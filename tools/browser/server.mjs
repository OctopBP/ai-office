#!/usr/bin/env node
// MCP-сервер браузера для роли QA: stdio, один Chromium на сессию через playwright-core.
// Контракт — docs/design/qa/spec.md, §3.1 и §5. Здесь только ядро: запуск браузера,
// open, set_device, set_offline, screenshot и инструменты чтения; жесты tap и swipe через
// CDP Input.dispatchTouchEvent и раскадровка storyboard (§5.2, §5.3); serve отдаёт папку
// рабочей копии из перехвата запросов, без порта (в песочнице listen запрещён). Фильтр адресов
// держит браузер на локальных адресах и опубликованной странице проекта: поэтому
// правило разрешений офиса пропускает инструменты сервера без вопроса владельцу.
//
// Переменные окружения:
//   QA_ALLOWED_ORIGIN    — единственный внешний origin, куда можно ходить (опубликованная страница)
//   OFFICE_WORKDIR       — рабочая копия; скриншоты пишутся только внутрь неё (иначе cwd)
//   OFFICE_TASK_ID       — номер задачи; раскадровка по умолчанию идёт в docs/qa/<задача>/shots/
//   OFFICE_BROWSER_PATH  — свой исполняемый файл Chromium для обычного режима
//   OFFICE_BROWSER_SHELL — chrome-headless-shell для запасного режима

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright-core';
import { z } from 'zod';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// stdout занят протоколом MCP, поэтому весь журнал — только в stderr.
const log = (msg) => process.stderr.write(`[browser] ${msg}\n`);

const WORKDIR = path.resolve(process.env.OFFICE_WORKDIR || process.cwd());
// Буферы ограничены, чтобы долгая страница со спамом в консоль не съела память и контекст.
const BUFFER_LIMIT = 1000;
const STATE_LIMIT = 16 * 1024;
const NAV_TIMEOUT = 30_000;

// ——— Фильтр адресов ———

// Локальные хосты разрешены на любом порту: там живёт dev-сервер проверяемого приложения.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

// Внешний origin берётся из окружения один раз: агент его не меняет, это решение офиса.
// Кривое значение не превращаем в «разрешить всё» — просто внешних адресов не будет.
function readAllowedOrigin() {
  const raw = (process.env.QA_ALLOWED_ORIGIN || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('нужен http или https');
    return url.origin;
  } catch (err) {
    log(`QA_ALLOWED_ORIGIN не разобран (${firstLine(err)}), внешние адреса закрыты`);
    return null;
  }
}

const ALLOWED_ORIGIN = readAllowedOrigin();

// Схемы без сети: страница собирает их сама, наружу они не ходят.
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:']);

// Разрешён ли адрес запроса страницы. ws/wss сводятся к http/https, чтобы сокет
// опубликованной страницы проходил вместе с ней, а HMR dev-сервера — вместе с localhost.
function urlAllowed(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return true;
  const proto = { 'ws:': 'http:', 'wss:': 'https:' }[url.protocol] || url.protocol;
  if (proto !== 'http:' && proto !== 'https:') return false;
  if (LOCAL_HOSTS.has(url.hostname)) return true;
  return ALLOWED_ORIGIN !== null && `${proto}//${url.host}` === ALLOWED_ORIGIN;
}

function allowedHint() {
  return `разрешены http(s)://localhost, http(s)://127.0.0.1 на любом порту${
    ALLOWED_ORIGIN ? ` и ${ALLOWED_ORIGIN}` : '; внешний адрес не задан (QA_ALLOWED_ORIGIN)'
  }`;
}

// Проверка для open: только http(s), без data:/about: — открыть QA просит страницу проекта.
function checkOpenUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`не адрес: ${raw}`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !urlAllowed(url.href)) {
    throw new Error(`адрес вне разрешённых: ${url.origin === 'null' ? raw : url.origin} — ${allowedHint()}`);
  }
  return url.href;
}

// Перехват на весь контекст: и переходы, и подресурсы, и запросы из воркеров страницы.
// Чужое обрывается как blockedbyclient и попадает в get_failed_requests через requestfailed.
async function installFilter(context) {
  await context.route('**/*', (route) => {
    const url = route.request().url();
    const served = servedFolder(url);
    if (served) return serveFile(route, served);
    if (urlAllowed(url)) return route.fallback();
    log(`заблокирован запрос: ${url.slice(0, 200)}`);
    return route.abort('blockedbyclient');
  });
  // WebSocket идёт мимо route; routeWebSocket есть не во всех версиях playwright-core.
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket(
      (url) => !urlAllowed(url.href),
      (ws) => {
        log(`заблокирован сокет: ${ws.url().slice(0, 200)}`);
        push(buffers.failed, { kind: 'blocked', method: 'WS', url: ws.url(), resource: 'websocket', error: 'адрес вне разрешённых' });
        return ws.close({ code: 1008, reason: 'blocked by QA filter' });
      },
    );
  }
}

// Route видит только первый запрос цепочки редиректов: если разрешённый сервер
// перенаправил на чужой адрес, документ уже открыт. Такую страницу сразу уводим на пустую.
function guardNavigation(page) {
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame() || urlAllowed(frame.url())) return;
    log(`переход на чужой адрес остановлен: ${frame.url().slice(0, 200)}`);
    push(buffers.failed, { kind: 'blocked', method: 'GET', url: frame.url(), resource: 'document', error: 'переход вне разрешённых адресов' });
    page.goto('about:blank').catch(() => {});
  });
}

// ——— Раздача папки без порта ———

// В песочнице исполнителя listen запрещён (EPERM), поэтому страницу проекта отдаём прямо
// из перехвата запросов: адрес http://127.0.0.1:<фиктивный порт>/ никто не слушает,
// ответы собирает обработчик route. Порт свой на каждую папку, чтобы origin не смешивались.
const SERVE_HOST = '127.0.0.1';
const SERVE_PORT_BASE = 47100;
const served = new Map(); // origin → абсолютный путь папки

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function servedFolder(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:') return null;
    const root = served.get(url.origin);
    return root ? { root, pathname: url.pathname } : null;
  } catch {
    return null;
  }
}

function notFound(route, what) {
  return route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: `404: ${what}` });
}

// Playwright не роняет перехваченные запросы в офлайне: fulfill отвечает и при setOffline(true)
// (проверено на 1.63). QA проверяет приложение без сети, поэтому офлайн обрываем сами.
async function serveFile(route, { root, pathname }) {
  if (session.offline) return route.abort('internetdisconnected');
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return notFound(route, pathname);
  }
  let file = path.resolve(root, `.${rel}`);
  const inside = path.relative(root, file);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return notFound(route, pathname);
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return route.fulfill({ status: 200, contentType: type, body, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR' || err?.code === 'EISDIR') return notFound(route, pathname);
    log(`раздача не прочитала ${file}: ${firstLine(err)}`);
    return route.fulfill({ status: 500, contentType: 'text/plain; charset=utf-8', body: `500: ${firstLine(err)}` });
  }
}

// ——— Устройства ———

const PRESETS = {
  'phone-portrait': { width: 390, height: 844, dpr: 3, mobile: true, touch: true, orientation: 'portrait' },
  'phone-landscape': { width: 844, height: 390, dpr: 3, mobile: true, touch: true, orientation: 'landscape' },
  tablet: { width: 834, height: 1194, dpr: 2, mobile: true, touch: true, orientation: 'portrait' },
  desktop: { width: 1440, height: 900, dpr: 2, mobile: false, touch: false, orientation: 'landscape' },
};

// Мобильный UA нужен, иначе сайты с разметкой по UA отдают десктоп даже на узком экране.
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ——— Состояние сессии ———

const session = {
  browser: null,
  context: null,
  page: null,
  cdp: null,
  mode: null, // 'headless' | 'headless-shell-single-process'
  device: { name: 'desktop', ...PRESETS.desktop },
  offline: false,
  desktopUA: null,
  launching: null,
};

const buffers = { console: [], errors: [], failed: [] };

function push(list, entry) {
  list.push({ t: Date.now(), ...entry });
  if (list.length > BUFFER_LIMIT) list.splice(0, list.length - BUFFER_LIMIT);
}

function clearBuffers() {
  buffers.console.length = 0;
  buffers.errors.length = 0;
  buffers.failed.length = 0;
}

// ——— Запуск браузера ———

const BASE_ARGS = ['--mute-audio', '--no-first-run', '--no-default-browser-check'];

async function launchBrowser() {
  // Сначала обычный headless: он ближе к живому Chrome и держит несколько процессов.
  try {
    const browser = await chromium.launch({
      headless: true,
      args: BASE_ARGS,
      ...(process.env.OFFICE_BROWSER_PATH ? { executablePath: process.env.OFFICE_BROWSER_PATH } : {}),
    });
    log('режим запуска: headless');
    return { browser, mode: 'headless' };
  } catch (err) {
    log(`обычный headless не поднялся: ${firstLine(err)}`);
  }
  // Запасной путь для песочниц, где запрещено плодить процессы: всё в одном процессе.
  // В этом режиме Chromium не переживает второй контекст, поэтому сервер всегда держит один.
  const browser = await chromium.launch({
    headless: true,
    args: [...BASE_ARGS, '--single-process', '--no-zygote'],
    ...(process.env.OFFICE_BROWSER_SHELL ? { executablePath: process.env.OFFICE_BROWSER_SHELL } : {}),
  });
  log('режим запуска: chrome-headless-shell --single-process');
  return { browser, mode: 'headless-shell-single-process' };
}

// Init-скрипт для get_state: считает созданные AudioContext и помнит последний (§5.4 п.5).
function audioProbe() {
  const wrap = (name) => {
    const Orig = window[name];
    if (typeof Orig !== 'function') return;
    window[name] = class extends Orig {
      constructor(...args) {
        super(...args);
        window.__QA_LAST_AUDIO__ = this;
      }
    };
  };
  wrap('AudioContext');
  wrap('webkitAudioContext');
}

async function ensurePage() {
  if (session.page && !session.page.isClosed()) return session.page;
  if (!session.launching) {
    session.launching = (async () => {
      if (!session.browser || !session.browser.isConnected()) {
        const { browser, mode } = await launchBrowser();
        session.browser = browser;
        session.mode = mode;
        session.context = null;
        browser.on('disconnected', () => {
          log('браузер отключился');
          session.browser = null;
          session.context = null;
          session.page = null;
          session.cdp = null;
        });
      }
      if (!session.context) {
        session.context = await session.browser.newContext({
          viewport: { width: session.device.width, height: session.device.height },
          deviceScaleFactor: session.device.dpr,
        });
        await installFilter(session.context);
        await session.context.addInitScript(audioProbe);
        if (session.offline) await session.context.setOffline(true);
      }
      const page = await session.context.newPage();
      attachListeners(page);
      session.page = page;
      session.cdp = await session.context.newCDPSession(page);
      // Родной UA запоминаем до первого override, чтобы вернуть его при переходе на десктоп.
      session.desktopUA ??= (await page.evaluate(() => navigator.userAgent)).replace('HeadlessChrome', 'Chrome');
      await applyDevice();
    })().finally(() => {
      session.launching = null;
    });
  }
  await session.launching;
  return session.page;
}

function attachListeners(page) {
  guardNavigation(page);
  page.on('console', (msg) => {
    const loc = msg.location();
    push(buffers.console, {
      level: msg.type(),
      text: msg.text(),
      ...(loc?.url ? { source: `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` } : {}),
    });
  });
  page.on('pageerror', (err) => {
    push(buffers.errors, { message: err.message, stack: err.stack || '' });
  });
  page.on('requestfailed', (req) => {
    push(buffers.failed, {
      kind: 'failed',
      method: req.method(),
      url: req.url(),
      resource: req.resourceType(),
      error: req.failure()?.errorText || 'unknown',
    });
  });
  page.on('response', (res) => {
    if (res.status() < 400) return;
    const req = res.request();
    push(buffers.failed, {
      kind: 'http',
      method: req.method(),
      url: res.url(),
      resource: req.resourceType(),
      status: res.status(),
      statusText: res.statusText(),
    });
  });
  page.on('crash', () => push(buffers.errors, { message: 'страница упала (crash)', stack: '' }));
}

// Меняет вьюпорт, DPR, ориентацию, touch и UA на живой странице, без перезагрузки:
// всё идёт через Emulation.* по CDP, Chrome сам шлёт resize и orientationchange.
async function applyDevice() {
  const d = session.device;
  const page = session.page;
  const cdp = session.cdp;
  // Сначала setViewportSize — чтобы Playwright знал новый размер (от него считаются скриншоты),
  // затем свой override поверх: Playwright выставляет только размер и DPR контекста.
  await page.setViewportSize({ width: d.width, height: d.height });
  const landscape = d.orientation === 'landscape';
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: d.width,
    height: d.height,
    deviceScaleFactor: d.dpr,
    mobile: d.mobile,
    screenWidth: d.width,
    screenHeight: d.height,
    screenOrientation: landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
  });
  // maxTouchPoints принимается только в пределах 1–16, даже при выключенном touch: 0 Chrome отвергает.
  await cdp.send('Emulation.setTouchEmulationEnabled', d.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await cdp.send('Emulation.setUserAgentOverride', { userAgent: d.mobile ? MOBILE_UA : session.desktopUA });
}

// ——— Чтение состояния страницы ———

const PATH_RE = /^[A-Za-z_$][\w$]*(\.[\w$]+|\[\d+\])*$/;

// Единственная функция, которая уходит на страницу из get_state. Строку path она
// разбирает как путь и не исполняет как код (§5.4 п.2).
function readState({ path, depthLimit }) {
  const audioCtx = window.__QA_LAST_AUDIO__;
  const env = {
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
    dpr: devicePixelRatio,
    orientation: screen.orientation ? screen.orientation.type : 'unknown',
    online: navigator.onLine,
    visibility: document.visibilityState,
    scroll: { x: scrollX, y: scrollY },
    audio: audioCtx ? audioCtx.state : 'none',
  };

  const seen = new WeakSet();
  const clean = (v, depth) => {
    if (v === null || v === undefined) return v ?? null;
    const type = typeof v;
    if (type === 'function') return '[function]';
    if (type === 'bigint') return `${v}n`;
    if (type === 'symbol') return String(v);
    if (type !== 'object') return Number.isFinite(v) || type !== 'number' ? v : String(v);
    if (typeof Node !== 'undefined' && v instanceof Node) return '[node]';
    if (seen.has(v)) return '[cycle]';
    if (depth >= depthLimit) return '[depth]';
    seen.add(v);
    let out;
    if (Array.isArray(v)) out = v.map((x) => clean(x, depth + 1));
    else if (v instanceof Map) out = Object.fromEntries([...v].map(([k, x]) => [String(k), clean(x, depth + 1)]));
    else if (v instanceof Set) out = [...v].map((x) => clean(x, depth + 1));
    else if (v instanceof Date) out = v.toISOString();
    else {
      out = {};
      for (const k of Object.keys(v)) {
        try {
          out[k] = clean(v[k], depth + 1);
        } catch (e) {
          out[k] = `[error: ${e && e.message}]`;
        }
      }
    }
    seen.delete(v);
    return out;
  };

  const parse = (p) => p.match(/[^.[\]]+/g) || [];
  const dig = (root, keys) => {
    let cur = root;
    for (const k of keys) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[k];
    }
    return cur;
  };

  let app = null;
  let note;
  try {
    const keys = path ? parse(path) : [];
    if (keys[0] === 'storage' && (keys[1] === 'local' || keys[1] === 'session')) {
      const store = keys[1] === 'local' ? localStorage : sessionStorage;
      if (keys.length < 3) {
        app = Object.fromEntries(Object.keys(store).map((k) => [k, store.getItem(k)]));
      } else {
        const raw = store.getItem(keys[2]);
        let val = raw;
        try {
          val = raw === null ? null : JSON.parse(raw);
        } catch {}
        app = clean(keys.length > 3 ? dig(val, keys.slice(3)) : val, 0);
      }
    } else {
      let root = window.__QA_STATE__;
      if (root === undefined) {
        note = 'приложение не объявило __QA_STATE__';
      } else {
        if (typeof root === 'function') root = root();
        app = clean(dig(root, keys), 0);
      }
    }
  } catch (e) {
    note = `ошибка чтения: ${e && e.message}`;
  }
  return { env, app: app === undefined ? null : app, ...(note ? { note } : {}) };
}

// ——— Помощники ответов ———

function firstLine(err) {
  return String(err?.message || err).split('\n')[0];
}

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  return { isError: true, content: [{ type: 'text', text: `Ошибка: ${firstLine(err)}` }] };
}

// Обёртка: ошибка браузера возвращается агенту текстом, а не роняет сервер.
const tool = (fn) => async (args) => {
  try {
    return ok(await fn(args ?? {}));
  } catch (err) {
    log(`инструмент упал: ${err?.stack || err}`);
    return fail(err);
  }
};

function filterSince(list, since, limit) {
  const items = since ? list.filter((e) => e.t > since) : list;
  return items.slice(-limit);
}

function deviceView() {
  return { ...session.device, offline: session.offline, mode: session.mode };
}

// Путь внутри рабочей копии; всё, что уходит наружу через `..` или абсолютный путь, — отказ.
function insideWorkdir(target) {
  const file = path.resolve(WORKDIR, target);
  const rel = path.relative(WORKDIR, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`путь вне рабочей копии: ${target}`);
  return { file, rel };
}

// ——— Жесты ———

// Шаг траектории свайпа: 16 мс — один кадр на 60 Гц, как у живого пальца (§5.2).
const GESTURE_STEP_MS = 16;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ждёт момента `at` по часам от `start`: шаги считаются от начала жеста, а не друг от друга,
// поэтому задержка одного шага не растягивает весь свайп.
async function waitUntil(start, at) {
  const left = start + at - Date.now();
  if (left > 0) await sleep(left);
}

function touchPoint(x, y) {
  return { x, y, id: 0, radiusX: 4, radiusY: 4, force: 1 };
}

async function touch(type, x, y) {
  // touchEnd и touchCancel передаются с пустым списком: палец уже отпущен.
  const touchPoints = type === 'touchEnd' || type === 'touchCancel' ? [] : [touchPoint(x, y)];
  await session.cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
}

// Точка на ломаной на доле пути `f` от 0 до 1. Доля берётся по длине, поэтому скорость
// пальца постоянна по всей траектории, а не скачет на коротких отрезках.
function pointAt(points, lengths, total, f) {
  if (total === 0) return points[0];
  let rest = f * total;
  for (let i = 0; i < lengths.length; i++) {
    if (rest <= lengths[i] || i === lengths.length - 1) {
      const k = lengths[i] === 0 ? 0 : Math.min(1, rest / lengths[i]);
      const a = points[i];
      const b = points[i + 1];
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    rest -= lengths[i];
  }
  return points[points.length - 1];
}

// Без touch-эмуляции (десктоп) те же жесты идут мышью — словарь QA не меняется (§5.2).
const useMouse = () => !session.device.touch;

async function doTap(x, y) {
  await ensurePage();
  if (useMouse()) {
    await session.page.mouse.click(x, y);
    return { x, y, input: 'mouse' };
  }
  await touch('touchStart', x, y);
  await touch('touchEnd', x, y);
  return { x, y, input: 'touch' };
}

async function doSwipe(points, durationMs) {
  await ensurePage();
  const lengths = [];
  for (let i = 0; i + 1 < points.length; i++) {
    lengths.push(Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y));
  }
  const total = lengths.reduce((s, l) => s + l, 0);
  // Число шагов — не меньше одного; последний шаг ровно в durationMs и в последней точке.
  const steps = Math.max(1, Math.round(durationMs / GESTURE_STEP_MS));
  const first = points[0];
  const mouse = useMouse();
  const start = Date.now();
  if (mouse) {
    await session.page.mouse.move(first.x, first.y);
    await session.page.mouse.down();
  } else {
    await touch('touchStart', first.x, first.y);
  }
  let last = first;
  try {
    for (let k = 1; k <= steps; k++) {
      const at = (durationMs * k) / steps;
      await waitUntil(start, at);
      last = pointAt(points, lengths, total, k / steps);
      if (mouse) await session.page.mouse.move(last.x, last.y);
      else await touch('touchMove', last.x, last.y);
    }
  } catch (err) {
    // Палец не должен «залипнуть» на странице: сорванный жест закрываем отменой.
    if (mouse) await session.page.mouse.up().catch(() => {});
    else await touch('touchCancel', last.x, last.y).catch(() => {});
    throw err;
  }
  if (mouse) await session.page.mouse.up();
  else await touch('touchEnd', last.x, last.y);
  return {
    input: mouse ? 'mouse' : 'touch',
    moves: steps,
    stepMs: Math.round((durationMs / steps) * 10) / 10,
    distance: Math.round(total),
    durationMs,
    actualMs: Date.now() - start,
  };
}

// ——— Раскадровка ———

const STORYBOARD_MAX = 30;
const STORYBOARD_MIN_INTERVAL = 16;

function defaultStoryboardDir() {
  const task = (process.env.OFFICE_TASK_ID || 'local').replace(/[^\w.-]/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('docs', 'qa', task, 'shots', `storyboard-${stamp}`);
}

// Кадры снимаются строго по очереди: два page.screenshot разом на одной странице мешают
// друг другу. Расписание считается от старта, поэтому медленный кадр не сдвигает остальные;
// если снимок длиннее интервала, следующий идёт сразу, а реальное время видно в `t`.
async function doStoryboard(count, intervalMs, dir) {
  const page = await ensurePage();
  const { file: folder, rel: relFolder } = insideWorkdir(dir || defaultStoryboardDir());
  await mkdir(folder, { recursive: true });
  const width = String(count - 1).length;
  const frames = [];
  const start = Date.now();
  for (let i = 0; i < count; i++) {
    await waitUntil(start, i * intervalMs);
    const name = `frame-${String(i).padStart(Math.max(2, width), '0')}.png`;
    const file = path.join(folder, name);
    const t = Date.now() - start;
    await page.screenshot({ path: file, type: 'png' });
    frames.push({ path: path.join(relFolder, name), t });
  }
  return { dir: relFolder, intervalMs, frames };
}

const pointSchema = z.object({ x: z.number(), y: z.number() });

// ——— Сервер ———

const server = new McpServer({ name: 'office-browser', version: '0.1.0' });

server.registerTool(
  'open',
  {
    description:
      'Открыть адрес в браузере и дождаться загрузки (событие load). Буферы консоли, ошибок и сети начинаются заново. ' +
      'Разрешены localhost и 127.0.0.1 на любом порту и опубликованная страница проекта; запросы страницы ' +
      'на другие адреса блокируются и видны в get_failed_requests.',
    inputSchema: {
      url: z.string().describe('Полный адрес, например http://127.0.0.1:5173/'),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe('По умолчанию load'),
    },
  },
  tool(async ({ url, waitUntil }) => {
    // Адрес проверяется до запуска браузера: на запрещённый адрес незачем поднимать Chromium.
    const target = checkOpenUrl(url);
    const page = await ensurePage();
    clearBuffers();
    const res = await page.goto(target, { waitUntil: waitUntil || 'load', timeout: NAV_TIMEOUT });
    // about:blank здесь значит, что guardNavigation уже увёл страницу с чужого редиректа.
    const landed = page.url();
    if (!/^https?:/.test(landed) || !urlAllowed(landed)) {
      throw new Error(`адрес перенаправил за пределы разрешённых (${landed}); подробности в get_failed_requests — ${allowedHint()}`);
    }
    return {
      url: page.url(),
      status: res ? res.status() : null,
      title: await page.title(),
      device: deviceView(),
    };
  }),
);

server.registerTool(
  'serve',
  {
    description:
      'Раздать папку рабочей копии (собранную статику, страницу проекта) без прослушивания порта: запросы ' +
      'на возвращённый адрес http://127.0.0.1:<порт>/ отдаёт сам браузер из файлов папки. Адрес передайте в open. ' +
      'Каталог отдаёт свой index.html, нет файла — 404; в офлайне (set_offline) раздача тоже обрывается.',
    inputSchema: {
      dir: z.string().describe('Папка относительно рабочей копии, например dist или tools/browser/fixtures/target/fixed'),
    },
  },
  tool(async ({ dir }) => {
    const { file: root, rel } = insideWorkdir(dir);
    if (!(await stat(root).catch(() => null))?.isDirectory()) throw new Error(`не папка: ${rel}`);
    // Та же папка — тот же адрес: повторный serve не плодит origin и не теряет localStorage.
    let origin = [...served].find(([, folder]) => folder === root)?.[0];
    if (!origin) {
      origin = `http://${SERVE_HOST}:${SERVE_PORT_BASE + served.size}`;
      served.set(origin, root);
    }
    log(`раздача ${rel} → ${origin}/`);
    return { url: `${origin}/`, dir: rel };
  }),
);

server.registerTool(
  'set_device',
  {
    description:
      'Сменить устройство без перезагрузки страницы: вьюпорт, ориентация, DPR, touch и мобильный UA. ' +
      'Пресеты: phone-portrait, phone-landscape, tablet, desktop. Поля width/height/dpr/orientation переопределяют пресет.',
    inputSchema: {
      preset: z.enum(Object.keys(PRESETS)).optional().describe('Без пресета меняются только переданные поля'),
      width: z.number().int().min(200).max(4000).optional(),
      height: z.number().int().min(200).max(4000).optional(),
      dpr: z.number().min(1).max(3).optional().describe('Плотность пикселей, обычно 2–3'),
      orientation: z.enum(['portrait', 'landscape']).optional().describe('Без размеров — поворот текущего экрана'),
    },
  },
  tool(async ({ preset, width, height, dpr, orientation }) => {
    const base = preset ? { name: preset, ...PRESETS[preset] } : { ...session.device };
    const next = { ...base };
    if (dpr !== undefined) next.dpr = dpr;
    if (width !== undefined) next.width = width;
    if (height !== undefined) next.height = height;
    if (orientation && orientation !== next.orientation) {
      // Поворот без явных размеров меняет стороны местами, как настоящий телефон.
      if (width === undefined && height === undefined) [next.width, next.height] = [next.height, next.width];
      next.orientation = orientation;
    } else if (!orientation && (width !== undefined || height !== undefined)) {
      next.orientation = next.width > next.height ? 'landscape' : 'portrait';
    }
    if (!preset && (width !== undefined || height !== undefined || orientation)) next.name = 'custom';
    session.device = next;
    if (session.page && !session.page.isClosed()) await applyDevice();
    return deviceView();
  }),
);

server.registerTool(
  'set_offline',
  {
    description: 'Включить или выключить офлайн для страницы (navigator.onLine и сетевые запросы, включая раздачу serve).',
    inputSchema: { on: z.boolean() },
  },
  tool(async ({ on }) => {
    session.offline = on;
    if (session.context) await session.context.setOffline(on);
    return { offline: on };
  }),
);

server.registerTool(
  'screenshot',
  {
    description: 'Снять один PNG-снимок страницы в файл и вернуть путь. Путь — внутри рабочей копии.',
    inputSchema: {
      path: z.string().describe('Путь к файлу .png относительно рабочей копии, например docs/qa/T-1/shots/home.png'),
      fullPage: z.boolean().optional().describe('Вся страница, а не только видимая часть'),
    },
  },
  tool(async ({ path: target, fullPage }) => {
    const { file, rel } = insideWorkdir(target);
    if (path.extname(file).toLowerCase() !== '.png') throw new Error('снимок пишется только в .png');
    const page = await ensurePage();
    await mkdir(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: !!fullPage, type: 'png' });
    return { path: rel };
  }),
);

server.registerTool(
  'get_console',
  {
    description: 'Сообщения консоли страницы с последнего open.',
    inputSchema: {
      level: z.enum(['log', 'debug', 'info', 'error', 'warning']).optional(),
      since: z.number().optional().describe('Только записи с t больше этого (мс эпохи)'),
      limit: z.number().int().min(1).max(BUFFER_LIMIT).optional().describe('По умолчанию 100 последних'),
    },
  },
  tool(async ({ level, since, limit }) => {
    const list = level ? buffers.console.filter((e) => e.level === level) : buffers.console;
    return filterSince(list, since, limit || 100);
  }),
);

server.registerTool(
  'get_errors',
  {
    description: 'Необработанные исключения страницы (pageerror) со стеком с последнего open.',
    inputSchema: {
      since: z.number().optional(),
      limit: z.number().int().min(1).max(BUFFER_LIMIT).optional(),
    },
  },
  tool(async ({ since, limit }) => filterSince(buffers.errors, since, limit || 100)),
);

server.registerTool(
  'get_failed_requests',
  {
    description: 'Сетевые сбои с последнего open: оборванные запросы (kind=failed) и ответы со статусом ≥ 400 (kind=http).',
    inputSchema: {
      since: z.number().optional(),
      limit: z.number().int().min(1).max(BUFFER_LIMIT).optional(),
    },
  },
  tool(async ({ since, limit }) => filterSince(buffers.failed, since, limit || 100)),
);

server.registerTool(
  'get_state',
  {
    description:
      'Прочитать состояние страницы как JSON: env (адрес, вьюпорт, DPR, ориентация, онлайн, видимость, прокрутка, звук) ' +
      'и app — значение из window.__QA_STATE__ или storage.local.<ключ> / storage.session.<ключ>. ' +
      'path — только путь вида a.b[0].c, код не исполняется.',
    inputSchema: {
      path: z.string().optional().describe('Путь внутри __QA_STATE__, например game.level или storage.local.settings'),
    },
  },
  tool(async ({ path: statePath }) => {
    if (statePath && !PATH_RE.test(statePath)) throw new Error('path — только идентификаторы через точку и [индексы]');
    const page = await ensurePage();
    const result = await page.evaluate(readState, { path: statePath || '', depthLimit: 6 });
    const text = JSON.stringify(result.app);
    if (text && text.length > STATE_LIMIT) {
      result.app = text.slice(0, STATE_LIMIT);
      result.note = `${result.note ? `${result.note}; ` : ''}обрезано до 16 КБ`;
    }
    return result;
  }),
);

server.registerTool(
  'tap',
  {
    description:
      'Касание пальцем в точке (CSS-пиксели вьюпорта): touchStart и touchEnd через CDP Input.dispatchTouchEvent, ' +
      'страница видит pointerType touch. На десктопном устройстве без touch — клик мышью.',
    inputSchema: {
      x: z.number().min(0),
      y: z.number().min(0),
    },
  },
  tool(async ({ x, y }) => doTap(x, y)),
);

const swipeShape = {
  points: z
    .array(pointSchema)
    .min(2)
    .max(50)
    .describe('Траектория: от двух точек {x,y}, первая — где палец коснулся, последняя — где отпустил'),
  durationMs: z
    .number()
    .int()
    .min(16)
    .max(10_000)
    .describe('Время жеста: быстрый свайп около 120 мс, медленный около 600 мс'),
};

server.registerTool(
  'swipe',
  {
    description:
      'Свайп пальцем по траектории из нескольких точек за durationMs: touchStart, равномерные по времени touchMove ' +
      'с шагом 16 мс и постоянной скоростью вдоль пути, touchEnd. На десктопном устройстве — мышью с зажатой кнопкой.',
    inputSchema: swipeShape,
  },
  tool(async ({ points, durationMs }) => doSwipe(points, durationMs)),
);

server.registerTool(
  'storyboard',
  {
    description:
      `Раскадровка: count PNG-кадров (до ${STORYBOARD_MAX}) с интервалом intervalMs (от ${STORYBOARD_MIN_INTERVAL} мс) в папку dir ` +
      'внутри рабочей копии; вернуть пути и время каждого кадра от старта. Чтобы снять кадры во время жеста, ' +
      'передайте swipe {points, durationMs} или tap {x, y}: жест стартует вместе с первым кадром.',
    inputSchema: {
      count: z.number().int().min(1).max(STORYBOARD_MAX),
      intervalMs: z.number().int().min(STORYBOARD_MIN_INTERVAL).max(10_000),
      dir: z
        .string()
        .optional()
        .describe('Папка относительно рабочей копии; по умолчанию docs/qa/<задача>/shots/storyboard-<время>'),
      swipe: z.object(swipeShape).optional().describe('Свайп, который идёт параллельно съёмке'),
      tap: pointSchema.optional().describe('Касание в начале съёмки'),
    },
  },
  tool(async ({ count, intervalMs, dir, swipe, tap }) => {
    if (swipe && tap) throw new Error('за одну раскадровку — один жест: swipe или tap');
    await ensurePage();
    // Жест и съёмка идут одновременно: жест шлёт события по CDP, съёмка ждёт своих моментов.
    const gesture = swipe ? doSwipe(swipe.points, swipe.durationMs) : tap ? doTap(tap.x, tap.y) : null;
    const [board, done] = await Promise.allSettled([doStoryboard(count, intervalMs, dir), gesture]);
    if (board.status === 'rejected') throw board.reason;
    if (done.status === 'rejected') throw new Error(`кадры сняты в ${board.value.dir}, но жест сорвался: ${firstLine(done.reason)}`);
    return gesture ? { ...board.value, gesture: done.value } : board.value;
  }),
);

// ——— Жизненный цикл ———

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  try {
    await session.browser?.close();
  } catch (err) {
    log(`браузер не закрылся штатно: ${firstLine(err)}`);
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// Офис закрыл канал — сессия кончилась, браузер не должен пережить сервер.
process.stdin.on('end', () => shutdown(0));

await server.connect(new StdioServerTransport());
log(`сервер запущен, рабочая копия: ${WORKDIR}`);

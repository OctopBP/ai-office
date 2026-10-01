#!/usr/bin/env node
// MCP-сервер браузера для роли QA: stdio, один Chromium на сессию через playwright-core.
// Контракт — docs/design/qa/spec.md, §3.1 и §5. Здесь только ядро: запуск браузера,
// open, set_device, set_offline, screenshot и инструменты чтения. Жесты, раскадровка,
// фильтр адресов и правило разрешений — отдельные задачи.
//
// Переменные окружения:
//   OFFICE_WORKDIR       — рабочая копия; скриншоты пишутся только внутрь неё (иначе cwd)
//   OFFICE_BROWSER_PATH  — свой исполняемый файл Chromium для обычного режима
//   OFFICE_BROWSER_SHELL — chrome-headless-shell для запасного режима

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright-core';
import { z } from 'zod';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// stdout занят протоколом MCP, поэтому весь журнал — только в stderr.
const log = (msg) => process.stderr.write(`[browser] ${msg}\n`);

const WORKDIR = path.resolve(process.env.OFFICE_WORKDIR || process.cwd());
// Буферы ограничены, чтобы долгая страница со спамом в консоль не съела память и контекст.
const BUFFER_LIMIT = 1000;
const STATE_LIMIT = 16 * 1024;
const NAV_TIMEOUT = 30_000;

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
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: d.touch, maxTouchPoints: d.touch ? 5 : 0 });
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

// ——— Сервер ———

const server = new McpServer({ name: 'office-browser', version: '0.1.0' });

server.registerTool(
  'open',
  {
    description: 'Открыть адрес в браузере и дождаться загрузки (событие load). Буферы консоли, ошибок и сети начинаются заново.',
    inputSchema: {
      url: z.string().describe('Полный адрес, например http://127.0.0.1:5173/'),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe('По умолчанию load'),
    },
  },
  tool(async ({ url, waitUntil }) => {
    const page = await ensurePage();
    clearBuffers();
    const res = await page.goto(url, { waitUntil: waitUntil || 'load', timeout: NAV_TIMEOUT });
    return {
      url: page.url(),
      status: res ? res.status() : null,
      title: await page.title(),
      device: deviceView(),
    };
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
    description: 'Включить или выключить офлайн для страницы (navigator.onLine и сетевые запросы).',
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
    const file = path.resolve(WORKDIR, target);
    const rel = path.relative(WORKDIR, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`путь вне рабочей копии: ${target}`);
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

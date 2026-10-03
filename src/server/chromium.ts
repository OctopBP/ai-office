/**
 * Chromium для браузера QA.
 *
 * Сервер `browser` (tools/browser/server.mjs) поднимает браузер через
 * playwright-core, а сам playwright-core браузеров не везёт: они лежат в его
 * кеше (на macOS — ~/Library/Caches/ms-playwright). На машине разработчика
 * кеш обычно уже есть, на чистой машине владельца — нет, и QA без этой
 * проверки молча работал бы без браузера: сервер падает на запуске, а
 * агент видит только «инструмент не ответил».
 *
 * Поэтому при найме роли, подписанной на `browser`, и на старте её сессии
 * проверяем кеш, а пустой доливаем штатной командой `playwright install`.
 * Итог — и удачный, и нет — пишем в ленту офиса.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ServerKey } from './i18n';
import type { Vars } from '../shared/i18n';

/** Что модулю нужно от офиса: лента и словарь. */
export interface ChromiumOffice {
  addLog(agentId: string | null, kind: 'system', text: string): void;
  say(key: ServerKey, vars?: Vars): string;
}

/** Какие браузеры ставим: полный Chromium и headless shell, им сервер запускается по умолчанию. */
const BROWSERS = ['chromium'];

/** Скачивание идёт сотню-другую мегабайт; дольше ждать — значит сеть не пускает. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;

type Check = { ok: true } | { ok: false; reason: string; missing?: string[] };

/** Путь к cli.js playwright-core. Пакета нет — в сборке его забыли положить. */
function playwrightCli(): string | null {
  try {
    const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
    const cli = join(dirname(pkg), 'cli.js');
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/**
 * Запустить cli.js playwright-core. Сервер в приложении работает под
 * электроновским node (ELECTRON_RUN_AS_NODE), и `node` рядом может не быть,
 * поэтому зовём тот же бинарник, что исполняет нас, с той же переменной —
 * настоящий node её не замечает.
 */
function runCli(cli: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; error?: string }> {
  return new Promise((done) => {
    let out = '';
    let child;
    try {
      child = spawn(process.execPath, [cli, ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      done({ code: null, out, error: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, out, error: `timeout ${Math.round(timeoutMs / 60_000)} min` });
    }, timeoutMs);
    // Хвоста хватает на причину; весь прогресс-бар скачивания держать незачем.
    const keep = (chunk: Buffer) => { out = (out + chunk.toString()).slice(-8000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => { clearTimeout(timer); done({ code: null, out, error: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, out }); });
  });
}

/**
 * Есть ли браузеры в кеше. Куда их ставит эта версия playwright-core, знает
 * только она сама: спрашиваем `install --dry-run` и смотрим, завершена ли
 * установка в каждой папке (метка INSTALLATION_COMPLETE — та же, по которой
 * судит сам Playwright; оборванная загрузка её не оставляет).
 */
async function checkChromium(cli: string): Promise<Check> {
  const custom = process.env.OFFICE_BROWSER_PATH;
  if (custom && existsSync(custom)) return { ok: true };
  const run = await runCli(cli, ['install', '--dry-run', ...BROWSERS], 60_000);
  if (run.code !== 0) return { ok: false, reason: run.error ?? lastLine(run.out) };
  const dirs = [...run.out.matchAll(/Install location:\s*(.+)/g)].map((m) => m[1].trim());
  if (!dirs.length) return { ok: false, reason: lastLine(run.out) };
  const missing = dirs.filter((d) => !existsSync(join(d, 'INSTALLATION_COMPLETE')));
  return missing.length ? { ok: false, reason: 'missing', missing } : { ok: true };
}

const lastLine = (text: string): string =>
  text.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 300) || '?';

/**
 * Одна установка на процесс: Chromium общий для всех офисов, и два найма
 * подряд не должны качать его дважды. Удачная проверка запоминается до
 * перезапуска; неудачная — нет, следующий найм или старт попробует снова.
 */
let inflight: Promise<boolean> | null = null;
let ready = false;

async function ensure(office: ChromiumOffice, who: string): Promise<boolean> {
  const cli = playwrightCli();
  if (!cli) {
    office.addLog(null, 'system', office.say('chromium.noPlaywright', { who }));
    return false;
  }
  const check = await checkChromium(cli);
  if (check.ok) return true;
  if (check.reason !== 'missing') {
    office.addLog(null, 'system', office.say('chromium.checkFailed', { who, reason: check.reason }));
    return false;
  }
  office.addLog(null, 'system', office.say('chromium.installing', { who }));
  const run = await runCli(cli, ['install', ...BROWSERS], INSTALL_TIMEOUT_MS);
  const after = run.code === 0 ? await checkChromium(cli) : null;
  if (after?.ok) {
    office.addLog(null, 'system', office.say('chromium.installed', { who }));
    return true;
  }
  const reason = run.error ?? (run.code !== 0 ? lastLine(run.out) : after && !after.ok
    ? (after.missing?.join(', ') ?? after.reason) : '?');
  office.addLog(null, 'system', office.say('chromium.installFailed', { who, reason }));
  return false;
}

/**
 * Убедиться, что Chromium есть, и доставить его, если нет. `who` — кто
 * нужен браузер (название роли), для ленты. Ошибок не бросает: итог уже
 * в ленте, а возвращаемое значение — для тех, кто хочет дождаться.
 */
export function ensureChromium(office: ChromiumOffice, who: string): Promise<boolean> {
  if (ready) return Promise.resolve(true);
  if (!inflight) {
    inflight = ensure(office, who)
      .catch((err) => {
        office.addLog(null, 'system', office.say('chromium.installFailed', { who, reason: (err as Error).message }));
        return false;
      })
      .then((ok) => {
        ready = ok;
        inflight = null;
        return ok;
      });
  }
  return inflight;
}

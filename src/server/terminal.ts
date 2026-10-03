/**
 * Встроенный терминал: псевдотерминал на сервере через node-pty.
 *
 * Модуль не знает про WebSocket: ему дают клиента (обычно id сокета), папку и
 * колбэки, он отдаёт ручку терминала. Протокол `term_*` и рассылку только
 * сокету-владельцу делает слой сервера. Разбор пакета, окружения и правила
 * доступа — docs/backend/T-292/terminal-pty.md.
 *
 * node-pty — нативный модуль, и он может не загрузиться: нет бинарника под
 * платформу, не тот ABI, песочница. Поэтому он грузится лениво, при первом
 * открытии, а сбой превращается в `TerminalError('unavailable')` — сервер без
 * терминала поднимается как раньше.
 */

import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { TerminalErrorReason } from '../shared/types';
import { projectEnv } from './childenv';

// ------------------------------------------------------------- типы pty

/*
 * Типы node-pty сюда намеренно не импортируются: гейт слияния гоняет typecheck
 * на дереве, где нативный пакет может быть не установлен, и `import type` из
 * 'node-pty' валит его с TS2307. Поэтому ниже — ровно та часть API, которой
 * пользуется модуль, а сам пакет грузится по имени из переменной.
 */

/** Подписка на событие pty; `dispose` снимает обработчик. */
interface PtyDisposable {
  dispose(): void;
}

/** Событие выхода оболочки. */
interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

/** Запущенный псевдотерминал — подмножество `IPty` из node-pty. */
interface PtyProcess {
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

/** Параметры запуска — подмножество `IPtyForkOptions`. */
interface PtySpawnOptions {
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/** Модуль node-pty — нужен только `spawn`. */
interface PtyModule {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess;
}

/** Имя пакета в переменной, чтобы TypeScript не пытался его резолвить. */
const PTY_MODULE = 'node-pty';

const requirePty = (): PtyModule => createRequire(import.meta.url)(PTY_MODULE) as PtyModule;

/** Ошибка терминала с причиной из контракта — её слой сервера кладёт в `term.error`. */
export class TerminalError extends Error {
  constructor(readonly reason: TerminalErrorReason, message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

// ------------------------------------------------------------- загрузка pty

/** Загрузчик подменяется в тесте, чтобы проверить сбой без живого терминала. */
let loadPty: () => PtyModule = requirePty;
let loaded: { pty: PtyModule } | { error: TerminalError } | null = null;

function pty(): PtyModule {
  if (!loaded) {
    try {
      loaded = { pty: loadPty() };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.warn(`[terminal] node-pty не загрузился: ${why}`);
      loaded = {
        error: new TerminalError('unavailable',
          `Терминал недоступен: не удалось загрузить node-pty (${why.split('\n')[0]}).`),
      };
    }
  }
  if ('error' in loaded) throw loaded.error;
  return loaded.pty;
}

/** Только для тестов: свой загрузчик и сброс запомненного результата. */
export function setPtyLoaderForTest(loader: (() => PtyModule) | null): void {
  loadPty = loader ?? requirePty;
  loaded = null;
}

// ------------------------------------------------------------- оболочка и окружение

/** Оболочка пользователя: на Windows PowerShell, `ComSpec` — запасной. */
export function shellFor(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  if (platform === 'win32') {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
    const ps = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    if (existsSync(ps)) return { file: ps, args: ['-NoLogo'] };
    return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: [] };
  }
  // Входная оболочка — чтобы подтянулся .zprofile, как в обычном Терминале.
  return { file: env.SHELL || '/bin/zsh', args: ['-l'] };
}

/** Переменные с токенами GitHub: сервер может их держать, оболочке они не положены. */
const EXTRA_SECRET_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'];

/**
 * Окружение оболочки: как у процессов проекта (без привязки к приложению и
 * ключей провайдеров), плюс снятые `OFFICE_*` и токены GitHub.
 */
export function terminalEnv(base: NodeJS.ProcessEnv = projectEnv()): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (name.startsWith('OFFICE_') || name === 'ELECTRON_RUN_AS_NODE') continue;
    if (EXTRA_SECRET_VARS.includes(name)) continue;
    env[name] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  // Приложение из Finder стартует без локали — кириллица в выводе станет «?».
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  return env;
}

// ------------------------------------------------------------- терминалы

/** Лимиты из документа: на одного клиента и на весь процесс. */
export const MAX_PER_CLIENT = 4;
export const MAX_TOTAL = 16;

/** Склейка вывода: копим до 16 мс или 32 КБ, отдаём одним куском. */
const FLUSH_MS = 16;
const FLUSH_BYTES = 32 * 1024;

export interface OpenTerminalOptions {
  /** Кому принадлежит терминал — по нему `closeAllForClient`. */
  clientId: string;
  /** Папка, в которой стартует оболочка. Берёт сервер, не клиент. */
  cwd: string;
  cols: number;
  rows: number;
  /** Склеенный вывод оболочки. */
  onData: (data: string) => void;
  /** Оболочка завершилась — сама или после `close`. Зовётся ровно раз. */
  onExit: (exit: { code: number | null; signal: number | null }) => void;
}

export interface TerminalHandle {
  id: string;
  cwd: string;
  /** Путь к запущенной оболочке — для `term.opened`. */
  shell: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Обратное давление: слой сервера ставит на паузу, пока сокет не сольёт буфер. */
  pause(): void;
  resume(): void;
  close(): void;
}

interface Live {
  clientId: string;
  handle: TerminalHandle;
}

const live = new Map<string, Live>();
let seq = 0;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Открытых терминалов у клиента (и всего, без аргумента). */
export function terminalCount(clientId?: string): number {
  if (clientId === undefined) return live.size;
  let n = 0;
  for (const t of live.values()) if (t.clientId === clientId) n++;
  return n;
}

/**
 * Запустить оболочку в `cwd`. Бросает `TerminalError`: `no_dir` — папки нет,
 * `limit` — превышен лимит, `unavailable` — node-pty не загрузился или
 * процесс не стартовал.
 */
export function openTerminal(opts: OpenTerminalOptions): TerminalHandle {
  const { clientId, cwd, onData, onExit } = opts;
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new TerminalError('no_dir', `Папка не найдена: ${cwd}`);
  }
  if (terminalCount(clientId) >= MAX_PER_CLIENT) {
    throw new TerminalError('limit', `Открыто уже ${MAX_PER_CLIENT} терминала — закройте один из них.`);
  }
  if (live.size >= MAX_TOTAL) {
    throw new TerminalError('limit', `На сервере открыто уже ${MAX_TOTAL} терминалов.`);
  }

  const lib = pty();
  const shell = shellFor();
  let proc: PtyProcess;
  try {
    proc = lib.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cwd,
      cols: clamp(opts.cols, 2, 500),
      rows: clamp(opts.rows, 1, 200),
      env: terminalEnv(),
    });
  } catch (err) {
    // В песочнице исполнителя здесь EPERM: открыть псевдотерминал запрещено.
    const why = err instanceof Error ? err.message : String(err);
    throw new TerminalError('unavailable', `Не удалось запустить оболочку ${shell.file}: ${why}`);
  }

  const id = `T${++seq}`;
  let pending = '';
  let timer: NodeJS.Timeout | null = null;
  let exited = false;

  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const chunk = pending;
    pending = '';
    onData(chunk);
  };

  const dataSub = proc.onData((data: string) => {
    pending += data;
    if (pending.length >= FLUSH_BYTES) flush();
    else if (!timer) timer = setTimeout(flush, FLUSH_MS);
  });
  const exitSub = proc.onExit(({ exitCode, signal }: PtyExitEvent) => {
    if (exited) return;
    exited = true;
    flush();
    dataSub.dispose();
    exitSub.dispose();
    live.delete(id);
    onExit({ code: exitCode ?? null, signal: signal ?? null });
  });

  const handle: TerminalHandle = {
    id,
    cwd,
    shell: shell.file,
    write(data) {
      if (!exited) proc.write(data);
    },
    resize(cols, rows) {
      if (!exited) proc.resize(clamp(cols, 2, 500), clamp(rows, 1, 200));
    },
    pause() {
      if (!exited) proc.pause();
    },
    resume() {
      if (!exited) proc.resume();
    },
    close() {
      if (exited) return;
      // Терминал убираем из учёта сразу: лимит не должен ждать, пока оболочка
      // доберётся до выхода. `onExit` придёт из события процесса.
      live.delete(id);
      try {
        // На Windows сигналов нет — node-pty сам делает kill.
        proc.kill(process.platform === 'win32' ? undefined : 'SIGHUP');
      } catch {
        // Процесс уже ушёл — событие выхода догонит или уже пришло.
      }
    },
  };
  live.set(id, { clientId, handle });
  return handle;
}

/** Ручка терминала, если он принадлежит этому клиенту; чужой не виден. */
export function terminalFor(clientId: string, id: string): TerminalHandle | null {
  const t = live.get(id);
  return t && t.clientId === clientId ? t.handle : null;
}

/** Клиент ушёл (сокет закрылся, вышел владелец) — все его терминалы убиваются. */
export function closeAllForClient(clientId: string): void {
  for (const t of [...live.values()]) if (t.clientId === clientId) t.handle.close();
}

/** Остановка сервера: закрыть всё. */
export function closeAll(): void {
  for (const t of [...live.values()]) t.handle.close();
}

// ------------------------------------------------------------- право открыть

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Адреса dev-сервера vite: в разработке страница грузится оттуда. */
export const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * Открыт ли офис наружу: задан `OFFICE_PUBLIC_URL` или сервер слушает не
 * только loopback. Пустой `OFFICE_HOST` — это все интерфейсы, то есть наружу:
 * в локальной сети сокет откроет любой, а подделать `Origin` вне браузера
 * ничего не стоит.
 */
export function isExposed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OFFICE_PUBLIC_URL?.trim()) return true;
  const host = (env.OFFICE_HOST ?? '').trim().replace(/^\[|\]$/g, '');
  if (!host) return true;
  return !(LOOPBACK.has(host) || host.startsWith('127.'));
}

export interface TerminalAccessInput {
  /** Офис открыт наружу — `isExposed()`. */
  exposed: boolean;
  /** На сокете сессия вошедшего владельца. Пока входа нет — false. */
  ownerSignedIn: boolean;
  /** `Origin` запроса на апгрейд сокета. */
  origin?: string;
  /** `Host` того же запроса. */
  host?: string;
  /** Публичный адрес офиса (`OFFICE_PUBLIC_URL`): за шлюзом `Host` может быть другим. */
  publicUrl?: string;
  /** Разрешённые адреса dev-сервера; по умолчанию — vite на 5173, только локально. */
  devOrigins?: string[];
}

export type TerminalAccess = { ok: true } | { ok: false; reason: 'forbidden'; message: string };

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * Правило доступа. Терминал — мгновенное выполнение кода от имени
 * пользователя сервера, поэтому строже остальных команд:
 * - открытый офис — только вошедший владелец;
 * - в любом режиме страница должна быть своей: `Origin` совпадает с `Host`
 *   (или публичным адресом, или dev-сервером в разработке). Иначе любая
 *   вкладка в браузере владельца открыла бы терминал на 127.0.0.1.
 */
export function canOpenTerminal(input: TerminalAccessInput): TerminalAccess {
  if (input.exposed && !input.ownerSignedIn) {
    return { ok: false, reason: 'forbidden', message: 'Офис открыт наружу: терминал доступен только вошедшему владельцу.' };
  }
  const origin = input.origin?.trim();
  if (!origin) {
    return { ok: false, reason: 'forbidden', message: 'Терминал открывается только со страницы офиса.' };
  }
  const own = originHost(origin);
  const allowed = new Set<string>();
  if (input.host) allowed.add(input.host.toLowerCase());
  const pub = input.publicUrl ? originHost(input.publicUrl) : null;
  if (pub) allowed.add(pub.toLowerCase());
  if (own && allowed.has(own.toLowerCase())) return { ok: true };
  if (!input.exposed && (input.devOrigins ?? DEV_ORIGINS).includes(origin)) return { ok: true };
  return { ok: false, reason: 'forbidden', message: 'Терминал открывается только со страницы офиса.' };
}

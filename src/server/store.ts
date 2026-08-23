import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ChatEntry, LogEntry, PermissionMode, PullRequestView, Settings, Usage } from '../shared/types';
import type { Task } from './state';
import type { Role } from './roles';

// Путь вынесен в переменную окружения: тестовый сервер не должен
// затирать состояние рабочего офиса. Это только путь по умолчанию —
// у каждого офиса файл состояния свой, и хранилище всегда получает его
// явным аргументом, а не читает общую на процесс переменную.
export const DEFAULT_STATE_FILE = resolve(process.env.OFFICE_STATE_FILE ?? '.office/state.json');

const SAVE_DEBOUNCE_MS = 400;

export interface PersistedInstance {
  id: string;
  roleId: string;
  deskIndex: number;
  usage: Usage;
  /** Расход по дням, ключ — 'ГГГГ-ММ-ДД'. */
  daily: Record<string, Usage>;
  sessionId: string | null;
  /**
   * Свой режим доступа сотрудника. Нет поля или null — своего режима нет:
   * в старых сохранениях его и не было, и это то же самое, что «как у роли».
   */
  permissionMode?: PermissionMode | null;
  /** Формат до детализации расходов: только сумма, без токенов. */
  costUsd?: number;
}

export interface Persisted {
  version: 1;
  projectDir: string;
  taskSeq: number;
  tasks: Task[];
  /** Пулл-реквесты конвейера ревью. В сохранениях до конвейера их нет. */
  prs?: PullRequestView[];
  chat: ChatEntry[];
  log: LogEntry[];
  instances: PersistedInstance[];
  /** Расход офиса за всё время и по дням. В старых сохранениях их нет. */
  usage?: Usage;
  daily?: Record<string, Usage>;
  settings: Settings;
  roleOverrides: Record<string, Partial<Role>>;
  savedAt: number;
}

export function load(file: string): Persisted | null {
  const path = resolve(file);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Persisted;
    if (data.version !== 1) {
      console.log(`⚠️  Состояние офиса версии ${data.version} не поддерживается, начинаю с чистого листа`);
      return null;
    }
    return data;
  } catch (err) {
    console.log(`⚠️  Не удалось прочитать ${path}: ${(err as Error).message}. Начинаю с чистого листа.`);
    return null;
  }
}

/** Отложенная запись одного файла состояния. */
interface Writer {
  timer: NodeJS.Timeout | null;
  snapshot: (() => Persisted) | null;
}

/**
 * Своя отложенная запись на каждый файл состояния. Один таймер на процесс
 * означал бы, что офис, сохранившийся вторым, отменяет снимок первого
 * (`if (timer) return` ниже) и его данные не доезжают до диска. Ключ —
 * абсолютный путь: в него же и пишем, так что запись одного офиса не может
 * уйти в файл другого, даже если офис переключили, пока таймер тикал.
 */
const writers = new Map<string, Writer>();

/** Запись атомарная: сначала во временный файл, потом переименование. */
function writeNow(path: string, w: Writer): void {
  if (!w.snapshot) return;
  const data = w.snapshot();
  w.snapshot = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    console.log(`⚠️  Не удалось сохранить состояние: ${(err as Error).message}`);
  }
}

/**
 * Сохранение с дебаунсом: за один ход агента прилетают десятки событий,
 * писать файл на каждое — расточительно.
 */
export function save(file: string, snapshot: () => Persisted): void {
  const path = resolve(file);
  let w = writers.get(path);
  if (!w) {
    w = { timer: null, snapshot: null };
    writers.set(path, w);
  }
  w.snapshot = snapshot;
  if (w.timer) return;
  w.timer = setTimeout(() => {
    w!.timer = null;
    writeNow(path, w!);
  }, SAVE_DEBOUNCE_MS);
}

/** Сбросить на диск немедленно: перед переключением офиса и при выключении. */
export function flush(file: string): void {
  const path = resolve(file);
  const w = writers.get(path);
  if (!w) return;
  if (w.timer) {
    clearTimeout(w.timer);
    w.timer = null;
  }
  writeNow(path, w);
}

/** Досохранить все офисы разом — только при выключении сервера. */
export function flushAll(): void {
  for (const path of [...writers.keys()]) flush(path);
}

export function wipe(file: string): void {
  const path = resolve(file);
  const w = writers.get(path);
  if (w) {
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    w.snapshot = null;
  }
  try { rmSync(path, { force: true }); } catch { /* нечего удалять */ }
}

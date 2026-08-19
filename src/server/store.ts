import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ChatEntry, LogEntry, Settings } from '../shared/types';
import type { Task } from './state';
import type { Role } from './roles';

// Путь вынесен в переменную окружения: тестовый сервер не должен
// затирать состояние рабочего офиса.
const FILE = resolve(process.env.OFFICE_STATE_FILE ?? '.office/state.json');
const SAVE_DEBOUNCE_MS = 400;

export interface PersistedInstance {
  id: string;
  roleId: string;
  deskIndex: number;
  costUsd: number;
  sessionId: string | null;
}

export interface Persisted {
  version: 1;
  projectDir: string;
  taskSeq: number;
  tasks: Task[];
  chat: ChatEntry[];
  log: LogEntry[];
  instances: PersistedInstance[];
  settings: Settings;
  roleOverrides: Record<string, Partial<Role>>;
  savedAt: number;
}

export function load(): Persisted | null {
  if (!existsSync(FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8')) as Persisted;
    if (data.version !== 1) {
      console.log(`⚠️  Состояние офиса версии ${data.version} не поддерживается, начинаю с чистого листа`);
      return null;
    }
    return data;
  } catch (err) {
    console.log(`⚠️  Не удалось прочитать ${FILE}: ${(err as Error).message}. Начинаю с чистого листа.`);
    return null;
  }
}

let timer: NodeJS.Timeout | null = null;
let pendingWrite: (() => Persisted) | null = null;

/** Запись атомарная: сначала во временный файл, потом переименование. */
function writeNow(): void {
  if (!pendingWrite) return;
  const data = pendingWrite();
  pendingWrite = null;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (err) {
    console.log(`⚠️  Не удалось сохранить состояние: ${(err as Error).message}`);
  }
}

/**
 * Сохранение с дебаунсом: за один ход агента прилетают десятки событий,
 * писать файл на каждое — расточительно.
 */
export function save(snapshot: () => Persisted): void {
  pendingWrite = snapshot;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    writeNow();
  }, SAVE_DEBOUNCE_MS);
}

/** Сбросить на диск немедленно — при выключении сервера. */
export function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  writeNow();
}

export function wipe(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  pendingWrite = null;
  try { rmSync(FILE, { force: true }); } catch { /* нечего удалять */ }
}

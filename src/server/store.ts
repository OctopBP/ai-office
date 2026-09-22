import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  ChatEntry, LayoutOverride, LogEntry, PermissionMode, PullRequestView, Settings,
  SpendEntryView, Usage,
} from '../shared/types';
import type { Run } from '../shared/workflow';
import type { Direction, Epic, Fact, LifeState, Proposal, Task } from './state';
import type { MeetingView, OwnerQuestion } from '../shared/types';
import type { Role } from './roles';
import { c } from './i18n';

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
  /** Имя от владельца. Нет поля или null — зовётся по роли; в старых сохранениях поля нет. */
  name?: string | null;
  /** Формат до детализации расходов: только сумма, без токенов. */
  costUsd?: number;
  /** Контекст последнего вызова, токенов. В сохранениях до ротации менеджера поля нет. */
  contextTokens?: number;
}

export interface Persisted {
  version: 1;
  projectDir: string;
  taskSeq: number;
  tasks: Task[];
  /**
   * План офиса: фичи и их порядок. Поля нет в сохранениях, сделанных до
   * появления плана, — такой офис поднимается с пустым планом, а его задачи
   * остаются задачами вне плана и раздаются как раньше.
   */
  epics?: Epic[];
  epicSeq?: number;
  /** Пулл-реквесты конвейера ревью. В сохранениях до конвейера их нет. */
  prs?: PullRequestView[];
  /** Прогоны процессов. В сохранениях до процессов их нет — конвейер заведёт заново. */
  runs?: Run[];
  chat: ChatEntry[];
  log: LogEntry[];
  /** История совещаний. В сохранениях до неё поля нет: старые реплики остаются в ветке `meeting` без привязки. */
  meetings?: MeetingView[];
  instances: PersistedInstance[];
  /**
   * Передача дел от закрытой по порогу контекста сессии менеджера: она
   * входит в системный промпт следующей. null — сессию ещё не ротировали.
   */
  pmHandoff?: string | null;
  /** Расход офиса за всё время и по дням. В старых сохранениях их нет. */
  usage?: Usage;
  daily?: Record<string, Usage>;
  /**
   * Детализация трат: каждая трата отдельной записью (см. `spend.ts`).
   * В сохранениях до неё поля нет — такой офис поднимается с пустой
   * детализацией, а накопленные `usage` и `daily` остаются как были:
   * разложить итог обратно на траты уже нельзя, и выдумывать их не станем.
   */
  spend?: SpendEntryView[];
  /** Номер последней траты. Не длина массива: свёртка выкидывает записи. */
  spendSeq?: number;
  settings: Settings;
  /**
   * Набор ролей офиса целиком: у каждого проекта он свой, и роли переживают
   * перезапуск вместе с доской. Поля нет в сохранениях, сделанных до переезда
   * ролей в состояние офиса, — такие поднимаются по roleOverrides.
   */
  roles?: Role[];
  /**
   * Правки ролей поверх базового набора — формат до появления поля `roles`.
   * Только для чтения старых сохранений: офис пишет теперь полный набор.
   */
  roleOverrides?: Record<string, Partial<Role>>;
  /**
   * Расстановка мебели этого офиса поверх пресетов, ключ — id пресета.
   * Хранится разница, а не копия раскладки: файлы `design/layouts/*.json`
   * остаются эталоном, и обновление пресета доезжает до офиса везде, где тот
   * ничего не двигал. Оверрайдов несколько, потому что переключение пресета
   * туда-обратно не должно стирать уже расставленную мебель.
   * В сохранениях старше редактора расстановки поля нет.
   */
  layoutOverrides?: Record<string, LayoutOverride>;
  /**
   * Жизнь офиса: планёрки, журнал, вопросы владельцу, ритуалы
   * (docs/design/living-office/spec.md). В сохранениях до неё поля нет —
   * офис начинает с пустой памяти, а не с выдуманной.
   */
  life?: Partial<LifeState>;
  /** Журнал офиса и вопросы владельцу. В сохранениях до живого офиса их нет. */
  facts?: Fact[];
  factSeq?: number;
  questions?: OwnerQuestion[];
  questionSeq?: number;
  /** Направления владельца и предложения офиса. В старых сохранениях их нет. */
  directions?: Direction[];
  directionSeq?: number;
  proposals?: Proposal[];
  proposalSeq?: number;
  savedAt: number;
}

export function load(file: string): Persisted | null {
  const path = resolve(file);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Persisted;
    if (data.version !== 1) {
      console.log(c('boot.stateVersion', { version: String(data.version) }));
      return null;
    }
    return data;
  } catch (err) {
    console.log(c('boot.stateReadFailed', { path, error: (err as Error).message }));
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
    console.log(c('boot.saveFailed', { error: (err as Error).message }));
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

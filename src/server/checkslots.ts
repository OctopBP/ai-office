/**
 * Общий ограничитель параллельных проверок — семафор на процесс сервера.
 *
 * Проверки гейта (typecheck, тесты) запускают все офисы и все копии задач
 * сразу, и на перегруженной машине они упираются в таймаут (T-659: load
 * average 97–146). Семафор один на процесс и общий для всех офисов: сколько
 * бы офисов ни сливало задачи, одновременно идёт не больше `limit()` проверок,
 * остальные ждут в очереди в порядке прихода (FIFO).
 *
 * Предел по умолчанию — max(1, floor(ядра / 4)), переопределяется переменной
 * окружения OFFICE_CHECK_SLOTS (целое ≥ 1).
 *
 * Запуск теста: node --import tsx/esm scripts/test-checkslots.ts
 */
import { cpus } from 'node:os';
import type { MergeSlots } from '../shared/types';

/** Отпускает слот. Повторный вызов ничего не делает. */
export type Release = () => void;

/** Что видно в статусе: кто держит слот или ждёт его и с какого момента. */
export interface SlotEntry {
  label: string;
  since: number;
}

export interface CheckSlots {
  /** Ждёт свободного слота; промис отдаёт функцию, которая его отпускает. */
  acquire(label: string): Promise<Release>;
  /** Держит слот на время `fn`; слот освобождается и при исключении. */
  withSlot<T>(label: string, fn: () => Promise<T> | T): Promise<T>;
  /** Очередь ожидающих, в порядке прихода. */
  waiting(): SlotEntry[];
  /** Кто сейчас держит слоты. */
  running(): SlotEntry[];
  /** Предел одновременных проверок. */
  limit(): number;
  /** Подписка на любое изменение занятых и ждущих слотов; возвращает отписку. */
  subscribe(fn: () => void): () => void;
}

/** Предел из OFFICE_CHECK_SLOTS или по числу ядер. */
export function defaultCheckSlotsLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OFFICE_CHECK_SLOTS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return Math.max(1, Math.floor(cpus().length / 4));
}

interface Waiter extends SlotEntry {
  grant: (release: Release) => void;
}

/** Отдельный семафор с заданным пределом — для тестов и особых случаев. */
export function createCheckSlots(max: number): CheckSlots {
  const cap = Math.max(1, Math.floor(max) || 1);
  const holders = new Set<SlotEntry>();
  const queue: Waiter[] = [];
  const listeners = new Set<() => void>();
  const changed = (): void => { for (const fn of [...listeners]) fn(); };

  const grant = (label: string): Release => {
    const entry: SlotEntry = { label, since: Date.now() };
    holders.add(entry);
    changed();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders.delete(entry);
      // Слот переходит первому в очереди сразу, без гонки с новыми acquire.
      const next = queue.shift();
      if (next) next.grant(grant(next.label));
      else changed();
    };
  };

  const acquire = (label: string): Promise<Release> => {
    if (holders.size < cap && queue.length === 0) return Promise.resolve(grant(label));
    return new Promise<Release>((resolve) => {
      queue.push({ label, since: Date.now(), grant: resolve });
      changed();
    });
  };

  return {
    acquire,
    async withSlot<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
      const release = await acquire(label);
      try {
        return await fn();
      } finally {
        release();
      }
    },
    waiting: () => queue.map(({ label, since }) => ({ label, since })),
    running: () => [...holders].map(({ label, since }) => ({ label, since })),
    limit: () => cap,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

let shared: CheckSlots | null = null;

/** Общий семафор процесса; предел читается при первом обращении. */
export function checkSlots(): CheckSlots {
  if (!shared) shared = createCheckSlots(defaultCheckSlotsLimit());
  return shared;
}

export const acquire = (label: string): Promise<Release> => checkSlots().acquire(label);
export const withSlot = <T>(label: string, fn: () => Promise<T> | T): Promise<T> =>
  checkSlots().withSlot(label, fn);
export const waiting = (): SlotEntry[] => checkSlots().waiting();
export const running = (): SlotEntry[] => checkSlots().running();

/**
 * Слоты для UI: занято, предел, ждут и задачи в очереди. Метка слота —
 * «команда @ путь», а путь копии задачи кончается её номером, по нему и
 * узнаём задачу.
 */
export function slotsView(taskIds: Iterable<string>, slots: CheckSlots = checkSlots()): MergeSlots {
  const wait = slots.waiting();
  const ids = [...taskIds];
  const waitingTaskIds = ids.filter((id) => {
    const re = new RegExp(`[/\\\\]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z-])`);
    return wait.some((w) => re.test(w.label));
  });
  return { busy: slots.running().length, limit: slots.limit(), waiting: wait.length, waitingTaskIds };
}

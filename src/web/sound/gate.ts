/**
 * Чистая логика звукового слоя: что и когда играть. Ни DOM, ни Web Audio, ни
 * стора — только решения, поэтому проверяется без браузера (scripts/test-sound.ts).
 *
 * Правила — docs «Звуки в офисе: карта событий» (D-6), раздел «Против
 * надоедливости»: звук только на переходе повода в новое состояние, пачка за
 * окно играет один звук высшего приоритета, троттлинг на звук, фокус,
 * режим «Только важное».
 */
import type { SoundMode } from './settings';

export type SoundName = 'tick' | 'sent' | 'message' | 'ask' | 'done' | 'release' | 'alert' | 'limit';

/** Уровень A — внимание и вехи, B — тихий отклик на действия владельца. */
export const SOUND_LEVEL: Record<SoundName, 'A' | 'B'> = {
  tick: 'B', sent: 'B', message: 'A', ask: 'A', done: 'A', release: 'A', alert: 'A', limit: 'A',
};

/** Приоритет в пачке: левее — важнее (alert > limit > ask > message > release > done). */
export const BATCH_PRIORITY: readonly SoundName[] = ['alert', 'limit', 'ask', 'message', 'release', 'done'];

export const BATCH_MS = 1500;
export const THROTTLE_MS = 3000;
export const TICK_THROTTLE_MS = 150;

export const throttleMs = (name: SoundName): number => (name === 'tick' ? TICK_THROTTLE_MS : THROTTLE_MS);

/** Что сейчас видно на экране: от этого зависит правило фокуса. */
export interface FocusState {
  /** Окно видно и в фокусе. */
  focused: boolean;
  /** Открыт чат с менеджером. */
  pmChatOpen: boolean;
  /** Открыта «Жизнь офиса». */
  lifeOpen: boolean;
}

/**
 * Молчит ли звук, потому что его источник открыт перед глазами: message — при
 * открытом чате PM, ask — при открытой «Жизни офиса». alert, limit, release
 * звучат всегда. Окно не в фокусе — правило не действует.
 */
export function mutedByFocus(name: SoundName, f: FocusState): boolean {
  if (!f.focused) return false;
  if (name === 'message') return f.pmChatOpen;
  if (name === 'ask') return f.lifeOpen;
  return false;
}

/** В режиме «Только важное» уровень B молчит. */
export const allowedByMode = (name: SoundName, mode: SoundMode): boolean =>
  mode === 'all' || SOUND_LEVEL[name] === 'A';

/**
 * Дедуп поводов. Звук играет на переходе повода в новое состояние: снимок
 * (первое подключение, переподключение, смена офиса) только запоминает набор,
 * ушедший повод забывается и при возвращении зазвучит снова.
 */
export function createKnown() {
  let keys: Set<string> | null = null;
  return {
    /** Снимок: запомнить, не играть. */
    baseline(now: Iterable<string>): void {
      keys = new Set(now);
    },
    /** Новые ключи относительно запомненных; набор обновляется. До снимка — пусто. */
    fresh(now: Iterable<string>): string[] {
      const next = new Set(now);
      if (!keys) { keys = next; return []; }
      const out = [...next].filter((k) => !keys!.has(k));
      keys = next;
      return out;
    },
    reset(): void { keys = null; },
  };
}

/** Множество уже виденных ключей без забывания (реплики PM по id), с потолком размера. */
export function createSeen(limit = 500) {
  const seen = new Set<string>();
  return {
    /** true — ключ новый и теперь запомнен. */
    add(key: string): boolean {
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > limit) seen.delete(seen.values().next().value as string);
      return true;
    },
    has: (key: string): boolean => seen.has(key),
    clear(): void { seen.clear(); },
  };
}

export interface GateDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  /** Проиграть звук. Исключения глотает вызывающий. */
  play: (name: SoundName) => void;
  mode: () => SoundMode;
  enabled: () => boolean;
  focus: () => FocusState;
  /** Эта вкладка — та, что звучит. */
  isLeader: () => boolean;
}

/**
 * Решатель: принимает запросы на звук и решает, играть ли. Звуки уровня A идут
 * через окно пачки — за BATCH_MS играет один, высшего приоритета. tick и sent
 * играют сразу (за вычетом троттлинга): это отклик на свои действия.
 */
export function createGate(deps: GateDeps) {
  const lastAt = new Map<SoundName, number>();
  let batch: SoundName[] | null = null;

  const throttled = (name: SoundName): boolean => {
    const at = lastAt.get(name);
    return at !== undefined && deps.now() - at < throttleMs(name);
  };

  const fire = (name: SoundName): boolean => {
    if (!deps.enabled() || !deps.isLeader()) return false;
    if (!allowedByMode(name, deps.mode())) return false;
    if (throttled(name)) return false;
    lastAt.set(name, deps.now());
    deps.play(name);
    return true;
  };

  const flush = (): void => {
    const picked = batch;
    batch = null;
    if (!picked) return;
    // Высший приоритет, не заглушённый троттлингом: иначе пачка из alert и
    // done при свежем alert потеряла бы и done, который мог прозвучать.
    for (const name of BATCH_PRIORITY) {
      if (!picked.includes(name) || throttled(name)) continue;
      fire(name);
      return;
    }
  };

  return {
    request(name: SoundName): void {
      if (!deps.enabled()) return;
      if (mutedByFocus(name, deps.focus())) return;
      if (SOUND_LEVEL[name] === 'B') { fire(name); return; }
      if (!batch) {
        batch = [name];
        deps.setTimer(flush, BATCH_MS);
      } else {
        batch.push(name);
      }
    },
    /** Тест: сколько запросов копится в пачке. */
    pending: (): number => batch?.length ?? 0,
  };
}

/**
 * Аренда «звучит эта вкладка». Хранилище общее у вкладок (localStorage):
 * кто взял аренду и обновляет её, тот и играет; вкладка с устаревшей арендой
 * (закрыта или зависла) уступает. Фокусная вкладка забирает аренду сразу.
 */
export const LEASE_TTL_MS = 5000;

export interface LeaseStore {
  read: () => { id: string; at: number } | null;
  write: (v: { id: string; at: number }) => void;
}

export function createLease(id: string, store: LeaseStore, now: () => number) {
  return {
    /** Эта вкладка звучит? Берёт аренду, если она свободна или своя; hasFocus забирает силой. */
    acquire(hasFocus: boolean): boolean {
      const cur = store.read();
      const t = now();
      if (!cur || cur.id === id || t - cur.at > LEASE_TTL_MS || hasFocus) {
        store.write({ id, at: t });
        return true;
      }
      return false;
    },
  };
}

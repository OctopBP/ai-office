/**
 * Движок звука: ленивый AudioContext, пробуждение первым жестом, решатель из
 * gate.ts. До жеста и при любой ошибке молчит — звук ничего не блокирует.
 */
import { createGate, createLease, type FocusState, type SoundName } from './gate';
import { getSoundSettings } from './settings';
import { schedule } from './synth';

let ctx: AudioContext | null = null;
let focusProvider: () => FocusState = () => ({ focused: true, pmChatOpen: false, lifeOpen: false });

/** Страница даёт знание о том, что открыто (events.ts), чтобы движок не знал о сторе. */
export function setFocusProvider(fn: () => FocusState): void {
  focusProvider = fn;
}

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Разбудить контекст: вызывается на жесте. До первого жеста звука нет. */
export function unlockSound(): void {
  try {
    const c = ensureContext();
    if (c && c.state === 'suspended') void c.resume().catch(() => {});
  } catch {
    // нет Web Audio — молчим
  }
}

let unlocked = false;
export function installUnlock(): () => void {
  const on = () => { unlocked = true; unlockSound(); };
  const opts = { capture: true } as const;
  window.addEventListener('pointerdown', on, opts);
  window.addEventListener('keydown', on, opts);
  return () => {
    window.removeEventListener('pointerdown', on, opts);
    window.removeEventListener('keydown', on, opts);
  };
}

/** Прямое проигрывание: громкость учитывается, правила и выключатель — нет («Проверить звук»). */
export function preview(name: SoundName): void {
  try {
    unlockSound();
    if (!ctx || ctx.state !== 'running') return;
    schedule(ctx, name, getSoundSettings().volume);
  } catch {
    // звук не должен ломать офис
  }
}

const LEASE_KEY = 'office-sound-lease';
const tabId = Math.random().toString(36).slice(2);
const lease = createLease(tabId, {
  read: () => {
    try {
      const raw = localStorage.getItem(LEASE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  write: (v) => {
    try { localStorage.setItem(LEASE_KEY, JSON.stringify(v)); } catch { /* ignore */ }
  },
}, () => Date.now());

const gate = createGate({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  play: (name) => {
    if (!unlocked) return;
    preview(name);
  },
  mode: () => getSoundSettings().mode,
  enabled: () => getSoundSettings().enabled,
  focus: () => focusProvider(),
  isLeader: () => lease.acquire(document.hasFocus() && !document.hidden),
});

/** Запросить звук по правилам офиса: режим, фокус, пачка, троттлинг, одна вкладка. */
export function play(name: SoundName): void {
  try {
    gate.request(name);
  } catch {
    // глотаем
  }
}

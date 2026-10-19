/**
 * Синтез звуков офиса на Web Audio: без зависимостей и файлов. Одна семья —
 * синус с короткой атакой и спадом, ноты пентатоники C (C–D–E–G–A), без
 * реверба. Вверх — хорошее или «ответь», вниз — проблема. Звуки различаются
 * контуром, а не тембром. Частоты, длительности и уровни подбираются на слух.
 */
import type { SoundName } from './gate';

interface Note { hz: number; at: number; dur: number; gain?: number }
interface Voice { notes: Note[]; level: number; lowpass?: number }

const G3 = 196.0;
const C5 = 523.25; const E5 = 659.25; const G5 = 783.99; const A5 = 880.0;
const C6 = 1046.5;

/** level: A громче B примерно на 9 дБ (0,35 ≈ −9 дБ). */
const A = 1;
const B = 0.35;

export const VOICES: Record<SoundName, Voice> = {
  tick: { level: B, notes: [{ hz: 1200, at: 0, dur: 0.04 }] },
  sent: { level: B * 0.8, notes: [{ hz: G5, at: 0, dur: 0.06 }, { hz: C6, at: 0.06, dur: 0.06 }] },
  message: { level: A * 0.8, notes: [{ hz: E5, at: 0, dur: 0.2 }] },
  ask: { level: A, notes: [{ hz: E5, at: 0, dur: 0.18 }, { hz: A5, at: 0.2, dur: 0.2 }] },
  done: {
    level: A,
    notes: [{ hz: C5, at: 0, dur: 0.15 }, { hz: E5, at: 0.15, dur: 0.15 }, { hz: G5, at: 0.3, dur: 0.15 }],
  },
  release: {
    level: A,
    notes: [
      { hz: C5, at: 0, dur: 0.2 }, { hz: E5, at: 0.18, dur: 0.2 }, { hz: G5, at: 0.36, dur: 0.2 },
      { hz: C6, at: 0.54, dur: 0.36 },
    ],
  },
  // Вниз и приглушённо: срезаем верх, чтобы тревога не била по ушам.
  alert: { level: A * 0.9, lowpass: 1500, notes: [{ hz: E5, at: 0, dur: 0.17 }, { hz: C5, at: 0.18, dur: 0.17 }] },
  limit: { level: A, notes: [{ hz: G3, at: 0, dur: 0.5 }] },
};

export const SOUND_NAMES = Object.keys(VOICES) as SoundName[];

const ATTACK = 0.005;

/** Расписать звук на контексте. Громкость — общая (0..1), уровень голоса учитывается здесь. */
export function schedule(ctx: AudioContext, name: SoundName, volume: number): void {
  const voice = VOICES[name];
  const t0 = ctx.currentTime + 0.01;
  const master = ctx.createGain();
  master.gain.value = Math.min(1, Math.max(0, volume)) * voice.level;
  let sink: AudioNode = master;
  if (voice.lowpass) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = voice.lowpass;
    lp.connect(master);
    sink = lp;
  }
  master.connect(ctx.destination);
  for (const n of voice.notes) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.hz;
    const start = t0 + n.at;
    const peak = (n.gain ?? 1) * 0.5;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(peak, start + ATTACK);
    env.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
    osc.connect(env).connect(sink);
    osc.start(start);
    osc.stop(start + n.dur + 0.02);
  }
}

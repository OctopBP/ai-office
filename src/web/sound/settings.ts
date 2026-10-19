/**
 * Настройки звука: свойство устройства, поэтому localStorage, а не серверные
 * настройки офиса. Свой ключ, от переключателя системных уведомлений не зависит.
 */
export type SoundMode = 'important' | 'all';

export interface SoundSettings {
  enabled: boolean;
  /** 0..1 */
  volume: number;
  /** important — только уровень A (внимание и вехи), all — A и B (тихий отклик). */
  mode: SoundMode;
}

export const SOUND_STORAGE_KEY = 'office-sound';

export const DEFAULT_SOUND_SETTINGS: SoundSettings = { enabled: true, volume: 0.4, mode: 'important' };

/** Привести прочитанное к настройкам: чужие и битые значения заменяются умолчаниями. */
export function normalizeSoundSettings(raw: unknown): SoundSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const volume = typeof o.volume === 'number' && Number.isFinite(o.volume)
    ? Math.min(1, Math.max(0, o.volume))
    : DEFAULT_SOUND_SETTINGS.volume;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_SOUND_SETTINGS.enabled,
    volume,
    mode: o.mode === 'all' || o.mode === 'important' ? o.mode : DEFAULT_SOUND_SETTINGS.mode,
  };
}

function load(): SoundSettings {
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    return normalizeSoundSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SOUND_SETTINGS };
  }
}

let current: SoundSettings | null = null;
const listeners = new Set<(s: SoundSettings) => void>();

export function getSoundSettings(): SoundSettings {
  if (!current) current = load();
  return current;
}

/** Применить часть настроек, сохранить и сообщить подписчикам. */
export function setSoundSettings(patch: Partial<SoundSettings>): SoundSettings {
  current = normalizeSoundSettings({ ...getSoundSettings(), ...patch });
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Хранилище закрыто или полно — настройка живёт до перезагрузки, звук не ломается.
  }
  for (const l of listeners) l(current);
  return current;
}

export function subscribeSoundSettings(listener: (s: SoundSettings) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Другая вкладка поменяла настройки — подтянуть. */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== SOUND_STORAGE_KEY) return;
    current = load();
    for (const l of listeners) l(current);
  });
}

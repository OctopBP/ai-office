/**
 * Чтение и запись раскладки в localStorage по офису (§2.8). Ключ
 * `office.layout.v1:<officeId>`. Битые или неизвестные данные — умолчание.
 * Разворот на весь экран и состояние переноса не сохраняются: их нет в Layout.
 */
import { defaultLayout, normalize, type Layout } from './model';

export const LAYOUT_KEY_PREFIX = 'office.layout.v1:';
export const SAVE_DELAY_MS = 300;

/** Минимум интерфейса хранилища — чтобы тестировать без DOM. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const layoutKey = (officeId: string) => `${LAYOUT_KEY_PREFIX}${officeId}`;

function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadLayout(officeId: string, store: KeyValueStore | null = browserStore()): Layout {
  if (!store) return defaultLayout();
  try {
    const text = store.getItem(layoutKey(officeId));
    if (!text) return defaultLayout();
    return normalize(JSON.parse(text)) ?? defaultLayout();
  } catch {
    return defaultLayout();
  }
}

export function saveLayout(officeId: string, layout: Layout, store: KeyValueStore | null = browserStore()): void {
  if (!store) return;
  try {
    store.setItem(layoutKey(officeId), JSON.stringify(layout));
  } catch {
    /* переполнено или запрещено — раскладка не критична */
  }
}

/** Запись с задержкой: частые изменения (перетаскивание) сливаются в одну. */
export function createSaver(
  store: KeyValueStore | null = browserStore(),
  delay = SAVE_DELAY_MS,
): { schedule(officeId: string, layout: Layout): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { officeId: string; layout: Layout } | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending) saveLayout(pending.officeId, pending.layout, store);
    pending = null;
  };
  return {
    schedule(officeId, layout) {
      // Смена офиса — сначала дописываем прежний.
      if (pending && pending.officeId !== officeId) flush();
      pending = { officeId, layout };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flush,
  };
}

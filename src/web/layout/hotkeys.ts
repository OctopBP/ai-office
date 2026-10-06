/**
 * Горячие клавиши оконной системы (спека window-system §2.7): чистое
 * сопоставление «событие → действие» и выполнение действия через операции
 * стора раскладки. Подписка на window — тонкий хук `useLayoutHotkeys` внизу файла, логики в нём нет.
 * Новые сочетания добавляются здесь и в справку.
 */
import { useEffect } from 'react';
import { useLayout } from './store';
import { DOCK_IDS, makeRef, type DockId, type Layout, type LayoutRuntime } from './model';

export type HotkeyAction =
  | { type: 'toggle-bottom' }
  | { type: 'new-terminal' }
  | { type: 'collapse-bottom' }
  | { type: 'maximize' }
  | { type: 'move'; dock: DockId }
  | { type: 'focus'; target: DockId | 'main' }
  | { type: 'tab'; step: 1 | -1 }
  | { type: 'close-tab' }
  | { type: 'escape' };

/** То, что сочетанию нужно знать о событии, — без DOM, чтобы тестировать. */
export interface KeyInfo {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const ARROW_DOCK: Record<string, DockId> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'bottom' };
const DIGIT_FOCUS: Record<string, DockId | 'main'> = {
  Digit1: 'left', Digit2: 'main', Digit3: 'right', Digit4: 'bottom',
};

/**
 * Какое действие вызывает сочетание. `inDock` — фокус раскладки в доке:
 * ⌘⇧↵, ⌘W и Ctrl+Tab касаются только дока. Платформенный модификатор —
 * `⌘` или `Ctrl` (как у терминала: `metaKey || ctrlKey`).
 */
export function matchHotkey(e: KeyInfo, inDock: boolean): HotkeyAction | null {
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return { type: 'escape' };

  // Ctrl+Tab — именно Ctrl, на macOS ⌘Tab съедает система.
  if (e.code === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
    return inDock ? { type: 'tab', step: e.shiftKey ? -1 : 1 } : null;
  }

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;

  if (e.code === 'Backquote' && !e.altKey) return e.shiftKey ? { type: 'new-terminal' } : { type: 'toggle-bottom' };

  if (e.altKey && !e.shiftKey) {
    // Цифры и стрелки — по физической клавише: Alt на macOS меняет символ.
    const dock = ARROW_DOCK[e.code];
    if (dock) return { type: 'move', dock };
    const target = DIGIT_FOCUS[e.code];
    if (target) return { type: 'focus', target };
    return null;
  }
  if (e.altKey) return null;

  if (e.code === 'KeyJ' && !e.shiftKey) return { type: 'collapse-bottom' };
  if (e.code === 'Enter' && e.shiftKey) return inDock ? { type: 'maximize' } : null;
  if (e.code === 'KeyW' && !e.shiftKey) return inDock ? { type: 'close-tab' } : null;
  return null;
}

/**
 * Действия, которые работают и в поле ввода, и внутри терминала: спека §2.7 —
 * в терминале ⌘` и ⌘⌥… перехватываются раньше xterm, остальное уходит в него.
 */
export function worksInTextTarget(a: HotkeyAction): boolean {
  return a.type === 'toggle-bottom' || a.type === 'new-terminal' || a.type === 'move' || a.type === 'focus';
}

/** Фокус в поле ввода или в xterm (у xterm свой скрытый textarea). */
export function isTextTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n || typeof n.tagName !== 'string') return false;
  if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT') return true;
  if (n.isContentEditable) return true;
  return typeof n.closest === 'function' && n.closest('.xterm') !== null;
}

/** Номер следующего терминала: наибольший `terminal:N` плюс один. */
export function nextTerminalId(layout: Layout): string {
  let max = 0;
  for (const d of DOCK_IDS) {
    for (const w of layout.docks[d]?.tabs ?? []) {
      if (w.kind !== 'terminal') continue;
      const n = Number(w.arg ?? 1);
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return `${max + 1}`;
}

/** Операции стора, которые нужны действиям. `useLayout.getState()` ему подходит. */
export interface HotkeyApi extends Pick<LayoutRuntime, 'maximized' | 'drag'> {
  layout: Layout;
  openWindow(ref: ReturnType<typeof makeRef>, dock?: DockId): void;
  toggleDock(dock: DockId): void;
  toggleCollapsed(dock: DockId): void;
  moveWindow(id: string, dock: DockId): void;
  activate(dock: DockId, id: string): void;
  closeWindow(id: string): void;
  setFocus(focus: DockId | 'main'): void;
  maximize(dock: DockId | null): void;
  setDrag(drag: LayoutRuntime['drag']): void;
}

/**
 * Выполнить действие. Возвращает, «съедено» ли оно: Esc, которому нечего
 * отменять, остаётся приложению (закрыть модалку, вернуть вид «Офис»).
 */
export function runHotkey(a: HotkeyAction, api: HotkeyApi): boolean {
  const { layout } = api;
  const focused = layout.focus === 'main' ? null : layout.focus;
  const state = focused ? layout.docks[focused] : undefined;
  switch (a.type) {
    case 'toggle-bottom': {
      // Нижнего дока нет — открыть терминал по умолчанию («Терминал 1»); иначе показать/скрыть.
      if (!layout.docks.bottom) api.openWindow(makeRef('terminal', '1'), 'bottom');
      else api.toggleDock('bottom');
      return true;
    }
    case 'new-terminal':
      api.openWindow(makeRef('terminal', nextTerminalId(layout)), 'bottom');
      return true;
    case 'collapse-bottom':
      if (!layout.docks.bottom) return false;
      api.toggleCollapsed('bottom');
      return true;
    case 'maximize':
      if (!focused) return false;
      api.maximize(focused);
      return true;
    case 'move': {
      // Только активная вкладка дока, в котором фокус; в основной области переносить нечего.
      if (!focused || !state?.active || focused === a.dock) return false;
      api.moveWindow(state.active, a.dock);
      return true;
    }
    case 'focus':
      // Дока нет — фокусировать нечего, клавишу не съедаем.
      if (a.target !== 'main' && !layout.docks[a.target]) return false;
      api.setFocus(a.target);
      return true;
    case 'tab': {
      if (!focused || !state || state.tabs.length < 2) return false;
      const i = state.tabs.findIndex((w) => w.id === state.active);
      const next = state.tabs[(i + a.step + state.tabs.length) % state.tabs.length]!;
      api.activate(focused, next.id);
      return true;
    }
    case 'close-tab':
      if (!state?.active) return false;
      api.closeWindow(state.active);
      return true;
    case 'escape':
      if (api.drag) { api.setDrag(null); return true; }
      if (api.maximized) { api.maximize(null); return true; }
      return false;
  }
}

/** Где стоит фокус по DOM: в доке, в основной области или нигде из них (null). */
function focusFromTarget(t: EventTarget | null): DockId | 'main' | null {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return null;
  const dock = el.closest<HTMLElement>('.dock');
  if (dock) {
    const id = (['bottom', 'right', 'left'] as const).find((d) => dock.classList.contains(`dock-${d}`));
    if (id) return id;
  }
  return el.closest('.work-main') ? 'main' : null;
}

/** Переместить DOM-фокус в док или основную область, чтобы клавиши шли туда. */
function focusDom(target: DockId | 'main'): void {
  const el = target === 'main'
    ? document.querySelector<HTMLElement>('.work-main')
    : document.querySelector<HTMLElement>(`.dock-${target} [role="tab"][tabindex="0"]`)
      ?? document.querySelector<HTMLElement>(`.dock-${target}`);
  if (!el) return;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

/** Capture-фаза: Esc и ⌘` не делятся с обработчиками `App.tsx`. */
export function useLayoutHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      // Фокус для клавиш — там, где он на самом деле (клик мимо вкладки его не сдвигает в сторе).
      const where = focusFromTarget(e.target);
      if (where && where !== useLayout.getState().layout.focus) useLayout.getState().setFocus(where);
      const st = useLayout.getState();
      const action = matchHotkey(e, st.layout.focus !== 'main');
      if (!action) return;
      if (isTextTarget(e.target) && !worksInTextTarget(action)) return;
      if (!runHotkey(action, st)) return;
      e.preventDefault();
      e.stopPropagation();
      if (action.type === 'focus') focusDom(action.target);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

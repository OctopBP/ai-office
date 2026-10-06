/**
 * Модель раскладки окон: типы и чистые функции `Layout → Layout`.
 * Без React и DOM — раскладка это интерфейсное состояние, а не источник
 * правды, и тестируется отдельно (`npm run test:layout`).
 * Спека: docs/design/window-system/spec.md, §2 и §4.
 */

import type { DropGeometry, DropTarget } from './dropzone';

/** Окно, которое можно положить во вкладку дока. Основные виды сюда не входят. */
export type WindowKind =
  | 'terminal' | 'docs' | 'log' | 'money' | 'merge' | 'meetings'
  | 'diff' | 'agent' | 'task';

export const WINDOW_KINDS: readonly WindowKind[] = [
  'terminal', 'docs', 'log', 'money', 'merge', 'meetings', 'diff', 'agent', 'task',
];

export interface WindowRef {
  /** Стабильный ключ вкладки: 'terminal:1', 'diff:T-12', 'agent:backend'. */
  id: string;
  kind: WindowKind;
  /** Параметр экземпляра: номер терминала, id задачи или агента. */
  arg?: string;
}

export type DockId = 'bottom' | 'right' | 'left';
export const DOCK_IDS: readonly DockId[] = ['bottom', 'right', 'left'];

export interface DockState {
  tabs: WindowRef[];
  /** id активной вкладки; null — вкладок нет. */
  active: string | null;
  /** px: высота (bottom) или ширина (right/left). */
  size: number;
  /** Свёрнут в полоску. */
  collapsed: boolean;
}

export interface Layout {
  v: 1;
  /** Нет ключа — дока нет. */
  docks: Partial<Record<DockId, DockState>>;
  /** Где фокус для горячих клавиш. */
  focus: DockId | 'main';
}

/** Живое, не сохраняемое. */
export interface LayoutRuntime {
  maximized: DockId | null;
  drag: {
    win: string;
    label: string;
    /** Курсор, px окна. */
    x: number;
    y: number;
    over: DropTarget | null;
    geo: DropGeometry;
  } | null;
  /** Размер окна — для режима «узко» и зажима размеров. */
  viewport: { w: number; h: number };
}

// ---------------------------------------------------------------- размеры

export const DOCK_DEFAULT: Record<DockId, number> = { bottom: 280, right: 430, left: 430 };
export const DOCK_MIN: Record<DockId, number> = { bottom: 120, right: 280, left: 280 };
/** Доля рабочей колонки, которую док может занять. */
export const DOCK_MAX_RATIO: Record<DockId, number> = { bottom: 0.7, right: 0.6, left: 0.6 };
/** Минимум основной области. */
export const MAIN_MIN = { w: 360, h: 240 };
/** Толщина свёрнутой полоски. */
export const STRIP_SIZE = 26;
export const KEY_STEP = 16;
export const KEY_STEP_BIG = 64;

/** Куда по умолчанию открывается окно. */
export const DEFAULT_DOCK: Record<WindowKind, DockId> = {
  terminal: 'bottom', log: 'bottom', merge: 'bottom', diff: 'bottom',
  docs: 'right', money: 'right', meetings: 'right', agent: 'right', task: 'right',
};

/** Размер рабочей колонки (то, что делят основная область и доки). */
export interface Extent { w: number; h: number }

const isBottom = (d: DockId) => d === 'bottom';

/**
 * Допустимый диапазон размера дока при данной рабочей колонке. Минимум
 * основной области (360×240) уменьшает максимум с учётом соседнего дока.
 * Если места не хватает даже на минимум дока — отдаём минимум: он важнее.
 */
export function dockRange(dock: DockId, layout: Layout, col: Extent): { min: number; max: number } {
  const min = DOCK_MIN[dock];
  const total = isBottom(dock) ? col.h : col.w;
  let max = Math.floor(total * DOCK_MAX_RATIO[dock]);
  const used = (d: DockId): number => {
    const s = layout.docks[d];
    if (!s) return 0;
    return s.collapsed ? STRIP_SIZE : s.size;
  };
  if (isBottom(dock)) {
    max = Math.min(max, col.h - MAIN_MIN.h);
  } else {
    const other: DockId = dock === 'right' ? 'left' : 'right';
    max = Math.min(max, col.w - MAIN_MIN.w - used(other));
  }
  return { min, max: Math.max(min, max) };
}

export function clampSize(dock: DockId, px: number, layout: Layout, col: Extent): number {
  const { min, max } = dockRange(dock, layout, col);
  if (!Number.isFinite(px)) return DOCK_DEFAULT[dock];
  return Math.round(Math.min(max, Math.max(min, px)));
}

/** Размеры для отрисовки: зажатые под текущую колонку, состояние не портим. */
export function effectiveSize(dock: DockId, layout: Layout, col: Extent): number {
  const s = layout.docks[dock];
  if (!s) return 0;
  return clampSize(dock, s.size, layout, col);
}

// --------------------------------------------------------------- создание

export function defaultLayout(): Layout {
  return { v: 1, docks: {}, focus: 'main' };
}

export function windowId(kind: WindowKind, arg?: string): string {
  return arg === undefined || arg === '' ? kind : `${kind}:${arg}`;
}

export function makeRef(kind: WindowKind, arg?: string): WindowRef {
  const ref: WindowRef = { id: windowId(kind, arg), kind };
  if (arg !== undefined && arg !== '') ref.arg = arg;
  return ref;
}

// ------------------------------------------------------------- поиск

export function findWindow(layout: Layout, id: string): { dock: DockId; index: number } | null {
  for (const dock of DOCK_IDS) {
    const index = layout.docks[dock]?.tabs.findIndex((w) => w.id === id) ?? -1;
    if (index >= 0) return { dock, index };
  }
  return null;
}

// ------------------------------------------------- внутренние помощники

function withDock(layout: Layout, dock: DockId, next: DockState | null): Layout {
  const docks = { ...layout.docks };
  if (next && next.tabs.length > 0) docks[dock] = next;
  else delete docks[dock];
  let focus = layout.focus;
  if (focus !== 'main' && !docks[focus]) focus = 'main';
  return { ...layout, docks, focus };
}

function newDock(dock: DockId, ref: WindowRef): DockState {
  return { tabs: [ref], active: ref.id, size: DOCK_DEFAULT[dock], collapsed: false };
}

// ------------------------------------------------------------- действия

/** Открыть окно; если уже есть — сфокусировать (и развернуть его док). */
export function openWindow(layout: Layout, ref: WindowRef, dock?: DockId): Layout {
  const at = findWindow(layout, ref.id);
  if (at) {
    const s = layout.docks[at.dock]!;
    return { ...withDock(layout, at.dock, { ...s, active: ref.id, collapsed: false }), focus: at.dock };
  }
  const target = dock ?? DEFAULT_DOCK[ref.kind];
  const s = layout.docks[target];
  const next = s ? { ...s, tabs: [...s.tabs, ref], active: ref.id, collapsed: false } : newDock(target, ref);
  return { ...withDock(layout, target, next), focus: target };
}

/** После снятия вкладки active указывает на соседа слева, иначе справа. */
function pickActive(tabs: WindowRef[], removedIndex: number): string | null {
  if (tabs.length === 0) return null;
  return tabs[Math.min(Math.max(removedIndex - 1, 0), tabs.length - 1)]!.id;
}

export function closeWindow(layout: Layout, id: string): Layout {
  const at = findWindow(layout, id);
  if (!at) return layout;
  const s = layout.docks[at.dock]!;
  const tabs = s.tabs.filter((w) => w.id !== id);
  const active = s.active === id ? pickActive(tabs, at.index) : s.active;
  return withDock(layout, at.dock, { ...s, tabs, active });
}

export function activate(layout: Layout, dock: DockId, id: string): Layout {
  const s = layout.docks[dock];
  if (!s || !s.tabs.some((w) => w.id === id)) return layout;
  return { ...withDock(layout, dock, { ...s, active: id, collapsed: false }), focus: dock };
}

/** Перенести окно в другой док (в конец или на место `index`). Свой док — как reorder. */
export function moveWindow(layout: Layout, id: string, dock: DockId, index?: number): Layout {
  const at = findWindow(layout, id);
  if (!at) return layout;
  const ref = layout.docks[at.dock]!.tabs[at.index]!;
  if (at.dock === dock) {
    const to = index === undefined ? layout.docks[dock]!.tabs.length - 1 : index;
    return reorder(layout, dock, at.index, to);
  }
  const without = closeWindow(layout, id);
  const s = without.docks[dock];
  let next: DockState;
  if (s) {
    const tabs = [...s.tabs];
    const i = index === undefined ? tabs.length : Math.min(Math.max(index, 0), tabs.length);
    tabs.splice(i, 0, ref);
    next = { ...s, tabs, active: id, collapsed: false };
  } else {
    next = newDock(dock, ref);
  }
  return { ...withDock(without, dock, next), focus: dock };
}

export function reorder(layout: Layout, dock: DockId, from: number, to: number): Layout {
  const s = layout.docks[dock];
  if (!s) return layout;
  const n = s.tabs.length;
  if (from < 0 || from >= n) return layout;
  const dest = Math.min(Math.max(to, 0), n - 1);
  if (dest === from) return layout;
  const tabs = [...s.tabs];
  const [ref] = tabs.splice(from, 1);
  tabs.splice(dest, 0, ref!);
  return withDock(layout, dock, { ...s, tabs });
}

/** Задать размер дока с зажимом (§2.3). */
export function resizeDock(layout: Layout, dock: DockId, px: number, col: Extent): Layout {
  const s = layout.docks[dock];
  if (!s) return layout;
  const size = clampSize(dock, px, layout, col);
  return size === s.size ? layout : withDock(layout, dock, { ...s, size });
}

/** Сбросить размер к умолчанию (двойной клик по разделителю). */
export function resetDockSize(layout: Layout, dock: DockId, col: Extent): Layout {
  return resizeDock(layout, dock, DOCK_DEFAULT[dock], col);
}

export function toggleCollapsed(layout: Layout, dock: DockId): Layout {
  const s = layout.docks[dock];
  if (!s) return layout;
  return withDock(layout, dock, { ...s, collapsed: !s.collapsed });
}

/**
 * Скрыть/показать док как ⌘`: есть и развёрнут — свернуть; свёрнут —
 * развернуть; нет дока — открыть терминал (нижний) по умолчанию.
 */
export function toggleDock(layout: Layout, dock: DockId): Layout {
  const s = layout.docks[dock];
  if (s) return toggleCollapsed(layout, dock);
  if (dock === 'bottom') return openWindow(layout, makeRef('terminal', '1'), 'bottom');
  return layout;
}

/** Закрыть все вкладки дока, кроме указанной (меню «⋯»). */
export function closeOthers(layout: Layout, dock: DockId, keepId: string): Layout {
  const s = layout.docks[dock];
  if (!s) return layout;
  const tabs = s.tabs.filter((w) => w.id === keepId);
  return withDock(layout, dock, { ...s, tabs, active: tabs.length ? keepId : null });
}

export function setFocus(layout: Layout, focus: DockId | 'main'): Layout {
  if (focus !== 'main' && !layout.docks[focus]) return layout;
  return layout.focus === focus ? layout : { ...layout, focus };
}

// ------------------------------------------------------------ runtime

export function defaultRuntime(viewport: { w: number; h: number } = { w: 1440, h: 900 }): LayoutRuntime {
  return { maximized: null, drag: null, viewport };
}

/** Разворот на весь экран: повтор того же дока — вернуть. */
export function maximizeRuntime(rt: LayoutRuntime, layout: Layout, dock: DockId | null): LayoutRuntime {
  if (dock === null || rt.maximized === dock || !layout.docks[dock]) return { ...rt, maximized: null };
  return { ...rt, maximized: dock };
}

/** Если развёрнутый док исчез (закрыли последнюю вкладку) — разворот снимается. */
export function syncRuntime(rt: LayoutRuntime, layout: Layout): LayoutRuntime {
  const maximized = rt.maximized && layout.docks[rt.maximized] ? rt.maximized : null;
  return maximized === rt.maximized ? rt : { ...rt, maximized };
}

/** Режим «узко» (< 900): боковые доки уходят вниз. Вычисляется, не хранится. */
export const NARROW_W = 900;
export const isNarrow = (viewport: { w: number }) => viewport.w < NARROW_W;

/** Раскладка для показа: в узком режиме вкладки боковых доков переезжают в нижний. */
export function displayLayout(layout: Layout, viewport: { w: number }): Layout {
  if (!isNarrow(viewport)) return layout;
  const side = (['left', 'right'] as DockId[]).filter((d) => layout.docks[d]);
  if (side.length === 0) return layout;
  const bottom = layout.docks.bottom;
  const tabs = [...(bottom?.tabs ?? [])];
  for (const d of side) tabs.push(...layout.docks[d]!.tabs);
  const docks: Layout['docks'] = {
    bottom: {
      tabs,
      active: bottom?.active ?? layout.docks[side[0]!]!.active,
      size: bottom?.size ?? DOCK_DEFAULT.bottom,
      collapsed: bottom?.collapsed ?? false,
    },
  };
  return { ...layout, docks, focus: layout.focus === 'main' ? 'main' : 'bottom' };
}

// ------------------------------------------------------- нормализация

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Привести произвольные данные к корректной раскладке или вернуть null.
 * Инварианты (§4): уникальные id во всём Layout; active существует; пустой
 * док удаляется; size в диапазоне (без знания колонки — по минимуму и
 * абсолютному потолку); неизвестный kind отбрасывается.
 */
export function normalize(raw: unknown): Layout | null {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.docks)) return null;
  const seen = new Set<string>();
  const docks: Layout['docks'] = {};
  for (const dock of DOCK_IDS) {
    const d = raw.docks[dock];
    if (!isRecord(d) || !Array.isArray(d.tabs)) continue;
    const tabs: WindowRef[] = [];
    for (const t of d.tabs) {
      if (!isRecord(t) || typeof t.id !== 'string' || t.id === '') continue;
      if (!WINDOW_KINDS.includes(t.kind as WindowKind)) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const ref: WindowRef = { id: t.id, kind: t.kind as WindowKind };
      if (typeof t.arg === 'string' && t.arg !== '') ref.arg = t.arg;
      tabs.push(ref);
    }
    if (tabs.length === 0) continue;
    const active = typeof d.active === 'string' && tabs.some((w) => w.id === d.active) ? d.active : tabs[0]!.id;
    const size = typeof d.size === 'number' && Number.isFinite(d.size)
      ? Math.round(Math.min(SIZE_CEIL, Math.max(DOCK_MIN[dock], d.size)))
      : DOCK_DEFAULT[dock];
    docks[dock] = { tabs, active, size, collapsed: d.collapsed === true };
  }
  const focus = raw.focus === 'main' || (typeof raw.focus === 'string' && docks[raw.focus as DockId])
    ? (raw.focus as DockId | 'main')
    : 'main';
  return { v: 1, docks, focus };
}

/** Абсолютный потолок размера при чтении: реальный зажим — по размеру окна. */
const SIZE_CEIL = 4000;

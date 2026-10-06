/**
 * Зоны сброса при перетаскивании вкладки (спека window-system §2.5): чистые
 * функции над прямоугольниками, без DOM. Геометрию снимает tabdrag.tsx.
 */
import { findWindow, moveWindow, type DockId, type Layout } from './model';

export interface Rect { x: number; y: number; w: number; h: number }

export interface DockGeometry {
  /** Весь док (у свёрнутого — полоска). */
  rect: Rect;
  /** Шапка со вкладками или полоска свёрнутого дока. */
  head: Rect;
  /** Вкладки по порядку. */
  tabs: Rect[];
  /** Вкладки стоят столбиком (боковая полоска свёрнутого дока). */
  vertical: boolean;
}

export interface DropGeometry {
  column: Rect;
  /** Только существующие доки. */
  docks: Partial<Record<DockId, DockGeometry>>;
}

/** Куда упадёт вкладка: на место `slot` в доке или в край рабочей колонки. */
export type DropTarget =
  | { kind: 'tab'; dock: DockId; slot: number }
  | { kind: 'edge'; dock: DockId };

/** Порог «отрыва» вкладки, px. */
export const DRAG_START = 6;
/** Доля колонки, отдаваемая зонам у краёв. */
export const EDGE_RATIO = 0.3;

export function pastThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_START;
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** Прямоугольник зоны у края колонки. */
export function edgeRect(column: Rect, dock: DockId): Rect {
  const w = column.w * EDGE_RATIO;
  const h = column.h * EDGE_RATIO;
  if (dock === 'left') return { x: column.x, y: column.y, w, h: column.h };
  if (dock === 'right') return { x: column.x + column.w - w, y: column.y, w, h: column.h };
  return { x: column.x, y: column.y + column.h - h, w: column.w, h };
}

/** Место вставки среди вкладок по середине каждой (0..n). */
export function slotAt(tabs: Rect[], vertical: boolean, x: number, y: number): number {
  let slot = 0;
  for (const r of tabs) {
    const mid = vertical ? r.y + r.h / 2 : r.x + r.w / 2;
    if ((vertical ? y : x) > mid) slot++;
  }
  return slot;
}

/** Зона под курсором. Приоритет: шапка дока → край колонки → тело дока. */
export function resolveDrop(x: number, y: number, g: DropGeometry): DropTarget | null {
  for (const dock of ['bottom', 'right', 'left'] as const) {
    const d = g.docks[dock];
    if (d && inside(d.head, x, y)) return { kind: 'tab', dock, slot: slotAt(d.tabs, d.vertical, x, y) };
  }
  const c = g.column;
  if (!inside(c, x, y)) return null;
  // На стыке зон выигрывает та, куда курсор зашёл глубже (в долях зоны).
  const depth: Record<DockId, number> = {
    left: (c.x + c.w * EDGE_RATIO - x) / (c.w * EDGE_RATIO),
    right: (x - (c.x + c.w * (1 - EDGE_RATIO))) / (c.w * EDGE_RATIO),
    bottom: (y - (c.y + c.h * (1 - EDGE_RATIO))) / (c.h * EDGE_RATIO),
  };
  let best: DockId | null = null;
  for (const dock of ['bottom', 'right', 'left'] as const) {
    if (depth[dock] > 0 && (best === null || depth[dock] > depth[best])) best = dock;
  }
  if (best) return { kind: 'edge', dock: best };
  for (const dock of ['bottom', 'right', 'left'] as const) {
    const d = g.docks[dock];
    if (d && inside(d.rect, x, y)) return { kind: 'tab', dock, slot: d.tabs.length };
  }
  return null;
}

/** Подсветка цели: зона и (для вкладки) риска места вставки. */
export function highlightOf(t: DropTarget, g: DropGeometry): { zone: Rect; mark: Rect | null } | null {
  if (t.kind === 'edge') return { zone: edgeRect(g.column, t.dock), mark: null };
  const d = g.docks[t.dock];
  if (!d) return null;
  const MARK = 2;
  let mark: Rect | null = null;
  const first = d.tabs[0];
  if (!first) {
    mark = d.vertical
      ? { x: d.head.x, y: d.head.y, w: d.head.w, h: MARK }
      : { x: d.head.x, y: d.head.y, w: MARK, h: d.head.h };
  } else {
    const prev = d.tabs[t.slot - 1];
    const next = d.tabs[t.slot];
    if (d.vertical) {
      const y = next ? next.y : prev ? prev.y + prev.h : first.y;
      mark = { x: d.head.x, y: y - MARK / 2, w: d.head.w, h: MARK };
    } else {
      const x = next ? next.x : prev ? prev.x + prev.w : first.x;
      mark = { x: x - MARK / 2, y: d.head.y, w: MARK, h: d.head.h };
    }
  }
  return { zone: d.head, mark };
}

/** Применить сброс. Тот же док и край своего дока — без изменений. */
export function applyDrop(layout: Layout, win: string, t: DropTarget): Layout {
  const at = findWindow(layout, win);
  if (!at) return layout;
  if (t.kind === 'edge') return at.dock === t.dock ? layout : moveWindow(layout, win, t.dock);
  if (at.dock === t.dock) {
    // slot считается до изъятия вкладки: правее неё он сдвигается на один.
    return moveWindow(layout, win, t.dock, t.slot > at.index ? t.slot - 1 : t.slot);
  }
  return moveWindow(layout, win, t.dock, t.slot);
}

export const sameTarget = (a: DropTarget | null, b: DropTarget | null): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind && a.dock === b.dock && (a.kind === 'edge' || (b.kind === 'tab' && a.slot === b.slot)));

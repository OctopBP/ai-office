/**
 * Срез Zustand раскладки: применяет чистые функции из model.ts и сохраняет
 * результат по офису. Компоненты читают срез и зовут действия, логики в них нет.
 */
import { create } from 'zustand';
import {
  activate, closeOthers, closeWindow, defaultLayout, defaultRuntime, maximizeRuntime,
  moveWindow, openWindow, reorder, resetDockSize, resizeDock, setFocus, syncRuntime, toggleCollapsed,
  toggleDock, type DockId, type Extent, type Layout, type LayoutRuntime, type WindowRef,
} from './model';
import { applyDrop, type DropTarget } from './dropzone';
import { createSaver, loadLayout } from './persist';

const saver = createSaver();

interface LayoutState extends LayoutRuntime {
  officeId: string | null;
  layout: Layout;
  /** Размер рабочей колонки — для зажима; обновляет оболочка по ResizeObserver. */
  column: Extent;

  /** Загрузить раскладку офиса (при монтировании и смене офиса). */
  load(officeId: string | null): void;
  /** Дописать отложенную запись сразу — перед закрытием страницы. */
  flush(): void;
  setViewport(w: number, h: number): void;
  setColumn(w: number, h: number): void;

  openWindow(ref: WindowRef, dock?: DockId): void;
  closeWindow(id: string): void;
  activate(dock: DockId, id: string): void;
  moveWindow(id: string, dock: DockId, index?: number): void;
  reorder(dock: DockId, from: number, to: number): void;
  /** Сброс перетаскиваемой вкладки в выбранную зону. */
  dropWindow(win: string, target: DropTarget): void;
  resizeDock(dock: DockId, px: number): void;
  resetDockSize(dock: DockId): void;
  toggleCollapsed(dock: DockId): void;
  toggleDock(dock: DockId): void;
  closeOthers(dock: DockId, keepId: string): void;
  setFocus(focus: DockId | 'main'): void;
  maximize(dock: DockId | null): void;
  setDrag(drag: LayoutRuntime['drag']): void;
  reset(): void;
}

export const useLayout = create<LayoutState>((set, get) => {
  /** Применить преобразование раскладки, снять разворот исчезнувшего дока, сохранить. */
  const apply = (fn: (l: Layout, col: Extent) => Layout) => {
    const { layout, column, officeId } = get();
    const next = fn(layout, column);
    if (next === layout) return;
    set((s) => ({ layout: next, ...syncRuntime(s, next) }));
    if (officeId) saver.schedule(officeId, next);
  };

  return {
    officeId: null,
    layout: defaultLayout(),
    column: { w: 1200, h: 800 },
    ...defaultRuntime(),

    load(officeId) {
      saver.flush();
      set({ officeId, layout: officeId ? loadLayout(officeId) : defaultLayout(), maximized: null, drag: null });
    },
    flush: () => saver.flush(),
    setViewport: (w, h) => set({ viewport: { w, h } }),
    setColumn: (w, h) => set({ column: { w, h } }),

    openWindow: (ref, dock) => apply((l) => openWindow(l, ref, dock)),
    closeWindow: (id) => apply((l) => closeWindow(l, id)),
    activate: (dock, id) => apply((l) => activate(l, dock, id)),
    moveWindow: (id, dock, index) => apply((l) => moveWindow(l, id, dock, index)),
    reorder: (dock, from, to) => apply((l) => reorder(l, dock, from, to)),
    dropWindow: (win, target) => apply((l) => applyDrop(l, win, target)),
    resizeDock: (dock, px) => apply((l, col) => resizeDock(l, dock, px, col)),
    resetDockSize: (dock) => apply((l, col) => resetDockSize(l, dock, col)),
    toggleCollapsed: (dock) => apply((l) => toggleCollapsed(l, dock)),
    toggleDock: (dock) => apply((l) => toggleDock(l, dock)),
    closeOthers: (dock, keepId) => apply((l) => closeOthers(l, dock, keepId)),
    setFocus: (focus) => apply((l) => setFocus(l, focus)),
    maximize: (dock) => set((s) => maximizeRuntime(s, s.layout, dock)),
    setDrag: (drag) => set({ drag }),
    reset() {
      apply(() => defaultLayout());
      set({ maximized: null, drag: null });
    },
  };
});

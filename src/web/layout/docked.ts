/**
 * Окна рейла, которые живут в доках (спека window-system §1): документы, лог,
 * расходы, очередь слияния и совещания. Открытие — через стор раскладки; куда
 * класть, решает DEFAULT_DOCK, а перенесённое пользователем помнит раскладка.
 */
import { makeRef, findWindow, type WindowKind } from './model';
import { useLayout } from './store';

export const DOCKED_KINDS = ['docs', 'log', 'money', 'merge', 'meetings'] as const;
export type DockedKind = (typeof DOCKED_KINDS)[number];
export const isDockedKind = (k: string): k is DockedKind => (DOCKED_KINDS as readonly string[]).includes(k);

/** Открыть окно в его доке (если уже открыто — показать и сфокусировать). */
export function openDocked(kind: WindowKind): void {
  useLayout.getState().openWindow(makeRef(kind));
}

/** Горячая клавиша: открыто и на виду — закрыть вкладку, иначе открыть. */
export function toggleDocked(kind: WindowKind): void {
  const st = useLayout.getState();
  const at = findWindow(st.layout, kind);
  const dock = at && st.layout.docks[at.dock];
  if (at && dock && !dock.collapsed && dock.active === kind) st.closeWindow(kind);
  else openDocked(kind);
}

/** Окно открыто и является активной вкладкой своего дока — для подсветки в рейле. */
export function isDockedOn(layout: ReturnType<typeof useLayout.getState>['layout'], kind: WindowKind): boolean {
  const at = findWindow(layout, kind);
  return !!at && layout.docks[at.dock]!.active === kind;
}

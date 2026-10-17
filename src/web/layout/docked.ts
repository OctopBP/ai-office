/**
 * Окна рейла, которые живут в доках (спека window-system §1): очередь слияния.
 * Документы, лог, расходы и совещания — страницы главной области (`RailView`),
 * в доках их больше нет. Открытие — через стор раскладки; куда
 * класть, решает DEFAULT_DOCK, а перенесённое пользователем помнит раскладка.
 */
import { makeRef, findWindow, type WindowKind } from './model';
import { useLayout } from './store';

export const DOCKED_KINDS = ['merge'] as const;

/** Виды, переехавшие из доков в главную область: их вкладки из старых раскладок убираем при загрузке. */
export const PAGE_KINDS: readonly string[] = ['docs', 'log', 'money', 'meetings'];
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

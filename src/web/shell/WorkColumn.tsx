/**
 * Рабочая колонка оболочки: основная область (children — текущий вид) и доки
 * снизу и справа с разделителями. Открытый док ужимает основную область —
 * она flex-ребёнок и забирает остаток. Колонка и окно измеряются и отдают
 * размер в стор раскладки (от него зависит зажим доков); раскладка своя у
 * каждого офиса. Логики раскладки здесь нет: она в layout/model.ts.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dock } from '../layout/Dock';
import { DropOverlay, startTabDrag } from '../layout/tabdrag';
import { windowTitle } from '../layout/titles';
import { Splitter } from '../layout/Splitter';
import { useLayout } from '../layout/store';
import { useLayoutHotkeys } from '../layout/hotkeys';
import { narrowMode, fitDockSizes } from '../layout/narrow';
import { displayLayout, dockRange, effectiveSize, findWindow, makeRef, type DockId, type Layout, type WindowRef } from '../layout/model';
import type { DockStatus } from '../layout/Dock';
import { TerminalWindow } from '../terminal/TerminalWindow';
import { useTermViews, type TermStatus } from '../terminal/sessions';
import { RailPage } from './RailPages';
import { t } from '../i18n';

/**
 * Содержимое вкладки. Окна рейла и терминал живут здесь; дифф и дроверы
 * переезжают в доки отдельными задачами — до тех пор у них заглушка.
 */
function WindowBody({ win, onCall }: { win: WindowRef; onCall: () => void }): ReactNode {
  const close = () => useLayout.getState().closeWindow(win.id);
  switch (win.kind) {
    case 'terminal': return <TerminalWindow winId={win.id} />;
    case 'merge':
      return <RailPage view={win.kind} onClose={close} onCall={onCall} />;
    default: return <p className="dock-empty">{t('dock.empty')}</p>;
  }
}

const TERM_STATUS: Record<TermStatus, DockStatus> = { live: 'ok', opening: 'warn', exited: 'warn', error: 'danger' };

/** Номер для нового терминала: наименьший свободный. */
function nextTerminalNumber(layout: Layout): string {
  const used = new Set(Object.values(layout.docks).flatMap((d) => d?.tabs.map((w) => w.id) ?? []));
  let n = 1;
  while (used.has(`terminal:${n}`)) n++;
  return String(n);
}

export function WorkColumn({ officeId, onCallMeeting, children }: {
  officeId: string | null;
  onCallMeeting: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const realLayout = useLayout((s) => s.layout);
  const viewport = useLayout((s) => s.viewport);
  const mode = useMemo(() => narrowMode(viewport), [viewport.w, viewport.h]);
  // В узком окне вкладки боковых доков показываются в нижнем; модель не меняется.
  const [narrowActive, setNarrowActive] = useState<string | null>(null);
  const layout = useMemo(
    () => (mode.sideToBottom ? displayLayout(realLayout, viewport, narrowActive) : realLayout),
    [mode.sideToBottom, realLayout, viewport.w, narrowActive],
  );
  const column = useLayout((s) => s.column);
  const maximized = useLayout((s) => s.maximized);
  const termViews = useTermViews((s) => s.byId);
  const st = useLayout.getState;
  useLayoutHotkeys();

  // Раскладка своя у каждого офиса: смена офиса — загрузка его раскладки.
  useEffect(() => {
    st().load(officeId);
    return () => st().flush();
  }, [officeId, st]);

  // Размер окна и колонки — для зажима размеров доков.
  useEffect(() => {
    const measureWindow = () => st().setViewport(window.innerWidth, window.innerHeight);
    measureWindow();
    window.addEventListener('resize', measureWindow);
    const el = ref.current;
    const ro = new ResizeObserver(() => {
      if (!el) return;
      const { w, h } = st().column;
      if (el.clientWidth !== w || el.clientHeight !== h) st().setColumn(el.clientWidth, el.clientHeight);
    });
    if (el) ro.observe(el);
    // Отложенную запись дописываем до закрытия страницы.
    const flush = () => st().flush();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('resize', measureWindow);
      window.removeEventListener('pagehide', flush);
      ro.disconnect();
    };
  }, [st]);

  const dock = (id: DockId) => {
    const s = layout.docks[id];
    if (!s) return null;
    // Свёрнутый нижний док не рисуем совсем: ни полоски, ни отступа. Открывает
    // его кнопка в верхнем ряду, рейл и Ctrl/Cmd+`.
    if (id === 'bottom' && s.collapsed) return null;
    const hidden = maximized !== null && maximized !== id;
    const sizes = fitDockSizes(
      { left: layout.docks.left && effectiveSize('left', layout, column), right: layout.docks.right && effectiveSize('right', layout, column), bottom: layout.docks.bottom && effectiveSize('bottom', layout, column) },
      mode, column,
    );
    const size = sizes[id] ?? effectiveSize(id, layout, column);
    const range = dockRange(id, layout, column);
    // Настоящий док вкладки: в узком режиме она может лежать в боковом.
    const homeOf = (win: string): DockId => findWindow(st().layout, win)?.dock ?? id;
    return (
      <div className={`work-dock work-dock-${id}${hidden ? ' off' : ''}`}>
        {!s.collapsed && maximized === null && (
          <Splitter
            dock={id} value={size} min={range.min} max={range.max}
            onChange={(px) => st().resizeDock(id, px)}
            onReset={() => st().resetDockSize(id)}
          />
        )}
        <Dock
          dock={id}
          state={s}
          size={size}
          maximized={maximized === id}
          renderWindow={(win) => <WindowBody win={win} onCall={onCallMeeting} />}
          statusOf={(win) => {
            const v = win.kind === 'terminal' ? termViews[win.id] : undefined;
            return v ? TERM_STATUS[v.status] : undefined;
          }}
          onAdd={id === 'bottom' ? () => st().openWindow(makeRef('terminal', nextTerminalNumber(st().layout)), 'bottom') : undefined}
          onActivate={(win) => { if (mode.sideToBottom) setNarrowActive(win); st().activate(homeOf(win), win); }}
          onClose={(win) => st().closeWindow(win)}
          onToggleCollapsed={() => st().toggleCollapsed(id)}
          onMaximize={() => st().maximize(id)}
          onMove={(win, to) => st().moveWindow(win, to)}
          onCloseOthers={(win) => st().closeOthers(homeOf(win), win)}
          onReorder={(from, to) => { if (!mode.sideToBottom) st().reorder(id, from, to); }}
          onTabPointerDown={(e, win) => startTabDrag(e, win.id, windowTitle(win), ref.current)}
        />
      </div>
    );
  };

  const has = (id: DockId) => (layout.docks[id] && !(id === 'bottom' && layout.docks[id]!.collapsed) ? ` has-${id[0]}` : '');
  return (
    <div ref={ref} className={`work-col${has('bottom')}${has('right')}${has('left')}${maximized ? ' maxi' : ''}`}>
      <div className="work-row">
        {dock('left')}
        <div className={`work-main${maximized ? ' off' : ''}`}>{children}</div>
        {dock('right')}
      </div>
      {dock('bottom')}
      <DropOverlay />
    </div>
  );
}

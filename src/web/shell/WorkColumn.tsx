/**
 * Рабочая колонка оболочки: основная область (children — текущий вид) и доки
 * снизу и справа с разделителями. Открытый док ужимает основную область —
 * она flex-ребёнок и забирает остаток. Колонка и окно измеряются и отдают
 * размер в стор раскладки (от него зависит зажим доков); раскладка своя у
 * каждого офиса. Логики раскладки здесь нет: она в layout/model.ts.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Dock } from '../layout/Dock';
import { Splitter } from '../layout/Splitter';
import { useLayout } from '../layout/store';
import { dockRange, effectiveSize, type DockId, type WindowRef } from '../layout/model';
import { t } from '../i18n';

/** Содержимое вкладки; конкретные окна переезжают в доки отдельными задачами. */
function WindowBody(_: { win: WindowRef }): ReactNode {
  return <p className="dock-empty">{t('dock.empty')}</p>;
}

export function WorkColumn({ officeId, children }: { officeId: string | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const layout = useLayout((s) => s.layout);
  const column = useLayout((s) => s.column);
  const maximized = useLayout((s) => s.maximized);
  const st = useLayout.getState;

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
    const hidden = maximized !== null && maximized !== id;
    const size = effectiveSize(id, layout, column);
    const range = dockRange(id, layout, column);
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
          renderWindow={(win) => <WindowBody win={win} />}
          onActivate={(win) => st().activate(id, win)}
          onClose={(win) => st().closeWindow(win)}
          onToggleCollapsed={() => st().toggleCollapsed(id)}
          onMaximize={() => st().maximize(id)}
          onMove={(win, to) => st().moveWindow(win, to)}
          onCloseOthers={(win) => st().closeOthers(id, win)}
          onReorder={(from, to) => st().reorder(id, from, to)}
        />
      </div>
    );
  };

  const has = (id: DockId) => (layout.docks[id] ? ` has-${id[0]}` : '');
  return (
    <div ref={ref} className={`work-col${has('bottom')}${has('right')}${maximized ? ' maxi' : ''}`}>
      <div className="work-row">
        <div className={`work-main${maximized ? ' off' : ''}`}>{children}</div>
        {dock('right')}
      </div>
      {dock('bottom')}
    </div>
  );
}

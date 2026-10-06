/**
 * Док: шапка со вкладками и кнопками «свернуть / развернуть / закрыть»,
 * тело с окнами и полоска свёрнутого состояния (спека §2.2, §2.4).
 * Компонент ничего не знает о сторе: состояние приходит пропсами, окна —
 * через renderWindow. Тела окон остаются в DOM и при свёрнутом доке, и под
 * неактивной вкладкой (скрыты), чтобы не терять xterm и процессы.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../icons';
import { t } from '../i18n';
import { DOCK_IDS, STRIP_SIZE, type DockId, type DockState, type WindowRef } from './model';
import { windowTitle } from './titles';

export type DockStatus = 'ok' | 'warn' | 'danger';

const STATUS_LABEL: Record<DockStatus, 'dock.statusOk' | 'dock.statusWarn' | 'dock.statusDanger'> = {
  ok: 'dock.statusOk', warn: 'dock.statusWarn', danger: 'dock.statusDanger',
};

interface DockProps {
  dock: DockId;
  state: DockState;
  /** Размер с учётом зажима под колонку, px. */
  size: number;
  maximized: boolean;
  renderWindow(ref: WindowRef): ReactNode;
  /** Точка статуса вкладки (у терминала — жив / открывается / ошибка). */
  statusOf?(ref: WindowRef): DockStatus | undefined;
  onActivate(id: string): void;
  onClose(id: string): void;
  onToggleCollapsed(): void;
  onMaximize(): void;
  onMove(id: string, dock: DockId): void;
  onCloseOthers(id: string): void;
  onReorder(from: number, to: number): void;
  /** Плюс в шапке: новая вкладка (у нижнего дока — терминал). */
  onAdd?(): void;
}

const DOCK_LABEL = { bottom: 'dock.bottom', right: 'dock.right', left: 'dock.left' } as const;
const WHERE_LABEL = { bottom: 'dock.toBottom', right: 'dock.toRight', left: 'dock.toLeft' } as const;

function StatusDot({ status }: { status?: DockStatus }) {
  if (!status) return null;
  // Цвет не единственный сигнал: слово в скрытом тексте и в подсказке.
  return (
    <>
      <span className={`dock-dot ${status}`} aria-hidden="true" />
      <span className="dock-sr">{t(STATUS_LABEL[status])}</span>
    </>
  );
}

export function Dock(p: DockProps) {
  const { dock, state } = p;
  const uid = useId();
  const [menu, setMenu] = useState<string | null>(null); // id вкладки, чьё меню открыто
  const menuRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const dragFrom = useRef<number | null>(null);
  const side = dock !== 'bottom';
  const label = t(DOCK_LABEL[dock]);

  // Меню закрывается по Esc и клику снаружи; Esc не всплывает дальше.
  useEffect(() => {
    if (menu === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMenu(null);
      tabRefs.current.get(menu)?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [menu]);

  const focusTab = (id: string) => {
    p.onActivate(id);
    requestAnimationFrame(() => tabRefs.current.get(id)?.focus());
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = state.tabs.length;
    const id = state.tabs[index]!.id;
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const to = index + (e.key === 'ArrowLeft' ? -1 : 1);
      if (to >= 0 && to < n) {
        p.onReorder(index, to);
        requestAnimationFrame(() => tabRefs.current.get(id)?.focus());
      }
      return;
    }
    let to: number | null = null;
    if (e.key === 'ArrowRight') to = (index + 1) % n;
    else if (e.key === 'ArrowLeft') to = (index - 1 + n) % n;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = n - 1;
    else if (e.key === 'Delete') {
      e.preventDefault();
      p.onClose(id);
      return;
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      setMenu(id);
      return;
    }
    if (to !== null) {
      e.preventDefault();
      focusTab(state.tabs[to]!.id);
    }
  };

  const moveTargets = DOCK_IDS.filter((d) => d !== dock);
  const expand = (id?: string) => {
    if (id) p.onActivate(id);
    else p.onToggleCollapsed();
  };

  const bodies = state.tabs.map((ref) => (
    <div
      key={ref.id}
      id={`${uid}-p-${ref.id}`}
      role="tabpanel"
      aria-labelledby={`${uid}-t-${ref.id}`}
      className="dock-panel"
      hidden={state.collapsed || ref.id !== state.active}
    >
      {p.renderWindow(ref)}
    </div>
  ));

  return (
    <section
      className={`dock dock-${dock}${state.collapsed ? ' collapsed' : ''}${p.maximized ? ' maximized' : ''}`}
      role="region"
      aria-label={label}
      style={{ ['--dock-size' as string]: `${state.collapsed ? STRIP_SIZE : p.size}px` }}
    >
      {state.collapsed ? (
        <div className="dock-strip">
          <div className="dock-strip-tabs" role="tablist" aria-orientation={side ? 'vertical' : 'horizontal'} aria-label={label}>
            {state.tabs.map((ref) => (
              <button
                key={ref.id}
                type="button"
                role="tab"
                aria-selected={ref.id === state.active}
                className={`dock-strip-tab${ref.id === state.active ? ' active' : ''}`}
                onClick={() => expand(ref.id)}
              >
                <StatusDot status={p.statusOf?.(ref)} />
                <span className="dock-tab-name" title={windowTitle(ref)}>{windowTitle(ref)}</span>
              </button>
            ))}
          </div>
          <button type="button" className="dock-btn" aria-label={t('dock.expand')} title={t('dock.expand')} onClick={() => expand()}>
            <Icon name={dock === 'bottom' ? 'chevron-up' : 'chevron-down'} size={14} className={side ? 'dock-ico-side' : ''} />
          </button>
        </div>
      ) : (
        <header className="dock-head">
          <div className="dock-tabs" role="tablist" aria-label={label}>
            {state.tabs.map((ref, i) => {
              const active = ref.id === state.active;
              const title = windowTitle(ref);
              return (
                <div
                  key={ref.id}
                  className={`dock-tab${active ? ' active' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    dragFrom.current = i;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', ref.id);
                  }}
                  onDragOver={(e) => {
                    if (dragFrom.current !== null) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom.current !== null) p.onReorder(dragFrom.current, i);
                    dragFrom.current = null;
                  }}
                  onDragEnd={() => { dragFrom.current = null; }}
                >
                  <button
                    ref={(el) => {
                      if (el) tabRefs.current.set(ref.id, el);
                      else tabRefs.current.delete(ref.id);
                    }}
                    type="button"
                    role="tab"
                    id={`${uid}-t-${ref.id}`}
                    aria-selected={active}
                    aria-controls={`${uid}-p-${ref.id}`}
                    tabIndex={active ? 0 : -1}
                    className="dock-tab-main"
                    onClick={() => p.onActivate(ref.id)}
                    onKeyDown={(e) => onTabKey(e, i)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu(ref.id);
                    }}
                  >
                    <StatusDot status={p.statusOf?.(ref)} />
                    <span className="dock-tab-name" title={title}>{title}</span>
                  </button>
                  <button
                    type="button"
                    className="dock-btn dock-tab-close"
                    tabIndex={-1}
                    aria-label={t('dock.closeTab', { name: title })}
                    title={t('common.close')}
                    onClick={() => p.onClose(ref.id)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              );
            })}
            {p.onAdd && (
              <button type="button" className="dock-btn" aria-label={t('dock.addTab')} title={t('dock.addTab')} onClick={p.onAdd}>
                <Icon name="plus" size={14} />
              </button>
            )}
          </div>
          <div className="dock-actions">
            <button
              type="button"
              className="dock-btn"
              aria-label={t(p.maximized ? 'dock.restore' : 'dock.maximize')}
              title={t(p.maximized ? 'dock.restore' : 'dock.maximize')}
              aria-pressed={p.maximized}
              onClick={p.onMaximize}
            >
              <Icon name={p.maximized ? 'arrows-minimize' : 'arrows-maximize'} size={14} />
            </button>
            <button type="button" className="dock-btn" aria-label={t('dock.collapse')} title={t('dock.collapse')} onClick={() => p.onToggleCollapsed()}>
              <Icon name="chevron-down" size={14} className={dock === 'bottom' ? '' : 'dock-ico-side'} />
            </button>
            <button
              type="button"
              className="dock-btn"
              aria-label={t('dock.menu')}
              aria-haspopup="menu"
              title={t('dock.menu')}
              onClick={() => state.active && setMenu(state.active)}
            >
              <Icon name="dots" size={14} />
            </button>
          </div>
        {menu !== null && (
          <div className="dock-menu" role="menu" ref={menuRef} aria-label={t('dock.menu')}>
            {moveTargets.map((d) => (
              <button
                key={d}
                type="button"
                role="menuitem"
                className="dock-menu-item"
                onClick={() => { const id = menu; setMenu(null); p.onMove(id, d); }}
              >
                {t('dock.moveTo', { where: t(WHERE_LABEL[d]) })}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className="dock-menu-item"
              onClick={() => { setMenu(null); p.onMaximize(); }}
            >
              {t(p.maximized ? 'dock.restore' : 'dock.maximize')}
            </button>
            {state.tabs.length > 1 && (
              <button
                type="button"
                role="menuitem"
                className="dock-menu-item"
                onClick={() => { const id = menu; setMenu(null); p.onCloseOthers(id); }}
              >
                {t('dock.closeOthers')}
              </button>
            )}
          </div>
        )}
        </header>
      )}
      <div className="dock-body" hidden={state.collapsed}>{bodies}</div>
    </section>
  );
}

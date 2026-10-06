/**
 * Перетаскивание вкладки мышью (pointer events): внутри дока меняет порядок,
 * в другой док — переносит, у края колонки — создаёт док. Зона считается
 * чистой функцией из dropzone.ts; здесь только события, снимок геометрии и
 * подсветка. Esc отменяет, мелкое движение (< 6 px) — это обычный клик.
 */
import type { PointerEvent as ReactPointerEvent } from 'react';
import { t } from '../i18n';
import { useLayout } from './store';
import {
  edgeRect, highlightOf, pastThreshold, resolveDrop, sameTarget,
  type DockGeometry, type DropGeometry, type Rect,
} from './dropzone';
import { DOCK_IDS, type DockId } from './model';

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** Снимок геометрии колонки и доков; доки размечены `data-dock`, вкладки — `data-tab`. */
function measure(col: HTMLElement): DropGeometry {
  const docks: DropGeometry['docks'] = {};
  for (const id of DOCK_IDS) {
    const el = col.querySelector<HTMLElement>(`[data-dock="${id}"]`);
    const head = el?.querySelector('.dock-head, .dock-strip');
    if (!el || !head) continue;
    const g: DockGeometry = {
      rect: rectOf(el),
      head: rectOf(head),
      tabs: [...el.querySelectorAll('[data-tab]')].map(rectOf),
      vertical: el.dataset.collapsed === 'true' && id !== 'bottom',
    };
    docks[id] = g;
  }
  return { column: rectOf(col), docks };
}

/** Начать отслеживание нажатия на вкладку; перенос стартует после отрыва на 6 px. */
export function startTabDrag(e: ReactPointerEvent, win: string, label: string, col: HTMLElement | null): void {
  if (e.button !== 0 || !col || !e.isPrimary) return;
  const sx = e.clientX;
  const sy = e.clientY;
  const store = useLayout;
  let active = false;
  let geo: DropGeometry | null = null;

  const finish = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('tab-dragging');
    store.getState().setDrag(null);
    if (active) {
      // Клик, которым браузер завершит перетаскивание, вкладка не получает.
      const eat = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', eat, true), 0);
    }
  };

  const onMove = (ev: PointerEvent) => {
    if (!active) {
      if (!pastThreshold(ev.clientX - sx, ev.clientY - sy)) return;
      active = true;
      geo = measure(col);
      document.body.classList.add('tab-dragging');
    }
    if (!geo) return;
    const over = resolveDrop(ev.clientX, ev.clientY, geo);
    const prev = store.getState().drag;
    store.getState().setDrag({
      win, label, x: ev.clientX, y: ev.clientY, geo,
      over: prev && sameTarget(prev.over, over) ? prev.over : over,
    });
  };
  const onUp = () => {
    const drag = store.getState().drag;
    finish();
    if (active && drag?.over) store.getState().dropWindow(win, drag.over);
  };
  const onCancel = () => finish();
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    ev.preventDefault();
    finish();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}

const EDGE_LABEL = { bottom: 'dock.dropBottom', right: 'dock.dropRight', left: 'dock.dropLeft' } as const;
const box = (r: Rect) => ({ left: r.x, top: r.y, width: r.w, height: r.h });

/** Подсветка зон, плавающая метка и подпись состояния для чтецов экрана. */
export function DropOverlay() {
  const drag = useLayout((s) => s.drag);
  if (!drag) return null;
  const { geo, over } = drag;
  const hl = over ? highlightOf(over, geo) : null;
  return (
    <div className="drop-layer" aria-hidden="false">
      <span className="dock-sr" role="status">{t('dock.dragging', { name: drag.label })}</span>
      {(['bottom', 'right', 'left'] as DockId[]).map((d) => {
        const on = over?.kind === 'edge' && over.dock === d;
        return (
          <div key={d} className={`drop-zone${on ? ' on' : ''}`} style={box(edgeRect(geo.column, d))}>
            <span className="drop-zone-label">{t(EDGE_LABEL[d])}</span>
          </div>
        );
      })}
      {over?.kind === 'tab' && hl && (
        <div className="drop-zone drop-head on" style={box(hl.zone)}>
          <span className="drop-zone-label">{t('dock.dropTab')}</span>
        </div>
      )}
      {over?.kind === 'tab' && hl?.mark && <div className="drop-mark" style={box(hl.mark)} />}
      <div className="drop-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>{drag.label}</div>
    </div>
  );
}

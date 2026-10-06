import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { useStore } from '../store';
import { t } from '../i18n';
import { Icon } from '../icons';
import { useLayout } from '../layout/store';
import { applyTermTheme, ensureSession, fitSession, focusSession, mountSession, useTermViews } from './sessions';

/**
 * Окно терминала — тело одной вкладки нижнего дока. Сессия живёт в реестре
 * (`sessions.ts`), здесь только посадка xterm в контейнер и подгонка сетки.
 * Док прячет тело через `hidden`, а не размонтирует, так что сессия не рвётся
 * ни при сворачивании дока, ни при смене вкладки.
 */
export function TerminalWindow({ winId }: { winId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const view = useTermViews((s) => s.byId[winId]);
  const theme = useStore((s) => s.theme);
  // Видимое окно: док развёрнут, вкладка активна. Сетку мерить можно только тогда.
  const visible = useLayout((s) => {
    for (const d of Object.values(s.layout.docks)) {
      if (d?.tabs.some((w) => w.id === winId)) return !d.collapsed && d.active === winId;
    }
    return false;
  });

  useEffect(() => {
    ensureSession(winId);
    if (ref.current) mountSession(winId, ref.current);
  }, [winId]);

  useEffect(() => { applyTermTheme(); }, [theme]);

  // Любая смена размера контейнера — перетаскивание разделителя, окно, рейл,
  // разворот дока — подгоняет сетку; cols×rows уходит серверу через onResize.
  useEffect(() => {
    const el = ref.current;
    if (!el || !visible) return;
    let raf = 0;
    const fit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitSession(winId));
    };
    fitSession(winId);
    focusSession(winId);
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [winId, visible]);

  const status = view?.status ?? 'opening';
  return (
    <div className="term-view">
      <div className="term-host" ref={ref} />
      {(status === 'error' || status === 'exited') && (
        <div className={`term-note ${status}`} role={status === 'error' ? 'alert' : 'status'}>
          <Icon name={status === 'error' ? 'alert-triangle' : 'circle-x'} size={16} />
          <div>
            {(view?.error ?? t('terminal.ended')).split('\n').map((line, i) => (
              <p key={i} className={i ? 'term-note-detail' : ''}>{line}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

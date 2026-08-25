import { useEffect, useRef, useState } from 'react';
import { sortedOffices, summarizeOfficeActivity, useStore } from './store';
import type { OfficeView } from '../shared/types';

/**
 * Быстрый переключатель офисов прямо из комнаты: бейдж проекта в HUD
 * открывает список офисов, клик по другому — переход без выхода в меню.
 * Переключение больше не требует остановки задач в работе (сервер держит их
 * сессии сам), поэтому здесь нет проверок на «занятость» — вся логика входа
 * и сброса UI живёт в store.enterOffice.
 */
export function OfficeSwitcher() {
  const offices = useStore((s) => s.offices);
  const projectDir = useStore((s) => s.projectDir);
  const theme = useStore((s) => s.theme);
  const pending = useStore((s) => s.pending);
  const pendingLabel = useStore((s) => s.pendingLabel);
  const enterOffice = useStore((s) => s.enterOffice);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onOutside);
    return () => window.removeEventListener('mousedown', onOutside);
  }, [open]);

  // Список пришёл, а снапшот нового офиса ещё в пути — держим бейдж закрытым
  // и показываем состояние ожидания вместо старых данных прежнего офиса.
  useEffect(() => { if (pending) setOpen(false); }, [pending]);

  if (pending === 'enter') {
    return (
      <div className="office-switcher switching" title="Ждём снапшот нового офиса">
        <span className="ico spin">🔄</span>
        <b>Переключаемся{pendingLabel ? ` на «${pendingLabel}»` : ''}…</b>
      </div>
    );
  }

  const list = sortedOffices(offices);
  const hasOthers = list.length > 1;

  const pick = (o: OfficeView) => {
    setOpen(false);
    enterOffice(o.id);
  };

  return (
    <div className="office-switcher" ref={ref}>
      <button
        type="button"
        className={`office-switcher-trigger ${hasOthers ? '' : 'lone'}`}
        onClick={hasOthers ? () => setOpen((v) => !v) : undefined}
        title={(hasOthers ? 'Быстрое переключение между офисами' : 'Единственный офис — переключаться пока не на что')
          + ` · ${projectDir} · тема «${theme === 'day' ? 'Лофт' : 'Ночь / неон'}»`}
      >
        <span className="ico">🏢</span>
        <b>{projectDir.split('/').pop()}{hasOthers ? ' ▾' : ''}</b>
      </button>

      {open && hasOthers && (
        <div className="office-switcher-list pixel">
          {list.map((o) => {
            const activity = summarizeOfficeActivity(o);
            const dotClass = activity.live
              ? 'live'
              : activity.hasQueue
              ? 'busy'
              : activity.hasUnmerged
              ? 'done'
              : '';
            return (
              <button
                key={o.id}
                type="button"
                className={`office-switcher-row ${o.current ? 'current' : ''}`}
                onClick={() => pick(o)}
                title={activity.live ? 'В офисе сейчас идёт живая работа' : undefined}
              >
                <span className={`office-switcher-dot ${dotClass}`} />
                <span className="office-switcher-name">
                  {o.name}
                  {activity.waiting > 0 && (
                    <span className="office-switcher-waiting" title="Ждут решения человека">
                      {activity.waiting}
                    </span>
                  )}
                </span>
                <span className="muted small">{o.current ? 'этот офис' : activity.text}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { createOffice, renameOffice, setOfficeIcon, summarizeOfficeActivity, useStore } from './store';
import type { OfficeView } from '../shared/types';
import { t } from './i18n';
import { Icon } from './icons';

// Палитра выбора без претензии на полноту — 16 эмодзи на разные темы проекта.
const ICON_PALETTE = [
  '🚀', '💡', '🎯', '📦', '🛠️', '🎨', '🧩', '📊',
  '🔥', '🌊', '🌱', '⚙️', '🧠', '📚', '🗂️', '✨',
];

/**
 * Дверь офиса: список проектов и создание нового. Офис = проект: своя
 * рабочая директория, своя доска и свои расходы.
 */
export function OfficesModal({ onClose }: { onClose: () => void }) {
  const offices = useStore((s) => s.offices);
  const enterOffice = useStore((s) => s.enterOffice);
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [creating, setCreating] = useState(false);

  const create = () => {
    if (!dir.trim()) return;
    createOffice(name.trim(), dir.trim());
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{t('offices.title')}</h3>
        <p className="modal-reason">{t('offices.note')}</p>

        <div className="offices">
          {offices.map((o) => (
            <div key={o.id} className={`office-row ${o.current ? 'current' : ''}`}>
              <div className="office-who">
                <b>{o.name}</b>
                <OfficeStatusMark office={o} />
                <div className="muted mono">{o.projectDir}</div>
              </div>
              {o.current ? (
                <span className="chip done">{t('offices.open')}</span>
              ) : (
                <button className="mini go" title={t('offices.openHint')}
                  onClick={() => { enterOffice(o.id); onClose(); }}>
                  {t('offices.openAction')}
                </button>
              )}
              <button className="mini" title={t('offices.rename')}
                onClick={() => {
                  const next = prompt(t('offices.namePrompt'), o.name);
                  if (next) renameOffice(o.id, next);
                }}>
                <Icon name="pencil" size={16} />
              </button>
              <OfficeIconPicker office={o} />
            </div>
          ))}
        </div>

        {creating ? (
          <>
            <label>{t('offices.name')}
              <input value={name} placeholder={t('offices.namePlaceholder')}
                onChange={(e) => setName(e.target.value)} />
            </label>
            <label>{t('offices.dir')}
              <input value={dir} placeholder="/Users/you/projects/my-app"
                onChange={(e) => setDir(e.target.value)} />
              <span className="hint muted">{t('offices.dirHint')}</span>
            </label>
            <div className="modal-actions">
              <button onClick={() => setCreating(false)}>{t('common.cancel')}</button>
              <button className="allow" onClick={create}>{t('offices.create')}</button>
            </div>
          </>
        ) : (
          <div className="modal-actions">
            <button onClick={onClose}>{t('common.close')}</button>
            <button className="allow" onClick={() => setCreating(true)}>{t('offices.new')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Статус офиса рядом с именем: стоит он на паузе, идёт ли в нём работа или он
 * простаивает. Тот же расчёт, что у рейла и главного экрана
 * (`summarizeOfficeActivity`), — иначе три списка говорили бы разное.
 */
function OfficeStatusMark({ office }: { office: OfficeView }) {
  const a = summarizeOfficeActivity(office);
  const mark = a.paused ? 'paused' : a.live ? 'live' : 'idle';
  const hint = a.paused
    ? t('office.paused.hint')
    : a.live ? t('office.working.hint') : t('office.idle.hint');
  return (
    <span className={`office-status ${mark}`} title={hint}>
      {a.paused && <Icon name="player-pause" size={10} />}
      {a.paused ? t('office.paused') : a.text}
    </span>
  );
}

/**
 * Выбор иконки офиса: палитра эмодзи, поле для своего символа и сброс.
 * Сохраняет только то, что подтвердил сервер, — состояние читается из
 * `offices` в сторе (`case 'offices'`), локального оптимистичного значения нет.
 */
function OfficeIconPicker({ office }: { office: OfficeView }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onOutside);
    return () => window.removeEventListener('mousedown', onOutside);
  }, [open]);

  const pick = (value: string) => {
    setOfficeIcon(office.id, { kind: 'emoji', value });
    setOpen(false);
    setCustom('');
  };

  return (
    <div className="office-icon-picker" ref={ref}>
      <button className="mini" title={t('offices.icon')} onClick={() => setOpen((v) => !v)}>
        🙂
      </button>
      {open && (
        <div className="office-icon-menu float">
          <div className="office-icon-menu-title">{t('offices.iconTitle')}</div>
          <div className="office-icon-palette">
            {ICON_PALETTE.map((e) => (
              <button key={e} className="office-icon-option" onClick={() => pick(e)}>{e}</button>
            ))}
          </div>
          <div className="office-icon-custom-row">
            <input value={custom} placeholder={t('offices.iconCustomPlaceholder')}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && custom.trim()) pick(custom.trim()); }} />
            <button className="mini" disabled={!custom.trim()} onClick={() => pick(custom.trim())}>
              ✓
            </button>
          </div>
          <button className="mini office-icon-reset"
            onClick={() => { setOfficeIcon(office.id, null); setOpen(false); }}>
            {t('offices.iconReset')}
          </button>
        </div>
      )}
    </div>
  );
}

import { Fragment, useEffect, useRef, useState } from 'react';
import {
  activeOffices, archiveOffice, archivedOffices, createOffice, renameOffice, setOfficeIcon,
  summarizeOfficeActivity, useStore,
} from './store';
import type { OfficeView } from '../shared/types';
import { t } from './i18n';
import { Icon } from './icons';
import { officeAvatarStyle } from './officeColor';
import { OfficeAvatarIcon } from './OfficeIcon';

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
  const requestArchiveOffice = useStore((s) => s.requestArchiveOffice);
  const requestRemoveOffice = useStore((s) => s.requestRemoveOffice);
  // Порядок тот же, что в рейле и на главном экране: список один, и видеть
  // его в трёх разных порядках человеку не за что. Раньше здесь показывался
  // сырой порядок записей реестра, а рейл сортировал по имени.
  const list = activeOffices(offices);
  const archived = archivedOffices(offices);
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [creating, setCreating] = useState(false);
  // Занесённая рука над архивацией или удалением из списка — офис и
  // действие, про которые спрашиваем. Своё подтверждение прямо в списке, а
  // не нативный confirm(): он выпадает из окна и его нечем оформить (так же
  // сделано снятие задачи в TaskDrawer).
  const [asking, setAsking] = useState<{ id: string; op: 'archive' | 'remove' } | null>(null);
  const ask = (id: string, op: 'archive' | 'remove') =>
    setAsking(asking?.id === id && asking.op === op ? null : { id, op });
  // Архив свёрнут по умолчанию: это склад, а не рабочий список.
  const [openArchive, setOpenArchive] = useState(false);

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
          {list.map((o) => {
            // «Последний офис» здесь не считаем: отказ сервера приходит тостом
            // с его собственной причиной, и двух разных правил не будет.
            return (
              <Fragment key={o.id}>
                <div className={`office-row ${o.current ? 'current' : ''}`}>
                  <span className="office-card-avatar sm" style={officeAvatarStyle(o)}>
                    <OfficeAvatarIcon office={o} imgClass="office-card-icon-img" />
                  </span>
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
                  <button className="mini" title={t('offices.archive')}
                    onClick={() => ask(o.id, 'archive')}>
                    <Icon name="archive" size={16} />
                  </button>
                  <button className="mini" title={t('offices.remove')}
                    onClick={() => ask(o.id, 'remove')}>
                    <Icon name="circle-x" size={16} />
                  </button>
                </div>
                {asking?.id === o.id && (
                  <OfficeConfirm office={o} op={asking.op} onCancel={() => setAsking(null)}
                    onConfirm={() => {
                      setAsking(null);
                      if (asking.op === 'archive') requestArchiveOffice(o.id);
                      else requestRemoveOffice(o.id);
                      // Открытый офис уходит через переключение в соседний:
                      // список под модалкой меняется целиком, и держать её
                      // поверх входа в другой проект незачем.
                      if (o.current) onClose();
                    }} />
                )}
              </Fragment>
            );
          })}
        </div>

        {/* Пустого раздела нет вовсе: пока в архив ничего не убирали, про
            архив и говорить не о чем. */}
        {archived.length > 0 && (
          <div className="offices-archive">
            <button className="ghost offices-archive-head" onClick={() => setOpenArchive((v) => !v)}>
              <span className="offices-archive-caret" aria-hidden>{openArchive ? '▾' : '▸'}</span>
              <Icon name="archive" size={14} />
              {t('offices.archiveSection', { n: archived.length })}
            </button>
            {openArchive && (
              <div className="offices">
                {archived.map((o) => (
                  <Fragment key={o.id}>
                    <div className="office-row archived">
                      <div className="office-who">
                        <b>{o.name}</b>
                        <span className="office-status">{t('offices.archivedMark')}</span>
                        <div className="muted mono">{o.projectDir}</div>
                      </div>
                      <button className="mini go" title={t('offices.unarchiveHint')}
                        onClick={() => archiveOffice(o.id, false)}>
                        {t('offices.unarchive')}
                      </button>
                      <button className="mini" title={t('offices.remove')}
                        onClick={() => ask(o.id, 'remove')}>
                        <Icon name="circle-x" size={16} />
                      </button>
                    </div>
                    {asking?.id === o.id && asking.op === 'remove' && (
                      <OfficeConfirm office={o} op="remove" onCancel={() => setAsking(null)}
                        onConfirm={() => { setAsking(null); requestRemoveOffice(o.id); }} />
                    )}
                  </Fragment>
                ))}
              </div>
            )}
          </div>
        )}

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
 * Подтверждение архивации или удаления из списка — под строкой офиса.
 * Удаление отдельно говорит, что файлы проекта не трогаются и офис
 * возвращается повторным открытием его папки. Общий с рейлом.
 */
export function OfficeConfirm({ office, op, onCancel, onConfirm }: {
  office: OfficeView;
  op: 'archive' | 'remove';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="office-archive-confirm">
      <p>{t(op === 'archive' ? 'offices.archiveConfirm' : 'offices.removeConfirm', { name: office.name })}</p>
      {office.current && <p className="muted small">{t('offices.archiveCurrentNote')}</p>}
      <div className="modal-actions">
        <button onClick={onCancel}>{t('common.cancel')}</button>
        <button className="danger" onClick={onConfirm}>
          {t(op === 'archive' ? 'offices.archiveAction' : 'offices.removeAction')}
        </button>
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

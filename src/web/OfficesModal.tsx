import { useState } from 'react';
import { createOffice, renameOffice, useStore } from './store';
import { t } from './i18n';
import { Icon } from './icons';

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

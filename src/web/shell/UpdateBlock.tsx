import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { Icon } from '../icons';
import { Tooltip } from '../Tooltip';
import type { UpdateState } from '../../shared/types';
import { ReleaseNotes } from './ReleaseNotes';

/**
 * Блок обновления настольного приложения внизу рейла (контракт —
 * src/shared/types.ts, мост — src/shared/desktop.ts). Моста
 * `window.officeDesktop.updates` нет ни в браузере, ни в старых версиях
 * приложения — тогда блок ничего не рисует и ни на что не подписывается.
 *
 * Поток ручной: «Установить обновление» → загрузка → «Перезапустить сейчас».
 * Занятость (`busy`) только предупреждает: перезапуск она не запрещает.
 */
export function UpdateBlock({ collapsed }: { collapsed: boolean }) {
  const bridge = typeof window !== 'undefined' ? window.officeDesktop?.updates : undefined;
  const [state, setState] = useState<UpdateState | null>(null);
  const [pending, setPending] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    bridge.getState().then((s) => { if (alive) setState(s); });
    const off = bridge.onState((s) => { if (alive) setState(s); });
    return () => { alive = false; off(); };
  }, [bridge]);

  // Esc закрывает окно заметок — как крестик и клик по подложке.
  useEffect(() => {
    if (!notesOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNotesOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notesOpen]);

  if (!bridge || !state || state.phase === 'idle' || state.phase === 'checking') return null;

  const run = (cmd: () => Promise<unknown>) => {
    setPending(true);
    cmd().finally(() => setPending(false));
  };
  const { phase, version, percent = 0 } = state;
  const download = () => run(() => bridge.download());
  const restart = () => run(() => bridge.restartNow());

  const title = phase === 'available' ? t('update.available', { version: version ?? '' })
    : phase === 'downloading' ? t('update.downloading', { percent })
    : phase === 'ready' ? t('update.readyTitle', { version: version ?? '' })
    : t('update.error');

  if (collapsed) {
    const tip = phase === 'error' && state.error ? `${title}: ${state.error}` : title;
    const action = phase === 'available' || phase === 'error' ? download
      : phase === 'ready' ? restart : undefined;
    return (
      <div className="rail-update-compact">
        <Tooltip tip={tip}>
          <button className={`ghost rail-update-icon ${phase}`} onClick={action}
            disabled={pending || phase === 'downloading'} aria-label={tip}>
            <Icon name="refresh" size={18} />
            <span className={`rail-update-dot ${phase}${state.busy && phase === 'ready' ? ' busy' : ''}`} aria-hidden />
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className={`rail-update ${phase}`} role="status">
      <div className="rail-update-title">{title}</div>
      {phase === 'downloading' && (
        <div className="meter" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${percent}%` }} />
        </div>
      )}
      {phase === 'error' && state.error && <div className="rail-update-text" title={state.error}>{state.error}</div>}
      {phase === 'ready' && state.busy && <div className="rail-update-warn">{t('update.busy')}</div>}
      {phase === 'available' && (
        <button className="primary mini" onClick={download} disabled={pending}>{t('update.install')}</button>
      )}
      {phase === 'ready' && (
        <button className="primary mini" onClick={restart} disabled={pending}>{t('update.restart')}</button>
      )}
      {phase === 'error' && (
        // Без известной версии повторять нечего — повтор это новая проверка.
        <button className="ghost mini" disabled={pending}
          onClick={() => run(() => (version ? bridge.download() : bridge.check()))}>{t('update.retry')}</button>
      )}
      {(phase === 'available' || phase === 'ready') && state.notes && (
        <button className="rail-update-notes" onClick={() => setNotesOpen(true)}>{t('update.notes.toggle')}</button>
      )}
      {notesOpen && state.notes && createPortal(
        <div className="modal-backdrop" onClick={() => setNotesOpen(false)}>
          <div className="modal update-notes" role="dialog" aria-modal="true" aria-labelledby="update-notes-title"
            onClick={(e) => e.stopPropagation()}>
            <div className="modal-head update-notes-head">
              <h3 id="update-notes-title">{t('update.notes.title', { version: version ?? '' })}</h3>
              <button className="sq ghost" onClick={() => setNotesOpen(false)} aria-label={t('common.close')} title={t('common.close')}>✕</button>
            </div>
            <div className="update-notes-body"><ReleaseNotes source={state.notes} /></div>
            <div className="modal-actions update-notes-actions">
              <button className="ghost mini" onClick={() => setNotesOpen(false)}>{t('common.close')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

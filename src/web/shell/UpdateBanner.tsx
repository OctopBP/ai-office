import { useEffect, useState } from 'react';
import { t } from '../i18n';
import type { UpdateState } from '../../shared/types';
import { ReleaseNotes } from './ReleaseNotes';

const DISMISS_KEY = 'office-update-dismissed';

/** Версия обновления, которую владелец уже отложил кнопкой «Позже». */
function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, version);
  } catch {
    // Хранилище недоступно — плашка вернётся при следующей перерисовке, не страшно.
  }
}

/**
 * Плашка автообновления приложения (desktop/updater.js, контракт —
 * src/shared/types.ts, мост — src/shared/desktop.ts). Моста `window.officeDesktop.updates` нет ни в
 * браузере, ни в старых версиях приложения — тогда компонент молчит совсем,
 * не подписываясь и не рисуя ничего.
 *
 * Показываем только то, что владельцу реально нужно решить: скачанное
 * обновление (`ready`) и лёгкую полоску загрузки (`downloading`). `checking`,
 * `available` и `error` — тихо: ошибка проверки не должна маячить окном, она
 * уже осела в журнал обновлений. Загрузку по `available` и предупреждение по
 * `busy` рисует новый блок обновления; эта плашка доживает до его прихода.
 */
export function UpdateBanner() {
  const bridge = typeof window !== 'undefined' ? window.officeDesktop?.updates : undefined;
  const [state, setState] = useState<UpdateState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [installing, setInstalling] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    bridge.getState().then((s) => { if (alive) setState(s); });
    return bridge.onState((s) => { if (alive) setState(s); });
  }, [bridge]);

  const version = state?.phase === 'ready' ? state.version : null;
  // Новая скачанная версия — окно заметок прежней к ней не относится.
  useEffect(() => {
    setNotesOpen(false);
  }, [version]);

  // Esc закрывает окно заметок — как крестик и клик по подложке.
  useEffect(() => {
    if (!notesOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNotesOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notesOpen]);

  if (!bridge || !state) return null;

  if (state.phase === 'downloading') {
    const percent = state.percent ?? 0;
    return (
      <div className="update-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="update-progress-bar" style={{ width: `${percent}%` }} title={t('update.downloading', { percent })} />
      </div>
    );
  }

  if (state.phase !== 'ready' || !state.version || state.version === dismissed) return null;
  const readyVersion = state.version;

  const handleLater = () => {
    writeDismissed(readyVersion);
    setDismissed(readyVersion);
  };

  const handleRestart = () => {
    if (!bridge) return;
    setInstalling(true);
    bridge.restartNow().finally(() => setInstalling(false));
  };

  const actions = (
    <button className="primary mini" onClick={handleRestart} disabled={installing}>
      {t('update.restart')}
    </button>
  );

  return (
    <>
      <div className="update-banner" role="status">
        <div className="update-banner-body">
          <div className="update-banner-title">{t('update.ready.title', { version: state.version })}</div>
          {state.notes && (
            <button className="update-banner-notes" onClick={() => setNotesOpen(true)}>
              {t('update.notes.toggle')}
            </button>
          )}
        </div>
        <div className="update-banner-actions">
          {actions}
          <button className="ghost mini" onClick={handleLater}>{t('update.later')}</button>
        </div>
      </div>
      {notesOpen && state.notes && (
        <div className="modal-backdrop" onClick={() => setNotesOpen(false)}>
          <div className="modal update-notes" role="dialog" aria-modal="true" aria-labelledby="update-notes-title"
            onClick={(e) => e.stopPropagation()}>
            <div className="modal-head update-notes-head">
              <h3 id="update-notes-title">{t('update.notes.title', { version: state.version })}</h3>
              <button className="sq ghost" onClick={() => setNotesOpen(false)} aria-label={t('common.close')} title={t('common.close')}>✕</button>
            </div>
            <div className="update-notes-body">
              <ReleaseNotes source={state.notes} />
            </div>
            <div className="modal-actions update-notes-actions">
              {actions}
              <button className="ghost mini" onClick={() => setNotesOpen(false)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

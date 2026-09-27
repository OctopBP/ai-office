import { useEffect, useState } from 'react';
import { t } from '../i18n';
import type { UpdateState } from '../../shared/desktop';

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
 * src/shared/desktop.ts). Моста `window.officeDesktop.updates` нет ни в
 * браузере, ни в старых версиях приложения — тогда компонент молчит совсем,
 * не подписываясь и не рисуя ничего.
 *
 * Показываем только то, что владельцу реально нужно решить: скачанное
 * обновление (`ready`) и лёгкую полоску загрузки (`downloading`). `checking`,
 * `available` (автозагрузка стартует сама через мгновение) и `error` — тихо:
 * ошибка проверки не должна маячить окном, она уже осела в журнал обновлений.
 */
export function UpdateBanner() {
  const bridge = typeof window !== 'undefined' ? window.officeDesktop?.updates : undefined;
  const [state, setState] = useState<UpdateState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    bridge.getState().then((s) => { if (alive) setState(s); });
    return bridge.onState((s) => { if (alive) setState(s); });
  }, [bridge]);

  const version = state?.status === 'ready' ? state.version : null;
  // Новая скачанная версия — прежний отказ и отложенная плашка к ней не относятся.
  useEffect(() => {
    setBusy(false);
    setNotesOpen(false);
  }, [version]);

  if (!bridge || !state) return null;

  if (state.status === 'downloading') {
    return (
      <div className="update-progress" role="progressbar" aria-valuenow={state.percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="update-progress-bar" style={{ width: `${state.percent}%` }} title={t('update.downloading', { percent: state.percent })} />
      </div>
    );
  }

  if (state.status !== 'ready' || state.version === dismissed) return null;

  const handleLater = () => {
    writeDismissed(state.version);
    setDismissed(state.version);
  };

  const handleRestart = () => {
    if (!bridge) return;
    setInstalling(true);
    bridge.installNow()
      .then((res) => { if (!res.ok && res.reason === 'busy') setBusy(true); })
      .finally(() => setInstalling(false));
  };

  return (
    <div className="update-banner" role="status">
      <div className="update-banner-body">
        <div className="update-banner-title">{t('update.ready.title', { version: state.version })}</div>
        {state.notes && (
          <details className="update-banner-notes" open={notesOpen} onToggle={(e) => setNotesOpen(e.currentTarget.open)}>
            <summary>{t('update.notes.toggle')}</summary>
            {/* Заметки к релизу — свой текст с GitHub, не чужая разметка: без
                dangerouslySetInnerHTML, просто текст в несколько строк. */}
            <p className="update-banner-notes-text">{state.notes}</p>
          </details>
        )}
      </div>
      <div className="update-banner-actions">
        {busy ? (
          <span className="update-banner-busy">{t('update.busy')}</span>
        ) : (
          <button className="primary mini" onClick={handleRestart} disabled={installing}>
            {t('update.restart')}
          </button>
        )}
        <button className="ghost mini" onClick={handleLater}>{t('update.later')}</button>
      </div>
    </div>
  );
}

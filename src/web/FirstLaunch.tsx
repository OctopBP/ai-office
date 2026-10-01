import { useEffect, useState } from 'react';
import type { ProviderView } from '../shared/types';
import { ProviderCard } from './ProviderCard';
import { pushToast, skipFirstLaunch, useStore } from './store';
import { t } from './i18n';

/**
 * Экран первого запуска «Чем будет работать команда?» (docs/design/T-189/ui.md §3).
 * Открывается сам, когда сервер говорит, что ни один провайдер не подключён
 * (`ProvidersView.noneReady`), — один раз на место: на главный экран и на
 * каждый офис. Это вопрос, а не ошибка: ни красного, ни блокирующего диалога.
 */

/**
 * Открыт ли экран в этом месте (`where` — id офиса или `menu`). Открытие
 * защёлкивается: как только первая карточка станет готовой, `noneReady`
 * погаснет, но экран останется, пока владелец сам не выберет провайдера.
 */
export function useFirstLaunch(where: string): { open: boolean; close: () => void } {
  const noneReady = useStore((s) => s.providers?.noneReady === true);
  const skipped = useStore((s) => s.firstLaunchSkipped.includes(where));
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (noneReady && !skipped) setOpen(true);
    if (skipped) setOpen(false);
  }, [noneReady, skipped, where]);
  return { open, close: () => setOpen(false) };
}

/** Порядок — алфавитный и не зависит от состояния: карточка не прыгает из-под курсора. */
export const byLabel = (a: ProviderView, b: ProviderView): number => a.label.localeCompare(b.label, 'en');

export function FirstLaunch({ where, onClose, standalone }: {
  where: string;
  onClose: () => void;
  /** До выбора офиса: страница во всё окно, без рейла. */
  standalone?: boolean;
}) {
  const providers = useStore((s) => s.providers);
  const list = [...(providers?.providers ?? [])].sort(byLabel);
  const ready = list.filter((p) => p.status.state === 'ready' || p.status.state === 'limited');
  const [which, setWhich] = useState('');

  const use = (p: ProviderView) => {
    pushToast({ id: `first-launch-${p.id}`, kind: 'info', title: t('providers.first.toast', { name: p.label }) });
    onClose();
  };
  const skip = () => {
    skipFirstLaunch(where);
    onClose();
  };
  const chosen = ready.length === 1 ? ready[0] : ready.find((p) => p.id === which);

  return (
    <section className={`first-launch${standalone ? ' standalone' : ' shell-view'}`} aria-labelledby="first-launch-title">
      <div className="first-launch-col">
        <h2 id="first-launch-title" className="first-launch-title">{t('providers.first.title')}</h2>
        <p className="first-launch-desc">{t('providers.first.desc')}</p>
        <div className="provider-list">
          {list.map((p) => <ProviderCard key={p.id} p={p} onUse={() => use(p)} />)}
        </div>
        <div className="first-launch-foot">
          {ready.length > 1 && (
            <select value={which} aria-label={t('providers.first.which')} onChange={(e) => setWhich(e.target.value)}>
              <option value="" disabled>{t('providers.first.which')}</option>
              {ready.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          )}
          <button className="primary" aria-disabled={!chosen} disabled={!chosen}
            title={ready.length === 0 ? t('providers.first.submitHint') : undefined}
            onClick={() => { if (chosen) use(chosen); }}>
            {t('providers.first.submit')}
          </button>
          {ready.length === 0 && <span className="form-hint">{t('providers.first.submitHint')}</span>}
        </div>
        <button className="ghost first-launch-skip" onClick={skip}>{t('providers.first.skip')}</button>
      </div>
    </section>
  );
}

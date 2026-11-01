import { useEffect, useState } from 'react';
import type { РасходЗаПериоды } from '../../shared/types';
import { LIMIT_TICK_MS } from '../LimitBars';
import { Tooltip } from '../Tooltip';
import { t } from '../i18n';
import { officeProvider, useStore } from '../store';
import { данныеСтроки, суммаРейла } from './расходыРейла';

/** Доллары офиса и лимит аккаунта независимы: у каждой строки своя подсказка. */
export function RailSpend() {
  const расходы = useStore(s => s.spendWindows);
  const лимиты = useStore(s => s.limits);
  const провайдеры = useStore(s => s.providers);
  const модель = useStore(s => s.settings.model);
  const офис = useStore(s => s.offices.find(o => o.current)?.id);
  const переход = useStore(s => s.pending);
  const [сейчас, задатьСейчас] = useState(Date.now);
  const [ошибка, задатьОшибку] = useState(false);

  useEffect(() => {
    const таймер = window.setInterval(() => задатьСейчас(Date.now()), LIMIT_TICK_MS);
    return () => window.clearInterval(таймер);
  }, []);

  useEffect(() => {
    if (!офис || переход) return;
    const контроллер = new AbortController();
    let занят = false;
    const обновить = async () => {
      if (занят || document.hidden) return;
      занят = true;
      try {
        const ответ = await fetch(`/api/spend?office=${encodeURIComponent(офис)}&limit=1`, { signal: контроллер.signal });
        if (!ответ.ok) throw new Error('spend');
        const данные = await ответ.json() as { windows?: РасходЗаПериоды };
        if (!данные.windows || !Number.isFinite(данные.windows.calculatedAt)) throw new Error('windows');
        if (контроллер.signal.aborted) return;
        const состояние = useStore.getState();
        if (состояние.pending || состояние.offices.find(o => o.current)?.id !== офис) return;
        if (!состояние.spendWindows || данные.windows.calculatedAt >= состояние.spendWindows.calculatedAt) {
          useStore.setState({ spendWindows: данные.windows });
        }
        задатьОшибку(false);
      } catch {
        if (!контроллер.signal.aborted) задатьОшибку(true);
      } finally { занят = false; }
    };
    задатьОшибку(false);
    void обновить();
    const таймер = window.setInterval(() => void обновить(), LIMIT_TICK_MS * 2);
    document.addEventListener('visibilitychange', обновить);
    return () => {
      контроллер.abort();
      window.clearInterval(таймер);
      document.removeEventListener('visibilitychange', обновить);
    };
  }, [офис, переход]);

  const провайдер = переход ? null : officeProvider(провайдеры, модель)?.provider ?? null;
  const устарел = ошибка || !!расходы && сейчас - расходы.calculatedAt > LIMIT_TICK_MS * 4;
  return (
    <div className="rail-spend" aria-label={t('rail.spend.title')}>
      {(['5h', '1w'] as const).map(период => {
        const расход = переход ? undefined : период === '5h' ? расходы?.fiveHour : расходы?.sevenDay;
        const { процент, строки } = данныеСтроки(лимиты, провайдер, период, сейчас);
        const сумма = суммаРейла(расход, устарел);
        const пояснения = [
          ...строки,
          t(период === '5h' ? 'rail.spend.fiveHour' : 'rail.spend.sevenDay', { money: сумма }),
          t('rail.spend.estimated'),
          ...(!расход || расход.costStatus === 'unavailable' ? [t('rail.spend.costUnknown')] : []),
          ...(расход?.costStatus === 'partial' ? [t('rail.spend.partial')] : []),
          ...(расход?.historyPartial ? [t('rail.spend.historyPartial')] : []),
          ...(устарел ? [t('rail.spend.stale')] : []),
          ...(ошибка ? [t('rail.spend.retry')] : []),
        ];
        return (
          <Tooltip key={период} className="tip-block rail-spend-tip"
            tip={<>{пояснения.map((строка, номер) => <span key={номер}>{строка}</span>)}</>}>
            <div className="rail-spend-row" tabIndex={0}
              aria-label={`${период}. ${пояснения.join('. ')}`}>
              <span className="rail-spend-period">{период}</span>
              {процент === null
                ? <span className="rail-spend-unknown" aria-label={t('rail.spend.percentUnknown')}>—</span>
                : <span className="meter" role="progressbar" aria-label={t('rail.spend.bar', { period: период })}
                  aria-valuemin={0} aria-valuemax={100} aria-valuenow={процент}>
                  <i style={{ width: `${процент}%` }} />
                </span>}
              <b>{сумма}</b>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

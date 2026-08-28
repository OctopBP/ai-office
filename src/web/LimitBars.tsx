import { useEffect, useState } from 'react';
import type { LimitKind } from '../shared/types';
import { freshness, limitTone, resetLine } from './money';
import { useStore } from './store';
import { t, type UiKey } from './i18n';

/**
 * Шкалы лимитов плана. Отдельным файлом, потому что спрашивают про лимит в
 * двух местах: на доске расходов внутри офиса и в главном меню, где офис ещё
 * не выбран. Лимит один на аккаунт, и рисоваться он обязан одинаково — две
 * копии этих шкал разошлись бы на первой же правке порогов.
 */

const KIND_KEY: Record<LimitKind, UiKey> = {
  five_hour: 'limits.kind.fiveHour',
  seven_day: 'limits.kind.sevenDay',
  seven_day_opus: 'limits.kind.sevenDayOpus',
  seven_day_sonnet: 'limits.kind.sevenDaySonnet',
  seven_day_oauth_apps: 'limits.kind.sevenDayApps',
  seven_day_overage_included: 'limits.kind.sevenDayOverage',
  overage: 'limits.kind.overage',
};

/** Шкала: заполнение, подпись слева, проценты справа. */
export function Gauge({ label, percent, note, tone }: {
  label: string; percent: number; note?: string; tone: 'ok' | 'warn' | 'hot';
}) {
  return (
    <div className="limit">
      <div className="limit-head">
        <span>{label}</span>
        <b className={tone}>{Math.round(percent)}%</b>
      </div>
      <div className="limit-bar">
        <div className={`limit-fill ${tone}`} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

/**
 * Лимиты плана целиком. Их считает не офис: цифры приезжают от SDK по ходу
 * работы, поэтому у только что запущенного офиса их может не быть вовсе — и
 * это не «ноль израсходовано», а «счётчика пока не видели». Так и написано:
 * пустая шкала на месте неизвестного успокаивала бы зря.
 */
export function LimitBars() {
  const limits = useStore((s) => s.limits);
  const authSource = useStore((s) => s.authSource);
  // Часы обратного отсчёта живут здесь, а не у того, кто рисует шкалы: тикать
  // они должны одинаково везде, и второй такой таймер в меню разошёлся бы
  // с этим на полминуты.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), LIMIT_TICK_MS);
    return () => clearInterval(id);
  }, []);

  if (!limits.available || limits.windows.length === 0) {
    return (
      <p className="muted small">
        {t(authSource === 'api-key' ? 'limits.none.apiKey' : 'limits.none.yet')}
      </p>
    );
  }

  return (
    <>
      <div className="limit-rows">
        {limits.windows.map((w) => (
          <Gauge
            key={w.kind}
            label={t(KIND_KEY[w.kind])}
            percent={w.utilization}
            note={resetLine(w, now)}
            tone={limitTone(w.utilization)}
          />
        ))}
      </div>
      <div className="muted small">
        {limits.plan && `${t('limits.plan', { plan: limits.plan })} · `}
        {limits.updatedAt !== null && freshness(limits.updatedAt, now)}
        {limits.status === 'allowed_warning' && ` · ${t('limits.status.warn')}`}
        {limits.status === 'rejected' && ` · ${t('limits.status.rejected')}`}
      </div>
    </>
  );
}

/**
 * Часы для обратного отсчёта. Раз в полминуты: до сброса лимита часы, и чаще
 * дёргать перерисовку не за чем.
 */
export const LIMIT_TICK_MS = 30_000;

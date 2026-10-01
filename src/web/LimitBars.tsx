import { isConnected, PROVIDERS } from '../shared/providers';
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
  codex_primary: 'limits.kind.codexPrimary',
  codex_secondary: 'limits.kind.codexSecondary',
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
      <div className="meter">
        <i className={tone === 'hot' ? 'danger' : tone === 'warn' ? 'warn' : ''}
          style={{ width: `${Math.min(100, percent)}%` }} />
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
  const providers = useStore((s) => s.providers);
  // Часы обратного отсчёта живут здесь, а не у того, кто рисует шкалы: тикать
  // они должны одинаково везде, и второй такой таймер в меню разошёлся бы
  // с этим на полминуты.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), LIMIT_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Шкалы — только у подключённых провайдеров: лимиты лежат на диске с
  // прошлых запусков, и шкала отключённого провайдера (той же подписки Claude)
  // выглядела бы так, будто офис на нём работает. Список провайдеров ещё не
  // пришёл — не прячем ничего, чтобы не мигать пустотой на старте.
  const connected = providers?.providers.filter((p) => isConnected(p.status)) ?? null;
  const windows = connected
    ? limits.windows.filter((w) => connected.some((p) => p.id === w.provider))
    : limits.windows;

  if (!limits.available || windows.length === 0) {
    const none: UiKey = connected?.length === 0 ? 'limits.none.noProvider'
      // Все подключённые пускают по ключу API — планов с окнами у них нет.
      : connected?.length && connected.every((p) => p.status.state === 'ready' && p.status.auth === 'api-key')
        ? 'limits.none.apiKey'
        : 'limits.none.yet';
    return <p className="muted small">{t(none)}</p>;
  }

  return (
    <>
      <div className="limit-rows">
        {windows.map((w) => (
          <Gauge
            key={`${w.provider ?? ''}:${w.kind}`}
            label={`${w.provider ? PROVIDERS[w.provider].label + ' · ' : ''}${t(KIND_KEY[w.kind])}`}
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

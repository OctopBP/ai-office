import { useStore } from './store';
import type { Usage } from '../shared/types';
import { t } from './i18n';

const money = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
const tok = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M`
  : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v));

/**
 * Доля ввода, которую модель прочитала из кеша. Считаем от всего ввода,
 * а не от суммы всех токенов: вывод к кешу отношения не имеет.
 */
export function cacheShare(u: Usage): number | null {
  const input = u.tokensIn + u.cacheRead;
  return input > 0 ? Math.round((u.cacheRead / input) * 100) : null;
}

/** Строка «38k in / 6k out · кеш 91%» — одна формулировка на весь интерфейс. */
export function usageLine(u: Usage): string {
  const share = cacheShare(u);
  return `${tok(u.tokensIn)} in / ${tok(u.tokensOut)} out` +
    (share === null ? '' : t('usage.cacheShare', { share }));
}

const dayLabel = (day: string): string => {
  const [, m, d] = day.split('-');
  return `${d}.${m}`;
};

export function UsageModal({ onClose }: { onClose: () => void }) {
  const usage = useStore((s) => s.usage);
  const days = useStore((s) => s.usageDays);
  const instances = useStore((s) => s.instances);
  const tasks = useStore((s) => s.tasks);
  const settings = useStore((s) => s.settings);

  const week = days.slice(-7);
  const peak = Math.max(0.0001, ...week.map((d) => d.usage.costUsd));
  const today = Object.values(instances).reduce((sum, i) => sum + i.today.costUsd, 0);
  const agents = Object.values(instances).sort((a, b) => b.usage.costUsd - a.usage.costUsd);
  const priciest = Object.values(tasks)
    .filter((t) => t.usage.costUsd > 0)
    .sort((a, b) => b.usage.costUsd - a.usage.costUsd)
    .slice(0, 5);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{t('usage.title')}</h3>
        <p className="modal-reason">{t('usage.note')}</p>

        <div className="usage-total">
          <div>
            <b>{money(today)}</b>
            <span className="muted small">{t('common.today')}</span>
          </div>
          <div>
            <b>{money(usage.costUsd)}</b>
            <span className="muted small">
              {t('usage.allTime')}
              {settings.globalBudgetUsd !== null
                && t('usage.ofCap', { cap: money(settings.globalBudgetUsd) })}
            </span>
          </div>
          <div>
            <b>{tok(usage.tokensIn)} / {tok(usage.tokensOut)}</b>
            <span className="muted small">{t('usage.inOut')}</span>
          </div>
          <div>
            <b>{cacheShare(usage) ?? 0}%</b>
            <span className="muted small">
              {t('usage.fromCache', { written: tok(usage.cacheWrite) })}
            </span>
          </div>
        </div>

        <h4>{t('usage.byDay')}</h4>
        {week.length === 0 && <p className="muted small">{t('usage.nothingSpent')}</p>}
        <div className="usage-days">
          {week.map((d) => (
            <div key={d.day} className="usage-day" title={`${d.day}: ${money(d.usage.costUsd)} · ${usageLine(d.usage)}`}>
              <div className="usage-bar" style={{ height: `${Math.max(4, (d.usage.costUsd / peak) * 56)}px` }} />
              <span className="muted small">{dayLabel(d.day)}</span>
              <span className="mono small">{money(d.usage.costUsd)}</span>
            </div>
          ))}
        </div>

        <h4>{t('usage.byAgent')}</h4>
        <div className="usage-rows">
          {agents.map((i) => (
            <div key={i.id} className="usage-row">
              <span className="mono dim">{i.id}</span>
              <span className="muted small">{usageLine(i.usage)}</span>
              <span className="muted small">
                {t('usage.todayCost', { cost: money(i.today.costUsd) })}
              </span>
              <b>{money(i.usage.costUsd)}</b>
            </div>
          ))}
        </div>

        {priciest.length > 0 && (
          <>
            <h4>{t('usage.priciest')}</h4>
            <div className="usage-rows">
              {priciest.map((t) => (
                <div key={t.id} className="usage-row">
                  <span className="mono dim">{t.id}</span>
                  <span className="row-title">{t.title}</span>
                  <span className="muted small">{usageLine(t.usage)}</span>
                  <b>{money(t.usage.costUsd)}</b>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="allow" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}

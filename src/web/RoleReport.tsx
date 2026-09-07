import { useState } from 'react';
import { useStore } from './store';
import { roleReport, WEEK_MS } from '../shared/report';
import { money } from './money';
import { t } from './i18n';

type Window = 'week' | 'month' | 'all';

const SINCE: Record<Window, () => number> = {
  week: () => Date.now() - WEEK_MS,
  month: () => Date.now() - 30 * 24 * 60 * 60 * 1000,
  all: () => 0,
};

const percent = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Табель роли в окне команды (docs/design/living-office/spec.md §3.2):
 * сколько закрыто, какая доля чисто, сколько переделывалось и вставало,
 * почём задача и честна ли роль в отметках критериев.
 *
 * Считается на клиенте из исходов задач, которые и так лежат в сторе, — по
 * той же формуле, что читает менеджер на рефлексии (`shared/report.ts`).
 * Отдельного счётчика на сервере нет намеренно: он ехал бы заново на каждое
 * изменение любой задачи.
 */
export function RoleReport({ roleId }: { roleId: string }) {
  const tasks = useStore((s) => s.tasks);
  const [window, setWindow] = useState<Window>('week');
  const report = roleReport(Object.values(tasks), roleId, SINCE[window]());
  const k = report.byKind;

  return (
    <section className="role-report">
      <div className="role-report-head">
        <h4 className="section-title">{t('report.title')}</h4>
        <div className="seg mini-seg">
          {(['week', 'month', 'all'] as Window[]).map((w) => (
            <button key={w} className={window === w ? 'on' : ''} onClick={() => setWindow(w)}>
              {t(`report.window.${w}`)}
            </button>
          ))}
        </div>
      </div>
      {report.closed === 0 ? (
        <p className="muted small">{t('report.empty')}</p>
      ) : (
        <div className="report-grid">
          <div className="report-cell">
            <span className="muted small">{t('report.closed')}</span>
            <b>{report.closed}</b>
          </div>
          <div className="report-cell" title={t('report.cleanShare.hint')}>
            <span className="muted small">{t('report.cleanShare')}</span>
            <b>{percent(report.cleanShare)}</b>
          </div>
          <div className="report-cell">
            <span className="muted small">{t('report.reworked')}</span>
            <b>{k.reworked}</b>
            {k.reworked > 0 && (
              <span className="muted small">{t('report.avgReworks', { n: report.avgReworks.toFixed(1) })}</span>
            )}
          </div>
          <div className="report-cell">
            <span className="muted small">{t('report.stuck')}</span>
            <b>{k.stuck}</b>
          </div>
          <div className="report-cell">
            <span className="muted small">{t('report.failed')}</span>
            <b className={k.failed ? 'bad' : ''}>{k.failed}</b>
          </div>
          <div className="report-cell">
            <span className="muted small">{t('report.reverted')}</span>
            <b className={k.reverted ? 'bad' : ''}>{k.reverted}</b>
          </div>
          <div className="report-cell">
            <span className="muted small">{t('report.avgCost')}</span>
            <b>{money(report.avgCostUsd)}</b>
            <span className="muted small">{t('report.total')} {money(report.totalCostUsd)}</span>
          </div>
          <div className="report-cell" title={t('report.claimed.hint')}>
            <span className="muted small">{t('report.claimed')}</span>
            <b>{report.claimedBeforeRework === null ? t('common.none') : percent(report.claimedBeforeRework)}</b>
          </div>
          <div className="report-cell" title={t('report.origin.hint')}>
            <span className="muted small">{t('report.origin')}</span>
            <b>{report.byOrigin.owner} / {report.byOrigin.office}</b>
          </div>
        </div>
      )}
    </section>
  );
}

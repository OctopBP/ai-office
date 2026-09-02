import { prStageLabel, prStageClass, retryPipeline, showDiff, useStore } from './store';
import type { PullRequestView } from '../shared/types';
import { locale, t } from './i18n';

/**
 * Конвейер ревью: что офис делает со сданными задачами прямо сейчас.
 * Это не список дел для пользователя — вмешиваться нужно только там, где
 * стадия «встало»: всё остальное едет само.
 */
const clock = (at: number): string =>
  new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

function order(a: PullRequestView, b: PullRequestView): number {
  // Вставшие — наверх: это единственное, что ждёт человека.
  if ((a.stage === 'stuck') !== (b.stage === 'stuck')) return a.stage === 'stuck' ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

export function PrPipeline() {
  const prs = useStore((s) => s.prs);
  const auto = useStore((s) => s.settings.autoPipeline);
  const list = Object.values(prs).sort(order);
  const live = list.filter((p) => p.stage !== 'merged');

  if (!auto) {
    return (
      <p className="empty">{t('pr.off')}</p>
    );
  }
  if (list.length === 0) {
    return <p className="empty">{t('pr.empty')}</p>;
  }

  return (
    <div className="pr-list">
      <div className="mq-head section-title">
        {t('pr.title')}
        {live.length > 0 && (
          <span className="muted small">{t('pr.live', { n: live.length })}</span>
        )}
      </div>
      <p className="muted small pr-hint">{t('pr.hint')}</p>

      {list.map((pr) => {
        const last = pr.reviews[pr.reviews.length - 1];
        return (
          <div key={pr.id} className={`mq-item ${pr.stage === 'stuck' ? 'conflict' : pr.stage === 'merged' ? 'merged' : ''}`}>
            <div className="mq-item-row">
              <span className="mono muted">{pr.taskId}</span>
              <span className="mq-title">{pr.title}</span>
              {pr.rounds > 0 && (
                <span className="muted small" title={t('pr.rounds.hint')}>
                  {t('pr.round', { n: pr.rounds + 1 })}
                </span>
              )}
              <span className={`chip merge-chip ${prStageClass(pr.stage)}`}>
                {prStageLabel(pr.stage)}
              </span>
            </div>

            <div className="mq-reason">{pr.note}</div>

            {pr.stage === 'stuck' && (
              <div className={`pr-watch ${pr.needsDecision ? 'bad' : ''}`}>
                {pr.needsDecision
                  ? t('pr.needsDecision')
                  : t('pr.retrying')
                    + (pr.nextTryAt ? t('pr.retryAt', { time: clock(pr.nextTryAt) }) : '')
                    + (pr.retries ? t('pr.retries', { n: pr.retries }) : '') + '.'}
              </div>
            )}

            {last && (
              <div className={`pr-review ${last.verdict === 'approve' ? 'ok' : 'bad'}`}>
                <b>{t(last.verdict === 'approve' ? 'pr.approved' : 'pr.changes')}</b>
                <p>{last.text}</p>
              </div>
            )}

            <div className="pr-actions">
              <span className="mono small muted">{pr.branch} → {pr.base}</span>
              {pr.url && (
                <a className="mini" href={pr.url} target="_blank" rel="noreferrer">
                  PR #{pr.number}
                </a>
              )}
              {pr.stage !== 'merged' && (
                <button type="button" className="mini" onClick={() => showDiff(pr.taskId)}>diff</button>
              )}
              {pr.stage === 'stuck' && (
                <button type="button" className="mini" onClick={() => retryPipeline(pr.taskId)}>
                  {t('pr.retryNow')}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

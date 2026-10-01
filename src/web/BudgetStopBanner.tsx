import type { TaskView } from '../shared/types';
import { retryTask } from './store';
import { t } from './i18n';
import { tok } from './money';

/**
 * Плашка остановленной по расходу задачи: «потрачено / порог» и кнопка
 * перезапуска. Перезапуск идёт обычным `retryTask` — порог предохранителя
 * считается сервером из истории роли и отсюда не меняется.
 * Живёт и в карточке задачи, и в живой карточке ленты чата (`compact`).
 */
export function BudgetStopBanner({ task, compact }: { task: TaskView; compact?: boolean }) {
  const stop = task.outcome?.kind === 'stopped_budget' ? task.outcome.budget : undefined;
  if (!stop) return null;
  // Перезапускать можно только то, что не идёт и не влито — как и на сервере.
  const canRetry = task.status === 'failed' || task.status === 'blocked';
  const figures = stop.reason === 'tokens'
    ? t('budgetStop.tokens', { spent: tok(stop.spentTokens), limit: tok(stop.limitTokens) })
    : t('budgetStop.compactions', { n: stop.compactions });
  // Клик по плашке в карточке ленты не должен открывать карточку задачи.
  const swallow = { onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    onKeyDown: (e: { stopPropagation: () => void }) => e.stopPropagation() };
  return (
    <div className={`budget-stop${compact ? ' compact' : ''}`} role="alert" {...swallow}>
      <div className="budget-stop-main">
        <b>{t('budgetStop.title')}</b>
        <span className="mono small">{figures}</span>
        {!compact && (
          <span className="muted small">
            {t(stop.limitSource === 'history' ? 'budgetStop.fromHistory' : 'budgetStop.fromDefault', { n: stop.samples })}
          </span>
        )}
      </div>
      {canRetry && (
        <button className="retry" onClick={() => retryTask(task.id)} title={t('budgetStop.restartHint')}>
          {t('board.restart')}
        </button>
      )}
    </div>
  );
}

import {
  mergeBadge, mergeStepFor, mergeTask, prStageLabel, prStageClass, retryPipeline,
  retryTask, showDiff, stopTask, useStore,
} from './store';
import type { TaskStatus, TaskView } from '../shared/types';
import { t as tr, type UiKey } from './i18n';

/**
 * Колонки доски. Провалы вынесены отдельно, а не свалены в «Готово»: пока они
 * лежали рядом со сделанным, их не замечали ни человек, ни менеджер — а это
 * ровно та стопка, из-за которой работа встаёт.
 */
const COLUMNS: Array<{ key: UiKey; statuses: TaskStatus[]; tone?: 'bad' }> = [
  { key: 'board.col.waiting', statuses: ['backlog', 'assigned'] },
  { key: 'board.col.working', statuses: ['in_progress'] },
  { key: 'board.col.review', statuses: ['review'] },
  { key: 'board.col.done', statuses: ['done'] },
  { key: 'board.col.failed', statuses: ['failed', 'blocked'], tone: 'bad' },
];

const statusLabel = (status: TaskStatus): string => tr(`task.status.${status}`);

function Card({ t }: { t: TaskView }) {
  const run = useStore((s) => s.mergeRun);
  const check = useStore((s) => s.mergeChecks[t.id]);
  const step = mergeStepFor(run, t.id);
  const badge = mergeBadge(t, step, check);
  // Стадия конвейера точнее статуса: «на проверке» одинаково выглядит и когда
  // ветку синхронизируют, и когда ревьюер уже смотрит.
  const pr = useStore((s) => s.prs[t.id]);
  // Пока конвейер ведёт задачу, ручное слияние вырвало бы ветку из-под
  // ревьюера — кнопку показываем, только когда он встал или его не было.
  const pipelineRunning = Boolean(pr) && pr.stage !== 'stuck' && pr.stage !== 'merged';
  return (
    <div className={`task ${t.status}`}>
      <div className="task-head">
        <b>{t.id}</b>
        <span className="task-title">{t.title}</span>
      </div>
      <div className="task-meta">
        <span className={`chip ${t.status}`}>{statusLabel(t.status)}</span>
        {pr && pr.stage !== 'merged' && (
          <span className={`chip merge-chip ${prStageClass(pr.stage)}`} title={pr.note}>
            {prStageLabel(pr.stage)}
          </span>
        )}
        {badge && (
          <span
            className={`chip merge-chip ${badge.cls}`}
            title={check?.state === 'conflict' ? check.conflicts.join(', ') : undefined}
          >
            {badge.label}
          </span>
        )}
        <span className="muted">{t.assigneeId ?? tr('common.none')}</span>
        {t.criteria.length > 0 && (
          <span className="muted">
            {tr('board.criteria', {
              done: t.criteria.filter((c) => c.done).length, total: t.criteria.length,
            })}
          </span>
        )}
        {t.usage.costUsd > 0 && <span className="muted">{`$${t.usage.costUsd.toFixed(3)}`}</span>}
      </div>
      {t.criteria.length > 0 && (
        <div className="criteria">
          {t.criteria.map((c, i) => (
            <div key={i} className={`criterion ${c.done ? 'done' : ''}`}>
              <span className="mark">{c.done ? '✓' : '·'}</span>{c.text}
            </div>
          ))}
        </div>
      )}
      {t.result && <div className="task-result">{t.result}</div>}
      {(t.status === 'failed' || t.status === 'blocked') && (
        <div className="muted small task-watch">
          {tr(t.interrupted ? 'board.interrupted' : 'board.toldManager')}
        </div>
      )}
      <div className="task-controls">
        {t.status === 'in_progress' && (
          <button className="stop" onClick={() => stopTask(t.id)}>{tr('board.stop')}</button>
        )}
        {(t.status === 'failed' || t.status === 'blocked') && (
          <button className="retry" onClick={() => retryTask(t.id)}>{tr('board.restart')}</button>
        )}
        {pr?.stage === 'stuck' && (
          <button className="retry" onClick={() => retryPipeline(t.id)}>
            {tr('board.continueReview')}
          </button>
        )}
      </div>
      {t.files.length > 0 && <div className="task-files mono">{t.files.join('  ·  ')}</div>}
      {t.branch && (
        <div className="task-branch">
          <span className="mono">{t.branch}</span>
          {t.merged ? (
            <span className="merged">{tr('merge.merged')}</span>
          ) : (
            <>
              <button className="mini" onClick={() => showDiff(t.id)}>{tr('board.showDiff')}</button>
              {!pipelineRunning && (t.status === 'done' || pr?.stage === 'stuck') && (
                <button className="merge" onClick={() => mergeTask(t.id)}>{tr('board.merge')}</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Board() {
  const tasks = useStore((s) => s.tasks);
  const list = Object.values(tasks).sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div className="board">
      {list.length === 0 && <p className="empty">{tr('board.empty')}</p>}
      {list.length > 0 && (
        <div className="columns">
          {COLUMNS.map((col) => {
            const items = list.filter((t) => col.statuses.includes(t.status));
            return (
              <div key={col.key} className={`column${col.tone ? ` ${col.tone}` : ''}`}>
                <div className="column-head">
                  {tr(col.key)} <span className="muted">{items.length}</span>
                </div>
                {items.map((t) => <Card key={t.id} t={t} />)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

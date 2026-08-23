import {
  mergeBadge, mergeStepFor, mergeTask, PR_STAGE_LABEL, prStageClass, retryPipeline,
  retryTask, showDiff, stopTask, useStore,
} from './store';
import type { TaskStatus, TaskView } from '../shared/types';

/**
 * Колонки доски. Провалы вынесены отдельно, а не свалены в «Готово»: пока они
 * лежали рядом со сделанным, их не замечали ни человек, ни менеджер — а это
 * ровно та стопка, из-за которой работа встаёт.
 */
const COLUMNS: Array<{ title: string; statuses: TaskStatus[]; tone?: 'bad' }> = [
  { title: 'Ожидают', statuses: ['backlog', 'assigned'] },
  { title: 'В работе', statuses: ['in_progress'] },
  { title: 'Ревью и слияние', statuses: ['review'] },
  { title: 'Готово', statuses: ['done'] },
  { title: 'Провалы и остановки', statuses: ['failed', 'blocked'], tone: 'bad' },
];

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'бэклог', assigned: 'назначена', in_progress: 'в работе',
  review: 'на проверке', blocked: 'заблокирована', done: 'готово', failed: 'провал',
};

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
        <span className={`chip ${t.status}`}>{STATUS_LABEL[t.status]}</span>
        {pr && pr.stage !== 'merged' && (
          <span className={`chip merge-chip ${prStageClass(pr.stage)}`} title={pr.note}>
            {PR_STAGE_LABEL[pr.stage]}
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
        <span className="muted">{t.assigneeId ?? '—'}</span>
        {t.criteria.length > 0 && (
          <span className="muted">
            критерии {t.criteria.filter((c) => c.done).length}/{t.criteria.length}
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
          {t.interrupted
            ? 'Оборвал перезапуск — офис возобновит сам.'
            : 'Офис показал это менеджеру: решение за ним.'}
        </div>
      )}
      <div className="task-controls">
        {t.status === 'in_progress' && (
          <button className="stop" onClick={() => stopTask(t.id)}>Остановить</button>
        )}
        {(t.status === 'failed' || t.status === 'blocked') && (
          <button className="retry" onClick={() => retryTask(t.id)}>Перезапустить</button>
        )}
        {pr?.stage === 'stuck' && (
          <button className="retry" onClick={() => retryPipeline(t.id)}>Продолжить ревью</button>
        )}
      </div>
      {t.files.length > 0 && <div className="task-files mono">{t.files.join('  ·  ')}</div>}
      {t.branch && (
        <div className="task-branch">
          <span className="mono">{t.branch}</span>
          {t.merged ? (
            <span className="merged">влита</span>
          ) : (
            <>
              <button className="mini" onClick={() => showDiff(t.id)}>Показать diff</button>
              {!pipelineRunning && (t.status === 'done' || pr?.stage === 'stuck') && (
                <button className="merge" onClick={() => mergeTask(t.id)}>Смержить</button>
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
      {list.length === 0 && <p className="empty">Пусто. Поставьте задачу PM'у справа.</p>}
      {list.length > 0 && (
        <div className="columns">
          {COLUMNS.map((col) => {
            const items = list.filter((t) => col.statuses.includes(t.status));
            return (
              <div key={col.title} className={`column${col.tone ? ` ${col.tone}` : ''}`}>
                <div className="column-head">
                  {col.title} <span className="muted">{items.length}</span>
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

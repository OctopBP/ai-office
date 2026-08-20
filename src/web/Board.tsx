import { mergeBadge, mergeTask, retryTask, showDiff, stopTask, useStore } from './store';
import type { TaskStatus, TaskView } from '../shared/types';

const COLUMNS: Array<{ title: string; statuses: TaskStatus[] }> = [
  { title: 'Ожидают', statuses: ['backlog', 'assigned'] },
  { title: 'В работе', statuses: ['in_progress'] },
  { title: 'Проверка', statuses: ['review', 'blocked'] },
  { title: 'Готово', statuses: ['done', 'failed'] },
];

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'бэклог', assigned: 'назначена', in_progress: 'в работе',
  review: 'на проверке', blocked: 'заблокирована', done: 'готово', failed: 'провал',
};

function Card({ t }: { t: TaskView }) {
  const queueItem = useStore((s) => s.mergeQueue?.items.find((i) => i.taskId === t.id));
  const badge = mergeBadge(t, queueItem);
  return (
    <div className={`task ${t.status}`}>
      <div className="task-head">
        <b>{t.id}</b>
        <span className="task-title">{t.title}</span>
      </div>
      <div className="task-meta">
        <span className={`chip ${t.status}`}>{STATUS_LABEL[t.status]}</span>
        {badge && (
          <span
            className={`chip merge-chip ${badge.cls}`}
            title={t.mergeability?.state === 'conflict' ? t.mergeability.conflicts.join(', ') : undefined}
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
      <div className="task-controls">
        {t.status === 'in_progress' && (
          <button className="stop" onClick={() => stopTask(t.id)}>Остановить</button>
        )}
        {(t.status === 'failed' || t.status === 'blocked') && (
          <button className="retry" onClick={() => retryTask(t.id)}>Перезапустить</button>
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
              {t.status === 'done' && (
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
              <div key={col.title} className="column">
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

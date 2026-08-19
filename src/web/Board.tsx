import { mergeTask, useStore } from './store';
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
  return (
    <div className={`task ${t.status}`}>
      <div className="task-head">
        <b>{t.id}</b>
        <span className="task-title">{t.title}</span>
      </div>
      <div className="task-meta">
        <span className={`chip ${t.status}`}>{STATUS_LABEL[t.status]}</span>
        <span className="muted">{t.assigneeId ?? '—'}</span>
      </div>
      {t.result && <div className="task-result">{t.result}</div>}
      {t.files.length > 0 && <div className="task-files mono">{t.files.join('  ·  ')}</div>}
      {t.branch && (
        <div className="task-branch">
          <span className="mono">{t.branch}</span>
          {t.merged ? (
            <span className="merged">влита</span>
          ) : t.status === 'done' ? (
            <button className="merge" onClick={() => mergeTask(t.id)}>Смержить</button>
          ) : null}
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
      <h2>Доска задач <span className="muted">{list.length}</span></h2>
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

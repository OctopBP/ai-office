import { Panel } from './Panel';
import { closeDiff, useStore } from './store';

/** Просмотр того, что задача изменила, — чтобы не лезть в терминал перед слиянием. */
export function DiffPanel() {
  const diff = useStore((s) => s.diff);
  const task = useStore((s) => (diff ? s.tasks[diff.taskId] : null));
  if (!diff) return null;

  const loading = !diff.error && !diff.stat && !diff.patch;

  return (
    <Panel
      title={`Изменения ${diff.taskId}`}
      hint={task ? `${task.title} · ветка ${task.branch}` : undefined}
      wide onClose={closeDiff}
    >
      {loading && <p className="muted">Считаю дифф…</p>}
      {diff.error && <p className="muted">{diff.error}</p>}
      {diff.stat && (
        <>
          <pre className="diff-stat">{diff.stat}</pre>
          <div className="diff">
            {diff.patch.split('\n').map((line, i) => {
              const kind = line.startsWith('+++') || line.startsWith('---') ? 'meta'
                : line.startsWith('@@') ? 'hunk'
                : line.startsWith('diff ') || line.startsWith('index ') ? 'meta'
                : line.startsWith('+') ? 'add'
                : line.startsWith('-') ? 'del' : '';
              return <div key={i} className={`dl ${kind}`}>{line || ' '}</div>;
            })}
          </div>
          {diff.truncated && (
            <p className="muted small">
              Дифф обрезан — слишком большой, чтобы показать целиком. Полностью его видно
              в рабочей копии задачи.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

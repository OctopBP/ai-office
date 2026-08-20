import { useEffect } from 'react';
import {
  checkMergeability, mergeBadge, mergeItemReason, QUEUE_STATE_LABEL,
  showDiff, startMergeQueue, stopMergeQueue, useStore,
} from './store';
import type { MergeQueueItem, TaskView } from '../shared/types';

/** Готовые к слиянию — завершённые задачи со своей веткой, которая ещё не влита. */
function candidatesOf(tasks: Record<string, TaskView>): TaskView[] {
  return Object.values(tasks)
    .filter((t) => t.status === 'done' && t.branch && !t.merged)
    .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
}

/** Что остановило уже отработавшую очередь и на какой задаче. */
function stoppedAt(items: MergeQueueItem[]): MergeQueueItem | undefined {
  return items.find((i) => i.state === 'failed');
}

export function MergeQueue() {
  const tasks = useStore((s) => s.tasks);
  const roles = useStore((s) => s.roles);
  const selection = useStore((s) => s.mergeSelection);
  const toggle = useStore((s) => s.toggleMergeSelect);
  const move = useStore((s) => s.moveMergeSelect);
  const clear = useStore((s) => s.clearMergeSelection);
  const queue = useStore((s) => s.mergeQueue);
  const typechecks = useStore((s) => s.mergeTypechecks);

  const candidates = candidatesOf(tasks);
  const candidateIds = candidates.map((t) => t.id).join(',');

  // Открыли панель или появилась новая готовая задача — сразу узнаём, чисто ли она сольётся.
  useEffect(() => {
    if (candidateIds) checkMergeability(candidateIds.split(','));
  }, [candidateIds]);

  const roleTitle = (roleId: string | null) => roles.find((r) => r.id === roleId)?.title ?? roleId ?? '—';
  const queueItemOf = (taskId: string) => queue?.items.find((i) => i.taskId === taskId);
  const stopper = queue && !queue.running ? stoppedAt(queue.items) : undefined;

  return (
    <div className="merge-queue">
      {candidates.length === 0 && (
        <p className="empty">Нет завершённых задач, ожидающих слияния.</p>
      )}

      {candidates.length > 0 && (
        <div className="mq-candidates">
          <div className="mq-head muted small">Готово к слиянию</div>
          {candidates.map((t) => {
            const badge = mergeBadge(t, queueItemOf(t.id));
            const order = selection.indexOf(t.id);
            return (
              <label key={t.id} className="mq-row">
                <input
                  type="checkbox"
                  checked={order >= 0}
                  onChange={() => toggle(t.id)}
                />
                {order >= 0 && <span className="mq-order">{order + 1}</span>}
                <span className="mono muted">{t.id}</span>
                <span className="mq-title">{t.title}</span>
                <span className="muted small">{roleTitle(t.roleId)}</span>
                <span className="mono small muted">{t.branch}</span>
                {badge && (
                  <span
                    className={`chip merge-chip ${badge.cls}`}
                    title={t.mergeability?.state === 'conflict' ? t.mergeability.conflicts.join(', ') : undefined}
                  >
                    {badge.label}
                  </span>
                )}
                <button type="button" className="mini" onClick={(e) => { e.preventDefault(); showDiff(t.id); }}>
                  diff
                </button>
              </label>
            );
          })}
        </div>
      )}

      {selection.length > 0 && (
        <div className="mq-order-list">
          <div className="mq-head muted small">
            Порядок слияния
            <button type="button" className="link-danger" onClick={clear}>очистить</button>
          </div>
          {selection.map((taskId, i) => {
            const t = tasks[taskId];
            if (!t) return null;
            return (
              <div key={taskId} className="mq-order-row">
                <span className="mq-order">{i + 1}</span>
                <span className="mq-title">{t.title}</span>
                <span className="mono small muted">{t.id}</span>
                <div className="mq-arrows">
                  <button type="button" className="sq" disabled={i === 0} onClick={() => move(taskId, -1)}>↑</button>
                  <button type="button" className="sq" disabled={i === selection.length - 1} onClick={() => move(taskId, 1)}>↓</button>
                  <button type="button" className="sq" onClick={() => toggle(taskId)}>✕</button>
                </div>
              </div>
            );
          })}

          <div className="mq-actions">
            {queue?.running ? (
              <button type="button" className="stop" onClick={stopMergeQueue}>Остановить очередь</button>
            ) : (
              <button type="button" className="primary" onClick={() => startMergeQueue(selection)}>
                Слить по очереди ({selection.length})
              </button>
            )}
          </div>
        </div>
      )}

      {queue && (
        <div className="mq-progress">
          <div className="mq-head muted small">
            {queue.running ? 'Слияние идёт…' : 'Последний прогон очереди'}
          </div>
          {stopper && (
            <div className="mq-stopped">
              Очередь остановилась на <b>{tasks[stopper.taskId]?.title ?? stopper.taskId}</b> — {mergeItemReason(stopper)}
            </div>
          )}
          {queue.items.map((item) => {
            const t = tasks[item.taskId];
            const tc = typechecks[item.taskId];
            return (
              <div key={item.taskId} className={`mq-item ${item.state}`}>
                <div className="mq-item-row">
                  <span className="mono muted">{item.taskId}</span>
                  <span className="mq-title">{t?.title ?? item.taskId}</span>
                  <span className={`chip merge-chip ${item.state === 'failed' ? 'conflict' : item.state === 'done' ? 'merged' : 'checking'}`}>
                    {QUEUE_STATE_LABEL[item.state]}
                  </span>
                </div>
                {item.state === 'failed' && (
                  <div className="mq-reason">{mergeItemReason(item)}</div>
                )}
                {tc && (
                  <div className={`mq-typecheck ${tc.ok ? 'ok' : 'bad'}`}>
                    <b>{tc.ok ? 'typecheck: успешно' : 'typecheck: ошибка'}</b>
                    {!tc.ok && <pre>{tc.output}</pre>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

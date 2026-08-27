import { useEffect } from 'react';
import {
  mergeBadge, mergeCheck, mergeStepClass, mergeStepFor, mergeStepLabel,
  showDiff, startMergeQueue, useStore,
} from './store';
import type { TaskView } from '../shared/types';
import { t } from './i18n';

/**
 * Ручное слияние — аварийный путь. В обычном порядке ветки вливает конвейер
 * ревью (см. PrPipeline): сюда лезут, когда он встал и надо разобраться руками.
 */
function candidatesOf(tasks: Record<string, TaskView>): TaskView[] {
  return Object.values(tasks)
    .filter((t) => t.status === 'done' && t.branch && !t.merged)
    .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
}

export function MergeQueue() {
  const tasks = useStore((s) => s.tasks);
  const roles = useStore((s) => s.roles);
  const selection = useStore((s) => s.mergeSelection);
  const toggle = useStore((s) => s.toggleMergeSelect);
  const move = useStore((s) => s.moveMergeSelect);
  const clear = useStore((s) => s.clearMergeSelection);
  const checks = useStore((s) => s.mergeChecks);
  const checking = useStore((s) => s.mergeChecking);
  const run = useStore((s) => s.mergeRun);

  const candidates = candidatesOf(tasks);
  const candidateIds = candidates.map((t) => t.id).join(',');

  // Открыли панель или появилась новая готовая задача — пересчитываем статусы.
  // Сервер сам решает, какие задачи мержабельны, — список ему не передаём.
  useEffect(() => {
    if (candidateIds) mergeCheck();
  }, [candidateIds]);

  const roleTitle = (roleId: string | null) =>
    roles.find((r) => r.id === roleId)?.title ?? roleId ?? t('common.none');

  return (
    <div className="merge-queue">
      {candidates.length === 0 && (
        <p className="empty">{t('mq.empty')}</p>
      )}

      {candidates.length > 0 && (
        <div className="mq-candidates">
          <div className="mq-head muted small">
            {t('mq.manual')}
            {checking && <span className="muted small">{t('mq.checking')}</span>}
          </div>
          {candidates.map((t) => {
            const check = checks[t.id];
            const step = mergeStepFor(run, t.id);
            const badge = mergeBadge(t, step, check);
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
                    title={check?.state === 'conflict' ? check.conflicts.join(', ') : undefined}
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
            {t('mq.order')}
            <button type="button" className="link-danger" onClick={clear}>{t('mq.clear')}</button>
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
            {run?.running ? (
              <span className="muted small">{t('mq.running')}</span>
            ) : (
              <button type="button" className="primary" onClick={() => startMergeQueue(selection)}>
                {t('mq.start', { n: selection.length })}
              </button>
            )}
          </div>
        </div>
      )}

      {run && (
        <div className="mq-progress">
          <div className="mq-head muted small">
            {t(run.running ? 'mq.inProgress' : 'mq.lastRun')}
          </div>
          {!run.running && (
            <div className={`mq-stopped ${run.steps.some((s) => s.status === 'conflict' || s.status === 'typecheck-failed' || s.status === 'failed') ? 'bad' : 'ok'}`}>
              {run.summary}
            </div>
          )}
          {run.steps.map((step) => (
            <div key={step.taskId} className={`mq-item ${step.status}`}>
              <div className="mq-item-row">
                <span className="mono muted">{step.taskId}</span>
                <span className="mq-title">{step.title}</span>
                <span className={`chip merge-chip ${mergeStepClass(step.status)}`}>
                  {mergeStepLabel(step.status)}
                </span>
              </div>
              {step.status !== 'pending' && (
                <div className="mq-reason">{step.message}</div>
              )}
              {step.typecheck && (
                <div className={`mq-typecheck ${step.typecheck.ok ? 'ok' : 'bad'}`}>
                  <b>
                    {step.typecheck.skipped
                      ? step.typecheck.message
                      : t(step.typecheck.ok ? 'mq.typecheckOk' : 'mq.typecheckFailed')}
                  </b>
                  {!step.typecheck.ok && !step.typecheck.skipped && <pre>{step.typecheck.output}</pre>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

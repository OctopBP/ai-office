import {
  mergeBadge, mergeStepFor, mergeTask, prStageLabel, prStageClass, retryPipeline,
  retryTask, showDiff, stopTask, useStore,
} from './store';
import type { TaskView } from '../shared/types';
import { taskClosed } from '../shared/types';
import { locale, t } from './i18n';
import { Hint, Tooltip } from './Tooltip';
import { HOTKEY } from './hotkeys';
import { AgentTag } from './Avatar';

/**
 * Раскрытая карточка задачи.
 *
 * Появилась вместе с планом, и не от красоты: карточка на доске несла всё
 * сразу — описание, критерии, отчёт, файлы, ветку и кнопки, — и три десятка
 * плановых задач превращали доску в стену текста, по которой невозможно
 * понять, где что стоит. Поэтому подробности переехали сюда, а на доске
 * осталось ровно то, что нужно, чтобы найти задачу глазами.
 *
 * Дровер, а не модалка: доска сама живёт оверлеем, и карточка обязана
 * открываться ПОВЕРХ неё, не закрывая колонок, — иначе, разобравшись с одной
 * задачей, приходилось бы заново искать место, где стоял взгляд.
 */

const money = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
const tokens = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v));

function elapsed(from: number | null, to: number | null): string {
  if (!from) return '';
  const ms = (to ?? Date.now()) - from;
  const min = Math.floor(ms / 60000);
  if (min < 1) return t('drawer.seconds', { s: Math.max(1, Math.round(ms / 1000)) });
  if (min < 60) return t('drawer.minutes', { m: min });
  return t('drawer.hours', { h: Math.floor(min / 60), m: min % 60 });
}

/** Строка связанной задачи: id, название и её нынешний статус. */
function Linked({ task, onOpen }: { task: TaskView; onOpen: (id: string) => void }) {
  return (
    <button className={`row link-row ${task.status}`} onClick={() => onOpen(task.id)}>
      <span className="mono dim">{task.id}</span>
      <span className="row-title">{task.title}</span>
      <span className="muted small">{t(`task.status.${task.status}`)}</span>
    </button>
  );
}

export function TaskDrawer() {
  const openTask = useStore((s) => s.openTask);
  const openTaskCard = useStore((s) => s.openTaskCard);
  const tasks = useStore((s) => s.tasks);
  const epics = useStore((s) => s.epics);
  const roles = useStore((s) => s.roles);
  const prs = useStore((s) => s.prs);
  const runs = useStore((s) => s.runs);
  const run = useStore((s) => s.mergeRun);
  const checks = useStore((s) => s.mergeChecks);
  const autoPipeline = useStore((s) => s.settings.autoPipeline);

  const task = openTask ? tasks[openTask] : null;
  // Задачу могли закрыть, слить и убрать, пока карточка была открыта, —
  // держать пустой дровер не за что.
  if (!task) return null;

  const epic = task.epicId ? epics[task.epicId] : null;
  const role = roles.find((r) => r.id === task.roleId);
  const pr = prs[task.id];
  const process = runs[task.id];
  const check = checks[task.id];
  const badge = mergeBadge(task, mergeStepFor(run, task.id), check);
  // Пока конвейер ведёт задачу, ручное слияние вырвало бы ветку у ревьюера.
  const pipelineRunning = Boolean(pr) && pr.stage !== 'stuck' && pr.stage !== 'merged';

  const waits = task.dependsOn.map((id) => tasks[id]).filter(Boolean)
    .filter((dep) => !taskClosed(dep, autoPipeline));
  const blocks = Object.values(tasks).filter((other) => other.dependsOn.includes(task.id));
  const done = task.criteria.filter((c) => c.done).length;

  return (
    <div className="drawer task-drawer">
      <div className="drawer-head">
        <div className="drawer-who">
          <h2><span className="mono dim">{task.id}</span> {task.title}</h2>
          <div className="task-meta">
            <span className={`chip ${task.status}`}>{t(`task.status.${task.status}`)}</span>
            {pr && pr.stage !== 'merged' && (
              <span className={`chip merge-chip ${prStageClass(pr.stage)}`}>
                {prStageLabel(pr.stage)}
              </span>
            )}
            {badge && <span className={`chip merge-chip ${badge.cls}`}>{badge.label}</span>}
            {task.outcome && (
              <span className={`chip outcome-chip ${task.outcome.kind}`} title={t('outcome.hint')}>
                {t(`outcome.${task.outcome.kind}`)}
              </span>
            )}
            {epic && (
              <span className="chip epic-chip" title={epic.goal}>{epic.id} · {epic.title}</span>
            )}
          </div>
        </div>
        <Tooltip tip={<Hint label={t('panel.close')} keys={HOTKEY.close} />}>
          <button className="sq ghost" onClick={() => openTaskCard(null)}>✕</button>
        </Tooltip>
      </div>

      <section>
        <h3 className="section-title">{t('taskCard.about')}</h3>
        <div className="kv">
          <span className="muted">{t('taskCard.role')}</span>
          <span>{role?.title ?? task.roleId ?? t('common.none')}</span>
          <span className="muted">{t('taskCard.assignee')}</span>
          <span>{task.assigneeId ? <AgentTag id={task.assigneeId} size="sm" /> : t('common.none')}</span>
          {task.startedAt && (
            <>
              <span className="muted">{t('taskCard.spentTime')}</span>
              <span>{elapsed(task.startedAt, task.finishedAt)}</span>
            </>
          )}
          <span className="muted">{t('taskCard.money')}</span>
          <span>
            {money(task.usage.costUsd)}
            {' · '}{tokens(task.usage.tokensIn + task.usage.tokensOut)} tok
          </span>
          <span className="muted">{t('taskCard.created')}</span>
          <span>{new Date(task.createdAt).toLocaleString(locale())}</span>
        </div>
      </section>

      {task.description && (
        <section>
          <h3 className="section-title">{t('taskCard.brief')}</h3>
          {/* ТЗ показываем как есть: исполнитель видел ровно этот текст, и
              подрезанный он перестал бы отвечать на «почему сделано так». */}
          <div className="task-brief">{task.description}</div>
        </section>
      )}

      {task.criteria.length > 0 && (
        <section>
          <h3 className="section-title">{t('drawer.criteria', { done, total: task.criteria.length })}</h3>
          <div className="criteria">
            {task.criteria.map((c, i) => (
              <div key={i} className={`criterion ${c.done ? 'done' : ''}`}>
                <span className="mark">{c.done ? '✓' : '·'}</span>{c.text}
              </div>
            ))}
          </div>
        </section>
      )}

      {(waits.length > 0 || blocks.length > 0) && (
        <section>
          <h3 className="section-title">{t('taskCard.links')}</h3>
          {waits.length > 0 && (
            <>
              <p className="muted small">{t('taskCard.waitsFor')}</p>
              {waits.map((dep) => <Linked key={dep.id} task={dep} onOpen={openTaskCard} />)}
            </>
          )}
          {blocks.length > 0 && (
            <>
              <p className="muted small">{t('taskCard.blocks')}</p>
              {blocks.map((dep) => <Linked key={dep.id} task={dep} onOpen={openTaskCard} />)}
            </>
          )}
        </section>
      )}

      {(task.result || pr) && (
        <section>
          <h3 className="section-title">{t('taskCard.outcome')}</h3>
          {task.result && <div className="task-result">{task.result}</div>}
          {pr && (
            <p className="muted small">
              {prStageLabel(pr.stage)}{pr.note ? ` — ${pr.note}` : ''}
              {pr.url && <> · <a href={pr.url} target="_blank" rel="noreferrer">{pr.url}</a></>}
            </p>
          )}
          {(task.status === 'failed' || task.status === 'blocked') && (
            <p className="muted small">
              {t(task.interrupted ? 'board.interrupted' : 'board.toldManager')}
            </p>
          )}
        </section>
      )}

      {pr?.gate && (
        <section>
          <h3 className="section-title">{t('taskCard.gate')}</h3>
          <div className={`gate-report ${pr.gate.ok ? 'ok' : 'bad'}`}>
            <p className="gate-message">{pr.gate.message}</p>
            {pr.gate.checks.length > 0 && (
              <div className="gate-checks">
                {pr.gate.checks.map((c) => (
                  <span key={c.command} className={`chip gate-chip ${c.ok ? 'ok' : 'bad'}`}>
                    {c.ok ? '✓' : '✗'} {c.command}
                  </span>
                ))}
              </div>
            )}
            {pr.gate.failed && (
              <details className="gate-failed">
                <summary>{t('taskCard.gateOutput')}</summary>
                {pr.gate.failed.files.length > 0 && (
                  <p className="mono small muted">{pr.gate.failed.files.join(', ')}</p>
                )}
                <pre>{pr.gate.failed.output}</pre>
              </details>
            )}
            {pr.gate.overlaps.length > 0 && (
              <div className="gate-overlaps">
                <p className="muted small">{t('taskCard.gateOverlaps')}</p>
                <ul>
                  {pr.gate.overlaps.map((o) => (
                    <li key={o.file} className="mono small">
                      {o.file}{o.symbols.length > 0 ? ` (${o.symbols.join(', ')})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {task.files.length > 0 && (
        <section>
          <h3 className="section-title">{t('taskCard.files')}</h3>
          <div className="task-files mono">{task.files.join('  ·  ')}</div>
        </section>
      )}

      {task.handoff && (
        <section>
          <h3 className="section-title">{t('taskCard.handoff')}</h3>
          <div className="task-handoff">
            <div><b>{t('taskCard.assumed')}:</b> {task.handoff.assumed}</div>
            <div><b>{t('taskCard.left')}:</b> {task.handoff.left}</div>
          </div>
        </section>
      )}

      {process && (
        <section>
          <h3 className="section-title">{t('taskCard.process')}</h3>
          <div className="task-process">
            <span className="mono">{process.workflowId}</span>
            {' · '}
            <span className="mono">{process.nodeId}</span>
            {' · '}
            <span className={`chip ${process.status}`}>{t(`run.status.${process.status}`)}</span>
            {process.note && <div className="muted">{process.note}</div>}
          </div>
        </section>
      )}

      {task.branch && (
        <section>
          <h3 className="section-title">{t('taskCard.branch')}</h3>
          <div className="task-branch">
            <span className="mono">{task.branch}</span>
            {task.merged && <span className="merged">{t('merge.merged')}</span>}
          </div>
        </section>
      )}

      <div className="drawer-actions">
        {task.status === 'in_progress' && (
          <button className="stop" onClick={() => stopTask(task.id)}>{t('board.stop')}</button>
        )}
        {(task.status === 'failed' || task.status === 'blocked') && (
          <button className="retry" onClick={() => retryTask(task.id)}>{t('board.restart')}</button>
        )}
        {pr?.stage === 'stuck' && (
          <button className="retry" onClick={() => retryPipeline(task.id)}>
            {t('board.continueReview')}
          </button>
        )}
        {task.branch && !task.merged && (
          <button onClick={() => showDiff(task.id)}>{t('board.showDiff')}</button>
        )}
        {task.branch && !task.merged && !pipelineRunning
          && (task.status === 'done' || pr?.stage === 'stuck') && (
          <button className="merge" onClick={() => mergeTask(task.id)}>{t('board.merge')}</button>
        )}
      </div>
    </div>
  );
}

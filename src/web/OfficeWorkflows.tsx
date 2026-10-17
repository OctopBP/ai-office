import { useId, useState } from 'react';
import { disableWorkflowNode, enableWorkflowNode, resetWorkflowEdits, setWorkflowProblem, useStore } from './store';
import type { WorkflowEntry } from '../shared/workflow';
import type { SkipWhen } from '../shared/workflow-overrides';
import { formatFullDateTime } from './dates';
import { Icon } from './icons';
import { t } from './i18n';
import { failureText, hasEdits, nodeViews, toggleAction, type NodeView } from './workflowEdits';

/** Условие пропуска одной строкой: «роли: backend; типы: code». */
function whenLabel(when: SkipWhen | undefined): string {
  if (!when) return '';
  return [
    when.roles?.length ? t('wfx.when.roles', { list: when.roles.join(', ') }) : '',
    when.types?.length ? t('wfx.when.types', { list: when.types.join(', ') }) : '',
    when.zones?.length ? t('wfx.when.zones', { list: when.zones.join(', ') }) : '',
  ].filter(Boolean).join('; ');
}

const byLabel = (by: string): string => (by === 'owner' ? t('wfx.by.owner') : by === 'manager' ? t('wfx.by.manager') : by);

function NodeRow({ entry, view, why }: {
  entry: WorkflowEntry; view: NodeView; why: string;
}) {
  const { node, mode } = view;
  const on = mode === 'on' || mode === 'required';
  // «Обязательный» — замок; остальные причины — подпись с вопросом, не с замком.
  const note = view.failure ? failureText(view.failure) : '';
  const lockText = view.locked === 'required' ? t('wfx.node.required.hint') : note;
  const flip = () => {
    const act = toggleAction(entry, view);
    if ('problem' in act) { setWorkflowProblem(entry.id, t('wfx.rejected', { node: node.id, problem: act.problem })); return; }
    if (act.action === 'enable') enableWorkflowNode(entry.id, node.id, why);
    else disableWorkflowNode(entry.id, node.id, why);
  };
  return (
    <li className={`wfx-node ${mode}`}>
      <span className="wfx-node-name">
        <b className="mono">{node.id}</b>
        <span className="muted small">{t(`flows.kind.${node.kind}`)}</span>
      </span>
      <span className="wfx-node-state">
        {mode === 'required' && (
          <span className="chip wfx-chip required" title={lockText}>
            <Icon name="lock" size={12} /> {t('wfx.node.required')}
          </span>
        )}
        {mode === 'off' && <span className="chip wfx-chip off">{t('wfx.node.off')}</span>}
        {mode === 'conditional' && (
          <span className="chip wfx-chip conditional" title={whenLabel(view.when)}>
            {t('wfx.node.conditional', { when: whenLabel(view.when) })}
          </span>
        )}
      </span>
      {note && view.locked !== 'required' && (
        <span className="wfx-node-note small"><Icon name="help" size={12} /> {note}</span>
      )}
      <label className="wfx-switch" title={lockText || undefined}>
        <input
          type="checkbox" role="switch" checked={on} disabled={view.locked !== null}
          aria-label={t('wfx.node.toggle', { node: node.id })}
          onChange={flip}
        />
        <span className="wfx-switch-text">{on ? t('wfx.node.enabled') : t('wfx.node.disabled')}</span>
      </label>
    </li>
  );
}

function ProcessCard({ entry, why }: { entry: WorkflowEntry; why: string }) {
  const problem = useStore((s) => s.workflowProblems[entry.id]);
  const views = nodeViews(entry);
  const history = [...(entry.officeEdits?.history ?? [])].reverse();
  return (
    <section className="wfx-card">
      <header className="wfx-head">
        <b>{entry.id}</b>
        <span className="muted small">{t('wfx.nodes', { n: entry.workflow.nodes.length })}</span>
        <button className="mini wfx-reset" disabled={!hasEdits(entry)}
          onClick={() => resetWorkflowEdits(entry.id, why)}>
          {t('wfx.reset')}
        </button>
      </header>
      <ol className="wfx-nodes">
        {views.map((v) => <NodeRow key={v.node.id} entry={entry} view={v} why={why} />)}
      </ol>
      {problem && (
        <div className="flows-problem" role="alert">
          <span>{problem}</span>
          <button className="mini" onClick={() => setWorkflowProblem(entry.id, null)}>{t('common.close')}</button>
        </div>
      )}
      <div className="wfx-history">
        <h4 className="wfx-history-title">{t('wfx.history')}</h4>
        {history.length === 0 && <p className="muted small">{t('wfx.history.empty')}</p>}
        <ul>
          {history.map((h) => (
            <li key={`${h.at}-${h.action}-${h.node ?? ''}`}>
              <span className="muted small mono">{formatFullDateTime(h.at)}</span>{' '}
              <span>{t(`wfx.action.${h.action}`, { node: h.node ?? '' })}</span>{' '}
              {h.when && <span className="small">({t('wfx.only', { when: whenLabel(h.when) })})</span>}{' '}
              <span className="muted small">· {byLabel(h.by)} · {t('wfx.why', { why: h.why })}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * Раздел настроек «Процессы»: узлы процессов с правками офиса. Данные идут из
 * стора (событие `workflows`), поэтому правки менеджера видны без перезагрузки.
 */
export function OfficeWorkflows() {
  const workflows = useStore((s) => s.workflows);
  const [reason, setReason] = useState('');
  const fid = useId();
  const why = reason.trim() || t('wfx.why.default');
  if (!workflows.length) return <p className="muted">{t('flows.empty')}</p>;
  return (
    <div className="wfx">
      <div className="form-row">
        <div className="form-row-label"><label htmlFor={`${fid}-why`}>{t('wfx.reason')}</label></div>
        <div className="form-row-control">
          <input id={`${fid}-why`} type="text" value={reason} placeholder={t('wfx.why.default')}
            onChange={(e) => setReason(e.target.value)} />
          <span className="form-hint">{t('wfx.reason.hint')}</span>
        </div>
      </div>
      {workflows.map((w) => <ProcessCard key={w.id} entry={w} why={why} />)}
    </div>
  );
}

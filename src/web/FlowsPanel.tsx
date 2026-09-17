import { useMemo, useState } from 'react';
import { resetWorkflow, saveWorkflow, updateSettings, useStore } from './store';
import {
  parseWorkflow, workflowStats, END, TASK_TYPES,
  type Run, type Workflow, type WorkflowEntry,
} from '../shared/workflow';
import { FlowGraph, FlowLegend } from './FlowGraph';
import { Panel } from './Panel';
import { t } from './i18n';
import { HOTKEY } from './hotkeys';

type Tab = 'board' | 'processes' | 'checks' | 'stats';

/**
 * Панель «Процессы» (docs/design/workflows/spec.md §8.5, §10): доска прогонов
 * по узлам, сами процессы с правкой пределов и текста, свои проверки
 * проекта и расход по узлам. Правка ложится файлом в `workflows/` проекта —
 * текст первичен, панель лишь показывает и проверяет его.
 */
export function FlowsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('board');
  const tabs = (
    <div className="seg panel-tabs">
      {(['board', 'processes', 'checks', 'stats'] as Tab[]).map((k) => (
        <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(`flows.tab.${k}`)}</button>
      ))}
    </div>
  );
  return (
    <Panel title={t('flows.title')} tabs={tabs} wide size="board" fixed hotkey={HOTKEY.flows} onClose={onClose}>
      <div className="life flows">
        {tab === 'board' && <BoardTab />}
        {tab === 'processes' && <ProcessesTab />}
        {tab === 'checks' && <ChecksTab />}
        {tab === 'stats' && <StatsTab />}
      </div>
    </Panel>
  );
}

/** Доска прогонов: граф процесса, на узлах — задачи, которые сейчас там стоят. */
function BoardTab() {
  const workflows = useStore((s) => s.workflows);
  const runs = useStore((s) => s.runs);
  const tasks = useStore((s) => s.tasks);
  const live = Object.values(runs).filter((r) => r.subject.taskId);
  if (!live.length) return <p className="empty">{t('flows.board.empty')}</p>;
  const byFlow = new Map<string, Run[]>();
  for (const r of live) byFlow.set(r.workflowId, [...(byFlow.get(r.workflowId) ?? []), r]);
  const title = (taskId: string) => tasks[taskId]?.title ?? '';
  return (
    <div className="life-list">
      {[...byFlow.entries()].map(([id, list]) => {
        const entry = workflows.find((w) => w.id === id);
        return (
          <div key={id} className="life-row">
            <div className="life-row-head">
              <b>{id}</b>
              <span className="muted small">{t('flows.board.count', { n: list.length })}</span>
              {(['running', 'waiting', 'stuck', 'done'] as const).map((st) => {
                const n = list.filter((r) => r.status === st).length;
                return n ? <span key={st} className={`chip ${st}`}>{t(`run.status.${st}`)} {n}</span> : null;
              })}
            </div>
            {entry
              ? <FlowGraph workflow={entry.workflow} runs={list} taskTitle={title} />
              : <p className="muted small">{t('flows.board.unknown')}</p>}
          </div>
        );
      })}
      <FlowLegend />
    </div>
  );
}

/** Список процессов и правка выбранного: пределы петель — полем в карточке узла, остальное — текстом. */
function ProcessesTab() {
  const workflows = useStore((s) => s.workflows);
  const [selected, setSelected] = useState<string | null>(null);
  const entry = workflows.find((w) => w.id === selected) ?? workflows[0] ?? null;
  if (!entry) return <p className="empty">{t('flows.empty')}</p>;
  return (
    <div className="life-list">
      <div className="flows-pick">
        {workflows.map((w) => (
          <button key={w.id} className={`mini${w.id === entry.id ? ' on' : ''}${w.problem ? ' danger' : ''}`}
            onClick={() => setSelected(w.id)}>
            {w.id}{w.source === 'project' ? ' ·' : ''}
          </button>
        ))}
      </div>
      <Editor key={entry.id + entry.text} entry={entry} />
    </div>
  );
}

function Editor({ entry }: { entry: WorkflowEntry }) {
  const [text, setText] = useState(entry.text);
  const [raw, setRaw] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const parsed = useMemo<{ workflow: Workflow | null; problem: string | null }>(() => {
    try {
      return { workflow: parseWorkflow(JSON.parse(text), `${entry.id}.json`), problem: null };
    } catch (err) {
      return { workflow: null, problem: (err as Error).message };
    }
  }, [text, entry.id]);
  const workflow = parsed.workflow ?? entry.workflow;
  const dirty = text !== entry.text;

  const setMax = (node: string, outcome: string, max: number) => {
    try {
      const data = JSON.parse(text) as { nodes: Array<{ id: string; next: Record<string, unknown> }> };
      const n = data.nodes.find((x) => x.id === node);
      if (!n) return;
      const tr = n.next[outcome];
      n.next[outcome] = typeof tr === 'string' ? { to: tr, max } : { ...(tr as object), max };
      setText(`${JSON.stringify(data, null, 2)}\n`);
    } catch { /* сломанный текст правят руками */ }
  };

  const node = workflow.nodes.find((n) => n.id === picked) ?? null;

  return (
    <div className="life-row">
      <div className="life-row-head">
        <b>{entry.id}</b>
        <span className={`chip ${entry.source}`}>{t(`flows.source.${entry.source}`)}</span>
        {entry.overrides && <span className="muted small">{t('flows.overrides')}</span>}
        <span className="muted small">{t('flows.trigger', { on: workflow.trigger.on })}</span>
        <span className="muted small">v{workflow.version}</span>
      </div>
      {entry.problem && <div className="flows-problem">{t('flows.problem', { problem: entry.problem })}</div>}

      <FlowGraph workflow={workflow} selected={picked} onSelect={(id) => setPicked(id === picked ? null : id)} />
      <FlowLegend />
      {node ? (
        <dl className="flow-inspect">
          <dt>{t('flows.node')}</dt>
          <dd><b className="mono">{node.id}</b> · {t(`flows.kind.${node.kind}`)} <span className="muted">· {t(`flows.kind.hint.${node.kind}`)}</span></dd>
          {node.run && <><dt>{t('flows.node.run')}</dt><dd className="mono">{node.run}</dd></>}
          {node.needs && node.needs.length > 0 && <><dt>{t('flows.node.needs')}</dt><dd className="mono">{node.needs.join(', ')}</dd></>}
          {node.same && <><dt>{t('flows.node.same')}</dt><dd className="mono">{node.same}</dd></>}
          {node.notSameAs && <><dt>{t('flows.node.notSameAs')}</dt><dd className="mono">{node.notSameAs}</dd></>}
          {node.in && node.in.length > 0 && <><dt>{t('flows.node.in')}</dt><dd className="mono">{node.in.join(', ')}</dd></>}
          {node.out && <><dt>{t('flows.node.out')}</dt><dd className="mono">{node.out}</dd></>}
          {node.done && node.done.length > 0 && (
            <><dt>{t('flows.node.done')}</dt><dd><ul>{node.done.map((d) => <li key={d}>{d}</li>)}</ul></dd></>
          )}
          {node.limits && (
            <><dt>{t('flows.node.limits')}</dt>
              <dd className="mono">{Object.entries(node.limits).map(([k, v]) => `${k} ${v}`).join(', ')}</dd></>
          )}
          {node.stage && <><dt>{t('flows.node.stage')}</dt><dd className="mono">{node.stage}</dd></>}
          <dt>{t('flows.next')}</dt>
          <dd>
            {Object.entries(node.next).map(([o, tr]) => (
              <div key={o} className={`flow-next${tr.to === 'stuck' ? ' stuck' : ''}`}>
                <span className="mono">{o}</span>
                <span className="muted">→</span>
                <span className="mono">{tr.to === END ? t('flows.board.done') : tr.to === 'stuck' ? t('run.status.stuck') : tr.to}</span>
                {tr.max !== undefined && (
                  <label className="flow-max">
                    <span className="muted">{t('flows.node.maxBefore')}</span>
                    <input type="number" min={1} max={20} value={tr.max}
                      onChange={(ev) => setMax(node.id, o, Math.max(1, Math.min(20, Number(ev.target.value) || 1)))} />
                    <span className="muted">{t('flows.node.maxAfter')}</span>
                  </label>
                )}
              </div>
            ))}
          </dd>
        </dl>
      ) : <p className="muted small">{t('flows.node.pick')}</p>}

      <div className="life-actions">
        <button className="mini" onClick={() => setRaw(!raw)}>{t('flows.json')}</button>
        <button className="mini" disabled={!dirty || Boolean(parsed.problem)} onClick={() => saveWorkflow(entry.id, text)}>
          {t('flows.save')}
        </button>
        {entry.source === 'project' && (
          <button className="mini" onClick={() => resetWorkflow(entry.id)}>{t('flows.reset')}</button>
        )}
        {parsed.problem && dirty && <span className="flows-problem">{parsed.problem}</span>}
      </div>
      {raw && (
        <textarea className="flows-json mono" value={text} rows={18} spellCheck={false}
          onChange={(e) => setText(e.target.value)} />
      )}
    </div>
  );
}

/** Свои проверки проекта и то, какой процесс за каким типом задачи. */
function ChecksTab() {
  const settings = useStore((s) => s.settings);
  const workflows = useStore((s) => s.workflows);
  const [checks, setChecks] = useState<Array<{ name: string; command: string }>>(
    () => Object.entries(settings.checks ?? {}).map(([name, command]) => ({ name, command })),
  );
  const [map, setMap] = useState<Record<string, string>>(() => ({ ...(settings.workflows ?? {}) }));
  const ids = workflows.map((w) => w.id);
  const save = () => {
    const clean: Record<string, string> = {};
    for (const c of checks) if (c.name.trim() && c.command.trim()) clean[c.name.trim()] = c.command.trim();
    updateSettings({ checks: clean, workflows: map });
  };
  return (
    <div className="life-list">
      <div className="life-row">
        <div className="life-row-head"><b>{t('flows.checks.title')}</b></div>
        <p className="muted small">{t('flows.checks.hint')}</p>
        {checks.map((c, i) => (
          <div key={i} className="life-actions">
            <input value={c.name} placeholder={t('flows.checks.name')}
              onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input value={c.command} placeholder={t('flows.checks.command')} className="mono"
              onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)))} />
            <button className="mini" onClick={() => setChecks(checks.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <div className="life-actions">
          <button className="mini" onClick={() => setChecks([...checks, { name: '', command: '' }])}>{t('flows.checks.add')}</button>
        </div>
      </div>
      <div className="life-row">
        <div className="life-row-head"><b>{t('flows.map.title')}</b></div>
        <p className="muted small">{t('flows.map.hint')}</p>
        {TASK_TYPES.map((type) => (
          <label key={type} className="flows-limit">
            <span className="mono">{type}</span>
            <select value={map[type] ?? (type === 'code' ? 'feature' : type)}
              onChange={(e) => setMap({ ...map, [type]: e.target.value })}>
              {ids.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="life-actions">
        <button className="mini" onClick={save}>{t('flows.checks.save')}</button>
      </div>
    </div>
  );
}

/** Расход по узлам: что стоит каждый узел, сколько идёт, чем кончается. */
function StatsTab() {
  const runs = useStore((s) => s.runs);
  const stats = useMemo(() => workflowStats(Object.values(runs)), [runs]);
  if (!stats.length) return <p className="empty">{t('flows.stats.empty')}</p>;
  return (
    <div className="life-list">
      {stats.map((s) => (
        <div key={`${s.workflowId}@${s.version}`} className="life-row">
          <div className="life-row-head">
            <b>{s.workflowId}</b><span className="muted small">v{s.version}</span>
            <span className="muted small">{t('flows.stats.runs', { n: s.runs, done: s.done, stuck: s.stuck })}</span>
            <span className="muted small">${s.costUsd.toFixed(2)}</span>
          </div>
          <table className="flows-nodes">
            <thead><tr><th>{t('flows.node')}</th><th>{t('flows.stats.count')}</th><th>{t('flows.stats.avgMs')}</th><th>{t('flows.stats.avgCost')}</th><th>{t('flows.stats.outcomes')}</th></tr></thead>
            <tbody>
              {s.nodes.map((n) => (
                <tr key={n.node}>
                  <td className="mono">{n.node}</td>
                  <td>{n.runs}</td>
                  <td>{n.avgMs >= 60_000 ? `${Math.round(n.avgMs / 60_000)} мин` : `${Math.round(n.avgMs / 1000)} с`}</td>
                  <td>${n.avgCostUsd.toFixed(3)}</td>
                  <td className="mono muted">{Object.entries(n.outcomes).map(([o, c]) => `${o} ${c}`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

import { useState } from 'react';
import {
  accessLabel, permissionSourceLabel, assignDirect, effectivePermissionMode, fire, hire,
  mergeTask, openLayoutSettings, permissionSource, requestTeamRole, retryTask, setAgentPermission,
  showDiff, stopTask, useStore, fullAccessWarning,
} from './store';
import { locale, t, t as tr } from './i18n';
import { useActionNotice } from './useActionNotice';
import { AgentAvatar } from './office3d/AgentAvatar';
import { usageLine } from './UsageModal';
import { Icon, type IconName } from './icons';
import type { Criterion, PermissionMode, TaskView } from '../shared/types';

const money = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
const tokens = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v));
const progress = (list: Criterion[]) => ({ done: list.filter((c) => c.done).length, total: list.length });

/** Тот же порядок и подписи, что и в настройке роли. */
const PERM_OPTIONS: PermissionMode[] = ['readonly', 'ask-writes', 'ask-risky', 'auto'];

/** Критерии готовности с отметками — то же представление, что и на доске. */
function Criteria({ list }: { list: Criterion[] }) {
  if (list.length === 0) return null;
  const { done, total } = progress(list);
  return (
    <div className="criteria">
      <div className="criteria-head">{t('drawer.criteria', { done, total })}</div>
      {list.map((c, i) => (
        <div key={i} className={`criterion ${c.done ? 'done' : ''}`}>
          <span className="mark">{c.done ? '✓' : '·'}</span>{c.text}
        </div>
      ))}
    </div>
  );
}

function elapsed(from: number | null, to: number | null): string {
  if (!from) return '';
  const ms = (to ?? Date.now()) - from;
  const min = Math.floor(ms / 60000);
  if (min < 1) return t('drawer.seconds', { s: Math.max(1, Math.round(ms / 1000)) });
  if (min < 60) return t('drawer.minutes', { m: min });
  return t('drawer.hours', { h: Math.floor(min / 60), m: min % 60 });
}

const statusLabel = (status: TaskView['status']): string => t(`task.status.${status}`);

const TOOL_ICON: Record<string, IconName> = {
  Bash: 'terminal-2', Read: 'book', Edit: 'pencil', Write: 'file-text', Grep: 'search', Glob: 'search',
  WebSearch: 'world', WebFetch: 'world', TodoWrite: 'list-check',
};

export function AgentDrawer() {
  const selected = useStore((s) => s.selected);
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  const tasksMap = useStore((s) => s.tasks);
  const log = useStore((s) => s.log);
  const settings = useStore((s) => s.settings);
  const select = useStore((s) => s.select);
  const setThread = useStore((s) => s.setThread);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const { notice, markPending, clear } = useActionNotice();

  const inst = selected ? instances[selected] : null;
  if (!inst) return null;
  const role = roles.find((r) => r.id === inst.roleId);

  const roleFallbackLabel = role ? accessLabel(effectivePermissionMode(role, settings)) : '';
  const chooseAgentMode = (mode: PermissionMode | null) => {
    // Полный доступ для сотрудника — то же опасное состояние, что и для роли и офиса.
    if (mode === 'auto') { setConfirmAuto(true); return; }
    setAgentPermission(inst.id, mode);
  };

  const all = Object.values(tasksMap);
  const mine = all.filter((t) => t.assigneeId === inst.id).sort((a, b) => a.createdAt - b.createdAt);
  const current = inst.currentTaskId ? tasksMap[inst.currentTaskId] : null;
  // Задачи своей роли, которые ещё никто не взял — их можно отдать этому агенту.
  const free = all.filter((t) => !t.assigneeId && t.status === 'backlog' && t.roleId === inst.roleId);
  const trail = log.filter((l) => l.agentId === inst.id).slice(-14);

  const done = mine.filter((t) => t.status === 'done').length;
  const running = mine.filter((t) => t.status === 'in_progress').length;

  const cap = settings.taskBudgetUsd;
  const usedShare = cap && current ? Math.min(100, (current.usage.costUsd / cap) * 100) : 0;

  return (
    <aside className="drawer">
      <header className="drawer-head">
        <AgentAvatar roleId={inst.roleId} instanceId={inst.id} look={role?.sprite} className="ava" />
        <div className="drawer-who">
          <h2>{inst.id}</h2>
          <div className="muted">
            {role?.title} · {role?.model.replace('claude-', '')} ·{' '}
            {inst.deskless ? t('drawer.noDesk') : t('employee.deskNo', { index: inst.desk.index })}
          </div>
          <span className={`perm-badge ${inst.effectivePermissionMode}`}
            title={t('drawer.permBadge')}>
            <Icon name={inst.effectivePermissionMode === 'auto' ? 'lock-open' : 'shield-lock'} size={14} />{' '}
            {accessLabel(inst.effectivePermissionMode)} · {permissionSourceLabel(permissionSource(inst, role))}
          </span>
          <div className={`chip ${inst.state}`}>
            {inst.note ?? statusLabel(current?.status ?? 'backlog')}
            {current && ` · ${elapsed(current.startedAt, null)} · ${current.id}`}
          </div>
        </div>
        <button className="icon" onClick={() => select(null)} title={t('common.close')}>✕</button>
      </header>

      {inst.deskless && (
        <div className="deskless-notice">
          <Icon name="armchair" size={16} /> {t('employee.deskless', { index: inst.desk.index })}{' '}
          <button className="link" onClick={openLayoutSettings}>{t('employee.layoutSettings')}</button>
        </div>
      )}

      <section>
        <h3>{t('employee.access')}</h3>
        <label>{t('employee.personalMode')}
          <select
            value={inst.permissionMode ?? ''}
            onChange={(e) => chooseAgentMode(e.target.value === '' ? null : e.target.value as PermissionMode)}
          >
            <option value="">{t('employee.asRole', { mode: roleFallbackLabel })}</option>
            {PERM_OPTIONS.map((m) => <option key={m} value={m}>{accessLabel(m)}</option>)}
          </select>
          <span className="hint">
            {inst.permissionMode
              ? t('employee.ownRule', { mode: accessLabel(inst.permissionMode) })
              : t('employee.roleRule', { mode: roleFallbackLabel })}
          </span>
        </label>
        {confirmAuto && (
          <div className="access-confirm">
            <p>{fullAccessWarning()}</p>
            <div className="modal-actions">
              <button onClick={() => setConfirmAuto(false)}>{t('common.cancel')}</button>
              <button className="danger" onClick={() => { setAgentPermission(inst.id, 'auto'); setConfirmAuto(false); }}>
                {t('settings.access.confirm')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h3>{t('drawer.doingNow')}</h3>
        {current ? (
          <div className="card">
            <div className="card-head"><b>{current.id}</b> {current.title}</div>
            <div className="muted small">
              {elapsed(current.startedAt, null)} · {money(current.usage.costUsd)} ·{' '}
              {tokens(current.usage.tokensIn + current.usage.tokensOut)} tok
              {current.branch && <> · {t('drawer.branch')} <code className="mono">{current.branch}</code></>}
            </div>
            <Criteria list={current.criteria} />
            {cap !== null && (
              <div className="budget">
                <div className="bar"><i style={{ width: `${usedShare}%` }} /></div>
                <span className="muted small">
                  {t('drawer.taskBudget', { cap: money(cap), share: Math.round(usedShare) })}
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className="muted small">{t('drawer.free')}</p>
        )}
      </section>

      <section>
        <h3>
          {t('drawer.tasks')}
          <span className="muted">
            {' · '}{t('drawer.tasksSummary', { done, running, free: free.length })}
          </span>
        </h3>
        {mine.length === 0 && free.length === 0 && <p className="muted small">{t('drawer.nothingYet')}</p>}
        {mine.map((t) => (
          <div key={t.id} className={`row ${t.status}`}>
            <span className="mono dim">{t.id}</span>
            <span className="row-title">{t.title}</span>
            <span className="muted small">{statusLabel(t.status)}</span>
            {t.criteria.length > 0 && (
              <span className="muted small">
                {progress(t.criteria).done}/{progress(t.criteria).total} {tr('drawer.crit')}
              </span>
            )}
            {t.usage.costUsd > 0 && <span className="muted small">{money(t.usage.costUsd)}</span>}
            {t.status === 'in_progress' && (
              <button className="mini stop" onClick={() => stopTask(t.id)}>{tr('drawer.stop')}</button>
            )}
            {(t.status === 'failed' || t.status === 'blocked') && (
              <button className="mini" onClick={() => retryTask(t.id)}>{tr('drawer.again')}</button>
            )}
            {t.branch && !t.merged && (
              <button className="mini" onClick={() => showDiff(t.id)}>diff</button>
            )}
            {t.status === 'done' && t.branch && !t.merged && (
              <button className="mini" onClick={() => mergeTask(t.id)}>{tr('drawer.merge')}</button>
            )}
            {t.status === 'review' && t.branch && (
              <span className="muted small" title={tr('drawer.pipelineOwns')}>{tr('drawer.inReview')}</span>
            )}
          </div>
        ))}
        {free.map((t) => (
          <div key={t.id} className="row backlog">
            <span className="mono dim">{t.id}</span>
            <span className="row-title">{t.title}</span>
            <button className="mini go" onClick={() => assignDirect(t.id, inst.id)}>{tr('drawer.start')}</button>
          </div>
        ))}
        {free.length > 0 && (
          <p className="muted small">{t('drawer.directNote')}</p>
        )}
      </section>

      <section>
        <h3>
          {t('drawer.transcript')}{' '}
          <span className="muted">· {t('drawer.lastN', { n: trail.length })}</span>
        </h3>
        <div className="trail">
          {trail.length === 0 && <p className="muted small">{t('chat.empty')}</p>}
          {trail.map((l) => {
            const tool = l.text.split(':')[0];
            return (
              <div key={l.id} className={`trail-row ${l.kind}${l.autoApproved ? ' auto-approved' : ''}`}>
                <span className="dim mono">
                  {new Date(l.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="ico">
                  {l.kind === 'tool'
                    ? (TOOL_ICON[tool] ? <Icon name={TOOL_ICON[tool]} size={14} /> : '•')
                    : <Icon name={l.kind === 'error' ? 'alert-triangle' : 'message'} size={14} />}
                </span>
                <span className="trail-text">
                  {l.autoApproved && (
                    <span className="auto-tag" title={t('log.autoHint')}>{t('log.auto')}</span>
                  )}
                  {l.text}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3>{t('usage.title.short')}</h3>
        <div className="usage-lines">
          {current && (
            <div>
              <b>{money(current.usage.costUsd)}</b> {t('usage.forTask')} ·{' '}
              <span className="muted">{usageLine(current.usage)}</span>
            </div>
          )}
          <div>
            <b>{money(inst.today.costUsd)}</b> {t('usage.forToday')} ·{' '}
            <span className="muted">{usageLine(inst.today)}</span>
          </div>
          <div className="muted">
            {money(inst.usage.costUsd)} {t('usage.forAgentAllTime')} · {usageLine(inst.usage)}
          </div>
        </div>
      </section>

      <div className="drawer-actions">
        <button onClick={() => { setThread(inst.id); select(null); }}>
          <Icon name="message" size={16} /> {t('drawer.talk')}
        </button>
        {role && !role.isManager && (
          <button disabled={role.active >= role.maxInstances} onClick={() => hire(inst.roleId)}>
            <Icon name="copy" size={16} /> {t('drawer.clone')}
          </button>
        )}
        {current && (
          <button className="danger" onClick={() => stopTask(current.id)}>
            <Icon name="player-stop" size={16} /> {t('drawer.stopTask')}
          </button>
        )}
      </div>
      <div className="drawer-links">
        <button className="link" onClick={() => requestTeamRole(inst.roleId)}>
          {inst.deskless
            ? t('drawer.roleLink')
            : t('drawer.roleLinkDesk', { index: inst.desk.index })}
        </button>
        {current?.worktreePath && (
          <div className="muted small mono" title={t('drawer.worktree')}>
            {current.worktreePath}
          </div>
        )}
        {role && !role.isManager && (
          <button
            className="link-danger"
            disabled={Boolean(inst.currentTaskId)}
            title={inst.currentTaskId
              ? t('employee.busyHint', { task: inst.currentTaskId })
              : t('employee.fireHint')}
            onClick={() => { markPending(); fire(inst.id); }}
          >
            {t('employee.fire')}
          </button>
        )}
      </div>
      {notice && (
        <div className="drawer-notice">
          <span>{notice}</span>
          <button className="sq" onClick={clear}>✕</button>
        </div>
      )}
    </aside>
  );
}

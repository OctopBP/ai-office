import { useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { PROVIDERS, providerOf } from '../shared/providers';
import { openLayoutSettings, useStore } from './store';
import { t, type UiKey } from './i18n';
import { Icon } from './icons';
import { Avatar } from './Avatar';
import { useInstanceName } from './instanceName';
import { useAgentAutosave, type AgentAutosave, type AgentField } from './useAgentAutosave';
import { AccessPanel, BriefPanel, ModelPanel, ProfilePanel, ResultsPanel } from './AgentPanels';
import type { InstanceView, MarketPackageView, RoleView } from '../shared/types';

/**
 * Страница агента в окне «Команда» (спека docs/design/T-151/spec.md):
 * закреплённая шапка с индикатором сохранения, под ней пять вкладок.
 * Кнопки «Сохранить» нет — всё сохраняет `useAgentAutosave` по правилам поля.
 */

export type AgentTab = 'profile' | 'model' | 'access' | 'brief' | 'results';

const TABS: AgentTab[] = ['profile', 'model', 'access', 'brief', 'results'];

/** Какие поля на какой вкладке — для красной точки ошибки на названии вкладки. */
const TAB_FIELDS: Record<AgentTab, AgentField[]> = {
  profile: ['name', 'title', 'sprite'],
  model: ['provider', 'model', 'ownModel', 'maxTurns', 'repoDir', 'isolate'],
  access: ['permissionMode', 'personalMode', 'mcp', 'capabilities'],
  brief: ['brief', 'briefExtra'],
  results: [],
};

/** Подпись поля — для вопроса «есть несохранённые правки: …» при закрытии. */
const FIELD_LABEL: Record<AgentField, UiKey> = {
  name: 'agent.field.name',
  personalMode: 'agent.field.personalMode',
  title: 'agent.field.roleName',
  sprite: 'role.look',
  provider: 'role.provider',
  model: 'role.model',
  ownModel: 'role.model',
  tier: 'role.model',
  permissionMode: 'agent.field.roleMode',
  isolate: 'role.isolate',
  maxTurns: 'settings.limits.turns',
  repoDir: 'role.repo',
  mcp: 'role.mcp',
  capabilities: 'role.capabilities',
  brief: 'role.brief',
  briefExtra: 'role.briefExtra',
};

export const agentFieldLabel = (f: AgentField): string => t(FIELD_LABEL[f]);

export interface AgentSettingsProps {
  instanceId: string;
  tab: AgentTab;
  onTab: (tab: AgentTab) => void;
  /** Окно спрашивает перед закрытием: дослать и вернуть подписи несохранённого. */
  guard: MutableRefObject<(() => string[]) | null>;
  onRemoved: () => void;
  packages: MarketPackageView[];
  marketBusy: boolean;
  act: (fn: () => void) => void;
  /** Кнопки окна в шапке (например, «+ Ещё один»). */
  actions?: ReactNode;
}

export function AgentSettings(props: AgentSettingsProps) {
  const inst = useStore((s) => s.instances[props.instanceId]);
  const role = useStore((s) => s.roles.find((r) => r.id === inst?.roleId));
  // Сотрудника уволили, пока страница открыта: сохранять некуда, правки
  // отбрасываются вместе с хуком.
  if (!inst || !role) return <p className="muted small">{t('employee.gone')}</p>;
  return <AgentPage {...props} inst={inst} role={role} />;
}

function AgentPage({ inst, role, tab, onTab, guard, onRemoved, packages, marketBusy, act, actions }: AgentSettingsProps & {
  inst: InstanceView;
  role: RoleView;
}) {
  const save = useAgentAutosave(role, inst, onRemoved);
  const busy = Boolean(inst.currentTaskId);
  const updateTo = role.package
    ? packages.find((p) => p.name === role.package!.name)?.roles.find((r) => r.id === role.id)?.updateTo ?? null
    : null;

  useEffect(() => {
    guard.current = () => { save.flush(); return save.unsaved().map(agentFieldLabel); };
    return () => { guard.current = null; };
  });

  // Уход с вкладки досылает то, что ждёт таймера или выхода из поля.
  const switchTab = (next: AgentTab) => { save.flush(); onTab(next); };
  const tabRefs = useRef<Partial<Record<AgentTab, HTMLButtonElement | null>>>({});
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = TABS.indexOf(tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    switchTab(next);
    tabRefs.current[next]?.focus();
  };

  const panelProps = { save, role, inst, busy };
  return (
    <div className="agent-page">
      <div className="agent-top">
        <AgentHead inst={inst} role={role} save={save} actions={actions} />
        <div className="tabs" role="tablist" aria-label={t('agent.tabs.aria')} onKeyDown={onTabKey}>
          {TABS.map((id) => {
            const hasError = TAB_FIELDS[id].some((f) => save.field(f).error);
            return (
              <button
                key={id} role="tab" id={`agent-tab-${id}`} aria-selected={tab === id} aria-controls="agent-panel"
                tabIndex={tab === id ? 0 : -1} className={tab === id ? 'on' : ''}
                ref={(el) => { tabRefs.current[id] = el; }}
                onClick={() => switchTab(id)}
              >
                {t(`agent.tab.${id}`)}
                {hasError && <span className="tabs-dot" role="img" aria-label={t('agent.tab.hasError')} />}
                {id === 'brief' && updateTo && <span className="tabs-badge">{t('agent.tab.update')}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="agent-panel" role="tabpanel" id="agent-panel" aria-labelledby={`agent-tab-${tab}`}>
        {role.archived && <div className="form-banner">{t('agent.banner.archived')}</div>}
        {busy && <BusyBanner taskId={inst.currentTaskId!} />}
        {tab === 'profile' && inst.deskless && (
          <div className="deskless-notice">
            <Icon name="armchair" size={16} /> {t('employee.deskless', { index: inst.desk.index })}{' '}
            <button className="link" onClick={openLayoutSettings}>{t('employee.layoutSettings')}</button>
          </div>
        )}
        {/* Плашки выше — вне шаблона: у первой группы `.form` не должно быть линии сверху. */}
        <div className="form">
          {tab === 'profile' && <ProfilePanel {...panelProps} />}
          {tab === 'model' && <ModelPanel {...panelProps} />}
          {tab === 'access' && <AccessPanel {...panelProps} />}
          {tab === 'brief' && <BriefPanel {...panelProps} packages={packages} marketBusy={marketBusy} act={act} />}
          {tab === 'results' && <ResultsPanel {...panelProps} />}
        </div>
      </div>
    </div>
  );
}

function BusyBanner({ taskId }: { taskId: string }) {
  const openTaskCard = useStore((s) => s.openTaskCard);
  const [before, after] = t('agent.busy.banner', { task: '\u0000' }).split('\u0000');
  return (
    <div className="form-banner">
      {before}
      <button className="link mono" onClick={() => openTaskCard(taskId)}>{taskId}</button>
      {after}
    </div>
  );
}

/** Шапка: аватар, имя (правится по клику), роль и модель, состояние, индикатор сохранения. */
function AgentHead({ inst, role, save, actions }: {
  inst: InstanceView; role: RoleView; save: AgentAutosave; actions?: ReactNode;
}) {
  const shown = useInstanceName(inst.id);
  const [editing, setEditing] = useState(false);
  const pkg = role.package ? ` · ${role.package.name} ${role.package.version}` : '';
  const done = () => { setEditing(false); save.commit('name'); };
  return (
    <div className="employee-card-head agent-head">
      <Avatar roleId={inst.roleId} instanceId={inst.id} size="lg" />
      <div className="agent-head-text">
        {editing ? (
          <input
            className="agent-name-input" autoFocus
            value={save.value<string>('name')} placeholder={t('employee.namePlaceholder')}
            onChange={(e) => save.edit('name', e.target.value)}
            onBlur={done}
            onKeyDown={(e) => {
              if (e.key === 'Enter') done();
              if (e.key === 'Escape') { e.stopPropagation(); save.cancel('name'); setEditing(false); }
            }}
          />
        ) : (
          <h3 className="agent-name">
            <button className="agent-name-btn" title={t('employee.rename')} onClick={() => setEditing(true)}>
              {shown} <Icon name="pencil" size={14} />
            </button>
          </h3>
        )}
        <p className="muted">
          {inst.name ? `${role.title} · ` : ''}{PROVIDERS[providerOf(role)].label} · {role.model.replace('claude-', '')}{pkg}
        </p>
      </div>
      <span className="chip">{t(`agent.state.${inst.state}`)}</span>
      {inst.deskless && (
        <span className="perm-badge deskless" title={t('office.desklessHint')}><Icon name="armchair" size={14} /></span>
      )}
      {actions}
      <SaveIndicator save={save} />
    </div>
  );
}

/** Индикатор сохранения — один на страницу, в правой части шапки. */
function SaveIndicator({ save }: { save: AgentAutosave }) {
  const { status } = save;
  const failed = status === 'error' || status === 'offline';
  return (
    <span className={`save-status ${status}`} role="status" aria-live={failed ? 'assertive' : 'polite'}>
      {status === 'saved' && <><Icon name="circle-check" size={14} /> {t('agent.save.saved')}</>}
      {status === 'justSaved' && <><Icon name="circle-check" size={14} /> {t('agent.save.justSaved')}</>}
      {status === 'dirty' && (
        <span className="save-status-dirty" title={t('agent.hint.onBlur')}>
          <span className="save-status-dot" /> {t('agent.save.dirty')}
        </span>
      )}
      {status === 'saving' && <><span className="spinner" /> {t('agent.save.saving')}</>}
      {failed && (
        <>
          <Icon name="alert-triangle" size={14} /> {t(status === 'offline' ? 'agent.save.offline' : 'agent.save.error')}
          <button className="mini" onClick={save.retry}>{t('agent.save.retry')}</button>
        </>
      )}
    </span>
  );
}

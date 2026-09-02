import { useEffect, useState } from 'react';
import { clearTeamRequest, fire, hire, useStore } from './store';
import { RoleEditor } from './RoleEditor';
import { EmployeeCard } from './EmployeeCard';
import { useActionNotice } from './useActionNotice';
import { Avatar } from './Avatar';
import { catalog } from './layoutData';
import { desks } from '../shared/layout';
import { t } from './i18n';
import type { AgentState } from '../shared/types';
import { Icon } from './icons';

const stateLabel = (state: AgentState): string => t(`agent.state.${state}`);

type Selection =
  | { kind: 'role'; id: string }
  | { kind: 'employee'; id: string }
  | { kind: 'new-role' }
  | null;

/**
 * Главный экран управления агентами: слева роли и их сотрудники, справа —
 * форма выбранной роли или карточка выбранного сотрудника. Заменяет собой
 * старую панель команды внутри «Помощи»: там она была побочной модалкой,
 * здесь — отдельная точка входа из шапки.
 */
export function TeamWindow({ onClose }: { onClose: () => void }) {
  const roles = useStore((s) => s.roles);
  const instances = useStore((s) => s.instances);
  const layout = useStore((s) => s.layout);
  const teamRequest = useStore((s) => s.teamRequest);
  const [selection, setSelection] = useState<Selection>(() => (
    teamRequest ? { kind: 'role', id: teamRequest.roleId } : null
  ));
  const { notice, markPending, clear } = useActionNotice();

  // Запрос на конкретную роль прочитан в начальном состоянии (см. useState
  // выше) — сбрасываем его один раз после монтирования, чтобы повторное
  // открытие окна не залипало на той же роли.
  useEffect(() => { if (teamRequest) clearTeamRequest(); }, []);

  const doHire = (roleId: string) => { markPending(); hire(roleId); };
  const doFire = (instanceId: string) => { markPending(); fire(instanceId); };

  const deskTotal = desks(layout, catalog).length;
  const seated = Object.keys(instances).length;
  const deskShortage = seated >= deskTotal;

  const sorted = [...roles].sort((a, b) => Number(a.archived) - Number(b.archived));
  const selectedRole = selection?.kind === 'role' ? roles.find((r) => r.id === selection.id) ?? null : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="team-window" onClick={(e) => e.stopPropagation()}>
        <header className="team-window-head">
          <h2>{t('hud.team')}</h2>
          <button className="sq ghost" onClick={onClose} title={t('panel.close')}>✕</button>
        </header>

        <div className="team-window-body">
          <div className="team-list-pane">
            <div className="team-list-head">
              <span className="muted small">
                {t('team.counts', { roles: roles.length, staff: seated })}
              </span>
              <button className="mini go" onClick={() => setSelection({ kind: 'new-role' })}>
                {t('team.addRole')}
              </button>
            </div>

            {deskShortage && (
              <div className="deskless-notice">
                <Icon name="armchair" size={16} /> {t('team.deskShortage', { desks: deskTotal, staff: seated })}
              </div>
            )}

            {notice && (
              <div className="team-notice">
                <span>{notice}</span>
                <button className="sq" onClick={clear}>✕</button>
              </div>
            )}

            <div className="team-list">
              {sorted.map((r) => {
                const members = Object.values(instances)
                  .filter((i) => i.roleId === r.id)
                  .sort((a, b) => a.id.localeCompare(b.id));
                const canHire = !r.isManager && !r.archived && r.active < r.maxInstances;
                const hireTitle = r.isManager
                  ? t('team.pmNoClone')
                  : r.archived ? t('team.archivedRole')
                  : canHire ? t('team.hireOne') : t('team.hireLimit');
                const roleSelected = selection?.kind === 'role' && selection.id === r.id;

                return (
                  <div key={r.id} className={`team-role-block ${r.archived ? 'archived' : ''}`}>
                    <div
                      className={`team-role-row ${roleSelected ? 'selected' : ''}`}
                      onClick={() => setSelection({ kind: 'role', id: r.id })}
                    >
                      <Avatar roleId={r.id} />
                      <span className="team-title">
                        {r.title}
                        <span className="muted mono"> {r.model.replace('claude-', '')}</span>
                        {r.archived && <span className="perm-badge">{t('team.archived')}</span>}
                      </span>
                      <span className="muted">{r.active}/{r.maxInstances}</span>
                      <button
                        className="mini" disabled={!canHire} title={hireTitle}
                        onClick={(e) => { e.stopPropagation(); doHire(r.id); }}
                      >
                        {t('team.hire')}
                      </button>
                    </div>

                    {members.length > 0 && (
                      <div className="team-members">
                        {members.map((m) => {
                          const busy = Boolean(m.currentTaskId);
                          const disabled = r.isManager || busy;
                          const title = r.isManager
                            ? t('employee.pmCannotFire')
                            : busy
                              ? t('team.busy', { task: m.currentTaskId ?? '' })
                              : t('employee.fire');
                          const memberSelected = selection?.kind === 'employee' && selection.id === m.id;
                          return (
                            <div
                              key={m.id} className={`team-member-row ${memberSelected ? 'selected' : ''}`}
                              onClick={() => setSelection({ kind: 'employee', id: m.id })}
                            >
                              <Avatar roleId={r.id} instanceId={m.id} size="sm" />
                              <span className="mono muted">{m.id}</span>
                              <span className="muted small">{stateLabel(m.state)}</span>
                              {m.deskless && (
                                <span className="perm-badge deskless" title={t('office.desklessHint')}>
                                  <Icon name="armchair" size={14} />
                                </span>
                              )}
                              {m.permissionMode && (
                                <span className={`perm-badge ${m.permissionMode}`}>
                                  <Icon name={m.permissionMode === 'auto' ? 'lock-open' : 'shield-lock'} size={14} />
                                </span>
                              )}
                              <button
                                className="mini link-danger" disabled={disabled} title={title}
                                onClick={(e) => { e.stopPropagation(); doFire(m.id); }}
                              >
                                {t('employee.fire')}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="team-detail">
            {selection?.kind === 'employee' && <EmployeeCard instanceId={selection.id} />}
            {(selection?.kind === 'new-role' || selection?.kind === 'role') && (
              <RoleEditor
                key={selection.kind === 'role' ? selection.id : 'new'}
                role={selectedRole}
                onSaved={(roleId) => setSelection({ kind: 'role', id: roleId })}
                onDeleted={() => setSelection(null)}
              />
            )}
            {!selection && (
              <p className="muted small">{t('team.pickHint')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

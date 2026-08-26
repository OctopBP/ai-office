import { useEffect, useState } from 'react';
import { clearTeamRequest, fire, hire, useStore } from './store';
import { RoleEditor } from './RoleEditor';
import { EmployeeCard } from './EmployeeCard';
import { useActionNotice } from './useActionNotice';
import { agentSpriteName, spriteOf } from './sprites';
import { catalog } from './layoutData';
import { desks } from '../shared/layout';

const STATE_RU: Record<string, string> = {
  idle: 'свободен', thinking: 'думает', working: 'работает', walking: 'идёт',
  talking: 'разговор', waiting_approval: 'ждёт разрешения', paused: 'на паузе',
  blocked: 'заблокирован', done: 'сдал работу', failed: 'ошибка',
};

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
  const theme = useStore((s) => s.theme);
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
          <h2>Команда</h2>
          <button className="sq" onClick={onClose} title="Закрыть — ESC">✕</button>
        </header>

        <div className="team-window-body">
          <div className="team-list-pane">
            <div className="team-list-head">
              <span className="muted small">{roles.length} ролей · {seated} сотрудников</span>
              <button className="mini go" onClick={() => setSelection({ kind: 'new-role' })}>
                + Добавить роль
              </button>
            </div>

            {deskShortage && (
              <div className="deskless-notice">
                🪑 Мест в раскладке {deskTotal}, а сотрудников уже {seated} — новый наём
                может остаться без стола, пока не освободится место или не сменится раскладка.
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
                  ? 'PM не клонируется'
                  : r.archived ? 'Роль в архиве — сначала верните её'
                  : canHire ? 'Нанять ещё одного' : 'Достигнут лимит клонов роли';
                const roleSelected = selection?.kind === 'role' && selection.id === r.id;

                return (
                  <div key={r.id} className={`team-role-block ${r.archived ? 'archived' : ''}`}>
                    <div
                      className={`team-role-row ${roleSelected ? 'selected' : ''}`}
                      onClick={() => setSelection({ kind: 'role', id: r.id })}
                    >
                      <img
                        className="team-avatar"
                        src={spriteOf(theme, agentSpriteName(r.id, r.id, r.sprite))} alt=""
                      />
                      <span className="team-title">
                        {r.title}
                        <span className="muted mono"> {r.model.replace('claude-', '')}</span>
                        {r.archived && <span className="perm-badge">в архиве</span>}
                      </span>
                      <span className="muted">{r.active}/{r.maxInstances}</span>
                      <button
                        className="mini" disabled={!canHire} title={hireTitle}
                        onClick={(e) => { e.stopPropagation(); doHire(r.id); }}
                      >
                        + Нанять
                      </button>
                    </div>

                    {members.length > 0 && (
                      <div className="team-members">
                        {members.map((m) => {
                          const busy = Boolean(m.currentTaskId);
                          const disabled = r.isManager || busy;
                          const title = r.isManager
                            ? 'PM — единственный, кого нельзя уволить'
                            : busy ? `Занят задачей ${m.currentTaskId}` : 'Уволить';
                          const memberSelected = selection?.kind === 'employee' && selection.id === m.id;
                          return (
                            <div
                              key={m.id} className={`team-member-row ${memberSelected ? 'selected' : ''}`}
                              onClick={() => setSelection({ kind: 'employee', id: m.id })}
                            >
                              <span className="mono muted">{m.id}</span>
                              <span className="muted small">{STATE_RU[m.state] ?? m.state}</span>
                              {m.deskless && <span className="perm-badge deskless">🪑</span>}
                              {m.permissionMode && (
                                <span className={`perm-badge ${m.permissionMode}`}>
                                  {m.permissionMode === 'auto' ? '🔓' : '🔐'}
                                </span>
                              )}
                              <button
                                className="mini link-danger" disabled={disabled} title={title}
                                onClick={(e) => { e.stopPropagation(); doFire(m.id); }}
                              >
                                Уволить
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
              <p className="muted small">
                Выберите роль или сотрудника слева — здесь появятся её настройки
                или карточка сотрудника.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

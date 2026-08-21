import { useState } from 'react';
import { ACCESS_LABEL, fire, hire, useStore } from './store';
import { RoleEditor } from './RoleEditor';
import { useActionNotice } from './useActionNotice';

const STATE_RU: Record<string, string> = {
  idle: 'свободен', thinking: 'думает', working: 'работает', walking: 'идёт',
  talking: 'разговор', waiting_approval: 'ждёт разрешения', paused: 'на паузе',
  blocked: 'заблокирован', done: 'сдал работу', failed: 'ошибка',
};

export function TeamPanel() {
  const roles = useStore((s) => s.roles);
  const instances = useStore((s) => s.instances);
  const [editing, setEditing] = useState<string | null>(null);
  const { notice, markPending, clear } = useActionNotice();

  const doHire = (roleId: string) => { markPending(); hire(roleId); };
  const doFire = (instanceId: string) => { markPending(); fire(instanceId); };

  return (
    <div className="team">
      <h2>Команда</h2>

      {notice && (
        <div className="team-notice">
          <span>{notice}</span>
          <button className="sq" onClick={clear}>✕</button>
        </div>
      )}

      {roles.map((r) => {
        const members = Object.values(instances)
          .filter((i) => i.roleId === r.id)
          .sort((a, b) => a.id.localeCompare(b.id));
        const canHire = !r.isManager && r.active < r.maxInstances;
        const hireTitle = r.isManager
          ? 'PM не клонируется'
          : canHire ? 'Нанять ещё одного' : 'Достигнут лимит клонов роли';

        return (
          <div key={r.id} className="team-role">
            <div className="team-row">
              <span className="team-emoji" style={{ background: r.color }}>{r.emoji}</span>
              <span className="team-title">
                {r.title}
                <span className="muted mono"> {r.model.replace('claude-', '')}</span>
              </span>
              {r.permissionMode && (
                <span className={`perm-badge ${r.permissionMode}`}
                  title="Роль работает не по общему режиму доступа офиса, а по своему">
                  {r.permissionMode === 'auto' ? '🔓' : '🔐'} {ACCESS_LABEL[r.permissionMode]}
                </span>
              )}
              <span className="muted">{r.active}/{r.maxInstances}</span>
              <button onClick={() => setEditing(r.id)}>Настроить</button>
              <button disabled={!canHire} title={hireTitle} onClick={() => doHire(r.id)}>
                + Нанять
              </button>
            </div>

            {members.length === 0 ? (
              <div className="team-vacancy">
                <span className="muted small">Никого не нанято</span>
                <button className="mini go" disabled={!canHire} title={hireTitle} onClick={() => doHire(r.id)}>
                  Нанять
                </button>
              </div>
            ) : (
              <div className="team-members">
                {members.map((m) => {
                  const busy = Boolean(m.currentTaskId);
                  const disabled = r.isManager || busy;
                  const title = r.isManager
                    ? 'PM — единственный, кого нельзя уволить'
                    : busy ? `Занят задачей ${m.currentTaskId} — сначала остановите или дождитесь` : 'Уволить';
                  return (
                    <div key={m.id} className="team-member">
                      <span className="mono muted">{m.id}</span>
                      <span className="muted small">{STATE_RU[m.state] ?? m.state}</span>
                      <button
                        className="mini link-danger" disabled={disabled} title={title}
                        onClick={() => doFire(m.id)}
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

      {editing && <RoleEditor roleId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

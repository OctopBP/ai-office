import { useState } from 'react';
import { hire, useStore } from './store';
import { RoleEditor } from './RoleEditor';

export function TeamPanel() {
  const roles = useStore((s) => s.roles);
  const instances = useStore((s) => s.instances);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="team">
      <h2>Команда</h2>
      {roles.map((r) => {
        const canHire = !r.isManager && r.active < r.maxInstances;
        return (
          <div key={r.id} className="team-row">
            <span className="team-emoji" style={{ background: r.color }}>{r.emoji}</span>
            <span className="team-title">
              {r.title}
              <span className="muted mono"> {r.model.replace('claude-', '')}</span>
            </span>
            <span className="muted">{r.active}/{r.maxInstances}</span>
            <button onClick={() => setEditing(r.id)}>Настроить</button>
            <button
              disabled={!canHire}
              title={canHire ? 'Нанять ещё одного' : 'Достигнут лимит роли'}
              onClick={() => hire(r.id)}
            >
              + Нанять
            </button>
          </div>
        );
      })}


      {editing && <RoleEditor roleId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

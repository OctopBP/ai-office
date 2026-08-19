import { useState } from 'react';
import { updateRole, useStore } from './store';
import type { RoleEditable } from '../shared/types';

const MODELS = [
  ['claude-opus-5', 'Opus 5 — $5/$25, сложные задачи'],
  ['claude-sonnet-5', 'Sonnet 5 — $3/$15, рабочая лошадка'],
  ['claude-haiku-4-5', 'Haiku 4.5 — $1/$5, простое и быстрое'],
] as const;

const MODES: Array<[RoleEditable['permissionMode'], string]> = [
  ['auto', 'ничего не спрашивать'],
  ['ask-risky', 'спрашивать необратимое (по умолчанию)'],
  ['ask-writes', 'спрашивать любую запись и команду'],
  ['readonly', 'только чтение'],
];

export function RoleEditor({ roleId, onClose }: { roleId: string; onClose: () => void }) {
  const role = useStore((s) => s.roles.find((r) => r.id === roleId));
  const [draft, setDraft] = useState<Partial<RoleEditable>>({});
  if (!role) return null;

  const value = { ...role, ...draft };
  const set = <K extends keyof RoleEditable>(k: K, v: RoleEditable[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const save = () => {
    if (Object.keys(draft).length) updateRole(roleId, draft);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{role.emoji} Настройка роли</h3>
        <p className="modal-reason">
          Изменения применяются к новым сессиям. У исполнителя, который работает прямо
          сейчас, промпт и модель зафиксированы на момент старта задачи.
        </p>

        <label>Название
          <input value={value.title} onChange={(e) => set('title', e.target.value)} />
        </label>

        <label>Модель
          <select value={value.model} onChange={(e) => set('model', e.target.value)}>
            {MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>

        <label>Разрешения
          <select
            value={value.permissionMode}
            onChange={(e) => set('permissionMode', e.target.value as RoleEditable['permissionMode'])}
          >
            {MODES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>

        <div className="row2">
          <label>Максимум клонов
            <input
              type="number" min={1} max={5} value={value.maxInstances}
              onChange={(e) => set('maxInstances', Math.max(1, Number(e.target.value)))}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox" checked={value.isolate}
              onChange={(e) => set('isolate', e.target.checked)}
            />
            Своя ветка на задачу
          </label>
        </div>

        <label>Инструкция роли
          <textarea rows={6} value={value.brief} onChange={(e) => set('brief', e.target.value)} />
        </label>

        <div className="modal-actions">
          <button onClick={onClose}>Отмена</button>
          <button className="allow" onClick={save}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

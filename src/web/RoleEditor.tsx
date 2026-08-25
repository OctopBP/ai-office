import { useState } from 'react';
import { ACCESS_LABEL, FULL_ACCESS_WARNING, parseTaskMaxTurns, updateRole, useStore } from './store';
import type { PermissionMode, RoleEditable } from '../shared/types';
import { MAX_TASK_MAX_TURNS, MIN_TASK_MAX_TURNS } from '../shared/types';

const MODELS = [
  ['claude-opus-5', 'Opus 5 — $5/$25, сложные задачи'],
  ['claude-sonnet-5', 'Sonnet 5 — $3/$15, рабочая лошадка'],
  ['claude-haiku-4-5', 'Haiku 4.5 — $1/$5, простое и быстрое'],
] as const;

const MODES: Array<[PermissionMode, string]> = [
  ['readonly', 'только чтение'],
  ['ask-writes', 'спрашивать про все изменения'],
  ['ask-risky', 'спрашивать про необратимое (по умолчанию)'],
  ['auto', 'полный доступ'],
];

export function RoleEditor({ roleId, onClose }: { roleId: string; onClose: () => void }) {
  const role = useStore((s) => s.roles.find((r) => r.id === roleId));
  const settings = useStore((s) => s.settings);
  const [draft, setDraft] = useState<Partial<RoleEditable>>({});
  // Лимит ходов держим строкой: пустое поле — это «как в офисе», а не ноль.
  const [turns, setTurns] = useState(role?.maxTurns?.toString() ?? '');
  const [confirmAuto, setConfirmAuto] = useState(false);
  if (!role) return null;

  const turnsParsed = parseTaskMaxTurns(turns);
  const turnsError = turnsParsed.error
    ? `Целое число от ${MIN_TASK_MAX_TURNS} до ${MAX_TASK_MAX_TURNS} или пусто — как в офисе`
    : null;

  const value = { ...role, ...draft };
  const set = <K extends keyof RoleEditable>(k: K, v: RoleEditable[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const chooseMode = (mode: PermissionMode | null) => {
    // Полный доступ для роли — то же опасное состояние, что и для офиса целиком.
    if (mode === 'auto') { setConfirmAuto(true); return; }
    set('permissionMode', mode);
  };

  const save = () => {
    if (turnsError) return;
    const patch: Partial<RoleEditable> = { ...draft };
    if (turnsParsed.value !== (role.maxTurns ?? null)) patch.maxTurns = turnsParsed.value;
    if (Object.keys(patch).length) updateRole(roleId, patch);
    onClose();
  };

  const officeLabel = ACCESS_LABEL[settings.officePermissionMode];

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
            value={value.permissionMode ?? ''}
            onChange={(e) => chooseMode(e.target.value === '' ? null : e.target.value as PermissionMode)}
          >
            <option value="">Как в офисе (сейчас: {officeLabel})</option>
            {MODES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <span className="hint">
            {value.permissionMode
              ? `Роль работает не по общему правилу офиса — переопределено на «${ACCESS_LABEL[value.permissionMode]}».`
              : `Роль использует общий режим доступа офиса: «${officeLabel}».`}
          </span>
        </label>

        {confirmAuto && (
          <div className="access-confirm">
            <p>{FULL_ACCESS_WARNING}</p>
            <div className="modal-actions">
              <button onClick={() => setConfirmAuto(false)}>Отмена</button>
              <button className="danger" onClick={() => { set('permissionMode', 'auto'); setConfirmAuto(false); }}>
                Да, включить полный доступ
              </button>
            </div>
          </div>
        )}

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

        <label>Лимит шагов исполнителя
          <input
            value={turns}
            placeholder={role.effectiveMaxTurns === null
              ? 'как в офисе (сейчас без ограничения)'
              : `как в офисе (сейчас ${role.effectiveMaxTurns})`}
            onChange={(e) => setTurns(e.target.value)}
          />
          <span className="hint">
            Потолок ходов одной сессии этой роли — тот самый лимит, из-за которого
            задача падает с «Reached maximum number of turns». Пусто — лимит офиса.
          </span>
          {turnsError && <span className="hint error">{turnsError}</span>}
        </label>

        <label>Репозиторий роли
          <input
            value={value.repoDir}
            placeholder="общий репозиторий офиса"
            onChange={(e) => set('repoDir', e.target.value)}
          />
          <span className="hint">
            Путь к репозиторию, в котором работает эта роль. Пусто — общий репозиторий
            офиса. Ветка задачи, её diff и слияние идут туда же.
          </span>
        </label>

        <label>Инструкция роли
          <textarea rows={6} value={value.brief} onChange={(e) => set('brief', e.target.value)} />
        </label>

        <div className="modal-actions">
          <button onClick={onClose}>Отмена</button>
          <button className="allow" onClick={save} disabled={!!turnsError}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

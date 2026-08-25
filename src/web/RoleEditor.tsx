import { useEffect, useState } from 'react';
import {
  ACCESS_LABEL, FULL_ACCESS_WARNING, archiveRole, clearRoleFeedback, createRole,
  parseTaskMaxTurns, removeRole, updateRole, useStore,
} from './store';
import { catalog } from './layoutData';
import { desks } from '../shared/layout';
import { agentSpriteName, spriteOf, spritePresets } from './sprites';
import type { PermissionMode, RoleDraft, RoleEditable, RoleView } from '../shared/types';
import {
  MAX_ROLE_INSTANCES, MAX_TASK_MAX_TURNS, MIN_ROLE_INSTANCES, MIN_TASK_MAX_TURNS,
} from '../shared/types';

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

/** Черновик новой роли — умолчания, с которых стартует форма создания. */
const BLANK: RoleEditable = {
  title: '', emoji: '🙂', color: '#94a3b8', model: 'claude-sonnet-5',
  permissionMode: null, maxInstances: 1, isolate: true, maxTurns: null,
  repoDir: '', sprite: 'agent_p1', brief: '',
};

/**
 * Форма роли — создание и правка одной формой. `role: null` значит создание:
 * все проверки и текст ошибок те же, что и при правке, потому что сервер
 * гоняет черновик через ту же проверку полей (checkRolePatch на сервере).
 */
export function RoleEditor({ role, onSaved, onDeleted }: {
  role: RoleView | null;
  onSaved: (roleId: string) => void;
  onDeleted: () => void;
}) {
  const settings = useStore((s) => s.settings);
  const roleFeedback = useStore((s) => s.roleFeedback);
  const theme = useStore((s) => s.theme);
  const layout = useStore((s) => s.layout);
  const instanceCount = useStore((s) => Object.keys(s.instances).length);
  const [draft, setDraft] = useState<Partial<RoleEditable>>({});
  const [turns, setTurns] = useState(role?.maxTurns?.toString() ?? '');
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [submittedOp, setSubmittedOp] = useState<'create' | 'update' | 'archive' | 'restore' | 'remove' | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ field: string; message: string }[]>([]);

  useEffect(() => {
    if (!roleFeedback || !submittedOp || roleFeedback.op !== submittedOp) return;
    if (submittedOp !== 'create' && roleFeedback.roleId !== (role?.id ?? null)) return;
    setSubmittedOp(null);
    if (roleFeedback.errors.length) { setFieldErrors(roleFeedback.errors); clearRoleFeedback(); return; }
    setFieldErrors([]);
    clearRoleFeedback();
    if (submittedOp === 'remove') onDeleted();
    else if (roleFeedback.roleId) onSaved(roleFeedback.roleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleFeedback]);

  const base = role ?? BLANK;
  const value = { ...base, ...draft };
  const set = <K extends keyof RoleEditable>(k: K, v: RoleEditable[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const turnsParsed = parseTaskMaxTurns(turns);
  const turnsError = turnsParsed.error
    ? `Целое число от ${MIN_TASK_MAX_TURNS} до ${MAX_TASK_MAX_TURNS} или пусто — как в офисе`
    : null;

  const errFor = (field: string) => fieldErrors.find((e) => e.field === field)?.message ?? null;
  const formError = errFor('');

  const chooseMode = (mode: PermissionMode | null) => {
    if (mode === 'auto') { setConfirmAuto(true); return; }
    set('permissionMode', mode);
  };

  const save = () => {
    if (turnsError) return;
    setFieldErrors([]);
    if (role) {
      const patch: Partial<RoleEditable> = { ...draft };
      if (turnsParsed.value !== (role.maxTurns ?? null)) patch.maxTurns = turnsParsed.value;
      if (!Object.keys(patch).length) return;
      setSubmittedOp('update');
      updateRole(role.id, patch);
    } else {
      const draftRole: RoleDraft = { ...value, maxTurns: turnsParsed.value };
      setSubmittedOp('create');
      createRole(draftRole);
    }
  };

  const staffCount = role?.active ?? 0;
  const archiveDisabled = !role || role.isManager || staffCount > 0;
  const archiveTitle = !role ? ''
    : role.isManager ? 'PM нельзя убрать в архив — без него офису не с кем разговаривать'
    : staffCount > 0 ? `Сначала уволите сотрудников этой роли (сейчас ${staffCount})`
    : 'Роль скроется из найма, но останется в истории задач';

  const removeDisabled = !role || role.isManager || !role.removable;
  const removeTitle = !role ? ''
    : role.isManager ? 'PM нельзя удалить — офис без него не работает'
    : !role.removable ? 'У роли есть задачи или сотрудники в истории — удалить насовсем нельзя, только в архив'
    : 'У роли нет ни одной задачи и ни одного сотрудника в истории — удаляется без следа';

  const doArchive = (archived: boolean) => {
    if (!role) return;
    setFieldErrors([]);
    setSubmittedOp(archived ? 'archive' : 'restore');
    archiveRole(role.id, archived);
  };
  const doRemove = () => {
    if (!role) return;
    setFieldErrors([]);
    setSubmittedOp('remove');
    removeRole(role.id);
  };

  const officeLabel = ACCESS_LABEL[settings.officePermissionMode];
  const titleDisabled = Boolean(role?.isManager);

  // Прикидка нехватки мест: столов в текущей раскладке меньше, чем уже
  // сидящих сотрудников, — новый наём в эту (или любую) роль скорее всего
  // не найдёт стола. Точный отказ всё равно придёт от сервера при найме,
  // здесь только заранее спокойно предупреждаем.
  const deskShortage = !role && instanceCount >= desks(layout, catalog).length;

  const presets = spritePresets(catalog.sprites);

  return (
    <div className="role-form">
      <h3>{role ? `Настройка роли «${role.title}»` : 'Новая роль'}</h3>
      <p className="modal-reason">
        Изменения применяются к новым сессиям. У исполнителя, который работает прямо
        сейчас, промпт и модель зафиксированы на момент старта задачи.
      </p>

      {formError && <div className="form-banner error">{formError}</div>}
      {deskShortage && (
        <div className="deskless-notice">
          🪑 Свободных мест в раскладке почти не осталось — новый сотрудник может остаться
          без стола, пока кто-то не освободит место или не сменится раскладка.
        </div>
      )}

      <label>Название
        <input
          value={value.title} disabled={titleDisabled}
          title={titleDisabled ? 'Менеджера нельзя переименовать в другую роль' : undefined}
          onChange={(e) => set('title', e.target.value)}
        />
        {errFor('title') && <span className="hint error">{errFor('title')}</span>}
      </label>

      <label>Внешность
        <div className="sprite-grid">
          {presets.map((p) => (
            <button
              key={p.id} type="button"
              className={`sprite-swatch ${value.sprite === p.id ? 'on' : ''}`}
              title={p.label} onClick={() => set('sprite', p.id)}
            >
              <img src={spriteOf(theme, p.id)} alt={p.label} />
              <span>{p.label}</span>
            </button>
          ))}
        </div>
        {!value.sprite && (
          <span className="hint">Внешность по умолчанию для этой роли — выберите пресет, чтобы сменить.</span>
        )}
        {errFor('sprite') && <span className="hint error">{errFor('sprite')}</span>}
      </label>

      <label>Модель
        <select value={value.model} onChange={(e) => set('model', e.target.value)}>
          {MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        {errFor('model') && <span className="hint error">{errFor('model')}</span>}
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
            type="number" min={MIN_ROLE_INSTANCES} max={MAX_ROLE_INSTANCES} value={value.maxInstances}
            onChange={(e) => set('maxInstances', Math.max(MIN_ROLE_INSTANCES, Number(e.target.value)))}
          />
          {errFor('maxInstances') && <span className="hint error">{errFor('maxInstances')}</span>}
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
          placeholder={role?.effectiveMaxTurns == null
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
        {errFor('repoDir') && <span className="hint error">{errFor('repoDir')}</span>}
      </label>

      <label>Инструкция роли
        <textarea rows={6} value={value.brief} onChange={(e) => set('brief', e.target.value)} />
        <span className="hint">
          Это промпт агента: правка меняет его поведение, а не просто описание для человека.
        </span>
      </label>

      <div className="modal-actions">
        <button className="allow" onClick={save} disabled={!!turnsError || submittedOp !== null}>
          {role ? 'Сохранить' : 'Создать роль'}
        </button>
      </div>

      {role && (
        <div className="role-danger">
          {role.archived ? (
            <button onClick={() => doArchive(false)} disabled={submittedOp !== null}>
              Вернуть роль из архива
            </button>
          ) : (
            <button
              className="link-danger" disabled={archiveDisabled || submittedOp !== null} title={archiveTitle}
              onClick={() => doArchive(true)}
            >
              Убрать в архив
            </button>
          )}
          <button
            className="link-danger" disabled={removeDisabled || submittedOp !== null} title={removeTitle}
            onClick={doRemove}
          >
            Удалить насовсем
          </button>
        </div>
      )}
    </div>
  );
}

/** Спрайт для предпросмотра в списке ролей — тот же выбор, что и в комнате. */
export const roleAvatarSprite = (r: RoleView): string => agentSpriteName(r.id, r.id, r.sprite);

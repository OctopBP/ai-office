import { useEffect, useState } from 'react';
import {
  accessLabel, fullAccessWarning, archiveRole, clearRoleFeedback, createRole,
  parseTaskMaxTurns, removeRole, updateRole, useStore,
} from './store';
import { t } from './i18n';
import { catalog } from './layoutData';
import { desks } from '../shared/layout';
import { agentSpriteName } from './sprites';
import { Icon } from './icons';
import { LookPicker } from './office3d/LookPicker';
import { lookById, LOOKS } from '../shared/looks';
import type { PermissionMode, RoleDraft, RoleEditable, RoleView } from '../shared/types';
import {
  MAX_ROLE_INSTANCES, MAX_TASK_MAX_TURNS, MIN_ROLE_INSTANCES, MIN_TASK_MAX_TURNS,
} from '../shared/types';

const MODEL_IDS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;

const models = (): Array<[string, string]> => [
  ['claude-opus-5', t('role.model.opus')],
  ['claude-sonnet-5', t('role.model.sonnet')],
  ['claude-haiku-4-5', t('role.model.haiku')],
];

const modes = (): Array<[PermissionMode, string]> => [
  ['readonly', accessLabel('readonly')],
  ['ask-writes', accessLabel('ask-writes')],
  ['ask-risky', t('role.mode.default', { mode: accessLabel('ask-risky') })],
  ['auto', accessLabel('auto')],
];

/** Черновик новой роли — умолчания, с которых стартует форма создания. */
const BLANK: RoleEditable = {
  title: '', emoji: '🙂', color: '#94a3b8', model: 'claude-sonnet-5',
  permissionMode: null, maxInstances: 1, isolate: true, maxTurns: null,
  repoDir: '', sprite: LOOKS[0].id, brief: '',
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
    ? t('role.turnsRange', { min: MIN_TASK_MAX_TURNS, max: MAX_TASK_MAX_TURNS })
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
    : role.isManager ? t('role.archive.pm')
    : staffCount > 0 ? t('role.archive.staff', { n: staffCount })
    : t('role.archive.hint');

  const removeDisabled = !role || role.isManager || !role.removable;
  const removeTitle = !role ? ''
    : role.isManager ? t('role.remove.pm')
    : !role.removable ? t('role.remove.hasHistory')
    : t('role.remove.clean');

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

  const officeLabel = accessLabel(settings.officePermissionMode);
  const titleDisabled = Boolean(role?.isManager);

  // Прикидка нехватки мест: столов в текущей раскладке меньше, чем уже
  // сидящих сотрудников, — новый наём в эту (или любую) роль скорее всего
  // не найдёт стола. Точный отказ всё равно придёт от сервера при найме,
  // здесь только заранее спокойно предупреждаем.
  const deskShortage = !role && instanceCount >= desks(layout, catalog).length;

  return (
    <div className="role-form">
      <h3>{role ? t('role.editTitle', { title: role.title }) : t('role.newTitle')}</h3>
      <p className="modal-reason">{t('role.note')}</p>

      {formError && <div className="form-banner error">{formError}</div>}
      {deskShortage && (
        <div className="deskless-notice">
          <Icon name="armchair" size={16} /> {t('role.deskShortage')}
        </div>
      )}

      <label>{t('role.title')}
        <input
          value={value.title} disabled={titleDisabled}
          title={titleDisabled ? t('role.title.pmHint') : undefined}
          onChange={(e) => set('title', e.target.value)}
        />
        {errFor('title') && <span className="hint error">{errFor('title')}</span>}
      </label>

      <label>{t('role.look')}
        <LookPicker value={value.sprite} onPick={(id) => set('sprite', id)} />
        {!lookById(value.sprite) && (
          <span className="hint">{t('role.look.hint')}</span>
        )}
        {errFor('sprite') && <span className="hint error">{errFor('sprite')}</span>}
      </label>

      <label>{t('role.model')}
        <select value={value.model} onChange={(e) => set('model', e.target.value)}>
          {models().map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        {errFor('model') && <span className="hint error">{errFor('model')}</span>}
      </label>

      <label>{t('role.permissions')}
        <select
          value={value.permissionMode ?? ''}
          onChange={(e) => chooseMode(e.target.value === '' ? null : e.target.value as PermissionMode)}
        >
          <option value="">{t('role.asOffice', { mode: officeLabel })}</option>
          {modes().map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <span className="hint">
          {value.permissionMode
            ? t('role.ownRule', { mode: accessLabel(value.permissionMode) })
            : t('role.officeRule', { mode: officeLabel })}
        </span>
      </label>

      {confirmAuto && (
        <div className="access-confirm">
          <p>{fullAccessWarning()}</p>
          <div className="modal-actions">
            <button onClick={() => setConfirmAuto(false)}>{t('common.cancel')}</button>
            <button className="danger" onClick={() => { set('permissionMode', 'auto'); setConfirmAuto(false); }}>
              {t('settings.access.confirm')}
            </button>
          </div>
        </div>
      )}

      <div className="row2">
        <label>{t('role.maxClones')}
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
          {t('role.isolate')}
        </label>
      </div>

      <label>{t('settings.limits.turns')}
        <input
          value={turns}
          placeholder={role?.effectiveMaxTurns == null
            ? t('role.turns.officeUnlimited')
            : t('role.turns.office', { n: role.effectiveMaxTurns })}
          onChange={(e) => setTurns(e.target.value)}
        />
        <span className="hint">{t('role.turns.hint')}</span>
        {turnsError && <span className="hint error">{turnsError}</span>}
      </label>

      <label>{t('role.repo')}
        <input
          value={value.repoDir}
          placeholder={t('role.repo.placeholder')}
          onChange={(e) => set('repoDir', e.target.value)}
        />
        <span className="hint">{t('role.repo.hint')}</span>
        {errFor('repoDir') && <span className="hint error">{errFor('repoDir')}</span>}
      </label>

      <label>{t('role.brief')}
        <textarea rows={6} value={value.brief} onChange={(e) => set('brief', e.target.value)} />
        <span className="hint">{t('role.brief.hint')}</span>
      </label>

      <div className="modal-actions">
        <button className="allow" onClick={save} disabled={!!turnsError || submittedOp !== null}>
          {role ? t('common.save') : t('role.create')}
        </button>
      </div>

      {role && (
        <div className="role-danger">
          {role.archived ? (
            <button onClick={() => doArchive(false)} disabled={submittedOp !== null}>
              {t('role.unarchive')}
            </button>
          ) : (
            <button
              className="link-danger" disabled={archiveDisabled || submittedOp !== null} title={archiveTitle}
              onClick={() => doArchive(true)}
            >
              {t('role.archive')}
            </button>
          )}
          <button
            className="link-danger" disabled={removeDisabled || submittedOp !== null} title={removeTitle}
            onClick={doRemove}
          >
            {t('role.remove')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Спрайт для предпросмотра в списке ролей — тот же выбор, что и в комнате. */
export const roleAvatarSprite = (r: RoleView): string => agentSpriteName(r.id, r.id, r.sprite);

import { CAPABILITIES } from '../shared/workflow';
import { PROVIDERS, PROVIDER_IDS, providerOf, type ProviderId } from '../shared/providers';
import { useEffect, useState } from 'react';
import {
  accessLabel, fullAccessWarning, archiveRole, clearExportResult, clearRoleFeedback, createRole,
  detachRole, exportRole, parseTaskMaxTurns, removeRole, updateRole, useStore,
} from './store';
import { t } from './i18n';
import { catalog } from './layoutData';
import { desks } from '../shared/layout';
import { agentSpriteName } from './sprites';
import { Icon } from './icons';
import { LookPicker } from './office3d/LookPicker';
import { lookById, LOOKS } from '../shared/looks';
import type { PermissionMode, RoleDraft, RoleEditable, RoleView } from '../shared/types';
import { MAX_TASK_MAX_TURNS, MIN_TASK_MAX_TURNS } from '../shared/types';

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
  permissionMode: null, isolate: true, maxTurns: null,
  repoDir: '', sprite: LOOKS[0].id, brief: '', briefExtra: '', mcp: [], capabilities: [],
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
  const [codexModels, setCodexModels] = useState<Array<[string, string]>>([]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/providers/codex', { signal: controller.signal })
      .then(r => r.json()).then(data => setCodexModels((data.models ?? []).map((m: { id: string; label: string }) => [m.id, m.label])))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const [draft, setDraft] = useState<Partial<RoleEditable>>({});
  const [turns, setTurns] = useState(role?.maxTurns?.toString() ?? '');
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [submittedOp, setSubmittedOp] = useState<'create' | 'update' | 'archive' | 'restore' | 'remove' | 'detach' | null>(null);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const exportResult = useStore((s) => s.exportResult);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportName, setExportName] = useState('');
  const [exportDir, setExportDir] = useState('');
  const ownExport = exportResult && role && exportResult.roleId === role.id ? exportResult : null;
  // Итог экспорта читается один раз: закрыли форму — следующее открытие чистое.
  useEffect(() => () => { if (exportResult) clearExportResult(); }, []);
  const [fieldErrors, setFieldErrors] = useState<{ field: string; message: string }[]>([]);

  useEffect(() => {
    if (!roleFeedback || !submittedOp || roleFeedback.op !== submittedOp) return;
    if (submittedOp !== 'create' && roleFeedback.roleId !== (role?.id ?? null)) return;
    setSubmittedOp(null);
    if (roleFeedback.errors.length) { setFieldErrors(roleFeedback.errors); clearRoleFeedback(); return; }
    setFieldErrors([]);
    clearRoleFeedback();
    if (submittedOp === 'remove') onDeleted();
    else if (submittedOp === 'detach') setConfirmDetach(false);
    else if (roleFeedback.roleId) onSaved(roleFeedback.roleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleFeedback]);

  const base = role ?? BLANK;
  const value = { ...base, ...draft };
  // Каталог офиса — из него и берётся, на что подписывать роль. Выключенные
  // серверы показываем тоже: подписка на них законна и заработает, как только
  // сервер включат обратно.
  const servers = settings.mcpServers ?? [];
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
  const doDetach = () => {
    if (!role) return;
    setFieldErrors([]);
    setSubmittedOp('detach');
    detachRole(role.id);
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

      <label>{t('role.provider')}
        <select value={providerOf(value)} onChange={(e) => {
          const provider = e.target.value as ProviderId;
          setDraft(d => ({ ...d, provider, model: PROVIDERS[provider].defaultModel }));
        }}>
          {PROVIDER_IDS.map(id => <option key={id} value={id}>{PROVIDERS[id].label}</option>)}
        </select>
        {errFor('provider') && <span className="hint error">{errFor('provider')}</span>}
      </label>

      <label>{t('role.model')}
        <input list="role-models" value={value.model} onChange={(e) => set('model', e.target.value)} />
        <datalist id="role-models">
          {(providerOf(value) === 'codex' ? [['default', t('role.model.codexDefault')], ...codexModels] : models())
            .map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </datalist>
        {providerOf(value) === 'codex' && <span className="hint">{t('role.codexHint')}</span>}
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

      <label className="checkbox">
        <input
          type="checkbox" checked={value.isolate}
          onChange={(e) => set('isolate', e.target.checked)}
        />
        {t('role.isolate')}
      </label>

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

      <div className="role-mcp">
        <span className="group-title">{t('role.mcp')}</span>
        {servers.length === 0 ? (
          <span className="hint muted">{t('role.mcp.empty')}</span>
        ) : (
          <>
            {servers.map((srv) => (
              <label key={srv.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={value.mcp.includes(srv.id)}
                  onChange={(e) => set('mcp', e.target.checked
                    ? [...value.mcp, srv.id]
                    : value.mcp.filter((id) => id !== srv.id))}
                />
                {srv.title || srv.id}
                {srv.disabled && <span className="muted"> — {t('role.mcp.off')}</span>}
              </label>
            ))}
            <span className="hint">{t('role.mcp.hint')}</span>
          </>
        )}
      </div>

      <div className="role-mcp">
        <span className="group-title">{t('role.capabilities')}</span>
        {CAPABILITIES.map((cap) => (
          <label key={cap} className="checkbox">
            <input
              type="checkbox"
              checked={(value.capabilities ?? []).includes(cap)}
              onChange={(e) => set('capabilities', e.target.checked
                ? [...(value.capabilities ?? []), cap]
                : (value.capabilities ?? []).filter((c) => c !== cap))}
            />
            <span className="mono">{cap}</span>
          </label>
        ))}
        <span className="hint">{t('role.capabilities.hint')}</span>
      </div>

      {role?.package ? (
        // Роль из пакета: бриф пакета только для чтения, своё — припиской.
        // Так обновление пакета никогда не спорит с тем, что дописал человек.
        <>
          <label>{t('role.package.brief')}
            <span className="hint muted">
              {role.package.name} · {t('role.package.version', { version: role.package.version })}
            </span>
            <textarea rows={6} value={role.package.brief} readOnly />
            <span className="hint">{t('role.package.brief.hint')}</span>
          </label>
          <label>{t('role.briefExtra')}
            <textarea rows={4} value={value.briefExtra} onChange={(e) => set('briefExtra', e.target.value)} />
            <span className="hint">{t('role.briefExtra.hint')}</span>
          </label>
        </>
      ) : (
        <label>{t('role.brief')}
          <textarea rows={6} value={value.brief} onChange={(e) => set('brief', e.target.value)} />
          <span className="hint">{t('role.brief.hint')}</span>
        </label>
      )}

      <div className="modal-actions">
        <button className="allow" onClick={save} disabled={!!turnsError || submittedOp !== null}>
          {role ? t('common.save') : t('role.create')}
        </button>
      </div>

      {role && (
        <div className="role-export">
          <button className="link" onClick={() => setExportOpen(!exportOpen)}>{t('role.export')}</button>
          {exportOpen && (
            <>
              <span className="hint">{t('role.export.hint')}</span>
              <div className="row2">
                <label>{t('role.export.name')}
                  <input value={exportName} placeholder={`@me/${role.id}`} onChange={(e) => setExportName(e.target.value)} />
                </label>
                <label>{t('role.export.dir')}
                  <input value={exportDir} placeholder={t('role.export.dir.placeholder', { id: role.id })} onChange={(e) => setExportDir(e.target.value)} />
                </label>
              </div>
              <div className="modal-actions">
                <button className="allow" disabled={!exportName.trim()} onClick={() => { clearExportResult(); exportRole(role.id, exportName, exportDir); }}>
                  {t('role.export.go')}
                </button>
              </div>
              {ownExport?.error && <div className="form-banner error">{ownExport.error}</div>}
              {ownExport && !ownExport.error && (
                <div className="hint">
                  {t('role.export.done', { dir: ownExport.dir })}
                  {ownExport.warnings.length > 0 && (
                    <ul className="market-list muted small">
                      <li>{t('role.export.warnings')}:</li>
                      {ownExport.warnings.map((w) => <li key={w}>{w}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

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
          {role.package && !confirmDetach && (
            <button
              className="link-danger" disabled={submittedOp !== null} title={t('role.detach.hint')}
              onClick={() => setConfirmDetach(true)}
            >
              {t('role.detach')}
            </button>
          )}
          {role.package && confirmDetach && (
            <div className="access-confirm">
              <p>{t('role.detach.hint')}</p>
              <div className="modal-actions">
                <button onClick={() => setConfirmDetach(false)}>{t('common.cancel')}</button>
                <button className="danger" disabled={submittedOp !== null} onClick={doDetach}>
                  {t('role.detach.confirm')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Спрайт для предпросмотра в списке ролей — тот же выбор, что и в комнате. */
export const roleAvatarSprite = (r: RoleView): string => agentSpriteName(r.id, r.sprite);

import { CAPABILITIES } from '../shared/workflow';
import { PROVIDERS, PROVIDER_IDS, providerOf, type ProviderId } from '../shared/providers';
import { useEffect, useState } from 'react';
import {
  accessLabel, fullAccessWarning, clearRoleFeedback, createRole, parseTaskMaxTurns, useStore,
} from './store';
import { has, t } from './i18n';
import { MODEL_IDS } from '../shared/models';
import { catalog } from './layoutData';
import { desks } from '../shared/layout';
import { agentSpriteName } from './sprites';
import { Icon } from './icons';
import { LookPicker } from './office3d/LookPicker';
import { lookById, LOOKS } from '../shared/looks';
import type { PermissionMode, RoleDraft, RoleEditable, RoleView } from '../shared/types';
import { MAX_TASK_MAX_TURNS, MIN_TASK_MAX_TURNS } from '../shared/types';

/**
 * Модели Claude для выпадающего списка — одним списком с сервером
 * (`shared/models.ts`), чтобы новая модель появлялась в форме сама. Подпись
 * ищется по ключу `role.model.<id>`; нет подписи — показывается сам id, это
 * лучше пустой строки в выпадающем списке.
 *
 * Список один для всех ролей. Незнакомый id (вписанный когда-то руками)
 * добавляется отдельной строкой в конец, чтобы форма показала его как есть и не
 * подменила молча на первую модель списка.
 */
const models = (current: string): Array<[string, string]> => {
  const list = MODEL_IDS.map((id): [string, string] => {
    const key = `role.model.${id}`;
    return [id, has(key) ? t(key) : id];
  });
  return current && !MODEL_IDS.includes(current) ? [...list, [current, current]] : list;
};

const modes = (): Array<[PermissionMode, string]> => [
  ['readonly', accessLabel('readonly')],
  ['ask-writes', accessLabel('ask-writes')],
  ['ask-risky', t('role.mode.default', { mode: accessLabel('ask-risky') })],
  ['auto', accessLabel('auto')],
];

/** Черновик новой роли — умолчания, с которых стартует форма создания. */
const BLANK: RoleEditable = {
  title: '', emoji: '🙂', color: '#94a3b8', model: 'claude-sonnet-5-5',
  permissionMode: null, isolate: true, maxTurns: null,
  repoDir: '', sprite: LOOKS[0].id, brief: '', briefExtra: '', mcp: [], capabilities: [],
};

/**
 * Форма новой роли. Правка существующей живёт на странице агента
 * (`AgentSettings`) и сохраняется сама; здесь автосохранение неприменимо —
 * сущности ещё нет, поэтому создание идёт явной кнопкой. Сервер гоняет
 * черновик через ту же проверку полей, что и правку (checkRolePatch).
 */
export function RoleEditor({ onCreated }: { onCreated: (roleId: string) => void }) {
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
  const [value, setValue] = useState<RoleEditable>(BLANK);
  const [turns, setTurns] = useState('');
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ field: string; message: string }[]>([]);

  useEffect(() => {
    if (!roleFeedback || !submitted || roleFeedback.op !== 'create') return;
    setSubmitted(false);
    clearRoleFeedback();
    setFieldErrors(roleFeedback.errors);
    if (!roleFeedback.errors.length && roleFeedback.roleId) onCreated(roleFeedback.roleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleFeedback]);

  const servers = settings.mcpServers ?? [];
  const set = <K extends keyof RoleEditable>(k: K, v: RoleEditable[K]) =>
    setValue((d) => ({ ...d, [k]: v }));

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

  const create = () => {
    if (turnsError) return;
    setFieldErrors([]);
    const draftRole: RoleDraft = { ...value, maxTurns: turnsParsed.value };
    setSubmitted(true);
    createRole(draftRole);
  };

  const officeLabel = accessLabel(settings.officePermissionMode);
  // Прикидка нехватки мест: столов в текущей раскладке меньше, чем уже
  // сидящих сотрудников, — новый наём скорее всего не найдёт стола. Точный
  // отказ всё равно придёт от сервера при найме, здесь только предупреждаем.
  const deskShortage = instanceCount >= desks(layout, catalog).length;

  return (
    <div className="role-form">
      <h3>{t('role.newTitle')}</h3>

      {formError && <div className="form-banner error">{formError}</div>}
      {deskShortage && (
        <div className="deskless-notice">
          <Icon name="armchair" size={16} /> {t('role.deskShortage')}
        </div>
      )}

      <label>{t('role.title')}
        <input value={value.title} onChange={(e) => set('title', e.target.value)} />
        {errFor('title') && <span className="hint error">{errFor('title')}</span>}
      </label>

      <label>{t('role.look')}
        <LookPicker value={value.sprite} onPick={(id) => set('sprite', id)} />
        {!lookById(value.sprite) && <span className="hint">{t('role.look.hint')}</span>}
        {errFor('sprite') && <span className="hint error">{errFor('sprite')}</span>}
      </label>

      <label>{t('role.provider')}
        <select value={providerOf(value)} onChange={(e) => {
          const provider = e.target.value as ProviderId;
          setValue(d => ({ ...d, provider, model: PROVIDERS[provider].defaultModel }));
        }}>
          {PROVIDER_IDS.map(id => <option key={id} value={id}>{PROVIDERS[id].label}</option>)}
        </select>
        {errFor('provider') && <span className="hint error">{errFor('provider')}</span>}
      </label>

      <label>{t('role.model')}
        {providerOf(value) === 'codex' ? (
          <>
            <input list="role-models" value={value.model} onChange={(e) => set('model', e.target.value)} />
            <datalist id="role-models">
              {[['default', t('role.model.codexDefault')], ...codexModels]
                .map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </datalist>
            <span className="hint">{t('role.codexHint')}</span>
          </>
        ) : (
          <select value={value.model} onChange={(e) => set('model', e.target.value)}>
            {models(value.model).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        )}
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
        <input type="checkbox" checked={value.isolate} onChange={(e) => set('isolate', e.target.checked)} />
        {t('role.isolate')}
      </label>

      <label>{t('settings.limits.turns')}
        <input value={turns} placeholder={t('role.turns.officeUnlimited')} onChange={(e) => setTurns(e.target.value)} />
        <span className="hint">{t('role.turns.hint')}</span>
        {turnsError && <span className="hint error">{turnsError}</span>}
      </label>

      <label>{t('role.repo')}
        <input value={value.repoDir} placeholder={t('role.repo.placeholder')} onChange={(e) => set('repoDir', e.target.value)} />
        <span className="hint">{t('role.repo.hint')}</span>
        {errFor('repoDir') && <span className="hint error">{errFor('repoDir')}</span>}
      </label>

      <div className="role-mcp">
        <span className="group-title">{t('role.mcp')}</span>
        {servers.length === 0 ? (
          <span className="hint muted">{t('role.mcp.empty')}</span>
        ) : servers.map((srv) => (
          <label key={srv.id} className="checkbox">
            <input
              type="checkbox"
              checked={value.mcp.includes(srv.id)}
              onChange={(e) => set('mcp', e.target.checked ? [...value.mcp, srv.id] : value.mcp.filter((id) => id !== srv.id))}
            />
            {srv.title || srv.id}
            {srv.disabled && <span className="muted"> — {t('role.mcp.off')}</span>}
          </label>
        ))}
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

      <label>{t('role.brief')}
        <textarea rows={6} value={value.brief} onChange={(e) => set('brief', e.target.value)} />
        <span className="hint">{t('role.brief.hint')}</span>
      </label>

      <div className="modal-actions">
        <button className="allow" onClick={create} disabled={!!turnsError || submitted}>
          {t('role.create')}
        </button>
      </div>
    </div>
  );
}

/** Спрайт для предпросмотра в списке ролей — тот же выбор, что и в комнате. */
export const roleAvatarSprite = (r: RoleView): string => agentSpriteName(r.id, r.sprite);

import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CAPABILITIES } from '../shared/workflow';
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '../shared/providers';
import { MODEL_IDS } from '../shared/models';
import { lookById } from '../shared/looks';
import {
  accessLabel, clearExportResult, exportRole, fire, fullAccessWarning, marketUpdate, openLayoutSettings,
  permissionSource, permissionSourceLabel, useStore,
} from './store';
import { has, t, type UiKey } from './i18n';
import { Icon } from './icons';
import { LookPicker } from './office3d/LookPicker';
import { RoleReport } from './RoleReport';
import { usageLine, usageMoney } from './money';
import type { AgentAutosave, AgentField } from './useAgentAutosave';
import type { InstanceView, MarketPackageView, PermissionMode, RoleView } from '../shared/types';

/**
 * Панели вкладок страницы агента (спека docs/design/T-151/spec.md, §3).
 * Здесь только разметка: когда и что уходит на сервер, решает
 * `useAgentAutosave`, панели зовут его `edit`/`commit`/`set`.
 */

export interface PanelProps {
  save: AgentAutosave;
  role: RoleView;
  inst: InstanceView;
  /** Сотрудник занят задачей: правки части полей подействуют со следующей. */
  busy: boolean;
}

const PERM_OPTIONS: PermissionMode[] = ['readonly', 'ask-writes', 'ask-risky', 'auto'];

/** Модели Claude одним списком с сервером; незнакомый id — отдельной строкой, чтобы не подменить молча. */
const claudeModels = (current: string): Array<[string, string]> => {
  const list = MODEL_IDS.map((id): [string, string] => {
    const key = `role.model.${id}`;
    return [id, has(key) ? t(key) : id];
  });
  return current && !MODEL_IDS.includes(current) ? [...list, [current, current]] : list;
};

// ------------------------------------------------------------- общие детали поля

/** Подпись поля: пометка занятости и короткое «Сохранено ✓» после записи. */
function FieldLabel({ text, save, f, when, busy }: {
  text: string; save: AgentAutosave; f: AgentField; when?: 'next' | 'now'; busy?: boolean;
}) {
  const state = save.field(f);
  return (
    <span className="field-label">
      {text}
      {busy && when && <span className="chip field-chip">{t(when === 'next' ? 'agent.busy.next' : 'agent.busy.now')}</span>}
      {state.justSaved && <span className="field-saved" aria-hidden="true">{t('agent.save.justSaved')} ✓</span>}
    </span>
  );
}

function FieldError({ save, f }: { save: AgentAutosave; f: AgentField }) {
  const error = save.field(f).error;
  return error ? <span className="hint error">{error}</span> : null;
}

/** Поле, которое сохраняется по выходу или Enter; Esc возвращает прежнее. */
function blurField(save: AgentAutosave, f: AgentField) {
  return {
    value: String(save.value(f) ?? ''),
    'aria-invalid': Boolean(save.field(f).error),
    className: save.field(f).error ? 'invalid' : undefined,
    onChange: (e: { target: { value: string } }) => save.edit(f, e.target.value),
    onBlur: () => save.commit(f),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') { e.preventDefault(); save.commit(f); }
      if (e.key === 'Escape') { e.stopPropagation(); save.cancel(f); (e.target as HTMLInputElement).blur(); }
    },
  };
}

/** Инлайн-подтверждение опасного шага — существующий блок `.access-confirm`. */
function Confirm({ text, yes, onYes, onNo, disabled }: {
  text: string; yes: string; onYes: () => void; onNo: () => void; disabled?: boolean;
}) {
  return (
    <div className="access-confirm">
      <p>{text}</p>
      <div className="modal-actions">
        <button onClick={onNo}>{t('common.cancel')}</button>
        <button className="danger" disabled={disabled} onClick={onYes}>{yes}</button>
      </div>
    </div>
  );
}

function Section({ title, children, danger }: { title: string; children: ReactNode; danger?: boolean }) {
  return (
    <section className={`agent-section${danger ? ' danger-zone' : ''}`}>
      <h4 className="section-title">{title}</h4>
      {children}
    </section>
  );
}

// ------------------------------------------------------------- «Профиль»

export function ProfilePanel({ save, role, inst, busy }: PanelProps) {
  const [confirm, setConfirm] = useState<'fire' | 'remove' | null>(null);
  const title = blurField(save, 'title');
  const name = blurField(save, 'name');
  const staff = role.active;
  const failed = save.actionFailed && save.actionFailed.op !== 'detach' ? save.actionFailed.errors : [];
  const actionError = failed.find((e) => e.field === '')?.message ?? failed[0]?.message;
  const pending = save.actionPending !== null;

  return (
    <>
      {inst.deskless && (
        <div className="deskless-notice">
          <Icon name="armchair" size={16} /> {t('employee.deskless', { index: inst.desk.index })}{' '}
          <button className="link" onClick={openLayoutSettings}>{t('employee.layoutSettings')}</button>
        </div>
      )}

      <Section title={t('agent.section.identity')}>
        <label>
          <FieldLabel text={t('agent.field.name')} save={save} f="name" />
          <input {...name} placeholder={t('employee.namePlaceholder')} />
          <span className="hint">{t('employee.nameHint.empty')}. {t('agent.hint.onBlur')}</span>
          <FieldError save={save} f="name" />
        </label>
        <label>
          <FieldLabel text={t('role.title')} save={save} f="title" />
          <input {...title} disabled={role.isManager} />
          {role.isManager
            ? <span className="hint">{t('role.title.pmHint')}</span>
            : <span className="hint">{t('agent.hint.onBlur')}</span>}
          <FieldError save={save} f="title" />
        </label>
        <div className="agent-field">
          <FieldLabel text={t('role.look')} save={save} f="sprite" />
          <LookPicker value={save.value<string>('sprite')} onPick={(id) => save.set({ sprite: id })} />
          {!lookById(save.value<string>('sprite')) && <span className="hint">{t('role.look.hint')}</span>}
          <FieldError save={save} f="sprite" />
        </div>
      </Section>

      <Section title={t('agent.section.desk')}>
        <p className="muted small">
          {inst.deskless ? t('employee.noDesk') : t('employee.deskNo', { index: inst.desk.index })}{' '}
          <button className="link" onClick={openLayoutSettings}>{t('employee.layoutSettings')}</button>
        </p>
      </Section>

      {role.isManager ? (
        <p className="hint muted">{t('employee.pmCannotFire')}</p>
      ) : (
        <Section title={t('agent.danger.title')} danger>
          {actionError && <div className="form-banner error">{actionError}</div>}
          <div className="danger-action">
            {confirm === 'fire' ? (
              <Confirm
                text={t('agent.confirm.fire', { name: inst.label })} yes={t('agent.confirm.fire.yes')}
                onNo={() => setConfirm(null)} onYes={() => { setConfirm(null); fire(inst.id); }} disabled={busy}
              />
            ) : (
              <button className="link-danger" disabled={busy} onClick={() => setConfirm('fire')}>{t('employee.fire')}</button>
            )}
            {busy && <span className="hint">{t('employee.busyHint', { task: inst.currentTaskId ?? '' })}</span>}
          </div>
          <div className="danger-action">
            {role.archived ? (
              <button disabled={pending} onClick={() => save.act('restore')}>{t('role.unarchive')}</button>
            ) : (
              <button className="link-danger" disabled={staff > 0 || pending} onClick={() => save.act('archive')}>
                {t('role.archive')}
              </button>
            )}
            <span className="hint">
              {role.archived ? '' : staff > 0 ? t('agent.archive.blocked') : t('role.archive.hint')}
            </span>
          </div>
          <div className="danger-action">
            {confirm === 'remove' ? (
              <Confirm
                text={t('agent.confirm.remove', { title: role.title })} yes={t('agent.confirm.remove.yes')}
                onNo={() => setConfirm(null)} onYes={() => { setConfirm(null); save.act('remove'); }} disabled={pending}
              />
            ) : (
              <button className="link-danger" disabled={!role.removable || pending} onClick={() => setConfirm('remove')}>
                {t('role.remove')}
              </button>
            )}
            <span className="hint">{role.removable ? t('role.remove.clean') : t('role.remove.hasHistory')}</span>
          </div>
        </Section>
      )}
    </>
  );
}

// ------------------------------------------------------------- «Модель и работа»

export function ModelPanel({ save, role, busy }: PanelProps) {
  const [codexModels, setCodexModels] = useState<Array<[string, string]>>([]);
  const [modelReset, setModelReset] = useState<string | null>(null);
  const [confirmIsolate, setConfirmIsolate] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/providers/codex', { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => setCodexModels((data.models ?? []).map((m: { id: string; label: string }) => [m.id, m.label])))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const provider = save.value<ProviderId>('provider');
  const model = save.value<string>('model');
  const turns = blurField(save, 'maxTurns');
  const repo = blurField(save, 'repoDir');
  const checkingRepo = save.field('repoDir').saving;

  return (
    <>
      <Section title={t('agent.section.model')}>
        <label>
          <FieldLabel text={t('role.provider')} save={save} f="provider" when="next" busy={busy} />
          <select value={provider} onChange={(e) => {
            const next = e.target.value as ProviderId;
            const reset = PROVIDERS[next].defaultModel;
            // Провайдер и модель — одним патчем: сервер без модели всё равно
            // сбросил бы её на умолчание, а форма показывает это сразу.
            save.set({ provider: next, model: reset });
            setModelReset(reset);
          }}>
            {PROVIDER_IDS.map((id) => <option key={id} value={id}>{PROVIDERS[id].label}</option>)}
          </select>
          {modelReset && <span className="hint">{t('agent.model.reset', { model: modelReset })}</span>}
          <FieldError save={save} f="provider" />
        </label>

        <label>
          <FieldLabel text={t('role.model')} save={save} f="model" when="next" busy={busy} />
          {provider === 'codex' ? (
            <>
              <input list="agent-models" {...blurField(save, 'model')} />
              <datalist id="agent-models">
                {[['default', t('role.model.codexDefault')], ...codexModels]
                  .map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </datalist>
              <span className="hint">{t('role.codexHint')}</span>
            </>
          ) : (
            <select value={model} onChange={(e) => { setModelReset(null); save.set({ model: e.target.value }); }}>
              {claudeModels(model).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          )}
          <FieldError save={save} f="model" />
        </label>

        <label>
          <FieldLabel text={t('settings.limits.turns')} save={save} f="maxTurns" when="next" busy={busy} />
          <input
            {...turns} inputMode="numeric"
            placeholder={role.effectiveMaxTurns == null
              ? t('role.turns.officeUnlimited')
              : t('role.turns.office', { n: role.effectiveMaxTurns })}
          />
          <span className="hint">{t('role.turns.hint')}</span>
          <FieldError save={save} f="maxTurns" />
        </label>
      </Section>

      <Section title={t('agent.section.code')}>
        <label>
          <FieldLabel text={t('role.repo')} save={save} f="repoDir" when="next" busy={busy} />
          <input {...repo} placeholder={t('role.repo.placeholder')} />
          {checkingRepo && (
            <span className="hint save-status"><span className="spinner" /> {t('agent.save.checking')}</span>
          )}
          <span className="hint">{t('role.repo.hint')}</span>
          {busy && <span className="hint">{t('agent.busy.repoNote')}</span>}
          <FieldError save={save} f="repoDir" />
        </label>

        <label className="checkbox">
          <input
            type="checkbox" checked={save.value<boolean>('isolate')}
            onChange={(e) => {
              // Выключение — с подтверждением: без ветки агент правит общую копию.
              if (!e.target.checked) { setConfirmIsolate(true); return; }
              setConfirmIsolate(false);
              save.set({ isolate: true });
            }}
          />
          <FieldLabel text={t('role.isolate')} save={save} f="isolate" when="next" busy={busy} />
        </label>
        <span className="hint">{t('agent.isolate.hint')}</span>
        <FieldError save={save} f="isolate" />
        {confirmIsolate && (
          <Confirm
            text={t('agent.confirm.isolate')} yes={t('agent.confirm.isolate.yes')}
            onNo={() => setConfirmIsolate(false)}
            onYes={() => { setConfirmIsolate(false); save.set({ isolate: false }); }}
          />
        )}
      </Section>
    </>
  );
}

// ------------------------------------------------------------- «Доступ и инструменты»

export function AccessPanel({ save, role, inst, busy }: PanelProps) {
  const settings = useStore((s) => s.settings);
  const [confirmAuto, setConfirmAuto] = useState<'permissionMode' | 'personalMode' | null>(null);
  const officeLabel = accessLabel(settings.officePermissionMode);
  const roleMode = save.value<PermissionMode | null>('permissionMode');
  const personal = save.value<PermissionMode | null>('personalMode');
  const roleFallback = accessLabel(roleMode ?? settings.officePermissionMode);
  const effective: PermissionMode = personal ?? roleMode ?? settings.officePermissionMode;
  const source = permissionSource({ permissionMode: personal }, { permissionMode: roleMode });
  const servers = settings.mcpServers ?? [];
  const mcp = save.value<string[]>('mcp');
  const caps = save.value<string[]>('capabilities');

  // Полный доступ действует сразу, даже посреди задачи, — поэтому только
  // после подтверждения; обратно, на более строгий режим, — без вопросов.
  const choose = (f: 'permissionMode' | 'personalMode', raw: string) => {
    const mode = raw === '' ? null : raw as PermissionMode;
    if (mode === 'auto') { setConfirmAuto(f); return; }
    setConfirmAuto(null);
    save.set({ [f]: mode });
  };

  return (
    <>
      <Section title={t('agent.section.access')}>
        <label>
          <FieldLabel text={t('role.permissions')} save={save} f="permissionMode" when="now" busy={busy} />
          <select value={roleMode ?? ''} onChange={(e) => choose('permissionMode', e.target.value)}>
            <option value="">{t('role.asOffice', { mode: officeLabel })}</option>
            <option value="readonly">{accessLabel('readonly')}</option>
            <option value="ask-writes">{accessLabel('ask-writes')}</option>
            <option value="ask-risky">{t('role.mode.default', { mode: accessLabel('ask-risky') })}</option>
            <option value="auto">{accessLabel('auto')}</option>
          </select>
          <FieldError save={save} f="permissionMode" />
        </label>
        {confirmAuto === 'permissionMode' && (
          <Confirm
            text={fullAccessWarning()} yes={t('settings.access.confirm')} onNo={() => setConfirmAuto(null)}
            onYes={() => { setConfirmAuto(null); save.set({ permissionMode: 'auto' }); }}
          />
        )}

        <label>
            <FieldLabel text={t('employee.personalMode')} save={save} f="personalMode" when="now" busy={busy} />
            <select value={personal ?? ''} onChange={(e) => choose('personalMode', e.target.value)}>
              <option value="">{t('employee.asRole', { mode: roleFallback })}</option>
              {PERM_OPTIONS.map((m) => <option key={m} value={m}>{accessLabel(m)}</option>)}
            </select>
            <FieldError save={save} f="personalMode" />
          </label>
        {confirmAuto === 'personalMode' && (
          <Confirm
            text={fullAccessWarning()} yes={t('settings.access.confirm')} onNo={() => setConfirmAuto(null)}
            onYes={() => { setConfirmAuto(null); save.set({ personalMode: 'auto' }); }}
          />
        )}

        <span className={`perm-badge ${effective}`}>
          <Icon name={effective === 'auto' ? 'lock-open' : 'shield-lock'} size={14} />{' '}
          {t('agent.access.effective', { mode: accessLabel(effective), source: permissionSourceLabel(source) })}
        </span>
        <span className="hint">{t('agent.access.chain')}</span>
      </Section>

      <Section title={t('agent.section.tools')}>
        {busy && <span className="chip field-chip">{t('agent.busy.next')}</span>}
        {servers.length === 0 ? (
          <span className="hint muted">{t('role.mcp.empty')}</span>
        ) : (
          <>
            {servers.map((srv) => (
              <label key={srv.id} className="checkbox">
                <input
                  type="checkbox" checked={mcp.includes(srv.id)}
                  onChange={(e) => save.set({ mcp: e.target.checked ? [...mcp, srv.id] : mcp.filter((id) => id !== srv.id) })}
                />
                {srv.title || srv.id}
                {srv.disabled && <span className="muted"> — {t('role.mcp.off')}</span>}
              </label>
            ))}
            <span className="hint">{t('role.mcp.hint')}</span>
          </>
        )}
        <FieldError save={save} f="mcp" />
      </Section>

      <Section title={t('agent.section.skills')}>
        {busy && <span className="chip field-chip">{t('agent.busy.next')}</span>}
        {CAPABILITIES.map((cap) => (
          <label key={cap} className="checkbox">
            <input
              type="checkbox" checked={caps.includes(cap)}
              onChange={(e) => save.set({ capabilities: e.target.checked ? [...caps, cap] : caps.filter((c) => c !== cap) })}
            />
            <span className="mono">{cap}</span>
          </label>
        ))}
        <span className="hint">{t('role.capabilities.hint')}</span>
        <FieldError save={save} f="capabilities" />
      </Section>
    </>
  );
}

// ------------------------------------------------------------- «Инструкция»

/** Длинный текст: сохраняется сам через паузу, страховка — «Вернуть как было при открытии». */
function LongText({ save, f, label, hint, busy }: {
  save: AgentAutosave; f: 'brief' | 'briefExtra'; label: UiKey; hint: UiKey; busy: boolean;
}) {
  const value = String(save.value(f) ?? '');
  const opened = String(save.opened(f) ?? '');
  return (
    <label>
      <FieldLabel text={t(label)} save={save} f={f} when="next" busy={busy} />
      <textarea
        rows={f === 'brief' ? 10 : 5} value={value}
        className={save.field(f).error ? 'invalid' : undefined}
        onChange={(e) => save.type(f, e.target.value)}
        onBlur={() => save.commit(f)}
      />
      <span className="hint">{t(hint)} {t('agent.hint.typing')}</span>
      {value !== opened && (
        <button type="button" className="link" onClick={() => save.set({ [f]: opened })}>{t('agent.save.revert')}</button>
      )}
      <FieldError save={save} f={f} />
    </label>
  );
}

export function BriefPanel({ save, role, busy, packages, marketBusy, act }: PanelProps & {
  packages: MarketPackageView[];
  marketBusy: boolean;
  act: (fn: () => void) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportName, setExportName] = useState('');
  const [exportDir, setExportDir] = useState('');
  const exportResult = useStore((s) => s.exportResult);
  const ownExport = exportResult && exportResult.roleId === role.id ? exportResult : null;
  // Итог экспорта читается один раз: закрыли вкладку — следующее открытие чистое.
  useEffect(() => () => { if (useStore.getState().exportResult) clearExportResult(); }, []);
  useEffect(() => { if (save.actionDone === 'detach') setConfirmDetach(false); }, [save.actionDone]);

  const link = role.package;
  const pkg = link ? packages.find((p) => p.name === link.name) : undefined;
  const updateTo = pkg?.roles.find((r) => r.id === role.id)?.updateTo ?? null;
  const detachError = save.actionFailed?.op === 'detach' ? save.actionFailed.errors[0]?.message : null;

  return (
    <>
      <Section title={t('agent.section.brief')}>
        {link ? (
          // Роль из пакета: бриф пакета только для чтения, своё — припиской.
          // Так обновление пакета никогда не спорит с тем, что дописал человек.
          <>
            <div className="agent-field">
              <span className="field-label">{t('role.package.brief')}</span>
              <textarea rows={showAll ? 20 : 6} value={link.brief} readOnly />
              <button type="button" className="link" onClick={() => setShowAll(!showAll)}>
                {t(showAll ? 'agent.brief.hideAll' : 'agent.brief.showAll')}
              </button>
              <span className="hint">{t('role.package.brief.hint')}</span>
            </div>
            <LongText save={save} f="briefExtra" label="role.briefExtra" hint="role.briefExtra.hint" busy={busy} />
          </>
        ) : (
          <LongText save={save} f="brief" label="role.brief" hint="role.brief.hint" busy={busy} />
        )}
      </Section>

      <Section title={t('agent.section.package')}>
        {link && (
          <div className="team-package-line">
            <span className="market-emoji" style={{ background: pkg?.color || 'var(--film-2)' }}>{pkg?.emoji || '📦'}</span>
            <span className="team-package-text">
              <b>{pkg?.title || link.name}</b>
              <span className="muted small"> {link.name} · {t('market.version', { version: link.version })}</span>
            </span>
            {updateTo && (
              <button className="mini go" disabled={marketBusy} onClick={() => act(() => marketUpdate(role.id))}>
                {t('market.update', { version: updateTo })}
              </button>
            )}
          </div>
        )}

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

        {link && (
          <div className="role-danger">
            {confirmDetach ? (
              <Confirm
                text={t('role.detach.hint')} yes={t('role.detach.confirm')} disabled={save.actionPending !== null}
                onNo={() => setConfirmDetach(false)} onYes={() => save.act('detach')}
              />
            ) : (
              <button className="link-danger" disabled={save.actionPending !== null} onClick={() => setConfirmDetach(true)}>
                {t('role.detach')}
              </button>
            )}
            {detachError && <span className="hint error">{detachError}</span>}
          </div>
        )}
      </Section>
    </>
  );
}

// ------------------------------------------------------------- «Результаты»

export function ResultsPanel({ role, inst }: PanelProps) {
  return (
    <>
      {/* У менеджера табеля нет — он не берёт задачи, остаются расходы. */}
      {!role.isManager && <RoleReport roleId={role.id} />}
      <Section title={t('agent.section.spend')}>
        <div className="usage-lines">
          <div>
            <b>{usageMoney(inst.today)}</b> {t('usage.forToday')} ·{' '}
            <span className="muted">{usageLine(inst.today)}</span>
          </div>
          <div className="muted">
            {usageMoney(inst.usage)} {t('usage.forAllTime')} · {usageLine(inst.usage)}
          </div>
        </div>
      </Section>
    </>
  );
}

import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CAPABILITIES } from '../shared/workflow';
import { PROVIDERS, PROVIDER_IDS, isConnected, type ProviderId } from '../shared/providers';
import { lookById } from '../shared/looks';
import {
  accessLabel, clearExportResult, exportRole, fire, fullAccessWarning, marketUpdate, openLayoutSettings,
  openProviderSettings, permissionSource, permissionSourceLabel, useStore,
} from './store';
import { has, t, type UiKey } from './i18n';
import { Icon } from './icons';
import { LookPicker } from './office3d/LookPicker';
import { RoleReport } from './RoleReport';
import { ProviderOptions, freeModel, modelOptions, providerLabel, useProviderModels } from './ProviderPick';
import { usageLine, usageMoney } from './money';
import type { AgentAutosave, AgentField } from './useAgentAutosave';
import type { InstanceView, MarketPackageView, PermissionMode, ProviderView, RoleView } from '../shared/types';

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

/** Пустой список провайдеров одной ссылкой: новый массив на каждый вызов селектора перерисовывал бы форму. */
const NO_PROVIDERS: ProviderView[] = [];

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
  return error ? <span className="form-hint error">{error}</span> : null;
}

/** Строка шаблона `.form-row`: подпись с подсказкой слева, поле справа. `wide` — длинный текст под подписью во всю ширину. */
function Row({ id, label, hint, wide, children }: {
  id?: string; label: ReactNode; hint?: ReactNode; wide?: boolean; children: ReactNode;
}) {
  return (
    <div className={`form-row${wide ? ' agent-row-wide' : ''}`}>
      <div className="form-row-label">
        <label htmlFor={id}>{label}</label>
        {hint && <span className="form-hint">{hint}</span>}
      </div>
      <div className="form-row-control">{children}</div>
    </div>
  );
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

/** Группа шаблона `.form-section`; опасная — с красным заголовком, как в настройках офиса. */
function Section({ title, desc, badge, children, danger }: {
  title: string; desc?: ReactNode; badge?: ReactNode; children: ReactNode; danger?: boolean;
}) {
  return (
    <section className={`form-section${danger ? ' form-section-danger' : ''}`}>
      <header className="form-section-head">
        <h3 className="form-section-title">{title}{badge}</h3>
        {desc && <p className="form-section-desc">{desc}</p>}
      </header>
      <div className="form-rows">{children}</div>
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
      <Section title={t('agent.section.identity')}>
        <Row
          id="agent-name" label={<FieldLabel text={t('agent.field.name')} save={save} f="name" />}
          hint={`${t('employee.nameHint.empty')}. ${t('agent.hint.onBlur')}`}
        >
          <input id="agent-name" {...name} placeholder={t('employee.namePlaceholder')} />
          <FieldError save={save} f="name" />
        </Row>
        <Row
          id="agent-title" label={<FieldLabel text={t('role.title')} save={save} f="title" />}
          hint={role.isManager ? t('role.title.pmHint') : t('agent.hint.onBlur')}
        >
          <input id="agent-title" {...title} disabled={role.isManager} />
          <FieldError save={save} f="title" />
        </Row>
        <Row
          label={<FieldLabel text={t('role.look')} save={save} f="sprite" />}
          hint={lookById(save.value<string>('sprite')) ? undefined : t('role.look.hint')}
          wide
        >
          <LookPicker value={save.value<string>('sprite')} onPick={(id) => save.set({ sprite: id })} />
          <FieldError save={save} f="sprite" />
        </Row>
      </Section>

      <Section title={t('agent.section.desk')}>
        <div className="muted small">
          {inst.deskless ? t('employee.noDesk') : t('employee.deskNo', { index: inst.desk.index })}{' '}
          <button className="link" onClick={openLayoutSettings}>{t('employee.layoutSettings')}</button>
        </div>
      </Section>

      {role.isManager ? (
        <Section title={t('agent.danger.title')} danger>
          <span className="form-hint">{t('employee.pmCannotFire')}</span>
        </Section>
      ) : (
        <Section title={t('agent.danger.title')} danger>
          {actionError && <div className="form-banner error">{actionError}</div>}
          <div>
            {confirm === 'fire' ? (
              <Confirm
                text={t('agent.confirm.fire', { name: inst.label })} yes={t('agent.confirm.fire.yes')}
                onNo={() => setConfirm(null)} onYes={() => { setConfirm(null); fire(inst.id); }} disabled={busy}
              />
            ) : (
              <button className="link-danger" disabled={busy} onClick={() => setConfirm('fire')}>{t('employee.fire')}</button>
            )}
            {busy && <span className="form-hint">{t('employee.busyHint', { task: inst.currentTaskId ?? '' })}</span>}
          </div>
          <div>
            {role.archived ? (
              <button disabled={pending} onClick={() => save.act('restore')}>{t('role.unarchive')}</button>
            ) : (
              <button className="link-danger" disabled={staff > 0 || pending} onClick={() => save.act('archive')}>
                {t('role.archive')}
              </button>
            )}
            {!role.archived && (
              <span className="form-hint">{staff > 0 ? t('agent.archive.blocked') : t('role.archive.hint')}</span>
            )}
          </div>
          <div>
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
            <span className="form-hint">{role.removable ? t('role.remove.clean') : t('role.remove.hasHistory')}</span>
          </div>
        </Section>
      )}
    </>
  );
}

// ------------------------------------------------------------- «Модель и работа»

export function ModelPanel({ save, role, busy }: PanelProps) {
  const [modelReset, setModelReset] = useState<string | null>(null);
  const [confirmIsolate, setConfirmIsolate] = useState(false);
  const providers = useStore((s) => s.providers?.providers ?? NO_PROVIDERS);
  const office = useStore((s) => s.settings.model);
  const cloud = useStore((s) => s.settings.engine === 'cloud');

  // Без своего выбора роль показывает «Как у офиса»: провайдер и модель в
  // `RoleView` уже разрешены в пару офиса, и выбрать их явно — значит
  // закрепить роль на них даже после смены провайдера офиса.
  const own = save.value<boolean>('ownModel');
  const provider = save.value<ProviderId>('provider');
  const model = save.value<string>('model');
  const models = useProviderModels(provider);
  const status = providers.find((p) => p.id === provider)?.status;
  const turns = blurField(save, 'maxTurns');
  const repo = blurField(save, 'repoDir');
  const checkingRepo = save.field('repoDir').saving;

  const resetToOffice = () => {
    setModelReset(null);
    save.cancel('provider');
    save.cancel('model');
    save.set({ ownModel: false });
  };
  const pickProvider = (value: string) => {
    if (!value) { resetToOffice(); return; }
    const next = value as ProviderId;
    // Модель другого провайдера новому ничего не говорит — сбрасываем на его
    // умолчание. Провайдер и модель уходят одним патчем, и форма видит это сразу.
    const reset = next === provider ? model : PROVIDERS[next].defaultModel;
    save.set({ provider: next, model: reset, ownModel: true });
    setModelReset(next === provider ? null : reset);
  };
  const pickModel = (value: string) => {
    setModelReset(null);
    if (!value) resetToOffice();
    else save.set({ provider, model: value, ownModel: true });
  };

  return (
    <>
      <Section title={t('agent.section.model')} desc={t('providers.role.desc')}>
        <Row id="agent-provider" label={<FieldLabel text={t('providers.role.provider')} save={save} f="provider" when="next" busy={busy} />}>
          <select id="agent-provider" value={own ? provider : ''} onChange={(e) => pickProvider(e.target.value)}>
            <option value="">{t('providers.role.asOffice', { name: providerLabel(providers, office.provider) })}</option>
            {providers.length
              ? <ProviderOptions providers={providers} opts={{ manager: role.isManager, cloud }} />
              : PROVIDER_IDS.map((id) => <option key={id} value={id}>{PROVIDERS[id].label}</option>)}
          </select>
          {own && (
            <span className="form-hint">
              <button type="button" className="link" onClick={resetToOffice}>{t('providers.role.reset')}</button>
            </span>
          )}
          {modelReset && <span className="form-hint">{t('agent.model.reset', { model: modelReset })}</span>}
          <FieldError save={save} f="provider" />
        </Row>

        <Row
          id="agent-model" label={<FieldLabel text={t('providers.role.model')} save={save} f="model" when="next" busy={busy} />}
          hint={freeModel(provider) ? t('role.codexHint') : undefined}
        >
          {freeModel(provider) ? (
            <>
              <input id="agent-model" list="agent-models" {...blurField(save, 'model')} />
              <datalist id="agent-models">
                {modelOptions(provider, models, '').map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </datalist>
            </>
          ) : (
            <select id="agent-model" value={own ? model : ''} onChange={(e) => pickModel(e.target.value)}>
              {!own && <option value="">{t('providers.role.asOffice', { name: office.model })}</option>}
              {modelOptions(provider, models, own ? model : '').map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          )}
          <span className="form-hint">{t('providers.role.next')}</span>
          {status && !isConnected(status) && (
            <span className="form-hint warn">
              {t('providers.role.notReady')}{' '}
              <button type="button" className="link" onClick={openProviderSettings}>{t('providers.role.connect')}</button>
            </span>
          )}
          {status?.state === 'limited' && status.resetsAt && (
            <span className="form-hint warn">
              {t('providers.role.limited', {
                time: new Date(status.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              })}
            </span>
          )}
          <FieldError save={save} f="model" />
        </Row>

        <Row
          id="agent-turns" label={<FieldLabel text={t('settings.limits.turns')} save={save} f="maxTurns" when="next" busy={busy} />}
          hint={t('role.turns.hint')}
        >
          <input
            id="agent-turns" {...turns} inputMode="numeric"
            placeholder={role.effectiveMaxTurns == null
              ? t('role.turns.officeUnlimited')
              : t('role.turns.office', { n: role.effectiveMaxTurns })}
          />
          <FieldError save={save} f="maxTurns" />
        </Row>
      </Section>

      <Section title={t('agent.section.code')}>
        <Row
          id="agent-repo" label={<FieldLabel text={t('role.repo')} save={save} f="repoDir" when="next" busy={busy} />}
          hint={t('role.repo.hint')}
        >
          <input id="agent-repo" {...repo} placeholder={t('role.repo.placeholder')} />
          {checkingRepo && (
            <span className="form-hint save-status"><span className="spinner" /> {t('agent.save.checking')}</span>
          )}
          {busy && <span className="form-hint">{t('agent.busy.repoNote')}</span>}
          <FieldError save={save} f="repoDir" />
        </Row>

        <div>
          <label className="form-check">
            <input
              type="checkbox" checked={save.value<boolean>('isolate')}
              onChange={(e) => {
                // Выключение — с подтверждением: без ветки агент правит общую копию.
                if (!e.target.checked) { setConfirmIsolate(true); return; }
                setConfirmIsolate(false);
                save.set({ isolate: true });
              }}
            />
            <span className="form-check-text">
              <FieldLabel text={t('role.isolate')} save={save} f="isolate" when="next" busy={busy} />
              <span className="form-hint">{t('agent.isolate.hint')}</span>
            </span>
          </label>
          <FieldError save={save} f="isolate" />
        </div>
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
      <Section title={t('agent.section.access')} desc={t('agent.access.chain')}>
        <Row id="agent-perm" label={<FieldLabel text={t('role.permissions')} save={save} f="permissionMode" when="now" busy={busy} />}>
          <select id="agent-perm" value={roleMode ?? ''} onChange={(e) => choose('permissionMode', e.target.value)}>
            <option value="">{t('role.asOffice', { mode: officeLabel })}</option>
            <option value="readonly">{accessLabel('readonly')}</option>
            <option value="ask-writes">{accessLabel('ask-writes')}</option>
            <option value="ask-risky">{t('role.mode.default', { mode: accessLabel('ask-risky') })}</option>
            <option value="auto">{accessLabel('auto')}</option>
          </select>
          <FieldError save={save} f="permissionMode" />
        </Row>
        {confirmAuto === 'permissionMode' && (
          <Confirm
            text={fullAccessWarning()} yes={t('settings.access.confirm')} onNo={() => setConfirmAuto(null)}
            onYes={() => { setConfirmAuto(null); save.set({ permissionMode: 'auto' }); }}
          />
        )}

        <Row id="agent-personal" label={<FieldLabel text={t('employee.personalMode')} save={save} f="personalMode" when="now" busy={busy} />}>
          <select id="agent-personal" value={personal ?? ''} onChange={(e) => choose('personalMode', e.target.value)}>
            <option value="">{t('employee.asRole', { mode: roleFallback })}</option>
            {PERM_OPTIONS.map((m) => <option key={m} value={m}>{accessLabel(m)}</option>)}
          </select>
          <FieldError save={save} f="personalMode" />
        </Row>
        {confirmAuto === 'personalMode' && (
          <Confirm
            text={fullAccessWarning()} yes={t('settings.access.confirm')} onNo={() => setConfirmAuto(null)}
            onYes={() => { setConfirmAuto(null); save.set({ personalMode: 'auto' }); }}
          />
        )}

        <div>
          <span className={`perm-badge ${effective}`}>
            <Icon name={effective === 'auto' ? 'lock-open' : 'shield-lock'} size={14} />{' '}
            {t('agent.access.effective', { mode: accessLabel(effective), source: permissionSourceLabel(source) })}
          </span>
        </div>
      </Section>

      <Section
        title={t('agent.section.tools')}
        desc={servers.length > 0 ? t('role.mcp.hint') : undefined}
        badge={busy && <span className="chip field-chip">{t('agent.busy.next')}</span>}
      >
        {servers.length === 0 ? (
          <span className="form-hint">{t('role.mcp.empty')}</span>
        ) : (
          servers.map((srv) => (
            <label key={srv.id} className="form-check">
              <input
                type="checkbox" checked={mcp.includes(srv.id)}
                onChange={(e) => save.set({ mcp: e.target.checked ? [...mcp, srv.id] : mcp.filter((id) => id !== srv.id) })}
              />
              <span className="form-check-text">
                {srv.title || srv.id}
                {srv.disabled && <span className="muted"> — {t('role.mcp.off')}</span>}
              </span>
            </label>
          ))
        )}
        <FieldError save={save} f="mcp" />
      </Section>

      <Section
        title={t('agent.section.skills')}
        desc={t('role.capabilities.hint')}
        badge={busy && <span className="chip field-chip">{t('agent.busy.next')}</span>}
      >
        {CAPABILITIES.map((cap) => (
          <label key={cap} className="form-check">
            <input
              type="checkbox" checked={caps.includes(cap)}
              onChange={(e) => save.set({ capabilities: e.target.checked ? [...caps, cap] : caps.filter((c) => c !== cap) })}
            />
            <span className="form-check-text mono">{cap}</span>
          </label>
        ))}
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
  const id = `agent-${f}`;
  return (
    <Row
      id={id} wide label={<FieldLabel text={t(label)} save={save} f={f} when="next" busy={busy} />}
      hint={`${t(hint)} ${t('agent.hint.typing')}`}
    >
      <textarea
        id={id} rows={f === 'brief' ? 10 : 5} value={value}
        className={save.field(f).error ? 'invalid' : undefined}
        onChange={(e) => save.type(f, e.target.value)}
        onBlur={() => save.commit(f)}
      />
      <span className="form-hint">
        {t('agent.brief.size', { n: value.length })}
        {value !== opened && (
          <> · <button type="button" className="link" onClick={() => save.set({ [f]: opened })}>{t('agent.save.revert')}</button></>
        )}
      </span>
      <FieldError save={save} f={f} />
    </Row>
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
            <Row id="agent-package-brief" wide label={t('role.package.brief')} hint={t('role.package.brief.hint')}>
              <textarea id="agent-package-brief" rows={showAll ? 20 : 6} value={link.brief} readOnly />
              <span className="form-hint">
                {t('agent.brief.size', { n: link.brief.length })} ·{' '}
                <button type="button" className="link" onClick={() => setShowAll(!showAll)}>
                  {t(showAll ? 'agent.brief.hideAll' : 'agent.brief.showAll')}
                </button>
              </span>
            </Row>
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

        <div>
          <button className="link" onClick={() => setExportOpen(!exportOpen)}>{t('role.export')}</button>
          {exportOpen && <span className="form-hint">{t('role.export.hint')}</span>}
        </div>
        {exportOpen && (
          <>
            <Row id="agent-export-name" label={t('role.export.name')}>
              <input id="agent-export-name" value={exportName} placeholder={`@me/${role.id}`} onChange={(e) => setExportName(e.target.value)} />
            </Row>
            <Row id="agent-export-dir" label={t('role.export.dir')}>
              <input id="agent-export-dir" value={exportDir} placeholder={t('role.export.dir.placeholder', { id: role.id })} onChange={(e) => setExportDir(e.target.value)} />
            </Row>
            <div className="modal-actions">
              <button className="allow" disabled={!exportName.trim()} onClick={() => { clearExportResult(); exportRole(role.id, exportName, exportDir); }}>
                {t('role.export.go')}
              </button>
            </div>
            {ownExport?.error && <div className="form-banner error">{ownExport.error}</div>}
            {ownExport && !ownExport.error && (
              <div className="form-hint">
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

        {link && (
          <div>
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
            {detachError && <span className="form-hint error">{detachError}</span>}
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

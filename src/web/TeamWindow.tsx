import { useEffect, useMemo, useRef, useState } from 'react';
import {
  clearTeamRequest, hireCopy, marketAddLink, marketCheck, marketOpen, roleProviderChip, updateSettings, useStore,
} from './store';
import { AgentSettings, type AgentTab } from './AgentSettings';
import { PackageCard } from './PackageCard';
import { useActionNotice } from './useActionNotice';
import { Avatar } from './Avatar';
import { displayInstance } from './instanceName';
import { catalog } from './layoutData';
import { desks } from '../shared/layout';
import { t } from './i18n';
import type { AgentState, InstanceView, MarketPackageView, RoleView } from '../shared/types';
import { Icon } from './icons';
import { Hint, Tooltip } from './Tooltip';
import { HOTKEY } from './hotkeys';
import { ShellPage } from './shell/ShellPage';

const stateLabel = (state: AgentState): string => t(`agent.state.${state}`);

/** Мини-чип провайдера сотрудника (ui.md §5.2): расчёт — `roleProviderChip` в сторе. */
function RoleProviderChip({ role }: { role: RoleView }) {
  const providers = useStore((s) => s.providers);
  const chip = roleProviderChip(role, providers);
  if (!chip) return null;
  const title = chip.ready
    ? t('providers.role.chipTitle', { name: chip.label, model: chip.model })
    : t('providers.role.chipNotReady', { name: chip.label });
  return (
    <span
      className={`chip provider-mini${chip.ready ? '' : ' warn'}${chip.own ? '' : ' muted'}`}
      title={title} aria-label={title}
    >
      {chip.short}
    </span>
  );
}

type Tab = 'staff' | 'market';

/** Сколько ждём нового сотрудника после «Нанять», прежде чем перестать высматривать его в списке. */
const HIRE_WAIT_MS = 15_000;

/**
 * Окно «Команда» с двумя вкладками: «В офисе» — те, кто нанят, и «Маркет» —
 * витрина пакетов. Слева список вкладки, справа карточка выбранного
 * сотрудника или пакета; у каждой вкладки своё выделение.
 *
 * Роль и сотрудник здесь одно и то же: в роли ровно один человек, а «ещё
 * один такой же» — отдельная роль из того же пакета со своими правками. Поэтому
 * в списке «В офисе» нет вложенности: каждый сотрудник — своя строка, а его
 * карточка — это и его состояние, и настройки его роли. Роль без людей (сервер
 * держит её как открытую вакансию) в списке не показывается.
 *
 * Найм идёт из карточки пакета — и окно тут же переключается на «В офисе»
 * с выделенным новичком, чтобы его можно было настроить не ища в списке.
 *
 * Открывается страницей главной области (пункт рейла, `ShellPage`), а не
 * модалкой. Крестик спрашивает про несохранённое; уход через рейл или
 * сегменты молча досылает правки — это делает сам `useAgentAutosave`.
 */
export function TeamWindow({ onClose }: { onClose: () => void }) {
  const roles = useStore((s) => s.roles);
  const instances = useStore((s) => s.instances);
  const layout = useStore((s) => s.layout);
  const market = useStore((s) => s.market);
  const lang = useStore((s) => s.lang);
  const settings = useStore((s) => s.settings);
  const teamRequest = useStore((s) => s.teamRequest);
  const [tab, setTab] = useState<Tab>('staff');
  const [staffSel, setStaffSel] = useState<string | null>(() => (
    teamRequest ? Object.values(instances).find((i) => i.roleId === teamRequest.roleId)?.id ?? null : null
  ));
  const [pkgSel, setPkgSel] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [link, setLink] = useState('');
  const { notice, markPending, clear } = useActionNotice();
  // Вкладка страницы агента живёт, пока открыто окно: при переходе к другому
  // сотруднику остаётся та же — так удобно сравнивать, например, модели.
  const [agentTab, setAgentTab] = useState<AgentTab>('profile');
  // Страница агента досылает правки и отвечает, что так и не сохранилось.
  const agentGuard = useRef<(() => string[]) | null>(null);
  const [closeAsk, setCloseAsk] = useState<string[] | null>(null);
  const requestClose = () => {
    const unsaved = agentGuard.current?.() ?? [];
    if (unsaved.length) setCloseAsk(unsaved);
    else onClose();
  };

  // Запрос на конкретную роль прочитан в начальном состоянии (см. useState
  // выше) и сбрасывается, чтобы повторное открытие не залипало на той же роли.
  // Страница может быть уже открыта, когда приходит новый запрос (ссылка из
  // карточки сотрудника поверх неё), — тогда переходим к нему здесь.
  useEffect(() => {
    if (!teamRequest) return;
    const id = Object.values(instances).find((i) => i.roleId === teamRequest.roleId)?.id;
    if (id) { setTab('staff'); setStaffSel(id); }
    clearTeamRequest();
  }, [teamRequest]);
  // Витрина читается с диска и из реестра на открытие: держать её в снапшоте
  // незачем. Читается сразу, а не при переходе на вкладку: строке пакета в
  // карточке сотрудника нужны значок и найденные обновления.
  useEffect(() => { marketOpen(); }, []);

  const packages = market?.packages ?? [];
  const busy = market?.busy === true;

  // Прыжок к нанятому: перед наймом запоминаем, кто уже есть, и первый новый
  // сотрудник, пришедший в стор, становится выбранным. Если офис отказал
  // (нет стола, менеджер уже есть), нового не будет — ожидание истекает само,
  // иначе оно перехватило бы кого-то, нанятого позже совсем другим путём.
  const awaiting = useRef<{ known: Set<string>; until: number } | null>(null);
  const hire = (fn: () => void) => {
    awaiting.current = { known: new Set(Object.keys(instances)), until: Date.now() + HIRE_WAIT_MS };
    markPending();
    fn();
  };
  useEffect(() => {
    const wait = awaiting.current;
    if (!wait) return;
    if (Date.now() > wait.until) { awaiting.current = null; return; }
    const fresh = Object.keys(instances).filter((id) => !wait.known.has(id)).sort();
    if (fresh.length === 0) return;
    awaiting.current = null;
    setStaffSel(fresh[0]);
    setTab('staff');
  }, [instances]);

  // Выбранная строка видна всегда: после прыжка к нанятому список мог быть
  // прокручен куда угодно, а новый человек появился наверху.
  const listPane = useRef<HTMLDivElement>(null);
  const selectedKey = tab === 'staff' ? staffSel : pkgSel;
  useEffect(() => {
    if (!selectedKey) return;
    const row = listPane.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(selectedKey)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [tab, selectedKey]);

  const act = (fn: () => void) => { markPending(); fn(); };
  const submitLink = () => {
    const url = link.trim();
    if (!url || busy) return;
    act(() => marketAddLink(url));
    setLink('');
  };

  const deskTotal = desks(layout, catalog).length;
  const seated = Object.keys(instances).length;
  const deskShortage = seated >= deskTotal;

  const roleOf = (inst: InstanceView): RoleView | undefined => roles.find((r) => r.id === inst.roleId);
  const q = query.trim().toLowerCase();
  const matchesStaff = (inst: InstanceView, role: RoleView | undefined): boolean => !q
    || inst.id.toLowerCase().includes(q)
    || inst.label.toLowerCase().includes(q)
    || (role?.title ?? '').toLowerCase().includes(q)
    || (role?.package?.name ?? '').toLowerCase().includes(q);
  // Менеджер первым — как в комнате: он один и с него офис начинается.
  const staff = useMemo(() => Object.values(instances)
    .map((inst) => ({ inst, role: roleOf(inst) }))
    .filter(({ inst, role }) => matchesStaff(inst, role))
    .sort((a, b) => Number(Boolean(b.role?.isManager)) - Number(Boolean(a.role?.isManager)) || a.inst.id.localeCompare(b.inst.id)),
  [instances, roles, q]);
  const onlyManager = Object.values(instances).every((i) => roleOf(i)?.isManager);

  const shown = useMemo(() => packages.filter((p) => !q
    || p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)
    || p.summary.toLowerCase().includes(q) || p.tags.some((tag) => tag.toLowerCase().includes(q))), [packages, q]);
  // Сколько людей из пакета в офисе — по живым сотрудникам, а не по витрине:
  // витрина перечитывается только на действиях маркета, и после увольнения
  // её счётчик отставал бы до следующего открытия окна.
  const headcount = (p: MarketPackageView) => Object.values(instances)
    .filter((i) => roleOf(i)?.package?.name === p.name).length;
  const staffTitles = (p: MarketPackageView) => Object.values(instances)
    .map((i) => roleOf(i))
    .filter((r): r is RoleView => r?.package?.name === p.name)
    .map((r) => r.title).join(', ');

  const selectedInst = tab === 'staff' && staffSel ? instances[staffSel] : undefined;
  const selectedRole = selectedInst ? roleOf(selectedInst) ?? null : null;
  const selectedPackage = tab === 'market' && pkgSel ? packages.find((p) => p.name === pkgSel) ?? null : null;

  return (
    <ShellPage bodyClass="fixed team-page" title={
      <span className="team-head-left">
        {t('hud.team')}
        <span className="seg team-tabs">
          <button className={tab === 'staff' ? 'on' : ''} onClick={() => setTab('staff')}>
            {t('team.tab.staff')} <span className="team-tab-count">{seated}</span>
          </button>
          <button className={tab === 'market' ? 'on' : ''} onClick={() => setTab('market')}>
            {t('team.tab.market')} <span className="team-tab-count">{packages.length}</span>
          </button>
        </span>
      </span>
    } actions={<>
      {tab === 'market' && (
        <>
          <button className="mini" disabled={busy} onClick={() => act(marketCheck)} title={t('market.check')}>
            <Icon name="refresh" size={12} /> {t('market.check')}
          </button>
          <button className="mini ghost" disabled={busy} onClick={() => marketOpen(true)}>{t('market.refresh')}</button>
        </>
      )}
      <Tooltip tip={<Hint label={t('panel.close')} keys={HOTKEY.close} />}>
        <button className="sq ghost" onClick={requestClose}>✕</button>
      </Tooltip>
    </>}>
      <div className="team-window-body">
        <div className="team-list-pane market-list-pane" ref={listPane}>
          <input
            className="market-search" value={query}
            placeholder={tab === 'staff' ? t('team.search') : t('market.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
          {tab === 'market' && market?.registryError && (
            <div className="team-notice">{t('market.registryError', { error: market.registryError })}</div>
          )}
          {notice && (
            <div className="team-notice">
              <span>{notice}</span>
              <button className="sq" onClick={clear}>✕</button>
            </div>
          )}
          {busy && <div className="hint muted market-busy">{t('market.busy')}</div>}

          {tab === 'staff' && (
            <>
              {deskShortage && (
                <div className="deskless-notice">
                  <Icon name="armchair" size={16} /> {t('team.deskShortage', { desks: deskTotal, staff: seated })}
                </div>
              )}
              {onlyManager && <p className="muted small team-group-hint">{t('team.empty')}</p>}
              <div className="team-list">
                {staff.length === 0 && !onlyManager && <span className="muted small">{t('market.empty')}</span>}
                {staff.map(({ inst, role }) => (
                  <button
                    key={inst.id}
                    data-row={inst.id}
                    className={`team-role-row market-row${staffSel === inst.id ? ' selected' : ''}${role?.archived ? ' archived' : ''}`}
                    onClick={() => setStaffSel(inst.id)}
                  >
                    <Avatar roleId={inst.roleId} instanceId={inst.id} />
                    <span className="market-row-text">
                      {/* С именем строка называется именем, а роль уходит в подстрочник. */}
                      <span className="market-row-title">{displayInstance(inst.id, instances, roles)}</span>
                      <span className="market-row-sub muted small">
                        {inst.name && role ? `${role.title} · ` : ''}{stateLabel(inst.state)}
                        {role?.package && ` · ${role.package.name} ${role.package.version}`}
                      </span>
                    </span>
                    {role && <RoleProviderChip role={role} />}
                    {inst.deskless && (
                      <span className="perm-badge deskless" title={t('office.desklessHint')}>
                        <Icon name="armchair" size={14} />
                      </span>
                    )}
                    {inst.permissionMode && (
                      <span className={`perm-badge ${inst.permissionMode}`}>
                        <Icon name={inst.permissionMode === 'auto' ? 'lock-open' : 'shield-lock'} size={14} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {tab === 'market' && (
            <>
              <p className="hint muted market-hint">{t('market.hint')}</p>
              <div className="team-list">
                {shown.length === 0 && <span className="muted small">{t('market.empty')}</span>}
                {shown.map((p) => {
                  const n = headcount(p);
                  return (
                    <button
                      key={p.name}
                      data-row={p.name}
                      className={`team-role-row market-row${pkgSel === p.name ? ' selected' : ''}`}
                      onClick={() => setPkgSel(p.name)}
                    >
                      <span className="market-emoji" style={{ background: p.color || 'var(--film-2)' }}>{p.emoji || '📦'}</span>
                      <span className="market-row-text">
                        <span className="market-row-title">{p.title || p.name}</span>
                        <span className="market-row-sub muted small">
                          {p.name}
                          {p.version ? ` · ${p.version}` : ` · ${t('market.notInstalled')}`}
                        </span>
                      </span>
                      {n > 0 && <span className="market-badge hired" title={t('market.inOffice', { roles: staffTitles(p) })}>{t('market.member.count', { n })}</span>}
                      {p.kind === 'team' && <span className="market-badge">{t('market.kind.team')}</span>}
                      {p.access === 'licensed' && <span className="market-badge link">{t('market.access.licensed')}</span>}
                      <span className={`market-badge ${p.trust}`}>{t(`market.origin.${p.origin}`)}</span>
                      {p.roles.some((r) => r.updateTo) && <span className="market-dot" title={t('market.updateAvailable', { version: p.roles.find((r) => r.updateTo)!.updateTo! })} />}
                    </button>
                  );
                })}
              </div>

              <div className="market-add">
                <span className="group-title">{t('market.addLink')}</span>
                <div className="market-add-row">
                  <input
                    value={link} placeholder={t('market.addLink.placeholder')}
                    onChange={(e) => setLink(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitLink(); }}
                  />
                  <button className="mini go" disabled={busy || !link.trim()} onClick={submitLink}>+</button>
                </div>
                <span className="hint">{t('market.addLink.hint')}</span>
              </div>
              {market?.checkedAt && (
                <span className="hint muted">{t('market.checkedAt', { time: new Date(market.checkedAt).toLocaleTimeString(lang) })}</span>
              )}
              {market?.service && (
                <label className="checkbox market-telemetry">
                  <input
                    type="checkbox" checked={settings.marketTelemetry === true}
                    onChange={(e) => updateSettings({ marketTelemetry: e.target.checked })}
                  />
                  {t('market.telemetry')}
                </label>
              )}
            </>
          )}
        </div>

        <div className="team-detail">
          {selectedInst && (
            <AgentSettings
              key={selectedInst.id}
              instanceId={selectedInst.id}
              tab={agentTab}
              onTab={setAgentTab}
              guard={agentGuard}
              onRemoved={() => setStaffSel(null)}
              packages={packages}
              marketBusy={busy}
              act={act}
              actions={selectedRole && !selectedRole.isManager && !selectedRole.archived ? (
                <button
                  className="mini" disabled={busy} title={t('team.hireOne')}
                  onClick={() => hire(() => hireCopy(selectedInst.roleId))}
                >
                  {t('team.hire')}
                </button>
              ) : null}
            />
          )}
          {selectedPackage && <PackageCard p={selectedPackage} busy={busy} act={act} hire={hire} />}
          {!selectedInst && !selectedPackage && (
            <p className="muted small">{t(tab === 'staff' ? 'team.pickHint' : 'market.pick')}</p>
          )}
        </div>
      </div>
      {closeAsk && (
        <div className="team-close-ask access-confirm" role="alertdialog">
          <p>{t('agent.save.closeAsk', { fields: closeAsk.join(', ') })}</p>
          <div className="modal-actions">
            <button onClick={() => setCloseAsk(null)}>{t('agent.save.stay')}</button>
            <button className="danger" onClick={onClose}>{t('agent.save.closeAnyway')}</button>
          </div>
        </div>
      )}
    </ShellPage>
  );
}

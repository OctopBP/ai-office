import { useEffect, useMemo, useState } from 'react';
import {
  marketAddLink, marketCheck, marketHire, marketHireTeam, marketInstall, marketLicense, marketOpen, marketUpdate,
  updateSettings, useStore,
} from './store';
import { useActionNotice } from './useActionNotice';
import { t } from './i18n';
import { Icon } from './icons';
import type { MarketPackageView } from '../shared/types';

/**
 * Окно «Маркет агентов»: слева витрина (встроенные пакеты, реестр, кеш и
 * поле «добавить по ссылке»), справа карточка пакета — что умеет, что просит,
 * и кнопки «Установить» / «Нанять» / «Обновить».
 *
 * Установка и найм разведены намеренно: разрешения пакета читаются из его
 * манифеста, а манифест есть только у установленного. Так человек видит,
 * какие серверы и переменные просит пакет, ДО того как в офисе появится роль.
 */
export function MarketWindow({ onClose }: { onClose: () => void }) {
  const market = useStore((s) => s.market);
  const lang = useStore((s) => s.lang);
  const settings = useStore((s) => s.settings);
  const [query, setQuery] = useState('');
  const [link, setLink] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const { notice, markPending, clear } = useActionNotice();

  // Витрина читается с диска и из реестра на открытие: держать её в снапшоте незачем.
  useEffect(() => { marketOpen(); }, []);

  const packages = market?.packages ?? [];
  const busy = market?.busy === true;
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => packages.filter((p) => !q
    || p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)
    || p.summary.toLowerCase().includes(q) || p.tags.some((tag) => tag.toLowerCase().includes(q))), [packages, q]);
  const current = packages.find((p) => p.name === selected) ?? null;

  const act = (fn: () => void) => { markPending(); fn(); };
  const submitLink = () => {
    const url = link.trim();
    if (!url || busy) return;
    act(() => marketAddLink(url));
    setLink('');
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="team-window market-window" onClick={(e) => e.stopPropagation()}>
        <header className="team-window-head">
          <h2>{t('market.title')}</h2>
          <div className="market-head-actions">
            <button className="mini" disabled={busy} onClick={() => act(marketCheck)} title={t('market.check')}>
              <Icon name="refresh" size={12} /> {t('market.check')}
            </button>
            <button className="mini ghost" disabled={busy} onClick={() => marketOpen(true)}>{t('market.refresh')}</button>
            <button className="sq ghost" onClick={onClose} title={t('panel.close')}>✕</button>
          </div>
        </header>

        <div className="team-window-body">
          <div className="team-list-pane market-list-pane">
            <p className="hint muted market-hint">{t('market.hint')}</p>
            <input
              className="market-search" value={query} placeholder={t('market.search')}
              onChange={(e) => setQuery(e.target.value)}
            />
            {market?.registryError && (
              <div className="team-notice">{t('market.registryError', { error: market.registryError })}</div>
            )}
            {notice && (
              <div className="team-notice">
                <span>{notice}</span>
                <button className="sq" onClick={clear}>✕</button>
              </div>
            )}
            {busy && <div className="hint muted market-busy">{t('market.busy')}</div>}

            <div className="team-list">
              {shown.length === 0 && <span className="muted small">{t('market.empty')}</span>}
              {shown.map((p) => (
                <button
                  key={p.name}
                  className={`team-role-row market-row${p.name === selected ? ' selected' : ''}`}
                  onClick={() => setSelected(p.name)}
                >
                  <span className="market-emoji" style={{ background: p.color || 'var(--film-2)' }}>{p.emoji || '📦'}</span>
                  <span className="market-row-text">
                    <span className="market-row-title">{p.title || p.name}</span>
                    <span className="market-row-sub muted small">
                      {p.name}
                      {p.version ? ` · ${p.version}` : ` · ${t('market.notInstalled')}`}
                      {p.roles.length > 0 && ` · ${t('market.inOffice', { roles: p.roles.map((r) => r.title).join(', ') })}`}
                    </span>
                  </span>
                  {p.kind === 'team' && <span className="market-badge">{t('market.kind.team')}</span>}
                  {p.access === 'licensed' && <span className="market-badge link">{t('market.access.licensed')}</span>}
                  <span className={`market-badge ${p.trust}`}>{t(`market.origin.${p.origin}`)}</span>
                  {p.roles.some((r) => r.updateTo) && <span className="market-dot" title={t('market.updateAvailable', { version: p.roles.find((r) => r.updateTo)!.updateTo! })} />}
                </button>
              ))}
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
          </div>

          <div className="team-detail">
            {current ? <PackageCard p={current} busy={busy} act={act} /> : <span className="muted">{t('market.pick')}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Чем поднимается сервер — одной строкой, как это увидит человек. */
const howItStarts = (s: MarketPackageView['servers'][number]): string =>
  (s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url);

function PackageCard({ p, busy, act }: { p: MarketPackageView; busy: boolean; act: (fn: () => void) => void }) {
  const [key, setKey] = useState('');
  const roleInOffice = p.roles.find((r) => !r.builtin) ?? p.roles[0] ?? null;
  const needsKey = p.access === 'licensed' && !p.licensed;
  const canInstall = !p.installed && p.origin === 'registry' && !p.yanked && !needsKey;
  const canHire = p.installed && !p.manager && p.kind === 'agent';
  const canHireTeam = p.installed && p.kind === 'team' && p.members.every((m) => m.available);
  return (
    <div className="role-form market-card">
      <h3>
        <span className="market-emoji big" style={{ background: p.color || 'var(--film-2)' }}>{p.emoji || '📦'}</span>
        {p.title || p.name}
      </h3>
      <p className="modal-reason">
        {p.name}
        {p.version && ` · ${t('market.version', { version: p.version })}`}
        {p.latest && p.version && p.latest !== p.version && ` · ${t('market.updateAvailable', { version: p.latest })}`}
        {' · '}<span className={`market-badge ${p.trust}`}>{t(`market.trust.${p.trust}`)}</span>
      </p>
      {p.summary && <p className="market-summary">{p.summary}</p>}
      {p.reputation && (
        <p className="muted small" title={t('market.reputation.hint')}>
          {t('market.reputation', {
            closed: p.reputation.closed, clean: Math.round(p.reputation.cleanShare * 100),
            cost: `$${p.reputation.avgCostUsd.toFixed(2)}`,
          })}
        </p>
      )}
      {p.tags.length > 0 && <p className="muted small">{p.tags.map((tag) => `#${tag}`).join(' ')}</p>}
      {p.yanked && <div className="form-banner error">{t('market.yanked')}</div>}

      <div className="modal-actions market-actions">
        {canInstall && (
          <button className="allow" disabled={busy} onClick={() => act(() => marketInstall(p.name))}>
            {busy ? t('market.installing') : t('market.install')}
          </button>
        )}
        {canHire && (
          <button className="allow" disabled={busy} onClick={() => act(() => marketHire(p.name))}>
            {roleInOffice ? t('market.hireMore') : t('market.hire')}
          </button>
        )}
        {p.kind === 'team' && p.installed && (
          <button className="allow" disabled={busy || !canHireTeam} title={t('market.hireTeam.hint')} onClick={() => act(() => marketHireTeam(p.name))}>
            {t('market.hireTeam')}
          </button>
        )}
        {p.access === 'licensed' && p.buyUrl && (
          <a className="button" href={p.buyUrl} target="_blank" rel="noreferrer">{t('market.buy')}{p.price ? ` · ${p.price}` : ''}</a>
        )}
        {p.roles.filter((r) => r.updateTo).map((r) => (
          <button key={r.id} className="go" disabled={busy} onClick={() => act(() => marketUpdate(r.id))}>
            {t('market.update', { version: r.updateTo! })} — {r.title}
          </button>
        ))}
      </div>

      {p.access === 'licensed' && (
        <section className="market-license">
          <span className="group-title">{t('market.license')}</span>
          {p.price && <div className="hint">{t('market.price')}: {p.price}</div>}
          <div className="market-add-row">
            <input value={key} placeholder={p.licensed ? t('market.license.have') : 'lic_…'} onChange={(e) => setKey(e.target.value)} />
            <button className="mini go" disabled={busy || !key.trim()} onClick={() => { act(() => marketLicense(p.name, key)); setKey(''); }}>{t('market.license.save')}</button>
            {p.licensed && <button className="mini ghost" disabled={busy} onClick={() => act(() => marketLicense(p.name, ''))}>{t('market.license.forget')}</button>}
          </div>
          <span className="hint">{t('market.license.hint')}</span>
        </section>
      )}

      {p.kind === 'team' && (
        <section>
          <span className="group-title">{t('market.members')}</span>
          <ul className="market-list">
            {p.members.map((m) => (
              <li key={m.package}>
                {m.title} <span className="muted small">({m.package}{m.version ? ` ${m.version}` : ''})</span>
                {m.count > 1 && <b> {t('market.member.count', { n: m.count })}</b>}
                {!m.installed && m.available && <span className="market-badge"> {t('market.member.toInstall')}</span>}
                {!m.available && <span className="market-badge link"> {t('market.member.missing')}</span>}
              </li>
            ))}
          </ul>
          {Object.keys(p.settings).length > 0 && (
            <>
              <span className="group-title">{t('market.teamSettings')}</span>
              <ul className="market-list muted small">
                {Object.entries(p.settings).map(([k, v]) => <li key={k}>{k}: {String(v)}</li>)}
              </ul>
            </>
          )}
          <span className="hint muted">{t('market.hireTeam.hint')}</span>
        </section>
      )}

      <section>
        <span className="group-title">{t('market.source')}</span>
        <div className="hint">
          {p.origin === 'builtin'
            ? t('market.source.builtin')
            : <>{p.repo}{p.path ? ` / ${p.path}` : ''}{p.commit && ` · ${t('market.commit', { commit: p.commit.slice(0, 7) })}`}</>}
        </div>
      </section>

      {p.roles.length > 0 && (
        <section>
          <span className="group-title">{t('market.roles')}</span>
          <ul className="market-list">
            {p.roles.map((r) => (
              <li key={r.id}>
                {r.title} <span className="muted small">({r.id}, {t('market.version', { version: r.version })})</span>
                {r.updateTo && <span className="market-badge community"> {t('market.updateAvailable', { version: r.updateTo })}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!p.installed ? (
        <p className="hint muted">{t('market.unknownYet')}</p>
      ) : p.kind === 'team' ? null : (
        <>
          <section className="market-permissions">
            <span className="group-title">{t('market.permissions')}</span>
            <span className="hint muted">{t('market.permissions.hint')}</span>
            <dl>
              <dt>{t('market.model')}</dt><dd>{p.model}</dd>
              <dt>{t('market.tools')}</dt><dd>{p.tools ? p.tools.join(', ') : t('market.tools.all')}</dd>
              <dt>{t('market.servers')}</dt>
              <dd>
                {p.mcp.length > 0 && <div>{t('market.servers.subscribed', { ids: p.mcp.join(', ') })}</div>}
                {p.servers.length === 0 && p.mcp.length === 0 && t('market.servers.none')}
                {p.servers.map((s) => (
                  <div key={s.id} className="market-server">
                    <b>{s.title || s.id}</b> <code>{howItStarts(s)}</code>
                    {Object.keys(s.env).length > 0 && <span className="muted small"> env: {Object.keys(s.env).join(', ')}</span>}
                  </div>
                ))}
              </dd>
              {p.env.length > 0 && <><dt>{t('market.env')}</dt><dd>{p.env.join(', ')}</dd></>}
              {p.network && <><dt>{t('market.network')}</dt><dd>✓</dd></>}
              {p.skills.length > 0 && <><dt>{t('market.skills')}</dt><dd>{p.skills.join(', ')}</dd></>}
            </dl>
          </section>
          <section>
            <span className="group-title">{t('market.brief')}</span>
            {p.brief ? <pre className="market-brief">{p.brief}</pre> : <span className="hint muted">{t('market.brief.empty')}</span>}
          </section>
          {p.warnings.length > 0 && (
            <section>
              <span className="group-title">{t('market.warnings')}</span>
              <ul className="market-list muted small">{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

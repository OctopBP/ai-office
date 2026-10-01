import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { EngineCapabilities, ProviderStatus } from '../shared/providers';
import type { LimitKind, ProviderView } from '../shared/types';
import { Gauge, LIMIT_TICK_MS } from './LimitBars';
import { limitTone, resetLine } from './money';
import { Icon } from './icons';
import {
  cancelProviderInstall, installProvider, loginProvider, logoutProvider, refreshProviders, useStore,
} from './store';
import { t, type UiKey } from './i18n';

/**
 * Карточка провайдера (docs/design/T-189/ui.md §2.2–2.5). Одна на два места —
 * вкладку «Провайдеры» и экран первого запуска: различаются только
 * контейнеры. Карточка ничего не считает сама: состояние приходит от сервера
 * (`ProviderView`), а кнопки шлют команды и ждут следующего события.
 */

const STATUS_KEY: Record<ProviderStatus['state'], UiKey> = {
  'not-installed': 'providers.status.notInstalled',
  installing: 'providers.status.installing',
  'needs-login': 'providers.status.needsLogin',
  unreachable: 'providers.status.unreachable',
  ready: 'providers.status.ready',
  limited: 'providers.status.limited',
  error: 'providers.status.error',
};

/** Как войти по подписке, раз офис сам пока не открывает вход: команда движка в терминале. */
const LOGIN_COMMAND: Record<string, string> = { 'claude-code': 'claude login', codex: 'codex login' };

const SUBSCRIPTION_NOTE: Record<string, UiKey> = {
  'claude-code': 'providers.login.noteClaude',
  codex: 'providers.login.noteOpenai',
};

const LIMIT_KIND_KEY: Record<LimitKind, UiKey> = {
  codex_primary: 'limits.kind.codexPrimary',
  codex_secondary: 'limits.kind.codexSecondary',
  five_hour: 'limits.kind.fiveHour',
  seven_day: 'limits.kind.sevenDay',
  seven_day_opus: 'limits.kind.sevenDayOpus',
  seven_day_sonnet: 'limits.kind.sevenDaySonnet',
  seven_day_oauth_apps: 'limits.kind.sevenDayApps',
  seven_day_overage_included: 'limits.kind.sevenDayOverage',
  overage: 'limits.kind.overage',
};

/** Пометка возможности: показываются только отличия от «всё умеет» (§2.2). */
interface Cap { label: UiKey; tip: UiKey; warm?: boolean }

function capsOf(c: EngineCapabilities): Cap[] {
  const caps: Cap[] = [];
  if (!c.sandbox) caps.push({ label: 'providers.cap.noSandbox', tip: 'providers.cap.noSandbox.tip', warm: true });
  if (!c.resume) caps.push({ label: 'providers.cap.noResume', tip: 'providers.cap.noResume.tip' });
  if (c.costUsd === 'none') caps.push({ label: 'providers.cap.noCost', tip: 'providers.cap.noCost.tip' });
  if (!c.streamingInput) caps.push({ label: 'providers.cap.noManager', tip: 'providers.cap.noManager.tip' });
  if (!c.cloud) caps.push({ label: 'providers.cap.noCloud', tip: 'providers.cap.noCloud.tip' });
  if (!c.planLimits && !c.balance) caps.push({ label: 'providers.cap.noLimits', tip: 'providers.cap.noLimits.tip' });
  return caps;
}

/** Монограмма вместо логотипа: ни у кого нет визуального преимущества (§0). */
const monogram = (label: string): string => {
  const words = label.split(/[\s·]+/).filter(Boolean);
  return words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : label.slice(0, 2);
};

const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

/** «через 2 ч 10 мин» — срок до сброса, тикает на клиенте. */
function span(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  return h > 0 ? t('providers.span.hm', { h, m: min % 60 }) : t('providers.span.m', { m: min });
}

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Поле ключа API, раскрытое внутри карточки (§2.5). */
function KeyForm({ p, onClose }: { p: ProviderView; onClose: () => void }) {
  const id = useId();
  const keychain = useStore((s) => s.providers?.keychain ?? true);
  const result = useStore((s) => s.providerLogin[p.id]);
  const [key, setKey] = useState('');
  const [shown, setShown] = useState(false);
  const [checking, setChecking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  // Итог приходит событием `provider.login`: пока его нет — «Проверяю…».
  useEffect(() => {
    if (!checking || !result) return;
    setChecking(false);
    if (result.ok) onClose();
  }, [checking, result, onClose]);

  const save = () => {
    if (!key.trim() || checking) return;
    setChecking(true);
    loginProvider(p.id, key);
  };
  const error = !checking && result && !result.ok ? result : null;
  const errorKey: UiKey | null = !error ? null
    : error.code === 'rejected' ? 'providers.key.err401'
    : error.code === 'network' ? 'providers.key.errNet'
    : error.code === 'keychain' ? 'providers.key.errKeychain'
    : 'providers.key.errUnsupported';

  return (
    <div className="provider-key" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <label htmlFor={id} className="provider-key-label">{t('providers.key.label')}</label>
      <div className="provider-key-row">
        <input
          id={id} ref={input} className="mono" type={shown ? 'text' : 'password'}
          autoComplete="off" spellCheck={false} value={key}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
        />
        <button type="button" className="mini ghost" aria-pressed={shown} onClick={() => setShown((v) => !v)}>
          {t(shown ? 'providers.key.hide' : 'providers.key.show')}
        </button>
      </div>
      <span className="form-hint">{t(keychain ? 'providers.key.hint' : 'providers.key.noKeychain')}</span>
      {errorKey && <span className="form-hint error" role="alert">{t(errorKey)}</span>}
      <div className="provider-actions">
        <button type="button" className="primary" disabled={!key.trim() || checking} onClick={save}>
          {checking ? <><span className="spinner" /> {t('providers.key.checking')}</> : t('providers.key.save')}
        </button>
        <button type="button" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

/** Меню ⋯ готовой карточки: перепроверка, смена и удаление ключа. */
function CardMenu({ p, onChangeKey }: { p: ProviderView; onChangeKey: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  const removeKey = () => {
    if (window.confirm(t('providers.confirm.logout'))) logoutProvider(p.id);
  };
  return (
    <div className="provider-menu" ref={box}>
      <button type="button" className="sq ghost mini" aria-haspopup="menu" aria-expanded={open}
        aria-label={t('providers.menu.title')} onClick={() => setOpen((v) => !v)}>
        <Icon name="dots" size={16} />
      </button>
      {open && (
        <div className="provider-menu-list float" role="menu">
          <button type="button" role="menuitem" className="ghost" onClick={pick(() => refreshProviders(true))}>{t('providers.recheck')}</button>
          {p.auth.includes('api-key') && (
            <button type="button" role="menuitem" className="ghost" onClick={pick(onChangeKey)}>{t('providers.menu.changeKey')}</button>
          )}
          {p.key?.source === 'keychain' && (
            <button type="button" role="menuitem" className="ghost danger" onClick={pick(removeKey)}>{t('providers.menu.deleteKey')}</button>
          )}
        </div>
      )}
    </div>
  );
}

export function ProviderCard({ p, onUse }: {
  p: ProviderView;
  /** Экран первого запуска: у готовой карточки главная кнопка «Работать этим провайдером». */
  onUse?: () => void;
}) {
  const titleId = useId();
  const status = p.status;
  const limits = useStore((s) => s.limits);
  const [keyOpen, setKeyOpen] = useState(false);
  const [howLogin, setHowLogin] = useState(false);
  const [details, setDetails] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status.state !== 'limited' && status.state !== 'ready') return;
    const timer = setInterval(() => setNow(Date.now()), LIMIT_TICK_MS);
    return () => clearInterval(timer);
  }, [status.state]);

  // Скринридеру — смена состояния, а не каждый процент установки.
  const [announce, setAnnounce] = useState('');
  const prev = useRef(status.state);
  useEffect(() => {
    if (prev.current === status.state) return;
    if (prev.current === 'installing' && status.state !== 'not-installed') setAnnounce(t('providers.install.done'));
    else if (status.state === 'ready') setAnnounce(t('providers.key.accepted'));
    else setAnnounce(t(STATUS_KEY[status.state]));
    prev.current = status.state;
    // Вход закончился где-то ещё (в терминале) — подсказка больше не нужна.
    if (status.state === 'ready' || status.state === 'limited') { setHowLogin(false); setKeyOpen(false); }
  }, [status.state]);

  const caps = capsOf(p.capabilities);
  const shownCaps = caps.slice(0, 3);
  const moreCaps = caps.slice(3);
  const connected = status.state === 'ready' || status.state === 'limited';
  const windows = connected
    ? limits.windows.filter((w) => (w.provider ?? 'claude-code') === p.id)
    : [];

  const keyButton = (label: UiKey, primary: boolean) => (
    <button type="button" className={primary ? 'primary' : ''} onClick={() => { setKeyOpen(true); setHowLogin(false); }}>
      {t(label)}
    </button>
  );

  let body: ReactNode = null;
  let actions: ReactNode = null;
  switch (status.state) {
    case 'not-installed':
      body = (
        <>
          <p className="provider-text">
            {status.sizeMb
              ? t('providers.install.need', { engine: p.engineLabel, size: status.sizeMb })
              : t('providers.install.needNoSize', { engine: p.engineLabel })}
          </p>
          {(p.installError ?? status.detail) && (
            <p className="provider-text error" role="alert">
              {p.installError ? t('providers.install.failed', { detail: p.installError }) : status.detail}
            </p>
          )}
        </>
      );
      actions = <button type="button" className="primary" onClick={() => installProvider(p.id)}>{t('providers.install.action')}</button>;
      break;
    case 'installing': {
      const pct = Math.round(status.share * 100);
      const known = status.totalBytes !== undefined && status.totalBytes > 0;
      body = (
        <>
          <p className="provider-text">
            {known
              ? t('providers.install.progress', {
                engine: p.engineLabel, pct, done: mb(status.bytes ?? 0), total: mb(status.totalBytes!),
              })
              : t('providers.install.progressUnknown')}
          </p>
          <div className={`provider-progress${known || pct > 0 ? '' : ' unknown'}`} role="progressbar"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={known || pct > 0 ? pct : undefined}
            aria-label={t('providers.status.installing')}>
            <i style={known || pct > 0 ? { width: `${pct}%` } : undefined} />
          </div>
        </>
      );
      actions = <button type="button" onClick={() => cancelProviderInstall(p.id)}>{t('providers.install.cancel')}</button>;
      break;
    }
    case 'needs-login': {
      const subscription = p.auth.includes('subscription') && status.auth.includes('subscription');
      const byKey = p.auth.includes('api-key');
      body = (
        <>
          <p className="provider-text">{t('providers.login.prompt', { name: p.label })}</p>
          {status.detail && <p className="provider-text muted">{status.detail}</p>}
          {howLogin && (
            <div className="provider-howto">
              <p className="provider-text">{t('providers.login.terminal')}</p>
              <code className="mono">{LOGIN_COMMAND[p.engine] ?? `${p.engine} login`}</code>
              <p className="provider-text">{t('providers.login.terminalThen')}</p>
            </div>
          )}
        </>
      );
      actions = !keyOpen && (
        <>
          {byKey && keyButton('providers.login.key', true)}
          {subscription && (
            <span className="provider-sub">
              <button type="button" onClick={() => setHowLogin((v) => !v)} aria-expanded={howLogin}>{t('providers.login.subscription')}</button>
              {SUBSCRIPTION_NOTE[p.engine] && <span className="form-hint">{t(SUBSCRIPTION_NOTE[p.engine]!)}</span>}
            </span>
          )}
          {howLogin && <button type="button" onClick={() => refreshProviders(true)}>{t('providers.recheck')}</button>}
        </>
      );
      break;
    }
    case 'unreachable':
      body = (
        <>
          <p className="provider-text">{t('providers.unreachable.text')}</p>
          <p className="provider-text muted">{status.detail}</p>
        </>
      );
      actions = <button type="button" onClick={() => refreshProviders(true)}>{t('providers.recheck')}</button>;
      break;
    case 'ready':
      body = (
        <>
          <p className="provider-text">
            {p.key
              ? t(p.key.source === 'env' ? 'providers.ready.account.env' : 'providers.ready.account.key', { tail: p.key.tail })
              : status.auth === 'none'
                ? t('providers.ready.account.local')
                : t('providers.ready.account.subscription', {
                  account: [status.plan, status.account].filter(Boolean).join(', ') || t('providers.ready.account.anon'),
                })}
          </p>
          <ProviderLimits windows={windows} planLimits={p.capabilities.planLimits} now={now} />
        </>
      );
      actions = !keyOpen && onUse && <button type="button" className="primary" onClick={onUse}>{t('providers.ready.useThis')}</button>;
      break;
    case 'limited': {
      const head = status.kind === 'balance'
        ? t('providers.limited.balance')
        : status.resetsAt
          ? t(status.kind === 'rate' ? 'providers.limited.rate' : 'providers.limited.plan', {
            time: clock(status.resetsAt), span: span(status.resetsAt - now),
          })
          : t('providers.limited.unknown');
      body = (
        <>
          <p className="provider-text warn">{head}</p>
          <p className="provider-text">{t(status.kind === 'balance' ? 'providers.limited.waitBalance' : 'providers.limited.wait')}</p>
          {status.detail && <p className="provider-text muted">{status.detail}</p>}
          <ProviderLimits windows={windows} planLimits={p.capabilities.planLimits} now={now} />
        </>
      );
      actions = !keyOpen && (
        <>
          {onUse && <button type="button" className="primary" onClick={onUse}>{t('providers.ready.useThis')}</button>}
          {(status.kind === 'balance' || !status.resetsAt) && (
            <button type="button" onClick={() => refreshProviders(true)}>{t('providers.recheck')}</button>
          )}
        </>
      );
      break;
    }
    case 'error':
      body = (
        <>
          <p className="provider-text error" role="alert">{t('providers.error.text')}</p>
          {details && <pre className="provider-details mono">{status.detail}</pre>}
        </>
      );
      actions = !keyOpen && (
        <>
          {p.auth.includes('api-key') && keyButton('providers.key.replace', true)}
          <button type="button" onClick={() => refreshProviders(true)}>{t('providers.recheck')}</button>
          <button type="button" className="ghost" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
            {t('providers.error.details')} {details ? '▴' : '▾'}
          </button>
        </>
      );
      break;
  }

  const hasMenu = status.state === 'ready' || status.state === 'limited' || status.state === 'error';
  return (
    <section className={`provider-card card state-${status.state}`} aria-labelledby={titleId}>
      <header className="provider-head">
        <span className="provider-tile" aria-hidden>{monogram(p.label)}</span>
        <div className="provider-name">
          <h4 id={titleId}>{p.label}</h4>
          <span className="provider-engine">{t('providers.engine', { engine: p.engineLabel })}</span>
        </div>
        <span className={`chip provider-status ${status.state}`}>
          <i aria-hidden />{t(STATUS_KEY[status.state])}
        </span>
        {hasMenu && <CardMenu p={p} onChangeKey={() => setKeyOpen(true)} />}
      </header>
      <div className="provider-body">{body}</div>
      {keyOpen && <KeyForm p={p} onClose={() => setKeyOpen(false)} />}
      {caps.length > 0 && (
        <div className="provider-caps">
          {shownCaps.map((c) => (
            <span key={c.label} className={`chip${c.warm ? ' warm' : ''}`} title={t(c.tip)} tabIndex={0}>{t(c.label)}</span>
          ))}
          {moreCaps.length > 0 && (
            <span className="chip" tabIndex={0} title={moreCaps.map((c) => `${t(c.label)} — ${t(c.tip)}`).join('\n')}>
              {t('providers.cap.more', { n: moreCaps.length })}
            </span>
          )}
        </div>
      )}
      {actions && <div className="provider-actions">{actions}</div>}
      <span className="provider-live" aria-live="polite">{announce}</span>
    </section>
  );
}

/** Шкалы лимитов этого провайдера — те же, что на доске расходов. */
function ProviderLimits({ windows, planLimits, now }: {
  windows: ReturnType<typeof useStore.getState>['limits']['windows'];
  planLimits: boolean;
  now: number;
}) {
  if (windows.length === 0) {
    return <p className="provider-text muted">{t(planLimits ? 'providers.ready.limitsYet' : 'providers.ready.limitsNone')}</p>;
  }
  return (
    <div className="limit-rows provider-limits">
      {windows.map((w) => (
        <Gauge key={w.kind} label={t(LIMIT_KIND_KEY[w.kind])} percent={w.utilization}
          note={resetLine(w, now)} tone={limitTone(w.utilization)} />
      ))}
    </div>
  );
}

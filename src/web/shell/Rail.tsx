import { useEffect, useRef, useState } from 'react';
import {
  reset, setEditingLayout, sortedOffices, summarizeOfficeActivity, useStore,
} from '../store';
import type { ModalKind, PanelKind } from '../Overlays';
import { money } from '../money';
import { t } from '../i18n';
import { Icon, type IconName } from '../icons';

/** Цвета аватарок офисов — по кругу, те же, что у ролей. */
const HUES = ['var(--hue-blue)', 'var(--hue-amber)', 'var(--hue-pink)', 'var(--hue-violet)'];

type WindowKind = 'board' | 'merge' | 'log' | 'money' | 'team' | 'settings';
const WINDOWS: Array<{ kind: WindowKind; icon: IconName }> = [
  { kind: 'board', icon: 'list-check' },
  { kind: 'merge', icon: 'git-merge' },
  { kind: 'log', icon: 'file-text' },
  { kind: 'money', icon: 'coin' },
  { kind: 'team', icon: 'users' },
  { kind: 'settings', icon: 'settings' },
];

/**
 * Левый рейл: офисы, окна офиса, расход за день и пользователь. Развёрнутый
 * (264) и свёрнутый до иконок (70) — переключается кнопкой у логотипа и
 * переживает перезагрузку.
 *
 * Список окон — то, что раньше жило только в хоткеях и в HUD: доска, очередь
 * слияния, лог, расходы, команда, настройки. Доска здесь ведёт в вид, а не в
 * панель: сегменты сверху — виды (см. `Shell.tsx`).
 */
export function Rail({ onPanel, onModal }: {
  onPanel: (p: PanelKind) => void;
  onModal: (m: ModalKind) => void;
}) {
  const offices = useStore((s) => s.offices);
  const instances = useStore((s) => s.instances);
  const tasks = useStore((s) => s.tasks);
  const settings = useStore((s) => s.settings);
  const pending = useStore((s) => s.pending);
  const enterOffice = useStore((s) => s.enterOffice);
  const collapsed = useStore((s) => s.railCollapsed);
  const setCollapsed = useStore((s) => s.setRailCollapsed);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);

  const list = sortedOffices(offices);
  // Счётчики те же, что были в HUD: в работе — по задачам, а не по позам агентов.
  const all = Object.values(tasks);
  const working = all.filter((x) => x.status === 'in_progress').length;
  const active = all.filter((x) => !['done', 'failed', 'planned'].includes(x.status)).length;
  const readyToMerge = all.filter((x) => x.status === 'done' && x.branch && !x.merged).length;
  const counts: Partial<Record<WindowKind, number>> = { board: active, merge: readyToMerge };

  // «Сегодня» — по агентам, как в HUD: общая сумма врала после перезапуска.
  const today = Object.values(instances).reduce((sum, i) => sum + i.today.costUsd, 0);
  const cap = settings.globalBudgetUsd;
  const share = cap ? Math.min(1, today / cap) : 0;

  const openWindow = (kind: WindowKind) => {
    if (kind === 'board') setView(view === 'board' ? 'office' : 'board');
    else if (kind === 'team' || kind === 'settings') onModal(kind);
    else onPanel(kind);
  };

  return (
    <aside className="shell-rail float">
      <div className="rail-brand">
        <span className="rail-logo" />
        <span className="rail-name">AI Office</span>
        <button className="ghost rail-toggle" onClick={() => setCollapsed(!collapsed)}
          title={t(collapsed ? 'shell.rail.expand' : 'shell.rail.collapse')}>
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      <div className="section-title">{t('shell.offices')}</div>
      <div className="rail-offices">
        {list.map((o) => {
          const i = offices.indexOf(o);
          const activity = summarizeOfficeActivity(o);
          const status = o.current
            ? t('shell.officeStatus', { n: Object.keys(instances).length, working })
            : activity.text;
          return (
            <button key={o.id} className={`rail-office${o.current ? ' current' : ''}`}
              onClick={() => { if (!o.current) enterOffice(o.id); }}
              disabled={pending === 'enter'}
              title={collapsed ? `${o.name} · ${status}` : o.projectDir}>
              <span className="rail-office-avatar" style={{ background: HUES[i % HUES.length] }} />
              <span className="rail-office-text">
                <span className="rail-office-name">{o.name}</span>
                <span className="rail-office-status">{status}</span>
              </span>
              {(o.current || activity.live) && <span className="rail-office-dot" />}
            </button>
          );
        })}
        <button className="dashed rail-new" onClick={() => onModal('offices')} title={t('shell.newOffice')}>
          {collapsed ? '+' : t('shell.newOffice')}
        </button>
      </div>

      <div className="rail-sep" />

      <div className="section-title">{t('shell.windows')}</div>
      <div className="rail-windows">
        {WINDOWS.map(({ kind, icon }) => {
          const n = counts[kind];
          return (
            <button key={kind} className={`rail-win${kind === 'board' && view === 'board' ? ' on' : ''}`}
              onClick={() => openWindow(kind)} title={t(`shell.win.${kind}`)}>
              <span className="rail-win-icon">
                {collapsed && n ? n : <Icon name={icon} size={12} />}
              </span>
              <span className="rail-win-label">{t(`shell.win.${kind}`)}</span>
              {n ? <span className="rail-win-count">{n}</span> : null}
            </button>
          );
        })}
      </div>

      <div className="rail-foot">
        <div className="rail-spend">
          <span className="muted">{t('shell.spendToday')}</span>
          <b>{cap !== null ? t('shell.spendOf', { today: money(today), cap: money(cap) }) : money(today)}</b>
        </div>
        <div className="meter"><i className={share > .9 ? 'danger' : share > .75 ? 'warn' : ''} style={{ width: `${share * 100}%` }} /></div>
        <User />
      </div>
    </aside>
  );
}

/**
 * Строка пользователя — и меню того, чему в макете места не нашлось: тема,
 * справка, совещание, редактор расстановки, плоский офис, выход в меню.
 * В HUD это были отдельные кнопки; здесь они спрятаны, потому что нужны
 * раз в день, а не раз в минуту.
 */
function User() {
  const authSource = useStore((s) => s.authSource);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const render3d = useStore((s) => s.render3d);
  const setRender3d = useStore((s) => s.setRender3d);
  const editingLayout = useStore((s) => s.editingLayout);
  const setShell = useStore((s) => s.setShell);
  const leaveOffice = useStore((s) => s.leaveOffice);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onOutside);
    return () => window.removeEventListener('mousedown', onOutside);
  }, [open]);

  const item = (label: string, icon: IconName, onClick: () => void, on = false) => (
    <button className={`rail-menu-item${on ? ' on' : ''}`} onClick={() => { setOpen(false); onClick(); }}>
      <Icon name={icon} size={16} />{label}
    </button>
  );

  return (
    <div className="rail-user" ref={ref}>
      <button className="ghost rail-user-btn" onClick={() => setOpen((v) => !v)}>
        <span className="rail-user-avatar" />
        <span className="rail-user-text">
          <span className="rail-user-name">{t('shell.user')}</span>
          <span className="rail-user-auth">{t(`shell.auth.${authSource}`)}</span>
        </span>
      </button>
      {open && (
        <div className="rail-menu float">
          {item(t('shell.menu.theme'), theme === 'day' ? 'moon' : 'sun', () => setTheme(theme === 'day' ? 'night' : 'day'))}
          {item(t('shell.menu.render'), 'device-desktop', () => setRender3d(!render3d))}
          {item(t('shell.menu.layout'), 'armchair', () => setEditingLayout(!editingLayout), editingLayout)}
          {item(t('shell.menu.classic'), 'grid-dots', () => setShell('classic'))}
          {item(t('shell.menu.reset'), 'refresh', reset)}
          {item(t('shell.menu.leave'), 'home', leaveOffice)}
        </div>
      )}
    </div>
  );
}

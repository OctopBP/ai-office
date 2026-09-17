import { useEffect, useRef, useState } from 'react';
import {
  reset, setEditingLayout, sortedOffices, summarizeOfficeActivity, useStore,
} from '../store';
import type { ModalKind, PanelKind } from '../Overlays';
import { money } from '../money';
import { t } from '../i18n';
import { Icon, type IconName } from '../icons';
import { Kbd } from '../Kbd';
import { Hint, Tooltip } from '../Tooltip';
import { HOTKEY } from '../hotkeys';

/** Буква на иконке офиса: первый символ названия, в верхнем регистре. */
function officeInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0].toUpperCase();
}

type WindowKind = 'board' | 'merge' | 'log' | 'money' | 'meetings' | 'life' | 'flows' | 'team' | 'settings';
const WINDOWS: Array<{ kind: WindowKind; icon: IconName }> = [
  { kind: 'board', icon: 'list-check' },
  { kind: 'merge', icon: 'git-merge' },
  { kind: 'log', icon: 'file-text' },
  { kind: 'money', icon: 'coin' },
  { kind: 'meetings', icon: 'message' },
  { kind: 'life', icon: 'book' },
  { kind: 'flows', icon: 'grid-dots' },
  { kind: 'team', icon: 'users' },
  { kind: 'settings', icon: 'settings' },
];

/**
 * Левый рейл: офисы, окна офиса, расход за день и пользователь. Развёрнутый
 * (264) и свёрнутый до иконок (70) — переключается кнопкой у логотипа и
 * переживает перезагрузку.
 *
 * Список окон — то, что раньше жило только в хоткеях и в HUD: доска, очередь
 * слияния, лог, расходы, команда с маркетом, настройки. Доска здесь ведёт в вид, а не в
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
  const leaveOffice = useStore((s) => s.leaveOffice);

  const list = sortedOffices(offices);
  // Счётчики те же, что были в HUD: в работе — по задачам, а не по позам агентов.
  const all = Object.values(tasks);
  const working = all.filter((x) => x.status === 'in_progress').length;
  const active = all.filter((x) => !['done', 'failed', 'planned'].includes(x.status)).length;
  const readyToMerge = all.filter((x) => x.status === 'done' && x.branch && !x.merged).length;
  // У совещаний счётчик — единица, пока одно идёт: это «сейчас говорят», а не число прошлых.
  const meetingLive = useStore((s) => s.meeting?.status === 'running');
  const counts: Partial<Record<WindowKind, number>> = {
    board: active, merge: readyToMerge, meetings: meetingLive ? 1 : 0,
  };
  // Бейдж «Жизни офиса» — число вопросов владельцу, ждущих решения. Считает
  // сервер (openQuestions в сторе), здесь только форматирование: 0 — бейджа
  // нет вовсе, больше 9 — «9+», чтобы вкладка не гуляла по ширине.
  const openQuestions = useStore((s) => s.openQuestions);
  const lifeBadge = openQuestions > 0 ? (openQuestions > 9 ? '9+' : String(openQuestions)) : null;

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

      {/* Выход на главный экран — на виду, а не в меню пользователя: это единственный
          путь назад к списку офисов, расходам и настройкам без клавиатуры. */}
      <Tooltip tip={collapsed && <Hint label={t('shell.home')} keys={HOTKEY.close} />}>
        <button className="rail-win rail-home" onClick={leaveOffice} disabled={pending === 'enter'}>
          <span className="rail-win-icon"><Icon name="home" size={12} /></span>
          <span className="rail-win-label">{t('shell.home')}</span>
          <Kbd keys={HOTKEY.close} className="rail-win-key" />
        </button>
      </Tooltip>

      <div className="section-title">{t('shell.offices')}</div>
      <div className="rail-offices">
        <div className="rail-office-list">
        {list.map((o) => {
          const activity = summarizeOfficeActivity(o);
          const status = o.current
            ? t('shell.officeStatus', { n: Object.keys(instances).length, working })
            : activity.text;
          return (
            <button key={o.id} className={`rail-office${o.current ? ' current' : ''}`}
              onClick={() => { if (!o.current) enterOffice(o.id); }}
              disabled={pending === 'enter'}
              title={collapsed ? `${o.name} · ${status}` : o.projectDir}>
              <span className="rail-office-avatar">{officeInitial(o.name)}</span>
              <span className="rail-office-text">
                <span className="rail-office-name">{o.name}</span>
                <span className="rail-office-status">{status}</span>
              </span>
              {(o.current || activity.live) && <span className="rail-office-dot" />}
            </button>
          );
        })}
        </div>
        <button className="dashed rail-new" onClick={() => onModal('offices')} title={t('shell.newOffice')}>
          {collapsed ? '+' : t('shell.newOffice')}
        </button>
      </div>

      <div className="rail-sep" />

      <div className="section-title">{t('shell.windows')}</div>
      <div className="rail-windows">
        {WINDOWS.map(({ kind, icon }) => {
          const n = counts[kind];
          const badge = kind === 'life' ? lifeBadge : null;
          const key = (HOTKEY as Partial<Record<WindowKind, string>>)[kind];
          return (
            // Подсказка — только свёрнутому рейлу: развёрнутый и так подписан.
            <Tooltip key={kind} tip={collapsed && <Hint label={t(`shell.win.${kind}`)} keys={key} />}>
              <button className={`rail-win${kind === 'board' && view === 'board' ? ' on' : ''}`}
                onClick={() => openWindow(kind)}>
                <span className="rail-win-icon">
                  {collapsed && n ? n : <Icon name={icon} size={12} />}
                </span>
                <span className="rail-win-label">{t(`shell.win.${kind}`)}</span>
                {n ? <span className="rail-win-count">{n}</span> : null}
                {badge && <span className="rail-win-badge">{badge}</span>}
                {key && <Kbd keys={key} className="rail-win-key" />}
              </button>
            </Tooltip>
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
 * Строка пользователя — и меню того, чему в макете места не нашлось:
 * редактор расстановки, сброс. Тема — в настройках офиса, выход на главный
 * экран — кнопкой под логотипом.
 * В HUD это были отдельные кнопки; здесь они спрятаны, потому что нужны
 * раз в день, а не раз в минуту.
 */
function User() {
  const authSource = useStore((s) => s.authSource);
  const editingLayout = useStore((s) => s.editingLayout);
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
          {item(t('shell.menu.layout'), 'armchair', () => setEditingLayout(!editingLayout), editingLayout)}
          {item(t('shell.menu.reset'), 'refresh', reset)}
        </div>
      )}
    </div>
  );
}

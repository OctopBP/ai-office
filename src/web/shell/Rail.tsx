import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  reorderOffice, reset, setEditingLayout, sortedOffices, summarizeOfficeActivity, useStore,
} from '../store';
import type { ModalKind, PanelKind } from '../Overlays';
import type { OfficeView } from '../../shared/types';
import { money } from '../money';
import { t } from '../i18n';
import { Icon, type IconName } from '../icons';
import { Kbd } from '../Kbd';
import { Hint, Tooltip } from '../Tooltip';
import { HOTKEY } from '../hotkeys';
import { officeAvatarColor, officeAvatarInk } from '../officeColor';
import { OfficeAvatarIcon } from '../OfficeIcon';

/** Сколько пикселей нужно сдвинуть указатель, прежде чем короткий клик по
 * строке офиса считается началом перетаскивания. Меньше — щелчок мышью с
 * лёгкой дрожью руки срывался бы в drag; больше — перетаскивание ощущалось бы
 * вязким. */
const DRAG_THRESHOLD_PX = 5;

/**
 * Список офисов в порядке `ids`. Офис, которого нет в `ids` (список успел
 * измениться, пока прикидка ещё висела — например, завёлся новый офис), не
 * теряется — он просто уходит в конец в своём прежнем относительном порядке.
 */
function reorderByIds(list: OfficeView[], ids: string[]): OfficeView[] {
  const byId = new Map(list.map((o) => [o.id, o] as const));
  const ordered = ids.map((id) => byId.get(id)).filter((o): o is OfficeView => !!o);
  const placed = new Set(ordered.map((o) => o.id));
  return [...ordered, ...list.filter((o) => !placed.has(o.id))];
}

/**
 * Перетаскивание строк офиса в рейле — на pointer events, без библиотек.
 *
 * Порядок при отпускании считается местом в списке БЕЗ самого перетаскиваемого
 * офиса — ровно то, что ждёт команда `reorder_office` на сервере
 * (см. `reorderOffice` в `offices.ts`), поэтому индекс можно послать как есть.
 *
 * Пока сервер не подтвердил перестановку своим событием `offices`, список
 * держит собственную прикидку (`optimisticOrder`): иначе строка на секунду
 * прыгала бы обратно и потом снова на новое место. Правда остаётся за
 * сервером — прикидка снимается, как только придёт новое состояние офисов
 * (`offices` из стора — не пересчитанный на каждый рендер `list`: у него
 * новая ссылка при каждом вызове `sortedOffices`, и завязка на него снимала
 * бы прикидку раньше, чем она успела бы отрисоваться), а если ответа нет
 * вовсе (отказ сервера не меняет список), снимается запасным таймером.
 */
function useOfficeDrag(offices: OfficeView[]) {
  const list = sortedOffices(offices);
  const [drag, setDrag] = useState<{ id: string; overIndex: number } | null>(null);
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const session = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => { setOptimisticOrder(null); }, [offices]);

  useEffect(() => {
    if (!optimisticOrder) return undefined;
    const timer = window.setTimeout(() => setOptimisticOrder(null), 4000);
    return () => window.clearTimeout(timer);
  }, [optimisticOrder]);

  // Место вставки — по вертикальной середине строк: курсор выше середины
  // строки значит «встать перед ней», иначе — двигаемся ниже. Список берём
  // свежим из стора (а не замыканием на `list`), чтобы не потерять офис,
  // заведшийся прямо во время перетаскивания.
  const overIndexAt = useCallback((clientY: number, dragId: string) => {
    const compare = sortedOffices(useStore.getState().offices).filter((o) => o.id !== dragId);
    for (let i = 0; i < compare.length; i++) {
      const el = rowRefs.current.get(compare[i].id);
      if (!el) continue;
      if (clientY < el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2) return i;
    }
    return compare.length;
  }, []);

  const onMove = useCallback((e: PointerEvent) => {
    const s = session.current;
    if (!s) return;
    if (!s.moved) {
      if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < DRAG_THRESHOLD_PX) return;
      s.moved = true;
      document.body.classList.add('office-dragging');
    }
    e.preventDefault();
    setDrag({ id: s.id, overIndex: overIndexAt(e.clientY, s.id) });
  }, [overIndexAt]);

  const onRelease = useCallback((e: PointerEvent | null) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    document.body.classList.remove('office-dragging');
    const s = session.current;
    session.current = null;
    setDrag(null);
    if (!s || !s.moved || !e) return;
    const idx = overIndexAt(e.clientY, s.id);
    const ids = sortedOffices(useStore.getState().offices).filter((o) => o.id !== s.id).map((o) => o.id);
    ids.splice(idx, 0, s.id);
    setOptimisticOrder(ids);
    reorderOffice(s.id, idx);
    // Клик, которым браузер обычно продолжает жест указателя, тут лишний:
    // строку только что перетащили, а не выбрали. `Rail` снимет флаг сам,
    // когда этот клик придёт.
    suppressClickRef.current = true;
  }, [onMove, overIndexAt]);

  const onUp = useCallback((e: PointerEvent) => onRelease(e), [onRelease]);
  const onCancel = useCallback(() => onRelease(null), [onRelease]);

  const onRowPointerDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return;
    session.current = { id, startX: e.clientX, startY: e.clientY, moved: false };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }, [onMove, onUp, onCancel]);

  const rowRef = useCallback((id: string) => (el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.set(id, el); else rowRefs.current.delete(id);
  }, []);

  const consumeSuppressedClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  const dropIndicator = (() => {
    if (!drag) return null;
    const compare = list.filter((o) => o.id !== drag.id);
    if (drag.overIndex < compare.length) return { before: compare[drag.overIndex].id };
    const last = compare[compare.length - 1];
    return last ? { after: last.id } : null;
  })();

  return {
    renderList: optimisticOrder ? reorderByIds(list, optimisticOrder) : list,
    dropIndicator,
    isDragging: (id: string) => drag?.id === id,
    onRowPointerDown,
    rowRef,
    consumeSuppressedClick,
  };
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

  const { renderList, dropIndicator, isDragging, onRowPointerDown, rowRef, consumeSuppressedClick } =
    useOfficeDrag(offices);
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
        {renderList.map((o) => {
          const activity = summarizeOfficeActivity(o);
          // У текущего офиса подпись своя — сколько в нём людей и сколько
          // занято. Пауза важнее этой арифметики: пока она стоит, «занято 0»
          // означает не «все свободны», а «работа не начнётся».
          const status = activity.paused
            ? t('office.paused')
            : o.current
              ? t('shell.officeStatus', { n: Object.keys(instances).length, working })
              : activity.text;
          const mark = activity.paused ? 'paused' : activity.live ? 'live' : 'idle';
          const markHint = activity.paused
            ? t('office.paused.hint')
            : activity.live ? t('office.working.hint') : t('office.idle.hint');
          // Архивный офис перетащить нечем (T-64/T-65 его не показывают
          // человеку как рабочий) — строка остаётся кликабельной, но без
          // ручки перетаскивания и её курсора.
          const draggable = !o.archived;
          const cls = [
            'rail-office',
            o.current && 'current',
            draggable && 'draggable',
            isDragging(o.id) && 'dragging',
            dropIndicator?.before === o.id && 'drop-before',
            dropIndicator?.after === o.id && 'drop-after',
          ].filter(Boolean).join(' ');
          return (
            <button key={o.id} ref={rowRef(o.id)} className={cls}
              onPointerDown={draggable ? (e) => onRowPointerDown(e, o.id) : undefined}
              onClick={() => {
                if (consumeSuppressedClick()) return;
                if (!o.current) enterOffice(o.id);
              }}
              disabled={pending === 'enter'}
              title={collapsed ? `${o.name} · ${status}` : o.projectDir}>
              <span className="rail-office-avatar"
                style={{ background: officeAvatarColor(o.id), color: officeAvatarInk(o.id) }}>
                <OfficeAvatarIcon office={o} imgClass="rail-office-icon-img" />
              </span>
              <span className="rail-office-text">
                <span className="rail-office-name">{o.name}</span>
                <span className="rail-office-status">{status}</span>
              </span>
              {/* Метка статуса есть у каждого офиса — иначе «на паузе» и
                  «простаивает» в списке выглядят одинаково. Пауза помечена не
                  только цветом, но и знаком ⏸: по одному цвету статус читают
                  не все. Подсказка висит на самой метке: заголовок строки
                  занят путём проекта. */}
              <span className={`rail-office-dot ${mark}`} title={markHint}>
                {activity.paused && <Icon name="player-pause" size={9} />}
              </span>
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

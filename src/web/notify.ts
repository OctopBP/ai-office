/**
 * Системные уведомления офиса: офис ждёт владельца или случилось важное, а
 * окно не на переднем плане.
 *
 * Одна реализация на браузер и приложение: в рендерере Electron тот же
 * Notification API показывает нативное уведомление ОС.
 *
 * Логика здесь, а не в компонентах: офис — визуализация, и уведомление не
 * должно зависеть от того, какая панель сейчас нарисована. Модуль слушает
 * события сервера уже после того, как стор их применил, и сравнивает набор
 * «поводов» — открытый вопрос, проваленная задача, вставший конвейер и так
 * далее — с тем, что было до события. Новый повод даёт одно уведомление.
 * Снимок (первое подключение, переподключение, смена офиса) повод не
 * показывает, а только запоминает: иначе каждый возврат связи давал бы залп
 * по давно известным вопросам.
 */
import { OFFICE_SENDER, type ServerEvent } from '../shared/types';
import { t } from './i18n';
import { displayInstance } from './instanceName';
import { onServerEvent, useStore } from './store';

const STORAGE_KEY = 'office-notify';

/**
 * Мост приложения для macOS и Windows (desktop/office-preload.js). В браузере
 * его нет — тогда всё идёт через обычные API страницы.
 */
interface OfficeDesktop {
  /** Восстановить окно из свёрнутого и вывести на передний план. */
  focus(): void;
  /** Число того, что ждёт владельца: значок в доке, подсветка на панели задач. Ноль снимает. */
  setBadge(count: number): void;
}

declare global {
  interface Window {
    officeDesktop?: OfficeDesktop;
  }
}

/**
 * window.focus() из страницы поднять свёрнутое окно не может: система отдаёт
 * фокус только процессу, который попросил сам. В приложении просит main.
 */
function focusWindow(): void {
  if (window.officeDesktop) window.officeDesktop.focus();
  else window.focus();
}

/** Куда вести по клику: вопрос — в «Жизнь офиса», задачу — на доску. */
type Target =
  | { kind: 'life' }
  | { kind: 'task'; taskId: string }
  | { kind: 'board' }
  | { kind: 'money' };

/** Повод для уведомления. `key` — и ключ сравнения, и tag уведомления. */
interface Reason {
  key: string;
  body: string;
  target: Target;
}

/** События, после которых набор поводов может поменяться. Прочие — тики сцены и чата. */
const RELEVANT = new Set<ServerEvent['t']>([
  'task', 'task.remove', 'epic', 'question', 'run', 'pr', 'limits', 'usage', 'settings',
]);

export type NotifyPermission = NotificationPermission | 'unsupported';

export const notifySupported = (): boolean => typeof Notification !== 'undefined';

export const notifyPermission = (): NotifyPermission =>
  (notifySupported() ? Notification.permission : 'unsupported');

/** Выбор человека в настройках. Разрешение браузера — отдельно: без него выбор ничего не даёт. */
export const notifyWanted = (): boolean => localStorage.getItem(STORAGE_KEY) === 'on';

/**
 * Переключатель «Системные уведомления». Разрешение спрашивается здесь, по
 * действию человека, а не при загрузке: браузеры глушат запросы без жеста, а
 * человек, которого спросили на входе, не знает, о чём его спрашивают.
 */
export async function setNotifyWanted(on: boolean): Promise<NotifyPermission> {
  localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  if (!on || !notifySupported()) return notifyPermission();
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

const clip = (text: string, n = 140): string =>
  (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

/** Все поводы по текущему состоянию стора. */
function reasons(): Reason[] {
  const s = useStore.getState();
  const out: Reason[] = [];

  for (const q of s.questions) {
    if (q.answeredAt || q.dismissedAt) continue;
    // Вопрос-согласование ведёт к задаче: владельцу важнее, что стоит, а
    // ответить он может и в карточке, и в «Жизни офиса».
    if (q.kind === 'gate' && q.taskId) {
      out.push({ key: `q:${q.id}`, body: t('notify.gate', { task: q.taskId }), target: { kind: 'life' } });
      continue;
    }
    const who = q.from === OFFICE_SENDER ? t('notify.fromOffice') : displayInstance(q.from, s.instances, s.roles);
    out.push({ key: `q:${q.id}`, body: clip(`${who}: ${q.text}`), target: { kind: 'life' } });
  }

  // Конвейер встаёт и прогоном, и пулл-реквестом — часто одновременно. Ключ
  // один на задачу, чтобы это было одно уведомление, а не два.
  const stuck = new Set<string>();
  for (const run of Object.values(s.runs)) {
    if (run.status === 'stuck' && run.subject.taskId) stuck.add(run.subject.taskId);
  }
  for (const pr of Object.values(s.prs)) {
    if (pr.stage === 'stuck') stuck.add(pr.taskId);
  }
  for (const taskId of stuck) {
    if (s.tasks[taskId]?.status === 'cancelled') continue;
    out.push({ key: `stuck:${taskId}`, body: t('notify.stuck', { task: taskId }), target: { kind: 'task', taskId } });
  }

  let limited = s.limits.status === 'rejected';
  for (const task of Object.values(s.tasks)) {
    if (task.limitedAt) limited = true;
    if (task.status === 'failed') {
      out.push({
        key: `failed:${task.id}`,
        body: clip(t('notify.failed', { task: task.id, title: task.title })),
        target: { kind: 'task', taskId: task.id },
      });
    }
  }

  for (const epic of Object.values(s.epics)) {
    if (epic.status === 'planned' && !epic.approved) {
      out.push({ key: `epic:${epic.id}:approve`, body: clip(t('notify.epicApprove', { title: epic.title })), target: { kind: 'board' } });
    } else if (epic.status === 'done') {
      out.push({ key: `epic:${epic.id}:done`, body: clip(t('notify.epicDone', { title: epic.title })), target: { kind: 'board' } });
    }
  }

  if (limited) out.push({ key: 'limit:plan', body: t('notify.limitPlan'), target: { kind: 'money' } });
  const cap = s.settings.globalBudgetUsd;
  if (cap !== null && s.usage.costUsd >= cap) {
    out.push({
      key: 'limit:budget',
      body: t('notify.limitBudget', { spent: s.usage.costUsd.toFixed(2), cap: cap.toFixed(2) }),
      target: { kind: 'money' },
    });
  }
  return out;
}

/**
 * Поводы, известные на момент последнего события, по офису. null — снимка
 * ещё не было, сравнивать не с чем. На уровне модуля, а не в замыкании:
 * App перемонтируется на смене языка, и заново подписанный слушатель не
 * должен принять всё известное за новое.
 */
let known: { officeId: string; keys: Set<string> } | null = null;

/** Куда вести после входа в офис: клик пришёл по офису, который сейчас не открыт. */
let pendingJump: { officeId: string; target: Target } | null = null;

const currentOffice = () => useStore.getState().offices.find((o) => o.current) ?? null;

function jump(target: Target): void {
  const s = useStore.getState();
  if (target.kind === 'task') {
    s.setView('board');
    s.openTaskCard(target.taskId);
  } else if (target.kind === 'board') {
    s.setView('board');
  } else {
    useStore.setState({ panelRequest: target.kind });
  }
}

function open(officeId: string, target: Target): void {
  focusWindow();
  const s = useStore.getState();
  const office = currentOffice();
  if (office?.id === officeId && s.screen === 'office' && !s.pending) {
    jump(target);
    return;
  }
  // Офис не открыт или открыт не этот: сначала вход, место — когда придёт его снимок.
  pendingJump = { officeId, target };
  s.enterOffice(officeId);
}

function show(officeId: string, title: string, reason: Reason): void {
  if (!notifyWanted() || notifyPermission() !== 'granted') return;
  // Человек смотрит на офис — ему всё видно и так.
  if (!document.hidden && document.hasFocus()) return;
  try {
    // tag — вторая защита от дублей: две вкладки офиса покажут одно уведомление.
    const n = new Notification(title, { body: reason.body, tag: `${officeId}:${reason.key}` });
    n.onclick = () => { n.close(); open(officeId, reason.target); };
  } catch {
    // Chrome на Android требует ServiceWorker для `new Notification` — там
    // уведомлений просто не будет, офис от этого не ломается.
  }
}

/**
 * Сколько ждёт владельца: открытые вопросы (согласования задач среди них) и
 * фичи, которые ждут его «поехали». Не зависит от переключателя уведомлений:
 * значок никого не отвлекает, он просто виден, когда есть на что ответить.
 */
function waitingCount(): number {
  const s = useStore.getState();
  if (!currentOffice()) return 0;
  const questions = s.questions.filter((q) => !q.answeredAt && !q.dismissedAt).length;
  const epics = Object.values(s.epics).filter((e) => e.status === 'planned' && !e.approved).length;
  return questions + epics;
}

/** Последнее отправленное в мост число: одно и то же не шлём на каждом событии. */
let badge = -1;

function updateBadge(): void {
  const bridge = window.officeDesktop;
  if (!bridge) return;
  const n = waitingCount();
  if (n === badge) return;
  badge = n;
  bridge.setBadge(n);
}

function handle(e: ServerEvent): void {
  if (e.t === 'snapshot' || RELEVANT.has(e.t)) updateBadge();
  const office = currentOffice();
  if (e.t === 'snapshot') {
    known = office ? { officeId: office.id, keys: new Set(reasons().map((r) => r.key)) } : null;
    if (pendingJump && office?.id === pendingJump.officeId) {
      const { target } = pendingJump;
      pendingJump = null;
      jump(target);
    }
    return;
  }
  if (!RELEVANT.has(e.t) || !office) return;
  // Офис сменился без снимка — сравнивать с чужими поводами нельзя.
  if (!known || known.officeId !== office.id) {
    known = { officeId: office.id, keys: new Set(reasons().map((r) => r.key)) };
    return;
  }
  const now = reasons();
  for (const r of now) {
    if (!known.keys.has(r.key)) show(office.id, office.name, r);
  }
  // Ушедший повод забывается: задача, провалившаяся снова после перезапуска,
  // снова стоит уведомления.
  known.keys = new Set(now.map((r) => r.key));
}

/** Подключить уведомления. Вызывается из App; возвращает отписку. */
export function startNotify(): () => void {
  return onServerEvent(handle);
}

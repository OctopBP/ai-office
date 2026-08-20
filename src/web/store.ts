import { create } from 'zustand';
import type {
  ChatEntry, DayUsage, InstanceView, LogEntry, MergeCheck, MergeCheckState, MergeRun, MergeStep,
  MergeStepStatus, PermissionDecision, PermissionRequest, MeetingView, RoleEditable, RoleView,
  ServerEvent, Settings, TaskView, Usage, CloudStatus, OfficeView,
} from '../shared/types';
import { emptyUsage } from '../shared/types';
import type { Theme } from './sprites';
import { kitchenSeatFor } from './desks';
import { meetingSeat } from './meetingSeats';

interface Pos { x: number; y: number }

/**
 * «Домашняя» позиция агента, когда он не на совещании и не в момент передачи
 * задачи: PM и занятые задачей исполнители сидят за своим столом, свободные —
 * на кухне. Источник истины — currentTaskId из InstanceView, отдельного
 * флага занятости на клиенте не заводим.
 */
function homePos(inst: InstanceView, roles: RoleView[]): Pos {
  const isManager = roles.find((r) => r.id === inst.roleId)?.isManager ?? false;
  if (isManager || inst.currentTaskId) return { x: inst.desk.x, y: inst.desk.y };
  return kitchenSeatFor(inst.desk.index);
}

export interface Toast {
  id: string;
  kind: 'done' | 'failed' | 'info';
  title: string;
  detail?: string;
  taskId?: string;
}

interface State {
  connected: boolean;
  busy: boolean;
  /** Офис на паузе: новая работа не запускается, исполнители замирают. */
  paused: boolean;
  /** Стартовое меню выбора офиса или уже открытая комната. */
  screen: 'menu' | 'office';
  /** Пришёл ли хоть один snapshot — до этого момента список офисов неизвестен. */
  booted: boolean;
  /** За 8 секунд после подключения snapshot не пришёл — сервер, видимо, недоступен. */
  connectFailed: boolean;
  /** Идёт вход в другой офис или создание нового: ждём новый snapshot или ошибку. */
  pending: 'enter' | 'create' | null;
  /** Название офиса, к которому относится pending — для «Входим в «Х»…». */
  pendingLabel: string | null;
  /** Ошибка входа или создания офиса, которую нужно показать в меню. */
  menuNotice: { kind: 'blocked' | 'create-error'; text: string } | null;
  /** Офисы = проекты: список и текущий. */
  offices: OfficeView[];
  /** Готовность облачного режима: ключ API и токен GitHub. */
  cloud: CloudStatus;
  /** Расход офиса за всё время и по дням — для HUD и панели расходов. */
  usage: Usage;
  usageDays: DayUsage[];
  projectDir: string;
  authSource: 'subscription' | 'api-key' | 'unknown';
  roles: RoleView[];
  instances: Record<string, InstanceView>;
  tasks: Record<string, TaskView>;
  chat: ChatEntry[];
  log: LogEntry[];
  permissions: PermissionRequest[];
  settings: Settings;
  meeting: MeetingView | null;
  /** Порядок задач, которые пользователь набрал для следующего запуска очереди слияния. */
  mergeSelection: string[];
  /** Статусы мержабельности завершённых задач, по taskId — приходят от сервера целиком. */
  mergeChecks: Record<string, MergeCheck>;
  /** Идёт ли сейчас пересчёт статусов: пока он идёт, старые статусы ещё валидны. */
  mergeChecking: boolean;
  /** Последний (или ещё идущий) прогон очереди слияния. */
  mergeRun: MergeRun | null;
  toggleMergeSelect: (taskId: string) => void;
  moveMergeSelect: (taskId: string, dir: -1 | 1) => void;
  clearMergeSelection: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  toasts: Toast[];
  /** Показанный сейчас дифф задачи. */
  diff: { taskId: string; stat: string; patch: string; truncated: boolean; error?: string } | null;
  /** Визуальные позиции — отдельно от логики: ходьба это чистая анимация. */
  pos: Record<string, Pos>;
  selected: string | null;
  /** Активная ветка чата: 'pm#1' или id агента. */
  thread: string;
  setThread: (t: string) => void;
  select: (id: string | null) => void;
  apply: (e: ServerEvent) => void;
  setConnected: (v: boolean) => void;
  /** Войти в офис из меню: текущий — сразу, иначе переключение на сервере. */
  enterOffice: (officeId: string) => void;
  /**
   * Выйти в меню — офис на сервере при этом не меняется, поэтому дёргать
   * switch_office незачем: это только локальная смена экрана. Соединение
   * остаётся подписанным на тот же офис, агенты продолжают работать и
   * события по-прежнему долетают до стора, просто пока не отрисовываются.
   */
  leaveOffice: () => void;
  /** Отправить создание офиса из меню и ждать снапшот или ошибку. */
  requestCreateOffice: (name: string, projectDir: string) => void;
  dismissMenuNotice: () => void;
}

export const useStore = create<State>((set, get) => ({
  connected: false,
  busy: false,
  paused: false,
  screen: 'menu',
  booted: false,
  connectFailed: false,
  pending: null,
  pendingLabel: null,
  menuNotice: null,
  offices: [],
  cloud: { hasKey: false, hasToken: false },
  usage: emptyUsage(),
  usageDays: [],
  projectDir: '',
  authSource: 'unknown',
  roles: [],
  instances: {},
  tasks: {},
  chat: [],
  log: [],
  permissions: [],
  settings: { globalBudgetUsd: null, taskBudgetUsd: null, engine: 'local', cloudRepoUrl: null },
  meeting: null,
  mergeSelection: [],
  mergeChecks: {},
  mergeChecking: false,
  mergeRun: null,
  toggleMergeSelect: (taskId) => set((s) => ({
    mergeSelection: s.mergeSelection.includes(taskId)
      ? s.mergeSelection.filter((id) => id !== taskId)
      : [...s.mergeSelection, taskId],
  })),
  moveMergeSelect: (taskId, dir) => set((s) => {
    const i = s.mergeSelection.indexOf(taskId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= s.mergeSelection.length) return {};
    const next = [...s.mergeSelection];
    [next[i], next[j]] = [next[j], next[i]];
    return { mergeSelection: next };
  }),
  clearMergeSelection: () => set({ mergeSelection: [] }),
  theme: (localStorage.getItem('office-theme') as Theme | null) ?? 'day',
  toasts: [],
  diff: null,
  pos: {},
  selected: null,
  thread: 'pm#1',

  setThread: (t) => set({ thread: t }),
  setTheme: (t) => { localStorage.setItem('office-theme', t); set({ theme: t }); },
  select: (id) => set({ selected: id }),
  setConnected: (v) => set({ connected: v }),

  enterOffice: (officeId) => {
    const s = get();
    const office = s.offices.find((o) => o.id === officeId);
    if (!office) return;
    if (office.current) { set({ screen: 'office' }); return; }
    // Переключение больше не требует остановки задач в работе — сервер сам
    // держит их сессии поверх смены офиса, поэтому клиент их не проверяет.
    // Сбрасываем UI прежнего офиса, чтобы выделение, чат-ветка и открытый
    // дифф не «протекали» в новый: панели закрывает App при входе в pending.
    set({
      pending: 'enter', pendingLabel: office.name, menuNotice: null,
      selected: null, thread: 'pm#1', diff: null,
    });
    switchOffice(officeId);
  },

  leaveOffice: () => set({
    screen: 'menu',
    // UI-состояние привязано к конкретному офису: не должно протекать ни в
    // меню, ни в следующий открытый офис.
    selected: null,
    thread: 'pm#1',
    diff: null,
    menuNotice: null,
  }),

  requestCreateOffice: (name, projectDir) => {
    set({ pending: 'create', pendingLabel: name.trim() || projectDir.trim(), menuNotice: null });
    createOffice(name, projectDir);
  },

  dismissMenuNotice: () => set({ menuNotice: null }),

  apply: (e) => {
    switch (e.t) {
      case 'snapshot': {
        const instances = Object.fromEntries(e.instances.map((i) => [i.id, i]));
        const pos = Object.fromEntries(e.instances.map((i) => [i.id, homePos(i, e.roles)]));
        set((s) => ({
          roles: e.roles, instances, pos,
          tasks: Object.fromEntries(e.tasks.map((t) => [t.id, t])),
          chat: e.chat, log: e.log, permissions: e.permissions, settings: e.settings,
          projectDir: e.projectDir, authSource: e.authSource, meeting: e.meeting, busy: e.busy,
          paused: e.paused, usage: e.usage.total, usageDays: e.usage.days,
          offices: e.offices, cloud: e.cloud,
          mergeChecks: Object.fromEntries(e.mergeChecks.map((c) => [c.taskId, c])),
          mergeRun: e.mergeRun,
          booted: true, connectFailed: false,
          // Снапшот пришёл во время входа/создания — офис открыт, показываем комнату.
          screen: s.pending ? 'office' : s.screen,
          pending: null, pendingLabel: null,
          // Снапшот — это либо переподключение, либо реальное переключение
          // офиса (switch_office шлёт именно snapshot, не точечный patch):
          // выделение, ветка чата и открытый дифф предыдущего офиса тут
          // больше не про что.
          selected: null,
          thread: 'pm#1',
          diff: null,
        }));
        break;
      }
      case 'instance': {
        const s0 = get();
        const prevInst = s0.instances[e.instance.id];
        const wasBusy = !!prevInst?.currentTaskId;
        const isBusy = !!e.instance.currentTaskId;
        // Место меняем только когда реально сменился статус занятости —
        // иначе каждое обновление расхода/заметки дёргало бы человечка.
        // На совещании стол/кухня подождут: место освободится, когда оно закончится.
        const inMeetingNow = s0.meeting?.status === 'running'
          && s0.meeting.participants.includes(e.instance.id);
        const shouldMove = !s0.pos[e.instance.id] || (wasBusy !== isBusy && !inMeetingNow);
        set((s) => ({
          instances: { ...s.instances, [e.instance.id]: e.instance },
          pos: shouldMove ? { ...s.pos, [e.instance.id]: homePos(e.instance, s.roles) } : s.pos,
        }));
        break;
      }
      case 'instance.remove':
        set((s) => {
          const instances = { ...s.instances };
          delete instances[e.id];
          return { instances };
        });
        break;
      case 'task': {
        const before = get().tasks[e.task.id];
        const t = e.task;
        set((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
        // Тост только на смену статуса, иначе он всплывал бы на каждое
        // обновление стоимости и токенов.
        if (before?.status !== t.status && (t.status === 'done' || t.status === 'failed')) {
          const files = t.files.length ? ` · ${t.files.length} файла` : '';
          pushToast({
            id: `${t.id}-${t.status}`,
            kind: t.status === 'done' ? 'done' : 'failed',
            title: `${t.assigneeId ?? 'кто-то'} ${t.status === 'done' ? 'закончил' : 'провалил'} ${t.id} «${t.title}»`,
            detail: t.status === 'done'
              ? `+$${t.usage.costUsd.toFixed(3)}${files}${t.branch && !t.merged ? ' · нужно слияние' : ''}`
              : (t.result ?? '').slice(0, 120),
            taskId: t.id,
          });
        }
        break;
      }
      case 'chat':
        set((s) => {
          if (s.chat.some((c) => c.id === e.entry.id)) return {};
          const chat = [...s.chat, e.entry];
          // Сервер сообщает об отказе входа/создания офиса обычной репликой
          // «офис» в общий чат — отдельного события протокол пока не даёт
          // (см. docs/design/office-menu/spec.md, §4). Пока мы ждём ответ
          // на вход или создание, такая реплика — это и есть ошибка меню.
          if (e.entry.from === 'офис' && s.pending) {
            return {
              chat,
              pending: null,
              pendingLabel: null,
              menuNotice: { kind: s.pending === 'create' ? 'create-error' : 'blocked', text: e.entry.text },
            };
          }
          return { chat };
        });
        break;
      case 'log':
        set((s) => (s.log.some((l) => l.id === e.entry.id)
          ? {}
          : { log: [...s.log.slice(-300), e.entry] }));
        break;
      case 'busy':
        set({ busy: e.busy });
        break;
      case 'paused':
        set({ paused: e.paused });
        break;
      case 'offices':
        set({ offices: e.offices });
        break;
      case 'cloud':
        set({ cloud: e.cloud });
        break;
      case 'usage':
        set({ usage: e.total, usageDays: e.days });
        break;
      case 'roles':
        set({ roles: e.roles });
        break;
      case 'settings':
        set({ settings: e.settings });
        break;
      case 'task.diff':
        set({ diff: { taskId: e.taskId, stat: e.stat, patch: e.patch, truncated: e.truncated, error: e.error } });
        break;
      case 'merge.checks':
        set({
          mergeChecks: Object.fromEntries(e.checks.map((c) => [c.taskId, c])),
          mergeChecking: e.checking,
        });
        break;
      case 'merge.run':
        set({ mergeRun: e.run });
        break;
      case 'meeting': {
        set({ meeting: e.meeting });
        // Рассаживаем участников за стол переговорки и возвращаем на места после.
        const insts = get().instances;
        set((s) => {
          const pos = { ...s.pos };
          if (e.meeting) {
            const total = e.meeting.participants.length;
            e.meeting.participants.forEach((id, i) => {
              const seat = meetingSeat(i, total);
              pos[id] = { x: seat.x, y: seat.y };
            });
          } else {
            for (const inst of Object.values(insts)) {
              pos[inst.id] = homePos(inst, s.roles);
            }
          }
          return { pos };
        });
        break;
      }
      case 'permission.request':
        set((s) => ({ permissions: [...s.permissions, e.request] }));
        break;
      case 'permission.resolved':
        set((s) => ({ permissions: s.permissions.filter((p) => p.id !== e.id) }));
        break;
      case 'handoff': {
        // Хореография передачи задачи: PM идёт к столу исполнителя и возвращается.
        const target = get().instances[e.to];
        const home = get().instances[e.from];
        if (!target || !home) break;
        set((s) => ({ pos: { ...s.pos, [e.from]: { x: target.desk.x - 1.1, y: target.desk.y + 0.9 } } }));
        setTimeout(() => {
          set((s) => ({ pos: { ...s.pos, [e.from]: { x: home.desk.x, y: home.desk.y } } }));
        }, 2600);
        break;
      }
    }
  },
}));

let socket: WebSocket | null = null;

function pushToast(toast: Toast): void {
  useStore.setState((s) => (s.toasts.some((t) => t.id === toast.id)
    ? {}
    : { toasts: [...s.toasts, toast] }));
  setTimeout(() => dismissToast(toast.id), 20000);
}

export function dismissToast(id: string): void {
  useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function connect(): void {
  // StrictMode монтирует эффекты дважды, а reconnect может наложиться на живое
  // соединение. Без этой защиты образуется второй сокет, и каждое событие
  // применяется дважды — в чате появляются дубли записей.
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  // Собранный веб приходит с того же порта, что и WebSocket, — адрес берём
  // из страницы. В dev странице отдаёт vite (:5173), а сервер живёт отдельно.
  const url = import.meta.env.DEV
    ? `ws://${location.hostname}:${import.meta.env.VITE_OFFICE_PORT ?? 3001}`
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  socket = new WebSocket(url);
  socket.onopen = () => useStore.getState().setConnected(true);
  socket.onclose = () => {
    useStore.getState().setConnected(false);
    setTimeout(connect, 1500);
  };
  socket.onmessage = (ev) => useStore.getState().apply(JSON.parse(ev.data) as ServerEvent);
  // Сокет может открыться, а snapshot — не прийти (сервер завис на старте).
  // Без этого таймаута экран меню молча висел бы на «Открываем офис…» вечно.
  setTimeout(() => {
    if (!useStore.getState().booted) useStore.setState({ connectFailed: true });
  }, 8000);
}

/** Кнопка «Повторить» на экране меню при ошибке подключения. */
export function retryConnect(): void {
  useStore.setState({ connectFailed: false });
  connect();
}

/** «сегодня в 14:32» / «вчера в 09:10» / «3 дня назад» / «12 мая» / «ещё не открывался». */
export function formatLastOpened(ts: number): string {
  if (!ts) return 'ещё не открывался';
  const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const time = new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const daysAgo = Math.max(0, Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000));
  if (daysAgo === 0) return `сегодня в ${time}`;
  if (daysAgo === 1) return `вчера в ${time}`;
  if (daysAgo < 7) {
    const mod10 = daysAgo % 10;
    const mod100 = daysAgo % 100;
    const word = mod10 === 1 && mod100 !== 11 ? 'день'
      : [2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100) ? 'дня' : 'дней';
    return `${daysAgo} ${word} назад`;
  }
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/** Текущий офис — всегда первой строкой, остальные по убыванию времени открытия. */
export function sortedOffices(offices: OfficeView[]): OfficeView[] {
  return [...offices].sort((a, b) => (
    a.current !== b.current ? (a.current ? -1 : 1) : b.lastOpenedAt - a.lastOpenedAt
  ));
}

/** Отправляет в активную ветку: менеджеру или напрямую агенту. */
export function send(text: string): void {
  const thread = useStore.getState().thread;
  socket?.send(thread === 'pm#1'
    ? JSON.stringify({ c: 'user_message', text })
    : JSON.stringify({ c: 'talk', instanceId: thread, text }));
}

export function decide(id: string, decision: PermissionDecision): void {
  socket?.send(JSON.stringify({ c: 'permission', id, decision }));
}

/** Слить одну задачу — очередь длиной в один шаг, тот же путь на сервере. */
export function mergeTask(taskId: string): void {
  socket?.send(JSON.stringify({ c: 'merge_task', taskId }));
}

/** Пересчитать статусы мержабельности всех завершённых задач. */
export function mergeCheck(): void {
  socket?.send(JSON.stringify({ c: 'merge_check' }));
}

/** Слить задачи по очереди в заданном порядке; сервер остановится на первой беде. */
export function startMergeQueue(taskIds: string[]): void {
  if (taskIds.length === 0) return;
  socket?.send(JSON.stringify({ c: 'merge_queue', taskIds }));
  useStore.setState({ mergeSelection: [] });
}

const MERGE_CHECK_LABEL: Record<MergeCheckState, string> = {
  unknown: 'не проверено',
  clean: 'сольётся чисто',
  conflict: 'конфликт',
  nothing: 'нечего сливать',
};

const MERGE_CHECK_CLASS: Record<MergeCheckState, string> = {
  unknown: 'unknown',
  clean: 'clean',
  conflict: 'conflict',
  nothing: 'merged',
};

export const MERGE_STEP_LABEL: Record<MergeStepStatus, string> = {
  merged: 'слита',
  nothing: 'нечего сливать',
  conflict: 'конфликт',
  'typecheck-failed': 'сборка сломана',
  failed: 'ошибка',
  skipped: 'пропущена',
  pending: 'в очереди',
};

/** Класс бейджа для статуса шага очереди — свой набор цветов, отдельный от MergeCheckState. */
export function mergeStepClass(status: MergeStepStatus): string {
  switch (status) {
    case 'merged':
    case 'nothing':
      return 'merged';
    case 'conflict':
    case 'typecheck-failed':
    case 'failed':
      return 'conflict';
    case 'skipped':
      return 'unknown';
    case 'pending':
    default:
      return 'checking';
  }
}

/** Шаг задачи в прогоне очереди, если он там есть. */
export function mergeStepFor(run: MergeRun | null, taskId: string): MergeStep | undefined {
  return run?.steps.find((s) => s.taskId === taskId);
}

/**
 * Компактный бейдж для карточки задачи: пока в последнем прогоне очереди у
 * задачи есть исход (шаг не 'pending'), он важнее статичной предпроверки —
 * он и приоритетнее, потому что новее.
 */
export function mergeBadge(t: TaskView, step: MergeStep | undefined, check: MergeCheck | undefined): { label: string; cls: string } | null {
  if (!t.branch) return null;
  if (t.merged) return { label: 'влита', cls: 'merged' };
  if (t.status !== 'done') return null;
  if (step && step.status !== 'pending') {
    return { label: MERGE_STEP_LABEL[step.status], cls: mergeStepClass(step.status) };
  }
  if (!check) return { label: 'не проверено', cls: 'unknown' };
  return { label: MERGE_CHECK_LABEL[check.state], cls: MERGE_CHECK_CLASS[check.state] };
}

export function hire(roleId: string): void {
  socket?.send(JSON.stringify({ c: 'spawn', roleId }));
}

export function fire(instanceId: string): void {
  socket?.send(JSON.stringify({ c: 'fire', instanceId }));
}

export function updateRole(roleId: string, patch: Partial<RoleEditable>): void {
  socket?.send(JSON.stringify({ c: 'update_role', roleId, patch }));
}

export function updateSettings(settings: Partial<Settings>): void {
  socket?.send(JSON.stringify({ c: 'settings', settings }));
}

export function stopTask(taskId: string): void {
  socket?.send(JSON.stringify({ c: 'stop_task', taskId }));
}

export function retryTask(taskId: string): void {
  socket?.send(JSON.stringify({ c: 'retry_task', taskId }));
}

export function callMeeting(topic: string, participants: string[]): void {
  socket?.send(JSON.stringify({ c: 'meeting', topic, participants }));
}

export function showDiff(taskId: string): void {
  useStore.setState({ diff: { taskId, stat: '', patch: '', truncated: false } });
  socket?.send(JSON.stringify({ c: 'task_diff', taskId }));
}

export function closeDiff(): void {
  useStore.setState({ diff: null });
}

export function assignDirect(taskId: string, instanceId: string): void {
  socket?.send(JSON.stringify({ c: 'assign_direct', taskId, instanceId }));
}

export function switchOffice(officeId: string): void {
  socket?.send(JSON.stringify({ c: 'switch_office', officeId }));
}

export function createOffice(name: string, projectDir: string): void {
  socket?.send(JSON.stringify({ c: 'create_office', name, projectDir }));
}

export function renameOffice(officeId: string, name: string): void {
  socket?.send(JSON.stringify({ c: 'rename_office', officeId, name }));
}

/** Токен GitHub уходит на сервер и живёт только в памяти процесса. */
export function setCloudToken(token: string): void {
  socket?.send(JSON.stringify({ c: 'cloud_token', token }));
}

export function setPaused(paused: boolean): void {
  socket?.send(JSON.stringify({ c: 'pause', paused }));
}

export function reset(): void {
  socket?.send(JSON.stringify({ c: 'reset' }));
}

import { create } from 'zustand';
import type {
  ChatEntry, InstanceView, LogEntry, PermissionDecision, PermissionRequest,
  MeetingView, RoleEditable, RoleView, ServerEvent, Settings, TaskView,
} from '../shared/types';
import { MEETING_SEATS } from '../shared/types';
import type { Theme } from './sprites';

interface Pos { x: number; y: number }

interface State {
  connected: boolean;
  busy: boolean;
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
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** Визуальные позиции — отдельно от логики: ходьба это чистая анимация. */
  pos: Record<string, Pos>;
  selected: string | null;
  /** Активная ветка чата: 'pm#1' или id агента. */
  thread: string;
  setThread: (t: string) => void;
  select: (id: string | null) => void;
  apply: (e: ServerEvent) => void;
  setConnected: (v: boolean) => void;
}

export const useStore = create<State>((set, get) => ({
  connected: false,
  busy: false,
  projectDir: '',
  authSource: 'unknown',
  roles: [],
  instances: {},
  tasks: {},
  chat: [],
  log: [],
  permissions: [],
  settings: { globalBudgetUsd: null, taskBudgetUsd: null },
  meeting: null,
  theme: (localStorage.getItem('office-theme') as Theme | null) ?? 'day',
  pos: {},
  selected: null,
  thread: 'pm#1',

  setThread: (t) => set({ thread: t }),
  setTheme: (t) => { localStorage.setItem('office-theme', t); set({ theme: t }); },
  select: (id) => set({ selected: id }),
  setConnected: (v) => set({ connected: v }),

  apply: (e) => {
    switch (e.t) {
      case 'snapshot': {
        const instances = Object.fromEntries(e.instances.map((i) => [i.id, i]));
        const pos = Object.fromEntries(e.instances.map((i) => [i.id, { x: i.desk.x, y: i.desk.y }]));
        set({
          roles: e.roles, instances, pos,
          tasks: Object.fromEntries(e.tasks.map((t) => [t.id, t])),
          chat: e.chat, log: e.log, permissions: e.permissions, settings: e.settings,
          projectDir: e.projectDir, authSource: e.authSource, meeting: e.meeting, busy: e.busy,
        });
        break;
      }
      case 'instance': {
        const prev = get().pos[e.instance.id];
        set((s) => ({
          instances: { ...s.instances, [e.instance.id]: e.instance },
          pos: prev ? s.pos : { ...s.pos, [e.instance.id]: { x: e.instance.desk.x, y: e.instance.desk.y } },
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
      case 'task':
        set((s) => ({ tasks: { ...s.tasks, [e.task.id]: e.task } }));
        break;
      case 'chat':
        set((s) => (s.chat.some((c) => c.id === e.entry.id)
          ? {}
          : { chat: [...s.chat, e.entry] }));
        break;
      case 'log':
        set((s) => (s.log.some((l) => l.id === e.entry.id)
          ? {}
          : { log: [...s.log.slice(-300), e.entry] }));
        break;
      case 'busy':
        set({ busy: e.busy });
        break;
      case 'roles':
        set({ roles: e.roles });
        break;
      case 'settings':
        set({ settings: e.settings });
        break;
      case 'meeting': {
        set({ meeting: e.meeting });
        // Рассаживаем участников за стол переговорки и возвращаем на места после.
        const insts = get().instances;
        set((s) => {
          const pos = { ...s.pos };
          if (e.meeting) {
            e.meeting.participants.forEach((id, i) => {
              const seat = MEETING_SEATS[i % MEETING_SEATS.length];
              pos[id] = { x: seat.x, y: seat.y };
            });
          } else {
            for (const inst of Object.values(insts)) {
              pos[inst.id] = { x: inst.desk.x, y: inst.desk.y };
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

export function connect(): void {
  // StrictMode монтирует эффекты дважды, а reconnect может наложиться на живое
  // соединение. Без этой защиты образуется второй сокет, и каждое событие
  // применяется дважды — в чате появляются дубли записей.
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const url = `ws://${location.hostname}:3001`;
  socket = new WebSocket(url);
  socket.onopen = () => useStore.getState().setConnected(true);
  socket.onclose = () => {
    useStore.getState().setConnected(false);
    setTimeout(connect, 1500);
  };
  socket.onmessage = (ev) => useStore.getState().apply(JSON.parse(ev.data) as ServerEvent);
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

export function mergeTask(taskId: string): void {
  socket?.send(JSON.stringify({ c: 'merge_task', taskId }));
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

export function assignDirect(taskId: string, instanceId: string): void {
  socket?.send(JSON.stringify({ c: 'assign_direct', taskId, instanceId }));
}

export function reset(): void {
  socket?.send(JSON.stringify({ c: 'reset' }));
}

// Общие типы между сервером и вебом.

export type AgentState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'walking'
  | 'talking'
  | 'waiting_approval'
  | 'blocked'
  | 'done'
  | 'failed';

export type TaskStatus =
  | 'backlog'
  | 'assigned'
  | 'in_progress'
  | 'review'
  | 'blocked'
  | 'done'
  | 'failed';

export interface Desk {
  index: number;
  x: number; // в клетках сетки
  y: number;
}

/** Поля роли, которые пользователь может менять из UI. */
export interface RoleEditable {
  title: string;
  emoji: string;
  color: string;
  model: string;
  permissionMode: 'auto' | 'ask-risky' | 'ask-writes' | 'readonly';
  maxInstances: number;
  isolate: boolean;
  brief: string;
}

export interface RoleView extends RoleEditable {
  id: string;
  isManager: boolean;
  /** Сколько инстансов сейчас в офисе. */
  active: number;
}

/** Откуда SDK берёт доступ: подписка Claude Code или платный ключ API. */
export type AuthSource = 'subscription' | 'api-key' | 'unknown';

export interface Settings {
  /** Общий потолок расходов офиса, $. null — без ограничения. */
  globalBudgetUsd: number | null;
  /** Потолок на одну задачу, $. null — без ограничения. */
  taskBudgetUsd: number | null;
}

export interface InstanceView {
  id: string;         // 'backend#1'
  roleId: string;
  label: string;      // 'Backend #1'
  desk: Desk;
  state: AgentState;
  currentTaskId: string | null;
  note: string | null; // текущая реплика/действие
  costUsd: number;
}

export interface TaskView {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  roleId: string | null;
  assigneeId: string | null;
  status: TaskStatus;
  result: string | null;
  files: string[];
  /** Изоляция: своя ветка и свой worktree на задачу. */
  branch: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  merged: boolean;
  createdAt: number;
}

export type RiskLevel = 'safe' | 'write' | 'danger';

export interface PermissionRequest {
  id: string;
  agentId: string;
  taskId: string | null;
  toolName: string;
  /** Человекочитаемое описание того, что агент хочет сделать. */
  summary: string;
  /** Подробности: команда целиком, путь к файлу, фрагмент содержимого. */
  detail: string;
  risk: RiskLevel;
  /** Почему спросили — например «команда удаляет файлы». */
  reason: string;
  /** Ключ для «разрешать всегда» в этой сессии, например «Bash:rm». */
  key: string;
  createdAt: number;
}

export type PermissionDecision = 'allow' | 'deny' | 'always';

export interface MeetingSeat { x: number; y: number }

export interface MeetingView {
  id: string;
  topic: string;
  participants: string[];
  /** Кто говорит прямо сейчас. */
  speaking: string | null;
  status: 'running' | 'done' | 'failed';
}

export interface ChatEntry {
  id: string;
  /** Ветка разговора: 'pm#1' — чат с менеджером, иначе id агента. */
  thread: string;
  from: string;   // 'user' | instanceId | 'офис'
  text: string;
  at: number;
}

export interface LogEntry {
  id: string;
  at: number;
  agentId: string | null;
  kind: 'tool' | 'text' | 'system' | 'error';
  text: string;
}

/** Всё, что сервер шлёт в UI. Единственный интерфейс между логикой и картинкой. */
export type ServerEvent =
  | { t: 'snapshot'; roles: RoleView[]; instances: InstanceView[]; tasks: TaskView[];
      chat: ChatEntry[]; log: LogEntry[]; permissions: PermissionRequest[];
      settings: Settings; projectDir: string; authSource: AuthSource;
      meeting: MeetingView | null; busy: boolean }
  | { t: 'instance'; instance: InstanceView }
  | { t: 'instance.remove'; id: string }
  | { t: 'task'; task: TaskView }
  | { t: 'chat'; entry: ChatEntry }
  | { t: 'log'; entry: LogEntry }
  | { t: 'handoff'; from: string; to: string; text: string }
  | { t: 'busy'; busy: boolean }
  | { t: 'roles'; roles: RoleView[] }
  | { t: 'settings'; settings: Settings }
  | { t: 'permission.request'; request: PermissionRequest }
  | { t: 'permission.resolved'; id: string; decision: PermissionDecision }
  | { t: 'meeting'; meeting: MeetingView | null };

/** Всё, что UI шлёт на сервер. */
export type ClientCommand =
  | { c: 'user_message'; text: string }
  | { c: 'permission'; id: string; decision: PermissionDecision }
  | { c: 'merge_task'; taskId: string }
  | { c: 'spawn'; roleId: string }
  | { c: 'fire'; instanceId: string }
  | { c: 'update_role'; roleId: string; patch: Partial<RoleEditable> }
  | { c: 'settings'; settings: Partial<Settings> }
  | { c: 'talk'; instanceId: string; text: string }
  | { c: 'stop_task'; taskId: string }
  | { c: 'retry_task'; taskId: string }
  | { c: 'meeting'; topic: string; participants: string[] }
  | { c: 'reset' };

// Размеры заданы артом: тайл 16 арт-пикселей × SCALE 3 = 48 экранных,
// комната floor.png ровно 1152×720 = 24×15 тайлов.
export const GRID = { cols: 24, cells: 15, cell: 48 };

/** Места за столом переговорки — вокруг него садятся участники совещания. */
export const MEETING_SEATS: MeetingSeat[] = [
  { x: 2.1, y: 11.1 }, { x: 4.6, y: 11.1 },
  { x: 2.1, y: 13.3 }, { x: 4.6, y: 13.3 },
  { x: 6.3, y: 12.2 },
];

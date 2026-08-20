// Общие типы между сервером и вебом.

export type AgentState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'walking'
  | 'talking'
  | 'waiting_approval'
  | 'paused'
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

/**
 * Результат предварительной проверки, сольётся ли ветка задачи без конфликтов.
 * Поле на TaskView сделано опциональным: сервер пока эту проверку не считает,
 * и до её появления клиент должен трактовать отсутствие поля как 'unknown'.
 */
export type MergeCheckState = 'unknown' | 'checking' | 'clean' | 'conflict' | 'merged' | 'nothing';

export interface TaskMergeability {
  state: MergeCheckState;
  /** Конфликтующие файлы — заполнено только при state === 'conflict'. */
  conflicts: string[];
  checkedAt: number;
}

/** Состояние одной задачи в очереди слияния, отражаемое событием 'merge.queue'. */
export type MergeQueueState = 'pending' | 'merging' | 'typecheck' | 'done' | 'failed' | 'skipped';

export interface MergeQueueItem {
  taskId: string;
  state: MergeQueueState;
  /** Итог git-слияния — как MergeOutcome.kind на сервере. */
  kind?: 'merged' | 'conflict' | 'nothing' | 'wrong-branch' | 'failed';
  conflicts?: string[];
  message?: string;
}

/**
 * Расход одной сессии, агента, задачи или всего офиса.
 * Ввод и кеш разнесены: кеш стоит в десять раз дешевле обычного ввода,
 * и без разделения непонятно, почему 200k токенов стоили копейки.
 */
export interface Usage {
  costUsd: number;
  /** Свежий ввод — то, что модель читает по полной цене. */
  tokensIn: number;
  tokensOut: number;
  /** Прочитано из кеша промпта. */
  cacheRead: number;
  /** Записано в кеш промпта. */
  cacheWrite: number;
}

export interface DayUsage {
  /** Дата в местном времени, 'ГГГГ-ММ-ДД'. */
  day: string;
  usage: Usage;
}

export const emptyUsage = (): Usage => ({
  costUsd: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
});

/** Пункт критерия готовности: исполнитель отмечает их по ходу работы. */
export interface Criterion {
  text: string;
  done: boolean;
}

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
  /** Свой репозиторий роли; пусто — общий репозиторий офиса. */
  repoDir: string;
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

/** Где выполняется задача: локальный Claude Code или Managed Agents в облаке. */
export type Engine = 'local' | 'cloud';

export interface Settings {
  /** Общий потолок расходов офиса, $. null — без ограничения. */
  globalBudgetUsd: number | null;
  /** Потолок на одну задачу, $. null — без ограничения. */
  taskBudgetUsd: number | null;
  /** Движок исполнителей. Облачный работает только на платном API. */
  engine: Engine;
  /** Репозиторий на GitHub, который монтируется в облачный контейнер. */
  cloudRepoUrl: string | null;
}

/** Что из облачной обвязки уже готово — ключ и токен в состояние не пишутся. */
export interface CloudStatus {
  /** Задан ANTHROPIC_API_KEY: без него Managed Agents недоступны. */
  hasKey: boolean;
  /** Известен токен GitHub с доступом к репозиторию. */
  hasToken: boolean;
}

/** Офис = проект: своя директория, доска, расходы и файл состояния. */
export interface OfficeView {
  id: string;
  name: string;
  projectDir: string;
  current: boolean;
  lastOpenedAt: number;
}

export interface InstanceView {
  id: string;         // 'backend#1'
  roleId: string;
  label: string;      // 'Backend #1'
  desk: Desk;
  state: AgentState;
  currentTaskId: string | null;
  note: string | null; // текущая реплика/действие
  /** Расход за всё время жизни агента. */
  usage: Usage;
  /** Он же за сегодня — «сколько этот агент стоил сегодня». */
  today: Usage;
}

export interface TaskView {
  id: string;
  title: string;
  description: string;
  criteria: Criterion[];
  roleId: string | null;
  assigneeId: string | null;
  status: TaskStatus;
  result: string | null;
  files: string[];
  /** Изоляция: своя ветка и свой worktree на задачу. */
  branch: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  /** В каком репозитории выполнялась задача: у ролей он может отличаться. */
  repoDir: string | null;
  merged: boolean;
  /** Итог предварительной проверки слияния; null/отсутствует — ещё не проверяли. */
  mergeability?: TaskMergeability | null;
  createdAt: number;
  /** Когда исполнитель реально взялся за задачу и когда закончил. */
  startedAt: number | null;
  finishedAt: number | null;
  /** Расход именно на эту задачу, а не на агента вообще. */
  usage: Usage;
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

export type PermissionDecision = 'allow' | 'deny' | 'always' | 'never';

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
      meeting: MeetingView | null; busy: boolean; paused: boolean;
      usage: { total: Usage; days: DayUsage[] };
      offices: OfficeView[]; cloud: CloudStatus }
  | { t: 'instance'; instance: InstanceView }
  | { t: 'instance.remove'; id: string }
  | { t: 'task'; task: TaskView }
  | { t: 'chat'; entry: ChatEntry }
  | { t: 'log'; entry: LogEntry }
  | { t: 'handoff'; from: string; to: string; text: string }
  | { t: 'busy'; busy: boolean }
  | { t: 'paused'; paused: boolean }
  | { t: 'offices'; offices: OfficeView[] }
  | { t: 'cloud'; cloud: CloudStatus }
  | { t: 'usage'; total: Usage; days: DayUsage[] }
  | { t: 'roles'; roles: RoleView[] }
  | { t: 'settings'; settings: Settings }
  | { t: 'permission.request'; request: PermissionRequest }
  | { t: 'permission.resolved'; id: string; decision: PermissionDecision }
  | { t: 'meeting'; meeting: MeetingView | null }
  | { t: 'task.diff'; taskId: string; stat: string; patch: string; truncated: boolean; error?: string }
  /** Полное состояние очереди слияния — не инкремент, чтобы клиенту не пришлось её собирать. */
  | { t: 'merge.queue'; items: MergeQueueItem[]; running: boolean }
  /** Результат npm run typecheck после слияния одной задачи из очереди. */
  | { t: 'merge.typecheck'; taskId: string; ok: boolean; output: string };

/** Всё, что UI шлёт на сервер. */
export type ClientCommand =
  | { c: 'user_message'; text: string }
  | { c: 'permission'; id: string; decision: PermissionDecision }
  | { c: 'merge_task'; taskId: string }
  /** Предпроверка мержабельности без изменения рабочего дерева. */
  | { c: 'check_merge'; taskIds: string[] }
  /** Слить задачи по очереди в заданном порядке; остановится на первом конфликте/ошибке. */
  | { c: 'merge_queue'; taskIds: string[] }
  | { c: 'merge_queue_stop' }
  /** Нанять сотрудника роли: и первого в пустую роль, и очередного клона. */
  | { c: 'spawn'; roleId: string }
  /** То же самое под говорящим именем — сервер принимает оба варианта. */
  | { c: 'hire'; roleId: string }
  /** Уволить сотрудника. Последнего в роли — можно: роль остаётся вакансией. */
  | { c: 'fire'; instanceId: string }
  | { c: 'update_role'; roleId: string; patch: Partial<RoleEditable> }
  | { c: 'settings'; settings: Partial<Settings> }
  | { c: 'talk'; instanceId: string; text: string }
  | { c: 'stop_task'; taskId: string }
  | { c: 'retry_task'; taskId: string }
  | { c: 'meeting'; topic: string; participants: string[] }
  | { c: 'assign_direct'; taskId: string; instanceId: string }
  | { c: 'task_diff'; taskId: string }
  | { c: 'pause'; paused: boolean }
  | { c: 'switch_office'; officeId: string }
  | { c: 'create_office'; name: string; projectDir: string }
  | { c: 'rename_office'; officeId: string; name: string }
  | { c: 'cloud_token'; token: string }
  | { c: 'reset' };

// Размеры заданы артом: тайл 16 арт-пикселей × SCALE 3 = 48 экранных,
// комната floor.png ровно 1152×720 = 24×15 тайлов.
export const GRID = { cols: 24, cells: 15, cell: 48 };

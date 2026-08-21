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

/**
 * Насколько свободно агент действует без человека.
 *
 * auto        — ничего не спрашивать (полный доступ)
 * ask-risky   — спрашивать только необратимое
 * ask-writes  — спрашивать про любую запись и любую команду оболочки
 * readonly    — запрещать всё, что меняет состояние
 */
export type PermissionMode = 'auto' | 'ask-risky' | 'ask-writes' | 'readonly';

/** Поля роли, которые пользователь может менять из UI. */
export interface RoleEditable {
  title: string;
  emoji: string;
  color: string;
  model: string;
  /** null — наследовать режим офиса (Settings.officePermissionMode). */
  permissionMode: PermissionMode | null;
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
  /**
   * По какому режиму роль работает на самом деле: свой, если задан, иначе
   * унаследованный офисный. Считает сервер — чтобы UI показывал то же, что
   * применяет обработчик разрешений, а не повторял правило наследования.
   */
  effectivePermissionMode: PermissionMode;
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
  /**
   * Потолок ходов сессии исполнителя. Ход — шаг агента (чтение файла, правка,
   * команда оболочки), а не реплика в разговоре. null — без ограничения; тогда
   * зациклившегося исполнителя остановят только бюджет и вы.
   * Живёт только у локального движка: у облачных сессий такого параметра нет.
   *
   * Поле необязательное, потому что сохранения офисов старше этой настройки
   * его не содержат. На проводе undefined не бывает: сервер добивает настройки
   * умолчаниями и при загрузке состояния, и при каждой правке.
   */
  taskMaxTurns?: number | null;
  /** Движок исполнителей. Облачный работает только на платном API. */
  engine: Engine;
  /** Репозиторий на GitHub, который монтируется в облачный контейнер. */
  cloudRepoUrl: string | null;
  /** Режим доступа офиса: его наследуют роли без собственного режима. */
  officePermissionMode: PermissionMode;
}

/**
 * Границы лимита ходов. Снизу 1: ноль и отрицательное — это не «без
 * ограничения», а сессия, падающая на первом же шаге. Сверху 1000 — защита от
 * описки в поле ввода: столько ходов ни одна задача не проходит, и цифра вроде
 * 60000 означала бы опечатку, а не намерение. Кому лимит правда не нужен —
 * оставляет поле пустым и получает null.
 */
export const MIN_TASK_MAX_TURNS = 1;
export const MAX_TASK_MAX_TURNS = 1000;

/** Что из облачной обвязки уже готово — ключ и токен в состояние не пишутся. */
export interface CloudStatus {
  /** Задан ANTHROPIC_API_KEY: без него Managed Agents недоступны. */
  hasKey: boolean;
  /** Известен токен GitHub с доступом к репозиторию. */
  hasToken: boolean;
}

/**
 * Сводка активности офиса для списка: она считается и по неоткрытым офисам,
 * поэтому берётся из их файла состояния, а не из живой доски.
 */
export interface OfficeActivity {
  /** Задачи, которые кто-то уже взял и ещё не закрыл. */
  inProgress: number;
  /** Сделаны, но ветка не слита — работа висит и ждёт человека. */
  doneUnmerged: number;
  /** Когда в офисе последний раз что-то происходило. null — ничего не было. */
  lastEventAt: number | null;
}

/** Что клиент просил сделать с офисом — на случай отказа сервера. */
export type OfficeOp = 'create' | 'switch' | 'rename' | 'remove';

/** Офис = проект: своя директория, доска, расходы и файл состояния. */
export interface OfficeView {
  id: string;
  name: string;
  projectDir: string;
  current: boolean;
  lastOpenedAt: number;
  /** Нет поля — сводку посчитать не удалось; ноль и «нет данных» разные вещи. */
  activity?: OfficeActivity;
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
  /**
   * Свой режим доступа этого сотрудника. null — своего нет, работает по
   * режиму роли, а та — по режиму офиса.
   */
  permissionMode: PermissionMode | null;
  /** По какому режиму агент работает на самом деле: агент → роль → офис. */
  effectivePermissionMode: PermissionMode;
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
  createdAt: number;
  /** Когда исполнитель реально взялся за задачу и когда закончил. */
  startedAt: number | null;
  finishedAt: number | null;
  /** Расход именно на эту задачу, а не на агента вообще. */
  usage: Usage;
}

/**
 * Сухая проверка ветки задачи против базовой: сольётся ли и с чем конфликтует.
 * 'nothing' — в ветке нет коммитов сверх базовой, 'unknown' — проверить
 * не удалось (нет ветки, нет репозитория).
 */
export type MergeCheckState = 'clean' | 'conflict' | 'nothing' | 'unknown';

export interface MergeCheck {
  taskId: string;
  state: MergeCheckState;
  /** Файлы, из-за которых слияние встанет. */
  conflicts: string[];
  /** Готовая фраза для интерфейса. */
  message: string;
  /** Когда считали: порядок слияний меняет результат, и статус быстро стареет. */
  checkedAt: number;
}

/** Прогон проверки сборки (npm run typecheck) после слияния. */
export interface TypecheckResult {
  ok: boolean;
  /** Хвост вывода: гнать в браузер весь лог tsc незачем. */
  output: string;
  /** Проверку не запускали (нет скрипта или npm недоступен) — это не провал. */
  skipped: boolean;
  message: string;
  durationMs: number;
}

/**
 * Что случилось с одной задачей в очереди слияния.
 * 'pending' — до неё не дошли, потому что очередь встала раньше.
 */
export type MergeStepStatus =
  | 'merged' | 'nothing' | 'conflict' | 'typecheck-failed' | 'failed' | 'skipped' | 'pending';

export interface MergeStep {
  taskId: string;
  title: string;
  status: MergeStepStatus;
  message: string;
  conflicts: string[];
  typecheck: TypecheckResult | null;
}

/** Один запуск очереди слияния: идёт по списку и встаёт на первой беде. */
export interface MergeRun {
  id: string;
  running: boolean;
  steps: MergeStep[];
  /** Итог по-русски: что слито и на чём встали. */
  summary: string;
  startedAt: number;
  finishedAt: number | null;
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
  /** Действие прошло без вопроса благодаря режиму доступа — не запрос, а факт постфактум. */
  autoApproved?: boolean;
}

/** Всё, что сервер шлёт в UI. Единственный интерфейс между логикой и картинкой. */
export type ServerEvent =
  | { t: 'snapshot'; roles: RoleView[]; instances: InstanceView[]; tasks: TaskView[];
      chat: ChatEntry[]; log: LogEntry[]; permissions: PermissionRequest[];
      settings: Settings; projectDir: string; authSource: AuthSource;
      meeting: MeetingView | null; busy: boolean; paused: boolean;
      usage: { total: Usage; days: DayUsage[] };
      offices: OfficeView[]; cloud: CloudStatus;
      /** Статусы слияния по завершённым задачам и последний прогон очереди. */
      mergeChecks: MergeCheck[]; mergeRun: MergeRun | null }
  | { t: 'instance'; instance: InstanceView }
  | { t: 'instance.remove'; id: string }
  | { t: 'task'; task: TaskView }
  | { t: 'chat'; entry: ChatEntry }
  | { t: 'log'; entry: LogEntry }
  | { t: 'handoff'; from: string; to: string; text: string }
  | { t: 'busy'; busy: boolean }
  | { t: 'paused'; paused: boolean }
  | { t: 'offices'; offices: OfficeView[] }
  /**
   * Отказ по операции с офисом. Уходит только тому клиенту, который её
   * просил: меню показывает текст в форме, а не ищет его в чате чужого
   * проекта. Текст готов к показу как есть, переформулировать не нужно.
   */
  | { t: 'office.error'; op: OfficeOp; officeId: string | null; message: string }
  | { t: 'cloud'; cloud: CloudStatus }
  | { t: 'usage'; total: Usage; days: DayUsage[] }
  | { t: 'roles'; roles: RoleView[] }
  | { t: 'settings'; settings: Settings }
  | { t: 'permission.request'; request: PermissionRequest }
  | { t: 'permission.resolved'; id: string; decision: PermissionDecision }
  | { t: 'meeting'; meeting: MeetingView | null }
  | { t: 'task.diff'; taskId: string; stat: string; patch: string; truncated: boolean; error?: string }
  /** Пересчитанные статусы мержабельности: приходят целым списком. */
  | { t: 'merge.checks'; checks: MergeCheck[]; checking: boolean }
  /** Ход и итог очереди слияния. */
  | { t: 'merge.run'; run: MergeRun };

/** Всё, что UI шлёт на сервер. */
export type ClientCommand =
  | { c: 'user_message'; text: string }
  | { c: 'permission'; id: string; decision: PermissionDecision }
  | { c: 'merge_task'; taskId: string }
  /** Пересчитать статусы мержабельности завершённых задач. */
  | { c: 'merge_check' }
  /** Слить выбранные задачи по порядку списка, останавливаясь на первой беде. */
  | { c: 'merge_queue'; taskIds: string[] }
  /** Нанять сотрудника роли: и первого в пустую роль, и очередного клона. */
  | { c: 'spawn'; roleId: string }
  /** То же самое под говорящим именем — сервер принимает оба варианта. */
  | { c: 'hire'; roleId: string }
  /** Уволить сотрудника. Последнего в роли — можно: роль остаётся вакансией. */
  | { c: 'fire'; instanceId: string }
  | { c: 'update_role'; roleId: string; patch: Partial<RoleEditable> }
  /** Режим доступа конкретного сотрудника. null — вернуть его к режиму роли. */
  | { c: 'agent_permission'; instanceId: string; mode: PermissionMode | null }
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
  /** Запросить список офисов, не дожидаясь снапшота: меню открывается раньше офиса. */
  | { c: 'list_offices' }
  /** Убрать офис из списка. Файлы проекта и его сохранение остаются на диске. */
  | { c: 'remove_office'; officeId: string }
  | { c: 'cloud_token'; token: string }
  | { c: 'reset' };

// Размеры заданы артом: тайл 16 арт-пикселей × SCALE 3 = 48 экранных,
// комната floor.png ровно 1152×720 = 24×15 тайлов.
export const GRID = { cols: 24, cells: 15, cell: 48 };

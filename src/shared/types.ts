// Общие типы между сервером и вебом.

// Раскладка и её оверрайд описаны в src/shared/layout.ts — там же, где код,
// который их считает. Здесь они только перевыставлены: ими пользуются и
// снапшот, и команды клиента, а разбирать контракт по двум файлам неудобно.
export type { Layout, LayoutOverride, LayoutPropEdit } from './layout';
import type { Layout, LayoutOverride, LayoutPropEdit } from './layout';

// Язык офиса живёт в настройках, а его тип — рядом с движком словарей.
export type { Lang } from './i18n';
import type { Lang } from './i18n';

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
  /** Габарит стола в тайлах — с учётом `size`/`scale` предмета (§3.2). */
  w: number;
  h: number;
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
  /**
   * Свой потолок ходов сессии этой роли. null — брать лимит офиса
   * (Settings.taskMaxTurns). Ревьюеру хватает десятка ходов, а разработчику
   * на большой задаче не хватает и сотни — общий на офис лимит приходится
   * ставить по самому прожорливому.
   *
   * «Без ограничения» на уровне роли не бывает: снять лимит совсем можно
   * только офису целиком, иначе одно и то же null означало бы то «как в
   * офисе», то «сколько угодно».
   */
  maxTurns: number | null;
  /** Свой репозиторий роли; пусто — общий репозиторий офиса. */
  repoDir: string;
  /**
   * Пресет внешности из каталога спрайтов (`agent_p1`…`agent_p10`).
   * Пусто — веб подбирает спрайт по id роли, как делал до появления поля:
   * у базовых ролей своя внешность нарисована, и затирать её значением
   * по умолчанию нельзя.
   */
  sprite: string;
  brief: string;
}

export interface RoleView extends RoleEditable {
  id: string;
  isManager: boolean;
  /**
   * Роль убрана в архив: не показывается в найме и не предлагается менеджеру,
   * но по-прежнему находится по id в задачах, логах и сохранённых инстансах.
   * Удаление роли — это именно архивация: roleId лежит в истории задач, и
   * физическое исчезновение роли развалило бы её показ.
   */
  archived: boolean;
  /**
   * Роль можно стереть насовсем, а не только заархивировать: у неё никогда
   * не было ни задач, ни сотрудников, и в истории её id не встречается.
   * Считает сервер — правило одно, и UI не должен повторять его своими силами.
   */
  removable: boolean;
  /** Сколько инстансов сейчас в офисе. */
  active: number;
  /**
   * Сколько ходов роль получит на самом деле: свой лимит, если задан, иначе
   * офисный. null — без ограничения. Считает сервер, чтобы UI показывал ровно
   * то, что уедет в SDK.
   */
  effectiveMaxTurns: number | null;
  /**
   * По какому режиму роль работает на самом деле: свой, если задан, иначе
   * унаследованный офисный. Считает сервер — чтобы UI показывал то же, что
   * применяет обработчик разрешений, а не повторял правило наследования.
   */
  effectivePermissionMode: PermissionMode;
}

/**
 * Заготовка новой роли из формы. id здесь нет намеренно: его генерирует
 * сервер по названию — только он знает, какие id уже заняты в этом офисе и
 * какие заняты базовым набором. Обязательно одно название; остальное сервер
 * добивает разумными умолчаниями, чтобы форма могла быть короткой.
 */
export type RoleDraft = Partial<RoleEditable> & { title: string };

/**
 * Что офис делает с ролью. Приезжает обратно в отказе, чтобы форма понимала,
 * на какое своё действие получила ошибку: создание и правка открыты в разных
 * местах интерфейса, а ответ приходит одним каналом.
 */
export type RoleOp = 'create' | 'update' | 'archive' | 'restore' | 'remove';

/**
 * Ошибка по конкретному полю формы: текст ложится под это поле, а не в общий
 * тост — человек правит ровно то, что не так. Пустой `field` — ошибка про роль
 * целиком (например «PM архивировать нельзя»), её показывают шапкой формы.
 */
export interface FieldError {
  field: string;
  message: string;
}

/**
 * Границы лимита клонов роли. Снизу 1: роль, в которую нельзя нанять никого, —
 * это архивная роль, а не настройка. Сверху 10 — столько сотрудников офис не
 * усадит ни в одной раскладке, и большее число означает описку.
 */
export const MIN_ROLE_INSTANCES = 1;
export const MAX_ROLE_INSTANCES = 10;

/** Потолок длины названия роли: оно печатается на бейдже и в списках. */
export const ROLE_TITLE_LIMIT = 60;

/** Откуда SDK берёт доступ: подписка Claude Code или платный ключ API. */
export type AuthSource = 'subscription' | 'api-key' | 'unknown';

/** Где выполняется задача: локальный Claude Code или Managed Agents в облаке. */
export type Engine = 'local' | 'cloud';

export interface Settings {
  /**
   * Язык офиса: на нём говорит интерфейс, на нём офис пишет в лог и на нём же
   * работают агенты. Настройка одна на всё, потому что разные языки у
   * интерфейса и у менеджера дали бы полутатарский офис: подпись кнопки на
   * одном языке, ответ под ней — на другом.
   *
   * Поле необязательное: сохранения офисов старше настройки его не содержат.
   * На проводе undefined не бывает — сервер добивает настройки умолчаниями и
   * при загрузке состояния, и при каждой правке.
   */
  language?: Lang;
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
  /**
   * Сколько исполнителей этого офиса работают одновременно. Ограничение
   * денежное, а не техническое: каждая живая сессия тратит токены, и без
   * потолка офис разгоняется настолько, насколько менеджер успел раздать
   * задачи. «Без ограничения» здесь не бывает — есть только число.
   *
   * Лимит пер-офисный, а сверх него действует общий потолок процесса
   * (см. DEFAULT_PROCESS_WORKERS): три офиса по три исполнителя — это
   * девять оплачиваемых сессий, чего пользователь не заказывал.
   *
   * Поле необязательное: сохранения офисов старше этой настройки его не
   * содержат. На проводе undefined не бывает — сервер добивает настройки
   * умолчаниями и при загрузке состояния, и при каждой правке.
   */
  maxConcurrentWorkers?: number;
  /** Движок исполнителей. Облачный работает только на платном API. */
  engine: Engine;
  /** Репозиторий на GitHub, который монтируется в облачный контейнер. */
  cloudRepoUrl: string | null;
  /** Режим доступа офиса: его наследуют роли без собственного режима. */
  officePermissionMode: PermissionMode;
  /**
   * Расстановка мебели: id пресета `design/layouts/<id>.json`. В старых
   * сохранениях поля нет — там подставляется `classic`, и заведённые раньше
   * офисы выглядят ровно так же, как выглядели.
   */
  layoutId: string;
  /**
   * Конвейер ревью: сданная задача сама подтягивает базу, открывает
   * пулл-реквест, проходит ревью и вливается. false — старый порядок,
   * когда ветку сливает человек из очереди слияния.
   */
  autoPipeline: boolean;
}

/**
 * Пресет раскладки для выбора в интерфейсе. Сама раскладка клиенту отсюда не
 * едет: веб читает design/layouts через import.meta.glob, а списку нужны только
 * id и подпись, чтобы было из чего выбирать.
 */
export interface LayoutOption {
  id: string;
  /** Человекочитаемое название — поле `title` раскладки. */
  title: string;
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

/**
 * Границы лимита одновременных исполнителей офиса. Снизу 1: ноль означал бы
 * офис, в котором задачи не стартуют никогда, а это не настройка, а поломка.
 * Сверху 10 — потолок, за которым цифра перестаёт быть осмысленной: каждая
 * сессия это отдельный процесс Claude Code со своей рабочей копией, и десяток
 * их на одной машине уже упирается в память и в лимиты API, а не в настройку.
 * Умолчание 3 — ровно то, что стояло константой MAX_CONCURRENT_WORKERS:
 * появление настройки не должно менять поведение офисов, где её не трогали.
 */
export const MIN_OFFICE_WORKERS = 1;
export const MAX_OFFICE_WORKERS = 10;
export const DEFAULT_OFFICE_WORKERS = 3;

/**
 * Общий потолок одновременных сессий исполнителей на весь процесс — сумма по
 * всем поднятым офисам. 6 = два офиса на умолчании: один офис работает ровно
 * как раньше, а расход при десятке открытых проектов остаётся предсказуемым.
 * Переопределяется переменной окружения OFFICE_MAX_WORKERS.
 */
export const DEFAULT_PROCESS_WORKERS = 6;

/** Что из облачной обвязки уже готово — ключ и токен в состояние не пишутся. */
export interface CloudStatus {
  /** Задан ANTHROPIC_API_KEY: без него Managed Agents недоступны. */
  hasKey: boolean;
  /** Известен токен GitHub с доступом к репозиторию. */
  hasToken: boolean;
}

/**
 * Сводка активности офиса для списка. По поднятым в память офисам считается
 * по живой доске, по остальным — по их файлу состояния: в списке видно все,
 * а открыт клиентом может быть только один.
 */
export interface OfficeActivity {
  /** Задачи, которые кто-то уже взял и ещё не закрыл. */
  inProgress: number;
  /** Сделаны, но ветка не слита — работа висит и ждёт человека. */
  doneUnmerged: number;
  /** Когда в офисе последний раз что-то происходило. null — ничего не было. */
  lastEventAt: number | null;
  /**
   * В офисе прямо сейчас работают сессии: исполнители, менеджер или разговор.
   * Именно этим «идёт работа» отличается от «на доске висит незакрытая
   * задача»: покинутый офис продолжает работать, и в списке это видно.
   */
  live: boolean;
  /**
   * Сколько запросов доступа ждут решения человека. Работа в этом офисе
   * стоит, пока он не вернётся: агент замер на вызове инструмента, а спросить
   * его больше некого. По неоткрытым офисам всегда ноль — запрос живёт
   * в памяти сессии и на диск не попадает.
   */
  waiting: number;
}

/**
 * Что клиент просил сделать с офисом — на случай отказа сервера.
 * `open` — команда пришла в офис, который ещё открывается: сделать её пока
 * не над чем, и клиенту об этом говорят, а не молчат.
 */
export type OfficeOp = 'create' | 'switch' | 'rename' | 'remove' | 'open';

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
  /**
   * Столов в раскладке меньше, чем сотрудников, и этому места не хватило.
   * `desk.index` при этом — не стол текущей раскладки, а запомненный номер
   * (вернётся раскладка попросторнее — сотрудник снова сядет за него), а
   * `desk.x/y` — клетка, на которой он просто стоит. Рисовать его за столом
   * по этому индексу нельзя: стола с таким номером сейчас нет.
   */
  deskless: boolean;
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
  /** Работу оборвал перезапуск сервера — офис возобновит её сам. */
  interrupted: boolean;
  createdAt: number;
  /** Когда исполнитель реально взялся за задачу и когда закончил. */
  startedAt: number | null;
  finishedAt: number | null;
  /** Расход именно на эту задачу, а не на агента вообще. */
  usage: Usage;
}

/**
 * Стадия конвейера ревью: что офис делает с работой по задаче прямо сейчас.
 * 'stuck' — конвейер встал и ждёт решения человека или менеджера; это
 * единственная стадия, на которой работа не двигается сама.
 */
export type PrStage =
  | 'sync'      // подтягиваем базовую ветку в ветку задачи
  | 'checks'    // прогоняем проверки проекта в ветке задачи
  | 'opening'   // открываем пулл-реквест
  | 'review'    // ревьюер смотрит
  | 'rework'    // автор правит по отзыву
  | 'merging'   // вливаем в базовую ветку
  | 'merged'    // влито, ветка и рабочая копия убраны
  | 'stuck';    // встали: нужен человек

export type ReviewVerdict = 'approve' | 'changes';

/** Один отзыв ревьюера по пулл-реквесту. */
export interface ReviewNote {
  at: number;
  verdict: ReviewVerdict;
  reviewerId: string | null;
  text: string;
}

/**
 * Пулл-реквест задачи. Живёт и без GitHub: если у офиса нет удалёнки с
 * токеном, это внутренняя сущность офиса, а слияние идёт локальным git merge.
 * С GitHub у него появляются number и url — тот же конвейер, но видимый
 * снаружи.
 */
export interface PullRequestView {
  id: string;
  taskId: string;
  title: string;
  branch: string;
  base: string;
  /** В каком репозитории всё происходит: у ролей они могут отличаться. */
  repoDir: string;
  /** Номер и ссылка на GitHub. null — пулл-реквест только внутри офиса. */
  number: number | null;
  url: string | null;
  stage: PrStage;
  /** Готовая фраза для интерфейса: что происходит или почему встали. */
  note: string;
  /** Сколько раз работу возвращали автору. */
  rounds: number;
  /** Сколько раз офис сам перезапускал вставший конвейер. */
  retries: number;
  /** Когда офис попробует снова. null — пробовать больше не будет. */
  nextTryAt: number | null;
  /**
   * Механически конвейер дальше не поедет: нужно решение менеджера (ревьюер
   * трижды завернул, некому ревьюить, кончился бюджет). Такие пулл-реквесты
   * офис не дёргает по кругу — он один раз зовёт PM и ждёт.
   */
  needsDecision: boolean;
  reviewerId: string | null;
  reviews: ReviewNote[];
  createdAt: number;
  updatedAt: number;
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

/**
 * Подпись офиса под системной репликой в чате. Это метка отправителя, а не
 * текст для человека: по ней веб отличает голос офиса от голоса менеджера,
 * и переводу она не подлежит — переведённая, она перестала бы совпадать.
 * Показывается она под своим переведённым именем (`chat.office` в словаре).
 */
export const OFFICE_SENDER = 'office';

/**
 * Как офис подписывался, пока был только русским. Значение лежит в чатах
 * заведённых тогда офисов, и знать про него надо ровно затем, чтобы старая
 * переписка не перестала читаться после обновления.
 */
export const LEGACY_OFFICE_SENDER = 'офис';

/** Реплика написана офисом, а не человеком и не агентом. */
export const isOfficeSender = (from: string): boolean =>
  from === OFFICE_SENDER || from === LEGACY_OFFICE_SENDER;

export interface ChatEntry {
  id: string;
  /** Ветка разговора: 'pm#1' — чат с менеджером, иначе id агента. */
  thread: string;
  /** 'user' | id сотрудника | OFFICE_SENDER */
  from: string;
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
      /**
       * Из чего можно выбирать раскладку. Список читается с диска на каждый
       * снапшот, так что новый файл в design/layouts появляется в нём без
       * перезапуска. Какая раскладка выбрана — в `settings.layoutId`.
       */
      layouts: LayoutOption[];
      /**
       * Итоговая расстановка офиса: пресет с уже наложенным оверрайдом (§8).
       * Веб рисует комнату по ней, а не по файлу пресета, — иначе сдвинутая
       * мебель была бы видна только серверу.
       */
      layout: Layout;
      /** Чем расстановка офиса отличается от пресета. null — ничем. */
      layoutOverride: LayoutOverride | null;
      /** Статусы слияния по завершённым задачам и последний прогон очереди. */
      mergeChecks: MergeCheck[]; mergeRun: MergeRun | null;
      /** Пулл-реквесты конвейера ревью — по одному на сданную задачу. */
      prs: PullRequestView[] }
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
  /**
   * Отказ по операции с ролью — тому клиенту, который её просил. Ошибки
   * разложены по полям формы: человек видит «такого репозитория нет» под
   * полем репозитория, а не общим тостом, из которого непонятно, что править.
   */
  | { t: 'role.error'; op: RoleOp; roleId: string | null; errors: FieldError[] }
  /**
   * Операция с ролью удалась. Список ролей приезжает отдельным событием всем,
   * кто смотрит офис, а это — ответ просившему: по нему форма закрывается и
   * узнаёт id, который сервер сгенерировал для новой роли.
   */
  | { t: 'role.saved'; op: RoleOp; roleId: string }
  | { t: 'settings'; settings: Settings }
  /**
   * Расстановка офиса изменилась: подвинули предмет, сбросили оверрайд или
   * сменили пресет. Едет целиком — клиенту нечего доклеивать самому.
   */
  | { t: 'layout'; layout: Layout; override: LayoutOverride | null }
  | { t: 'permission.request'; request: PermissionRequest }
  | { t: 'permission.resolved'; id: string; decision: PermissionDecision }
  | { t: 'meeting'; meeting: MeetingView | null }
  | { t: 'task.diff'; taskId: string; stat: string; patch: string; truncated: boolean; error?: string }
  /** Пересчитанные статусы мержабельности: приходят целым списком. */
  | { t: 'merge.checks'; checks: MergeCheck[]; checking: boolean }
  /** Ход и итог очереди слияния. */
  | { t: 'merge.run'; run: MergeRun }
  /** Пулл-реквест завели или он сдвинулся по конвейеру. */
  | { t: 'pr'; pr: PullRequestView };

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
  /** Завести роль. id генерирует сервер по названию — в команде его нет. */
  | { c: 'create_role'; role: RoleDraft }
  /**
   * Убрать роль в архив или вернуть из него. Архивная роль пропадает из найма
   * и из перечня для менеджера, но продолжает находиться по id в истории.
   */
  | { c: 'archive_role'; roleId: string; archived: boolean }
  /**
   * Стереть роль насовсем. Разрешено только для роли без следа в истории:
   * у неё никогда не было ни задач, ни сотрудников. Всё остальное — архив.
   */
  | { c: 'remove_role'; roleId: string }
  /** Режим доступа конкретного сотрудника. null — вернуть его к режиму роли. */
  | { c: 'agent_permission'; instanceId: string; mode: PermissionMode | null }
  | { c: 'settings'; settings: Partial<Settings> }
  /**
   * Сохранить расстановку: правки поверх выбранного пресета, по одной на
   * предмет. Присланное накладывается на то, что уже сохранено, — редактор
   * может слать один сдвинутый стол, а может всю расстановку разом.
   */
  | { c: 'layout_edit'; edits: LayoutPropEdit[] }
  /**
   * Вернуть расстановку к пресету. С `key` — только этот предмет,
   * без него — весь оверрайд текущей раскладки.
   */
  | { c: 'layout_reset'; key?: string }
  | { c: 'talk'; instanceId: string; text: string }
  | { c: 'stop_task'; taskId: string }
  | { c: 'retry_task'; taskId: string }
  | { c: 'meeting'; topic: string; participants: string[] }
  | { c: 'assign_direct'; taskId: string; instanceId: string }
  | { c: 'task_diff'; taskId: string }
  /** Толкнуть застрявший конвейер задачи заново — с той стадии, где он встал. */
  | { c: 'pr_retry'; taskId: string }
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

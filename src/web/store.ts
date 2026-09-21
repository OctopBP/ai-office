import { create } from 'zustand';
import type {
  ChatDraft,
  ChatEntry, DayUsage, FieldError, InstanceView, Layout, LayoutOption, LayoutOverride, LogEntry,
  McpServerState, MergeCheck, MergeCheckState, MergeRun, MergeStep, MergeStepStatus,
  PermissionDecision,
  MarketView, PermissionMode, PermissionRequest, MeetingView, RoleDraft, RoleEditable, RoleOp, RoleView,
  ServerEvent, Settings, TaskEdit, TaskPriority, TaskView, Usage, CloudStatus, OfficeView, OfficeIcon,
  PullRequestView, PrStage,
  EpicView, LimitsView, FactView, OwnerQuestion, LifeView, RitualId, DirectionView, ProposalView,
  OfficeSetupPlan, SetupCatalog, SetupStep, OfficeHealth, EnvReport, RuleScopeView,
} from '../shared/types';
import {
  compareOffices, emptyLimits, emptyUsage, isOfficeSender,
  MAX_OFFICE_WORKERS, MAX_TASK_MAX_TURNS, MIN_OFFICE_WORKERS, MIN_TASK_MAX_TURNS,
} from '../shared/types';
import { asLang, type Lang } from '../shared/i18n';
import type { Run, WorkflowEntry } from '../shared/workflow';
import { lang as currentLang, locale, setLang, t as tr } from './i18n';
import type { Theme } from './sprites';
import { type Graphics, loadGraphics, saveGraphics } from './office3d/graphics';
import { fitNow } from './office3d/fit';
import { catalog, DEFAULT_LAYOUT_ID, layoutFor, passabilityFor } from './layoutData';
import { interestsFor, rotateInterests, type Interest } from './interests';
import { isBusy } from './agentState';
import { go, readRoute, type HomeTab } from './router';
import { adjacentFree, deskPoint, findPath, meetingSeat } from '../shared/layout';

interface Pos { x: number; y: number }

/**
 * Куда агент идёт и каким путём.
 *
 * Стор отдаёт рендеру не «следующую точку через столько-то миллисекунд», а
 * **весь маршрут сразу**: ломаную по карте проходимости и скорость в тайлах
 * в секунду. Вести по ней фигуру — дело рендера, у которого есть кадры.
 *
 * Так было не всегда: раньше стор сам шагал по ломаной цепочкой setTimeout,
 * выкладывая по точке за раз. В фоновой вкладке браузер режет setTimeout до
 * одного срабатывания в секунду, а rAF останавливает вовсе, — и, вернувшись
 * на вкладку, человек видел не идущих агентов, а уже стоящих по местам: стор
 * успел доскакать до конца маршрута, пока рендер не рисовал ни кадра. Это и
 * был тот самый «рывком телепортируется до рабочего места».
 */
interface WalkPos extends Pos {
  /**
   * Ломаная от точки выхода до цели, включая оба конца. Одна точка — стоять
   * на месте (первое появление, снапшот, некуда идти).
   */
  path: Pos[];
  /** Постоянная скорость на весь маршрут, тайлов в секунду. */
  speed: number;
  /**
   * Номер маршрута. Рендер начинает вести фигуру заново, когда номер
   * сменился, — так новый маршрут отменяет недойденный прежний (агент шёл на
   * кухню, а его позвали на совещание).
   */
  seq: number;
  /** Цель — собственный стол агента: от этого зависят поза и свет монитора. */
  atDesk: boolean;
  /** Маршрут пройден. Ставит рендер: только он знает, где фигура на самом деле. */
  arrived: boolean;
}

/** Цель ходьбы: точная точка места и то, стол ли это. */
interface WalkTarget { at: Pos; atDesk: boolean }

/**
 * «Дом» агента, когда он не на совещании и не в момент передачи задачи:
 * занятый сидит за своим столом, свободный — там, где ему нашлось занятие.
 * Кто занят, решает `isBusy` — у исполнителя это задача, у менеджера ход
 * разговора; отдельного флага занятости на клиенте не заводим.
 *
 * Менеджер тут ничем не выделен нарочно: раньше он сидел за компьютером
 * всегда, даже когда офису нечего было ему сказать, и выглядело это не как
 * «начальник на месте», а как забытая на сцене фигура.
 *
 * Возвращается **точка слота `work`**, а не якорь стола. Прежде стор вёл
 * агента в якорь — клетку внутри следа стола, — а рисовал его рендер у
 * рабочей точки на тайл севернее: маршрут заканчивался внутри стола, а
 * фигура в последний момент перескакивала наружу. Теперь у логики и у
 * картинки одна и та же точка.
 */
function homeTarget(
  inst: InstanceView, roles: RoleView[], layout: Layout, instances: Record<string, InstanceView>,
): WalkTarget {
  // Столов меньше, чем сотрудников: этому места не хватило, и `desk.index`
  // указывает не на стол текущей раскладки, а на запомненный номер. Спрашивать
  // по нему точку слота нельзя — `deskPoint` бросит исключение.
  if (inst.deskless) return { at: { x: inst.desk.x, y: inst.desk.y }, atDesk: false };
  const desk = (): WalkTarget => ({
    at: deskPoint(layout, catalog, inst.desk.index, 'work'), atDesk: true,
  });
  if (isBusy(inst, roles)) return desk();
  // Свободный идёт туда, где ему нашлось занятие: поговорить, поиграть,
  // посидеть. Если занятий в раскладке нет вовсе — остаётся за своим столом:
  // по смыслу хуже, но сцену пустой координатой не ломает.
  const spot = interestsFor(layout, catalog, instances, roles).get(inst.id)?.at;
  return spot ? { at: spot, atDesk: false } : desk();
}

/** Занятия свободных в текущем состоянии стора — как их сейчас видит сцена. */
function interestsOf(s: Pick<State, 'layout' | 'instances' | 'roles'>): Map<string, Interest> {
  return interestsFor(s.layout, catalog, s.instances, s.roles);
}

/**
 * Перемена у одного меняет занятия других: собеседник ушёл работать или
 * из офиса — разговор распался, и оставшемуся раздача находит новое место,
 * скажем диван у приставки. Позу рендер берёт из раздачи сразу, а маршрут —
 * из стора, и без этого шага агент играл бы, сидя посреди комнаты там, где
 * стоял разговор. Поэтому после перемены все, у кого место сменилось, идут
 * к новому. Раздача липкая, так что `before` — ровно то, что было на сцене.
 *
 * Виновника перемены не трогаем: его маршрут решается отдельно, с учётом
 * стола. Кто на совещании — досидит его и вернётся домой после.
 */
function reseat(before: Map<string, Interest>, except: string): void {
  const s = useStore.getState();
  const after = interestsOf(s);
  const seated = new Set(s.meeting?.status === 'running' ? s.meeting.participants : []);
  for (const [id, next] of after) {
    if (id === except || seated.has(id)) continue;
    const prev = before.get(id)?.at;
    if (prev && prev.x === next.at.x && prev.y === next.at.y) continue;
    walkTo(id, { at: next.at, atDesk: false });
  }
}

/**
 * Шаг сетки, к которой прилипает перетаскиваемый предмет — половина тайла.
 *
 * Был вчетверо мельче, и это оказалось хуже: мебель вставала «почти ровно»,
 * а ряд столов приходилось выравнивать на глаз. Полтайла — примерно 40 см:
 * достаточно крупно, чтобы соседние предметы сами вставали в линию, и
 * достаточно мелко, чтобы стол можно было подвинуть на полшага.
 *
 * Экспортируется, потому что трёхмерный редактор эту же сетку рисует на полу:
 * показывать одну сетку, а прилипать к другой — верный способ сбить с толку.
 */
export const DRAG_GRID = 0.5;
function snapToGrid(v: number): number {
  return Math.round(v / DRAG_GRID) * DRAG_GRID;
}

/**
 * Не даёт утащить мебель мышью за пределы комнаты. Сервер такую правку всё
 * равно отклонит («позиция вне комнаты», см. docs/design/office-layout/spec.md
 * §8), но клиентский зажим избавляет от бессмысленного круга на сервер и
 * обратно ради заведомо неверной координаты.
 */
function clampToRoom(layout: Layout, x: number, y: number): Pos {
  const [cols, rows] = layout.size;
  return { x: Math.min(Math.max(x, 0), cols - DRAG_GRID), y: Math.min(Math.max(y, 0), rows - DRAG_GRID) };
}

export interface Toast {
  id: string;
  kind: 'done' | 'failed' | 'info';
  title: string;
  detail?: string;
  taskId?: string;
  /** Сколько висеть, мс. Без него — общий срок в 20 секунд. */
  ttl?: number;
}

interface State {
  connected: boolean;
  busy: boolean;
  /** Офис на паузе: новая работа не запускается, исполнители замирают. */
  paused: boolean;
  /** Стартовое меню выбора офиса или уже открытая комната. */
  screen: 'menu' | 'office';
  /**
   * Номер раздачи занятий: растёт при каждой ротации (`rotateRest`). Сама
   * раздача живёт в `interests.ts` и в сторе не хранится; номер нужен
   * рендеру, чтобы перечитать её, когда ни один агент не менялся.
   */
  restRev: number;
  /** Вкладка главного экрана — она же адрес (`router.ts`). */
  homeTab: HomeTab;
  setHomeTab: (tab: HomeTab) => void;
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
  /** Витрина мастера нового офиса. null — ещё не спрашивали. */
  setupCatalog: SetupCatalog | null;
  /** Ход сборки офиса мастером. null — сборка не идёт и не шла. */
  setupSteps: SetupStep[] | null;
  /** Метка поля, для которого открыт нативный диалог папки. null — диалога нет. */
  picking: string | null;
  /** Последний ответ диалога папки; `seq` растёт, чтобы одинаковые ответы не терялись. */
  picked: { seq: number; purpose: string; dir: string | null; error: string | null } | null;
  /** Офисы = проекты: список и текущий. */
  offices: OfficeView[];
  /** Готовность облачного режима: ключ API и токен GitHub. */
  cloud: CloudStatus;
  /** Расход офиса за всё время и по дням — для HUD и панели расходов. */
  usage: Usage;
  usageDays: DayUsage[];
  /**
   * Лимиты плана подписки: сколько окон съедено и когда они обнулятся.
   * Приезжают от SDK по ходу работы, поэтому до первой сессии их может не
   * быть вовсе — `available: false` это не «ноль», а «такого счётчика нет».
   */
  limits: LimitsView;
  projectDir: string;
  authSource: 'subscription' | 'api-key' | 'unknown';
  roles: RoleView[];
  instances: Record<string, InstanceView>;
  tasks: Record<string, TaskView>;
  /** План офиса: фичи по id. Порядок держит поле `order`, а не вставка. */
  epics: Record<string, EpicView>;
  chat: ChatEntry[];
  /**
   * Реплики, которые агенты пишут прямо сейчас, по ветке разговора. Живут
   * только пока идёт ход: конец хода их снимает, а готовая реплика приезжает
   * обычным событием `chat`. В ветке пишущий один, поэтому ключ — ветка.
   */
  drafts: Record<string, ChatDraft>;
  /**
   * Недописанное пользователем сообщение композера — по офису и ветке
   * (ключ считает `inputDraftKey`). Живёт здесь, а не в самом композере:
   * на виде «Доска» его не рендерят, и локальный useState терял бы набранный
   * текст при каждой смене вида. Читать — хуком `useInputDraft`.
   */
  inputDrafts: Record<string, string>;
  /** Записать черновик ввода в текущую ветку. Пустая строка — стереть. */
  setInputDraft: (text: string) => void;
  /**
   * Менеджер ответил, а чат в это время не смотрели: сегмент «Чат» зажигает
   * точку. Гаснет, как только чат открыли, — отдельного счётчика нет, важен
   * сам факт «там появилось новое».
   */
  chatUnread: boolean;
  log: LogEntry[];
  permissions: PermissionRequest[];
  settings: Settings;
  /**
   * Итог последней операции с ролью (создание/правка/архивация/удаление):
   * пустой `errors` — сделано, форма роли использует это как сигнал закрыть
   * себя или очистить поля; непустой — ошибки, разложенные по полям.
   */
  roleFeedback: { op: RoleOp; roleId: string | null; errors: FieldError[] } | null;
  /** Витрина маркета. null — окно ещё не открывали в этой сессии. */
  market: MarketView | null;
  /** Итог последнего экспорта роли в пакет — форма роли читает и сбрасывает. */
  exportResult: { roleId: string; dir: string; warnings: string[]; error: string | null } | null;
  /**
   * Запрос открыть окно «Команда» на конкретной роли — например, ссылкой
   * из карточки сотрудника. App открывает окно по нему, а само окно после
   * прочтения сбрасывает поле (тот же приём, что и у settingsSection).
   */
  teamRequest: { roleId: string } | null;
  /** Пресеты раскладки для выбора в настройках — приходят в снапшоте, читаются сервером с диска. */
  layouts: LayoutOption[];
  /**
   * Итоговая расстановка офиса: пресет с уже наложенным оверрайдом (§8).
   * Комната рисуется по ней, а не по файлу пресета, — приходит в снапшоте
   * и целиком обновляется событием `layout` после каждой правки.
   */
  layout: Layout;
  /** Чем расстановка отличается от пресета — для «Сбросить расстановку». null — ничем. */
  layoutOverride: LayoutOverride | null;
  /**
   * Идёт ли сейчас сохранение правки расстановки: пока true, ближайшая
   * реплика «офис» в чате — это отказ по ней (предмета нет, координата вне
   * комнаты), а не случайное системное сообщение. Тот же приём, что у
   * `settingsPending`.
   */
  layoutPending: boolean;
  /** Режим редактирования расстановки: включается кнопкой в HUD, вне него мебель мышью не хватается. */
  editingLayout: boolean;
  /**
   * Запрос открыть настройки на разделе «Проект» — например, ссылкой из
   * карточки безместного сотрудника. App открывает по нему модалку настроек,
   * а SettingsModal сразу после прочтения сбрасывает поле, чтобы обычное
   * открытие настроек по-прежнему помнило раздел, где пользователь был в
   * прошлый раз.
   */
  settingsSection: 'project' | null;
  /** Предмет, который сейчас тащат мышью, и его позиция в тайлах (уже с привязкой к сетке) — превью до отпускания кнопки. */
  dragItem: { key: string; x: number; y: number; rot: number } | null;
  /**
   * Идёт ли сейчас сохранение настроек: пока true, ближайшая реплика «офис»
   * в чате — это отказ по этому сохранению (например, раскладки уже нет на
   * диске), а не случайное системное сообщение. Показываем его тостом, а не
   * теряем в общей ленте, которую пользователь мог не открыть (§ SettingsModal).
   */
  settingsPending: boolean;
  meeting: MeetingView | null;
  /** История совещаний, старые первыми, — вместе с идущим сейчас. */
  meetings: MeetingView[];
  /** Порядок задач, которые пользователь набрал для следующего запуска очереди слияния. */
  mergeSelection: string[];
  /** Статусы мержабельности завершённых задач, по taskId — приходят от сервера целиком. */
  /**
   * Что известно о внешних MCP-серверах, по id сервера. Пусто — не «всё
   * плохо», а «ещё никто не работал»: статус приезжает от живых сессий.
   */
  mcpStatus: Record<string, McpServerState>;
  mergeChecks: Record<string, MergeCheck>;
  /** Идёт ли сейчас пересчёт статусов: пока он идёт, старые статусы ещё валидны. */
  mergeChecking: boolean;
  /** Последний (или ещё идущий) прогон очереди слияния. */
  mergeRun: MergeRun | null;
  /** Пулл-реквесты конвейера ревью, по taskId. */
  prs: Record<string, PullRequestView>;
  /** Прогоны процессов, по taskId (docs/design/workflows/spec.md §8). */
  runs: Record<string, Run>;
  /** Процессы офиса: встроенные и свои у проекта. */
  workflows: WorkflowEntry[];
  /** Живой офис: журнал, вопросы владельцу, ритуалы (docs/design/living-office). */
  facts: FactView[];
  questions: OwnerQuestion[];
  /** Сколько вопросов владельцу ждут решения — для бейджа на вкладке «Жизнь офиса». */
  openQuestions: number;
  life: LifeView;
  /** Сводка здоровья офиса: провалы без разбора, протухшие ветки, вставшие задачи. */
  health: OfficeHealth | null;
  /** Предполётные проверки окружения: чего офису не хватает, чтобы брать задачи. */
  env: EnvReport;
  /** Направления владельца и предложения офиса. */
  directions: DirectionView[];
  proposals: ProposalView[];
  /**
   * Правила офиса по кругам. Приезжают по запросу панели, а не в снимке:
   * они лежат файлами в репозиториях, и читать их на каждое подключение
   * незачем — панель правил открывают куда реже, чем офис.
   */
  rules: RuleScopeView[] | null;
  toggleMergeSelect: (taskId: string) => void;
  moveMergeSelect: (taskId: string, dir: -1 | 1) => void;
  clearMergeSelection: () => void;
  /**
   * Язык офиса, на котором нарисован интерфейс. В сторе он лежит не ради
   * подписей — их отдаёт `t()`, — а ради перерисовки: приложение
   * перемонтируется по нему целиком (`main.tsx`), иначе после смены языка
   * половина экрана осталась бы на прежнем.
   */
  lang: Lang;
  /**
   * Тема, которой сейчас нарисован офис, — всегда конкретная, day или night:
   * её читают сцена и палитра. Выбор пользователя лежит в `themeMode` и может
   * быть «как в системе» — тогда `theme` следует за системной и меняется
   * вместе с ней без перезагрузки.
   */
  theme: Theme;
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
  /**
   * Что стоит в главной области новой оболочки: сцена, доска или чат.
   * Сегменты сверху — это виды, а не оверлеи: рейл и композер остаются, а
   * в виде «Чат» композер и есть поле ввода треда.
   */
  view: View;
  setView: (v: View) => void;
  /** Рейл свёрнут до иконок. Переживает перезагрузку. */
  railCollapsed: boolean;
  setRailCollapsed: (v: boolean) => void;
  /** Настройки картинки трёхмерного офиса (пикселизация и её параметры).
   *  Хранятся у клиента: см. `office3d/graphics.ts`. */
  graphics: Graphics;
  setGraphics: (patch: Partial<Graphics>) => void;
  toasts: Toast[];
  /** Показанный сейчас дифф задачи. */
  diff: { taskId: string; stat: string; patch: string; truncated: boolean; error?: string } | null;
  /** Визуальные позиции — отдельно от логики: ходьба это чистая анимация. */
  pos: Record<string, WalkPos>;
  selected: string | null;
  /**
   * Раскрытая карточка задачи. Держится здесь, а не в доске: открыть задачу
   * можно и с доски, и из карточки сотрудника, а дровер у правого края один.
   */
  openTask: string | null;
  openTaskCard: (taskId: string | null) => void;
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
  /** Собрать офис по плану мастера: прогресс приходит событиями, итог — снапшот или ошибка. */
  requestSetupOffice: (plan: OfficeSetupPlan) => void;
  /** Спросить витрину мастера. Повторный вызов обновляет её. */
  loadSetupCatalog: () => void;
  /** Открыть нативный диалог папки на машине сервера; ответ придёт в `picked`. */
  pickFolder: (purpose: string, start?: string) => void;
  dismissMenuNotice: () => void;
}

export type View = 'office' | 'board' | 'chat';
export type ThemeMode = Theme | 'system';

/** Системная тема — через media query; слушаем её ниже, после создания стора. */
const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
const resolveTheme = (mode: ThemeMode): Theme => (mode === 'system' ? (darkMedia.matches ? 'night' : 'day') : mode);
function initialThemeMode(): ThemeMode {
  const v = localStorage.getItem('office-theme');
  return v === 'day' || v === 'night' || v === 'system' ? v : 'system';
}

const INPUT_DRAFTS_KEY = 'office-input-drafts';

/**
 * Ключ черновика ввода: офис и ветка. Офис в ключе обязателен — ветка 'pm#1'
 * есть в каждом офисе, и без него недописанное в одном офисе всплыло бы в
 * другом. Перевод строки как разделитель: в id офиса и ветки его не бывает.
 */
function inputDraftKey(s: Pick<State, 'offices' | 'thread'>): string {
  return `${s.offices.find((o) => o.current)?.id ?? ''}\n${s.thread}`;
}

function loadInputDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(INPUT_DRAFTS_KEY);
    if (!raw) return {};
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
      if (typeof v === 'string' && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveInputDrafts(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(INPUT_DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Приватный режим браузера — черновик просто не переживёт перезагрузку.
  }
}

/**
 * Черновик ввода текущей ветки текущего офиса. Хук, а не поле: ключ считается
 * из состояния, а компоненту нужна подписка ровно на свою строку.
 */
export function useInputDraft(): string {
  return useStore((s) => s.inputDrafts[inputDraftKey(s)] ?? '');
}

export const useStore = create<State>((set, get) => ({
  connected: false,
  busy: false,
  paused: false,
  screen: 'menu',
  restRev: 0,
  homeTab: (() => { const r = readRoute(); return r.kind === 'home' ? r.tab : 'offices'; })(),
  setHomeTab: (tab) => {
    go({ kind: 'home', tab });
    set({ homeTab: tab });
  },
  booted: false,
  connectFailed: false,
  pending: null,
  pendingLabel: null,
  menuNotice: null,
  setupCatalog: null,
  setupSteps: null,
  picking: null,
  picked: null,
  offices: [],
  cloud: { hasKey: false, hasToken: false },
  usage: emptyUsage(),
  usageDays: [],
  limits: emptyLimits(),
  projectDir: '',
  authSource: 'unknown',
  roles: [],
  instances: {},
  tasks: {},
  epics: {},
  chat: [],
  drafts: {},
  inputDrafts: loadInputDrafts(),
  chatUnread: false,
  log: [],
  permissions: [],
  roleFeedback: null,
  market: null,
  exportResult: null,
  teamRequest: null,
  settings: {
    globalBudgetUsd: null, taskBudgetUsd: null, engine: 'local', cloudRepoUrl: null,
    officePermissionMode: 'ask-risky', layoutId: DEFAULT_LAYOUT_ID, autoPipeline: true,
  },
  layouts: [],
  // До первого снапшота своей раскладки офиса ещё не знаем — берём ту же,
  // с которой заводится новый офис, что и запасное значение settings.layoutId выше.
  layout: layoutFor(DEFAULT_LAYOUT_ID),
  layoutOverride: null,
  layoutPending: false,
  editingLayout: false,
  settingsSection: null,
  dragItem: null,
  settingsPending: false,
  meeting: null,
  meetings: [],
  mergeSelection: [],
  mcpStatus: {},
  mergeChecks: {},
  mergeChecking: false,
  mergeRun: null,
  prs: {},
  runs: {},
  workflows: [],
  facts: [],
  questions: [],
  openQuestions: 0,
  directions: [],
  proposals: [],
  rules: null,
  life: {
    standupDay: null, standupAt: null, lastRun: {}, runs: [], running: null,
    flows: {},
    policy: { consolidateEveryMs: 0, questionsPerStandup: 0, standupPmLine: false, reflectionOn: false },
  },
  health: null,
  env: { checks: [], at: 0 },
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
  lang: currentLang(),
  theme: resolveTheme(initialThemeMode()),
  themeMode: initialThemeMode(),
  // В этой ветке офис по умолчанию трёхмерный — она ради него и заведена.
  // Явный выбор пользователя (клавиша 0) сильнее умолчания и переживает
  // перезагрузку; когда 3D догонит плоский рендер по функциям, ключ уйдёт
  // вместе с самим переключателем.
  graphics: loadGraphics(),
  toasts: [],
  diff: null,
  pos: {},
  selected: null,
  openTask: null,
  thread: 'pm#1',

  // Вернулись в ветку менеджера прямо в чате — значит новое уже видно.
  setThread: (t) => set((s) => (t === 'pm#1' && s.view === 'chat'
    ? { thread: t, chatUnread: false }
    : { thread: t })),
  // Пишем в localStorage на каждое нажатие: строка короткая, а всё, что сложнее
  // (таймер, сброс на unload), стоило бы дороже самой пользы.
  setInputDraft: (text) => set((s) => {
    const key = inputDraftKey(s);
    if ((s.inputDrafts[key] ?? '') === text) return {};
    const inputDrafts = { ...s.inputDrafts };
    if (text) inputDrafts[key] = text;
    else delete inputDrafts[key];
    saveInputDrafts(inputDrafts);
    return { inputDrafts };
  }),
  setThemeMode: (m) => { localStorage.setItem('office-theme', m); set({ themeMode: m, theme: resolveTheme(m) }); },
  view: 'office',
  // Открыли чат — точка непрочитанного своё отслужила.
  setView: (v) => set(v === 'chat' ? { view: v, chatUnread: false } : { view: v }),
  railCollapsed: localStorage.getItem('office-rail') === 'collapsed',
  setRailCollapsed: (v) => { localStorage.setItem('office-rail', v ? 'collapsed' : 'open'); set({ railCollapsed: v }); },
  setGraphics: (patch) => set((s) => {
    const graphics = { ...s.graphics, ...patch };
    saveGraphics(graphics);
    return { graphics };
  }),
  // Дровер в офисе один: открыли сотрудника — карточка задачи закрывается,
  // и наоборот. Иначе две панели легли бы одна поверх другой у правого края.
  select: (id) => set((s) => ({ selected: id, openTask: id ? null : s.openTask })),
  openTaskCard: (taskId) => set((s) => ({ openTask: taskId, selected: taskId ? null : s.selected })),
  // Связь оборвалась — конца хода мы уже не услышим, и «печатает…» осталось бы
  // висеть вечно. Черновики снимаем; после переподключения их вернёт снимок.
  setConnected: (v) => set(v ? { connected: v } : { connected: v, drafts: {} }),

  enterOffice: (officeId) => {
    const s = get();
    const office = s.offices.find((o) => o.id === officeId);
    if (!office) return;
    // Адрес меняется раньше состояния: подписчик адреса (`routeSync.ts`)
    // видит уже новый путь и не принимает вход за расхождение.
    go({ kind: 'office', officeId });
    if (office.current) { set({ screen: 'office' }); return; }
    // Переключение больше не требует остановки задач в работе — сервер сам
    // держит их сессии поверх смены офиса, поэтому клиент их не проверяет.
    // Сбрасываем UI прежнего офиса, чтобы выделение, чат-ветка и открытый
    // дифф не «протекали» в новый: панели закрывает App при входе в pending.
    set({
      pending: 'enter', pendingLabel: office.name, menuNotice: null,
      selected: null, openTask: null, thread: 'pm#1', diff: null, view: 'office',
    });
    switchOffice(officeId);
  },

  leaveOffice: () => {
    go({ kind: 'home', tab: get().homeTab });
    set({
      screen: 'menu',
      // UI-состояние привязано к конкретному офису: не должно протекать ни в
      // меню, ни в следующий открытый офис.
      selected: null,
      openTask: null,
      thread: 'pm#1',
      diff: null,
      view: 'office',
      menuNotice: null,
    });
  },

  requestCreateOffice: (name, projectDir) => {
    set({ pending: 'create', pendingLabel: name.trim() || projectDir.trim(), menuNotice: null });
    createOffice(name, projectDir);
  },

  requestSetupOffice: (plan) => {
    set({ pending: 'create', pendingLabel: plan.name.trim(), menuNotice: null, setupSteps: [] });
    socket?.send(JSON.stringify({ c: 'setup_office', plan }));
  },

  loadSetupCatalog: () => {
    socket?.send(JSON.stringify({ c: 'setup_catalog' }));
  },

  pickFolder: (purpose, start) => {
    if (get().picking) return;
    set({ picking: purpose });
    socket?.send(JSON.stringify({ c: 'pick_folder', purpose, start }));
  },

  dismissMenuNotice: () => set({ menuNotice: null }),

  apply: (e) => {
    switch (e.t) {
      case 'snapshot': {
        // Язык офиса запоминаем раньше, чем раскладываем снимок: подписи в
        // нём уже собираются на новом языке.
        setLang(e.settings.language);
        const instances = Object.fromEntries(e.instances.map((i) => [i.id, i]));
        // Снапшот — это не приход в офис, а картина офиса, который уже
        // работает: агентов ставим по местам без ходьбы. Живые позиции
        // прежнего офиса при этом больше ни о чём: сцена собирается заново.
        // Один общий номер маршрута на всех — ходить никто из них не начинает.
        livePos.clear();
        walkSeq += 1;
        const seq = walkSeq;
        const pos = Object.fromEntries(e.instances.map((i) => {
          const home = homeTarget(i, e.roles, e.layout, instances);
          return [i.id, {
            ...home.at, path: [{ ...home.at }], speed: walkSpeed(),
            seq, atDesk: home.atDesk, arrived: true,
          }];
        }));
        set((s) => ({
          lang: asLang(e.settings.language),
          roles: e.roles, instances, pos,
          tasks: Object.fromEntries(e.tasks.map((t) => [t.id, t])),
          epics: Object.fromEntries(e.epics.map((f) => [f.id, f])),
          chat: e.chat, log: e.log, permissions: e.permissions, settings: e.settings,
          // Вкладку могли открыть посреди хода менеджера: черновики из снимка
          // и есть то, что он уже успел наговорить.
          drafts: Object.fromEntries(e.drafts.map((d) => [d.thread, d])),
          layouts: e.layouts, layout: e.layout, layoutOverride: e.layoutOverride,
          projectDir: e.projectDir, authSource: e.authSource, meeting: e.meeting, meetings: e.meetings,
          busy: e.busy,
          paused: e.paused, usage: e.usage.total, usageDays: e.usage.days, limits: e.limits,
          offices: e.offices, cloud: e.cloud, env: e.env,
          mcpStatus: Object.fromEntries(e.mcpStatus.map((m) => [m.id, m])),
          mergeChecks: Object.fromEntries(e.mergeChecks.map((c) => [c.taskId, c])),
          mergeRun: e.mergeRun,
          prs: Object.fromEntries(e.prs.map((pr) => [pr.taskId, pr])),
          runs: Object.fromEntries(e.runs.map((r) => [r.subject.taskId ?? r.id, r])),
          workflows: e.workflows,
          facts: e.facts, questions: e.questions, openQuestions: e.openQuestions, life: e.life,
          directions: e.directions, proposals: e.proposals,
          booted: true, connectFailed: false,
          // Снапшот пришёл во время входа/создания — офис открыт, показываем комнату.
          screen: s.pending ? 'office' : s.screen,
          pending: null, pendingLabel: null,
          // Сборка мастером закончилась входом в офис — экран прогресса больше не нужен.
          setupSteps: null,
          // Снапшот — это либо переподключение, либо реальное переключение
          // офиса (switch_office шлёт именно snapshot, не точечный patch):
          // выделение, ветка чата и открытый дифф предыдущего офиса тут
          // больше не про что.
          selected: null,
          openTask: null,
          thread: 'pm#1',
          chatUnread: false,
          diff: null,
          roleFeedback: null,
          teamRequest: null,
          // Правила — чужие: у нового офиса свои файлы и свои круги.
          // Панель спросит их заново, когда её откроют.
          rules: null,
        }));
        break;
      }
      case 'instance': {
        const s0 = get();
        const prevInst = s0.instances[e.instance.id];
        const wasBusy = prevInst ? isBusy(prevInst, s0.roles) : false;
        const nowBusy = isBusy(e.instance, s0.roles);
        // Место меняем только когда реально сменился статус занятости —
        // иначе каждое обновление расхода/заметки дёргало бы человечка.
        // На совещании стол/кухня подождут: место освободится, когда оно закончится.
        const inMeetingNow = s0.meeting?.status === 'running'
          && s0.meeting.participants.includes(e.instance.id);
        const shouldMove = !s0.pos[e.instance.id] || (wasBusy !== nowBusy && !inMeetingNow);
        const before = interestsOf(s0);
        set((s) => ({ instances: { ...s.instances, [e.instance.id]: e.instance } }));
        if (shouldMove) {
          const s1 = get();
          walkTo(e.instance.id, homeTarget(e.instance, s1.roles, s1.layout, s1.instances));
        }
        reseat(before, e.instance.id);
        break;
      }
      case 'instance.remove':
        livePos.delete(e.id);
        const before = interestsOf(get());
        set((s) => {
          const instances = { ...s.instances };
          delete instances[e.id];
          return { instances };
        });
        reseat(before, e.id);
        break;
      case 'epic':
        set((s) => ({ epics: { ...s.epics, [e.epic.id]: e.epic } }));
        break;
      case 'task': {
        const before = get().tasks[e.task.id];
        const t = e.task;
        set((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
        // Тост только на смену статуса, иначе он всплывал бы на каждое
        // обновление стоимости и токенов.
        if (before?.status !== t.status && (t.status === 'done' || t.status === 'failed')) {
          const files = t.files.length ? tr('toast.files', { n: t.files.length }) : '';
          pushToast({
            id: `${t.id}-${t.status}`,
            kind: t.status === 'done' ? 'done' : 'failed',
            title: tr(t.status === 'done' ? 'toast.taskDone' : 'toast.taskFailed', {
              who: t.assigneeId ?? tr('common.someone'), task: t.id, title: t.title,
            }),
            detail: t.status === 'done'
              ? `+$${t.usage.costUsd.toFixed(3)}${files}`
                + (t.branch && !t.merged ? tr('toast.needsMerge') : '')
              : (t.result ?? '').slice(0, 120),
            taskId: t.id,
          });
        }
        break;
      }
      case 'task.remove':
        set((s) => {
          const tasks = { ...s.tasks };
          delete tasks[e.id];
          // Карточка стёртой задачи открыта — закрываем её: показывать в ней
          // больше нечего, а пустая панель выглядит как поломка.
          return s.openTask === e.id ? { tasks, openTask: null } : { tasks };
        });
        break;
      case 'chat':
        set((s) => {
          if (s.chat.some((c) => c.id === e.entry.id)) return {};
          const chat = [...s.chat, e.entry];
          // Готовая реплика пришла — черновик того же автора отслужил. Сервер
          // снимает его и сам (`chat.draft.end` шлётся раньше), но держать
          // «без дубля» на порядке событий не стоит: событие могло и потеряться.
          const live = s.drafts[e.entry.thread];
          const drafts = live && live.from === e.entry.from ? { ...s.drafts } : s.drafts;
          if (drafts !== s.drafts) delete drafts[e.entry.thread];
          // Ответили не нам в открытый чат — зажигаем точку на сегменте.
          const chatUnread = s.chatUnread
            || (e.entry.thread === 'pm#1' && e.entry.from !== 'user'
              && !(s.view === 'chat' && s.thread === 'pm#1'));
          const seen = { drafts, chatUnread };
          // Отказ входа/создания офиса приходит событием `office.error` (ниже).
          // Реплику «офис» за отказ здесь больше не принимаем: пока ждём
          // снимок нового офиса, он же может прислать свою планёрку, и меню
          // показало бы её в форме как ошибку.
          // Тот же приём для настроек: отказ (например, неизвестная
          // раскладка) приходит репликой «офис», а не отдельным событием.
          // Пока идёт сохранение — эта реплика про него, а не про что-то
          // ещё; окно настроек уже закрыто, поэтому показываем тостом.
          if (isOfficeSender(e.entry.from) && s.settingsPending) {
            pushToast({
              id: e.entry.id, kind: 'failed',
              title: tr('toast.settingsNotSaved'), detail: e.entry.text,
            });
            return { chat, ...seen, settingsPending: false };
          }
          // Тот же приём для правки расстановки: отказ (предмета нет,
          // координата вне комнаты) приходит репликой «офис», а не отдельным
          // событием (см. docs/design/office-layout/spec.md §8).
          if (isOfficeSender(e.entry.from) && s.layoutPending) {
            pushToast({
              id: e.entry.id, kind: 'failed',
              title: tr('toast.layoutNotSaved'), detail: e.entry.text,
            });
            return { chat, ...seen, layoutPending: false };
          }
          return { chat, ...seen };
        });
        break;
      // Черновик завели заново (или начали новое сообщение): текст берём
      // из события целиком — прежний недописанный к ответу уже не относится.
      case 'chat.draft':
        set((s) => ({ drafts: { ...s.drafts, [e.draft.thread]: e.draft } }));
        break;
      case 'chat.draft.delta':
        set((s) => {
          const entry = Object.entries(s.drafts).find(([, d]) => d.id === e.id);
          if (!entry) return {};
          const [thread, draft] = entry;
          return { drafts: { ...s.drafts, [thread]: { ...draft, text: draft.text + e.text } } };
        });
        break;
      // Конец хода — в том числе по ошибке и обрыву: индикатор снимаем всегда.
      case 'chat.draft.end':
        set((s) => {
          const thread = Object.keys(s.drafts).find((k) => s.drafts[k].id === e.id);
          if (!thread) return {};
          const drafts = { ...s.drafts };
          delete drafts[thread];
          return { drafts };
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
      case 'setup.catalog':
        set({ setupCatalog: e.catalog });
        break;
      case 'setup.progress':
        set({ setupSteps: e.steps });
        break;
      case 'folder.picked':
        set((s) => ({ picking: null, picked: { seq: (s.picked?.seq ?? 0) + 1, purpose: e.purpose, dir: e.dir, error: e.error } }));
        break;
      case 'office.error':
        // Отказ во входе или создании, пока меню ждёт ответа: форма
        // показывает причину и перестаёт крутить спиннер.
        if ((e.op === 'create' || e.op === 'switch') && get().pending) {
          set((s) => ({
            pending: null,
            pendingLabel: null,
            menuNotice: { kind: s.pending === 'create' ? 'create-error' as const : 'blocked' as const, text: e.message },
          }));
          break;
        }
        // Стартовый офис не открылся: снапшота не будет никогда, и меню без
        // этой ветки висело бы на «Открываем офис…» до таймаута соединения,
        // а потом врало бы, что сервер недоступен. Список офисов сервер
        // присылает прямо перед ошибкой, поэтому показываем меню с причиной:
        // человек может открыть другой проект, не перезапуская сервер.
        // Отказы создания, входа и переименования меню разбирает репликой
        // «офис» в чате — их эта ветка не трогает. Иконка — отдельный, более
        // новый op: для неё протокол сразу даёт это событие, поэтому здесь же
        // и показываем тост, без похода через чат.
        if (e.op === 'icon') {
          pushToast({
            id: `office-icon-error-${e.officeId ?? 'x'}`,
            kind: 'failed',
            title: tr('toast.iconNotSaved'),
            detail: e.message,
          });
          break;
        }
        set((s) => (e.op === 'open' && !s.booted
          ? {
            booted: true,
            connectFailed: false,
            pending: null,
            pendingLabel: null,
            menuNotice: { kind: 'blocked' as const, text: e.message },
          }
          : {}));
        break;
      case 'cloud':
        set({ cloud: e.cloud });
        break;
      case 'usage':
        set({ usage: e.total, usageDays: e.days });
        break;
      case 'limits':
        set({ limits: e.limits });
        break;
      case 'mcp.status':
        set({ mcpStatus: Object.fromEntries(e.servers.map((m) => [m.id, m])) });
        break;
      case 'roles':
        set({ roles: e.roles });
        break;
      case 'role.error':
        set({ roleFeedback: { op: e.op, roleId: e.roleId, errors: e.errors } });
        break;
      case 'role.saved':
        set({ roleFeedback: { op: e.op, roleId: e.roleId, errors: [] } });
        break;
      case 'market':
        set({ market: e.market });
        break;
      case 'role.exported':
        set({ exportResult: { roleId: e.roleId, dir: e.dir, warnings: e.warnings, error: e.error } });
        break;
      case 'settings':
        // Язык приезжает вместе с остальными настройками офиса: сначала его
        // запоминает словарь, и только потом обновляется стор — иначе
        // перерисовка успела бы пройти по старому языку.
        if (setLang(e.settings.language)) set({ lang: asLang(e.settings.language) });
        set({ settings: e.settings, settingsPending: false });
        break;
      case 'layout': {
        set({ layout: e.layout, layoutOverride: e.override, layoutPending: false });
        // Правка могла сдвинуть столы и кухонные места — переставляем всех
        // на пересчитанные позиции, как при смене раскладки целиком.
        // Кто на совещании — там и остаётся, вернётся домой после него.
        const s0 = get();
        const inMeeting = new Set(s0.meeting?.status === 'running' ? s0.meeting.participants : []);
        for (const inst of Object.values(s0.instances)) {
          if (inMeeting.has(inst.id)) continue;
          walkTo(inst.id, homeTarget(inst, s0.roles, e.layout, s0.instances));
        }
        break;
      }
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
      case 'pr':
        set((s) => ({ prs: { ...s.prs, [e.pr.taskId]: e.pr } }));
        break;
      case 'run':
        set((s) => ({ runs: { ...s.runs, [e.run.subject.taskId ?? e.run.id]: e.run } }));
        break;
      case 'workflows':
        set({ workflows: e.workflows });
        break;
      case 'fact':
        set((s) => ({
          facts: s.facts.some((f) => f.id === e.fact.id)
            ? s.facts.map((f) => (f.id === e.fact.id ? e.fact : f))
            : [...s.facts, e.fact],
        }));
        break;
      case 'fact.remove':
        set((s) => ({ facts: s.facts.filter((f) => f.id !== e.id) }));
        break;
      case 'question':
        set((s) => ({
          questions: s.questions.some((q) => q.id === e.question.id)
            ? s.questions.map((q) => (q.id === e.question.id ? e.question : q))
            : [...s.questions, e.question],
          openQuestions: e.openQuestions,
        }));
        break;
      case 'life':
        set({ life: e.life });
        break;
      case 'rules':
        set({ rules: e.scopes });
        break;
      case 'health':
        set({ health: e.health });
        break;
      case 'env':
        set({ env: e.env });
        break;
      case 'direction':
        set((s) => ({
          directions: s.directions.some((d) => d.id === e.direction.id)
            ? s.directions.map((d) => (d.id === e.direction.id ? e.direction : d))
            : [...s.directions, e.direction],
        }));
        break;
      case 'direction.remove':
        set((s) => ({ directions: s.directions.filter((d) => d.id !== e.id) }));
        break;
      case 'proposal':
        set((s) => ({
          proposals: s.proposals.some((p) => p.id === e.proposal.id)
            ? s.proposals.map((p) => (p.id === e.proposal.id ? e.proposal : p))
            : [...s.proposals, e.proposal],
        }));
        break;
      case 'meeting': {
        // История дописывается тем же событием, что двигает людей к столу:
        // null означает «совещание ушло со стола», из истории оно не уходит.
        const next = e.meeting;
        set((s) => ({
          meeting: next,
          meetings: !next ? s.meetings
            : s.meetings.some((m) => m.id === next.id)
              ? s.meetings.map((m) => (m.id === next.id ? next : m))
              : [...s.meetings, next],
        }));
        // Рассаживаем участников за стол переговорки и возвращаем на места после —
        // каждый идёт своей ломаной, а не телепортируется.
        const s0 = get();
        if (e.meeting) {
          const total = e.meeting.participants.length;
          e.meeting.participants.forEach((id, i) => {
            const seat = meetingSeat(s0.layout, catalog, i, total);
            walkTo(id, { at: { x: seat.x, y: seat.y }, atDesk: false });
          });
        } else {
          for (const inst of Object.values(s0.instances)) {
            walkTo(inst.id, homeTarget(inst, s0.roles, s0.layout, s0.instances));
          }
        }
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
        // Встать рядом с рабочей точкой адресата, а не в неё саму: за ней
        // сидит человек. Клетку выбирает карта — прежнее «на тайл левее и
        // чуть ниже якоря стола» у крайнего слева стола уводило за пределы
        // комнаты, и путь туда искать было негде.
        const workAt = target.deskless
          ? { x: target.desk.x, y: target.desk.y }
          : deskPoint(get().layout, catalog, target.desk.index, 'work');
        const beside = adjacentFree(passabilityFor(get().layout), workAt) ?? workAt;
        walkTo(e.from, { at: beside, atDesk: false });
        setTimeout(() => {
          // Куда возвращаться, спрашиваем в момент возврата, а не сейчас: за
          // две с половиной секунды менеджер мог закончить ход, и тогда его
          // дом — уже не стол, а место отдыха.
          const s1 = get();
          const back = s1.instances[e.from] ?? home;
          walkTo(e.from, homeTarget(back, s1.roles, s1.layout, s1.instances));
        }, 2600);
        break;
      }
    }
  },
}));

let socket: WebSocket | null = null;

/**
 * Скорость ходьбы — тайлов в секунду, постоянная для любого отрезка (§7
 * спеки): длительность отрезка = его длина / эта скорость, а не фиксированные
 * 900 мс независимо от расстояния. Значение подобрано так, чтобы типичный
 * (несколько тайлов, часто по диагонали после «протягивания» пути) отрезок
 * занимал примерно те же ~0.9 с, что и раньше, — общий темп офиса не должен
 * визуально «поехать».
 */
const WALK_TILES_PER_SEC = 5;

/**
 * Скорость ходьбы — ручка подгонки (`design/fit.json`), а не константа.
 *
 * Она же управляет тем, как быстро перебирают ноги: клип шага растягивается
 * под неё в `Agents3D`. Разъехавшись, эти два числа дают скольжение по полу —
 * поэтому источник у них один. Значение из файла может не приехать (старый
 * файл, правка руками), тогда берётся прежнее.
 */
function walkSpeed(): number {
  const v = fitNow().walk.tilesPerSec;
  return Number.isFinite(v) && v > 0 ? v : WALK_TILES_PER_SEC;
}

/**
 * Номер следующего маршрута — общий счётчик на всех агентов. Сравниваются
 * номера только с прежним номером того же агента, поэтому один счётчик на
 * офис проще отдельных и так же надёжен.
 */
let walkSeq = 0;

/**
 * Где фигура агента стоит прямо сейчас, в тайлах раскладки.
 *
 * Пишет рендер каждый кадр, читает поиск пути. Не состояние стора нарочно:
 * перерисовывать офис по движению фигуры незачем — она и так рисуется каждый
 * кадр, — а вот строить новый маршрут надо именно от того места, где человек
 * оказался. Раньше на этот вопрос отвечать было нечем, и маршрут, перебитый
 * на полпути, начинался от точки выхода: агент, которого позвали на совещание
 * посреди комнаты, сперва возвращался туда, откуда вышел.
 */
const livePos = new Map<string, Pos>();

/** Рендер сообщает, где фигура. Вызывается из кадра — ничего не перерисовывает. */
export function reportPosition(instanceId: string, x: number, y: number): void {
  livePos.set(instanceId, { x, y });
}

/**
 * Ставит агента в точку без ходьбы: первое появление, снапшот, смена офиса.
 * Маршрут из одной точки — рендер поймёт его как «просто стой здесь».
 */
function placeAt(instanceId: string, target: WalkTarget): void {
  walkSeq += 1;
  const seq = walkSeq;
  useStore.setState((s) => ({
    pos: {
      ...s.pos,
      [instanceId]: {
        ...target.at, path: [{ ...target.at }], speed: walkSpeed(),
        seq, atDesk: target.atDesk, arrived: true,
      },
    },
  }));
}

/**
 * Ведёт агента к точке по карте проходимости (§7): считает ломаную и отдаёт
 * её рендеру целиком. Сетка берётся из кэша `passabilityFor` — считается один
 * раз на раскладку, не на каждый шаг.
 *
 * Пути нет (цель на занятой клетке, комната отрезана) — идём настолько
 * близко, насколько пускает карта (`bestEffort`), но не напрямую. Прежний
 * запасной ход «идти по прямой» и означал «сквозь стены»: достаточно было
 * цели на занятом тайле — менеджер, например, шёл к чужому столу в точку
 * `desk.x - 1.1`, которая у крайнего слева стола попадала вообще за пределы
 * комнаты, — и агент честно шёл по прямой через всё, что было между.
 */
function walkTo(instanceId: string, target: WalkTarget): void {
  const s = useStore.getState();
  const current = s.pos[instanceId];
  if (!current) { placeAt(instanceId, target); return; }

  const grid = passabilityFor(s.layout);
  const grounded = { x: current.x, y: current.y };
  // От того места, где фигура на самом деле, — его сообщает рендер. Пока он не
  // сказал ни слова (первый кадр ещё не нарисован), берём цель прежнего
  // маршрута: другого ответа просто нет.
  const from = livePos.get(instanceId) ?? grounded;
  // `bestEffort` отказывает только когда свободной клетки нет во всей округе —
  // например, координата фигуры уехала за пределы комнаты. Тогда пробуем от
  // цели прежнего маршрута: это место заведомо на карте.
  const path = findPath(grid, from, target.at, { bestEffort: true })
    ?? findPath(grid, grounded, target.at, { bestEffort: true });
  // Не нашлось и оттуда — агент остаётся там, где стоит. Прежде здесь был
  // запасной ход «идти напрямую», и он-то и означал «сквозь стены».
  if (!path) return;
  const end = path[path.length - 1];

  walkSeq += 1;
  const seq = walkSeq;
  useStore.setState((st) => ({
    pos: {
      ...st.pos,
      [instanceId]: {
        x: end.x, y: end.y, path, speed: walkSpeed(),
        seq, atDesk: target.atDesk, arrived: path.length < 2,
      },
    },
  }));
}

/**
 * Рендер дошёл до конца маршрута. Отдельное событие, а не таймер в сторе:
 * «дошёл» — это факт о картинке, и знает его тот, кто рисует кадры. По нему
 * загорается монитор на столе (`useLitDesks`) и агент садится.
 */
export function markArrived(instanceId: string, seq: number): void {
  useStore.setState((s) => {
    const walk = s.pos[instanceId];
    if (!walk || walk.seq !== seq || walk.arrived) return {};
    return { pos: { ...s.pos, [instanceId]: { ...walk, arrived: true } } };
  });
}

export function pushToast(toast: Toast): void {
  useStore.setState((s) => (s.toasts.some((t) => t.id === toast.id)
    ? {}
    : { toasts: [...s.toasts, toast] }));
  setTimeout(() => dismissToast(toast.id), toast.ttl ?? 20000);
}

// Системная тема поменялась — офис следует за ней, если выбрано «как в системе».
darkMedia.addEventListener('change', () => {
  if (useStore.getState().themeMode === 'system') useStore.setState({ theme: resolveTheme('system') });
});

/**
 * Ротация занятий: у кого вышел срок, тот берётся за другое дело.
 *
 * Срок у каждого свой (`interests.ts`), поэтому тик частый, а меняется по
 * нему обычно один человек. Кому идти — решает `reseat`, как и после любой
 * другой перемены: сравнивает раздачу до и после и ведёт тех, у кого
 * сменилось место. Сменившим занятие на том же месте идти некуда — им
 * хватает нового номера раздачи, по которому рендер перечитает позу.
 */
function rotateRest(): void {
  const s = useStore.getState();
  if (s.screen !== 'office') return;
  const before = interestsOf(s);
  if (rotateInterests().length === 0) return;
  reseat(before, '');
  useStore.setState((st) => ({ restRev: st.restRev + 1 }));
}
if (typeof window !== 'undefined') setInterval(rotateRest, 1000);

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
  if (!ts) return tr('office.neverOpened');
  const startOfDay = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const time = new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  const daysAgo = Math.max(0, Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000));
  if (daysAgo === 0) return tr('office.openedToday', { time });
  if (daysAgo === 1) return tr('office.openedYesterday', { time });
  if (daysAgo < 7) return tr('office.openedDaysAgo', { n: daysAgo });
  return new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
}

/**
 * Порядок списка офисов — ручная расстановка человека, а для всех, кого руками
 * не двигали, время создания, самый старый сверху (`compareOffices` из общего
 * контракта). Один и тот же на всех трёх экранах: рейл, модалка офисов и
 * главный экран зовут именно эту функцию.
 *
 * Ни выбор офиса, ни его активность, ни события обновления списка порядка не
 * меняют. `lastOpenedAt` для сортировки не годится — он едет при каждом входе,
 * и строка прыгала бы наверх под рукой. Имя тоже не годится, хотя раньше
 * сортировали по нему: его переименовывают, а `localeCompare` считает по
 * локали ОТКРЫТОГО офиса (язык — настройка офиса), и вход в соседний проект
 * с другим языком мог переставить список. Активный офис выделяется только
 * видом (класс `current` в `Rail.tsx`).
 */
export function sortedOffices(offices: OfficeView[]): OfficeView[] {
  return [...offices].sort(compareOffices);
}

/** Сводка активности офиса для переключателя — уже посчитанные тексты и флаги, а не сырые числа. */
export interface OfficeActivitySummary {
  /** Короткая строка вида «2 в работе · 1 к слиянию» либо «простаивает»/«нет данных». */
  text: string;
  /** Прямо сейчас в офисе есть живая сессия — не просто висящая на доске задача. */
  live: boolean;
  /** Есть задачи в работе (не обязательно живые прямо сейчас). */
  hasQueue: boolean;
  /** Есть готовые, но не слитые задачи. */
  hasUnmerged: boolean;
  /** Сколько запросов доступа ждут решения человека. */
  waiting: number;
  /** Офис стоит на паузе: сам он работу не продолжит, пока паузу не снимут. */
  paused: boolean;
}

/** Считает сводку по офису из списка `offices` для короткого переключателя. */
export function summarizeOfficeActivity(o: OfficeView): OfficeActivitySummary {
  const a = o.activity;
  if (!a) {
    return {
      text: tr('office.noData'), live: false, hasQueue: false, hasUnmerged: false, waiting: 0,
      paused: false,
    };
  }
  const parts: string[] = [];
  if (a.inProgress > 0) parts.push(tr('office.inProgress', { n: a.inProgress }));
  if (a.doneUnmerged > 0) parts.push(tr('office.toMerge', { n: a.doneUnmerged }));
  // Пауза идёт первой строкой и не спорит со счётчиками: «2 в работе» у офиса
  // на паузе врало бы — работа там стоит, и сама она не возобновится.
  const text = a.paused
    ? (parts.length ? `${tr('office.paused')} · ${parts.join(' · ')}` : tr('office.paused'))
    : parts.length
      ? parts.join(' · ')
      : tr(a.live ? 'office.working' : 'office.idle');
  return {
    text, live: a.live, hasQueue: a.inProgress > 0, hasUnmerged: a.doneUnmerged > 0,
    waiting: a.waiting, paused: a.paused,
  };
}

/**
 * Четыре уровня общего режима доступа офиса — id, подпись и честное
 * объяснение для UI. Функция, а не константа: язык офиса меняется на ходу,
 * а собранный при загрузке модуля список остался бы на прежнем.
 */
export const accessModes = (): Array<[PermissionMode, string, string]> => ([
  ['readonly', tr('access.readonly'), tr('access.readonly.hint')],
  ['ask-writes', tr('access.ask-writes'), tr('access.ask-writes.hint')],
  ['ask-risky', tr('access.ask-risky'), tr('access.ask-risky.hint')],
  ['auto', tr('access.auto'), tr('access.auto.hint')],
]);

/** Короткая подпись режима доступа — для строки статуса, а не для выбора. */
export const accessLabel = (mode: PermissionMode): string => tr(`access.short.${mode}`);

/** Честный текст подтверждения перед включением полного доступа — офисного или ролевого. */
export const fullAccessWarning = (): string => tr('access.fullWarning');

/** Режим роли, если он задан явно, иначе общий режим офиса. */
export function effectivePermissionMode(
  role: { permissionMode: PermissionMode | null },
  settings: Settings,
): PermissionMode {
  return role.permissionMode ?? settings.officePermissionMode;
}

/** Откуда фактический режим доступа сотрудника: свой, от роли или от офиса. */
export type PermissionSource = 'agent' | 'role' | 'office';

export const permissionSourceLabel = (source: PermissionSource): string =>
  tr(`access.source.${source}`);

/** Первое звено в цепочке «сотрудник → роль → офис», где задано своё правило. */
export function permissionSource(
  inst: { permissionMode: PermissionMode | null },
  role: { permissionMode: PermissionMode | null } | undefined,
): PermissionSource {
  if (inst.permissionMode) return 'agent';
  if (role?.permissionMode) return 'role';
  return 'office';
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

const mergeCheckLabel = (state: MergeCheckState): string => tr(`merge.check.${state}`);

const MERGE_CHECK_CLASS: Record<MergeCheckState, string> = {
  unknown: 'unknown',
  clean: 'clean',
  conflict: 'conflict',
  nothing: 'merged',
};

/** Стадии конвейера ревью на языке интерфейса. */
export const prStageLabel = (stage: PrStage): string => tr(`pr.stage.${stage}`);

/** Цвет стадии: зелёный — доехало, красный — встало, остальное в работе. */
export const prStageClass = (stage: PrStage): string =>
  (stage === 'merged' ? 'merged' : stage === 'stuck' ? 'conflict' : 'checking');

export const mergeStepLabel = (status: MergeStepStatus): string => tr(`merge.step.${status}`);

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
  if (t.merged) return { label: tr('merge.merged'), cls: 'merged' };
  if (t.status !== 'done') return null;
  if (step && step.status !== 'pending') {
    return { label: mergeStepLabel(step.status), cls: mergeStepClass(step.status) };
  }
  if (!check) return { label: tr('merge.check.unknown'), cls: 'unknown' };
  return { label: mergeCheckLabel(check.state), cls: MERGE_CHECK_CLASS[check.state] };
}

/**
 * Нанять ещё одного такого же: офис заведёт отдельного сотрудника с теми же
 * настройками — своя роль из того же пакета, своё имя и своя внешность.
 *
 * Первого сотрудника в роль команда `spawn` уже не шлёт ниоткуда: роль без
 * людей в списке команды не показывается, и найм в неё идёт из маркета —
 * там же, где нанимают и всех остальных (`marketHire`).
 */
export function hireCopy(roleId: string): void {
  socket?.send(JSON.stringify({ c: 'hire_copy', roleId }));
}

export function fire(instanceId: string): void {
  socket?.send(JSON.stringify({ c: 'fire', instanceId }));
}

export function updateRole(roleId: string, patch: Partial<RoleEditable>): void {
  socket?.send(JSON.stringify({ c: 'update_role', roleId, patch }));
}

/** Завести роль. id придумывает сервер по названию — в черновике его нет. */
export function createRole(role: RoleDraft): void {
  socket?.send(JSON.stringify({ c: 'create_role', role }));
}

/** Убрать роль в архив или вернуть её оттуда. */
export function archiveRole(roleId: string, archived: boolean): void {
  socket?.send(JSON.stringify({ c: 'archive_role', roleId, archived }));
}

/** Стереть роль насовсем — только там, где сервер это разрешит (RoleView.removable). */
export function removeRole(roleId: string): void {
  socket?.send(JSON.stringify({ c: 'remove_role', roleId }));
}

/**
 * Отвязать роль от пакета — форк. Бриф остаётся вычисленным и дальше
 * правится напрямую; обновления пакета до роли больше не доходят.
 */
export function detachRole(roleId: string): void {
  socket?.send(JSON.stringify({ c: 'detach_role', roleId }));
}

/** Экспортировать роль в папку пакета. Итог приедет событием role.exported. */
export function exportRole(roleId: string, name: string, dir: string): void {
  socket?.send(JSON.stringify({ c: 'export_role', roleId, name, dir }));
}

export function clearExportResult(): void {
  useStore.setState({ exportResult: null });
}

// ---------------------------------------------------------------- маркет

/** Открыть витрину: реестр, кеш и встроенные пакеты. `refresh` — перечитать реестр. */
export function marketOpen(refresh = false): void {
  socket?.send(JSON.stringify({ c: 'market_open', refresh }));
}

export function marketInstall(name: string): void {
  socket?.send(JSON.stringify({ c: 'market_install', name }));
}

export function marketAddLink(url: string): void {
  socket?.send(JSON.stringify({ c: 'market_add_link', url }));
}

export function marketHire(name: string): void {
  socket?.send(JSON.stringify({ c: 'market_hire', name }));
}

export function marketCheck(): void {
  socket?.send(JSON.stringify({ c: 'market_check' }));
}

export function marketUpdate(roleId: string): void {
  socket?.send(JSON.stringify({ c: 'market_update', roleId }));
}

export function marketHireTeam(name: string): void {
  socket?.send(JSON.stringify({ c: 'market_hire_team', name }));
}

/** Ключ лицензии пакета на этой машине. Пустой — забыть. */
export function marketLicense(name: string, key: string): void {
  socket?.send(JSON.stringify({ c: 'market_license', name, key }));
}

/** Форма роли прочитала итог своей операции — сбрасываем, чтобы не залипал. */
export function clearRoleFeedback(): void {
  useStore.setState({ roleFeedback: null });
}

/** Открыть окно «Команда» сразу на форме конкретной роли. */
export function requestTeamRole(roleId: string): void {
  useStore.setState({ teamRequest: { roleId } });
}

/** Окно «Команда» прочитало запрос на роль — сбрасываем, чтобы не залипал. */
export function clearTeamRequest(): void {
  useStore.setState({ teamRequest: null });
}

export function updateSettings(settings: Partial<Settings>): void {
  useStore.setState({ settingsPending: true });
  socket?.send(JSON.stringify({ c: 'settings', settings }));
}

/**
 * Разбирает поле лимита шагов исполнителя. Пустая строка — «без ограничения»
 * (null, отправлять можно). Значение вне [MIN_TASK_MAX_TURNS; MAX_TASK_MAX_TURNS]
 * или нецелое — ошибка, value в этом случае отправлять нельзя.
 */
export function parseTaskMaxTurns(v: string): { value: number | null; error: string | null } {
  const trimmed = v.trim();
  if (trimmed === '') return { value: null, error: null };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < MIN_TASK_MAX_TURNS || n > MAX_TASK_MAX_TURNS) {
    return {
      value: null,
      error: tr('field.turnsRange', { min: MIN_TASK_MAX_TURNS, max: MAX_TASK_MAX_TURNS }),
    };
  }
  return { value: n, error: null };
}

/**
 * Разбирает поле «Одновременно исполнителей». В отличие от лимита шагов,
 * пустое поле здесь не значит «без ограничения»: офис без потолка сессий —
 * это как раз то, от чего настройка и защищает. Пустое поле оставляет
 * прежнее значение, поэтому value = null и отправлять его нельзя.
 */
export function parseMaxWorkers(v: string): { value: number | null; error: string | null } {
  const trimmed = v.trim();
  if (trimmed === '') return { value: null, error: null };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < MIN_OFFICE_WORKERS || n > MAX_OFFICE_WORKERS) {
    return {
      value: null,
      error: tr('field.workersRange', { min: MIN_OFFICE_WORKERS, max: MAX_OFFICE_WORKERS }),
    };
  }
  return { value: n, error: null };
}

/** Личный режим доступа сотрудника; null — вернуть к режиму роли. */
export function setAgentPermission(instanceId: string, mode: PermissionMode | null): void {
  socket?.send(JSON.stringify({ c: 'agent_permission', instanceId, mode }));
}

/** Имя сотрудника; пустое — снять имя, зовётся по роли. Отказ придёт в чат офиса. */
export function setAgentName(instanceId: string, name: string): void {
  socket?.send(JSON.stringify({ c: 'agent_name', instanceId, name }));
}

export function stopTask(taskId: string): void {
  socket?.send(JSON.stringify({ c: 'stop_task', taskId }));
}

export function retryTask(taskId: string): void {
  socket?.send(JSON.stringify({ c: 'retry_task', taskId }));
}

/**
 * Снять задачу: делать её больше не надо. Идущую офис остановит сам, а
 * задачи, которые ждали её результата, снимет вместе с ней.
 */
export function dropTask(taskId: string, reason = ''): void {
  socket?.send(JSON.stringify({ c: 'task_drop', taskId, reason }));
}

/**
 * Стереть задачу с доски насовсем. Сервер откажет, если за задачей уже стоит
 * работа, — отказ придёт готовым текстом в чат офиса.
 */
export function deleteTask(taskId: string): void {
  socket?.send(JSON.stringify({ c: 'task_delete', taskId }));
}

/** Переписать задачу: шлём только изменённые поля. */
export function editTask(taskId: string, patch: TaskEdit): void {
  socket?.send(JSON.stringify({ c: 'task_edit', taskId, patch }));
}

/**
 * «Поехали» по фиче. То же самое можно сказать менеджеру словами — команда
 * ведёт в тот же обработчик, поэтому щелчок и фраза в чате не расходятся.
 */
export function approveEpic(epicId: string): void {
  socket?.send(JSON.stringify({ c: 'epic_approve', epicId }));
}

/** Снять фичу с плана. Причину офис подставит сам: щелчок её не несёт. */
export function cancelEpic(epicId: string): void {
  socket?.send(JSON.stringify({ c: 'epic_cancel', epicId }));
}

/**
 * Переставить фичи. Шлём весь порядок, а не «эту вверх»: сервер не должен
 * гадать, относительно кого её поднимают, — и два клиента, двигающие план
 * одновременно, не соберут из двух сдвигов третий, которого никто не просил.
 */
export function reorderEpics(epicIds: string[]): void {
  socket?.send(JSON.stringify({ c: 'epic_reorder', epicIds }));
}

export function callMeeting(topic: string, participants: string[]): void {
  socket?.send(JSON.stringify({ c: 'meeting', topic, participants }));
}

export function showDiff(taskId: string): void {
  useStore.setState({ diff: { taskId, stat: '', patch: '', truncated: false } });
  socket?.send(JSON.stringify({ c: 'task_diff', taskId }));
}

/** Толкнуть вставший конвейер: он продолжит с той стадии, где встал. */
export function retryPipeline(taskId: string): void {
  socket?.send(JSON.stringify({ c: 'pr_retry', taskId }));
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

/**
 * Пересчитать проверки окружения по кнопке «перепроверить». Свежий отчёт
 * приедет через WS-событие 'env' — здесь достаточно дёрнуть REST, не трогая
 * стор напрямую. `?office=` обязателен: без него сервер пересчитает не тот
 * офис, что открыт в этой вкладке, а глобальный текущий офис процесса.
 */
export function recheckEnv(): Promise<void> {
  const officeId = useStore.getState().offices.find((o) => o.current)?.id;
  const query = officeId ? `?office=${encodeURIComponent(officeId)}` : '';
  return fetch(`/api/env${query}`, { method: 'POST' }).then(() => undefined).catch(() => undefined);
}

export function createOffice(name: string, projectDir: string): void {
  socket?.send(JSON.stringify({ c: 'create_office', name, projectDir }));
}

export function renameOffice(officeId: string, name: string): void {
  socket?.send(JSON.stringify({ c: 'rename_office', officeId, name }));
}

/**
 * Перетащили строку офиса в рейле. `index` — место в ВИДИМОМ списке (том, что
 * рисует `sortedOffices`), считая от нуля и БЕЗ самого переставляемого офиса —
 * ровно так, как ждёт `reorderOffice` на сервере. Правда — то, что сервер
 * пришлёт следующим событием `offices`; здесь только отправка команды.
 */
export function reorderOffice(officeId: string, index: number): void {
  socket?.send(JSON.stringify({ c: 'reorder_office', officeId, index }));
}

/** null сбрасывает иконку офиса к умолчанию (инициал). */
export function setOfficeIcon(officeId: string, icon: OfficeIcon | null): void {
  socket?.send(JSON.stringify({ c: 'set_office_icon', officeId, icon }));
}

/**
 * Загрузить картинку-иконку офиса. Тело запроса — сам файл: ручка
 * `POST /api/office/icon` берёт формат из Content-Type (src/server/officeicon.ts),
 * multipart она не разбирает. Идёт по HTTP, а не по сокету, потому что байты
 * файла в JSON-команде пришлось бы гнать base64-строкой.
 *
 * Возвращает текст отказа сервера (его же показываем человеку) или null, если
 * всё сохранилось: новый список офисов с адресом картинки приедет сам событием
 * 'offices', отдельного обновления стора здесь не нужно.
 */
export async function uploadOfficeIcon(officeId: string, file: File): Promise<string | null> {
  try {
    const res = await fetch(`/api/office/icon?office=${encodeURIComponent(officeId)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    const body = await res.json().catch(() => null) as { error?: string } | null;
    if (!res.ok) return body?.error ?? `HTTP ${res.status}`;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Токен GitHub уходит на сервер и живёт только в памяти процесса. */
export function setCloudToken(token: string): void {
  socket?.send(JSON.stringify({ c: 'cloud_token', token }));
}

export function setPaused(paused: boolean): void {
  socket?.send(JSON.stringify({ c: 'pause', paused }));
}

/** Включить/выключить редактор расстановки. Выключение бросает недотащенный предмет без сохранения. */
export function setEditingLayout(v: boolean): void {
  useStore.setState({ editingLayout: v, dragItem: null });
}

/**
 * Взять предмет мышью — только в режиме редактирования, вне него мебель не
 * хватается. Поворот берётся текущий: правка уходит на сервер целиком, и
 * предмет, который просто подвинули, не должен вставать прямо.
 */
export function startDrag(key: string, x: number, y: number, rot = 0): void {
  const s = useStore.getState();
  if (!s.editingLayout) return;
  useStore.setState({ dragItem: { key, rot, ...clampToRoom(s.layout, snapToGrid(x), snapToGrid(y)) } });
}

/**
 * Повернуть предмет, пока он в руках. Шаг мелкий: в плоском офисе поворота не
 * было вовсе (спрайт вида сверху разворачивается только перерисовкой), и
 * ограничивать его прямыми углами теперь незачем — стол под углом к стене
 * ставится ровно так же просто, как вдоль неё.
 */
export function rotateDrag(delta: number): void {
  useStore.setState((s) => (s.dragItem
    ? { dragItem: { ...s.dragItem, rot: (((s.dragItem.rot + delta) % 360) + 360) % 360 } }
    : {}));
}

/** Провести взятый предмет к точке курсора — только превью, до отпускания кнопки ничего не уходит на сервер. */
export function updateDrag(x: number, y: number): void {
  useStore.setState((s) => (s.dragItem
    ? { dragItem: { ...s.dragItem, ...clampToRoom(s.layout, snapToGrid(x), snapToGrid(y)) } }
    : {}));
}

/** Отпустили кнопку мыши: если что-то тащили — сохраняем новую позицию правкой поверх оверрайда. */
export function endDrag(): void {
  const item = useStore.getState().dragItem;
  useStore.setState({ dragItem: null });
  if (!item) return;
  useStore.setState({ layoutPending: true });
  socket?.send(JSON.stringify({
    c: 'layout_edit',
    edits: [{ key: item.key, at: [item.x, item.y], rot: item.rot }],
  }));
}

/** Сбросить расстановку офиса к пресету — весь оверрайд целиком. */
export function resetLayout(): void {
  useStore.setState({ layoutPending: true });
  socket?.send(JSON.stringify({ c: 'layout_reset' }));
}

/** Открыть настройки сразу на разделе «Проект» — там выбор раскладки. */
export function openLayoutSettings(): void {
  useStore.setState({ settingsSection: 'project' });
}

/** SettingsModal прочитал запрос на раздел — сбрасываем, чтобы не залипал. */
export function clearSettingsSection(): void {
  useStore.setState({ settingsSection: null });
}

export function reset(): void {
  socket?.send(JSON.stringify({ c: 'reset' }));
}

// ---------------------------------------------------------------- живой офис

/** Ответ на вопрос офиса: ложится в журнал, менеджер узнаёт системным сообщением. */
export function answerQuestion(id: string, answer: string): void {
  socket?.send(JSON.stringify({ c: 'answer_question', id, answer }));
}

/** Снять вопрос без ответа: офис остаётся при своём допущении. */
export function dismissQuestion(id: string): void {
  socket?.send(JSON.stringify({ c: 'dismiss_question', id }));
}

export function confirmFact(id: string): void {
  socket?.send(JSON.stringify({ c: 'fact_confirm', id }));
}

export function archiveFact(id: string): void {
  socket?.send(JSON.stringify({ c: 'fact_archive', id }));
}

/** Запустить ритуал сейчас — тем же путём, что по расписанию. */
export function saveWorkflow(id: string, text: string): void {
  socket?.send(JSON.stringify({ c: 'workflow_save', id, text }));
}

export function resetWorkflow(id: string): void {
  socket?.send(JSON.stringify({ c: 'workflow_reset', id }));
}

export function runRitual(ritual: RitualId): void {
  socket?.send(JSON.stringify({ c: 'ritual_run', ritual }));
}

/**
 * Сменить важность задачи. Отдельная команда, а не патч задачи: сервер сам
 * пришлёт обновлённую задачу в снимке, поэтому локально тут ничего не
 * угадываем — иначе доска на миг показала бы то, чего офис ещё не принял.
 */
export function setTaskPriority(taskId: string, priority: TaskPriority): void {
  socket?.send(JSON.stringify({ c: 'task_priority', taskId, priority }));
}

export function createDirection(text: string): void {
  socket?.send(JSON.stringify({ c: 'direction_create', text }));
}

export function updateDirection(
  id: string, patch: Partial<Pick<DirectionView, 'text' | 'active' | 'priority'>>,
): void {
  socket?.send(JSON.stringify({ c: 'direction_update', id, patch }));
}

export function removeDirection(id: string): void {
  socket?.send(JSON.stringify({ c: 'direction_remove', id }));
}

/**
 * Правила офиса. Своего списка клиент не держит и после правки ничего не
 * угадывает: номера пунктов в файле после удаления съезжают, и правду о них
 * знает только сервер — он и присылает круги целиком на каждую команду.
 */
export function listRules(): void {
  socket?.send(JSON.stringify({ c: 'rules_list' }));
}

export function addRule(scopeId: string, text: string): void {
  socket?.send(JSON.stringify({ c: 'rule_add', scopeId, text }));
}

export function editRule(id: string, text: string): void {
  socket?.send(JSON.stringify({ c: 'rule_edit', id, text }));
}

export function dropRule(id: string): void {
  socket?.send(JSON.stringify({ c: 'rule_drop', id }));
}

/** Принять или отклонить предложение офиса. Принятая фича встаёт в план согласованной. */
export function decideProposal(id: string, accept: boolean): void {
  socket?.send(JSON.stringify({ c: 'proposal_decide', id, accept }));
}

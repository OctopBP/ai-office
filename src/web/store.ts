import { create } from 'zustand';
import type {
  ChatEntry, DayUsage, FieldError, InstanceView, Layout, LayoutOption, LayoutOverride, LogEntry,
  MergeCheck, MergeCheckState, MergeRun, MergeStep, MergeStepStatus, PermissionDecision,
  PermissionMode, PermissionRequest, MeetingView, RoleDraft, RoleEditable, RoleOp, RoleView,
  ServerEvent, Settings, TaskView, Usage, CloudStatus, OfficeView, PullRequestView, PrStage,
} from '../shared/types';
import {
  emptyUsage, MAX_OFFICE_WORKERS, MAX_TASK_MAX_TURNS, MIN_OFFICE_WORKERS, MIN_TASK_MAX_TURNS,
} from '../shared/types';
import type { Theme } from './sprites';
import { type Graphics, loadGraphics, saveGraphics } from './office3d/graphics';
import { fitNow } from './office3d/fit';
import { catalog, DEFAULT_LAYOUT_ID, layoutFor, passabilityFor } from './layoutData';
import { interestsFor } from './interests';
import { isBusy } from './agentState';
import { findPath, meetingSeat } from '../shared/layout';

interface Pos { x: number; y: number }

/**
 * Позиция агента для отрисовки плюс длительность WAAPI-перехода к ней —
 * считается в walkTo/stepWalk по длине отрезка (§7 спеки), а не константа.
 * ms = 0 — телепорт без анимации (первое появление, снапшот, неизвестная
 * текущая позиция).
 */
interface WalkPos extends Pos { ms: number }

/**
 * «Домашняя» позиция агента, когда он не на совещании и не в момент передачи
 * задачи: занятый сидит за своим столом, свободный — там, где ему нашлось
 * занятие. Кто занят, решает `isBusy` — у исполнителя это задача, у менеджера
 * ход разговора; отдельного флага занятости на клиенте не заводим.
 *
 * Менеджер тут ничем не выделен нарочно: раньше он сидел за компьютером
 * всегда, даже когда офису нечего было ему сказать, и выглядело это не как
 * «начальник на месте», а как забытая на сцене фигура.
 */
function homePos(
  inst: InstanceView, roles: RoleView[], layout: Layout, instances: Record<string, InstanceView>,
): Pos {
  if (isBusy(inst, roles)) return { x: inst.desk.x, y: inst.desk.y };
  // Свободный идёт туда, где ему нашлось занятие: поговорить, поиграть,
  // посидеть. Если занятий в раскладке нет вовсе — остаётся за своим столом:
  // по смыслу хуже, но сцену пустой координатой не ломает.
  return interestsFor(layout, catalog, instances, roles).get(inst.id)?.at
    ?? { x: inst.desk.x, y: inst.desk.y };
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
  /**
   * Итог последней операции с ролью (создание/правка/архивация/удаление):
   * пустой `errors` — сделано, форма роли использует это как сигнал закрыть
   * себя или очистить поля; непустой — ошибки, разложенные по полям.
   */
  roleFeedback: { op: RoleOp; roleId: string | null; errors: FieldError[] } | null;
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
  /** Порядок задач, которые пользователь набрал для следующего запуска очереди слияния. */
  mergeSelection: string[];
  /** Статусы мержабельности завершённых задач, по taskId — приходят от сервера целиком. */
  mergeChecks: Record<string, MergeCheck>;
  /** Идёт ли сейчас пересчёт статусов: пока он идёт, старые статусы ещё валидны. */
  mergeChecking: boolean;
  /** Последний (или ещё идущий) прогон очереди слияния. */
  mergeRun: MergeRun | null;
  /** Пулл-реквесты конвейера ревью, по taskId. */
  prs: Record<string, PullRequestView>;
  toggleMergeSelect: (taskId: string) => void;
  moveMergeSelect: (taskId: string, dir: -1 | 1) => void;
  clearMergeSelection: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** Показывать комнату трёхмерным рендером вместо плоского (клавиша 0).
   *  Пока 3D догоняет плоский офис по функциям, выбор остаётся за
   *  пользователем и переживает перезагрузку. */
  render3d: boolean;
  setRender3d: (v: boolean) => void;
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
  roleFeedback: null,
  teamRequest: null,
  settings: {
    globalBudgetUsd: null, taskBudgetUsd: null, engine: 'local', cloudRepoUrl: null,
    officePermissionMode: 'ask-risky', layoutId: 'classic', autoPipeline: true,
  },
  layouts: [],
  // До первого снапшота своей раскладки офиса ещё не знаем — берём тот же
  // classic, что и запасное значение settings.layoutId ниже.
  layout: layoutFor(DEFAULT_LAYOUT_ID),
  layoutOverride: null,
  layoutPending: false,
  editingLayout: false,
  settingsSection: null,
  dragItem: null,
  settingsPending: false,
  meeting: null,
  mergeSelection: [],
  mergeChecks: {},
  mergeChecking: false,
  mergeRun: null,
  prs: {},
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
  // В этой ветке офис по умолчанию трёхмерный — она ради него и заведена.
  // Явный выбор пользователя (клавиша 0) сильнее умолчания и переживает
  // перезагрузку; когда 3D догонит плоский рендер по функциям, ключ уйдёт
  // вместе с самим переключателем.
  render3d: (localStorage.getItem('office-render3d') ?? '1') === '1',
  graphics: loadGraphics(),
  toasts: [],
  diff: null,
  pos: {},
  selected: null,
  thread: 'pm#1',

  setThread: (t) => set({ thread: t }),
  setTheme: (t) => { localStorage.setItem('office-theme', t); set({ theme: t }); },
  setRender3d: (v) => { localStorage.setItem('office-render3d', v ? '1' : '0'); set({ render3d: v }); },
  setGraphics: (patch) => set((s) => {
    const graphics = { ...s.graphics, ...patch };
    saveGraphics(graphics);
    return { graphics };
  }),
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
        const pos = Object.fromEntries(
          e.instances.map((i) => [i.id, { ...homePos(i, e.roles, e.layout, instances), ms: 0 }]),
        );
        set((s) => ({
          roles: e.roles, instances, pos,
          tasks: Object.fromEntries(e.tasks.map((t) => [t.id, t])),
          chat: e.chat, log: e.log, permissions: e.permissions, settings: e.settings,
          layouts: e.layouts, layout: e.layout, layoutOverride: e.layoutOverride,
          projectDir: e.projectDir, authSource: e.authSource, meeting: e.meeting, busy: e.busy,
          paused: e.paused, usage: e.usage.total, usageDays: e.usage.days,
          offices: e.offices, cloud: e.cloud,
          mergeChecks: Object.fromEntries(e.mergeChecks.map((c) => [c.taskId, c])),
          mergeRun: e.mergeRun,
          prs: Object.fromEntries(e.prs.map((pr) => [pr.taskId, pr])),
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
          roleFeedback: null,
          teamRequest: null,
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
        set((s) => ({ instances: { ...s.instances, [e.instance.id]: e.instance } }));
        if (shouldMove) {
          const s1 = get();
          walkTo(e.instance.id, homePos(e.instance, s1.roles, s1.layout, s1.instances));
        }
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
          // Тот же приём для настроек: отказ (например, неизвестная
          // раскладка) приходит репликой «офис», а не отдельным событием.
          // Пока идёт сохранение — эта реплика про него, а не про что-то
          // ещё; окно настроек уже закрыто, поэтому показываем тостом.
          if (e.entry.from === 'офис' && s.settingsPending) {
            pushToast({ id: e.entry.id, kind: 'failed', title: 'Настройки не сохранены', detail: e.entry.text });
            return { chat, settingsPending: false };
          }
          // Тот же приём для правки расстановки: отказ (предмета нет,
          // координата вне комнаты) приходит репликой «офис», а не отдельным
          // событием (см. docs/design/office-layout/spec.md §8).
          if (e.entry.from === 'офис' && s.layoutPending) {
            pushToast({ id: e.entry.id, kind: 'failed', title: 'Расстановка не сохранена', detail: e.entry.text });
            return { chat, layoutPending: false };
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
      case 'office.error':
        // Стартовый офис не открылся: снапшота не будет никогда, и меню без
        // этой ветки висело бы на «Открываем офис…» до таймаута соединения,
        // а потом врало бы, что сервер недоступен. Список офисов сервер
        // присылает прямо перед ошибкой, поэтому показываем меню с причиной:
        // человек может открыть другой проект, не перезапуская сервер.
        // Отказы остальных операций (создание, вход, переименование) меню
        // разбирает репликой «офис» в чате — их эта ветка не трогает.
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
      case 'roles':
        set({ roles: e.roles });
        break;
      case 'role.error':
        set({ roleFeedback: { op: e.op, roleId: e.roleId, errors: e.errors } });
        break;
      case 'role.saved':
        set({ roleFeedback: { op: e.op, roleId: e.roleId, errors: [] } });
        break;
      case 'settings':
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
          walkTo(inst.id, homePos(inst, s0.roles, e.layout, s0.instances));
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
      case 'meeting': {
        set({ meeting: e.meeting });
        // Рассаживаем участников за стол переговорки и возвращаем на места после —
        // каждый идёт своей ломаной, а не телепортируется.
        const s0 = get();
        if (e.meeting) {
          const total = e.meeting.participants.length;
          e.meeting.participants.forEach((id, i) => {
            const seat = meetingSeat(s0.layout, catalog, i, total);
            walkTo(id, { x: seat.x, y: seat.y });
          });
        } else {
          for (const inst of Object.values(s0.instances)) {
            walkTo(inst.id, homePos(inst, s0.roles, s0.layout, s0.instances));
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
        walkTo(e.from, { x: target.desk.x - 1.1, y: target.desk.y + 0.9 });
        setTimeout(() => {
          // Куда возвращаться, спрашиваем в момент возврата, а не сейчас: за
          // две с половиной секунды менеджер мог закончить ход, и тогда его
          // дом — уже не стол, а место отдыха.
          const s1 = get();
          const back = s1.instances[e.from] ?? home;
          walkTo(e.from, homePos(back, s1.roles, s1.layout, s1.instances));
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

/** Отрезок короче этого не проходится мгновенно — иначе микросдвиги (например,
 * после правки расстановки) выглядели бы как телепорт без анимации. */
const MIN_WALK_MS = 120;

function legDurationMs(from: Pos, to: Pos): number {
  const tiles = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.max(MIN_WALK_MS, Math.round((tiles / walkSpeed()) * 1000));
}

/**
 * Поколение текущего перемещения агента — новый вызов walkTo() отменяет ещё
 * не доигранные отрезки прежнего (например, агент шёл на кухню, а его тут же
 * позвали на совещание): stepWalk сверяется со своим поколением и молча
 * останавливается, если оно устарело.
 */
const walkGen = new Map<string, number>();

/**
 * Один отрезок пути: переносит агента в точку и через вычисленную по длине
 * отрезка длительность зовёт следующий. Саму визуальную интерполяцию между
 * точками рисует WAAPI-анимация в Office.tsx, а не CSS-переход, — здесь
 * только тайминг и данные (позиция + длительность), как и положено логике
 * ходьбы в сторе.
 */
function stepWalk(instanceId: string, waypoints: Pos[], i: number, gen: number): void {
  if (walkGen.get(instanceId) !== gen) return;
  if (i >= waypoints.length) return;
  const ms = legDurationMs(waypoints[i - 1], waypoints[i]);
  useStore.setState((s) => ({ pos: { ...s.pos, [instanceId]: { ...waypoints[i], ms } } }));
  if (i + 1 < waypoints.length) {
    setTimeout(() => stepWalk(instanceId, waypoints, i + 1, gen), ms);
  }
}

/**
 * Ведёт агента к точке по ломаной из findPath (§7 спеки), отрезок за
 * отрезком, вместо прыжка по прямой. Сетка проходимости берётся из кэша
 * `passabilityFor` — считается один раз на раскладку, не на каждый шаг.
 * Если пути нет (изолированная зона, начальная или конечная клетка заняты)
 * или начальная позиция агента ещё не известна — ведёт себя предсказуемо:
 * идёт напрямую, как до этого этапа, а не зависает и не телепортируется.
 */
function walkTo(instanceId: string, target: Pos): void {
  const gen = (walkGen.get(instanceId) ?? 0) + 1;
  walkGen.set(instanceId, gen);
  const s = useStore.getState();
  const current = s.pos[instanceId];
  if (!current) {
    useStore.setState((st) => ({ pos: { ...st.pos, [instanceId]: { ...target, ms: 0 } } }));
    return;
  }
  const grid = passabilityFor(s.layout);
  const path = findPath(grid, current, target);
  const waypoints = path ?? [current, target];
  stepWalk(instanceId, waypoints, 1, gen);
}

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
}

/** Считает сводку по офису из списка `offices` для короткого переключателя. */
export function summarizeOfficeActivity(o: OfficeView): OfficeActivitySummary {
  const a = o.activity;
  if (!a) return { text: 'нет данных', live: false, hasQueue: false, hasUnmerged: false, waiting: 0 };
  const parts: string[] = [];
  if (a.inProgress > 0) parts.push(`${a.inProgress} в работе`);
  if (a.doneUnmerged > 0) parts.push(`${a.doneUnmerged} к слиянию`);
  const text = parts.length ? parts.join(' · ') : (a.live ? 'идёт работа' : 'простаивает');
  return { text, live: a.live, hasQueue: a.inProgress > 0, hasUnmerged: a.doneUnmerged > 0, waiting: a.waiting };
}

/** Четыре уровня общего режима доступа офиса — id, подпись и честное объяснение для UI. */
export const ACCESS_MODES: Array<[PermissionMode, string, string]> = [
  ['readonly', 'Только чтение', 'Запрещено всё, что меняет состояние: ни записи файла, ни команды оболочки.'],
  ['ask-writes', 'Спрашивать про все изменения', 'Любая запись файла и любая команда оболочки требует подтверждения.'],
  ['ask-risky', 'Спрашивать про необратимое', 'Подтверждение только для удаления, push и других необратимых действий.'],
  ['auto', 'Полный доступ', 'Ничего не спрашивать — включая необратимые действия.'],
];

export const ACCESS_LABEL: Record<PermissionMode, string> = {
  readonly: 'только чтение',
  'ask-writes': 'спрашивать про все изменения',
  'ask-risky': 'спрашивать про необратимое',
  auto: 'полный доступ',
};

/** Честный текст подтверждения перед включением полного доступа — офисного или ролевого. */
export const FULL_ACCESS_WARNING = 'Агенты смогут выполнять необратимые действия — удалять файлы, '
  + 'пушить в репозиторий, выполнять произвольные команды — вообще без вопросов. Включить полный доступ?';

/** Режим роли, если он задан явно, иначе общий режим офиса. */
export function effectivePermissionMode(
  role: { permissionMode: PermissionMode | null },
  settings: Settings,
): PermissionMode {
  return role.permissionMode ?? settings.officePermissionMode;
}

/** Откуда фактический режим доступа сотрудника: свой, от роли или от офиса. */
export type PermissionSource = 'agent' | 'role' | 'office';

export const PERMISSION_SOURCE_LABEL: Record<PermissionSource, string> = {
  agent: 'личный',
  role: 'от роли',
  office: 'от офиса',
};

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

/** Стадии конвейера ревью на языке интерфейса. */
export const PR_STAGE_LABEL: Record<PrStage, string> = {
  sync: 'подтягиваю main',
  checks: 'проверки',
  opening: 'открываю PR',
  review: 'на ревью',
  rework: 'доработка',
  merging: 'вливаю',
  merged: 'влито',
  stuck: 'встало',
};

/** Цвет стадии: зелёный — доехало, красный — встало, остальное в работе. */
export const prStageClass = (stage: PrStage): string =>
  (stage === 'merged' ? 'merged' : stage === 'stuck' ? 'conflict' : 'checking');

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
      error: `Целое число от ${MIN_TASK_MAX_TURNS} до ${MAX_TASK_MAX_TURNS} или пусто — без ограничения`,
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
      error: `Целое число от ${MIN_OFFICE_WORKERS} до ${MAX_OFFICE_WORKERS}`,
    };
  }
  return { value: n, error: null };
}

/** Личный режим доступа сотрудника; null — вернуть к режиму роли. */
export function setAgentPermission(instanceId: string, mode: PermissionMode | null): void {
  socket?.send(JSON.stringify({ c: 'agent_permission', instanceId, mode }));
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

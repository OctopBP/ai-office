/**
 * План офиса: фичи, их порядок и раздача задач по мере готовности.
 *
 * Зачем это отдельно от менеджера. Раньше весь порядок работ жил в голове PM:
 * он резал просьбу на задачи и раздавал их все подряд. На одной просьбе это
 * работало, на трёх больших фичах — нет: офис хватался за всё сразу, ветки
 * расходились, а сам план существовал только в сессии менеджера и исчезал
 * вместе с ней (роли сменили — сессия перезапущена, сервер перезапустили —
 * тем более).
 *
 * Поэтому обязанности разделены:
 * - менеджер РЕШАЕТ — режет фичу на задачи, ставит порядок и зависимости.
 *   Это то, чего код не умеет;
 * - офис ИСПОЛНЯЕТ — держит план на доске и сам отдаёт задачу, как только она
 *   готова и есть кому её взять. Это то, чего не умеет модель: она не
 *   просыпается в нужную минуту и не помнит, кто освободился.
 *
 * Отсюда же и ответ на «бэкенд закрыл свои задачи по фиче — что дальше»:
 * никто никого не переключает. Освободился исполнитель — офис ищет самую
 * раннюю готовую задачу его роли, и если в текущей фиче таких нет, берёт из
 * следующей (насколько позволяет Settings.focusEpics).
 *
 * Спринтов-таймбоксов здесь нет намеренно: инкремент закрывается по факту
 * («все задачи фичи в основной ветке»), а не по календарю.
 */
import { dayKey, HEALTH_DIRECTION, OFFICE_SENDER, taskClosed } from '../shared/types';
import { toTaskView, type Epic, type OfficeState, type Task } from './state';
import type { TaskType } from '../shared/workflow';
import { recordOutcome } from './outcomes';

// ------------------------------------------------------------ инициативы

/** Минимальный недельный запас на своё, чтобы простаивающий офис мог за собой следить. */
const MIN_WEEKLY_ALLOWANCE_USD = 1;

export interface InitiativeBudget {
  /** Потрачено на инициативы (без здоровья проекта) за неделю. */
  spentUsd: number;
  /** Весь расход офиса за неделю. */
  totalUsd: number;
  /** Сколько на своё можно: доля от всего, но не меньше минимального запаса. */
  allowedUsd: number;
  exhausted: boolean;
}

/**
 * Доля на своё (docs/design/living-office/spec.md §7.4). Считается по
 * журналам расхода задач за последние семь дней: инициатива узнаётся по
 * фиче задачи. Минимальный запас нужен, чтобы офис, которому владелец
 * неделю ничего не давал, не оказался заперт нулём: пятая часть от нуля —
 * это ноль.
 */
export function initiativeBudget(state: OfficeState, now = Date.now()): InitiativeBudget {
  const days: string[] = [];
  for (let i = 0; i < 7; i += 1) days.push(dayKey(now - i * 86_400_000));
  let spent = 0;
  for (const task of state.tasks.values()) {
    const epic = task.epicId ? state.epics.get(task.epicId) : null;
    if (!epic || epic.origin !== 'office' || epic.directionId === HEALTH_DIRECTION) continue;
    for (const day of days) spent += task.daily?.[day]?.costUsd ?? 0;
  }
  let total = 0;
  for (const day of days) total += state.daily[day]?.costUsd ?? 0;
  const allowed = Math.max(MIN_WEEKLY_ALLOWANCE_USD, total * state.initiativeShare());
  return { spentUsd: spent, totalUsd: total, allowedUsd: allowed, exhausted: spent >= allowed };
}

/**
 * Живые агенты офиса глазами плана. Настоящую реализацию ставит agents.ts при
 * загрузке, проверки подменяют своей.
 *
 * Через реестр, а не прямым импортом, намеренно: план зовут отовсюду —
 * и запуск задач, и конвейер ревью, и надзор, — а импортируй он их в ответ,
 * модули замкнулись бы друг на друга.
 */
export interface PlanAgents {
  assign(state: OfficeState, taskId: string): { ok: boolean; message: string };
  notifyPm(state: OfficeState, text: string): void;
}

let agents: PlanAgents = {
  assign: () => ({ ok: false, message: '' }),
  notifyPm() { /* до подъёма офиса сообщать некому */ },
};

export function setPlanAgents(next: PlanAgents): void {
  agents = next;
}

/** Задача доведена до конца по правилу офиса — оно одно на всех (§types). */
const closed = (state: OfficeState, task: Task): boolean =>
  taskClosed(toTaskView(task), state.settings.autoPipeline);

/** Расход по всем задачам фичи. Считается, а не хранится: слагаемые уже есть. */
export const epicCost = (state: OfficeState, epicId: string): number =>
  state.tasksOfEpic(epicId).reduce((sum, t) => sum + t.usage.costUsd, 0);

/**
 * Готова ли плановая задача к раздаче: всё, от чего она зависит, уже в
 * основной ветке. Возвращает id задач, которых она ждёт, — пустой список
 * значит «можно отдавать». Не найденную зависимость (задачу удалили или
 * менеджер сослался на несуществующий id) считаем выполненной: держать
 * работу из-за опечатки хуже, чем начать её чуть раньше.
 */
export function waitingFor(state: OfficeState, task: Task): string[] {
  return (task.dependsOn ?? []).filter((id) => {
    const dep = state.tasks.get(id);
    return dep ? !closed(state, dep) : false;
  });
}

/**
 * Одна фича закончилась. Считается по задачам, а не по отметке менеджера:
 * «готово» — это когда работа в основной ветке, а не когда о ней отчитались.
 * Фича без задач не закрывается никогда: закрывать в ней нечего, и молчаливое
 * «готово» на пустом месте выглядело бы как успех, которого не было.
 */
function closeFinishedEpics(state: OfficeState): void {
  for (const epic of state.epicList()) {
    if (epic.status !== 'active') continue;
    const tasks = state.tasksOfEpic(epic.id);
    if (!tasks.length || !tasks.every((t) => closed(state, t))) continue;

    state.updateEpic(epic.id, { status: 'done', finishedAt: Date.now(), attention: null });
    const spent = epicCost(state, epic.id).toFixed(2);
    state.addChat(OFFICE_SENDER, state.say('plan.chat.epicDone', {
      epic: epic.id, title: epic.title, spent,
    }));

    // Менеджеру — не поздравление, а работа: сказать человеку, что можно
    // проверить, и (если офис ждёт согласия) спросить про следующую фичу.
    const next = nextUnstarted(state);
    agents.notifyPm(state, state.say('plan.pm.epicDone', {
      epic: epic.id, title: epic.title, goal: epic.goal, spent,
      tasks: tasks.map((t) => `${t.id} «${t.title}»`).join(', '),
      next: next
        ? state.say(next.approved ? 'plan.pm.nextAuto' : 'plan.pm.nextWaits', {
          epic: next.id, title: next.title,
        })
        : state.say('plan.pm.nextNone'),
    }));
  }
}

/** Ближайшая фича, за которую офис ещё не брался. */
const nextUnstarted = (state: OfficeState): Epic | null =>
  state.epicList().find((e) => e.status === 'planned') ?? null;

/**
 * Взять в работу столько фич, сколько позволяет настройка фокуса.
 *
 * Несогласованную фичу обход пропускает, а не упирается в неё. Порядок плана
 * решает, кого брать раньше, но только среди согласованных: согласие человека
 * — это его прямое указание «вот эту можно», и оно сильнее порядка, который
 * до него расставил менеджер. Иначе одобренная третья фича молча стояла бы за
 * второй, которую человек одобрять и не собирался.
 */
function activateEpics(state: OfficeState): void {
  const open = state.epicList().filter((e) => e.status === 'active' || e.status === 'planned');
  let active = open.filter((e) => e.status === 'active').length;
  // Долю на своё считаем один раз на проход: она не меняется, пока фичи
  // не начались, а пересчитывать журналы расходов на каждую фичу незачем.
  let budget: InitiativeBudget | null = null;

  for (const epic of open) {
    if (epic.status !== 'planned') continue;
    if (active >= state.focusLimit()) return;
    if (!epic.approved) continue;
    // Инициатива стоит, пока доля на своё исчерпана; фича владельца идёт.
    // Здоровье проекта — обязанность, а не инициатива: в долю не входит.
    if (epic.origin === 'office' && epic.directionId !== HEALTH_DIRECTION) {
      budget ??= initiativeBudget(state);
      if (budget.exhausted) {
        if (!epic.attention) {
          state.updateEpic(epic.id, { attention: Date.now() });
          state.addLog(null, 'system', state.say('initiative.shareLog', {
            spent: budget.spentUsd.toFixed(2), allowed: budget.allowedUsd.toFixed(2),
            share: Math.round(state.initiativeShare() * 100), total: budget.totalUsd.toFixed(2),
          }));
        }
        continue;
      }
    }
    state.updateEpic(epic.id, { status: 'active', startedAt: Date.now(), attention: null });
    active += 1;
    state.addChat(OFFICE_SENDER,
      state.say('plan.chat.epicActive', { epic: epic.id, title: epic.title }));
    state.addLog(null, 'system',
      state.say('plan.log.epicActive', { epic: epic.id, title: epic.title }));
  }
}

/**
 * Отдать в работу всё, что созрело. Порядок обхода — порядок плана: сначала
 * ранняя фича, внутри неё — задачи по своему порядку. Именно здесь и
 * происходит переход исполнителя к следующей фиче: своей роли он не меняет,
 * просто в ранней фиче для неё готовых задач больше нет.
 *
 * Раздаём сразу, а не оставляем задачу ждать надзора: тот заводит стоящую
 * задачу только через четверть часа — это запас на раздумья менеджера, а
 * плановую задачу обдумывать уже не надо, её порядок решён заранее.
 */
function releaseReady(state: OfficeState): void {
  const active = new Set(
    state.epicList().filter((e) => e.status === 'active').map((e) => e.id));

  const queue = [...state.tasks.values()]
    .filter((t) => t.status === 'planned')
    // Задача вне плана в статусе planned ничьей очереди не ждёт: её держат
    // только собственные зависимости.
    .filter((t) => t.epicId === null || active.has(t.epicId))
    .sort((a, b) => epicOrder(state, a) - epicOrder(state, b)
      || a.order - b.order || a.createdAt - b.createdAt);

  for (const task of queue) {
    if (waitingFor(state, task).length) continue;
    state.updateTask(task.id, { status: 'backlog', attention: null });
    state.addLog(null, 'system', state.say('plan.log.released', {
      task: task.id, title: task.title,
      epic: task.epicId ?? state.say('plan.noEpic'),
    }));
    // Отказ (нет слота, некому взять, кончился бюджет) не ошибка плана:
    // задача остаётся в очереди на доске и поедет сама — за этим следят
    // очередь за слотом и надзор.
    agents.assign(state, task.id);
  }
}

/** Место фичи задачи в плане. Задача вне плана идёт первой: её никто не ждёт. */
const epicOrder = (state: OfficeState, task: Task): number =>
  (task.epicId ? state.epics.get(task.epicId)?.order ?? 0 : -1);

/**
 * Работа встала, и сама она не поедет. Два случая, и оба — про человека или
 * менеджера, а не про повтор через минуту:
 *
 * - план упёрся в несогласованную фичу, а делать больше нечего;
 * - плановая задача ждёт зависимость, которая провалилась.
 *
 * Про каждое говорим ровно один раз (`attention`) — напоминание раз в минуту
 * это шум, из-за которого перестают читать и остальные сообщения.
 */
function reportStalls(state: OfficeState, now: number): void {
  const tasks = [...state.tasks.values()];
  const working = tasks.some((t) => (
    t.status === 'assigned' || t.status === 'in_progress' || t.status === 'review'
    || t.status === 'backlog'));

  // 1. Ждём «поехали», и больше в офисе ничего не происходит.
  const next = nextUnstarted(state);
  if (next && !next.approved && !working && !next.attention) {
    state.updateEpic(next.id, { attention: now });
    state.addChat(OFFICE_SENDER,
      state.say('plan.chat.waiting', { epic: next.id, title: next.title }));
    agents.notifyPm(state, state.say('plan.pm.waiting', {
      epic: next.id, title: next.title, goal: next.goal,
      tasks: String(state.tasksOfEpic(next.id).length),
    }));
  }

  // 2. Зависимость провалилась — сама она не починится.
  for (const task of tasks) {
    if (task.status !== 'planned' || task.attention) continue;
    const dead = waitingFor(state, task)
      .map((id) => state.tasks.get(id))
      .filter((dep): dep is Task => dep?.status === 'failed');
    if (!dead.length) continue;
    state.updateTask(task.id, { attention: now });
    agents.notifyPm(state, state.say('plan.pm.blocked', {
      task: task.id, title: task.title,
      deps: dead.map((d) => `${d.id} «${d.title}»`).join(', '),
    }));
  }
}

/**
 * Один проход планировщика. Идемпотентен и дёшев — зовётся отовсюду, где
 * картина мира могла измениться: завершилась задача, влилась ветка, человек
 * согласовал фичу, тикнул надзор.
 */
export function dispatch(state: OfficeState): void {
  if (state.paused) return;
  const now = Date.now();
  closeFinishedEpics(state);
  activateEpics(state);
  releaseReady(state);
  reportStalls(state, now);
}

// ---------------------------------------------------------------- заведение

/** Задача плана глазами менеджера — то, что приходит из plan_features. */
export interface PlannedTask {
  /** Короткий ключ внутри плана: на него ссылаются зависимости соседей. */
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  roleId: string;
  /** Ключи задач этого же плана либо id уже заведённых задач. */
  dependsOn?: string[];
  /** Тип работы (spec процессов §7.2). Пусто — по роли. */
  type?: TaskType | '';
}

export interface PlannedEpic {
  title: string;
  goal: string;
  tasks: PlannedTask[];
}

export interface PlanResult {
  ok: boolean;
  /** Готовый к показу текст: план или причина отказа. */
  message: string;
}

/**
 * Завести план целиком: фичи, их задачи и связи между ними.
 *
 * Одним вызовом, а не по задаче за раз, намеренно: план проверяется целиком
 * (ссылки, циклы, роли) и ложится на доску целиком. Половина плана на доске —
 * это офис, который начал работать не по плану, а по его обрывку.
 */
export interface PlanOrigin {
  origin: 'owner' | 'office';
  rationale: string;
  directionId: string | null;
  /**
   * Согласие проставить сразу, минуя настройку planApproval. Нужно
   * инициативам: там согласие решает режим инициативы, а не общий порядок.
   */
  approved?: boolean;
}

export function createPlan(state: OfficeState, epics: PlannedEpic[], from?: PlanOrigin): PlanResult {
  if (!epics.length) return { ok: false, message: state.say('plan.err.empty') };

  const roles = state.workerRoles().map((r) => r.id);
  const keys = new Map<string, string>();          // ключ плана → будущий id задачи
  const seen = new Set<string>();

  // Проверяем всё до единой правки на доске: отказ на полпути оставил бы
  // половину плана заведённой, а менеджер считал бы, что не завёл ничего.
  for (const epic of epics) {
    if (!epic.title.trim()) return { ok: false, message: state.say('plan.err.noTitle') };
    if (!epic.tasks.length) {
      return { ok: false, message: state.say('plan.err.noTasks', { title: epic.title }) };
    }
    for (const task of epic.tasks) {
      const key = task.key.trim();
      if (!key) return { ok: false, message: state.say('plan.err.noKey', { title: task.title }) };
      if (seen.has(key)) return { ok: false, message: state.say('plan.err.dupKey', { key }) };
      seen.add(key);
      if (!roles.includes(task.roleId)) {
        return {
          ok: false,
          message: state.say('plan.err.badRole', { role: task.roleId, valid: roles.join(', ') }),
        };
      }
      if (!task.acceptanceCriteria.some((c) => c.trim())) {
        return { ok: false, message: state.say('plan.err.noCriteria', { title: task.title }) };
      }
    }
  }

  // Ссылки разбираем вторым проходом: задача вправе зависеть от той, что
  // описана ниже неё, — план читается сверху вниз, а связи в нём любые.
  for (const epic of epics) {
    for (const task of epic.tasks) {
      for (const dep of task.dependsOn ?? []) {
        if (!seen.has(dep) && !state.tasks.has(dep)) {
          return { ok: false, message: state.say('plan.err.noDep', { key: task.key, dep }) };
        }
      }
    }
  }

  const cycle = findCycle(epics);
  if (cycle) return { ok: false, message: state.say('plan.err.cycle', { chain: cycle.join(' → ') }) };

  // Проверки пройдены — заводим. Порядок фич продолжает уже существующий
  // план, а не начинается заново: новая фича встаёт в конец очереди, а не
  // впереди той, которую офис уже ведёт.
  const approved = from?.approved ?? !state.needsApproval();
  let order = state.epicList().length;
  const made: Epic[] = [];

  for (const planned of epics) {
    order += 1;
    const epic = state.createEpic({
      title: planned.title.trim(), goal: planned.goal.trim(), order, approved,
      origin: from?.origin ?? 'owner', rationale: from?.rationale ?? '',
      directionId: from?.directionId ?? null,
    });
    made.push(epic);
    planned.tasks.forEach((task, i) => {
      const created = state.createTask({
        title: task.title,
        description: task.description,
        criteria: task.acceptanceCriteria.map((c) => c.trim()).filter(Boolean),
        roleId: task.roleId,
        epicId: epic.id,
        order: i + 1,
        dependsOn: [],
        status: 'planned',
        ...(task.type ? { type: task.type } : {}),
      });
      keys.set(task.key.trim(), created.id);
    });
  }

  // Зависимости проставляем, когда id известны все: ключ мог указывать на
  // задачу, которую заводят позже.
  for (const planned of epics) {
    for (const task of planned.tasks) {
      const id = keys.get(task.key.trim());
      if (!id) continue;
      const deps = (task.dependsOn ?? [])
        .map((dep) => keys.get(dep) ?? dep)
        .filter((dep) => dep !== id);
      if (deps.length) state.updateTask(id, { dependsOn: deps });
    }
  }

  dispatch(state);
  return { ok: true, message: planSummary(state) };
}

/**
 * Цикл в зависимостях внутри плана. Ищем до заведения: круг «A ждёт B, B ждёт
 * A» на доске не проявится ошибкой — обе задачи просто не начнутся никогда, и
 * искать причину будет некому.
 */
function findCycle(epics: PlannedEpic[]): string[] | null {
  const edges = new Map<string, string[]>();
  for (const epic of epics) {
    for (const task of epic.tasks) {
      edges.set(task.key.trim(), (task.dependsOn ?? []).map((d) => d.trim()));
    }
  }
  const state = new Map<string, 'open' | 'closed'>();
  const path: string[] = [];

  const walk = (key: string): string[] | null => {
    if (state.get(key) === 'closed') return null;
    if (state.get(key) === 'open') return [...path.slice(path.indexOf(key)), key];
    state.set(key, 'open');
    path.push(key);
    for (const next of edges.get(key) ?? []) {
      // Ссылка на уже заведённую задачу циклом быть не может: та ничего
      // из этого плана не ждёт.
      if (!edges.has(next)) continue;
      const found = walk(next);
      if (found) return found;
    }
    path.pop();
    state.set(key, 'closed');
    return null;
  };

  for (const key of edges.keys()) {
    const found = walk(key);
    if (found) return found;
  }
  return null;
}

// ------------------------------------------------------------- вмешательство

/** «Поехали» по фиче — от человека кнопкой или от менеджера инструментом. */
export function approveEpic(state: OfficeState, epicId: string): PlanResult {
  const epic = state.epics.get(epicId);
  if (!epic) return { ok: false, message: state.say('plan.err.noEpic', { epic: epicId }) };
  if (epic.status === 'done' || epic.status === 'cancelled') {
    return { ok: false, message: state.say('plan.err.epicClosed', { epic: epicId }) };
  }
  if (epic.approved) {
    return { ok: false, message: state.say('plan.err.already', { epic: epicId }) };
  }
  state.updateEpic(epicId, { approved: true, attention: null });
  state.addChat(OFFICE_SENDER,
    state.say('plan.chat.approved', { epic: epic.id, title: epic.title }));
  dispatch(state);
  const fresh = state.epics.get(epicId);
  return {
    ok: true,
    message: state.say(fresh?.status === 'active' ? 'plan.ok.started' : 'plan.ok.queued', {
      epic: epic.id, title: epic.title, focus: state.focusLimit(),
    }),
  };
}

/**
 * Снять фичу с плана. Её незапущенные задачи остаются на доске серыми, а не
 * стираются: по ним видно, от чего отказались, — а стёртая фича выглядит так,
 * будто её и не планировали.
 */
export function cancelEpic(state: OfficeState, epicId: string, reason: string): PlanResult {
  const epic = state.epics.get(epicId);
  if (!epic) return { ok: false, message: state.say('plan.err.noEpic', { epic: epicId }) };
  if (epic.status === 'done') {
    return { ok: false, message: state.say('plan.err.epicDone', { epic: epicId }) };
  }
  state.updateEpic(epicId, { status: 'cancelled', finishedAt: Date.now(), attention: null });
  // Незапущенные задачи снятой фичи закрываются исходом «снята»: они больше
  // не начнутся, и табелю роли это важно не меньше, чем провал.
  for (const task of state.tasksOfEpic(epicId)) {
    if (task.status === 'planned' || task.status === 'backlog') recordOutcome(state, task.id, 'cancelled');
  }
  state.addChat(OFFICE_SENDER, state.say('plan.chat.cancelled', {
    epic: epic.id, title: epic.title, reason: reason.trim() || state.say('plan.noReason'),
  }));
  dispatch(state);
  return { ok: true, message: state.say('plan.ok.cancelled', { epic: epic.id, title: epic.title }) };
}

/**
 * Переставить фичи. Порядок задаётся списком целиком, а не сдвигом одной:
 * «подними F-3 повыше» — это всегда вопрос «выше кого именно», и отвечать на
 * него должен тот, кто переставляет, а не догадка офиса.
 */
export function reorderEpics(state: OfficeState, ids: string[]): PlanResult {
  const known = state.epicList();
  const unknown = ids.filter((id) => !state.epics.has(id));
  if (unknown.length) {
    return { ok: false, message: state.say('plan.err.noEpic', { epic: unknown.join(', ') }) };
  }
  let order = 0;
  for (const id of ids) {
    order += 1;
    state.updateEpic(id, { order });
  }
  // Неназванные фичи уезжают следом, сохраняя свой относительный порядок:
  // назвать все каждый раз — лишняя работа и лишний повод ошибиться.
  for (const epic of known) {
    if (ids.includes(epic.id)) continue;
    order += 1;
    state.updateEpic(epic.id, { order });
  }
  dispatch(state);
  return { ok: true, message: planSummary(state) };
}

// ------------------------------------------------------------------- отчёт

/**
 * План словами — то, что менеджер видит в get_board, а через него и человек.
 * Здесь же видно, чего каждая задача ждёт: без этого «почему ничего не
 * происходит» остаётся без ответа.
 */
export function planSummary(state: OfficeState): string {
  const epics = state.epicList();
  if (!epics.length) return '';

  const lines = epics.map((epic) => {
    const tasks = state.tasksOfEpic(epic.id);
    const done = tasks.filter((t) => closed(state, t)).length;
    const head = `${epic.id} [${state.say(`plan.status.${epic.status}`)}]`
      + `${epic.status === 'planned' && !epic.approved ? ` ${state.say('plan.needsOk')}` : ''}`
      + ` ${epic.title} — ${epic.goal}`;
    const stat = state.say('plan.progress', {
      done, total: tasks.length, spent: epicCost(state, epic.id).toFixed(2),
    });
    const rows = tasks.map((task) => {
      const wait = waitingFor(state, task);
      const tail = wait.length ? ` ${state.say('plan.waitsFor', { deps: wait.join(', ') })}` : '';
      return `    ${task.id} [${task.status}] ${task.title} → ${task.roleId ?? '—'}${tail}`;
    });
    return [`${head}\n    ${stat}`, ...rows].join('\n');
  });

  return `${state.say('plan.header', { focus: state.focusLimit() })}\n${lines.join('\n')}`;
}

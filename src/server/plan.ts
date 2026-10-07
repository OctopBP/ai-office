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
import { asTaskPriority, dayKey, HEALTH_DIRECTION, taskClosed, taskOver } from '../shared/types';
import type { EpicHold, TaskPriority } from '../shared/types';
import { toTaskView, type Epic, type OfficeState, type PmAbout, type Task } from './state';
import type { TaskType } from '../shared/workflow';
import { cancelTask } from './outcomes';

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
  /** `about` — задача или фича: по ней выбирается чат, в сессию которого уйдёт сообщение. */
  notifyPm(state: OfficeState, text: string, about?: PmAbout): void;
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

/**
 * Задача больше не поедет: доведена до конца или снята. Закрытие фичи идёт по
 * этому правилу, а готовность зависимостей — по `closed`: снятая задача
 * результата не оставляет, и ждать её нельзя, но и держать из-за неё фичу
 * открытой навсегда тоже.
 */
const over = (state: OfficeState, task: Task): boolean =>
  taskOver(toTaskView(task), state.settings.autoPipeline);

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
 * Задача не начнётся никогда сама: провалена, снята или ждёт такую — в том
 * числе через цепочку («ждёт ту, что ждёт проваленную»). `seen` бережёт от
 * круга в зависимостях: круг тоже никогда не начнётся, и это тот же ответ.
 */
function dead(state: OfficeState, task: Task, seen = new Set<string>()): boolean {
  if (task.status === 'failed' || task.status === 'cancelled') return true;
  if (task.status !== 'planned') return false;
  if (seen.has(task.id)) return true;
  seen.add(task.id);
  return waitingFor(state, task).some((id) => {
    const dep = state.tasks.get(id);
    return !!dep && dead(state, dep, seen);
  });
}

/**
 * Задача ещё может дать фиче результат: идёт, ждёт слияния или может
 * начаться. Проваленная — нет: её перезапускают или снимают руками, и пока
 * этого не сделали, она не работа, а вопрос к человеку.
 */
const alive = (state: OfficeState, task: Task): boolean =>
  !over(state, task) && !dead(state, task);

/**
 * Держит ли активная фича место в фокусе. Только если в ней осталась живая
 * работа. Раньше место держала любая фича в статусе active — и фича, где всё
 * влито, кроме одной проваленной задачи, не закрывалась (провал не «конец»)
 * и не отдавала место никогда. Два таких хвоста при фокусе в два — и план
 * стоит целиком, хотя исполнители свободны (T-354).
 */
export const holdsSlot = (state: OfficeState, epic: Epic): boolean =>
  epic.status === 'active' && state.tasksOfEpic(epic.id).some((t) => alive(state, t));

/** Задача фактически движется: в работе, на ревью или ждёт слияния. */
const moving = (state: OfficeState, task: Task): boolean =>
  task.status !== 'planned' && task.status !== 'failed' && !over(state, task);

/**
 * Записать причину простоя фичи. Только при смене: тогда же она и уходит
 * в ленту — одной строкой на смену, а не строкой на каждый тик.
 */
function setHold(state: OfficeState, epic: Epic, hold: EpicHold | null): void {
  if (JSON.stringify(epic.hold ?? null) === JSON.stringify(hold)) return;
  state.updateEpic(epic.id, { hold });
  if (!hold || hold.kind === 'approval') return;   // про согласие говорит reportStalls
  state.addLog(null, 'system', state.say('plan.log.hold', {
    epic: epic.id, title: epic.title, why: holdText(state, hold),
  }));
  if (hold.kind === 'stuck') {
    // Сама такая фича не сдвинется — это вопрос к человеку и менеджеру.
    state.addOfficeNote(state.say('plan.chat.stuck', {
      epic: epic.id, title: epic.title, tasks: hold.tasks.join(', '),
    }), { epicId: epic.id });
    agents.notifyPm(state, state.say('plan.pm.stuck', {
      epic: epic.id, title: epic.title, tasks: hold.tasks.join(', '),
    }), { epicId: epic.id });
  }
}

/** Причина простоя словами — для ленты, чата и плана менеджера. */
export function holdText(state: OfficeState, hold: EpicHold): string {
  switch (hold.kind) {
    case 'approval': return state.say('plan.hold.approval');
    case 'slot': return state.say('plan.hold.slot', { epics: hold.epics.join(', ') });
    case 'share': return state.say('plan.hold.share');
    case 'tasks': return state.say('plan.hold.tasks', { tasks: hold.tasks.join(', ') });
    case 'stuck': return state.say('plan.hold.stuck', { tasks: hold.tasks.join(', ') });
    case 'unstaffed': return state.say('plan.hold.unstaffed', { tasks: hold.tasks.join(', ') });
  }
}

/**
 * Вес приоритета при выборе: меньше — раньше. Отдельной таблицей, а не
 * позицией в TASK_PRIORITIES, чтобы новый уровень в середине списка не
 * переставил молча всю очередь офиса.
 */
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

/** Вес задачи. Задачи, которой уже нет на доске, — средний: её всё равно выкинут. */
export const priorityRank = (task: Task | undefined): number =>
  PRIORITY_RANK[asTaskPriority(task?.priority)];

/**
 * Сравнение задач по важности: сначала высокие. Равный приоритет даёт ноль —
 * и прежний порядок (сначала старые) сохраняется сам: сортировка в JS
 * стабильна, а значит, приоритет только поднимает важное, а не перетасовывает
 * всё остальное.
 *
 * Это выбор «что взять следующим», а не право обойти правила: зависимости,
 * фокус на числе фич и порядок самих фич считаются раньше и сильнее.
 */
export const byPriority = (a: Task, b: Task): number => priorityRank(a) - priorityRank(b);

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
    if (!tasks.length || !tasks.every((t) => over(state, t))) continue;

    // Фича, в которой всё сняли, закончилась не успехом: доводить в ней было
    // нечего. Говорить про такую «готово» — врать в ленте и в табеле.
    if (!tasks.some((t) => closed(state, t))) {
      state.updateEpic(epic.id, { status: 'cancelled', finishedAt: Date.now(), attention: null });
      state.addOfficeNote(state.say('plan.chat.epicEmpty', {
        epic: epic.id, title: epic.title,
      }), { epicId: epic.id });
      agents.notifyPm(state, state.say('plan.pm.epicEmpty', { epic: epic.id, title: epic.title }), { epicId: epic.id });
      continue;
    }

    state.updateEpic(epic.id, { status: 'done', finishedAt: Date.now(), attention: null });
    const spent = epicCost(state, epic.id).toFixed(2);
    state.addOfficeNote(state.say('plan.chat.epicDone', {
      epic: epic.id, title: epic.title, spent,
    }), { epicId: epic.id });

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
    }), { epicId: epic.id });
  }
}

/**
 * Режим инициативы «начинать самому» (auto): офис не ждёт «поехали» ни по
 * своим фичам, ни по фичам владельца из плана менеджера. Так решил владелец
 * (Q-96): режим auto — это согласие на весь план, а не только на своё.
 */
export const autoApproves = (state: OfficeState): boolean => state.initiativeMode() === 'auto';

/**
 * Проставить согласие фичам, которые ждут «поехали», если режим auto.
 * Ловит и заведённые до включения режима, и пережившие перезапуск сервера:
 * зовётся на каждом проходе планировщика, а он идёт и по тику надзора.
 * Согласие — только допуск в очередь: место в фокусе, доля на своё и
 * зависимости задач считаются дальше как обычно.
 */
function approveInAuto(state: OfficeState): void {
  if (!autoApproves(state)) return;
  for (const epic of state.epicList()) {
    if (epic.status !== 'planned' || epic.approved) continue;
    state.updateEpic(epic.id, { approved: true, attention: null, hold: null });
    state.addLog(null, 'system', state.say('plan.log.autoApproved', { epic: epic.id, title: epic.title }));
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
  // Место считаем по фичам с живой работой, а не по статусу active: см.
  // holdsSlot. Список, а не число, — им же объясняем, кого ждёт очередь.
  const holders = state.epicList().filter((e) => holdsSlot(state, e)).map((e) => e.id);
  // Долю на своё считаем один раз на проход: она не меняется, пока фичи
  // не начались, а пересчитывать журналы расходов на каждую фичу незачем.
  let budget: InitiativeBudget | null = null;

  for (const epic of state.epicList()) {
    if (epic.status !== 'planned') continue;
    if (!epic.approved) {
      setHold(state, epic, { kind: 'approval' });
      continue;
    }
    if (holders.length >= state.focusLimit()) {
      setHold(state, epic, { kind: 'slot', epics: [...holders] });
      continue;
    }
    // Инициатива стоит, пока доля на своё исчерпана; фича владельца идёт.
    // Здоровье проекта — обязанность, а не инициатива: в долю не входит.
    if (epic.origin === 'office' && epic.directionId !== HEALTH_DIRECTION) {
      budget ??= initiativeBudget(state);
      if (budget.exhausted) {
        if (epic.hold?.kind !== 'share') {
          state.addLog(null, 'system', state.say('initiative.shareLog', {
            spent: budget.spentUsd.toFixed(2), allowed: budget.allowedUsd.toFixed(2),
            share: Math.round(state.initiativeShare() * 100), total: budget.totalUsd.toFixed(2),
          }));
        }
        setHold(state, epic, { kind: 'share' });
        continue;
      }
    }
    state.updateEpic(epic.id, { status: 'active', startedAt: Date.now(), attention: null, hold: null });
    holders.push(epic.id);
    state.addOfficeNote(
      state.say('plan.chat.epicActive', { epic: epic.id, title: epic.title }), { epicId: epic.id });
    state.addLog(null, 'system',
      state.say('plan.log.epicActive', { epic: epic.id, title: epic.title }));
  }
}

/**
 * Причина простоя у идущих фич — после раздачи, когда уже ясно, что поехало.
 * Фича без живой работы стоит намертво (`stuck`); фича, где ничего не
 * движется, а плановое ждёт чужих задач, — ждёт их (`tasks`). У закрытых
 * причину стираем: им ждать нечего.
 */
function markActiveHolds(state: OfficeState): void {
  for (const epic of state.epicList()) {
    if (epic.status !== 'active') {
      if (epic.status !== 'planned' && epic.hold) state.updateEpic(epic.id, { hold: null });
      continue;
    }
    const tasks = state.tasksOfEpic(epic.id);
    // Фича без задач стоит не «намертво», а пустая: говорить о ней нечего.
    if (tasks.length && !tasks.some((t) => alive(state, t))) {
      setHold(state, epic, {
        kind: 'stuck',
        tasks: tasks.filter((t) => dead(state, t) && t.status !== 'cancelled').map((t) => t.id),
      });
      continue;
    }
    // Некому делать (spec подпроектов §3.3): ничего не начато, а все выпущенные
    // в очередь задачи ждут допуска к зоне. Допуск прошёл — admitGate снял
    // admitWait, и следующий проход снимет причину сам.
    const queued = tasks.filter((t) => t.status === 'backlog');
    if (queued.length && queued.every((t) => t.admitWait)
      && !tasks.some((t) => t.status !== 'backlog' && moving(state, t))) {
      setHold(state, epic, { kind: 'unstaffed', tasks: queued.map((t) => t.id) });
      continue;
    }
    if (tasks.some((t) => moving(state, t))) {
      setHold(state, epic, null);
      continue;
    }
    const awaited = new Set<string>();
    for (const task of tasks) {
      if (task.status === 'planned' && alive(state, task)) {
        for (const id of waitingFor(state, task)) awaited.add(id);
      }
    }
    setHold(state, epic, awaited.size ? { kind: 'tasks', tasks: [...awaited] } : null);
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
    // Порядок фич считается раньше приоритета: важная задача поздней фичи не
    // должна обгонять фичу, которую офис ведёт сейчас, — иначе приоритет
    // задачи тихо переставлял бы план целиком. А вот внутри уже созревшей
    // работы решает важность, и только при равной — прежний порядок.
    .sort((a, b) => epicOrder(state, a) - epicOrder(state, b)
      || byPriority(a, b) || a.order - b.order || a.createdAt - b.createdAt);

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
    state.addOfficeNote(
      state.say('plan.chat.waiting', { epic: next.id, title: next.title }), { epicId: next.id });
    agents.notifyPm(state, state.say('plan.pm.waiting', {
      epic: next.id, title: next.title, goal: next.goal,
      tasks: String(state.tasksOfEpic(next.id).length),
    }), { epicId: next.id });
  }

  // 2. Зависимость провалилась — сама она не починится.
  for (const task of tasks) {
    if (task.status !== 'planned' || task.attention) continue;
    const dead = waitingFor(state, task)
      .map((id) => state.tasks.get(id))
      .filter((dep): dep is Task => dep?.status === 'failed' || dep?.status === 'cancelled');
    if (!dead.length) continue;
    state.updateTask(task.id, { attention: now });
    agents.notifyPm(state, state.say('plan.pm.blocked', {
      task: task.id, title: task.title,
      deps: dead.map((d) => `${d.id} «${d.title}»`).join(', '),
    }), { taskId: task.id });
  }
}

/**
 * Один проход планировщика. Идемпотентен и дёшев — зовётся отовсюду, где
 * картина мира могла измениться: завершилась задача, влилась ветка, человек
 * согласовал фичу, тикнул надзор.
 */
export function dispatch(state: OfficeState): void {
  // Архив — та же остановка, что и пауза, только окончательная: по офису в
  // архиве не двигается ничего, включая планировщик.
  if (state.paused || state.archived) return;
  const now = Date.now();
  closeFinishedEpics(state);
  approveInAuto(state);
  activateEpics(state);
  releaseReady(state);
  markActiveHolds(state);
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

/**
 * `chatId` — чат с менеджером, в разговоре которого план заведён: фичи и их
 * задачи привязываются к нему (спека T-125 §2, автопривязка).
 */
export function createPlan(
  state: OfficeState, epics: PlannedEpic[], from?: PlanOrigin, chatId?: string | null,
): PlanResult {
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
  // В режиме auto фича владельца согласована сразу, как и своя (Q-96).
  const approved = autoApproves(state) || (from?.approved ?? !state.needsApproval());
  let order = state.epicList().length;
  const made: Epic[] = [];

  for (const planned of epics) {
    order += 1;
    const epic = state.createEpic({
      title: planned.title.trim(), goal: planned.goal.trim(), order, approved,
      origin: from?.origin ?? 'owner', rationale: from?.rationale ?? '',
      directionId: from?.directionId ?? null,
      chatId: chatId ?? null,
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
        chatId: chatId ?? null,
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

  // Одна ссылка на весь план, а не по сообщению на фичу и задачу: план
  // заводится одним шагом менеджера и в ленте читается одним блоком (§5
  // docs/design/T-126/cards.md). Задачи фич карточка берёт с доски.
  state.addChatRef(made.length === 1
    ? { kind: 'epic', id: made[0].id }
    : { kind: 'plan', epicIds: made.map((e) => e.id) }, chatId);

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
    // Повторное «поехали» по стоящей фиче — не ошибка, а вопрос «почему
    // стоит». Пересчитываем и отвечаем причиной, а не «офис ведёт её сам».
    dispatch(state);
    const hold = state.epics.get(epicId)?.hold;
    return {
      ok: false,
      message: hold && epic.status === 'planned'
        ? state.say('plan.err.alreadyHeld', { epic: epicId, why: holdText(state, hold) })
        : state.say('plan.err.already', { epic: epicId }),
    };
  }
  state.updateEpic(epicId, { approved: true, attention: null });
  state.addOfficeNote(
    state.say('plan.chat.approved', { epic: epic.id, title: epic.title }), { epicId: epic.id });
  dispatch(state);
  const fresh = state.epics.get(epicId);
  if (fresh?.status === 'active') {
    return {
      ok: true,
      message: state.say('plan.ok.started', { epic: epic.id, title: epic.title, focus: state.focusLimit() }),
    };
  }
  // Согласована, но не пошла. Молча стоять нельзя: щелчок по кнопке ответа
  // в чат не возвращает, поэтому причину говорим в ленту сами.
  const why = fresh?.hold ? holdText(state, fresh.hold) : state.say('plan.hold.unknown');
  state.addOfficeNote(
    state.say('plan.chat.queued', { epic: epic.id, title: epic.title, why }), { epicId: epic.id });
  return {
    ok: true,
    message: state.say('plan.ok.queued', {
      epic: epic.id, title: epic.title, focus: state.focusLimit(), why,
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
    if (task.status === 'planned' || task.status === 'backlog') cancelTask(state, task);
  }
  state.addOfficeNote(state.say('plan.chat.cancelled', {
    epic: epic.id, title: epic.title, reason: reason.trim() || state.say('plan.noReason'),
  }), { epicId: epic.id });
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
      + ` ${epic.title} — ${epic.goal}`
      + (epic.hold && epic.hold.kind !== 'approval' ? ` (${holdText(state, epic.hold)})` : '');
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

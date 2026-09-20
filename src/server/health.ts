/**
 * Сводка здоровья офиса: три беды, которые никто не замечает вовремя.
 *
 * Провал без разбора — это потерянная неделя: задача упала, менеджеру сказали
 * о ней один раз в момент падения (supervisor.ts, watchBoard), и если тогда
 * никто не записал причину в журнал, повторится она ровно так же. Ветка,
 * которую не слили, тихо расходится с основной, и чем дольше висит, тем дороже
 * стоит слияние. Задача, вставшая на автосжатии или в ожидании, снаружи
 * выглядит как работающая — человечек в комнате сидит за столом.
 *
 * Всё считается из доски и журнала на момент запроса. Своих счётчиков модуль
 * не держит нигде, кроме кеша для сравнения «изменилось ли», а признак
 * автосжатия живёт на самой задаче (`Task.compactions`) и сохраняется вместе
 * с ней. Поэтому после перезапуска сервера сводка говорит то же самое, что
 * говорила до него, а не начинает жизнь с чистого листа.
 */
import type { HealthEntry, HealthReason, OfficeHealth } from '../shared/types';
import type { OfficeState, Task } from './state';

/** Со скольких часов ветка без слияния считается повисшей. */
const BRANCH_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Сколько задача стоит в очереди, прежде чем попасть в сводку. Тот же порог,
 * с которого надзор начинает о ней говорить: раньше этого она не «встала»,
 * а просто ждёт своего прохода.
 */
const QUEUED_MS = 5 * 60_000;

/**
 * Со скольких сжатий контекста подряд задача считается буксующей. Одно сжатие
 * нормально: длинная задача с десятками прочитанных файлов доходит до окна и
 * едет дальше. Два и больше — сессия уже пережёвывает саму себя, и почти
 * всегда это значит, что задача слишком велика для одного исполнителя.
 */
const COMPACT_LIMIT = 2;

/** Сколько ждём тишины, прежде чем пересобрать сводку по событиям доски. */
const DEBOUNCE_MS = 500;

interface Watch {
  /** Подпись прошлой сводки: по ней видно, изменилась она или только постарела. */
  sig: string;
  timer: NodeJS.Timeout | null;
  off: (() => void) | null;
}

const watches = new Map<string, Watch>();

const entry = (
  task: Task, kind: HealthEntry['kind'], reason: HealthReason,
  note: string, since: number, now: number,
): HealthEntry => ({
  kind,
  reason,
  taskId: task.id,
  title: task.title,
  roleId: task.roleId,
  branch: task.branch,
  note,
  since,
  // Возраст считаем на момент сборки: отрицательным он быть не может даже
  // если время задачи уехало вперёд после правки состояния руками.
  ageMs: Math.max(0, now - since),
});

/** Есть ли в журнале хоть одна запись про эту задачу. */
function hasPostmortem(state: OfficeState, taskId: string): boolean {
  // Архивные и протухшие записи тоже считаются: разбор был, и повторять его
  // офис не просит. «Без разбора» — это когда о задаче не написали вовсе.
  return state.factList().some((f) => f.source.taskId === taskId);
}

/** Провалившиеся задачи, про которые в журнале ничего нет. */
function failures(state: OfficeState, now: number): HealthEntry[] {
  const out: HealthEntry[] = [];
  for (const task of state.tasks.values()) {
    const kind = task.outcome?.kind;
    const failed = task.status === 'failed' || kind === 'failed' || kind === 'reverted';
    if (!failed) continue;
    if (hasPostmortem(state, task.id)) continue;
    const reason: HealthReason = kind === 'reverted' ? 'reverted' : 'noPostmortem';
    const since = task.outcome?.at ?? task.finishedAt ?? task.startedAt ?? task.createdAt;
    out.push(entry(task, 'failure', reason, state.say(`health.${reason}`, {
      task: task.id, title: task.title,
    }), since, now));
  }
  return out.sort((a, b) => a.since - b.since);
}

/** Ветки задач, которые старше суток и не слиты. */
function branches(state: OfficeState, now: number): HealthEntry[] {
  const out: HealthEntry[] = [];
  for (const task of state.tasks.values()) {
    if (!task.branch || task.merged) continue;
    // Снятая задача ветку за собой не тянет: её никто и не собирался сливать.
    if (task.outcome?.kind === 'cancelled') continue;
    // Отсчёт от момента, с которого ветку можно было сливать: работа сдана —
    // от сдачи, ещё идёт — от начала. Иначе долгая задача попадала бы в
    // сводку просто за то, что её делают второй день.
    const since = task.finishedAt ?? task.startedAt ?? task.createdAt;
    if (now - since < BRANCH_STALE_MS) continue;
    const pr = state.prs.get(task.id);
    const stuck = pr?.stage === 'stuck';
    const reason: HealthReason = stuck ? 'prStuck' : 'unmerged';
    out.push(entry(task, 'branch', reason, state.say(`health.${reason}`, {
      branch: task.branch, note: pr?.note ?? '',
    }), since, now));
  }
  return out.sort((a, b) => a.since - b.since);
}

/**
 * Задачи, которые стоят. Причина у задачи одна, самая сильная: пять строк про
 * одну и ту же задачу — это не сводка, а лог.
 */
function stalled(state: OfficeState, now: number): HealthEntry[] {
  const out: HealthEntry[] = [];
  // Прогоны процессов по задачам: ждут ответа или встали.
  const waiting = new Map<string, number>();
  for (const run of state.runs.values()) {
    const taskId = run.subject.taskId;
    if (!taskId) continue;
    if (run.status !== 'waiting') continue;
    waiting.set(taskId, Math.min(waiting.get(taskId) ?? run.updatedAt, run.updatedAt));
  }

  for (const task of state.tasks.values()) {
    // Снятая задача не стоит, а закрыта: спрашивать с офиса за то, что её
    // никто не делает, — значит звать чинить чужое решение.
    if (task.merged || task.status === 'done' || task.status === 'failed'
      || task.status === 'cancelled') continue;
    const pr = state.prs.get(task.id);

    let reason: HealthReason | null = null;
    let since = task.startedAt ?? task.createdAt;
    let params: Record<string, string | number> = {};

    if (task.status === 'blocked' && task.limitedAt) {
      reason = 'limit';
      since = task.limitedAt;
    } else if (task.status === 'blocked' && task.interrupted) {
      reason = 'interrupted';
    } else if (task.compactions >= COMPACT_LIMIT && task.status === 'in_progress') {
      reason = 'compacting';
      since = task.compactedAt ?? since;
      params = { n: task.compactions };
    } else if (pr?.needsDecision) {
      reason = 'decision';
      since = pr.updatedAt;
      params = { note: pr.note };
    } else if (waiting.has(task.id)) {
      reason = 'runWaiting';
      since = waiting.get(task.id) as number;
    } else if (task.status === 'backlog' && now - task.createdAt > QUEUED_MS) {
      reason = 'queued';
      since = task.createdAt;
    }
    if (!reason) continue;

    out.push(entry(task, 'stall', reason, state.say(`health.${reason}`, params), since, now));
  }
  return out.sort((a, b) => a.since - b.since);
}

/** Собрать сводку прямо сейчас. Чистая функция от доски и журнала. */
export function officeHealth(state: OfficeState, now = Date.now()): OfficeHealth {
  return {
    at: now,
    failures: failures(state, now),
    branches: branches(state, now),
    stalled: stalled(state, now),
  };
}

/**
 * Подпись сводки — всё, кроме возрастов и момента сборки. Сравнивать целиком
 * нельзя: `ageMs` меняется при каждом пересчёте, и офис рассылал бы событие
 * «сводка изменилась» на каждый чих, хотя не изменилось ничего.
 */
function signature(health: OfficeHealth): string {
  const line = (e: HealthEntry): string => `${e.kind}:${e.reason}:${e.taskId}:${e.since}:${e.note}`;
  return [health.failures, health.branches, health.stalled]
    .map((list) => list.map(line).join('|')).join('||');
}

/**
 * Пересобрать сводку и разослать, если она стала другой. Вызывается и по
 * событиям доски, и проходом надзора: часть записей появляется просто от
 * времени (ветке стукнули сутки), а времени никакое событие не приходит.
 */
export function refreshHealth(state: OfficeState, now = Date.now()): OfficeHealth {
  const health = officeHealth(state, now);
  // Офис, за которым никто не следит (надзор подняли отдельно, как в тестах),
  // всё равно должен сравнивать сводку с прошлой — иначе он рассылал бы её
  // на каждом проходе как новость.
  let watch = watches.get(state.officeId);
  if (!watch) {
    watch = { sig: '', timer: null, off: null };
    watches.set(state.officeId, watch);
  }
  const sig = signature(health);
  if (watch.sig === sig) return health;
  watch.sig = sig;
  state.emit({ t: 'health', health });
  return health;
}

/**
 * Следить за здоровьем офиса: пересобирать сводку, когда меняется доска.
 *
 * Пересчёт отложен на полсекунды по двум причинам. Одно действие офиса — это
 * пачка событий подряд (задача, пулл-реквест, запись в журнал), и считать
 * сводку на каждое из них незачем. И, главное, рассылка изнутри подписки —
 * это событие внутри события: таймер разрывает эту петлю.
 */
export function watchHealth(state: OfficeState): void {
  stopHealth(state.officeId);
  const watch: Watch = { sig: '', timer: null, off: null };
  watches.set(state.officeId, watch);

  const plan = () => {
    if (watch.timer) return;
    const timer = setTimeout(() => {
      watch.timer = null;
      refreshHealth(state);
    }, DEBOUNCE_MS);
    // Сводка не повод держать процесс живым: она обслуживает работу.
    timer.unref?.();
    watch.timer = timer;
  };

  watch.off = state.subscribe((e) => {
    // Слушаем только то, из чего сводка и собрана. Лог и реплики чата идут
    // потоком, и пересчитывать на них — это считать сводку постоянно.
    if (e.t === 'task' || e.t === 'pr' || e.t === 'fact' || e.t === 'fact.remove'
      || e.t === 'run' || e.t === 'instance.remove') plan();
  });

  // Первая сводка — сразу при открытии офиса: после перезапуска сервера
  // клиент должен увидеть накопившееся, а не ждать первого события.
  refreshHealth(state);
}

/** Перестать следить: офис выгружают из памяти. */
export function stopHealth(officeId: string): void {
  const watch = watches.get(officeId);
  if (!watch) return;
  if (watch.timer) clearTimeout(watch.timer);
  watch.off?.();
  watches.delete(officeId);
}

/**
 * Сессия исполнителя сжала контекст. Считаем это на задаче, а не на сессии:
 * задача переживает и перезапуск сервера, и смену исполнителя, а вопрос
 * «почему это делается третий час» задают именно про задачу.
 */
export function noteCompaction(state: OfficeState, instanceId: string): void {
  const taskId = state.instances.get(instanceId)?.currentTaskId;
  if (!taskId) return;
  const task = state.tasks.get(taskId);
  if (!task) return;
  state.updateTask(taskId, {
    compactions: task.compactions + 1,
    compactedAt: Date.now(),
  });
}

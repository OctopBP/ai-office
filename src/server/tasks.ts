/**
 * Правка, снятие и удаление задач.
 *
 * Завести задачу офис умел с самого начала, а передумать — нет: формулировка
 * застывала навсегда, и на «сделай это по-другому» менеджеру оставалось
 * только завести вторую задачу рядом. Доска от этого росла дублями, а первая
 * задача всё равно уезжала исполнителю — через десять минут её раздавал
 * надзор.
 *
 * Отсюда три разных действия, и путать их нельзя:
 *
 * - ПРАВКА (`editTask`) — та же задача с другим ТЗ. Пока за неё никто не
 *   взялся или работа уже остановлена: у идущей задачи ТЗ уже прочитано, и
 *   менять его на ходу значит врать исполнителю.
 * - СНЯТИЕ (`dropTask`) — задача больше не нужна. Остаётся на доске со
 *   снятым исходом: по ней видно, от чего отказались, а табель роли не
 *   считает снятую работу провалом.
 * - УДАЛЕНИЕ (`deleteTask`) — задачи не должно было быть вовсе. Разрешено
 *   только там, где стирать нечего: ни сессии, ни ветки, ни потраченных
 *   денег. Всё остальное — снятие, ровно как у ролей (архив против «стереть»).
 */
import { OFFICE_SENDER, type TaskEdit, type TaskStatus } from '../shared/types';
import { TASK_TYPES, type TaskType } from '../shared/workflow';
import type { OfficeState, Task } from './state';
import { cancelTask } from './outcomes';
import { dispatch } from './plan';

/** Обрез для ленты: длинный заголовок в строке журнала ничего не добавляет. */
const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface TaskResult {
  ok: boolean;
  /** Готовый к показу текст: что получилось или почему нельзя. */
  message: string;
}

/** За задачу взялись прямо сейчас: трогать её ТЗ нельзя. */
const RUNNING: TaskStatus[] = ['assigned', 'in_progress', 'review'];

/** Задача ещё не начиналась: её и раздают, и стирают без последствий. */
const UNTOUCHED: TaskStatus[] = ['planned', 'backlog'];

/**
 * Переписать задачу. Меняется только присланное: «поменяй роль» не должно
 * молча стирать критерии, а «перепиши ТЗ» — сбрасывать зависимости.
 */
export function editTask(state: OfficeState, taskId: string, patch: TaskEdit): TaskResult {
  const task = state.tasks.get(taskId);
  if (!task) return { ok: false, message: state.say('task.err.noTask', { task: taskId }) };
  if (task.outcome || task.status === 'done' || task.status === 'cancelled') {
    return { ok: false, message: state.say('task.edit.closed', { task: task.id }) };
  }
  if (RUNNING.includes(task.status)) {
    return { ok: false, message: state.say('task.edit.running', { task: task.id }) };
  }

  const changes: string[] = [];
  const next: Partial<Task> = {};

  const title = patch.title?.trim();
  if (title !== undefined && title !== task.title) {
    if (!title) return { ok: false, message: state.say('task.edit.emptyTitle') };
    next.title = title;
    changes.push(state.say('task.edit.field.title'));
  }

  const description = patch.description?.trim();
  if (description !== undefined && description !== task.description) {
    if (!description) return { ok: false, message: state.say('task.edit.emptyDescription') };
    next.description = description;
    changes.push(state.say('task.edit.field.description'));
  }

  if (patch.criteria !== undefined) {
    const criteria = patch.criteria.map((c) => c.trim()).filter(Boolean);
    if (!criteria.length) {
      return { ok: false, message: state.say('tool.createTask.noCriteria') };
    }
    // Отметки не переносим: критерии переписаны, и «выполнено» от прошлой
    // формулировки — это отметка о работе, которой уже нет в ТЗ.
    next.criteria = criteria.map((text) => ({ text, done: false }));
    changes.push(state.say('task.edit.field.criteria', { n: criteria.length }));
  }

  const roleId = patch.roleId?.trim();
  if (roleId !== undefined && roleId !== task.roleId) {
    const valid = state.workerRoles().map((r) => r.id);
    if (!valid.includes(roleId)) {
      return {
        ok: false,
        message: state.say('tool.createTask.badRole', { role: roleId, valid: valid.join(', ') }),
      };
    }
    next.roleId = roleId;
    changes.push(state.say('task.edit.field.role', { role: roleId }));
    // Тип работы был выведен из прежней роли — пересчитываем его вместе с
    // ней: иначе задача дизайнера продолжила бы ездить по процессу для кода.
    if (patch.type === undefined) next.type = state.typeForRole(roleId);
  }

  if (patch.type !== undefined) {
    const type = patch.type.trim() as TaskType | '';
    if (type && !TASK_TYPES.includes(type as TaskType)) {
      return {
        ok: false,
        message: state.say('task.edit.badType', { type, valid: TASK_TYPES.join(', ') }),
      };
    }
    const resolved = type ? (type as TaskType) : state.typeForRole(next.roleId ?? task.roleId);
    if (resolved !== task.type) {
      next.type = resolved;
      changes.push(state.say('task.edit.field.type', { type: resolved ?? '—' }));
    }
  }

  // Важность живёт отдельным полем и меняется отдельным методом: её правят
  // и кнопкой на доске, и тем же edit_task — «это срочно» приходит от
  // человека ровно так же, как «перепиши ТЗ».
  if (patch.priority !== undefined && patch.priority !== task.priority) {
    const problem = state.setTaskPriority(task.id, patch.priority);
    if (problem) return { ok: false, message: problem };
    changes.push(state.say('task.edit.field.priority', {
      priority: state.priorityWord(patch.priority),
    }));
  }

  if (!changes.length) return { ok: false, message: state.say('task.edit.nothing', { task: task.id }) };

  state.updateTask(task.id, next);
  const fresh = state.tasks.get(task.id) as Task;
  state.addChat(OFFICE_SENDER, state.say('task.edit.chat', {
    task: task.id, title: fresh.title, changed: changes.join(', '),
  }));
  state.addLog(null, 'system', state.say('task.edit.log', {
    task: task.id, changed: changes.join(', '),
  }));
  // Остановленная задача сама не поедет: правка ТЗ — ещё не перезапуск, и
  // обещать обратное нельзя.
  const idle = task.status === 'failed' || task.status === 'blocked'
    ? state.say('task.edit.needsRestart', { task: task.id })
    : '';
  return {
    ok: true,
    message: state.say('task.edit.ok', {
      task: task.id, title: fresh.title, changed: changes.join(', '),
    }) + idle,
  };
}

/**
 * Снять задачу с доски. Работающего исполнителя при этом прерываем: «отмени,
 * я передумал» обязано работать и тогда, когда работа уже началась, — иначе
 * человек платит за то, что решили не делать.
 */
export function dropTask(state: OfficeState, taskId: string, reason = ''): TaskResult {
  const task = state.tasks.get(taskId);
  if (!task) return { ok: false, message: state.say('task.err.noTask', { task: taskId }) };
  if (task.status === 'cancelled') {
    return { ok: false, message: state.say('task.drop.already', { task: task.id }) };
  }
  if (task.merged || task.status === 'done') {
    return { ok: false, message: state.say('task.drop.done', { task: task.id }) };
  }
  if (task.status === 'review') {
    return { ok: false, message: state.say('task.drop.review', { task: task.id }) };
  }

  const why = reason.trim();
  // Задачи, которые стояли в очереди за этой: они опирались на её результат,
  // и без него делать их нечего. Снимаем вместе — иначе они зависли бы в
  // плане навсегда, а фича из-за них никогда бы не закрылась.
  const chained = dependants(state, task.id);

  const running = RUNNING.includes(task.status);
  if (running) {
    const inst = [...state.instances.values()].find((i) => i.currentTaskId === task.id);
    if (!inst?.abort) {
      // Сессии уже нет, а статус остался от неё: закрываем как обычную.
      cancelOne(state, task, why);
    } else {
      // Конец сессии разберёт тот, кто её запускал (agents.ts): он закоммитит
      // наработки в ветку задачи и закроет её снятой.
      state.cancelledByUser.add(task.id);
      inst.abort.abort();
      state.addChat(OFFICE_SENDER, state.say('task.drop.stopping', {
        task: task.id, title: task.title, who: inst.id,
        reason: why || state.say('task.drop.noReason'),
      }));
    }
  } else {
    cancelOne(state, task, why);
  }

  for (const dep of chained) cancelOne(state, dep, state.say('task.drop.chainReason', { task: task.id }));
  dispatch(state);

  const tail = chained.length
    ? state.say('task.drop.chained', { tasks: chained.map((t) => t.id).join(', ') })
    : '';
  const head = running && state.cancelledByUser.has(task.id)
    ? state.say('task.drop.okStopping', { task: task.id, title: task.title })
    : state.say('task.drop.ok', { task: task.id, title: task.title });
  return { ok: true, message: head + tail };
}

/** Снять одну задачу: исход, запись в чат и в журнал офиса. */
function cancelOne(state: OfficeState, task: Task, reason: string): void {
  cancelTask(state, task);
  // Причину не выдумываем: строка «снята: без объяснения» читается как
  // отговорка офиса, хотя офис тут вообще ни при чём.
  state.addChat(OFFICE_SENDER, reason
    ? state.say('task.drop.chat', { task: task.id, title: task.title, reason })
    : state.say('task.drop.chatPlain', { task: task.id, title: task.title }));
  state.addLog(null, 'system', state.say('task.drop.log', {
    task: task.id, title: clip(task.title),
  }));
}

/**
 * Задачи, которые ждут эту — включая тех, кто ждёт их самих. Берём только
 * незапущенные: начатую задачу чужое снятие не касается, работа по ней уже
 * идёт и её результат никуда не денется.
 */
function dependants(state: OfficeState, taskId: string): Task[] {
  const out: Task[] = [];
  const seen = new Set<string>([taskId]);
  let wave = [taskId];
  while (wave.length) {
    const next: string[] = [];
    for (const task of state.tasks.values()) {
      if (seen.has(task.id) || task.outcome) continue;
      if (!UNTOUCHED.includes(task.status)) continue;
      if (!(task.dependsOn ?? []).some((id) => wave.includes(id))) continue;
      seen.add(task.id);
      out.push(task);
      next.push(task.id);
    }
    wave = next;
  }
  return out;
}

/**
 * Стереть задачу насовсем. Можно ровно тогда, когда стирать нечего: задачу
 * ни разу не начинали. Всё, за чем стоит работа — ветка, сессия, деньги, —
 * снимается, а не стирается: иначе из офиса пропадала бы история, по которой
 * считается табель роли и видно, куда ушли деньги.
 */
export function deleteTask(state: OfficeState, taskId: string): TaskResult {
  const task = state.tasks.get(taskId);
  if (!task) return { ok: false, message: state.say('task.err.noTask', { task: taskId }) };

  const trace = traceOf(state, task);
  if (trace) {
    return { ok: false, message: state.say('task.delete.refused', { task: task.id, trace }) };
  }

  // Ссылки на стёртую задачу чинить некому: «ждёт T-5», которой нет, — это
  // задача, которая не поедет никогда.
  const freed: string[] = [];
  for (const other of state.tasks.values()) {
    if (!(other.dependsOn ?? []).includes(task.id)) continue;
    state.updateTask(other.id, { dependsOn: other.dependsOn.filter((id) => id !== task.id) });
    freed.push(other.id);
  }

  state.removeTask(task.id);
  state.addChat(OFFICE_SENDER, state.say('task.delete.chat', { task: task.id, title: task.title }));
  state.addLog(null, 'system', state.say('task.delete.log', {
    task: task.id, title: clip(task.title),
  }));
  dispatch(state);

  return {
    ok: true,
    message: state.say('task.delete.ok', { task: task.id, title: task.title })
      + (freed.length ? state.say('task.delete.freed', { tasks: freed.join(', ') }) : ''),
  };
}

/**
 * След задачи: то, что пропадёт вместе с ней. Пусто — стирать нечего.
 * Возвращает готовый кусок фразы, а не флаг: человеку и менеджеру важно
 * знать, что именно мешает, — иначе отказ выглядит как каприз офиса.
 */
function traceOf(state: OfficeState, task: Task): string | null {
  if (!UNTOUCHED.includes(task.status)) {
    return state.say('task.delete.traceStatus', { status: state.say(`task.state.${task.status}`) });
  }
  if (task.outcome) return state.say('task.delete.traceOutcome');
  if (task.branch || task.worktreePath) return state.say('task.delete.traceBranch', { branch: task.branch ?? '' });
  if (task.assigneeId || task.startedAt) return state.say('task.delete.traceStarted');
  if (task.usage.costUsd > 0) return state.say('task.delete.traceSpent', { spent: task.usage.costUsd.toFixed(2) });
  if (state.prs.has(task.id)) return state.say('task.delete.tracePr');
  return null;
}

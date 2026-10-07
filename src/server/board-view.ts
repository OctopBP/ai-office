/**
 * Доска глазами менеджера: сводка и выборки текстом (T-362, по наработкам T-358).
 *
 * Отдавать доску целиком нельзя: на сотнях задач это под двести тысяч
 * символов, в ответ инструмента такое не влезает, и менеджер не видит как раз
 * того, ради чего смотрел, — что живо, какие фичи стоят и почему.
 *
 * Поэтому без условий — сводка: счётчики, открытые фичи с причиной простоя,
 * живые задачи строками, закрытое числом, открытые вопросы. Подробности —
 * выборкой: одна фича, статусы, конкретные задачи, постранично. Любой вывод
 * ограничен потолком и при превышении честно обрезан.
 *
 * Здесь только чистые функции от данных к тексту: на входе списки задач, фич
 * и вопросов, на выходе строка. Ни состояния офиса, ни побочных эффектов —
 * поэтому модуль проверяется синтетической доской без сервера. Слова берутся
 * из серверных словарей (ключи board.*, причины простоя — plan.hold.*) через
 * функцию перевода, которую передаёт вызывающий: язык — дело офиса, не модуля.
 */
import {
  DEFAULT_TASK_PRIORITY, taskClosed,
  type EpicHold, type EpicView, type OwnerQuestion, type TaskStatus, type TaskView,
} from '../shared/types';
import type { Vars } from '../shared/i18n';
import type { ServerKey } from './i18n';

/** Перевод на язык офиса: обычно state.say или t(lang, …). */
export type BoardSay = (key: ServerKey, vars?: Vars) => string;

/** Потолок вывода в символах. Длиннее — обрезается с подсказкой сузить выборку. */
export const BOARD_CAP = 20_000;

/** Все статусы задачи в порядке её жизни — для счётчиков и проверки аргумента. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'planned', 'backlog', 'assigned', 'in_progress', 'review', 'blocked', 'done', 'failed', 'cancelled',
];

/** Сколько живых задач перечислять в сводке; остальные — числом и выборкой. */
const LIVE_SHOWN = 80;
/** Сколько открытых фич перечислять в сводке. */
const FEATURES_SHOWN = 40;
/** Сколько открытых вопросов показывать в сводке. */
const QUESTIONS_SHOWN = 15;
/** Страница выборки по умолчанию и её предел. */
const PAGE_DEFAULT = 30;
const PAGE_MAX = 200;

/** Задача — ровно те поля, что нужны тексту. */
export type BoardTask = Pick<TaskView,
  'id' | 'title' | 'status' | 'roleId' | 'assigneeId' | 'epicId' | 'order' | 'priority'
  | 'dependsOn' | 'merged' | 'branch'>
  & Partial<Pick<TaskView, 'result' | 'criteria' | 'subprojectId'>>;

/** Фича плана — поля для строки и причины простоя. */
export type BoardEpic = Pick<EpicView, 'id' | 'title' | 'status' | 'order'>
  & Partial<Pick<EpicView, 'hold' | 'goal' | 'approved'>>;

/** Вопрос владельцу — поля для строки сводки. */
export type BoardQuestion = Pick<OwnerQuestion, 'id' | 'taskId' | 'text'>
  & Partial<Pick<OwnerQuestion, 'answer' | 'dismissedAt'>>;

/** Вход: всё, из чего строится текст доски. */
export interface BoardInput {
  tasks: readonly BoardTask[];
  epics: readonly BoardEpic[];
  /** Открытые вопросы. Отвеченные и снятые отсеиваются и здесь — на всякий случай. */
  questions?: readonly BoardQuestion[];
  /** Settings.autoPipeline: по нему «сдана» отличается от «закрыта». По умолчанию — включён. */
  autoPipeline?: boolean;
  /**
   * Подпроекты офиса. Есть хотя бы один — живые задачи в сводке группируются
   * по зонам; нет — сводка прежняя.
   */
  zones?: readonly BoardZone[];
}

/** Зона для заголовка группы в сводке. */
export interface BoardZone {
  id: string;
  name: string;
}

/** Выборка. Все поля необязательные; ни одного — сводка. */
export interface BoardOpts {
  featureId?: string;
  status?: string | readonly string[];
  taskIds?: readonly string[];
  limit?: number;
  offset?: number;
  /** Потолок символов; по умолчанию BOARD_CAP. */
  cap?: number;
}

// ------------------------------------------------------------- мелочи

const clip = (s: unknown, n: number): string => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

const idNum = (id: string): number => Number(id.replace(/\D+/g, '')) || 0;

/** Список id с хвостом «+N», чтобы строка не разрасталась. */
const someIds = (ids: readonly string[], n = 5): string =>
  ids.slice(0, n).join(', ') + (ids.length > n ? ` +${ids.length - n}` : '');

/** Причина простоя фичи словами — ключи plan.hold.*, как у plan.ts (holdText), но с коротким списком id. */
export function holdWords(say: BoardSay, hold: EpicHold): string {
  switch (hold.kind) {
    case 'approval': return say('plan.hold.approval');
    case 'slot': return say('plan.hold.slot', { epics: someIds(hold.epics) });
    case 'share': return say('plan.hold.share');
    case 'tasks': return say('plan.hold.tasks', { tasks: someIds(hold.tasks) });
    case 'stuck': return say('plan.hold.stuck', { tasks: someIds(hold.tasks) });
    case 'unstaffed': return say('plan.hold.unstaffed', { tasks: someIds(hold.tasks) });
  }
}

/**
 * Обрезать текст до потолка с пометкой. Режем по границе строки: полстроки
 * задачи читается как другая задача.
 */
export function capText(say: BoardSay, text: string, cap = BOARD_CAP): string {
  if (text.length <= cap) return text;
  const note = `\n${say('board.cut', { cap })}`;
  const room = Math.max(0, cap - note.length);
  const cut = text.lastIndexOf('\n', room);
  return `${text.slice(0, cut > room / 2 ? cut : room)}${note}`;
}

// ------------------------------------------------------------- признаки

/** Контекст расчёта: индекс задач, правило закрытия и перевод. */
interface Ctx {
  byId: Map<string, BoardTask>;
  auto: boolean;
  say: BoardSay;
}

const ctxOf = (input: BoardInput, say: BoardSay): Ctx => ({
  byId: new Map(input.tasks.map((x) => [x.id, x])),
  auto: input.autoPipeline ?? true,
  say,
});

const isClosed = (c: Ctx, t: BoardTask): boolean => taskClosed(t, c.auto);

/** Сдана, но ещё не влита: едет по конвейеру ревью и слияния. */
const awaitsMerge = (c: Ctx, t: BoardTask): boolean => t.status === 'done' && !isClosed(c, t);

/**
 * Живая задача — о ней надо знать сейчас: в очереди, в работе, на ревью (в том
 * числе сданная и ждущая слияния), провалилась или встала. Плановая задача
 * фичи видна строкой фичи; плановая без фичи — живая, иначе её не видно нигде.
 */
function isLive(c: Ctx, t: BoardTask): boolean {
  switch (t.status) {
    case 'backlog': case 'assigned': case 'in_progress': case 'review':
    case 'blocked': case 'failed':
      return true;
    case 'done': return awaitsMerge(c, t);
    case 'planned': return !t.epicId;
    default: return false;
  }
}

/** Порядок живых в сводке: сначала то, что требует решения. */
function liveRank(t: BoardTask): number {
  switch (t.status) {
    case 'failed': case 'blocked': return 0;
    case 'in_progress': case 'assigned': return 1;
    case 'review': case 'done': return 2;
    case 'backlog': return 3;
    default: return 4;
  }
}

// ------------------------------------------------------------- строки

/** Одна строка задачи: id, статус, важность, заголовок, роль или исполнитель, фича, зависимости. */
function taskLine(c: Ctx, t: BoardTask): string {
  // Средний приоритет не пишем: он у большинства и только заглушил бы важные.
  const priority = t.priority && t.priority !== DEFAULT_TASK_PRIORITY ? ` !${t.priority}` : '';
  const status = awaitsMerge(c, t) ? c.say('board.awaitsMerge') : t.status;
  const who = t.assigneeId ?? t.roleId ?? '—';
  const feature = t.epicId ? ` · ${t.epicId}` : '';
  const deps = t.dependsOn.length
    ? ` · ${c.say('board.after', {
      ids: t.dependsOn.map((id) => {
        const dep = c.byId.get(id);
        return dep && isClosed(c, dep) ? `${id} ✓` : id;
      }).join(', '),
    })}`
    : '';
  return `${t.id} [${status}]${priority} ${clip(t.title, 90)} → ${who}${feature}${deps}`;
}

/** Строка в выборке: та же плюс критерии и результат. */
function taskDetail(c: Ctx, t: BoardTask): string {
  const lines = [taskLine(c, t)];
  const criteria = t.criteria ?? [];
  if (criteria.length) {
    lines.push(`    ${c.say('board.criteria', { done: criteria.filter((x) => x.done).length, total: criteria.length })}`);
  }
  if (t.result) lines.push(`    ${c.say('board.result', { text: clip(t.result, 200) })}`);
  return lines.join('\n');
}

/** Задачи фичи в порядке плана. */
const tasksOfEpic = (input: BoardInput, epicId: string): BoardTask[] =>
  input.tasks.filter((x) => x.epicId === epicId)
    .sort((a, b) => a.order - b.order || idNum(a.id) - idNum(b.id));

/** Прогресс фичи: закрыто из всех, кроме снятых, — снятые не работа и не долг. */
export function featureProgress(input: BoardInput, epicId: string): { done: number; total: number } {
  const c = ctxOf(input, (key) => key);
  const tasks = tasksOfEpic(input, epicId).filter((x) => x.status !== 'cancelled');
  return { done: tasks.filter((x) => isClosed(c, x)).length, total: tasks.length };
}

/** Строка фичи: id, название, статус, «N из M» и причина простоя, если стоит. */
export function featureLine(say: BoardSay, input: BoardInput, epic: BoardEpic): string {
  const { done, total } = featureProgress(input, epic.id);
  const hold = epic.hold && (epic.status === 'planned' || epic.status === 'active')
    ? ` — ${holdWords(say, epic.hold)}`
    : '';
  return `${epic.id} «${clip(epic.title, 80)}» [${epic.status}] ${say('board.progress', { done, total })}${hold}`;
}

// ------------------------------------------------------------- сводка

/**
 * Живые задачи по зонам (spec подпроектов §6.1): группа на зону в порядке
 * зон, задачи без зоны или с пропавшей зоной — в последней группе «весь
 * проект». Пустые группы не печатаются. Порядок внутри группы — тот же, что
 * у сводки: сначала то, что требует решения.
 */
function byZone(c: Ctx, live: readonly BoardTask[], zones: readonly BoardZone[]): string[] {
  const known = new Set(zones.map((z) => z.id));
  const groups = [
    ...zones.map((z) => ({
      title: z.name && z.name !== z.id ? `${z.id} (${z.name})` : z.id,
      tasks: live.filter((x) => x.subprojectId === z.id),
    })),
    {
      title: c.say('subprojects.text.wholeProject'),
      tasks: live.filter((x) => !x.subprojectId || !known.has(x.subprojectId)),
    },
  ];
  return groups.filter((g) => g.tasks.length).flatMap((g) => [
    c.say('board.zone', { zone: g.title, n: g.tasks.length }),
    ...g.tasks.map((x) => `  ${taskLine(c, x)}`),
  ]);
}

/** Сводка доски без потолка: счётчики, фичи, живые задачи, закрытое числом, вопросы. */
export function boardSummary(input: BoardInput, say: BoardSay): string {
  const c = ctxOf(input, say);
  const { tasks, epics } = input;
  const parts: string[] = [];

  if (!tasks.length && !epics.length) return say('board.empty');

  const counts = TASK_STATUSES
    .map((s) => [s, tasks.filter((x) => x.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s} ${n}`)
    .join(', ');
  parts.push(say('board.counts', { total: tasks.length, counts: counts || '—' }));

  if (epics.length) {
    const open = epics.filter((e) => e.status === 'planned' || e.status === 'active')
      .sort((a, b) => a.order - b.order);
    const lines = open.slice(0, FEATURES_SHOWN).map((e) => featureLine(say, input, e));
    if (open.length > FEATURES_SHOWN) {
      lines.push(say('board.featuresMore', { n: open.length - FEATURES_SHOWN }));
    }
    const done = epics.filter((e) => e.status === 'done').length;
    const cancelled = epics.filter((e) => e.status === 'cancelled').length;
    if (done || cancelled) lines.push(say('board.featuresClosed', { done, cancelled }));
    parts.push(`${say('board.features', { n: open.length })}\n${lines.join('\n') || '—'}`);
  }

  if (tasks.length) {
    const live = tasks.filter((x) => isLive(c, x))
      .sort((a, b) => liveRank(a) - liveRank(b) || idNum(a.id) - idNum(b.id));
    if (live.length) {
      const top = live.slice(0, LIVE_SHOWN);
      const shown = input.zones?.length ? byZone(c, top, input.zones) : top.map((x) => taskLine(c, x));
      if (live.length > LIVE_SHOWN) {
        shown.push(say('board.liveMore', { n: live.length - LIVE_SHOWN }));
      }
      parts.push(`${say('board.live', { n: live.length })}\n${shown.join('\n')}`);
    } else {
      parts.push(say('board.noLive'));
    }
    // Закрытое — только числом.
    const merged = tasks.filter((x) => isClosed(c, x) && x.merged).length;
    const closed = tasks.filter((x) => isClosed(c, x) && !x.merged).length;
    const cancelled = tasks.filter((x) => x.status === 'cancelled').length;
    parts.push(say('board.closed', { merged, closed, cancelled }));
  }

  const questions = (input.questions ?? []).filter((q) => !q.answer && !q.dismissedAt);
  if (questions.length) {
    const rows = questions.slice(0, QUESTIONS_SHOWN)
      .map((q) => `${q.id}${q.taskId ? ` (${q.taskId})` : ''}: ${clip(q.text, 160)}`);
    if (questions.length > QUESTIONS_SHOWN) rows.push(say('board.questionsMore', { n: questions.length - QUESTIONS_SHOWN }));
    parts.push(`${say('board.questions', { n: questions.length })}\n${rows.join('\n')}`);
  }

  parts.push(say('board.hint'));
  return parts.join('\n\n');
}

// ------------------------------------------------------------- выборка

const statusList = (status: BoardOpts['status']): string[] =>
  (typeof status === 'string' ? status.split(',') : [...(status ?? [])])
    .map((s) => s.trim()).filter(Boolean);

/** Выборка задана хотя бы одним условием — иначе отдаётся сводка. */
export const isSelection = (o: BoardOpts): boolean =>
  Boolean(o.featureId?.trim() || statusList(o.status).length || o.taskIds?.length || o.limit || o.offset);

/** Границы страницы: отрицательное и лишнее приводим к разумному. */
export function pageOf(limit?: number, offset?: number): { limit: number; offset: number } {
  const l = Math.floor(limit ?? 0);
  const o = Math.floor(offset ?? 0);
  return { limit: l > 0 ? Math.min(l, PAGE_MAX) : PAGE_DEFAULT, offset: o > 0 ? o : 0 };
}

/**
 * Выборка задач: фича, статусы, конкретные id — условия складываются через
 * «и». Порядок: в фиче — порядок плана, по id — как попросили, иначе сначала
 * новые: в длинном хвосте статуса обычно нужен конец.
 */
export function boardSelect(
  input: BoardInput, o: BoardOpts, say: BoardSay,
): { ok: boolean; text: string; more: boolean } {
  const c = ctxOf(input, say);
  const head: string[] = [];
  let list: BoardTask[];

  const featureId = o.featureId?.trim();
  if (featureId) {
    const epic = input.epics.find((e) => e.id === featureId);
    if (!epic) return { ok: false, more: false, text: say('board.noFeature', { id: featureId }) };
    head.push(featureLine(say, input, epic));
    if (epic.goal) head.push(`    ${clip(epic.goal, 300)}`);
    list = tasksOfEpic(input, epic.id);
  } else {
    list = [...input.tasks].sort((a, b) => idNum(b.id) - idNum(a.id));
  }

  if (o.taskIds?.length) {
    const wanted = [...new Set(o.taskIds.map((id) => id.trim()).filter(Boolean))];
    const missing = wanted.filter((id) => !c.byId.has(id));
    if (missing.length) head.push(say('board.missing', { ids: missing.join(', ') }));
    list = featureId
      ? list.filter((x) => wanted.includes(x.id))
      : wanted.map((id) => c.byId.get(id)).filter((x): x is BoardTask => Boolean(x));
  }

  const statuses = statusList(o.status);
  if (statuses.length) {
    const unknown = statuses.filter((s) => !TASK_STATUSES.includes(s as TaskStatus));
    if (unknown.length) {
      return {
        ok: false, more: false,
        text: say('board.badStatus', { statuses: unknown.join(', '), known: TASK_STATUSES.join(', ') }),
      };
    }
    const wanted = new Set(statuses);
    list = list.filter((x) => wanted.has(x.status));
  }

  const { limit, offset } = pageOf(o.limit, o.offset);
  const page = list.slice(offset, offset + limit);
  const more = offset + page.length < list.length;
  const body = page.length ? page.map((x) => taskDetail(c, x)).join('\n') : say('board.nothing');
  const from = page.length ? offset + 1 : 0;
  const footer = `${say('board.shown', { from, to: offset + page.length, total: list.length })} `
    + (more ? say('board.more', { offset: offset + page.length }) : say('board.all'));
  return { ok: true, more, text: [...head, body, footer].join('\n') };
}

// ------------------------------------------------------------- вход

/**
 * Текст доски: без условий — сводка, с условиями — выборка. Всегда под
 * потолком: длинный вывод обрезается с подсказкой сузить выборку.
 */
export function formatBoard(input: BoardInput, say: BoardSay, opts: BoardOpts = {}): string {
  const cap = opts.cap ?? BOARD_CAP;
  if (!isSelection(opts)) return capText(say, boardSummary(input, say), cap);
  return capText(say, boardSelect(input, opts, say).text, cap);
}

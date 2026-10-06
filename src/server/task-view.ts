/**
 * Задачи словами для менеджера: короткий review_status и подробности одной
 * задачи в get_task. Чистые функции без состояния офиса — на вход данные и
 * язык, на выход текст, поэтому их легко проверить отдельно (test-task-view.ts).
 */
import type { PullRequestView } from '../shared/types';
import type { Lang } from '../shared/i18n';
import type { Epic, Task } from './state';
import { t } from './i18n';

/** Сколько влитые задачи остаются в коротком review_status. */
export const RECENT_MERGED_MS = 24 * 60 * 60 * 1000;
/** Размер страницы review_status с all=true по умолчанию. */
export const REVIEW_PAGE = 30;

export interface ReviewPick {
  /** Что показать, свежие сверху. */
  shown: PullRequestView[];
  /** Короткий режим: сколько влито раньше суток и не показано. */
  olderMerged: number;
  /** Всего пулл-реквестов в конвейере. */
  total: number;
  /** Режим all: номер первой показанной строки (с нуля). */
  offset: number;
  /** Режим all: есть следующая страница. */
  hasMore: boolean;
}

export interface ReviewQuery {
  all?: boolean;
  limit?: number;
  offset?: number;
  now?: number;
}

/**
 * Что показывать в review_status. По умолчанию — всё невлитое и влитое за
 * сутки: давно влитые задачи менеджеру не нужны, а их сотни, и они топят
 * то, что ещё едет. С all=true — всё подряд постранично.
 */
export function pickReviews(prs: Iterable<PullRequestView>, query: ReviewQuery = {}): ReviewPick {
  const sorted = [...prs].sort((a, b) => b.updatedAt - a.updatedAt);
  const total = sorted.length;
  if (query.all) {
    const limit = Math.max(1, Math.floor(query.limit ?? REVIEW_PAGE));
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const shown = sorted.slice(offset, offset + limit);
    return { shown, olderMerged: 0, total, offset, hasMore: offset + shown.length < total };
  }
  // Время слияния отдельно не хранится: у влитого пулл-реквеста updatedAt —
  // последняя смена стадии, то есть само слияние.
  const since = (query.now ?? Date.now()) - RECENT_MERGED_MS;
  const shown = sorted.filter((pr) => pr.stage !== 'merged' || pr.updatedAt >= since);
  return { shown, olderMerged: total - shown.length, total, offset: 0, hasMore: false };
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const stageText = (pr: Pick<PullRequestView, 'stage'>, lang: Lang): string =>
  t(lang, `pr.stage.${pr.stage}`);

/** Одна строка review_status. */
export function reviewLine(pr: PullRequestView, lang: Lang): string {
  return `${pr.taskId} «${pr.title}» — ${stageText(pr, lang)}` +
    `${pr.rounds ? t(lang, 'tool.reviewStatus.rounds', { n: pr.rounds }) : ''}` +
    `${pr.url ? `, ${pr.url}` : ''}\n    ${clip(pr.note, 200)}`;
}

/** Ответ review_status целиком. */
export function reviewStatusText(prs: Iterable<PullRequestView>, query: ReviewQuery, lang: Lang): string {
  const pick = pickReviews(prs, query);
  if (!pick.total) return t(lang, 'tool.reviewStatus.empty');
  const lines = pick.shown.map((pr) => reviewLine(pr, lang));
  if (query.all) {
    if (!pick.shown.length) {
      lines.push(t(lang, 'tool.reviewStatus.pageEmpty', { offset: pick.offset, total: pick.total }));
    } else {
      lines.push(t(lang, 'tool.reviewStatus.page', {
        from: pick.offset + 1, to: pick.offset + pick.shown.length, total: pick.total,
      }));
    }
    if (pick.hasMore) {
      lines.push(t(lang, 'tool.reviewStatus.more', { next: pick.offset + pick.shown.length }));
    }
  } else {
    if (!pick.shown.length) lines.push(t(lang, 'tool.reviewStatus.nothingFresh'));
    if (pick.olderMerged) lines.push(t(lang, 'tool.reviewStatus.older', { n: pick.olderMerged }));
  }
  return lines.join('\n');
}

export type TaskForView = Pick<Task,
  'id' | 'title' | 'description' | 'criteria' | 'roleId' | 'assigneeId' | 'status' | 'priority'
  | 'epicId' | 'dependsOn' | 'result' | 'handoff' | 'merged' | 'branch'>;

export interface TaskViewContext {
  epic: Pick<Epic, 'id' | 'title'> | null;
  pr: PullRequestView | null;
  /** Статусы зависимостей по id: чего задача ждёт. Нет id — задача не найдена. */
  depStatus?: Record<string, string>;
  lang: Lang;
}

/** Подробности одной задачи для get_task: всё, без обрезки ТЗ и отчёта. */
export function taskDetails(task: TaskForView, ctx: TaskViewContext): string {
  const { lang, epic, pr } = ctx;
  const say = (key: Parameters<typeof t>[1], vars?: Parameters<typeof t>[2]) => t(lang, key, vars);
  const none = '—';
  const out: string[] = [`${task.id} «${task.title}»`];
  out.push(`${say('taskView.status')}: ${task.status}${task.merged ? `, ${say('taskView.merged')}` : ''}`);
  out.push(`${say('taskView.priority')}: ${say(`task.priority.${task.priority}`)}`);
  out.push(`${say('taskView.role')}: ${task.roleId ?? none}, ${say('taskView.assignee')}: ${task.assigneeId ?? none}`);
  out.push(`${say('taskView.epic')}: ${epic ? `${epic.id} «${epic.title}»` : task.epicId ?? none}`);
  const deps = task.dependsOn.map((id) => {
    const status = ctx.depStatus?.[id];
    return status ? `${id} [${status}]` : id;
  });
  out.push(`${say('taskView.deps')}: ${deps.length ? deps.join(', ') : none}`);
  if (task.branch) out.push(`${say('taskView.branch')}: ${task.branch}`);

  out.push('', `${say('taskView.description')}:`, task.description.trim() || none);

  const done = task.criteria.filter((c) => c.done).length;
  out.push('', `${say('taskView.criteria')} ${done}/${task.criteria.length}:`);
  task.criteria.forEach((c, i) => out.push(`${c.done ? '✓' : '·'} ${i + 1}. ${c.text}`));

  if (task.result || task.handoff) {
    out.push('', `${say('taskView.result')}:`);
    if (task.result) out.push(task.result.trim());
    if (task.handoff) {
      if (task.handoff.assumed) out.push(`${say('taskView.assumed')}: ${task.handoff.assumed}`);
      if (task.handoff.left) out.push(`${say('taskView.left')}: ${task.handoff.left}`);
    }
  }

  out.push('', `${say('taskView.review')}: ${pr ? stageText(pr, lang) : say('taskView.noReview')}`);
  if (pr) {
    if (pr.rounds) out.push(say('tool.reviewStatus.rounds', { n: pr.rounds }).replace(/^,\s*/, ''));
    if (pr.url) out.push(pr.url);
    if (pr.note) out.push(pr.note);
    const last = pr.reviews[pr.reviews.length - 1];
    if (last) {
      const verdict = say(last.verdict === 'approve' ? 'taskView.approve' : 'taskView.changes');
      out.push('', `${say('taskView.lastReview')} (${verdict}${last.reviewerId ? `, ${last.reviewerId}` : ''}):`, last.text.trim());
    }
  }
  return out.join('\n');
}

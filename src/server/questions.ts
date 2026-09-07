/**
 * Вопросы владельцу (docs/design/living-office/spec.md §6).
 *
 * Прямое продолжение правила «прими решение сам и опиши допущение в отчёте»:
 * агент по-прежнему решает сам и идёт дальше, но допущение больше не
 * хоронится в отчёте — оно ложится в очередь, показывается порцией в
 * планёрке, а ответ владельца становится записью журнала.
 *
 * Не блокирует никогда. Ждущий владельца исполнитель — это оплачиваемая
 * сессия, которая простаивает, и ветка, которая стоит. Единственное, что
 * по-прежнему блокирует, — запрос доступа: там цена ошибки не в переделке.
 */
import type { OwnerQuestion, QuestionKind } from '../shared/types';
import { OFFICE_SENDER } from '../shared/types';
import type { OfficeState } from './state';
import { tellPm } from './review';

/** Сколько вопросов можно задать по одной задаче — как у `ask_colleague`. */
export const MAX_QUESTIONS_PER_TASK = 2;

/** Порядок важности в планёрке: противоречие и протухшее решение выше допущений. */
const PRIORITY: Record<QuestionKind, number> = {
  gate: 0, contradiction: 1, stale: 2, revert: 3, assumption: 4,
};

/** Открытые вопросы: без ответа и не снятые. */
export const openQuestions = (state: OfficeState): OwnerQuestion[] =>
  state.questionList().filter((q) => !q.answeredAt && !q.dismissedAt);

/**
 * Задать вопрос от агента по задаче. Возвращает текст для инструмента:
 * «записано, продолжай по допущению» либо причину отказа. Лимит — на
 * задачу: иначе исполнитель начал бы спрашивать вместо того, чтобы читать код.
 */
export function askOwner(
  state: OfficeState, from: string, taskId: string | null, text: string, assumption: string,
): { ok: boolean; text: string; question: OwnerQuestion | null } {
  if (!text.trim()) return { ok: false, text: state.say('questions.empty'), question: null };
  if (taskId) {
    const used = state.questionsByTask.get(taskId) ?? 0;
    if (used >= MAX_QUESTIONS_PER_TASK) {
      return { ok: false, text: state.say('questions.limit', { max: MAX_QUESTIONS_PER_TASK }), question: null };
    }
    state.questionsByTask.set(taskId, used + 1);
  }
  const question = state.addQuestion({
    from, taskId, kind: 'assumption', text, assumption: assumption || state.say('questions.noAssumption'),
  });
  state.addLog(from === OFFICE_SENDER ? null : from, 'system',
    state.say('questions.askedLog', { id: question.id, text: clip(text, 120) }));
  return { ok: true, text: state.say('questions.askedOk', { id: question.id }), question };
}

/** Вопрос от самого офиса: ритуал заметил противоречие, протухшее решение, откат. */
export function officeAsks(
  state: OfficeState, kind: QuestionKind, text: string, assumption: string, taskId: string | null = null,
): OwnerQuestion {
  const question = state.addQuestion({ from: OFFICE_SENDER, taskId, kind, text, assumption });
  state.addLog(null, 'system', state.say('questions.askedLog', { id: question.id, text: clip(text, 120) }));
  return question;
}

/**
 * Ответ владельца. Ложится в журнал самой надёжной записью из всех и уходит
 * менеджеру: если это правило для роли, предложить его — его дело.
 * Возвращает false, если такого вопроса нет или он уже закрыт.
 */
export function answerQuestion(state: OfficeState, id: string, answer: string): boolean {
  const question = state.questions.get(id);
  if (!question || question.answeredAt) return false;
  const text = answer.trim();
  if (!text) return false;
  const now = Date.now();
  state.updateQuestion(id, { answer: text, answeredAt: now, dismissedAt: null });

  const roleId = question.from !== OFFICE_SENDER ? state.instances.get(question.from)?.roleId ?? null : null;
  const fact = state.addFact({
    kind: question.kind === 'stale' ? 'decision' : 'fact',
    text: state.say('questions.factText', { question: question.text, answer: text }),
    // Ответ по допущению исполнителя — факт его роли; остальное — про проект.
    scope: question.kind === 'assumption' && roleId ? `role:${roleId}` : 'project',
    source: { questionId: id, ...(question.taskId ? { taskId: question.taskId } : {}) },
  });
  state.addChat(OFFICE_SENDER, state.say('questions.answeredChat', { id, fact: fact.id }));
  tellPm(state, state.say('questions.pmAnswered', {
    id, question: question.text, assumption: question.assumption, answer: text,
    task: question.taskId ?? '—',
  }));
  return true;
}

/** Снять вопрос без ответа: офис остаётся при своём допущении. */
export function dismissQuestion(state: OfficeState, id: string): boolean {
  const question = state.questions.get(id);
  if (!question || question.answeredAt || question.dismissedAt) return false;
  state.updateQuestion(id, { dismissedAt: Date.now() });
  return true;
}

/**
 * Порция вопросов для планёрки: самые важные из ещё не показанных. Вопрос
 * по задаче, которая уже закрылась чисто с этим допущением, идёт последним —
 * спрашивать всерьёз то, что уже сработало, незачем.
 */
export function pickForStandup(state: OfficeState, n: number, now = Date.now()): OwnerQuestion[] {
  const settled = (q: OwnerQuestion): number =>
    (q.taskId && state.tasks.get(q.taskId)?.outcome?.kind === 'clean' ? 1 : 0);
  const picked = openQuestions(state)
    .filter((q) => q.shownAt === null)
    .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || settled(a) - settled(b) || a.askedAt - b.askedAt)
    .slice(0, Math.max(0, n));
  for (const q of picked) state.updateQuestion(q.id, { shownAt: now });
  return picked;
}

/**
 * Ответ прямо в чате: «Q-3: да, оставляем». Возвращает id вопроса, если
 * строка про него, — тогда менеджеру она как сообщение не идёт.
 */
export function answerFromChat(state: OfficeState, text: string): string | null {
  const m = /^\s*(Q-\d+)\s*[:\-—–]\s*(.+)$/s.exec(text);
  if (!m) return null;
  return answerQuestion(state, m[1], m[2]) ? m[1] : null;
}

const clip = (s: string, n: number): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/**
 * Ритуал свежести журнала: раз в неделю, на месте забывания (rituals.ts →
 * runners.forget). Вердикты и план проверки — в чистом staleness.ts, здесь
 * их применение к офису.
 *
 * Запись, которая три недели не подтверждалась, разбирается по маршруту
 * planStalenessCheck:
 * - факт и урок офис проверяет сам: агент только на чтение сверяет их с
 *   кодом, git и доской. «Устарела» с проверяемым основанием — запись
 *   помечается заменённой (пометка T-331) и уходит в архив, в ленте строка с
 *   основанием; «актуальна» — новая дата подтверждения; «не знаю» —
 *   откладывается до следующего прогона;
 * - решения владельца офис не отменяет: все, что пора подтвердить, уходят
 *   ОДНИМ вопросом за прогон со списком и вариантами «Все в силе / Пересмотреть».
 *
 * Разобранная запись запоминается с отпечатком текста и не поднимается
 * снова, пока её не переписали. Записи-противоречия и — без агента проверки —
 * факты забываются по-старому, по датам.
 */
import { OFFICE_SENDER } from '../shared/types';
import type { Fact, OfficeState } from './state';
import { archiveFact, confirmFact, STALE_AFTER_MS } from './journal';
import { officeAsks } from './questions';
import { factIdsIn } from './superseded';
import {
  isFreshnessChecked, markFreshnessChecked, parseFreshnessVerdicts, planStalenessCheck, pruneFreshness,
  summarizeVerdicts, type FreshnessBasis, type FreshnessOutcome, type StalenessHints,
} from './staleness';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Сколько записей агент проверяет за прогон; остальные ждут следующего. */
export const FRESHNESS_BATCH = 12;
/** Сколько решений помещается в один вопрос владельцу. */
export const FRESHNESS_OWNER_MAX = 10;

/** Агент самопроверки: короткая сессия только на чтение, ответ — текст с JSON. */
export type FreshnessChecker = (state: OfficeState, prompt: string) => Promise<{
  text: string; costUsd: number; error?: string;
}>;

export interface FreshnessResult {
  /** Факты, ушедшие из промптов по дате (без агента и записи-противоречия). */
  staled: number;
  /** Ушли в архив: устаревшие по вердикту и протухшие по дате. */
  archived: number;
  /** Подтверждены проверкой. */
  actual: number;
  /** Не проверены: «не знаю» или не влезли в прогон. */
  deferred: number;
  /** Вопросов владельцу: 0 или 1. */
  asked: number;
  costUsd: number;
}

const clip = (s: string, n: number): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

const days = (fact: Fact, now: number): number => Math.max(0, Math.floor((now - fact.confirmedAt) / DAY_MS));

/** Основание словами — для ленты. */
export function basisText(state: OfficeState, basis: FreshnessBasis | undefined): string {
  if (!basis) return '—';
  return state.say(`freshness.basis.${basis.kind}`, { ref: clip(basis.ref, 160) });
}

/** Прогон ритуала свежести. */
export async function runFreshness(
  state: OfficeState, now = Date.now(), check?: FreshnessChecker,
): Promise<FreshnessResult> {
  const result: FreshnessResult = { staled: 0, archived: 0, actual: 0, deferred: 0, asked: 0, costUsd: 0 };
  pruneFreshness(state.life, (id) => {
    const f = state.facts.get(id);
    return Boolean(f) && f!.status !== 'archived';
  });

  const toOwner: Fact[] = [];
  const toSelf: Fact[] = [];
  for (const fact of state.factList()) {
    // Заменённая запись уже не в промптах — она история, проверять в ней нечего.
    if (fact.status === 'archived' || fact.supersededBy) continue;
    if (now - fact.confirmedAt < STALE_AFTER_MS) continue;
    if (fact.kind === 'contradiction' || (fact.kind === 'fact' && !check)) {
      forgetByDate(state, fact, now, result);
      continue;
    }
    if (isFreshnessChecked(state.life, fact)) continue;
    // Без агента урок, как и раньше, спрашивается у владельца.
    if (planStalenessCheck(fact, now).route === 'owner' || !check) toOwner.push(fact);
    else toSelf.push(fact);
  }

  if (toSelf.length && check) await selfCheck(state, toSelf, now, check, result);
  if (toOwner.length) askOwnerOnce(state, toOwner, now, result);
  state.touchLife();
  return result;
}

/** Забывание по датам: живой факт протухает, протухший вдвое дольше — в архив. */
function forgetByDate(state: OfficeState, fact: Fact, now: number, result: FreshnessResult): void {
  if (fact.status === 'live') {
    state.updateFact(fact.id, { status: 'stale' });
    state.addLog(null, 'system', state.say('journal.staleLog', { id: fact.id }));
    result.staled += 1;
  } else if (now - fact.confirmedAt >= 2 * STALE_AFTER_MS) {
    state.updateFact(fact.id, { status: 'archived' });
    state.addLog(null, 'system', state.say('journal.archivedLog', { id: fact.id }));
    result.archived += 1;
  }
}

/** Самопроверка фактов и уроков агентом: самые давние первыми, порцией. */
async function selfCheck(
  state: OfficeState, facts: Fact[], now: number, check: FreshnessChecker, result: FreshnessResult,
): Promise<void> {
  const batch = [...facts].sort((a, b) => a.confirmedAt - b.confirmedAt).slice(0, FRESHNESS_BATCH);
  result.deferred += facts.length - batch.length;
  const answer = await check(state, freshnessPrompt(state, batch, now));
  result.costUsd += answer.costUsd;
  if (answer.error && !answer.text.trim()) {
    state.addLog(null, 'system', state.say('freshness.agentFailed', { error: clip(answer.error, 200) }));
  }
  const ids = new Set(batch.map((f) => f.id));
  const summary = summarizeVerdicts(parseFreshnessVerdicts(answer.text).filter((v) => ids.has(v.factId)));
  const byId = new Map(summary.outcomes.map((o) => [o.factId, o]));
  const confirmed: string[] = [];
  const deferred: string[] = [];
  for (const fact of batch) {
    const outcome = byId.get(fact.id);
    if (outcome?.verdict === 'stale') {
      retire(state, fact, outcome);
      result.archived += 1;
    } else if (outcome?.verdict === 'actual') {
      state.updateFact(fact.id, { confirmedAt: now, status: 'live', askedAt: null });
      markFreshnessChecked(state.life, fact, now);
      confirmed.push(fact.id);
    } else {
      deferred.push(fact.id);
    }
  }
  result.actual += confirmed.length;
  result.deferred += deferred.length;
  if (confirmed.length) state.addLog(null, 'system', state.say('freshness.actualLog', { ids: confirmed.join(', ') }));
  if (deferred.length) state.addLog(null, 'system', state.say('freshness.deferredLog', { ids: deferred.join(', ') }));
}

/**
 * Устаревшая запись: пометка «заменена» тем, что её опровергло (запись,
 * задача, коммит, место в коде), и архив. Из журнала не стирается — остаётся
 * историей; в ленте — почему и чем проверено.
 */
function retire(state: OfficeState, fact: Fact, outcome: FreshnessOutcome): void {
  if (!fact.supersededBy && outcome.basis) state.updateFact(fact.id, { supersededBy: clip(outcome.basis.ref, 80) });
  archiveFact(state, fact.id);
  state.addLog(null, 'system', state.say('freshness.staleLog', {
    id: fact.id, text: clip(fact.text, 120),
    reason: clip(outcome.reason || '—', 300), basis: basisText(state, outcome.basis),
  }));
}

/** Все решения, которые пора подтвердить, — одним вопросом. */
function askOwnerOnce(state: OfficeState, facts: Fact[], now: number, result: FreshnessResult): void {
  const listed = [...facts].sort((a, b) => a.confirmedAt - b.confirmedAt).slice(0, FRESHNESS_OWNER_MAX);
  result.deferred += facts.length - listed.length;
  const rows = listed.map((f) => state.say('freshness.ownerRow', {
    id: f.id, text: clip(f.text, 160), days: days(f, now),
  }));
  officeAsks(state, 'stale', state.say('freshness.ownerQuestion', { list: rows.join('\n') }),
    state.say('journal.staleAssumption'), null,
    [state.say('freshness.optionAll'), state.say('freshness.optionReview')]);
  for (const f of listed) {
    state.updateFact(f.id, { askedAt: now });
    markFreshnessChecked(state.life, f, now);
  }
  result.asked = 1;
}

/** Задание агенту самопроверки: записи с подсказками и задачи с доски. */
export function freshnessPrompt(state: OfficeState, facts: Fact[], now = Date.now()): string {
  const taskIds: string[] = [];
  const rows = facts.map((fact) => {
    const hints = planStalenessCheck(fact, now).hints;
    for (const id of hints.tasks) if (!taskIds.includes(id)) taskIds.push(id);
    return state.say('prompt.freshness.fact', {
      id: fact.id, kind: fact.kind, days: days(fact, now), text: fact.text, hints: hintsText(state, hints),
    });
  });
  const tasks = taskIds.slice(0, 20).flatMap((id) => {
    const task = state.tasks.get(id);
    return task ? [state.say('prompt.resolveContradiction.taskRow', {
      id, title: task.title, status: task.status, result: clip(task.result ?? '', 200) || '—',
    })] : [];
  });
  return state.say('prompt.freshness.task', {
    facts: rows.join('\n\n'),
    tasks: tasks.length ? tasks.join('\n') : state.say('prompt.resolveContradiction.noTasks'),
  });
}

function hintsText(state: OfficeState, hints: StalenessHints): string {
  const parts = [...hints.files, ...hints.symbols, ...hints.tasks, ...hints.facts];
  return parts.length ? parts.join(', ') : state.say('prompt.freshness.noHints');
}

/* ── Ответ владельца ────────────────────────────────────────────────────── */

/** «Все в силе», «да», «всё ещё верно» — без оговорки «пересмотреть». */
const ALL_IN_FORCE = /(^|[^\p{L}])(вс[её]\s+в\s+силе|в\s+силе|да|верно|all\s+in\s+force|in\s+force|still\s+(true|valid)|yes)(?![\p{L}])/iu;
const REVIEW = /(^|[^\p{L}])(пересмотр\p{L}*|не\s+в\s+силе|нет|review|reconsider|revise|no|not)(?![\p{L}])/iu;

export function isAllInForce(answer: string): boolean {
  return ALL_IN_FORCE.test(answer) && !REVIEW.test(answer);
}

/**
 * Владелец ответил на вопрос о свежести. «Все в силе» подтверждает каждое
 * решение из списка и запоминает его разобранным. «Пересмотреть» ничего не
 * меняет: решения остаются в силе, а вопрос с ответом уходит менеджеру —
 * пересмотр его дело. Возвращает id подтверждённых.
 */
export function applyFreshnessAnswer(state: OfficeState, question: { from: string; text: string }, answer: string): string[] {
  if (question.from !== OFFICE_SENDER || !isAllInForce(answer)) return [];
  const done: string[] = [];
  for (const id of factIdsIn(question.text)) {
    const fact = state.facts.get(id);
    if (!fact || !confirmFact(state, id)) continue;
    markFreshnessChecked(state.life, fact);
    done.push(id);
  }
  if (done.length) state.touchLife();
  return done;
}

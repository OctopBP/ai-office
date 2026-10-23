/**
 * Ритуал свежести журнала: раз в неделю, на месте забывания (rituals.ts →
 * runners.forget). Вердикты и план проверки — в чистом staleness.ts, здесь
 * их применение к офису.
 *
 * Запись, которая три недели не подтверждалась, офис проверяет сам: агент
 * только на чтение сверяет факт, урок и решение с кодом, git, доской и
 * журналом.
 * - «Устарела» с проверяемым основанием — запись помечается заменённой
 *   (пометка T-331) и уходит в архив, в ленте строка с основанием. Для
 *   решения это значит «явно устарело»: его заменила более новая запись или
 *   снят повод, ради которого его принимали.
 * - «Актуальна» — новая дата подтверждения; решение соблюдается, владельца
 *   не спрашиваем.
 * - «Описание реализации» (только решение) — запись не выбор владельца, а
 *   рассказ о том, как сделан код: она становится фактом и дальше
 *   проверяется как факт.
 * - «Противоречие» с основанием (только решение) — единственный повод
 *   спросить владельца: по вопросу на запись, с сутью расхождения и
 *   основанием, варианты «В силе / Пересмотреть».
 * - «Не знаю» — откладывается до следующего прогона.
 *
 * Решение от одного лишь возраста владельцу не уходит (T-690): нет агента
 * проверки — решения и уроки ждут следующего прогона. Разобранная запись
 * запоминается с отпечатком текста и не поднимается снова, пока её не
 * переписали. Записи-противоречия и — без агента проверки — факты
 * забываются по-старому, по датам.
 */
import { OFFICE_SENDER } from '../shared/types';
import type { Fact, OfficeState } from './state';
import { archiveFact, confirmFact, STALE_AFTER_MS } from './journal';
import { officeAsks } from './questions';
import { factIdsIn } from './superseded';
import {
  isFreshnessChecked, markFreshnessChecked, parseFreshnessVerdicts, planStalenessCheck, pruneFreshness,
  summarizeVerdicts, verdictForKind, type FreshnessBasis, type FreshnessOutcome, type StalenessHints,
} from './staleness';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Сколько записей агент проверяет за прогон; остальные ждут следующего. */
export const FRESHNESS_BATCH = 12;

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
  /** Решения, оказавшиеся описанием реализации, — переведены в факты. */
  converted: number;
  /** Не проверены: «не знаю», не влезли в прогон или нет агента проверки. */
  deferred: number;
  /** Вопросов владельцу: по одному на решение с найденным противоречием. */
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
  const result: FreshnessResult = { staled: 0, archived: 0, actual: 0, converted: 0, deferred: 0, asked: 0, costUsd: 0 };
  pruneFreshness(state.life, (id) => {
    const f = state.facts.get(id);
    return Boolean(f) && f!.status !== 'archived';
  });

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
    // Без агента решения и уроки ждут: возраст — не повод спрашивать владельца.
    if (!check || planStalenessCheck(fact, now).route !== 'self') {
      result.deferred += 1;
      continue;
    }
    toSelf.push(fact);
  }

  if (toSelf.length && check) await selfCheck(state, toSelf, now, check, result);
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

/** Самопроверка фактов, уроков и решений агентом: самые давние первыми, порцией. */
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
  const contradicted: Array<{ fact: Fact; outcome: FreshnessOutcome }> = [];
  for (const fact of batch) {
    const found = byId.get(fact.id);
    const outcome = found && verdictForKind(found, fact.kind);
    if (outcome?.verdict === 'stale') {
      retire(state, fact, outcome);
      result.archived += 1;
    } else if (outcome?.verdict === 'actual') {
      state.updateFact(fact.id, { confirmedAt: now, status: 'live', askedAt: null });
      markFreshnessChecked(state.life, fact, now);
      confirmed.push(fact.id);
    } else if (outcome?.verdict === 'implementation') {
      toFact(state, fact, outcome, now);
      result.converted += 1;
    } else if (outcome?.verdict === 'contradicted') {
      contradicted.push({ fact, outcome });
    } else {
      deferred.push(fact.id);
    }
  }
  for (const { fact, outcome } of contradicted) askContradiction(state, fact, outcome, now);
  result.asked += contradicted.length;
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

/**
 * Решение оказалось описанием реализации: запись становится фактом с новой
 * датой. Разобранной её не отмечаем — через срок она проверится как факт.
 */
function toFact(state: OfficeState, fact: Fact, outcome: FreshnessOutcome, now: number): void {
  state.updateFact(fact.id, { kind: 'fact', confirmedAt: now, status: 'live', askedAt: null });
  state.addLog(null, 'system', state.say('freshness.implementationLog', {
    id: fact.id, text: clip(fact.text, 120), reason: clip(outcome.reason || '—', 300),
  }));
}

/**
 * Решение расходится с кодом, доской или более новой записью — вопрос
 * владельцу про одну эту запись: сама запись, суть противоречия и основание.
 */
function askContradiction(state: OfficeState, fact: Fact, outcome: FreshnessOutcome, now: number): void {
  const reason = clip(outcome.reason || '—', 300);
  const basis = basisText(state, outcome.basis);
  const options = [state.say('freshness.optionInForce'), state.say('freshness.optionReview')];
  officeAsks(state, 'stale', state.say('freshness.conflictQuestion', {
    id: fact.id, text: clip(fact.text, 300), reason, basis,
  }), state.say('journal.staleAssumption'), null, options, {
    title: state.say('freshness.conflictTitle', { text: clip(fact.text, 80) }),
    quotes: [{ ref: fact.id, text: fact.text, note: state.say('freshness.quoteNote', { days: days(fact, now) }) }],
    basis: state.say('freshness.conflictBasis', { reason, basis }),
    refs: [{ kind: 'journal' as const, id: fact.id }, ...basisRef(outcome.basis)],
    groupKey: 'journal-freshness',
    groupTitle: state.say('freshness.groupTitle'),
    groupOptions: options,
  });
  state.updateFact(fact.id, { askedAt: now });
  markFreshnessChecked(state.life, fact, now);
}

/** Основание чипом в подробностях вопроса: запись, задача, коммит или файл. */
function basisRef(basis: FreshnessBasis | undefined): Array<{ kind: 'journal' | 'task' | 'commit' | 'file'; id: string }> {
  if (!basis) return [];
  const kind = ({ newer: 'journal', task: 'task', git: 'commit', code: 'file' } as const)[basis.kind];
  // У кода основание бывает «файл:символ» — чип ведёт на файл.
  const id = basis.kind === 'code' ? basis.ref.split(':')[0] : basis.ref;
  return [{ kind, id }];
}

/** Задание агенту самопроверки: записи с подсказками и задачи с доски. */
export function freshnessPrompt(state: OfficeState, facts: Fact[], now = Date.now()): string {
  const taskIds: string[] = [];
  const rows = facts.map((fact) => {
    const hints = planStalenessCheck(fact, now).hints;
    for (const id of hints.tasks) if (!taskIds.includes(id)) taskIds.push(id);
    // Задачи из основания урока — в общий список с доски, как и подсказки.
    for (const id of fact.evidence ?? []) if (/^T-\d+$/.test(id) && !taskIds.includes(id)) taskIds.push(id);
    return state.say('prompt.freshness.fact', {
      id: fact.id, kind: fact.kind, days: days(fact, now), text: fact.text, hints: hintsText(state, hints),
    }) + lessonText(state, fact);
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

/**
 * Урок проверяется по его основанию (T-665): агент сверяет, держится ли ещё
 * то, на что урок ссылается. Нет основания — так и сказано, проверка по тексту.
 */
function lessonText(state: OfficeState, fact: Fact): string {
  if (fact.kind !== 'lesson') return '';
  const parts: string[] = [];
  if (fact.cue) parts.push(state.say('prompt.freshness.cue', { cue: fact.cue }));
  parts.push(fact.evidence?.length
    ? state.say('prompt.freshness.evidence', { refs: fact.evidence.join(', ') })
    : state.say('prompt.freshness.noEvidence'));
  return `\n${parts.join('\n')}`;
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
 * Владелец ответил на вопрос о свежести. «В силе» подтверждает решение из
 * вопроса и запоминает его разобранным. «Пересмотреть» ничего не меняет:
 * решение остаётся в силе, а вопрос с ответом уходит менеджеру — пересмотр
 * его дело. Возвращает id подтверждённых.
 *
 * Какие записи подтверждать — по цитатам вопроса: в тексте есть и
 * основание, а запись-основание ответ владельца не подтверждает. Вопросы без
 * цитат (заданные до них) разбираются по номерам в тексте.
 */
export function applyFreshnessAnswer(
  state: OfficeState, question: { from: string; text: string; quotes?: Array<{ ref: string }> }, answer: string,
): string[] {
  if (question.from !== OFFICE_SENDER || !isAllInForce(answer)) return [];
  const quoted = (question.quotes ?? []).map((q) => q.ref).filter((ref) => /^J-\d+$/.test(ref));
  const done: string[] = [];
  for (const id of quoted.length ? quoted : factIdsIn(question.text)) {
    const fact = state.facts.get(id);
    if (!fact || !confirmFact(state, id)) continue;
    markFreshnessChecked(state.life, fact);
    done.push(id);
  }
  if (done.length) state.touchLife();
  return done;
}

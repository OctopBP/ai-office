/**
 * Ритуалы офиса (docs/design/living-office/spec.md §5): то, что офис делает
 * не по задаче, а по расписанию, глядя на самого себя.
 *
 * Офис — не демон. Он живёт, пока запущен, и «ночью» его чаще всего нет.
 * Поэтому расписание не кроновое, а событийное: ритуалы гоняет надзор тем же
 * проходом, что и ветки, на «тихом тике» — когда в офисе никто не работает и
 * событий не было N минут. Правила общие для всех:
 *
 * - нет дельты — нет ритуала: пустой день не консолидируется;
 * - лимиты подписки выше ритуалов: за порогом они откладываются, работа по
 *   задачам — нет;
 * - за проход идёт не больше одного ритуала, и не поверх идущего;
 * - каждый прогон — запись RitualRun, чтобы портфель (§8.2) видел, что
 *   ритуалы дали.
 *
 * Планёрка — единственный ритуал, который смотрит вперёд, и единственный,
 * которому не нужна модель. Показывается при первом открытии офиса за день —
 * первом снапшоте, ушедшем клиенту в этот день.
 *
 * Модель здесь не вызывается: ритуалы знают только, что кто-то умеет
 * «консолидировать» и «найти противоречия» (RitualAgents). Настоящую
 * реализацию ставит agents.ts, проверки — свою.
 */
import { dayKey, limitReset, OFFICE_SENDER } from '../shared/types';
import type { OwnerQuestion, RitualId, RitualRun } from '../shared/types';
import { LANG_LOCALE } from '../shared/i18n';
import type { Fact, OfficeState, Task } from './state';
import { forget, STALE_AFTER_MS } from './journal';
import { officeAsks, pickForStandup } from './questions';
import { limitsView } from './limits';
import { tellPm } from './review';

/** Если планёрки ещё не было ни разу — «с прошлой» значит «за сутки». */
const FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Сколько тишины считается тихим тиком. */
export const QUIET_MS = 5 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** С какого объёма журнала есть что сверять на противоречия. */
const CONTRADICTIONS_MIN_FACTS = 5;

const clip = (s: string, n = 120): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

// ------------------------------------------------------------- агенты

/** Что консолидация получает на вход: дельта с прошлого прогона. */
export interface ConsolidationInput {
  since: number;
  /** Закрытые за это время задачи с исходом и отчётом. */
  closed: Array<{ id: string; title: string; roleId: string; kind: string; result: string; reviews: string[] }>;
  /** Что говорили человек и менеджер. */
  chat: Array<{ from: string; text: string }>;
  /** Живой журнал — чтобы новое сверялось со старым. */
  facts: Fact[];
}

/** Что ритуал на модели произвёл. Один формат на консолидацию и противоречия. */
export interface RitualOutput {
  facts: Array<{ kind: 'fact' | 'decision' | 'lesson'; text: string; scope: string; taskId?: string }>;
  contradictions: Array<{ a: string; b: string; text: string }>;
  questions: Array<{ text: string; assumption: string }>;
  costUsd: number;
  error?: string;
}

export interface RitualAgents {
  consolidate(state: OfficeState, input: ConsolidationInput): Promise<RitualOutput>;
  contradictions(state: OfficeState, facts: Fact[]): Promise<RitualOutput>;
}

const emptyOutput = (): RitualOutput => ({ facts: [], contradictions: [], questions: [], costUsd: 0 });

let agents: RitualAgents = {
  async consolidate() { return emptyOutput(); },
  async contradictions() { return emptyOutput(); },
};

export function setRitualAgents(next: RitualAgents): void {
  agents = next;
}

// ------------------------------------------------------------ планёрка

/** Пора ли показывать планёрку: день сменился с прошлой. */
export const standupDue = (state: OfficeState, now = Date.now()): boolean =>
  state.life.standupDay !== dayKey(now);

/**
 * Текст планёрки из данных доски: что ждёт человека, что офис сделал сам с
 * прошлого раза, что встало, вопросы дня. Пустые разделы не печатаются —
 * сообщение должно читаться за десять секунд, иначе его перестанут читать вовсе.
 *
 * `questions` — порция, уже отобранная и помеченная показанной: сам текст
 * ничего в состоянии не меняет, чтобы его можно было собрать для проверки.
 */
export function standupText(state: OfficeState, now = Date.now(), questions: OwnerQuestion[] = []): string {
  const say = state.say.bind(state);
  const tasks = [...state.tasks.values()];
  const lines: string[] = [say('life.standup.head', {
    date: new Date(now).toLocaleDateString(LANG_LOCALE[state.lang()], {
      weekday: 'long', day: 'numeric', month: 'long',
    }),
  })];

  // 1. Что ждёт именно человека: без него это не сдвинется.
  const waiting: string[] = [];
  const permissions = state.pendingRequests().length;
  if (permissions) waiting.push(say('life.standup.permissions', { n: permissions }));
  const unmerged = tasks.filter((t) => t.status === 'done' && t.branch && !t.merged).length;
  if (unmerged && !state.settings.autoPipeline) waiting.push(say('life.standup.unmerged', { n: unmerged }));
  for (const epic of state.epicList()) {
    if (epic.status === 'planned' && !epic.approved) {
      waiting.push(say('life.standup.approval', { epic: epic.id, title: epic.title }));
    }
  }
  if (waiting.length) lines.push('', say('life.standup.waiting'), ...waiting);

  // 2. Что случилось с прошлой планёрки — по исходам, а не по статусам.
  const since = state.life.standupAt ?? now - FIRST_WINDOW_MS;
  const closed = tasks.filter((t) => t.outcome && t.outcome.at >= since).map((t) => t.outcome!);
  const count = (kind: string) => closed.filter((o) => o.kind === kind).length;
  const delivered = count('clean') + count('reworked') + count('stuck');
  const done: string[] = [];
  if (delivered) {
    done.push(say('life.standup.closed', {
      n: delivered, clean: count('clean'), reworked: count('reworked'), stuck: count('stuck'),
    }));
  }
  if (count('failed')) done.push(say('life.standup.failed', { n: count('failed') }));
  if (count('reverted')) done.push(say('life.standup.reverted', { n: count('reverted') }));
  const byOffice = closed.filter((o) => o.origin === 'office').length;
  if (byOffice) done.push(say('life.standup.byOffice', { n: byOffice }));
  if (done.length) lines.push('', say('life.standup.since'), ...done);

  // 3. Что встало: конвейер сам дальше не поедет.
  const stuck = [...state.prs.values()].filter((pr) => pr.stage === 'stuck');
  if (stuck.length) {
    lines.push('', say('life.standup.stuckHead'), ...stuck.map((pr) => say('life.standup.stuckRow', {
      task: pr.taskId, title: pr.title, note: clip(pr.note),
    })));
  }

  // 4. Вопросы дня — порция, не очередь целиком.
  if (questions.length) {
    lines.push('', say('questions.standupHead'), ...questions.map((q) => {
      const who = q.from === OFFICE_SENDER ? say('common.officeItself') : q.from;
      const settled = q.taskId && state.tasks.get(q.taskId)?.outcome?.kind === 'clean';
      return say(settled ? 'questions.standupSettled' : 'questions.standupRow', {
        id: q.id, who, text: q.text, assumption: q.assumption,
      });
    }));
  }

  if (lines.length === 1) lines.push(say('life.standup.quiet'));
  return lines.join('\n');
}

/**
 * Показать планёрку и запомнить, что сегодня она была. Менеджера просим
 * добавить фразу только если портфель это разрешает и лимиты не на грани:
 * в лимитах первой уходит именно эта фраза.
 */
export function runStandup(state: OfficeState, now = Date.now()): string {
  const questions = pickForStandup(state, state.life.policy.questionsPerStandup, now);
  const text = standupText(state, now, questions);
  state.addChat(OFFICE_SENDER, text);
  state.addLog(null, 'system', state.say('life.standup.log'));
  state.touchLife({ standupDay: dayKey(now), standupAt: now });
  state.noteRitualRun({
    ritual: 'standup', at: now, costUsd: 0,
    produced: { questions: questions.length }, note: '',
  });
  if (state.life.policy.standupPmLine && state.settings.ritualsEnabled !== false
      && !limitsBusy(state) && !state.dryRun) {
    tellPm(state, state.say('ritual.standupPm', { text }));
  }
  return text;
}

/**
 * Офис открыли — кто-то на него смотрит. Первый взгляд за день получает
 * планёрку; остальные — ничего: это не приветствие, а сводка.
 */
export function noteOfficeViewed(state: OfficeState, now = Date.now()): void {
  if (!state.opened) return;
  if (standupDue(state, now)) runStandup(state, now);
}

// ------------------------------------------------------------- расписание

/** Окно подписки съедено за порог — ритуалы на модели откладываются. */
export function limitsBusy(state: OfficeState, now = Date.now()): { percent: number } | null {
  const threshold = state.ritualLimit();
  const limits = limitsView();
  if (!limits.available) return null;
  const hot = limits.windows.find((w) => w.utilization >= threshold && !limitReset(w, now));
  return hot ? { percent: Math.round(hot.utilization) } : null;
}

/** Тихо ли в офисе: сессий нет, событий не было QUIET_MS. */
export const quiet = (state: OfficeState, now = Date.now()): boolean =>
  state.running === 0 && !state.meetingRunning && state.talks.size === 0
  && now - state.lastWorkAt >= QUIET_MS;

/** Дельта с прошлой консолидации: закрытые задачи и разговоры. */
function consolidationInput(state: OfficeState): ConsolidationInput {
  const since = state.life.lastRun.consolidate ?? 0;
  const closed = [...state.tasks.values()]
    .filter((t) => t.outcome && t.outcome.at > since)
    .map((t) => ({
      id: t.id, title: t.title, roleId: t.roleId ?? '', kind: t.outcome!.kind,
      result: clip(t.result ?? '', 400),
      reviews: (state.prOf(t.id)?.reviews ?? []).map((r) => clip(r.text, 300)),
    }));
  const chat = state.chat
    .filter((c) => c.at > since && c.thread === 'pm#1' && c.from !== OFFICE_SENDER)
    .map((c) => ({ from: c.from, text: clip(c.text, 400) }));
  const facts = state.factList().filter((f) => f.status === 'live');
  return { since, closed, chat, facts };
}

const hasDelta = (input: ConsolidationInput): boolean => input.closed.length > 0 || input.chat.length > 0;

/** Ритуал, которому пора. null — ничего не пора. Порядок — по дешевизне. */
export function dueRitual(state: OfficeState, now = Date.now()): RitualId | null {
  if (state.settings.ritualsEnabled === false || state.paused || state.ritualRunning) return null;
  const last = state.life.lastRun;
  // Забывание — без модели и без тишины: смотрит только на даты.
  if (now - (last.forget ?? 0) >= WEEK_MS && state.facts.size > 0) return 'forget';
  if (!quiet(state, now)) return null;
  if (now - (last.consolidate ?? 0) >= state.life.policy.consolidateEveryMs
      && hasDelta(consolidationInput(state))) return 'consolidate';
  if (now - (last.contradictions ?? 0) >= WEEK_MS
      && state.factList().filter((f) => f.status === 'live').length >= CONTRADICTIONS_MIN_FACTS) {
    return 'contradictions';
  }
  return null;
}

/**
 * Проход расписания — из надзора. Один ритуал за проход: ритуал на модели
 * длится, и второй поверх него удвоил бы расход ради той же дельты.
 */
export async function tickRituals(state: OfficeState, now = Date.now()): Promise<void> {
  const due = dueRitual(state, now);
  if (!due) return;
  await runRitual(state, due, now);
}

/**
 * Запустить ритуал сейчас — по расписанию или по кнопке. Ритуалы на модели
 * уважают порог лимита; по кнопке тоже: кнопка — не повод сжечь остаток окна.
 */
export async function runRitual(state: OfficeState, ritual: RitualId, now = Date.now()): Promise<RitualRun | null> {
  if (state.ritualRunning) return null;
  if (ritual === 'standup') {
    runStandup(state, now);
    return state.life.runs[state.life.runs.length - 1] ?? null;
  }
  const needsModel = ritual === 'consolidate' || ritual === 'contradictions' || ritual === 'reflect';
  const hot = needsModel ? limitsBusy(state, now) : null;
  if (hot) {
    state.addLog(null, 'system', state.say('ritual.deferredLog', {
      ritual: state.say(`ritual.name.${ritual}`), percent: hot.percent, threshold: state.ritualLimit(),
    }));
    // Отложенный ритуал не забывается, но и не долбится каждую минуту.
    state.life.lastRun[ritual] = now - WEEK_MS + 60 * 60 * 1000;
    return null;
  }

  state.ritualRunning = ritual;
  state.emitLife();
  state.addLog(null, 'system', state.say('ritual.startLog', { ritual: state.say(`ritual.name.${ritual}`) }));
  try {
    const run = await runners[ritual](state, now);
    state.addLog(null, 'system', state.say('ritual.doneLog', {
      ritual: state.say(`ritual.name.${ritual}`), note: run.note, cost: run.costUsd.toFixed(3),
    }));
    return state.noteRitualRun(run);
  } catch (err) {
    state.addLog(null, 'error', state.say('ritual.failedLog', {
      ritual: state.say(`ritual.name.${ritual}`), error: (err as Error).message,
    }));
    return state.noteRitualRun({
      ritual, at: now, costUsd: 0, produced: {}, note: (err as Error).message,
    });
  } finally {
    state.ritualRunning = null;
    state.emitLife();
  }
}

type Runner = (state: OfficeState, now: number) => Promise<Omit<RitualRun, 'id'>>;

/** Положить то, что ритуал произвёл: записи, противоречия, вопросы. */
function applyOutput(state: OfficeState, ritual: RitualId, out: RitualOutput): Record<string, number> {
  let facts = 0;
  for (const f of out.facts) {
    if (!f.text.trim()) continue;
    const fact = state.addFact({
      kind: f.kind, text: f.text, scope: f.scope || 'project',
      source: { ritual, ...(f.taskId ? { taskId: f.taskId } : {}) },
    });
    state.addLog(null, 'system', state.say('journal.noted', { id: fact.id, text: clip(fact.text) }));
    facts += 1;
  }
  let contradictions = 0;
  for (const c of out.contradictions) {
    if (!c.a.trim() || !c.b.trim()) continue;
    state.addFact({ kind: 'contradiction', text: c.text || `${c.a} ≠ ${c.b}`, scope: 'office', source: { ritual } });
    officeAsks(state, 'contradiction',
      state.say('questions.contradiction', { a: clip(c.a, 160), b: clip(c.b, 160) }),
      state.say('questions.contradictionAssumption'));
    contradictions += 1;
  }
  let questions = 0;
  for (const q of out.questions) {
    if (!q.text.trim()) continue;
    officeAsks(state, 'assumption', q.text, q.assumption);
    questions += 1;
  }
  return { facts, contradictions, questions };
}

const runners: Record<RitualId, Runner> = {
  async standup(state, now) {
    runStandup(state, now);
    return { ritual: 'standup', at: now, costUsd: 0, produced: {}, note: '' };
  },

  async consolidate(state, now) {
    const input = consolidationInput(state);
    const out = await agents.consolidate(state, input);
    if (out.error) throw new Error(out.error);
    const produced = applyOutput(state, 'consolidate', out);
    return {
      ritual: 'consolidate', at: now, costUsd: out.costUsd, produced,
      note: state.say('ritual.consolidate.note', produced),
    };
  },

  async contradictions(state, now) {
    const facts = state.factList().filter((f) => f.status === 'live' && f.kind !== 'contradiction');
    const out = await agents.contradictions(state, facts);
    if (out.error) throw new Error(out.error);
    const produced = applyOutput(state, 'contradictions', out);
    return {
      ritual: 'contradictions', at: now, costUsd: out.costUsd, produced,
      note: state.say('ritual.contradictions.note', produced),
    };
  },

  async forget(state, now) {
    const result = forget(state, now);
    for (const f of result.staled) state.addLog(null, 'system', state.say('journal.staleLog', { id: f.id }));
    for (const f of result.archived) state.addLog(null, 'system', state.say('journal.archivedLog', { id: f.id }));
    for (const f of result.toAsk) {
      officeAsks(state, 'stale', state.say('journal.staleQuestion', {
        text: clip(f.text, 200), id: f.id, days: Math.round((now - f.confirmedAt) / 86_400_000),
      }), state.say('journal.staleAssumption'));
    }
    const produced = { staled: result.staled.length, archived: result.archived.length, asked: result.toAsk.length };
    return {
      ritual: 'forget', at: now, costUsd: 0, produced,
      note: state.say('ritual.forget.note', produced),
    };
  },

  // Рефлексия и здоровье проекта — следующие фазы: пока ничего не делают,
  // но расписание про них знает, чтобы не менять форму записи потом.
  async reflect(_state, now) {
    return { ritual: 'reflect', at: now, costUsd: 0, produced: {}, note: '' };
  },
  async health(_state, now) {
    return { ritual: 'health', at: now, costUsd: 0, produced: {}, note: '' };
  },
};

/**
 * Откат — повод спросить, а не переделывать: до ответа владельца офис не
 * знает, что именно было не так. Один вопрос на задачу.
 */
export function askAboutReverts(state: OfficeState, tasks: Task[]): void {
  for (const task of tasks) {
    const asked = state.questionList().some((q) => q.kind === 'revert' && q.taskId === task.id);
    if (asked) continue;
    officeAsks(state, 'revert',
      state.say('questions.revert', { task: task.id, title: task.title }),
      state.say('questions.revertAssumption'), task.id);
  }
}

export { STALE_AFTER_MS };

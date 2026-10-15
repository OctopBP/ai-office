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
import type { WorkflowNode } from '../shared/workflow';
import { builtinWorkflows } from './workflows';
import { drive, newRun, type Executor } from './runs';
import { dayKey, HEALTH_DIRECTION, limitReset, OFFICE_SENDER } from '../shared/types';
import type { BranchMark, FactView, HealthEntry, OwnerQuestion, RitualId, RitualRun } from '../shared/types';
import { LANG_LOCALE } from '../shared/i18n';
import { roleReports, WEEK_MS as REPORT_WEEK_MS, type RoleReport } from '../shared/report';
import { toTaskView, type Fact, type OfficeState, type Task } from './state';
import { archiveFact, STALE_AFTER_MS, supersedeFacts } from './journal';
import { runFreshness } from './freshness';
import { tidyOffice } from './tidy';
import { factIdsIn, isPromptable } from './superseded';
import {
  buildResolvePrompt, decideContradiction, isOwnerDecision, isPairResolved, markPairResolved, observationKey,
  OBSERVATION_ID, parseVerdict, taskIdsIn,
  type ContradictionVerdict, type TaskNote,
} from './contradictions';
import { findPriorContradiction, repeatedQuestions } from './contradiction-history';
import {
  askOwner, dismissQuestion, ensureDelegateOptions, officeAsks, openQuestions, pickForStandup, setContradictionDelegate,
} from './questions';
import { limitsView } from './limits';
import { tellPm } from './review';
import { runTypecheck } from './merge';
import { officeHealth } from './health';
import { isRepo } from './git';
import { planSummary } from './plan';
import { pendingProposals, proposeFeature, type FeatureProposal } from './initiatives';

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
  questions: Array<{ text: string; assumption: string; options?: string[]; replaces?: string[] }>;
  costUsd: number;
  error?: string;
}

/** Что рефлексия получает: неделя офиса в цифрах и текстах (§5.5). */
export interface ReflectionInput {
  since: number;
  reports: RoleReport[];
  /** Замечания ревьюера по переделанным задачам недели. */
  reviews: Array<{ taskId: string; title: string; roleId: string; text: string }>;
  rituals: { runs: number; costUsd: number };
  questions: OwnerQuestion[];
  directions: Array<{ id: string; text: string; active: boolean }>;
  plan: string;
  facts: Fact[];
}

/** Что рефлексия произвела сверх общего: фичи, правила и итог для владельца. */
export interface ReflectionOutput extends RitualOutput {
  features: FeatureProposal[];
  /** Правила из повторов (§5.5, §8.1) — становятся предложениями владельцу. */
  rules: Array<{ roleId: string; text: string; rationale: string }>;
  summary: string;
}

/** Ответ агента разбора противоречия: сырой текст, который разбирает parseVerdict. */
export interface ResolveOutput {
  text: string;
  costUsd: number;
  error?: string;
}

export interface RitualAgents {
  consolidate(state: OfficeState, input: ConsolidationInput): Promise<RitualOutput>;
  contradictions(state: OfficeState, facts: Fact[]): Promise<RitualOutput>;
  reflect(state: OfficeState, input: ReflectionInput): Promise<ReflectionOutput>;
  /**
   * Разбор одной пары записей по коду, git и доске — только чтение. Нет
   * агента — пара считается неразобранной и уходит владельцу.
   */
  resolveContradiction?(state: OfficeState, prompt: string): Promise<ResolveOutput>;
  /**
   * Самопроверка свежести фактов и уроков по коду, git и доске — только
   * чтение (freshness.ts). Нет агента — факты забываются по датам, уроки
   * уходят владельцу.
   */
  checkFreshness?(state: OfficeState, prompt: string): Promise<ResolveOutput>;
}

const emptyOutput = (): RitualOutput => ({ facts: [], contradictions: [], questions: [], costUsd: 0 });

let agents: RitualAgents = {
  async consolidate() { return emptyOutput(); },
  async contradictions() { return emptyOutput(); },
  async reflect() { return { ...emptyOutput(), features: [], rules: [], summary: '' }; },
};

export function setRitualAgents(next: RitualAgents): void {
  agents = next;
}

// ------------------------------------------------------------ планёрка

/**
 * Пора ли показывать планёрку: день сменился с прошлой. Архивному офису не
 * пора никогда — он не поднимается, а если его успели увидеть до выгрузки,
 * сводка о работе, которой не будет, только сбивает с толку.
 */
export const standupDue = (state: OfficeState, now = Date.now()): boolean =>
  !state.archived && state.life.standupDay !== dayKey(now);

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
    if (epic.status !== 'planned' || epic.approved) continue;
    // Инициативу офиса называем инициативой: владелец должен видеть, что
    // это предложил не он, и почему.
    waiting.push(epic.origin === 'office'
      ? say('life.standup.initiative', { epic: epic.id, title: epic.title, rationale: epic.rationale })
      : say('life.standup.approval', { epic: epic.id, title: epic.title }));
  }
  const proposals = pendingProposals(state);
  if (proposals.length) {
    waiting.push(say('life.standup.proposals'), ...proposals.map((p) => say('life.standup.proposalRow', {
      id: p.id, kind: say(`proposal.kind.${p.kind}`), title: p.title, rationale: clip(p.rationale),
    })));
  }
  if (waiting.length) lines.push('', say('life.standup.waiting'), ...waiting);

  // 1½. Итог рефлексии, если она была после прошлой планёрки.
  if (state.life.reflection && (state.life.reflectionAt ?? 0) > (state.life.standupAt ?? 0)) {
    lines.push('', say('reflect.standup'), state.life.reflection);
  }

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
      && state.officeRuntime() && !limitsBusy(state) && !state.dryRun) {
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
  const runtime = state.officeRuntime();
  // Провайдер не выбран — и лимитов считать не по чему; ритуалы на модели
  // отсечёт runRitual, планёрка без фразы менеджера проверку делает сама.
  if (!runtime) return null;
  const limits = limitsView(runtime.provider);
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
  if (state.settings.ritualsEnabled === false || state.paused || state.archived
      || state.ritualRunning) return null;
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
  // Здоровье проекта — раз в сутки, без модели: проверки и протухшие ветки.
  if (now - (last.health ?? 0) >= HEALTH_EVERY_MS && state.tasks.size > 0) return 'health';
  // Разбор завалов — раз в сутки, без модели, и только когда в сводке правда
  // что-то есть: пустая сводка не повод даже начинать прогон.
  if (now - (last.triage ?? 0) >= TRIAGE_EVERY_MS && hasTriageWork(state, now)) return 'triage';
  // Рефлексия — раз в неделю, после забывания, и только если за неделю есть
  // исходы: рефлексировать над пустой неделей не над чем.
  if (state.life.policy.reflectionOn && now - (last.reflect ?? 0) >= WEEK_MS
      && [...state.tasks.values()].some((t) => t.outcome && t.outcome.at >= now - WEEK_MS)) {
    return 'reflect';
  }
  return null;
}

/** Как часто офис смотрит на здоровье проекта. */
const HEALTH_EVERY_MS = 24 * 60 * 60 * 1000;
/** Как часто офис разбирает завалы. */
const TRIAGE_EVERY_MS = 24 * 60 * 60 * 1000;

// -------------------------------------------------- разбор завалов

/**
 * Что разбору завалов есть делать прямо сейчас.
 *
 * Провалы берутся из сводки здоровья как есть: там они ровно те, про которые
 * в журнале нет ни строчки. Ветки — не как есть: сводка законно держит и
 * ветки идущих задач (ветка третьего дня работы правда расходится с основной),
 * но разбирать в них нечего. Метка «слить или удалить» на живой ветке — это
 * врезка в чужую работу, поэтому здесь остаются только закрытые задачи.
 */
export interface TriageWork {
  failures: HealthEntry[];
  branches: Array<{ task: Task; mark: BranchMark; days: number }>;
}

export function triageWork(state: OfficeState, now = Date.now()): TriageWork {
  const health = officeHealth(state, now);
  const branches: TriageWork['branches'] = [];
  for (const item of health.branches) {
    const task = state.tasks.get(item.taskId);
    if (!task || !task.branch) continue;
    // Задача ещё в работе — ветка не наша забота.
    if (task.status !== 'done' && task.status !== 'failed') continue;
    // Уже помечена: разбор не переставляет метку по кругу и не шумит второй раз.
    if (task.branchMark) continue;
    branches.push({ task, mark: markFor(task), days: Math.floor(item.ageMs / 86_400_000) });
  }
  return { failures: health.failures, branches };
}

const hasTriageWork = (state: OfficeState, now: number): boolean => {
  const work = triageWork(state, now);
  return work.failures.length > 0 || work.branches.length > 0;
};

/**
 * Что делать с повисшей веткой: работа сдана — слить, не сдана — удалить.
 * Метка и есть весь результат: веток офис не сливает и не удаляет сам —
 * автоматического слияния в проекте нет, решение за владельцем.
 */
const markFor = (task: Task): BranchMark =>
  task.status === 'done' && task.outcome?.kind !== 'failed' && task.outcome?.kind !== 'reverted'
    ? 'merge'
    : 'drop';

/**
 * Провал, который стоит вернуть в план: работу не забраковали — её оборвало
 * снаружи, лимитом плана или перезапуском сервера. Откат и вердикт ревьюера
 * офис вторым заходом не отменяет: это решение человека, а не сбой.
 */
const retryable = (task: Task): boolean =>
  task.outcome?.kind !== 'reverted' && (task.limitedAt !== null || task.interrupted);

/** Причина провала — из того, что доска и так знает. Модель не нужна. */
function failureReason(state: OfficeState, task: Task): string {
  if (task.outcome?.kind === 'reverted') return state.say('triage.reason.reverted');
  if (task.limitedAt) return state.say('triage.reason.limit');
  if (task.interrupted) return state.say('triage.reason.interrupted');
  if (task.compactions >= 2) return state.say('triage.reason.compacting', { n: task.compactions });
  const changes = (state.prOf(task.id)?.reviews ?? []).filter((r) => r.verdict === 'changes').pop();
  if (changes) return state.say('triage.reason.review', { text: clip(changes.text, 200) });
  if (task.result?.trim()) return state.say('triage.reason.result', { text: clip(task.result, 200) });
  return state.say('triage.reason.unknown');
}

/**
 * Вернуть задачу в план — вторым заходом, а не воскрешением прежней: у той
 * есть исход, ветка и своя история, и переписывать их значило бы соврать
 * табелю роли. Идёт по направлению здоровья, то есть как обязанность офиса,
 * а не как инициатива.
 */
function returnToPlan(state: OfficeState, task: Task, reason: string): boolean {
  const roles = state.workerRoles();
  const role = roles.find((r) => r.id === task.roleId) ?? roles[0];
  if (!role) return false;
  const criteria = task.criteria.map((c) => c.text.trim()).filter(Boolean);
  const made = proposeFeature(state, {
    title: state.say('triage.retryTitle', { task: task.id, title: clip(task.title, 60) }),
    goal: state.say('triage.retryGoal', { task: task.id, title: clip(task.title, 60) }),
    rationale: state.say('triage.retryRationale', { task: task.id, reason }),
    directionId: HEALTH_DIRECTION,
    tasks: [{
      key: 'retry',
      title: task.title,
      description: state.say('triage.retryDesc', {
        task: task.id, reason, description: clip(task.description, 1500),
      }),
      acceptanceCriteria: criteria.length ? criteria : [state.say('triage.retryCriterion')],
      roleId: role.id,
    }],
  });
  if (!made.ok) state.addLog(null, 'system', made.message);
  return made.ok;
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
  // Архив держим и здесь, а не только в расписании: ритуал запускают ещё и по
  // кнопке, а по архивному офису не должно идти никакой работы.
  if (state.archived) return null;
  if (ritual === 'standup') {
    runStandup(state, now);
    return state.life.runs[state.life.runs.length - 1] ?? null;
  }
  const needsModel = ritual === 'consolidate' || ritual === 'contradictions' || ritual === 'reflect';
  // Без выбранного провайдера ритуал на модели пропускаем: подставлять
  // Claude Code молча нельзя. Отметка — как у отложенного, чтобы не
  // повторять попытку и строку в ленте каждую минуту.
  if (needsModel && !state.officeRuntime()) {
    state.addLog(null, 'system', state.say('ritual.noProviderLog', { ritual: state.say(`ritual.name.${ritual}`) }));
    state.life.lastRun[ritual] = now - WEEK_MS + 60 * 60 * 1000;
    return null;
  }
  const hot = needsModel ? limitsBusy(state, now) : null;
  if (hot) {
    state.addLog(null, 'system', state.say('ritual.deferredLog', {
      ritual: state.say(`ritual.name.${ritual}`), percent: hot.percent, threshold: state.ritualLimit(),
    }));
    // Отложенный ритуал не забывается, но и не долбится каждую минуту.
    state.life.lastRun[ritual] = now - WEEK_MS + 60 * 60 * 1000;
    // Портфель считает отложенные: упёрлись в лимит трижды за неделю —
    // первой отключается рефлексия, самый дорогой ритуал.
    state.touchLife({ deferrals: state.life.deferrals + 1 });
    return null;
  }

  state.ritualRunning = ritual;
  state.emitLife();
  state.addLog(null, 'system', state.say('ritual.startLog', { ritual: state.say(`ritual.name.${ritual}`) }));
  try {
    const run = await runAsFlow(state, ritual, now);
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

/**
 * Ритуал — процесс офиса (spec процессов §6.1): файл `workflows/ritual-<id>.json`
 * с триггером и одним узлом, а идёт он тем же раннером, что и задачи, и
 * виден таким же прогоном. Расписание пока считает `dueRitual`: интервалы
 * правит портфель, и файл о них не знает.
 */
async function runAsFlow(state: OfficeState, ritual: RitualId, now: number): Promise<Omit<RitualRun, 'id'>> {
  const workflow = builtinWorkflows().get(`ritual-${ritual}`);
  if (!workflow) return runners[ritual](state, now);
  state.pruneFlowRuns(workflow.id, 19);
  const run = newRun(workflow, { flow: workflow.id }, now);
  let result: Omit<RitualRun, 'id'> | null = null;
  const executor: Executor<WorkflowNode> = {
    async run() {
      result = await runners[ritual](state, now);
      return { outcome: 'pass', note: result.note };
    },
  };
  await drive(state, workflow, run, (node) => (node.run === `office:ritual:${ritual}` ? executor : undefined), {
    context: (node) => node,
    stuck: (_node, halt) => { throw new Error(halt.note); },
  });
  return result ?? { ritual, at: now, costUsd: 0, produced: {}, note: '' };
}

/**
 * Запись журнала по цитате из flag_contradiction. Модель цитирует строку
 * журнала вида «J-12 [вид, область] текст» — сначала ищем id, потом сам
 * текст. Новое наблюдение, которого в журнале нет, не находится: такую пару
 * разбирать не с чем, она уходит владельцу как раньше.
 */
function factByQuote(facts: Fact[], quote: string): Fact | null {
  for (const m of quote.matchAll(/\b[A-Z]+-\d+\b/g)) {
    const hit = facts.find((f) => f.id === m[0]);
    if (hit) return hit;
  }
  const norm = (s: string): string => s.toLowerCase().replace(/[«»“”"'`]/g, '').replace(/\s+/g, ' ').trim();
  const q = norm(quote.replace(/^-?\s*[A-Z]+-\d+\s*(\[[^\]]*\])?/, ''));
  if (q.length < 12) return null;
  return facts.find((f) => {
    const t = norm(f.text);
    return t.includes(q) || q.includes(t);
  }) ?? null;
}

/** Вывод разбора словами — для вопроса владельцу, когда офис сам пару не закрыл. */
function verdictText(state: OfficeState, verdict: ContradictionVerdict): string {
  if (verdict.kind === 'stale') {
    const text = state.say('contradictions.verdict.stale', {
      keep: verdict.keepId, forget: verdict.forgetId, reason: clip(verdict.reason, 300),
    });
    return verdict.evidence
      ? `${text} ${state.say('contradictions.closed.evidence', { evidence: clip(verdict.evidence, 200) })}`
      : text;
  }
  if (verdict.kind === 'compatible') {
    return state.say('contradictions.verdict.compatible', { reason: clip(verdict.reason, 300) });
  }
  const reason = state.say('contradictions.verdict.unresolved', { reason: clip(verdict.reason, 300) });
  return verdict.lean ? `${reason} ${state.say('contradictions.verdict.lean', { lean: clip(verdict.lean, 200) })}` : reason;
}

/**
 * Сторона противоречия: запись журнала или новое наблюдение ритуала, которого
 * в журнале ещё нет (консолидация сверяет дельту с журналом). view — то, что
 * видит агент разбора; key — чем сторона входит в память разобранных пар.
 */
interface ContradictionSide {
  fact: Fact | null;
  view: FactView;
  key: string;
}

/** Длина варианта ответа: длиннее questions.ts → tidyOptions вариант выбросит. */
const OPTION_LEN = 40;

/**
 * Сторона кнопкой для владельца: id записи и начало её текста. По id в ответе
 * supersededByAnswer понимает, какая запись проиграла, поэтому чужие id из
 * текста в кнопку не попадают.
 */
function sideOption(state: OfficeState, side: ContradictionSide): string {
  const head = side.fact ? `${side.fact.id}: ` : `${state.say('contradictions.option.observation')}: `;
  const text = side.view.text.replace(/^-?\s*[A-Z]+-\d+\s*(\[[^\]]*\])?:?/, '').replace(/\b[A-Z]+-\d+\b/g, '');
  return `${head}${clip(text, OPTION_LEN - head.length)}`;
}

/** Задачи, которые упоминают стороны: их статус и отчёт уходят агенту разбора. */
function tasksFor(state: OfficeState, sides: ContradictionSide[]): TaskNote[] {
  const ids: string[] = [];
  for (const { view } of sides) {
    for (const id of [view.source.taskId ?? '', ...taskIdsIn(view.text)]) {
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids.slice(0, 6).flatMap((id) => {
    const task = state.tasks.get(id);
    return task ? [{ id, title: task.title, status: task.status, result: task.result }] : [];
  });
}

/** Что стало с одним противоречием: спросили, закрыли сами или пропустили как разобранное. */
type ContradictionFate = 'asked' | 'resolved' | 'skipped';

/**
 * Одно противоречие: прежде чем спрашивать владельца, офис разбирает пару
 * сам (решение журнала: владельца спрашивают, только когда разобраться не
 * вышло или сталкиваются два его решения). Разобранная пара второй раз не
 * поднимается — ни агентом, ни вопросом.
 */
async function handleContradiction(
  state: OfficeState, ritual: RitualId, c: { a: string; b: string; text: string }, out: RitualOutput,
): Promise<ContradictionFate> {
  const live = state.factList().filter((f) => f.status === 'live' && isPromptable(f));
  const now = Date.now();
  const sideOf = (quote: string): ContradictionSide => {
    const fact = factByQuote(live, quote);
    if (fact) return { fact, view: fact, key: fact.id };
    return {
      fact: null,
      key: observationKey(quote),
      view: {
        id: OBSERVATION_ID, kind: 'fact', text: quote.trim(), scope: 'project', source: { ritual },
        createdAt: now, confirmedAt: now, status: 'live',
      },
    };
  };
  const a = sideOf(c.a);
  const b = sideOf(c.b);
  // Обе цитаты — одна и та же запись: расходиться ей не с чем.
  if (a.fact && a.fact.id === b.fact?.id) return 'skipped';
  const what = clip(c.text || `${c.a} ≠ ${c.b}`, 160);
  const label = (side: ContradictionSide): string =>
    clip(side.fact ? `${side.fact.id}: ${side.fact.text}` : side.view.text, 160);
  // Подписи снимаем до разбора: уточнение формулировки перепишет текст записи,
  // а в ленте должно остаться то, что расходилось.
  const labels = { a: label(a), b: label(b) };
  const question = state.say('questions.contradiction', labels);
  const remember = (): void => {
    markPairResolved(state.life, a.key, b.key);
    state.touchLife();
  };

  if (isPairResolved(state.life, a.key, b.key)) return 'skipped';
  // Владелец эту тему уже видел — по записи, по цитатам или по формулировке.
  const prior = findPriorContradiction(c, [a.fact, b.fact], state.questionList(), state.factList());
  if (prior) {
    remember();
    state.addLog(null, 'system', state.say('contradictions.repeatLog', {
      what, ref: prior.questionId ?? prior.factId ?? '',
    }));
    return 'skipped';
  }

  const options = [sideOption(state, a), sideOption(state, b), state.say('contradictions.option.both')];
  if (!a.fact && !b.fact) {
    // Ни одной стороны в журнале нет — забывать нечего и сверять не с чем:
    // вопрос владельцу, но с кнопками и один раз.
    remember();
    state.addFact({ kind: 'contradiction', text: c.text || `${c.a} ≠ ${c.b}`, scope: 'office', source: { ritual } });
    officeAsks(state, 'contradiction', question, state.say('questions.contradictionAssumption'), null, options);
    return 'asked';
  }

  let verdict: ContradictionVerdict;
  if (!agents.resolveContradiction) {
    verdict = { kind: 'unresolved', reason: state.say('contradictions.noAgent') };
  } else {
    const prompt = buildResolvePrompt(a.view, b.view, state.lang(), tasksFor(state, [a, b]));
    const answer = await agents.resolveContradiction(state, prompt);
    out.costUsd += answer.costUsd;
    verdict = answer.error && !answer.text.trim()
      ? { kind: 'unresolved', reason: state.say('contradictions.agentFailed', { error: clip(answer.error, 200) }) }
      : parseVerdict(answer.text, state.lang());
  }
  const decision = decideContradiction(a.view, b.view, verdict, state.lang());
  remember();

  if (decision.action === 'close') {
    const closed = decision.verdict.kind === 'stale'
      ? applyStale(state, ritual, a, b, decision.verdict)
      : state.say('contradictions.closed.compatible', { reason: clip(decision.verdict.reason, 300) });
    state.addLog(null, 'system', state.say('contradictions.closedLog', {
      what, ...labels, verdict: closed,
    }));
    return 'resolved';
  }

  state.addFact({ kind: 'contradiction', text: c.text || `${c.a} ≠ ${c.b}`, scope: 'office', source: { ritual } });
  const review = state.say(
    decision.why === 'owner-decisions' ? 'contradictions.review.ownerDecisions'
      : decision.why === 'unsure' ? 'contradictions.review.unsure'
        : 'contradictions.review.unresolved',
    { verdict: verdictText(state, decision.verdict) },
  );
  officeAsks(state, 'contradiction', `${question}\n\n${review}`,
    state.say('questions.contradictionAssumption'), null, options);
  return 'asked';
}

/**
 * Применить вердикт «верна одна»: проигравшая запись помечается заменённой и
 * уходит в архив (из журнала не стирается — остаётся историей), победившая
 * подтверждается и, если агент дал уточнение, переписывается. Верное новое
 * наблюдение заводится записью. Возвращает итог словами — для строки ленты.
 */
function applyStale(
  state: OfficeState, ritual: RitualId, a: ContradictionSide, b: ContradictionSide,
  verdict: Extract<ContradictionVerdict, { kind: 'stale' }>,
): string {
  const [keep, lose] = a.view.id === verdict.keepId ? [a, b] : [b, a];
  const rewrite = verdict.rewrite ? clip(verdict.rewrite, 600) : '';
  const parts: string[] = [];
  let keepId: string;
  if (keep.fact) {
    keepId = keep.fact.id;
    // Решение владельца офис не переформулирует — только подтверждает.
    const reworded = Boolean(rewrite) && rewrite !== keep.fact.text && !isOwnerDecision(keep.fact);
    state.updateFact(keepId, { confirmedAt: Date.now(), ...(reworded ? { text: rewrite } : {}) });
    if (reworded) parts.push(state.say('contradictions.closed.rewritten', { id: keepId, text: clip(rewrite, 300) }));
  } else {
    // Верно наблюдение: оно становится записью на месте устаревшей.
    keepId = state.addFact({
      kind: 'fact', text: rewrite || keep.view.text, scope: lose.fact?.scope ?? 'project', source: { ritual },
    }).id;
  }
  if (lose.fact) {
    supersedeFacts(state, [lose.fact.id], keepId);
    archiveFact(state, lose.fact.id);
    parts.unshift(state.say(keep.fact ? 'contradictions.closed.stale' : 'contradictions.closed.observationRight', {
      keep: keepId, forget: lose.fact.id, reason: clip(verdict.reason, 300),
    }));
  } else {
    parts.unshift(state.say('contradictions.closed.observationWrong', { keep: keepId, reason: clip(verdict.reason, 300) }));
  }
  if (verdict.evidence) parts.push(state.say('contradictions.closed.evidence', { evidence: clip(verdict.evidence, 300) }));
  return parts.map((part) => part.replace(/[.\s]+$/, '')).join('. ');
}

/**
 * Стороны вопроса о противоречии: записи журнала из подписей «J-12: текст»
 * в кавычках шаблона questions.contradiction. Не нашлись так — первые id
 * записей в тексте (вопрос могли переформулировать).
 */
function questionSides(state: OfficeState, text: string): Fact[] {
  const quoted = [...text.matchAll(/[«“"]\s*(J-\d+):/g)].map((m) => m[1]);
  const ids = [...new Set([...quoted, ...factIdsIn(text)])];
  return ids.flatMap((id) => state.facts.get(id) ?? []).slice(0, 2);
}

/**
 * «Пусть офис разберётся»: владелец отдал вопрос о противоречии офису. Тот же
 * агент разбора, что у ритуала (только чтение: код, git, доска), но решение
 * журнала здесь действует целиком: подтверждённая кодом, git или влитой
 * задачей сторона верна, даже если обе записи — решения владельца. Верная
 * запись подтверждается свежей датой, устаревшая уходит в архив с пометкой
 * «заменена»; итог — строкой в ленте и в чате вопроса. Не вышло — обе записи
 * остаются, в ленте причина, и вопрос владельцу заново не задаётся: пара
 * отмечена разобранной.
 */
export async function delegateContradiction(
  state: OfficeState, question: OwnerQuestion,
): Promise<'resolved' | 'unresolved'> {
  const where = { chatId: question.chatId, taskId: question.taskId };
  const fail = (verdict: string): 'unresolved' => {
    const text = state.say('contradictions.delegate.failedLog', { id: question.id, verdict });
    state.addLog(null, 'system', text);
    state.addOfficeNote(text, where);
    return 'unresolved';
  };
  const unresolved = (reason: string): string => state.say('contradictions.verdict.unresolved', { reason });

  const sides = questionSides(state, question.text);
  if (sides.length < 2) {
    return fail(unresolved(state.say('contradictions.delegate.noSides', { ids: sides.map((f) => f.id).join(', ') || '—' })));
  }
  const gone = sides.find((f) => f.status !== 'live' || !isPromptable(f));
  if (gone) return fail(unresolved(state.say('contradictions.delegate.gone', { id: gone.id })));

  const [a, b] = sides.map((fact): ContradictionSide => ({ fact, view: fact, key: fact.id }));
  const labels = { a: clip(`${a.view.id}: ${a.view.text}`, 160), b: clip(`${b.view.id}: ${b.view.text}`, 160) };
  let verdict: ContradictionVerdict;
  if (!agents.resolveContradiction) {
    verdict = { kind: 'unresolved', reason: state.say('contradictions.noAgent') };
  } else {
    const prompt = `${buildResolvePrompt(a.view, b.view, state.lang(), tasksFor(state, [a, b]))}\n\n`
      + state.say('prompt.resolveContradiction.delegated');
    const answer = await agents.resolveContradiction(state, prompt);
    verdict = answer.error && !answer.text.trim()
      ? { kind: 'unresolved', reason: state.say('contradictions.agentFailed', { error: clip(answer.error, 200) }) }
      : parseVerdict(answer.text, state.lang());
  }
  // Пара разобрана при любом исходе: ритуал её больше не поднимет.
  markPairResolved(state.life, a.key, b.key);
  state.touchLife();

  const decision = decideContradiction(a.view, b.view, verdict, state.lang(), { delegated: true });
  if (decision.action !== 'close') return fail(verdictText(state, decision.verdict));

  let closed: string;
  if (decision.verdict.kind === 'stale') {
    closed = applyStale(state, 'contradictions', a, b, decision.verdict);
  } else {
    // Верны обе — обе и подтверждаем.
    const now = Date.now();
    for (const side of [a, b]) state.updateFact(side.view.id, { confirmedAt: now });
    closed = state.say('contradictions.closed.compatible', { reason: clip(decision.verdict.reason, 300) });
  }
  const text = state.say('contradictions.delegate.closedLog', { id: question.id, ...labels, verdict: closed });
  state.addLog(null, 'system', text);
  state.addOfficeNote(text, where);
  return 'resolved';
}

setContradictionDelegate(async (state, question) => { await delegateContradiction(state, question); });

/**
 * Закрыть открытые вопросы-повторы о противоречиях: о тех же записях журнала
 * владельца уже спрашивали. Закрываем ссылкой на прежний вопрос и его ответ.
 */
export function closeRepeatedContradictions(state: OfficeState): string[] {
  const closed: string[] = [];
  for (const { repeat, prior } of repeatedQuestions(state.questionList(), state.factList())) {
    const why = prior.answeredAt
      ? state.say('contradictions.repeatClosed', { id: prior.id, answer: clip(prior.answer ?? '', 200) })
      : state.say('contradictions.repeatClosedOpen', { id: prior.id });
    if (dismissQuestion(state, repeat.id, why)) {
      state.addLog(null, 'system', `${repeat.id}: ${why}`);
      closed.push(repeat.id);
    }
  }
  return closed;
}

/** Положить то, что ритуал произвёл: записи, противоречия, вопросы. */
async function applyOutput(state: OfficeState, ritual: RitualId, out: RitualOutput): Promise<Record<string, number>> {
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
  let resolved = 0;
  for (const c of out.contradictions) {
    if (!c.a.trim() || !c.b.trim()) continue;
    const fate = await handleContradiction(state, ritual, c, out);
    if (fate === 'asked') contradictions += 1;
    else if (fate === 'resolved') resolved += 1;
  }
  let questions = 0;
  for (const q of out.questions) {
    if (!q.text.trim()) continue;
    // Замена — как у менеджера: новый вопрос забирает старые себе.
    if (q.replaces?.length) askOwner(state, OFFICE_SENDER, null, q.text, q.assumption, q.options, q.replaces);
    else officeAsks(state, 'assumption', q.text, q.assumption, null, q.options);
    questions += 1;
  }
  return { facts, contradictions, resolved, questions };
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
    const produced = await applyOutput(state, 'consolidate', out);
    return {
      ritual: 'consolidate', at: now, costUsd: out.costUsd, produced,
      note: state.say('ritual.consolidate.note', produced),
    };
  },

  async contradictions(state, now) {
    closeRepeatedContradictions(state);
    ensureDelegateOptions(state);
    const facts = state.factList().filter((f) => f.status === 'live' && isPromptable(f));
    const out = await agents.contradictions(state, facts);
    if (out.error) throw new Error(out.error);
    const produced = await applyOutput(state, 'contradictions', out);
    return {
      ritual: 'contradictions', at: now, costUsd: out.costUsd, produced,
      note: state.say('ritual.contradictions.note', produced),
    };
  },

  /**
   * Свежесть журнала (freshness.ts): факты и уроки офис проверяет сам,
   * решения, которые пора подтвердить, — один вопрос владельцу за прогон.
   */
  async forget(state, now) {
    // Самопроверка — на модели: без провайдера и за порогом лимита ритуал
    // идёт по-старому, по датам, а не откладывается целиком.
    const check = state.officeRuntime() && !limitsBusy(state, now) ? agents.checkFreshness : undefined;
    const result = await runFreshness(state, now, check ? (s, prompt) => check.call(agents, s, prompt) : undefined);
    const { costUsd, ...produced } = result;
    // Раз в неделю, вместе с забыванием, офис смотрит и на сами ритуалы.
    adjustPortfolio(state, now);
    return {
      ritual: 'forget', at: now, costUsd, produced,
      note: state.say('ritual.forget.note', produced),
    };
  },

  /**
   * Рефлексия (§5.5): единственный ритуал, который ведёт менеджер, потому
   * что его результат — решения. Сама она ничего не меняет: заводит фичи
   * через режим инициативы, записи в журнал и вопросы владельцу, а итог
   * пишет в чат и запоминает для планёрки.
   */
  async reflect(state, now) {
    const out = await agents.reflect(state, reflectionInput(state, now));
    if (out.error) throw new Error(out.error);
    const produced = await applyOutput(state, 'reflect', out);
    let features = 0;
    for (const feature of out.features) {
      const made = proposeFeature(state, feature);
      if (made.ok) features += 1;
      else state.addLog(null, 'system', made.message);
    }
    // Правило из повторов — предложение, а не правка: бриф роли меняет
    // поведение исполнителя, и без одобрения владельца офис его не трогает.
    let rules = 0;
    for (const rule of out.rules) {
      if (!rule.text.trim() || !state.role(rule.roleId)) continue;
      const dup = state.proposalList().some((p) =>
        p.kind === 'rule' && p.status === 'pending' && p.roleId === rule.roleId && p.text.trim() === rule.text.trim());
      if (dup) continue;
      state.addProposal({
        kind: 'rule', title: clip(rule.text, 80), text: rule.text.trim(), rationale: rule.rationale,
        roleId: rule.roleId, setting: null, directionId: null, plan: null,
      });
      state.addChat(OFFICE_SENDER, state.say('proposal.ruleProposedChat', {
        role: rule.roleId, text: clip(rule.text, 200), rationale: clip(rule.rationale, 200),
      }));
      rules += 1;
    }
    const summary = out.summary.trim();
    if (summary) {
      state.addChat(OFFICE_SENDER, state.say('reflect.chat', { summary }));
      state.touchLife({ reflection: summary, reflectionAt: now });
    }
    const all = { ...produced, features, rules };
    return {
      ritual: 'reflect', at: now, costUsd: out.costUsd, produced: all,
      note: state.say('reflect.note', all),
    };
  },

  /**
   * Здоровье проекта (§7.1, встроенное направление): то, что офис делал бы
   * и без владельца. Без модели: красные проверки в основной ветке — фича
   * на починку (обязанность, не инициатива: в долю не входит и «поехали» не
   * ждёт), ветка, которая неделю ни слита, ни в конвейере, — вопрос.
   */
  async health(state, now) {
    let checks = 'ok';
    if (await isRepo(state.projectDir)) {
      const result = await runTypecheck(state.projectDir, state.lang());
      if (!result.ok) {
        checks = 'red';
        const fixer = state.workerRoles().find((r) => r.id === 'backend' && r.isolate)
          ?? state.workerRoles().find((r) => r.isolate);
        if (!fixer) {
          state.addLog(null, 'error', state.say('health.noRole'));
        } else {
          const made = proposeFeature(state, {
            title: state.say('health.checksFailedTitle'),
            goal: state.say('health.checksFailedGoal'),
            rationale: state.say('health.checksRationale'),
            directionId: HEALTH_DIRECTION,
            tasks: [{
              key: 'fix', title: state.say('health.checksFailedTask'),
              description: state.say('health.checksFailedDesc', { output: clip(result.message, 1500) }),
              acceptanceCriteria: [state.say('health.checksCriterion1'), state.say('health.checksCriterion2')],
              roleId: fixer.id,
            }],
          });
          if (!made.ok) state.addLog(null, 'system', made.message);
        }
      }
    }
    let stale = 0;
    for (const task of state.tasks.values()) {
      if (!task.branch || task.merged || task.status !== 'done' || !task.finishedAt) continue;
      if (state.prOf(task.id) && state.prOf(task.id)!.stage !== 'stuck') continue;
      const days = Math.floor((now - task.finishedAt) / 86_400_000);
      if (days < 7) continue;
      const asked = state.questionList().some((q) => q.taskId === task.id && q.text.includes(task.branch!) === false
        && q.kind === 'assumption' && q.from === OFFICE_SENDER);
      if (asked) continue;
      officeAsks(state, 'assumption', state.say('health.staleBranch', { task: task.id, title: task.title, days }),
        state.say('health.staleAssumption'), task.id);
      stale += 1;
    }
    // Уборка веток и worktree — раз в сутки, итог она пишет в ленту сама.
    const tidy = await tidyOffice(state, now);
    const removed = tidy ? tidy.branches + tidy.worktrees : 0;
    const produced = { checks: checks === 'red' ? 1 : 0, stale, removed };
    return {
      ritual: 'health', at: now, costUsd: 0, produced,
      note: state.say('health.note', { checks: state.say(checks === 'red' ? 'health.red' : 'health.ok'), stale })
        + (removed ? state.say('health.tidyNote', { removed }) : ''),
    };
  },

  /**
   * Разбор завалов: раз в сутки офис читает сводку здоровья и расчищает её.
   *
   * По каждому провалу — запись в журнал с причиной и номером задачи: именно
   * её потом видит любая следующая сессия, и именно её отсутствие делает
   * провал потерянной неделей. Запись заодно и есть признак разбора — с ней
   * провал уходит из сводки, и завтрашний прогон не разбирает его заново.
   * Провал, который оборвало снаружи, вдобавок возвращается в план.
   *
   * Модель здесь не нужна: и причина, и метка считаются из доски. Ритуал
   * стоит ноль — не «дёшево», а ровно ноль.
   */
  async triage(state, now) {
    const work = triageWork(state, now);
    let noted = 0;
    let returned = 0;
    for (const item of work.failures) {
      const task = state.tasks.get(item.taskId);
      if (!task) continue;
      const reason = failureReason(state, task);
      const back = retryable(task) && returnToPlan(state, task, reason);
      if (back) returned += 1;
      const fact = state.addFact({
        kind: 'lesson',
        text: state.say(back ? 'triage.factRetried' : 'triage.fact', {
          task: task.id, title: clip(task.title, 80),
          role: task.roleId ?? state.say('triage.noRole'), reason,
        }),
        scope: task.roleId ? `role:${task.roleId}` : 'project',
        source: { ritual: 'triage', taskId: task.id },
      });
      state.addLog(null, 'system', state.say('journal.noted', { id: fact.id, text: clip(fact.text) }));
      noted += 1;
    }

    const marked: Record<BranchMark, string[]> = { merge: [], drop: [] };
    for (const { task, mark, days } of work.branches) {
      state.updateTask(task.id, { branchMark: mark, branchMarkAt: now });
      marked[mark].push(`${task.branch} (${task.id})`);
      state.addLog(null, 'system', state.say('triage.markLog', {
        branch: task.branch ?? '', task: task.id, days, mark: state.say(`triage.mark.${mark}`),
      }));
    }

    if (noted + marked.merge.length + marked.drop.length > 0) {
      const lines = [state.say('triage.chatHead', { noted, returned })];
      if (marked.merge.length) lines.push(state.say('triage.chatMerge', { branches: marked.merge.join(', ') }));
      if (marked.drop.length) lines.push(state.say('triage.chatDrop', { branches: marked.drop.join(', ') }));
      state.addChat(OFFICE_SENDER, lines.join('\n'));
    }

    const produced = { noted, returned, merge: marked.merge.length, drop: marked.drop.length };
    return {
      ritual: 'triage', at: now, costUsd: 0, produced,
      note: state.say('triage.note', produced),
    };
  },
};

/** Неделя офиса для рефлексии — цифры и тексты, без файлов. */
export function reflectionInput(state: OfficeState, now = Date.now()): ReflectionInput {
  const since = now - REPORT_WEEK_MS;
  const tasks = [...state.tasks.values()].map(toTaskView);
  const reviews: ReflectionInput['reviews'] = [];
  for (const task of state.tasks.values()) {
    if (!task.outcome || task.outcome.at < since || task.outcome.reworks === 0) continue;
    for (const r of state.prOf(task.id)?.reviews ?? []) {
      if (r.verdict === 'changes') {
        reviews.push({ taskId: task.id, title: task.title, roleId: task.roleId ?? '', text: clip(r.text, 300) });
      }
    }
  }
  const runs = state.life.runs.filter((r) => r.at >= since);
  return {
    since,
    reports: roleReports(tasks, since),
    reviews,
    rituals: { runs: runs.length, costUsd: runs.reduce((s, r) => s + r.costUsd, 0) },
    questions: state.questionList().filter((q) => q.askedAt >= since),
    directions: state.directionList().map((d) => ({ id: d.id, text: d.text, active: d.active })),
    plan: planSummary(state),
    facts: state.factList().filter((f) => f.status === 'live'),
  };
}

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

// ------------------------------------------------------------ портфель

/** Через сколько дней вопрос без ответа считается проигнорированным. */
const UNANSWERED_MS = 14 * 24 * 60 * 60 * 1000;
/** Сколько планёрок подряд без ответа владельца, чтобы убрать фразу менеджера. */
const UNREAD_STANDUPS = 5;
/** Сколько отложенных ритуалов за неделю выключают рефлексию. */
const DEFERRALS_LIMIT = 3;
const MAX_CONSOLIDATE_EVERY_MS = 48 * 60 * 60 * 1000;
const MIN_QUESTIONS = 2;

/**
 * Портфель ритуалов (§8.2): обучение на отклике, применённое к самим
 * ритуалам. Это то немногое, что офис меняет в себе без одобрения — цена
 * ошибки здесь лишний или недостающий абзац в чате, а не поведение
 * исполнителя. Каждая подкрутка называется вслух в ленте.
 */
export function adjustPortfolio(state: OfficeState, now = Date.now()): void {
  const policy = state.life.policy;
  const twoWeeks = now - 2 * WEEK_MS;

  // 1. Консолидация даёт записи, которые протухают, ни разу не подтвердившись → реже.
  const fromConsolidation = state.factList().filter((f) => f.source.ritual === 'consolidate' && f.createdAt >= twoWeeks);
  const archived = fromConsolidation.filter((f) => f.status !== 'live').length;
  const confirmed = fromConsolidation.filter((f) => f.status === 'live' && f.confirmedAt > f.createdAt).length;
  if (archived >= 3 && archived > confirmed && policy.consolidateEveryMs < MAX_CONSOLIDATE_EVERY_MS) {
    const next = Math.min(MAX_CONSOLIDATE_EVERY_MS, policy.consolidateEveryMs * 2);
    state.setPolicy({ consolidateEveryMs: next });
    state.addLog(null, 'system', state.say('portfolio.consolidateSlower', {
      archived, confirmed, h: Math.round(next / 3_600_000),
    }));
  }

  // 2. Вопросы две недели без ответа → порция меньше.
  const ignored = openQuestions(state).filter((q) => q.shownAt !== null && now - q.shownAt >= UNANSWERED_MS).length;
  if (ignored >= 3 && policy.questionsPerStandup > MIN_QUESTIONS) {
    const n = Math.max(MIN_QUESTIONS, policy.questionsPerStandup - 1);
    state.setPolicy({ questionsPerStandup: n });
    state.addLog(null, 'system', state.say('portfolio.fewerQuestions', { open: ignored, n }));
  }

  // 3. Планёрку не читают (в день планёрки владелец не написал ни слова) → без фразы менеджера.
  const standups = state.life.runs.filter((r) => r.ritual === 'standup').slice(-UNREAD_STANDUPS);
  if (standups.length >= UNREAD_STANDUPS && policy.standupPmLine) {
    const unread = standups.every((r) => !state.chat.some((c) =>
      c.from === 'user' && dayKey(c.at) === dayKey(r.at) && c.at > r.at));
    if (unread) {
      state.setPolicy({ standupPmLine: false });
      state.addLog(null, 'system', state.say('portfolio.noPmLine', { n: UNREAD_STANDUPS }));
    }
  }

  // 4. Лимит подписки: часто откладывались → рефлексия выключается первой;
  //    неделя без отложенных → возвращается.
  if (state.life.deferrals >= DEFERRALS_LIMIT && policy.reflectionOn) {
    state.setPolicy({ reflectionOn: false });
    state.addLog(null, 'system', state.say('portfolio.reflectionOff', { n: state.life.deferrals }));
  } else if (state.life.deferrals === 0 && !policy.reflectionOn && state.settings.ritualsEnabled !== false) {
    state.setPolicy({ reflectionOn: true });
    state.addLog(null, 'system', state.say('portfolio.reflectionOn'));
  }
  state.touchLife({ deferrals: 0 });
}

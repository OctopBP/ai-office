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
import type { BranchMark, HealthEntry, OwnerQuestion, RitualId, RitualRun } from '../shared/types';
import { LANG_LOCALE } from '../shared/i18n';
import { roleReports, WEEK_MS as REPORT_WEEK_MS, type RoleReport } from '../shared/report';
import { toTaskView, type Fact, type OfficeState, type Task } from './state';
import { forget, STALE_AFTER_MS } from './journal';
import { officeAsks, openQuestions, pickForStandup } from './questions';
import { limitsView } from './limits';
import { providerOf } from '../shared/providers';
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
  questions: Array<{ text: string; assumption: string; options?: string[] }>;
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

export interface RitualAgents {
  consolidate(state: OfficeState, input: ConsolidationInput): Promise<RitualOutput>;
  contradictions(state: OfficeState, facts: Fact[]): Promise<RitualOutput>;
  reflect(state: OfficeState, input: ReflectionInput): Promise<ReflectionOutput>;
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
  const limits = limitsView(providerOf(state.role('pm')));
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
    officeAsks(state, 'assumption', q.text, q.assumption, null, q.options);
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
    // Раз в неделю, вместе с забыванием, офис смотрит и на сами ритуалы.
    adjustPortfolio(state, now);
    return {
      ritual: 'forget', at: now, costUsd: 0, produced,
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
    const produced = applyOutput(state, 'reflect', out);
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
    const produced = { checks: checks === 'red' ? 1 : 0, stale };
    return {
      ritual: 'health', at: now, costUsd: 0, produced,
      note: state.say('health.note', { checks: state.say(checks === 'red' ? 'health.red' : 'health.ok'), stale }),
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

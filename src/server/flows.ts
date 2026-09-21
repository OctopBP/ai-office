/**
 * Процессы самого офиса (docs/design/workflows/spec.md §6): не по задаче, а
 * по состоянию. Главный из них — «что дальше» (`workflows/what-next.json`):
 * доска опустела, и офис сам смотрит, есть ли работа по направлениям
 * владельца, заводит её, а если вывести фичу не из чего — редко и дёшево
 * собирает совещание о развитии. Ничего этого нет — офис честно простаивает.
 *
 * Три правила, без которых это превратилось бы в утечку денег (§6.2):
 * - нет дельты — нет прогона: с прошлого раза должно что-то случиться;
 * - затухание: после «нечего делать» следующий заход вдвое позже;
 * - ожидание владельца — не простой: пока висят неслитые ветки, план без
 *   «поехали» или предложения без ответа, офис не заводит новое поверх.
 *
 * Сессии агентов сюда не импортируются: как и у конвейера, живых агентов
 * ставит agents.ts (FlowAgents), а проверки подменяют их своими.
 */
import { HEALTH_DIRECTION, OFFICE_SENDER, dayKey } from '../shared/types';
import type { Run, Workflow, WorkflowNode } from '../shared/workflow';
import type { OfficeState } from './state';
import { workflowCatalog } from './workflows';
import { drive, newRun, type Executor, type Resolve, type RunHooks, type StepResult } from './runs';
import { quiet } from './rituals';
import { initiativeBudget, proposeFeature, type FeatureProposal } from './initiatives';
import { tellPm } from './review';

/** Первая пауза после «нечего делать»; дальше удваивается до суток. */
const BACKOFF_BASE_MS = 60 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
/**
 * Пауза после отказа без модели (нет направлений, ждём владельца, нет
 * дельты). Проверка бесплатна, но раз в минуту незачем: то, чего ждём,
 * за минуту не появляется.
 */
const SKIP_BACKOFF_MS = 15 * 60 * 1000;
/** Столько открытых вопросов владельцу — уже очередь, новое не заводим. */
const OPEN_QUESTIONS_LIMIT = 5;
/** Сколько раз подряд можно собрать совещание, не получив нового направления. */
const MEETINGS_WITHOUT_DIRECTION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_MEETING_EVERY_DAYS = 7;
/** Сколько прогонов одного процесса офиса помнить — ради расхода по узлам (§10). */
export const KEEP_FLOW_RUNS = 20;

const clip = (s: string, n = 160): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

// ------------------------------------------------------------- агенты

export interface DecideInput {
  digest: string;
  canMeet: boolean;
  directions: Array<{ id: string; text: string }>;
  /** Что владелец уже отклонял — чтобы не предлагать снова. */
  rejected: string[];
}

export interface DecideOutput {
  kind: 'feature' | 'meet' | 'nothing';
  feature?: FeatureProposal;
  topic?: string;
  why?: string;
  costUsd: number;
  error?: string;
}

export interface SummaryInput {
  agenda: string;
  transcript: string;
  rejected: string[];
}

export interface SummaryOutput {
  features: FeatureProposal[];
  summary: string;
  costUsd: number;
  error?: string;
}

export interface MeetingLine { id: string; title: string; text: string }

export interface FlowAgents {
  decide(state: OfficeState, input: DecideInput): Promise<DecideOutput>;
  summarize(state: OfficeState, input: SummaryInput): Promise<SummaryOutput>;
  meeting(state: OfficeState, topic: string, participants: string[]): Promise<{ ok: boolean; said: MeetingLine[]; error?: string }>;
}

let agents: FlowAgents = {
  async decide() { return { kind: 'nothing', costUsd: 0 }; },
  async summarize() { return { features: [], summary: '', costUsd: 0 }; },
  async meeting() { return { ok: false, said: [] }; },
};

export function setFlowAgents(next: FlowAgents): void {
  agents = next;
}

// ------------------------------------------------------------ состояние

/**
 * Доска пуста: ничего не делается и делать нечего без человека. Задача в
 * работе, на ревью, в очереди или плановая в согласованной фиче — не пусто.
 * Заблокированная (спросила и ждёт) и проваленная — пусто: их сдвинет
 * человек или менеджер, а не новая фича.
 */
export function boardIdle(state: OfficeState, now = Date.now()): boolean {
  // Архивный офис не придумывает себе работу: инициатива — тоже работа.
  if (state.settings.ritualsEnabled === false || state.paused || state.archived) return false;
  if (state.initiativeMode() === 'off') return false;
  if (state.ritualRunning || !quiet(state, now)) return false;
  for (const t of state.tasks.values()) {
    if (t.status === 'backlog' || t.status === 'assigned' || t.status === 'in_progress' || t.status === 'review') return false;
  }
  for (const e of state.epicList()) {
    if (e.status === 'active' || (e.status === 'planned' && e.approved)) return false;
  }
  return true;
}

/** Что ждёт именно владельца — пока это есть, офис нового не заводит. */
function ownerBacklog(state: OfficeState): string[] {
  const say = state.say.bind(state);
  const items: string[] = [];
  const unmerged = [...state.tasks.values()].filter((t) => t.status === 'done' && t.branch && !t.merged).length;
  if (unmerged && !state.settings.autoPipeline) items.push(say('flow.backlog.unmerged', { n: unmerged }));
  const epics = state.epicList().filter((e) => e.status === 'planned' && !e.approved).length;
  if (epics) items.push(say('flow.backlog.epics', { n: epics }));
  const proposals = state.proposalList().filter((p) => p.status === 'pending').length;
  if (proposals) items.push(say('flow.backlog.proposals', { n: proposals }));
  const open = state.questionList().filter((q) => !q.answeredAt && !q.dismissedAt);
  const gates = open.filter((q) => q.kind === 'gate').length;
  if (gates) items.push(say('flow.backlog.gates', { n: gates }));
  if (open.length > OPEN_QUESTIONS_LIMIT) items.push(say('flow.backlog.questions', { n: open.length }));
  return items;
}

/** Случилось ли что-то с прошлого прогона: без дельты офис менеджера не будит. */
function hasDelta(state: OfficeState, since: number | null, now: number): boolean {
  if (since === null) return true;
  if (dayKey(now) !== dayKey(since)) return true;
  // Сравнение нестрогое: событие в ту же миллисекунду, что и прошлый заход,
  // тот заход мог и не увидеть. Лишний заход дешевле пропущенного ответа.
  for (const t of state.tasks.values()) if (t.outcome && t.outcome.at >= since) return true;
  for (const d of state.directionList()) if (d.createdAt >= since) return true;
  for (const q of state.questionList()) if (q.answeredAt && q.answeredAt >= since) return true;
  for (const p of state.proposalList()) if (p.decidedAt && p.decidedAt >= since) return true;
  for (const e of state.epicList()) if (e.finishedAt && e.finishedAt >= since) return true;
  return false;
}

/** Можно ли сейчас собрать совещание: кулдаун и «не без новых направлений». */
function canMeet(state: OfficeState, flowId: string, now: number): boolean {
  const mem = state.flowMemory(flowId);
  if (mem.lastMeetingAt === null) return true;
  const every = (state.settings.meetingEveryDays ?? DEFAULT_MEETING_EVERY_DAYS) * DAY_MS;
  if (now - mem.lastMeetingAt < every) return false;
  const fresh = state.directionList().some((d) => d.createdAt > (mem.lastMeetingAt ?? 0));
  return fresh || mem.meetingsSinceDirection < MEETINGS_WITHOUT_DIRECTION;
}

/** Затухание: каждый пустой заход отодвигает следующий вдвое, до суток. */
function backOff(state: OfficeState, flowId: string, now: number): void {
  const streak = state.flowMemory(flowId).idleStreak + 1;
  const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (streak - 1));
  state.touchFlow(flowId, { idleStreak: streak, backoffUntil: now + wait });
}

const rejectedTitles = (state: OfficeState): string[] =>
  state.proposalList().filter((p) => p.status === 'rejected').slice(-10).map((p) => p.title);

const liveDirections = (state: OfficeState) =>
  state.directionList().filter((d) => d.active && d.id !== HEALTH_DIRECTION);

// ---------------------------------------------------------------- узлы

interface Ctx {
  state: OfficeState;
  workflow: Workflow;
  node: WorkflowNode;
  run: Run;
  now: number;
}

/**
 * Отказ без модели. В лог — только если причина сменилась: та же причина
 * каждые пятнадцать минут — шум, за которым перестают читать остальное.
 * Серию «нечего» от менеджера отказ не трогает: менеджера не спрашивали.
 */
const skip = (ctx: Ctx, why: string): StepResult => {
  const { state, workflow, now } = ctx;
  const mem = state.flowMemory(workflow.id);
  if (mem.lastOutcome !== 'skip' || mem.lastNote !== why) {
    state.addLog(null, 'system', state.say('flow.skip', { flow: workflow.id, why }));
  }
  state.touchFlow(workflow.id, { backoffUntil: now + SKIP_BACKOFF_MS, lastNote: why });
  return { outcome: 'skip', note: why };
};

/**
 * Выжимка без модели: направления, исходы с прошлого раза, что уже отклонено,
 * бюджет на своё. Одновременно — все причины не будить менеджера.
 */
const digest: Executor<Ctx> = {
  async run(ctx) {
    const { state, workflow, now } = ctx;
    const say = state.say.bind(state);
    const mem = state.flowMemory(workflow.id);

    const directions = liveDirections(state);
    if (!directions.length) return skip(ctx, say('flow.noDirections'));
    const backlog = ownerBacklog(state);
    if (backlog.length) return skip(ctx, say('flow.ownerBacklog', { items: backlog.join('; ') }));
    const budget = initiativeBudget(state, now);
    if (budget.exhausted) return skip(ctx, say('flow.budget', { spent: budget.spentUsd.toFixed(2), allowed: budget.allowedUsd.toFixed(2) }));
    if (!hasDelta(state, mem.lastAt, now)) return skip(ctx, say('flow.noDelta'));

    // Дельта есть — затухание снимается: это новый заход, а не тот же.
    state.touchFlow(workflow.id, { backoffUntil: null });
    const since = mem.lastAt ?? now - WEEK_MS;
    const closed = [...state.tasks.values()].filter((t) => t.outcome && t.outcome.at > since);
    const lines = [
      say('flow.digest.directions'),
      ...directions.map((d) => `- ${d.id}: ${d.text}`),
      '',
      say('flow.digest.outcomes', { n: closed.length }),
      ...closed.slice(0, 12).map((t) => say('flow.digest.outcomeRow', {
        task: t.id, title: clip(t.title, 60), kind: t.outcome!.kind, role: t.roleId ?? '',
      })),
      '',
      say('flow.digest.budget', { spent: budget.spentUsd.toFixed(2), allowed: budget.allowedUsd.toFixed(2) }),
      say(canMeet(state, workflow.id, now) ? 'flow.digest.canMeet' : 'flow.digest.cannotMeet'),
    ];
    const rejected = rejectedTitles(state);
    if (rejected.length) lines.push('', say('flow.digest.rejected'), ...rejected.map((t) => `- ${t}`));
    state.addChat(OFFICE_SENDER, say('flow.startChat'));
    return { outcome: 'pass', artifact: { kind: 'digest', text: lines.join('\n') } };
  },
};

/** Менеджер решает: фича по направлению, совещание или «нечего». */
const whatNext: Executor<Ctx> = {
  async run(ctx) {
    const { state, workflow, run, now } = ctx;
    const say = state.say.bind(state);
    const meetOk = canMeet(state, workflow.id, now);
    const out = await agents.decide(state, {
      digest: run.artifacts.digest?.text ?? '',
      canMeet: meetOk,
      directions: liveDirections(state).map((d) => ({ id: d.id, text: d.text })),
      rejected: rejectedTitles(state),
    });
    if (out.error) state.addLog(null, 'error', say('flow.decideFailed', { error: out.error }));

    if (out.kind === 'feature' && out.feature) {
      const made = proposeFeature(state, out.feature);
      if (made.ok) {
        state.touchFlow(workflow.id, { idleStreak: 0, backoffUntil: null });
        return { outcome: 'feature', note: made.message, artifact: { kind: 'decision', text: made.message, ref: 'feature' } };
      }
      state.addLog(null, 'system', made.message);
    }
    if (out.kind === 'meet' && meetOk) {
      const topic = (out.topic ?? '').trim() || say('flow.defaultTopic');
      state.touchFlow(workflow.id, { idleStreak: 0, backoffUntil: null });
      return { outcome: 'meet', note: topic, artifact: { kind: 'decision', text: topic, ref: 'meet' } };
    }
    const why = out.why?.trim() || out.error || say('flow.nothingDefault');
    const streak = state.flowMemory(workflow.id).idleStreak;
    if (streak === 0) state.addChat(OFFICE_SENDER, say('flow.nothingChat', { why }));
    else state.addLog(null, 'system', say('flow.nothingLog', { why }));
    backOff(state, workflow.id, now);
    return { outcome: 'nothing', note: why, artifact: { kind: 'decision', text: why, ref: 'nothing' } };
  },
};

/**
 * Повестка без модели: тема, направления без фич, повторные возвраты,
 * откаты и — главное — что владелец уже отклонял. Здесь же ставится отметка
 * о совещании: кулдаун считается от созыва, а не от итога.
 */
const agenda: Executor<Ctx> = {
  async run(ctx) {
    const { state, workflow, run, now } = ctx;
    const say = state.say.bind(state);
    if (!canMeet(state, workflow.id, now)) return skip(ctx, say('flow.meetingCooldown'));
    const topic = run.artifacts.decision?.text ?? say('flow.defaultTopic');
    const epics = state.epicList();
    const bare = liveDirections(state).filter((d) => !epics.some((e) => e.directionId === d.id));
    const week = now - WEEK_MS;
    const reworked = [...state.tasks.values()].filter((t) => t.outcome && t.outcome.at > week && t.outcome.reworks > 0);
    const reverted = [...state.tasks.values()].filter((t) => t.outcome && t.outcome.at > week && t.outcome.kind === 'reverted');
    const rejected = rejectedTitles(state);
    const lines = [
      say('flow.agenda.topic', { topic }),
      ...(bare.length ? ['', say('flow.agenda.bare'), ...bare.map((d) => `- ${d.id}: ${d.text}`)] : []),
      ...(reworked.length ? ['', say('flow.agenda.reworked'), ...reworked.slice(0, 8).map((t) =>
        say('flow.agenda.reworkedRow', { task: t.id, title: clip(t.title, 60), n: t.outcome!.reworks }))] : []),
      ...(reverted.length ? ['', say('flow.agenda.reverted'), ...reverted.map((t) => `- ${t.id} ${clip(t.title, 60)}`)] : []),
      ...(rejected.length ? ['', say('flow.agenda.rejected'), ...rejected.map((t) => `- ${t}`)] : []),
    ];
    const mem = state.flowMemory(workflow.id);
    const fresh = state.directionList().some((d) => d.createdAt > (mem.lastMeetingAt ?? 0));
    state.touchFlow(workflow.id, {
      lastMeetingAt: now,
      meetingsSinceDirection: fresh ? 1 : mem.meetingsSinceDirection + 1,
    });
    state.addChat(OFFICE_SENDER, say('flow.meetingChat', { topic }));
    return { outcome: 'pass', artifact: { kind: 'agenda', text: lines.join('\n') } };
  },
};

/**
 * Совещание по кругу (§3, `meeting`): менеджер и не больше двух свободных
 * сотрудников разных ролей — если узел просит умения, сначала те, у кого они
 * есть. Стенограмма — артефакт для итога; менеджер получает её не в основную
 * сессию, а в узел `summary`, иначе итог подводился бы дважды.
 */
const meeting: Executor<Ctx> = {
  async run(ctx) {
    const { state, run, node } = ctx;
    const say = state.say.bind(state);
    const topic = run.artifacts.decision?.text ?? say('flow.defaultTopic');
    const pm = [...state.instances.values()].find((i) => state.role(i.roleId)?.isManager);
    const needs = node.needs ?? [];
    const free = [...state.instances.values()].filter((i) => {
      const role = state.role(i.roleId);
      return role && !role.isManager && !role.archived && !i.currentTaskId;
    });
    const score = (id: string): number => {
      const role = state.role(id);
      const caps = role?.capabilities ?? [];
      return needs.filter((n) => caps.includes(n)).length;
    };
    const picked: string[] = [];
    const roles = new Set<string>();
    for (const inst of [...free].sort((a, b) => score(b.roleId) - score(a.roleId))) {
      if (roles.has(inst.roleId) || picked.length >= 2) continue;
      roles.add(inst.roleId);
      picked.push(inst.id);
    }
    const ids = [...(pm ? [pm.id] : []), ...picked];
    if (ids.length < 2) return { outcome: 'failed', note: say('flow.noParticipants') };
    const out = await agents.meeting(state, topic, ids);
    if (!out.ok) return { outcome: 'failed', note: out.error ?? say('meeting.crashed', { error: '' }) };
    const transcript = out.said.map((s) => `${s.title} (${s.id}):\n${s.text}`).join('\n\n');
    return { outcome: 'done', artifact: { kind: 'transcript', text: transcript } };
  },
};

/** Итог совещания менеджером: 2–3 предложения владельцу, всегда через согласование. */
const meetingSummary: Executor<Ctx> = {
  async run(ctx) {
    const { state, run } = ctx;
    const say = state.say.bind(state);
    const out = await agents.summarize(state, {
      agenda: run.artifacts.agenda?.text ?? '',
      transcript: run.artifacts.transcript?.text ?? '',
      rejected: rejectedTitles(state),
    });
    if (out.error) state.addLog(null, 'error', say('flow.decideFailed', { error: out.error }));
    let proposed = 0;
    for (const feature of out.features.slice(0, 3)) {
      const made = proposeFeature(state, feature, { asProposal: true });
      if (made.ok) proposed += 1;
      else state.addLog(null, 'system', made.message);
    }
    const summary = out.summary.trim();
    if (summary) state.addChat(OFFICE_SENDER, say('flow.summaryChat', { summary }));
    return {
      outcome: proposed ? 'proposed' : 'nothing',
      note: summary,
      artifact: { kind: 'summary', text: summary || String(proposed), ref: String(proposed) },
    };
  },
};

const OFFICE: Record<string, Executor<Ctx>> = {
  'office:digest': digest,
  'office:what-next': whatNext,
  'office:agenda': agenda,
  'office:meeting-summary': meetingSummary,
};

const resolveExecutor: Resolve<Ctx> = (node) => {
  if (node.run) return OFFICE[node.run];
  if (node.kind === 'meeting') return meeting;
  return undefined;
};

// -------------------------------------------------------------- прогоны

/** Идущие прогоны офиса: ключ «офис:процесс». */
const running = new Map<string, Promise<void>>();

export const isFlowRunning = (state: OfficeState, flowId: string): boolean =>
  running.has(`${state.officeId}:${flowId}`);

/** Процессы офиса с триггером по состоянию — в порядке файлов, свои поверх встроенных. */
export const stateFlows = (state: OfficeState): Workflow[] =>
  workflowCatalog(state).map((e) => e.workflow).filter((w) => w.trigger.on === 'board.idle');

/**
 * Пора ли процессу: триггер сработал, затухание прошло, не идёт прямо
 * сейчас. Один процесс за проход — как и с ритуалами.
 */
export function dueFlow(state: OfficeState, now = Date.now()): Workflow | null {
  for (const workflow of stateFlows(state)) {
    if (isFlowRunning(state, workflow.id)) return null;
    const mem = state.flowMemory(workflow.id);
    if (mem.backoffUntil && now < mem.backoffUntil) continue;
    if (workflow.trigger.on === 'board.idle' && !boardIdle(state, now)) continue;
    return workflow;
  }
  return null;
}

/** Проход из надзора: запускает процесс, которому пора, и не ждёт его. */
export function tickFlows(state: OfficeState, now = Date.now()): void {
  const due = dueFlow(state, now);
  if (due) void runFlow(state, due, now);
}

/**
 * Провести процесс офиса от начала до конца. Прогон — новый на каждый
 * заход (старый убирается: помнить их все незачем), память триггера —
 * в `life.flows`.
 */
export function runFlow(state: OfficeState, workflow: Workflow, now = Date.now()): Promise<void> {
  const key = `${state.officeId}:${workflow.id}`;
  const already = running.get(key);
  if (already) return already;

  state.pruneFlowRuns(workflow.id, KEEP_FLOW_RUNS - 1);
  const run = newRun(workflow, { flow: workflow.id }, now);
  state.saveRun(run);

  let last: string | null = null;
  const hooks: RunHooks<Ctx> = {
    context: (node) => ({ state, workflow, node, run, now }),
    transition: (_ctx, _from, outcome) => { last = outcome; },
    stuck: (_ctx, why) => {
      state.addLog(null, 'error', state.say('flow.stuck', { flow: workflow.id, why: why.note }));
      if (why.needsDecision) tellPm(state, state.say('flow.stuck', { flow: workflow.id, why: why.note }));
    },
    // Процесс офиса тратит сессиями менеджера — его расход и есть цена узла.
    cost: () => state.instances.get('pm#1')?.usage.costUsd ?? 0,
  };
  const promise = drive(state, workflow, run, resolveExecutor, hooks)
    .catch((err) => {
      state.addLog(null, 'error', state.say('flow.stuck', { flow: workflow.id, why: (err as Error).message }));
    })
    .finally(() => {
      state.touchFlow(workflow.id, { lastAt: now, lastOutcome: last ?? run.note, lastNote: run.note });
      running.delete(key);
    });
  running.set(key, promise);
  return promise;
}

/** Дождаться идущих процессов офиса — проверкам и остановке сервера. */
export async function whenFlowsIdle(state: OfficeState): Promise<void> {
  for (let guard = 0; guard < 50; guard += 1) {
    const runs = [...running.entries()]
      .filter(([key]) => key.startsWith(`${state.officeId}:`))
      .map(([, p]) => p);
    if (!runs.length) return;
    await Promise.all(runs);
  }
}

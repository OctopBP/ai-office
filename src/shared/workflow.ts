/**
 * Процесс (docs/design/workflows/spec.md): как офис ведёт задачу от узла к
 * узлу — кто делает шаг, что считать сделанным, куда идти по исходу и сколько
 * раз можно вернуться назад.
 *
 * Здесь — только форма и её проверка. Модуль общий: сервер по нему ведёт
 * прогоны, а интерфейс однажды будет рисовать доску процессов. Ни git, ни
 * агентов, ни состояния офиса здесь нет.
 *
 * Словарь узлов намеренно маленький (§3 спеки): шесть видов, и он не растёт.
 * Всё, что не выражается ими, выражается действием (`run`) внутри узла.
 */
import { z } from 'zod';

export const NODE_KINDS = ['step', 'check', 'gate', 'decide', 'fanout', 'meeting'] as const;
export type NodeKind = typeof NODE_KINDS[number];

/**
 * Способности (§5 спеки): узел просит не роль, а умение. Словарь общий и
 * короткий — строка с точкой, область и умение.
 */
export const CAPABILITIES = [
  'code.write', 'code.review',
  'docs.write', 'docs.legal', 'docs.marketing',
  'design.ui', 'design.sprite', 'design.3d', 'image.generate',
  'research.web', 'plan', 'summarize',
] as const;
export type Capability = typeof CAPABILITIES[number];
export const isCapability = (s: string): s is Capability =>
  (CAPABILITIES as readonly string[]).includes(s);

/**
 * Тип задачи выбирает процесс (§7.2). Ставится менеджером или выводится из
 * способностей роли, на которую задача заведена.
 */
export const TASK_TYPES = ['code', 'design', 'content', 'research'] as const;
export type TaskType = typeof TASK_TYPES[number];

/** Тип задачи по способностям роли. null — процесса для такой работы нет. */
export function typeForCapabilities(caps: readonly string[]): TaskType | null {
  if (caps.includes('code.write')) return 'code';
  if (caps.some((c) => c.startsWith('design.') || c === 'image.generate')) return 'design';
  if (caps.some((c) => c.startsWith('docs.'))) return 'content';
  if (caps.includes('research.web')) return 'research';
  return null;
}

/**
 * Записка при передаче (§4): что сделано, что решил сам, что не сделано.
 * Пишет тот, кто сдаёт; читает тот, кто принимает. Транскрипт не передаётся.
 */
export interface Handoff {
  did: string;
  assumed: string;
  left: string;
}

/**
 * Артефакт, который есть у любого прогона по задаче ещё до первого узла:
 * отчёт исполнителя с запиской. Узел может брать его в `in`, не объявляя
 * производителя.
 */
export const REPORT_ARTIFACT = 'report';
/** `same: "author"` — тот, кто делал саму задачу, а не узел прогона. */
export const AUTHOR = 'author';

/** Служебные узлы: в файле не описываются, но переход в них разрешён. */
export const END = 'end';
export const STUCK = 'stuck';

/** Стадии пулл-реквеста, которыми узел показывается в панели «Ревью и слияние». */
export const NODE_STAGES = ['sync', 'checks', 'opening', 'review', 'rework', 'merging'] as const;
export type NodeStage = typeof NODE_STAGES[number];

const ID_RE = /^[a-z][a-z0-9-]*$/;
const id = z.string().regex(ID_RE, 'id — строчные латинские буквы, цифры и дефис');

const transitionSchema = z.union([
  id,
  z.object({ to: id, max: z.number().int().min(1).optional() }).strict(),
]);

const nodeSchema = z.object({
  id,
  kind: z.enum(NODE_KINDS),
  /** Действие узла из каталога офиса (`office:sync-base`) или проекта. */
  run: z.string().optional(),
  /** Что должен уметь исполнитель (§5). У check/gate — нет. */
  needs: z.array(z.enum(CAPABILITIES)).optional(),
  /**
   * Исход узла, если в офисе НЕТ ни одной роли с такими умениями. Без него
   * работа встаёт навсегда: нанять роль может только человек, а сделанная
   * работа тем временем не доезжает даже до согласования. Указывать имеет
   * смысл там, где шаг — проверка чужой работы, а не сама работа.
   */
  noRole: z.string().optional(),
  /** Тот же исполнитель, что делал этот узел; `author` — сама задача. */
  same: id.optional(),
  /** Не тот, кто делал этот узел: запрет самопроверки. */
  notSameAs: id.optional(),
  /** Какие артефакты предыдущих узлов подать на вход. */
  in: z.array(id).optional(),
  /** Под каким именем узел кладёт свой артефакт в прогон. */
  out: id.optional(),
  /** Что считать сделанным — проверяемые пункты, как критерии задачи. */
  done: z.array(z.string()).optional(),
  limits: z.object({
    turns: z.number().int().min(1).optional(),
    usd: z.number().min(0).optional(),
    model: z.string().optional(),
  }).strict().optional(),
  /** Как узел показывается в панели пулл-реквестов. */
  stage: z.enum(NODE_STAGES).optional(),
  /** Куда дальше: исход → узел. Обратный переход обязан иметь `max`. */
  next: z.record(z.string(), transitionSchema),
}).strict();

const triggerSchema = z.discriminatedUnion('on', [
  z.object({ on: z.literal('task.created'), type: z.string().optional() }).strict(),
  z.object({ on: z.literal('task.finished'), type: z.enum(TASK_TYPES).optional() }).strict(),
  z.object({ on: z.literal('epic.approved') }).strict(),
  /** Доска пуста: всё закрыто или ждёт человека, сессий нет (§6.2). */
  z.object({ on: z.literal('board.idle') }).strict(),
  /** Тихий тик: событий не было N минут; не чаще, чем раз в everyHours. */
  z.object({ on: z.literal('quiet'), minutes: z.number().int().min(1), everyHours: z.number().min(0).optional() }).strict(),
  z.object({ on: z.literal('day.first') }).strict(),
  z.object({ on: z.literal('week') }).strict(),
  z.object({ on: z.literal('owner.answered') }).strict(),
  z.object({ on: z.literal('manual') }).strict(),
]);

const workflowSchema = z.object({
  id,
  version: z.number().int().min(1),
  trigger: triggerSchema,
  /** Узлы по порядку; первый — с него прогон начинается. */
  nodes: z.array(nodeSchema).min(1),
}).strict();

export type Trigger = z.infer<typeof triggerSchema>;

export interface Transition {
  to: string;
  /** Сколько раз подряд можно пройти этот переход. Есть у каждой петли. */
  max?: number;
}

export interface WorkflowNode extends Omit<z.infer<typeof nodeSchema>, 'next'> {
  next: Record<string, Transition>;
}

export interface Workflow {
  id: string;
  version: number;
  trigger: Trigger;
  nodes: WorkflowNode[];
}

/** Ключ перехода в счётчиках прогона. */
export const edgeKey = (from: string, to: string): string => `${from}>${to}`;

const isNode = (workflow: Workflow, nodeId: string): boolean =>
  workflow.nodes.some((n) => n.id === nodeId);

/** Узлы, достижимые из `from` по переходам, прошедшим фильтр (сам `from` включён). */
function reachable(
  workflow: Workflow, from: string, allow: (tr: Transition) => boolean,
): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = workflow.nodes.find((n) => n.id === cur);
    if (!node) continue;
    for (const tr of Object.values(node.next)) {
      if (allow(tr) && isNode(workflow, tr.to) && !seen.has(tr.to)) stack.push(tr.to);
    }
  }
  return seen;
}

/**
 * Разобрать файл процесса. Опечатка, лишний ключ, переход в несуществующий
 * узел, петля без предела — всё это ошибка, а не предупреждение: файл пишет
 * человек, и проглоченная опечатка находится через неделю глазами.
 */
export function parseWorkflow(data: unknown, where = '<workflow>'): Workflow {
  const parsed = workflowSchema.parse(data);
  const workflow: Workflow = {
    ...parsed,
    nodes: parsed.nodes.map((n) => ({
      ...n,
      next: Object.fromEntries(Object.entries(n.next).map(([outcome, tr]) =>
        [outcome, typeof tr === 'string' ? { to: tr } : { ...tr }])),
    })),
  };

  const seen = new Set<string>();
  for (const node of workflow.nodes) {
    if (seen.has(node.id)) throw new Error(`${where}: узел «${node.id}» объявлен дважды`);
    if (node.id === END || node.id === STUCK) {
      throw new Error(`${where}: «${node.id}» — служебное имя, узел так назвать нельзя`);
    }
    seen.add(node.id);
  }

  for (const node of workflow.nodes) {
    if (!Object.keys(node.next).length) {
      throw new Error(`${where}: у узла «${node.id}» нет ни одного перехода`);
    }
    for (const name of node.in ?? []) {
      if (name !== REPORT_ARTIFACT && !workflow.nodes.some((n) => n.out === name)) {
        throw new Error(`${where}: узел «${node.id}» ждёт артефакт «${name}», который никто не производит`);
      }
    }
    if (node.noRole !== undefined) {
      if (!node.needs?.length) {
        throw new Error(`${where}: у узла «${node.id}» есть noRole, но нет умений needs — пропускать нечего`);
      }
      if (!(node.noRole in node.next)) {
        throw new Error(`${where}: узел «${node.id}» по noRole уходит в исход «${node.noRole}», которого нет среди переходов`);
      }
    }
    for (const ref of [node.same, node.notSameAs]) {
      if (ref && ref !== AUTHOR && !seen.has(ref)) {
        throw new Error(`${where}: узел «${node.id}» ссылается на исполнителя узла «${ref}», а такого узла нет`);
      }
    }
    for (const [outcome, tr] of Object.entries(node.next)) {
      if (tr.to !== END && tr.to !== STUCK && !seen.has(tr.to)) {
        throw new Error(`${where}: «${node.id}» по исходу «${outcome}» ведёт в «${tr.to}», а такого узла нет`);
      }
      // Любой круг обязан проходить хотя бы через один переход с пределом:
      // без него он крутился бы за деньги, пока не кончится бюджет. То есть
      // переходы без max сами по себе кругов образовывать не должны.
      if (tr.max === undefined && tr.to !== END && tr.to !== STUCK
        && reachable(workflow, tr.to, (t) => t.max === undefined).has(node.id)) {
        throw new Error(`${where}: переход «${node.id} → ${tr.to}» замыкает круг, в котором нет ни одного предела max`);
      }
    }
  }
  return workflow;
}

export const nodeOf = (workflow: Workflow, nodeId: string): WorkflowNode | null =>
  workflow.nodes.find((n) => n.id === nodeId) ?? null;

export const firstNode = (workflow: Workflow): WorkflowNode => workflow.nodes[0];

/**
 * Тело каждой петли: узлы, достижимые из её конца по обычным (не петлевым)
 * переходам. По нему раннер решает, сбрасывать ли счётчик: в узел пришли
 * снаружи петли — это новый заход, и попытки считаются заново; пришли изнутри
 * — это тот же заход, и попытки копятся.
 *
 * Так «автор чинит проверки не больше раза за круг» и «ревьюер возвращает не
 * больше двух раз за всю задачу» выражаются одним и тем же `max`: круг ревью
 * возвращает прогон в узел проверок снаружи их петли, а в узел ревью — изнутри
 * петли доработки.
 */
export function loopBodies(workflow: Workflow): Map<string, Set<string>> {
  const bodies = new Map<string, Set<string>>();
  for (const node of workflow.nodes) {
    for (const tr of Object.values(node.next)) {
      if (tr.max === undefined) continue;
      bodies.set(edgeKey(node.id, tr.to), reachable(workflow, tr.to, (t) => t.max === undefined));
    }
  }
  return bodies;
}

/** Предел петли по исходу узла с данным действием. null — такого перехода нет. */
export function loopMax(workflow: Workflow, run: string, outcome: string): number | null {
  const node = workflow.nodes.find((n) => n.run === run);
  return node?.next[outcome]?.max ?? null;
}

// ---------------------------------------------------------------- прогон

/** То, что узел оставляет после себя и что получает следующий (§4 спеки). */
export interface RunArtifact {
  kind: string;
  text: string;
  ref?: string;
}

/** 'waiting' — стоит на узле согласования и ничего не тратит. */
export type RunStatus = 'running' | 'waiting' | 'stuck' | 'done';

/**
 * Прогон: процесс, применённый к одной задаче (§2 спеки). Помнит, где стоит,
 * откуда пришёл, сколько раз прошёл каждую петлю и что собрал по дороге.
 * Держит версию процесса, на которой начался: правка файла касается только
 * новых прогонов.
 */
export interface Run {
  id: string;
  workflowId: string;
  version: number;
  /** По чему идёт прогон: задача, фича или процесс самого офиса (`flow`). */
  subject: { taskId?: string; epicId?: string; flow?: string };
  nodeId: string;
  /** Откуда пришли в текущий узел. null — с начала (первый заход или перезапуск). */
  from: string | null;
  /** Сколько раз прошли каждую петлю, ключ — edgeKey(). */
  loops: Record<string, number>;
  artifacts: Record<string, RunArtifact>;
  /** Кто делал каждый узел-шаг: для `same` и `notSameAs`. */
  actors: Record<string, string>;
  /** Что стоил и сколько шёл каждый узел (§10): для сравнения процессов. */
  steps: RunStep[];
  /** Вопрос владельцу, ответа на который ждёт узел согласования. */
  waitingOn: string | null;
  status: RunStatus;
  needsDecision: boolean;
  /** Готовая фраза: почему встал. */
  note: string;
  startedAt: number;
  updatedAt: number;
}

/** Один пройденный узел: чем кончился, сколько шёл, сколько стоил. */
export interface RunStep {
  node: string;
  outcome: string;
  startedAt: number;
  ms: number;
  costUsd: number;
}

/** Имя своей проверки проекта (`run: "project:<имя>"`, Settings.checks). */
export const CHECK_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Процесс глазами интерфейса: откуда взят, что в файле, что с ним не так.
 * Файл проекта с ошибкой показывается вместе с ошибкой, а офис тем временем
 * едет по встроенному.
 */
export interface WorkflowEntry {
  id: string;
  source: 'builtin' | 'project';
  /** Есть и встроенный, и файл проекта — проект перекрывает. */
  overrides: boolean;
  workflow: Workflow;
  /** Текст файла, по которому офис едет; у встроенного — его собственный. */
  text: string;
  /** Файл проекта не разобрался: причина. Офис едет по встроенному. */
  problem: string | null;
}

export interface NodeStats {
  node: string;
  runs: number;
  avgMs: number;
  avgCostUsd: number;
  outcomes: Record<string, number>;
}

export interface WorkflowStats {
  workflowId: string;
  version: number;
  runs: number;
  done: number;
  stuck: number;
  costUsd: number;
  nodes: NodeStats[];
}

/**
 * Расход по узлам (§10) из прогонов: сколько узел стоит, сколько идёт, чем
 * кончается. Считается по версии процесса — так две редакции одного файла
 * можно положить рядом и увидеть, дала ли правка что-нибудь.
 */
export function workflowStats(runs: Run[]): WorkflowStats[] {
  const byKey = new Map<string, WorkflowStats & { _nodes: Map<string, { n: number; ms: number; cost: number; outcomes: Record<string, number> }> }>();
  for (const run of runs) {
    const key = `${run.workflowId}@${run.version}`;
    let stats = byKey.get(key);
    if (!stats) {
      stats = { workflowId: run.workflowId, version: run.version, runs: 0, done: 0, stuck: 0, costUsd: 0, nodes: [], _nodes: new Map() };
      byKey.set(key, stats);
    }
    stats.runs += 1;
    if (run.status === 'done') stats.done += 1;
    if (run.status === 'stuck') stats.stuck += 1;
    for (const step of run.steps ?? []) {
      stats.costUsd += step.costUsd;
      const node = stats._nodes.get(step.node) ?? { n: 0, ms: 0, cost: 0, outcomes: {} };
      node.n += 1;
      node.ms += step.ms;
      node.cost += step.costUsd;
      node.outcomes[step.outcome] = (node.outcomes[step.outcome] ?? 0) + 1;
      stats._nodes.set(step.node, node);
    }
  }
  return [...byKey.values()].map(({ _nodes, ...stats }) => ({
    ...stats,
    nodes: [..._nodes.entries()].map(([node, v]) => ({
      node, runs: v.n, avgMs: v.n ? Math.round(v.ms / v.n) : 0,
      avgCostUsd: v.n ? v.cost / v.n : 0, outcomes: v.outcomes,
    })),
  })).sort((a, b) => a.workflowId.localeCompare(b.workflowId) || b.version - a.version);
}

/**
 * Память триггера по состоянию (§6.2): когда процесс шёл в последний раз,
 * чем кончился, сколько раз подряд ответил «нечего делать» и до какого
 * момента его не будить. Без дельты прогона нет; после «нечего» — затухание.
 */
export interface FlowMemory {
  lastAt: number | null;
  lastOutcome: string | null;
  /** Причина последнего исхода — чтобы не писать одно и то же в лог каждый проход. */
  lastNote: string | null;
  /** Сколько раз подряд менеджер ответил «нечего делать». */
  idleStreak: number;
  backoffUntil: number | null;
  /** Когда офис в последний раз сам созывал совещание о развитии. */
  lastMeetingAt: number | null;
  /** Сколько совещаний подряд прошло без нового направления от владельца. */
  meetingsSinceDirection: number;
}

export const emptyFlowMemory = (): FlowMemory => ({
  lastAt: null, lastOutcome: null, lastNote: null, idleStreak: 0, backoffUntil: null, lastMeetingAt: null,
  meetingsSinceDirection: 0,
});

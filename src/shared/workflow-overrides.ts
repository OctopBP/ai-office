/**
 * Правки процесса офиса (docs/design/workflows/spec.md, «Правки процесса
 * офиса»): поверх базового процесса — встроенного или своего у проекта —
 * офис хранит список правок. Файл процесса при этом не меняется: правка —
 * это настройка офиса, а не редакция процесса.
 *
 * Правка одна — «выключить узел», всегда или при условии (роль, тип задачи,
 * зона). Выключенный узел из процесса вынимается: переходы, которые вели в
 * него, ведут туда, куда он отправил бы при успехе (`pass`, `approve`,
 * `done`), а узлы, до которых после этого не дойти, выпадают вместе с ним.
 * Так выключенный ревью уводит задачу от открытия PR прямо к проверкам и
 * слиянию, а доработка по отзыву выпадает сама — её больше некому вызвать.
 *
 * Здесь — только форма, сборка и проверка. Хранение, история и лента —
 * src/server/workflow-overrides.ts.
 */
import { END, STUCK, nodeOf, parseWorkflow, type TaskType, type Transition, type Workflow, type WorkflowNode } from './workflow';

/**
 * Обязательные узлы — по действию. Их нельзя выключить ни всегда, ни по
 * условию: слияние и гейт с проверками держат основную ветку целой, и без
 * них процесс кода превращается в «влить что угодно». Пред-merge гейт
 * (premerge.ts) живёт внутри действия `office:merge`, проверки ветки —
 * `office:checks`.
 */
export const REQUIRED_RUNS: readonly string[] = ['office:merge', 'office:checks'];

/** Исходы «узел сделан», в порядке предпочтения: по нему идёт обход выключенного узла. */
export const BYPASS_OUTCOMES: readonly string[] = ['pass', 'approve', 'done', 'ok', 'yes'];

/**
 * Условие пропуска. Поля складываются через «и», значения внутри поля — через
 * «или»: `{ roles: ['backend'], types: ['code'] }` — задачи роли backend типа
 * code. Пустое условие запрещено: для «всегда» условие не задают вовсе.
 */
export interface SkipWhen {
  roles?: string[];
  types?: TaskType[];
  /** Зоны (подпроекты) задачи — `Task.subprojectId`. */
  zones?: string[];
}

/** Действующая правка: узел выключен всегда (`when` нет) или по условию. */
export interface NodeOverride {
  node: string;
  when?: SkipWhen;
  /** Каким исходом обходить узел; по умолчанию первый подходящий из BYPASS_OUTCOMES. */
  outcome?: string;
}

/** Запись истории: кто, когда, что и почему. */
export interface OverrideChange {
  at: number;
  /** Кто правил: владелец, менеджер, id сотрудника. */
  by: string;
  why: string;
  action: 'disable' | 'enable' | 'reset';
  node?: string;
  when?: SkipWhen;
  outcome?: string;
}

/** Правки одного процесса в офисе. */
export interface WorkflowOverrides {
  workflowId: string;
  /** Растёт на каждую правку и сброс: по нему видно, что набор поменялся. */
  rev: number;
  rules: NodeOverride[];
  history: OverrideChange[];
}

/** Что известно о задаче для условия пропуска. */
export interface SkipSubject {
  roleId?: string | null;
  type?: TaskType | null;
  zone?: string | null;
}

export function skipMatches(when: SkipWhen, subject: SkipSubject): boolean {
  const has = <T>(list: T[] | undefined, value: T | null | undefined) =>
    !list?.length || (value != null && list.includes(value));
  return has(when.roles, subject.roleId) && has(when.types, subject.type) && has(when.zones, subject.zone);
}

const isEmptyWhen = (when: SkipWhen): boolean =>
  !when.roles?.length && !when.types?.length && !when.zones?.length;

/** Каким исходом обойти узел. null — у узла нет исхода «сделано». */
export function bypassOutcome(node: WorkflowNode, wanted?: string): string | null {
  if (wanted) return wanted in node.next ? wanted : null;
  return BYPASS_OUTCOMES.find((o) => o in node.next) ?? null;
}

/** Причина отказа правки кодом: интерфейс по нему подбирает текст на своём языке. */
export type OverrideFailureCode =
  | 'noNode' | 'dup' | 'required' | 'emptyWhen' | 'noOutcome' | 'noBypass'
  | 'cycle' | 'noSteps' | 'dropped' | 'noEnd' | 'needed' | 'broken'
  | 'noWorkflow' | 'noReason' | 'notDisabled';

/** Отказ с кодом; `node` — о каком узле речь, `detail` — довесок (список, артефакт, сырой текст). */
export interface OverrideFailure {
  code: OverrideFailureCode;
  node?: string;
  detail?: string;
  text: string;
}

class OverrideError extends Error {
  constructor(readonly failure: OverrideFailure) { super(failure.text); }
}
const fail = (code: OverrideFailureCode, text: string, node?: string, detail?: string): never => {
  throw new OverrideError({ code, text, ...(node ? { node } : {}), ...(detail ? { detail } : {}) });
};

/**
 * Собрать процесс без узлов `off`. Бросает понятную ошибку, если без них
 * процесс не собирается: нет исхода обхода, обход ходит по кругу, выпал
 * обязательный узел, нет пути до конца или файл процесса перестал быть цел.
 */
function withoutNodes(base: Workflow, off: Map<string, NodeOverride>): Workflow {
  if (!off.size) return base;
  const where = `процесс «${base.id}»`;

  const bypass = (to: string): Transition | null => {
    const seen = new Set<string>();
    let cur = to;
    while (off.has(cur)) {
      if (seen.has(cur)) fail('cycle', `${where}: выключенные узлы обходят друг друга по кругу (${[...seen].join(' → ')})`, cur, [...seen].join(' → '));
      seen.add(cur);
      const node = nodeOf(base, cur) as WorkflowNode;
      const outcome = bypassOutcome(node, off.get(cur)?.outcome) as string;
      cur = node.next[outcome].to;
    }
    return cur === to ? null : { to: cur };
  };

  const nodes = base.nodes
    .filter((n) => !off.has(n.id))
    .map((n) => ({
      ...n,
      next: Object.fromEntries(Object.entries(n.next).map(([outcome, tr]) => {
        const moved = bypass(tr.to);
        return [outcome, moved ? { ...tr, to: moved.to } : { ...tr }];
      })),
    }));

  const start = bypass(base.nodes[0].id)?.to ?? base.nodes[0].id;
  if (start === END || start === STUCK) {
    fail('noSteps', `${where}: без выключенных узлов в процессе не остаётся ни одного шага`);
  }

  // Узлы, до которых от начала больше не дойти, выпадают: их некому вызвать.
  const reach = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (reach.has(cur)) continue;
    reach.add(cur);
    for (const tr of Object.values(nodes.find((n) => n.id === cur)?.next ?? {})) {
      if (tr.to !== END && tr.to !== STUCK) stack.push(tr.to);
    }
  }
  const kept = nodes.filter((n) => reach.has(n.id));
  kept.sort((a, b) => (a.id === start ? -1 : b.id === start ? 1 : 0));

  for (const node of base.nodes) {
    if (node.run && REQUIRED_RUNS.includes(node.run) && !reach.has(node.id) && !off.has(node.id)) {
      fail('dropped', `${where}: обязательный узел «${node.id}» (${node.run}) выпадает из процесса — до него больше не дойти`, node.id);
    }
  }
  if (!kept.some((n) => Object.values(n.next).some((tr) => tr.to === END))) {
    fail('noEnd', `${where}: без выключенных узлов у процесса нет пути до конца`);
  }

  try {
    return parseWorkflow({ ...base, nodes: kept.map((n) => ({ ...n, next: n.next })) }, where);
  } catch (err) {
    const text = (err as Error).message;
    const needs = /узел «([^»]+)» ждёт артефакт «([^»]+)»/.exec(text);
    if (needs) fail('needed', `${text} — правка ломает процесс`, needs[1], needs[2]);
    fail('broken', `${text} — правка ломает процесс`, undefined, text);
  }
  throw new Error('недостижимо');
}

/**
 * Действующий процесс: база с правками. Правки по условию применяются, только
 * если задача известна и подходит; без задачи (каталог, подсказки промпту)
 * действуют лишь безусловные.
 */
export function applyOverrides(base: Workflow, rules: readonly NodeOverride[], subject?: SkipSubject): Workflow {
  const off = new Map<string, NodeOverride>();
  for (const rule of rules) {
    if (!rule.when || (subject && skipMatches(rule.when, subject))) off.set(rule.node, rule);
  }
  return withoutNodes(base, off);
}

/**
 * Проверить набор правок целиком. Сначала каждая сама по себе (узел есть, не
 * обязательный, условие не пустое, обход есть), потом сборка: безусловные
 * вместе с любым сочетанием условных — задача может попасть под любые из них
 * сразу. null — набор годен, иначе текст ошибки.
 */
export function overridesFailure(base: Workflow, rules: readonly NodeOverride[]): OverrideFailure | null {
  const seen = new Set<string>();
  for (const rule of rules) {
    const node = nodeOf(base, rule.node);
    if (!node) {
      const known = base.nodes.map((n) => n.id).join(', ');
      return { code: 'noNode', node: rule.node, detail: known, text: `в процессе «${base.id}» нет узла «${rule.node}»; есть: ${known}` };
    }
    if (seen.has(rule.node)) return { code: 'dup', node: rule.node, text: `узел «${rule.node}» правится дважды` };
    seen.add(rule.node);
    if (node.run && REQUIRED_RUNS.includes(node.run)) {
      return { code: 'required', node: node.id, text: `узел «${node.id}» (${node.run}) обязательный — слияние и гейт с проверками выключить нельзя` };
    }
    if (rule.when && isEmptyWhen(rule.when)) {
      return { code: 'emptyWhen', node: node.id, text: `у правки узла «${node.id}» пустое условие — для «всегда» условие не задают` };
    }
    if (!bypassOutcome(node, rule.outcome)) {
      return rule.outcome
        ? { code: 'noOutcome', node: node.id, detail: rule.outcome, text: `у узла «${node.id}» нет исхода «${rule.outcome}»; есть: ${Object.keys(node.next).join(', ')}` }
        : { code: 'noBypass', node: node.id, text: `у узла «${node.id}» нет исхода «сделано» (${BYPASS_OUTCOMES.join(', ')}) — непонятно, куда идти без него` };
    }
  }

  const always = rules.filter((r) => !r.when);
  const maybe = rules.filter((r) => r.when);
  // Сочетаний 2^n; условных правок на процесс — единицы. Больше 8 — проверяем
  // крайние: ни одной и все сразу.
  const combos = maybe.length <= 8
    ? Array.from({ length: 1 << maybe.length }, (_, mask) => maybe.filter((_r, i) => mask & (1 << i)))
    : [[], maybe];
  for (const combo of combos) {
    const off = new Map([...always, ...combo].map((r) => [r.node, r] as const));
    try {
      withoutNodes(base, off);
    } catch (err) {
      if (err instanceof OverrideError) return err.failure;
      return { code: 'broken', detail: (err as Error).message, text: (err as Error).message };
    }
  }
  return null;
}

/** То же текстом (русским, для ленты и инструментов менеджера): null — набор годен. */
export function overridesProblem(base: Workflow, rules: readonly NodeOverride[]): string | null {
  return overridesFailure(base, rules)?.text ?? null;
}

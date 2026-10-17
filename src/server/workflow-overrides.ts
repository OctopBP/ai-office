/**
 * Правки процесса офиса: хранение с историей, сборка действующего процесса и
 * лента (docs/design/workflows/spec.md, «Правки процесса офиса»).
 *
 * Правки живут в состоянии офиса (`OfficeState.workflowOverrides`, state.json)
 * и лежат поверх базового процесса — встроенного из `workflows/` или своего у
 * проекта. Файлы процессов они не трогают. Форма, сборка и проверка —
 * src/shared/workflow-overrides.ts; здесь — то, что связано с офисом.
 *
 * Действующий процесс собирается на старте прогона и кладётся в сам прогон
 * (`Run.plan`): задача, уже идущая по конвейеру, доезжает по процессу, с
 * которым начинала, а новые идут по новому.
 */
import {
  applyOverrides, overridesProblem, type NodeOverride, type SkipSubject, type SkipWhen, type WorkflowOverrides,
} from '../shared/workflow-overrides';
import { TASK_TYPES, type Run, type TaskType, type Workflow, type WorkflowEntry } from '../shared/workflow';
import type { OfficeState, Task } from './state';
import { workflowCatalog, workflowFor } from './workflows';

export interface OverrideResult {
  ok: boolean;
  message: string;
}

/** Правки процесса в офисе; пустой набор, если правок не было. */
export function overridesOf(state: OfficeState, workflowId: string): WorkflowOverrides {
  return state.workflowOverrides.get(workflowId) ?? { workflowId, rev: 0, rules: [], history: [] };
}

/** Кто правил, если не сказано: правят процесс владелец или менеджер по его слову. */
const OWNER = 'owner';

/** Условие в одну строку для ленты. */
function whenText(state: OfficeState, when?: SkipWhen): string {
  if (!when) return state.say('wfo.always');
  const parts = [
    when.roles?.length ? state.say('wfo.when.roles', { list: when.roles.join(', ') }) : '',
    when.types?.length ? state.say('wfo.when.types', { list: when.types.join(', ') }) : '',
    when.zones?.length ? state.say('wfo.when.zones', { list: when.zones.join(', ') }) : '',
  ].filter(Boolean);
  return parts.join('; ');
}

/** Привести условие в порядок: без пустых строк и повторов, типы — только известные. */
function tidyWhen(when: SkipWhen | undefined): { when?: SkipWhen; problem?: string } {
  if (!when) return {};
  const list = (xs: unknown): string[] | undefined => {
    if (xs === undefined) return undefined;
    if (!Array.isArray(xs)) return [];
    const clean = [...new Set(xs.map((x) => String(x).trim()).filter(Boolean))];
    return clean.length ? clean : undefined;
  };
  const types = list(when.types);
  const bad = types?.filter((t) => !(TASK_TYPES as readonly string[]).includes(t));
  if (bad?.length) return { problem: `неизвестный тип задачи: ${bad.join(', ')}; есть: ${TASK_TYPES.join(', ')}` };
  const out: SkipWhen = {};
  const roles = list(when.roles);
  const zones = list(when.zones);
  if (roles) out.roles = roles;
  if (types) out.types = types as TaskType[];
  if (zones) out.zones = zones;
  return { when: out };
}

/** Записать новый набор правил: проверка, история, лента. */
function commit(
  state: OfficeState, base: Workflow, rules: NodeOverride[],
  change: WorkflowOverrides['history'][number], text: string,
): OverrideResult {
  const problem = overridesProblem(base, rules);
  if (problem) return { ok: false, message: state.say('wfo.rejected', { problem }) };
  const prev = overridesOf(state, base.id);
  state.setWorkflowOverrides({
    workflowId: base.id, rev: prev.rev + 1, rules, history: [...prev.history, change],
  });
  state.addLog(null, 'system', text);
  state.emitWorkflows();
  return { ok: true, message: text };
}

/** Базовый процесс или понятная ошибка. */
function baseOf(state: OfficeState, workflowId: string): Workflow | string {
  return workflowFor(state, workflowId)
    ?? `процесса «${workflowId}» нет; есть: ${workflowCatalog(state).map((e) => e.id).join(', ')}`;
}

/**
 * Выключить узел процесса — всегда или по условию. Правка того же узла
 * заменяет прежнюю: на узел действует одна правка.
 */
export function disableNode(state: OfficeState, input: {
  workflowId: string; node: string; when?: SkipWhen; outcome?: string; why: string; by?: string;
}): OverrideResult {
  const base = baseOf(state, input.workflowId);
  if (typeof base === 'string') return { ok: false, message: state.say('wfo.rejected', { problem: base }) };
  const why = input.why?.trim() ?? '';
  if (!why) return { ok: false, message: state.say('wfo.rejected', { problem: 'нужна причина правки' }) };
  const tidy = tidyWhen(input.when);
  if (tidy.problem) return { ok: false, message: state.say('wfo.rejected', { problem: tidy.problem }) };
  if (input.when && !tidy.when) {
    return { ok: false, message: state.say('wfo.rejected', { problem: `у правки узла «${input.node}» пустое условие — для «всегда» условие не задают` }) };
  }
  const rule: NodeOverride = {
    node: input.node,
    ...(tidy.when ? { when: tidy.when } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
  };
  const rules = [...overridesOf(state, base.id).rules.filter((r) => r.node !== input.node), rule];
  return commit(state, base, rules, {
    at: Date.now(), by: input.by ?? OWNER, why, action: 'disable', node: input.node,
    ...(rule.when ? { when: rule.when } : {}), ...(rule.outcome ? { outcome: rule.outcome } : {}),
  }, state.say('wfo.disabled', {
    workflow: base.id, node: input.node, when: whenText(state, rule.when), why,
  }));
}

/** Включить узел обратно: снять его правку. */
export function enableNode(state: OfficeState, input: {
  workflowId: string; node: string; why: string; by?: string;
}): OverrideResult {
  const base = baseOf(state, input.workflowId);
  if (typeof base === 'string') return { ok: false, message: state.say('wfo.rejected', { problem: base }) };
  const why = input.why?.trim() ?? '';
  if (!why) return { ok: false, message: state.say('wfo.rejected', { problem: 'нужна причина правки' }) };
  const current = overridesOf(state, base.id).rules;
  if (!current.some((r) => r.node === input.node)) {
    return { ok: false, message: state.say('wfo.rejected', { problem: `узел «${input.node}» в процессе «${base.id}» не выключен` }) };
  }
  return commit(state, base, current.filter((r) => r.node !== input.node), {
    at: Date.now(), by: input.by ?? OWNER, why, action: 'enable', node: input.node,
  }, state.say('wfo.enabled', { workflow: base.id, node: input.node, why }));
}

/** Сбросить все правки процесса: офис вернётся к базовому. История остаётся. */
export function resetOverrides(state: OfficeState, input: {
  workflowId: string; why: string; by?: string;
}): OverrideResult {
  const base = baseOf(state, input.workflowId);
  if (typeof base === 'string') return { ok: false, message: state.say('wfo.rejected', { problem: base }) };
  const why = input.why?.trim() ?? '';
  if (!why) return { ok: false, message: state.say('wfo.rejected', { problem: 'нужна причина правки' }) };
  const current = overridesOf(state, base.id).rules;
  if (!current.length) return { ok: true, message: state.say('wfo.nothingToReset', { workflow: base.id }) };
  const nodes = current.map((r) => r.node).join(', ');
  return commit(state, base, [], {
    at: Date.now(), by: input.by ?? OWNER, why, action: 'reset',
  }, state.say('wfo.reset', { workflow: base.id, nodes, why }));
}

/** Что известно о задаче для условий пропуска. */
export const subjectOf = (task: Task): SkipSubject => ({
  roleId: task.roleId ?? null,
  type: task.type ?? (task.branch ? 'code' : null),
  zone: task.subprojectId ?? null,
});

/**
 * Действующий процесс: база с правками офиса. Без задачи действуют только
 * безусловные правки. Правки, которые перестали сходиться с базой (свой файл
 * процесса у проекта поменяли), не применяются: офис едет по базе и пишет об
 * этом в ленту — лучше лишний узел, чем процесс без слияния.
 */
export function effectiveWorkflow(
  state: OfficeState, base: Workflow, subject?: SkipSubject,
): Workflow {
  const set = state.workflowOverrides.get(base.id);
  if (!set?.rules.length) return base;
  try {
    return applyOverrides(base, set.rules, subject);
  } catch (err) {
    state.addLog(null, 'error', state.say('wfo.broken', { workflow: base.id, problem: (err as Error).message }));
    return base;
  }
}

/** Действующий процесс по id; null — такого процесса нет. */
export function effectiveWorkflowById(state: OfficeState, workflowId: string, subject?: SkipSubject): Workflow | null {
  const base = workflowFor(state, workflowId);
  return base ? effectiveWorkflow(state, base, subject) : null;
}

/**
 * Новый прогон берёт действующий процесс и кладёт его в себя, если он
 * отличается от базы. Идущий прогон — по тому, с чем начинал.
 */
export function planRun(state: OfficeState, run: Run, effective: Workflow, base: Workflow): void {
  if (effective === base) return;
  run.plan = effective;
  run.overridesRev = overridesOf(state, base.id).rev;
}

/** Процесс, по которому идёт прогон: снимок со старта или база. */
export const runWorkflow = (run: Run | null | undefined, base: Workflow): Workflow =>
  run?.plan && run.plan.id === base.id ? run.plan : base;

/** Каталог процессов для интерфейса — с правками офиса у каждого процесса. */
export function catalogWithEdits(state: OfficeState): WorkflowEntry[] {
  return workflowCatalog(state).map((entry) => {
    const set = state.workflowOverrides.get(entry.id);
    return set && (set.rules.length || set.history.length)
      ? { ...entry, officeEdits: { rev: set.rev, rules: set.rules, history: set.history } }
      : entry;
  });
}

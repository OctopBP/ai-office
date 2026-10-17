/**
 * Инструменты менеджера для процессов офиса (docs/design/workflows/spec.md,
 * «Правки процесса офиса»): посмотреть процессы, выключить или включить узел,
 * сбросить к базовому. Сами правки, валидатор и лента — workflow-overrides.ts;
 * здесь только разговор с менеджером: разбор аргументов и текст ответа.
 *
 * Отдельным модулем, как docs-tools.ts: менеджер подключает их в teamTools, а
 * проверка зовёт обработчики напрямую, без сессии и без сервера.
 */
import { z } from 'zod';
import { overridesProblem, REQUIRED_RUNS, type NodeOverride, type SkipWhen } from '../shared/workflow-overrides';
import { TASK_TYPES, type Trigger, type WorkflowEntry } from '../shared/workflow';
import { tool } from './engines';
import { hasKey } from './i18n';
import type { OfficeState } from './state';
import { workflowFor } from './workflows';
import {
  catalogWithEdits, disableNode, effectiveWorkflow, enableNode, overridesOf, resetOverrides,
} from './workflow-overrides';

/** Кто правит: менеджер по слову владельца. */
const PM = 'pm#1';

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function titleOf(state: OfficeState, id: string): string {
  const key = `wfl.title.${id}`;
  return hasKey(key) ? state.say(key) : id;
}

function triggerText(state: OfficeState, trigger: Trigger): string {
  const key = `wfl.on.${trigger.on}`;
  const on = hasKey(key) ? state.say(key) : trigger.on;
  const type = 'type' in trigger ? trigger.type : undefined;
  return type ? state.say('wfl.on.type', { on, type }) : on;
}

function whenText(state: OfficeState, when: SkipWhen): string {
  return [
    when.roles?.length ? state.say('wfo.when.roles', { list: when.roles.join(', ') }) : '',
    when.types?.length ? state.say('wfo.when.types', { list: when.types.join(', ') }) : '',
    when.zones?.length ? state.say('wfo.when.zones', { list: when.zones.join(', ') }) : '',
  ].filter(Boolean).join('; ');
}

/** Один процесс: шапка и узлы по порядку с пометками. */
export function workflowText(state: OfficeState, entry: WorkflowEntry): string {
  const set = overridesOf(state, entry.id);
  const edits = set.rules.length
    ? state.say('wfl.edits.some', { rev: set.rev })
    : set.history.length ? state.say('wfl.edits.history') : state.say('wfl.edits.none');
  const head = state.say('wfl.head', {
    id: entry.id, title: titleOf(state, entry.id), source: state.say(entry.source === 'project' ? 'wfl.source.project' : 'wfl.source.builtin'),
    when: triggerText(state, entry.workflow.trigger), edits,
  });
  // Что останется от процесса без условных правок: узлы, выпавшие вслед за
  // выключенными, видны менеджеру, иначе «убрал ревью» выглядит как «убрал
  // только ревью».
  const effective = effectiveWorkflow(state, entry.workflow);
  const kept = new Set(effective.nodes.map((n) => n.id));
  const rules = new Map(set.rules.map((r) => [r.node, r] as const));
  const lines = entry.workflow.nodes.map((node, i) => {
    const marks: string[] = [];
    const rule = rules.get(node.id);
    if (rule && !rule.when) marks.push(state.say('wfl.mark.off', { why: state.say('wfo.always') }));
    else if (rule?.when) marks.push(state.say('wfl.mark.when', { when: whenText(state, rule.when) }));
    else if (!kept.has(node.id)) marks.push(state.say('wfl.mark.dropped'));
    if (node.run && REQUIRED_RUNS.includes(node.run)) marks.push(state.say('wfl.mark.required'));
    const run = node.run ? ` (${node.run})` : '';
    return `  ${i + 1}. ${node.id}${run}${marks.length ? ` — ${marks.join('; ')}` : ''}`;
  });
  const problem = entry.problem ? [state.say('wfl.problem', { problem: entry.problem })] : [];
  return [head, ...problem, ...lines].join('\n');
}

export function workflowsText(state: OfficeState): string {
  const catalog = catalogWithEdits(state);
  return catalog.length ? catalog.map((e) => workflowText(state, e)).join('\n\n') : state.say('wfl.empty');
}

const WHEN = z.object({
  roles: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  zones: z.array(z.string()).optional(),
}).strict();

type Change = {
  node: string;
  action: 'disable' | 'enable';
  when?: z.infer<typeof WHEN>;
  outcome?: string;
};

/**
 * Проверить все правки до записи: набор, который получится после них, обязан
 * пройти валидатор целиком. Иначе первая правка легла бы, вторая — нет, и
 * процесс остался бы наполовину поправленным. null — годен.
 */
function changesProblem(state: OfficeState, workflowId: string, changes: Change[]): string | null {
  const base = workflowFor(state, workflowId);
  if (!base) return null; // про несуществующий процесс внятно скажет disableNode
  let rules: NodeOverride[] = [...overridesOf(state, workflowId).rules];
  for (const ch of changes) {
    if (ch.action === 'enable') {
      if (!rules.some((r) => r.node === ch.node)) return `узел «${ch.node}» в процессе «${workflowId}» не выключен`;
      rules = rules.filter((r) => r.node !== ch.node);
      continue;
    }
    const bad = ch.when?.types?.filter((t) => !(TASK_TYPES as readonly string[]).includes(t));
    if (bad?.length) return `неизвестный тип задачи: ${bad.join(', ')}; есть: ${TASK_TYPES.join(', ')}`;
    rules = [...rules.filter((r) => r.node !== ch.node), {
      node: ch.node, ...(ch.when ? { when: ch.when as SkipWhen } : {}), ...(ch.outcome ? { outcome: ch.outcome } : {}),
    }];
  }
  return overridesProblem(base, rules);
}

/** Применить правки менеджера: сначала проверка всего набора, потом по одной. */
export function editWorkflow(
  state: OfficeState, input: { workflowId: string; changes: Change[]; reason: string },
): { ok: boolean; message: string } {
  const workflowId = input.workflowId.trim();
  if (!input.changes.length) return { ok: false, message: state.say('tool.editWorkflow.empty') };
  const problem = changesProblem(state, workflowId, input.changes);
  if (problem) return { ok: false, message: state.say('wfo.rejected', { problem }) };
  const lines: string[] = [];
  let ok = true;
  for (const ch of input.changes) {
    const out = ch.action === 'enable'
      ? enableNode(state, { workflowId, node: ch.node.trim(), why: input.reason, by: PM })
      : disableNode(state, {
        workflowId, node: ch.node.trim(), why: input.reason, by: PM,
        ...(ch.when ? { when: ch.when as SkipWhen } : {}), ...(ch.outcome ? { outcome: ch.outcome } : {}),
      });
    lines.push(`- ${out.message}`);
    if (!out.ok) { ok = false; break; }
  }
  const entry = catalogWithEdits(state).find((e) => e.id === workflowId);
  const now = entry ? workflowText(state, entry) : '—';
  return {
    ok,
    message: state.say(ok ? 'tool.editWorkflow.ok' : 'tool.editWorkflow.partial', {
      workflow: workflowId, lines: lines.join('\n'), now,
    }),
  };
}

export function workflowTools(state: OfficeState) {
  return [
    tool(
      'list_workflows',
      state.say('tool.listWorkflows.desc'),
      {},
      async () => text(workflowsText(state)),
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'edit_workflow',
      state.say('tool.editWorkflow.desc'),
      {
        workflowId: z.string().describe(state.say('tool.editWorkflow.id')),
        changes: z.array(z.object({
          node: z.string().describe(state.say('tool.editWorkflow.node')),
          action: z.enum(['disable', 'enable']).describe(state.say('tool.editWorkflow.action')),
          when: WHEN.optional().describe(state.say('tool.editWorkflow.when')),
          outcome: z.string().optional().describe(state.say('tool.editWorkflow.outcome')),
        })).describe(state.say('tool.editWorkflow.changes')),
        reason: z.string().describe(state.say('tool.editWorkflow.reason')),
      },
      async (args) => {
        const out = editWorkflow(state, args);
        return text(out.message, !out.ok);
      },
    ),

    tool(
      'reset_workflow',
      state.say('tool.resetWorkflow.desc'),
      {
        workflowId: z.string().describe(state.say('tool.resetWorkflow.id')),
        reason: z.string().describe(state.say('tool.resetWorkflow.reason')),
      },
      async (args) => {
        const workflowId = args.workflowId.trim();
        const out = resetOverrides(state, { workflowId, why: args.reason, by: PM });
        const entry = out.ok ? catalogWithEdits(state).find((e) => e.id === workflowId) : undefined;
        return text(entry ? `${out.message}\n\n${workflowText(state, entry)}` : out.message, !out.ok);
      },
    ),
  ];
}

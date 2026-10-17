/**
 * Логика экрана «Процессы» в настройках офиса: состояние узлов и проверка
 * переключателя. Компонент только рисует то, что отсюда вернулось. Проверка —
 * та же `overridesProblem`, что на сервере, поэтому отказ виден до отправки.
 */
import { REQUIRED_RUNS, bypassOutcome, overridesProblem, type NodeOverride, type SkipWhen } from '../shared/workflow-overrides';
import type { WorkflowEntry, WorkflowNode } from '../shared/workflow';

/** Как узел выглядит в списке. */
export type NodeMode = 'on' | 'off' | 'conditional' | 'required';

export interface NodeView {
  node: WorkflowNode;
  mode: NodeMode;
  when?: SkipWhen;
  /** Почему переключатель недоступен (обязательный узел, нет исхода обхода); null — доступен. */
  locked: 'required' | 'noBypass' | null;
}

const isRequired = (node: WorkflowNode): boolean => Boolean(node.run && REQUIRED_RUNS.includes(node.run));

/** Узлы процесса по порядку, каждый с состоянием. */
export function nodeViews(entry: WorkflowEntry): NodeView[] {
  const rules = entry.officeEdits?.rules ?? [];
  return entry.workflow.nodes.map((node) => {
    const rule = rules.find((r) => r.node === node.id);
    if (isRequired(node)) return { node, mode: 'required', locked: 'required' };
    const noBypass = !bypassOutcome(node);
    const locked = noBypass && !rule ? 'noBypass' : null;
    if (!rule) return { node, mode: 'on', locked };
    return { node, mode: rule.when ? 'conditional' : 'off', when: rule.when, locked };
  });
}

/**
 * Что сделает переключатель на узле: `disable` — выключить всегда, `enable` —
 * снять правку (и безусловную, и условную). Отказ — текстом.
 */
export function toggleAction(entry: WorkflowEntry, view: NodeView): { action: 'disable' | 'enable' } | { problem: string } {
  if (view.mode === 'off' || view.mode === 'conditional') return { action: 'enable' };
  const rules: NodeOverride[] = [...(entry.officeEdits?.rules ?? []), { node: view.node.id }];
  const problem = overridesProblem(entry.workflow, rules);
  return problem ? { problem } : { action: 'disable' };
}

/** Есть ли что сбрасывать. */
export const hasEdits = (entry: WorkflowEntry): boolean => (entry.officeEdits?.rules.length ?? 0) > 0;

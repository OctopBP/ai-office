/**
 * Логика экрана «Процессы» в настройках офиса: состояние узлов и проверка
 * переключателя. Компонент только рисует то, что отсюда вернулось. Проверка —
 * та же `overridesProblem`, что на сервере, поэтому отказ виден до отправки.
 */
import { REQUIRED_RUNS, overridesFailure, type NodeOverride, type OverrideFailure, type SkipWhen } from '../shared/workflow-overrides';
import { t } from './i18n';
import type { WorkflowEntry, WorkflowNode } from '../shared/workflow';

/** Как узел выглядит в списке. */
export type NodeMode = 'on' | 'off' | 'conditional' | 'required';

export interface NodeView {
  node: WorkflowNode;
  mode: NodeMode;
  when?: SkipWhen;
  /**
   * Почему переключатель недоступен: обязательный узел, нет исхода обхода,
   * выключение ломает процесс (`blocked`, например следующий узел ждёт
   * артефакт этого); null — доступен.
   */
  locked: 'required' | 'noBypass' | 'blocked' | null;
  /** Причина блокировки кодом, когда она не «обязательный». */
  failure?: OverrideFailure;
}

/** Причина отказа текстом на языке интерфейса. */
export const failureText = (f: OverrideFailure): string =>
  t(`wfx.fail.${f.code}`, { node: f.node ?? '', detail: f.detail ?? '' });

const isRequired = (node: WorkflowNode): boolean => Boolean(node.run && REQUIRED_RUNS.includes(node.run));

/** Узлы процесса по порядку, каждый с состоянием. */
export function nodeViews(entry: WorkflowEntry): NodeView[] {
  const rules = entry.officeEdits?.rules ?? [];
  return entry.workflow.nodes.map((node) => {
    const rule = rules.find((r) => r.node === node.id);
    if (isRequired(node)) return { node, mode: 'required', locked: 'required' };
    // Выключить узел с правкой нечего проверять — её можно только снять.
    if (rule) return { node, mode: rule.when ? 'conditional' : 'off', when: rule.when, locked: null };
    const failure = overridesFailure(entry.workflow, [...rules, { node: node.id }]);
    if (!failure) return { node, mode: 'on', locked: null };
    return { node, mode: 'on', locked: failure.code === 'noBypass' ? 'noBypass' : 'blocked', failure };
  });
}

/**
 * Что сделает переключатель на узле: `disable` — выключить всегда, `enable` —
 * снять правку (и безусловную, и условную). Отказ — текстом.
 */
export function toggleAction(entry: WorkflowEntry, view: NodeView): { action: 'disable' | 'enable' } | { problem: string } {
  if (view.mode === 'off' || view.mode === 'conditional') return { action: 'enable' };
  const rules: NodeOverride[] = [...(entry.officeEdits?.rules ?? []), { node: view.node.id }];
  const failure = overridesFailure(entry.workflow, rules);
  return failure ? { problem: failureText(failure) } : { action: 'disable' };
}

/** Есть ли что сбрасывать. */
export const hasEdits = (entry: WorkflowEntry): boolean => (entry.officeEdits?.rules.length ?? 0) > 0;

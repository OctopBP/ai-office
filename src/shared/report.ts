/**
 * Табель роли — сводка исходов её задач за окно времени
 * (docs/design/living-office/spec.md §3.2).
 *
 * Считается, а не хранится, и лежит в общем контракте намеренно: одну и ту же
 * сводку показывает окно команды в вебе и читает менеджер на еженедельной
 * рефлексии. Разойдись эти две формулы — человек и менеджер спорили бы о
 * «доле чистых закрытий» роли, глядя на разные числа.
 */
import type { OutcomeKind, TaskView } from './types';

/** Одна задача глазами табеля: только то, что нужно для сводки. */
export type ReportTask = Pick<TaskView, 'roleId' | 'outcome' | 'usage'>;

export interface RoleReport {
  roleId: string;
  /** Закрытых задач всего — с любым исходом. */
  closed: number;
  byKind: Record<OutcomeKind, number>;
  /** Доля закрытых чисто среди влитых и сделанных (без провалов и снятых). */
  cleanShare: number;
  /** Средняя глубина переделки среди задач, которые переделывались. */
  avgReworks: number;
  /** Средняя стоимость закрытой задачи. */
  avgCostUsd: number;
  totalCostUsd: number;
  /**
   * Честность критериев: доля отмеченных автором пунктов среди задач, которые
   * ревьюер потом возвращал. Роль, которая отмечает все пункты и получает
   * возврат, врёт себе — и это видно именно здесь, а не в средней цене.
   */
  claimedBeforeRework: number | null;
  /** Задачи, поставленные офисом себе, против поставленных человеком. */
  byOrigin: { owner: number; office: number };
}

const emptyKinds = (): Record<OutcomeKind, number> => ({
  clean: 0, reworked: 0, stuck: 0, failed: 0, cancelled: 0, reverted: 0,
});

/**
 * Табель одной роли по задачам с исходом не раньше `since`. Задачи без исхода
 * не считаются вовсе: они ещё идут, и судить о них не по чему.
 */
export function roleReport(tasks: ReportTask[], roleId: string, since = 0): RoleReport {
  const mine = tasks.filter((t) => t.roleId === roleId && t.outcome && t.outcome.at >= since);
  const byKind = emptyKinds();
  const byOrigin = { owner: 0, office: 0 };
  let cost = 0;
  let reworks = 0;
  let reworked = 0;
  let claimed = 0;
  let claimedTotal = 0;
  for (const task of mine) {
    const o = task.outcome!;
    byKind[o.kind] += 1;
    byOrigin[o.origin] += 1;
    cost += o.costUsd;
    if (o.reworks > 0) {
      reworked += 1;
      reworks += o.reworks;
      claimed += o.criteria.claimed;
      claimedTotal += o.criteria.total;
    }
  }
  const delivered = byKind.clean + byKind.reworked + byKind.stuck + byKind.reverted;
  return {
    roleId,
    closed: mine.length,
    byKind,
    cleanShare: delivered ? byKind.clean / delivered : 0,
    avgReworks: reworked ? reworks / reworked : 0,
    avgCostUsd: mine.length ? cost / mine.length : 0,
    totalCostUsd: cost,
    claimedBeforeRework: claimedTotal ? claimed / claimedTotal : null,
    byOrigin,
  };
}

/** Табели всех ролей, у которых за окно есть хоть один исход. */
export function roleReports(tasks: ReportTask[], since = 0): RoleReport[] {
  const roles = new Set<string>();
  for (const t of tasks) if (t.roleId && t.outcome && t.outcome.at >= since) roles.add(t.roleId);
  return [...roles].sort().map((id) => roleReport(tasks, id, since));
}

/** Неделя в миллисекундах — окно табеля по умолчанию. */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

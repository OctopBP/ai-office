import type { EpicHold, EpicView } from '../shared/types';
import { t } from './i18n';

/**
 * Почему фича стоит — словами для шапки фичи. Причину считает сервер
 * (EpicView.hold), веб только переводит её в текст: так доска и карточка в
 * чате не могут разойтись в объяснении.
 */
export function epicHoldText(hold: EpicHold): string {
  switch (hold.kind) {
    case 'approval': return t('plan.awaiting');
    case 'slot': return t('plan.hold.slot', { epics: hold.epics.join(', ') });
    case 'share': return t('plan.hold.share');
    case 'tasks': return t('plan.hold.tasks', { tasks: hold.tasks.join(', ') });
    case 'stuck': return t('plan.hold.stuck', { tasks: hold.tasks.join(', ') });
    case 'unstaffed': return t('plan.hold.unstaffed', { tasks: hold.tasks.join(', ') });
  }
}

/**
 * Подпись «чего ждёт» для согласованной фичи. Про согласие шапка говорит
 * отдельно, рядом с кнопкой «Поехали», поэтому здесь его нет. Причины ещё нет
 * (сервер старее веба) — прежнее «ждёт очереди».
 */
export function epicWaitLabel(epic: EpicView): string | null {
  const hold = epic.hold ?? null;
  if (hold && hold.kind !== 'approval') return epicHoldText(hold);
  return epic.status === 'planned' && epic.approved ? t('plan.queued') : null;
}

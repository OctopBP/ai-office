/**
 * Кнопки быстрого ответа в чате с менеджером (T-599). Менеджер спрашивает в
 * реплике «Запустить задачу?» и зовёт `offer_replies` — под репликой встают
 * кнопки с вариантами. Реплика хода ложится в чат только по `result`, когда
 * инструмент уже отработал, поэтому варианты копятся на сессии чата
 * (`PmSession.replies`) и прикрепляются к реплике в конце хода: она и есть
 * последняя реплика хода — промежуточную подводку SDK в результат не кладёт.
 */
import type { ChatEntry } from '../shared/types';
import { tidyReplies } from '../shared/types';
import type { OfficeState, PmSession } from './state';

/**
 * Запомнить варианты для реплики текущего хода. Повторный вызов в том же ходе
 * заменяет прежние варианты: в чат идёт только последняя реплика, и кнопки
 * должны отвечать на неё. null — после нормализации выбирать не из чего
 * (меньше двух вариантов), прежние варианты не тронуты.
 */
export function offerReplies(pm: PmSession, options: readonly unknown[]): string[] | null {
  const replies = tidyReplies(options);
  if (!replies.length) return null;
  pm.replies = replies;
  return replies;
}

/**
 * Ход менеджера закончился репликой: положить её в чат вместе с вариантами,
 * если он их предложил, и забыть варианты — следующий ход начинает с чистого.
 */
export function settlePmReply(state: OfficeState, pm: PmSession, text: string): ChatEntry {
  const replies = pm.replies ?? undefined;
  pm.replies = null;
  return state.addChat('pm#1', text, 'pm#1', undefined, pm.chatId, undefined, replies);
}

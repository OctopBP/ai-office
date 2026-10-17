/**
 * Кнопки быстрого ответа в чате с менеджером (T-599). Менеджер спрашивает в
 * реплике «Запустить задачу?» и зовёт `offer_replies` — под репликой встают
 * кнопки с вариантами. Реплика хода ложится в чат только по `result`, когда
 * инструмент уже отработал, поэтому варианты копятся на сессии чата
 * (`PmSession.replies`) и прикрепляются к реплике в конце хода.
 *
 * `result` у SDK — только последний текстовый блок хода. Суть вариантов
 * менеджер обычно пишет до вызова `offer_replies`, а после него — короткий
 * хвост, и в чат попадал один хвост: кнопки без объяснения (T-643). Поэтому
 * текстовые блоки хода копятся тоже (`PmSession.turnText`), и реплика с
 * кнопками собирается из всех них. Реплика без кнопок по-прежнему — итог хода:
 * там подводка перед инструментами («сейчас посмотрю доску») ответом не была.
 */
import type { ChatEntry } from '../shared/types';
import { tidyReplies } from '../shared/types';
import type { SDKMessage } from './engines/types';
import type { OfficeState, PmSession } from './state';

/**
 * Запомнить варианты для реплики текущего хода. Повторный вызов в том же ходе
 * заменяет прежние варианты: реплика хода одна, и кнопки должны отвечать на
 * неё. null — после нормализации выбирать не из чего (меньше двух вариантов),
 * прежние варианты не тронуты.
 */
export function offerReplies(pm: PmSession, options: readonly unknown[]): string[] | null {
  const replies = tidyReplies(options);
  if (!replies.length) return null;
  pm.replies = replies;
  return replies;
}

/**
 * Текст менеджера из готового сообщения SDK — в текст хода. Берём только
 * верхний уровень (непустой `parent_tool_use_id` — речь подагента) и только
 * разговорные ходы: сжатие памяти и передача дел (`rotating`) — не реплика.
 * Подряд идущий повтор того же блока не дублируем.
 */
export function notePmText(pm: PmSession, msg: SDKMessage): void {
  if (msg.type !== 'assistant' || msg.parent_tool_use_id || pm.rotating) return;
  for (const block of msg.message.content ?? []) {
    if (block.type !== 'text') continue;
    const text = block.text?.trim();
    if (text && pm.turnText[pm.turnText.length - 1] !== text) pm.turnText.push(text);
  }
}

/**
 * Реплика хода с кнопками: все текстовые блоки хода по порядку, итог хода —
 * последним, если SDK его ещё не прислал отдельным сообщением.
 */
function turnReply(blocks: readonly string[], result: string): string {
  const parts = blocks.filter(Boolean);
  if (!parts.length || parts[parts.length - 1] !== result) parts.push(result);
  return parts.join('\n\n');
}

/**
 * Ход менеджера закончился репликой: положить её в чат вместе с вариантами,
 * если он их предложил, и забыть варианты и текст хода — следующий ход
 * начинает с чистого. С вариантами в реплику идёт весь текст хода, чтобы
 * описание того, из чего выбирать, стояло прямо над кнопками.
 */
export function settlePmReply(state: OfficeState, pm: PmSession, text: string): ChatEntry {
  const replies = pm.replies ?? undefined;
  const body = replies ? turnReply(pm.turnText, text) : text;
  pm.replies = null;
  pm.turnText = [];
  return state.addChat('pm#1', body, 'pm#1', undefined, pm.chatId, undefined, replies);
}

/**
 * Кнопки быстрого ответа в чате с менеджером (T-599). Менеджер спрашивает в
 * реплике «Запустить задачу?» и зовёт `offer_replies` — под репликой встают
 * кнопки с вариантами. Реплика хода ложится в чат только по `result`, когда
 * инструмент уже отработал, поэтому варианты копятся на сессии чата
 * (`PmSession.replies`) и прикрепляются к реплике в конце хода.
 *
 * `result` у SDK Claude — только последний текстовый блок хода. Суть ответа
 * менеджер обычно пишет до вызова инструмента (`offer_replies`, `create_task`),
 * а после него — короткий хвост, и в чат попадал один хвост (T-643, T-664).
 * Поэтому текстовые блоки хода копятся (`PmSession.turnText`), и реплика
 * собирается из всех них по порядку. У Codex и OpenCode `result` — уже все
 * блоки хода подряд, второй раз их не дописываем.
 *
 * Рассуждения (thinking) в реплику не идут никогда: это не речь владельцу.
 * Если модель написала ответ в рассуждениях, а текстом — только хвост,
 * `offer_replies` возвращает ей подсказку дописать реплику текстом (T-664).
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

/** Есть ли в текущем ходе текст, который владелец увидит в реплике. */
export function turnHasText(pm: PmSession): boolean {
  return pm.turnText.length > 0;
}

/** Текст без различий в пробелах и переводах строк — для сравнения блоков с `result`. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Реплика хода: все текстовые блоки хода по порядку. Итог хода дописывается
 * в конец, только если его ещё нет среди блоков: у Claude это последний блок,
 * у Codex и OpenCode — все блоки, склеенные переводом строки. Блоков нет
 * (сообщения не пришли) — реплика из одного итога.
 */
export function turnReply(blocks: readonly string[], result: string): string {
  const parts = blocks.map((b) => b.trim()).filter(Boolean);
  const tail = result.trim();
  if (!parts.length) return tail;
  if (!tail) return parts.join('\n\n');
  const said = flat(parts.join(' '));
  const ending = flat(tail);
  if (said.endsWith(ending)) return parts.join('\n\n');
  // Итог шире блоков (часть сообщений до нас не дошла) — он и есть реплика.
  if (ending.endsWith(said)) return tail;
  return [...parts, tail].join('\n\n');
}

/**
 * Ход менеджера закончился: положить реплику в чат вместе с вариантами,
 * если он их предложил, и забыть варианты и текст хода — следующий ход
 * начинает с чистого. В реплику идёт весь текст хода по порядку, кнопки — под
 * ней. null — сказать нечего: ни текста хода, ни итога.
 */
export function settlePmReply(state: OfficeState, pm: PmSession, text: string): ChatEntry | null {
  const replies = pm.replies ?? undefined;
  const body = turnReply(pm.turnText, text);
  pm.replies = null;
  pm.turnText = [];
  if (!body) return null;
  return state.addChat('pm#1', body, 'pm#1', undefined, pm.chatId, undefined, replies);
}

/**
 * Автоназвание чатов с менеджером: после ответа менеджера дешёвая модель
 * смотрит на последние реплики и называет чат по теме в 2–5 слов.
 *
 * Когда: впервые — после первого обмена репликами (до этого в названии первая
 * строка владельца, см. `autoChatTitle` в state.ts), дальше — не чаще, чем раз
 * в `RETITLE_EVERY` реплик владельца. Смену темы решает сама модель: ей
 * показывают текущее название, и если оно ещё подходит, она его и
 * возвращает — тогда ничего не меняется и клиентам ничего не уходит.
 *
 * Чего не трогает: основной чат (его название — роль, а не тема: туда падают
 * события без привязки) и чат, переименованный владельцем (`PmChat.renamed`).
 *
 * Сама модель подключается из agents.ts через `setChatTitler`, как ритуалы:
 * так этот модуль не тянет за собой движок и проверяется без сети. Сбой
 * генерации ни на что не влияет — название остаётся прежним.
 */
import type { OfficeState } from './state';

/** Реплик владельца между пересмотрами названия. */
export const RETITLE_EVERY = 4;
/** Сколько последних реплик видит модель: тема — это недавнее, а не вся история. */
const LAST_MESSAGES = 6;
/** Длина одной реплики в запросе: для темы хватает начала, а токены дешевле не бывают. */
const MESSAGE_CLIP = 400;
/** Предел готового названия: 2–5 слов в него укладываются с запасом. */
const TITLE_MAX = 60;

export interface ChatTitleInput {
  current: string;
  messages: Array<{ from: 'owner' | 'manager'; text: string }>;
}

/** Модель, которая называет чат. Пустой ответ или null — «не знаю», название не меняется. */
export type ChatTitler = (state: OfficeState, input: ChatTitleInput) => Promise<string | null>;

let titler: ChatTitler = async () => null;

export function setChatTitler(next: ChatTitler): void {
  titler = next;
}

/**
 * Сколько реплик владельца было в чате, когда его называли в последний раз.
 * Только в памяти: после перезапуска чат один раз пересмотрят заново, и если
 * тема та же, модель вернёт то же название — дёшево и безвредно.
 */
const marks = new WeakMap<OfficeState, Map<string, number>>();
/** Чаты, для которых название уже генерируется: второй вызов параллельно не нужен. */
const busy = new WeakMap<OfficeState, Set<string>>();

const bucket = <T>(map: WeakMap<OfficeState, T>, state: OfficeState, make: () => T): T => {
  let v = map.get(state);
  if (!v) map.set(state, v = make());
  return v;
};

/** Пора ли называть: первый раз — как только владелец что-то сказал, дальше — через `RETITLE_EVERY` реплик. */
export const titleDue = (ownerCount: number, lastMark: number | undefined): boolean =>
  ownerCount > 0 && (lastMark === undefined || ownerCount - lastMark >= RETITLE_EVERY);

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Ответ модели — в название: первая непустая строка без кавычек, префикса
 * «Название:» и точки в конце. Модель, начавшая рассуждать, даст длинную
 * строку — такую не берём, прежнее название лучше обрезанной фразы.
 */
export function cleanTitle(raw: string | null | undefined): string {
  const line = (raw ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const title = line
    .replace(/^(название|title)\s*:\s*/i, '')
    .replace(/[.。]+$/, '')
    .replace(/^["'«“„`*]+|["'»”`*]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || title.length > TITLE_MAX || title.split(' ').length > 8) return '';
  return title;
}

/**
 * Пересмотреть название чата после ответа менеджера. Ничего не ждёт от
 * вызывающего и ничего не бросает: вызывается как `void maybeAutoTitle(...)`.
 */
export async function maybeAutoTitle(state: OfficeState, chatId: string | undefined): Promise<void> {
  if (!chatId) return;
  const chat = state.pmChats.get(chatId);
  if (!chat || chat.main || chat.renamed) return;
  // Только живой разговор: карточки задач и реплики самого офиса о теме не говорят.
  const talk = state.chat.filter((e) => e.thread === 'pm#1' && e.chatId === chatId && !e.ref
    && (e.from === 'user' || e.from === 'pm#1'));
  const ownerCount = talk.filter((e) => e.from === 'user').length;
  const chatMarks = bucket(marks, state, () => new Map<string, number>());
  if (!titleDue(ownerCount, chatMarks.get(chatId))) return;
  const running = bucket(busy, state, () => new Set<string>());
  if (running.has(chatId)) return;
  running.add(chatId);
  // Отметка — до вызова: сбой не должен превращаться в повтор на каждой реплике.
  chatMarks.set(chatId, ownerCount);
  try {
    const title = cleanTitle(await titler(state, {
      current: chat.title,
      messages: talk.slice(-LAST_MESSAGES).map((e) => ({
        from: e.from === 'user' ? 'owner' as const : 'manager' as const,
        text: clip(e.text.trim().replace(/\s+/g, ' '), MESSAGE_CLIP),
      })),
    }));
    if (title) state.autoTitlePmChat(chatId, title);
  } catch (err) {
    console.warn(`[chattitle] ${chatId}: ${(err as Error).message}`);
  } finally {
    running.delete(chatId);
  }
}

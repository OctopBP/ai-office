/**
 * Вопросы владельцу: что общее у сервера и веба. Признак «открыт» и сходство
 * двух вопросов считаются одинаково по обе стороны сокета — иначе значок,
 * планёрка и подсказка «похоже на Q-N» разошлись бы между собой.
 */
import type { OwnerQuestion, QuestionQuote, QuestionRef } from './types';

/** Открыт: без ответа, не снят и не объединён с другим вопросом. */
export const isOpenQuestion = (q: OwnerQuestion): boolean =>
  !q.answeredAt && !q.dismissedAt && !q.mergedInto;

/**
 * Необязательные поля разметки вопроса (спека owner-questions-simple §7):
 * суть, подробности, цитаты, основание, ссылки, подтверждение, группа.
 */
export type QuestionMeta = Pick<OwnerQuestion,
  'title' | 'details' | 'quotes' | 'basis' | 'refs' | 'confirm' | 'proposal' | 'groupKey' | 'groupTitle' | 'groupOptions'>;

/** Поля разметки списком: что проверять у старого вопроса и что снимать при правке. */
export const QUESTION_META_KEYS = [
  'title', 'details', 'quotes', 'basis', 'refs', 'confirm', 'proposal', 'groupKey', 'groupTitle', 'groupOptions',
] as const satisfies readonly (keyof QuestionMeta)[];

/** Предел короткой сути вопроса. */
export const TITLE_MAX = 120;
/** Пределы списков разметки: карточке хватает, а state.json не пухнет. */
export const QUOTES_MAX = 8;
export const REFS_MAX = 12;
export const GROUP_OPTIONS_MAX = 4;
/** Длина одной цитаты и подписи к ней. */
const QUOTE_LEN = 600;
const NOTE_LEN = 80;
/** Длина темы группы: она встаёт в заголовок после «N похожих вопросов — ». */
const GROUP_TITLE_LEN = 80;
/** Длина общего варианта группы — как у кнопки варианта. */
const OPTION_LEN = 40;

const REF_KINDS: readonly QuestionRef['kind'][] = ['journal', 'task', 'commit', 'file'];

/** Хеш коммита: 7–40 шестнадцатеричных знаков, среди которых есть цифра и буква. */
const HASH_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

/**
 * Короткая суть из сырой строки: одна строка, без номеров записей журнала
 * (J-12) и хешей коммитов, не длиннее `max`. Пустая строка — сути нет.
 */
export function questionTitle(raw: string | undefined, max = TITLE_MAX): string {
  const line = (raw ?? '')
    .replace(/\(\s*\bJ-\d+\b\s*\)/g, '')
    .replace(/\bJ-\d+\b:?/g, '')
    .replace(HASH_RE, '')
    .replace(/\(\s*[,;]?\s*\)/g, '')
    .replace(/\s+([,.;:!?»)])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/g, '')
    .trim();
  return clipText(line, max);
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Что показать заголовком: короткая суть, а у старых вопросов — весь текст. */
export const questionHeadline = (q: Pick<OwnerQuestion, 'title' | 'text'>): string =>
  q.title?.trim() || q.text;

/**
 * Ссылки, которые упоминает текст: записи журнала (J-12), задачи (T-40),
 * коммиты (хеш) и файлы проекта (src/…/x.ts). Порядок — как в тексте.
 */
export function refsInText(text: string | undefined): QuestionRef[] {
  if (!text) return [];
  const found: { at: number; ref: QuestionRef }[] = [];
  const scan = (re: RegExp, kind: QuestionRef['kind']): void => {
    for (const m of text.matchAll(re)) found.push({ at: m.index ?? 0, ref: { kind, id: m[0] } });
  };
  scan(/\bJ-\d+\b/g, 'journal');
  scan(/\bT-\d+\b/g, 'task');
  scan(new RegExp(HASH_RE.source, 'g'), 'commit');
  scan(/(?<![\w/.-])(?:src|scripts|docs|workflows|packages|desktop|registry|design|tools)\/[\w./-]*\w\.[a-z]{1,5}\b/g, 'file');
  return found.sort((a, b) => a.at - b.at).map((f) => f.ref);
}

/** Ссылки без пустых и повторов, в пределе `REFS_MAX`. */
function tidyRefs(refs: QuestionRef[] | undefined): QuestionRef[] {
  const out: QuestionRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs ?? []) {
    const id = ref?.id?.trim();
    if (!id || !REF_KINDS.includes(ref.kind)) continue;
    const key = `${ref.kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = ref.label?.trim();
    out.push({ kind: ref.kind, id, ...(label ? { label } : {}) });
    if (out.length >= REFS_MAX) break;
  }
  return out;
}

function tidyQuotes(quotes: QuestionQuote[] | undefined): QuestionQuote[] {
  const out: QuestionQuote[] = [];
  for (const q of quotes ?? []) {
    const text = q?.text?.trim();
    const ref = q?.ref?.trim();
    if (!text || !ref) continue;
    const note = q.note?.trim();
    out.push({ ref, text: clipText(text, QUOTE_LEN), ...(note ? { note: clipText(note, NOTE_LEN) } : {}) });
    if (out.length >= QUOTES_MAX) break;
  }
  return out;
}

function tidyOptions(options: string[] | undefined): string[] {
  const out: string[] = [];
  for (const o of options ?? []) {
    const text = clipText(o?.trim() ?? '', OPTION_LEN);
    if (!text || out.some((x) => x.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
    if (out.length >= GROUP_OPTIONS_MAX) break;
  }
  return out;
}

/**
 * Привести разметку к виду для хранения: пустое выбрасываем, суть чистим и
 * режем, списки чистим от пустого и повторов. `proposal` — признак
 * подтверждения (§7), поэтому с ним всегда ставится `confirm`, а `confirm`
 * без `proposal` не храним: подтверждать нечего. Тема и общие варианты
 * группы без `groupKey` не храним: группы нет.
 */
export function tidyQuestionMeta(meta: QuestionMeta | undefined): QuestionMeta {
  if (!meta) return {};
  const out: QuestionMeta = {};
  const title = questionTitle(meta.title);
  if (title) out.title = title;
  const details = meta.details?.trim();
  if (details) out.details = details;
  const quotes = tidyQuotes(meta.quotes);
  if (quotes.length) out.quotes = quotes;
  const basis = meta.basis?.trim();
  if (basis) out.basis = basis;
  const refs = tidyRefs(meta.refs);
  if (refs.length) out.refs = refs;
  const proposal = meta.proposal?.trim();
  if (proposal) { out.confirm = true; out.proposal = proposal; }
  const group = meta.groupKey?.trim();
  if (group) {
    out.groupKey = group;
    const groupTitle = clipText(meta.groupTitle?.trim() ?? '', GROUP_TITLE_LEN);
    if (groupTitle) out.groupTitle = groupTitle;
    const groupOptions = tidyOptions(meta.groupOptions);
    if (groupOptions.length) out.groupOptions = groupOptions;
  }
  return out;
}

/**
 * Приставка ответа-подтверждения: веб шлёт «Согласен: {proposal}» (§3),
 * сервер узнаёт её и применяет `proposal`, как нажатие его кнопки.
 */
export const CONFIRM_ANSWER = 'Согласен';

/** Ответ «Согласен» на вопрос с предложением офиса. */
export const confirmAnswer = (proposal: string): string => `${CONFIRM_ANSWER}: ${proposal.trim()}`;

const flat = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/**
 * Если ответ — подтверждение предложения офиса, вернуть сам `proposal`:
 * его сервер и разбирает, как нажатие кнопки. Кнопка `proposal`, «Согласен», «Согласен: …»
 * (после двоеточия — `proposal`, можно урезанный вебом) и английское
 * «Agree: …». «Согласен: что-то другое» и «Нет, иначе» — свободный ответ, null.
 */
export function confirmedProposal(q: Pick<OwnerQuestion, 'proposal'>, answer: string): string | null {
  const proposal = q.proposal?.trim();
  if (!proposal) return null;
  // Нажатие самой кнопки `proposal` — то же подтверждение.
  if (flat(answer) === flat(proposal)) return proposal;
  const m = /^\s*(?:согласен|согласна|согласны|agreed?)\s*(?:[:—–-]\s*([\s\S]*))?$/i.exec(answer);
  if (!m) return null;
  const rest = flat((m[1] ?? '').replace(/[.…]+$/, ''));
  if (!rest) return proposal;
  const want = flat(proposal);
  return want === rest || (rest.length >= 10 && want.startsWith(rest)) ? proposal : null;
}

/** Слова короче этого — служебные: «и», «на», «что». */
const MIN_WORD = 4;
/** Грубая основа: «макеты», «макет», «макетов» — одно слово. */
const STEM = 5;

/** Задачи, о которых вопрос: своя и упомянутые в тексте («T-32»). */
export function questionTasks(q: Pick<OwnerQuestion, 'taskId' | 'text'>): Set<string> {
  const out = new Set<string>();
  if (q.taskId) out.add(q.taskId);
  for (const m of q.text.matchAll(/\bT-\d+\b/g)) out.add(m[0]);
  return out;
}

function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= MIN_WORD && !/^\d+$/.test(word)) out.add(word.slice(0, STEM));
  }
  return out;
}

/**
 * Насколько два вопроса про одно и то же, 0…1. Меряем долю слов короткого
 * вопроса, которые есть в длинном: переформулировка обычно короче шаблона
 * согласования, и честное пересечение по объединению её бы недооценило.
 * Вопросы про разные задачи не похожи никогда — даже по одному шаблону.
 */
export function questionSimilarity(
  a: Pick<OwnerQuestion, 'taskId' | 'text'>, b: Pick<OwnerQuestion, 'taskId' | 'text'>,
): number {
  const ta = questionTasks(a);
  const tb = questionTasks(b);
  const sharedTask = [...ta].some((t) => tb.has(t));
  if (ta.size && tb.size && !sharedTask) return 0;
  const sa = stems(a.text);
  const sb = stems(b.text);
  const small = Math.min(sa.size, sb.size);
  if (small < 3) return 0;
  let common = 0;
  for (const s of sa) if (sb.has(s)) common += 1;
  const overlap = common / small;
  // Общая задача — сильная улика: хватает и половины общих слов.
  return sharedTask ? Math.min(1, overlap + 0.2) : overlap;
}

/** С какой похожести вопрос считается повтором. */
export const DUPLICATE_AT = 0.7;

/**
 * Открытый вопрос, повтором которого был бы `q`, — самый похожий. Вопрос,
 * поглощённый другим, не в счёт: его место занял тот, другой.
 */
export function findDuplicate(
  q: Pick<OwnerQuestion, 'taskId' | 'text'> & { id?: string },
  list: OwnerQuestion[],
): OwnerQuestion | null {
  let best: OwnerQuestion | null = null;
  let score = DUPLICATE_AT;
  for (const other of list) {
    if (other.id === q.id || !isOpenQuestion(other)) continue;
    const s = questionSimilarity(q, other);
    if (s >= score) { best = other; score = s; }
  }
  return best;
}

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

// ------------------------------------------------- подача вопросов (веб, §2–§5)

/** Предел «Пока считаем» в одну строку карточки: длиннее — полный текст в подробностях. */
export const ASSUMPTION_LINE = 140;

/**
 * Служебные приписки старых вопросов: инструкции к кнопкам («Нажмите…») и
 * пояснения ритуалов. Режутся шаблонами по предложениям; новые вопросы их не
 * содержат (цель — убрать в источнике).
 */
const BOILERPLATE = /^(?:Нажмите|Ответьте|Напишите|Press|Reply|Click)\b|^Обе записи — ваши решения|^Both entries are your decisions|^Вывод разбора:/i;

/** Текст без служебных приписок: режет предложения-шаблоны. Вырезано всё — исходный текст. */
export function stripBoilerplate(text: string): string {
  const out = text.split('\n')
    .map((line) => line.split(/(?<=[.!?…])[ \t]+/).filter((s) => !BOILERPLATE.test(s.trim())).join(' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out || text.trim();
}

/** Простой текст из Markdown: для строки допущения и заголовка. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[`*_~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Первое предложение: до точки, «?» или «!» с пробелом после (десятичные точки и «0.14.0» целы). */
function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?…](?=\s|$)/.exec(text);
  return (m?.[0] ?? text).trim();
}

/**
 * Заголовок старого вопроса без `title` (§7): первое предложение текста без
 * Markdown, приписок, J-/T-номеров и хешей, не длиннее 120 знаков.
 */
export function titleFallback(q: Pick<OwnerQuestion, 'text'>): string {
  const plain = plainText(stripBoilerplate(q.text));
  const sentence = firstSentence(plain);
  return questionTitle(sentence) || questionTitle(plain) || clipText(plain, TITLE_MAX);
}

/** Заголовок карточки: `title`, иначе запасной вариант из текста. */
export const cardTitle = (q: Pick<OwnerQuestion, 'title' | 'text'>): string =>
  q.title?.trim() || titleFallback(q);

/** Вопрос-подтверждение: офис уже решил и ждёт «Согласен» / «Нет, иначе». */
export const isConfirmQuestion = (q: Pick<OwnerQuestion, 'proposal'>): boolean => !!q.proposal?.trim();

/** Для строки «Офис считает: …»: длинное предложение режется до первого предложения. */
export function proposalLine(proposal: string): string {
  const p = plainText(proposal);
  return p.length <= TITLE_MAX ? p : clipText(firstSentence(p), TITLE_MAX);
}

export type QuestionSection = 'decide' | 'confirm';

/** Две группы открытых вопросов; каждая — по возрасту, старые сверху. */
export function splitGroups(open: readonly OwnerQuestion[]): { decide: OwnerQuestion[]; confirm: OwnerQuestion[] } {
  const sorted = [...open].sort((a, b) => a.askedAt - b.askedAt);
  return {
    decide: sorted.filter((q) => !isConfirmQuestion(q)),
    confirm: sorted.filter(isConfirmQuestion),
  };
}

/** Шаг очереди: один вопрос или группа однотипных. */
export interface QuestionCard {
  /** Одиночный — id вопроса; группа — `group:{секция}:{groupKey}`. */
  id: string;
  section: QuestionSection;
  questions: OwnerQuestion[];
  grouped: boolean;
  groupKey?: string;
}

/**
 * Карточки одной группы: вопросы с одним `groupKey` (≥ 2) сводятся в одну
 * карточку, которая стоит там, где первый из них. Порядок — по `askedAt`.
 */
export function buildCards(list: readonly OwnerQuestion[], section: QuestionSection): QuestionCard[] {
  const sorted = [...list].sort((a, b) => a.askedAt - b.askedAt);
  const byKey = new Map<string, OwnerQuestion[]>();
  for (const q of sorted) {
    const key = q.groupKey?.trim();
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), q]);
  }
  const cards: QuestionCard[] = [];
  const placed = new Set<string>();
  for (const q of sorted) {
    const key = q.groupKey?.trim();
    const members = key ? byKey.get(key) : undefined;
    if (key && members && members.length >= 2) {
      if (placed.has(key)) continue;
      placed.add(key);
      cards.push({ id: `group:${section}:${key}`, section, questions: members, grouped: true, groupKey: key });
    } else {
      cards.push({ id: q.id, section, questions: [q], grouped: false });
    }
  }
  return cards;
}

const flatOpt = (s: string): string => s.trim().toLowerCase();

/**
 * Общие варианты группы: `groupOptions` у первого вопроса, иначе набор
 * `options`, если он совпал у всех (по тексту, без регистра). Нет — пусто.
 */
export function commonOptions(group: readonly OwnerQuestion[]): string[] {
  const declared = group.find((q) => q.groupOptions?.length)?.groupOptions;
  if (declared?.length) return declared;
  const first = group[0]?.options ?? [];
  if (!first.length) return [];
  const key = (o: readonly string[]): string => o.map(flatOpt).join('\u0000');
  const want = key(first);
  return group.every((q) => key(q.options ?? []) === want) ? first : [];
}

/** Допущение группы: если у всех открытых совпадает — оно, иначе пусто. */
export function commonAssumption(group: readonly OwnerQuestion[]): string {
  const first = group[0]?.assumption?.trim() ?? '';
  return first && group.every((q) => (q.assumption?.trim() ?? '') === first) ? first : '';
}

/** Тема группы для заголовка: у первого вопроса, где она есть. */
export const groupTopic = (group: readonly OwnerQuestion[]): string =>
  group.find((q) => q.groupTitle?.trim())?.groupTitle?.trim() ?? '';

/**
 * Очередь: сначала «Нужно ваше решение», потом «На подтверждение». Пропущенные
 * (`skipped` — id карточек) уходят в конец своей группы, вопрос остаётся открытым.
 */
export function buildQueue(open: readonly OwnerQuestion[], skipped: readonly string[] = []): QuestionCard[] {
  const { decide, confirm } = splitGroups(open);
  const order = (cards: QuestionCard[]): QuestionCard[] => {
    const skip = new Set(skipped);
    return [...cards.filter((c) => !skip.has(c.id)), ...skipped
      .map((id) => cards.find((c) => c.id === id))
      .filter((c): c is QuestionCard => !!c)];
  };
  return [...order(buildCards(decide, 'decide')), ...order(buildCards(confirm, 'confirm'))];
}

/** Сегмент полосы прогресса очереди. */
export type QueueSegment = 'done' | 'now' | 'decide' | 'confirm';

/** Полоса прогресса: сделанные, текущий, остальные — решения и подтверждения. */
export function queueSegments(done: number, queue: readonly QuestionCard[]): QueueSegment[] {
  return [
    ...Array<QueueSegment>(done).fill('done'),
    ...queue.map((c, i): QueueSegment => (i === 0 ? 'now' : c.section)),
  ];
}

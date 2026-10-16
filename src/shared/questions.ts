/**
 * Вопросы владельцу: что общее у сервера и веба. Признак «открыт» и сходство
 * двух вопросов считаются одинаково по обе стороны сокета — иначе значок,
 * планёрка и подсказка «похоже на Q-N» разошлись бы между собой.
 */
import type { OwnerQuestion } from './types';

/** Открыт: без ответа, не снят и не объединён с другим вопросом. */
export const isOpenQuestion = (q: OwnerQuestion): boolean =>
  !q.answeredAt && !q.dismissedAt && !q.mergedInto;

/** Необязательные поля разметки вопроса: суть, детали, подтверждение, группа. */
export type QuestionMeta = Pick<OwnerQuestion, 'title' | 'details' | 'confirm' | 'proposal' | 'groupKey'>;

/** Предел короткой сути вопроса. */
export const TITLE_MAX = 120;

/**
 * Короткая суть из сырой строки: одна строка, без номеров записей журнала
 * (J-12) и хешей коммитов, не длиннее `max`. Пустая строка — сути нет.
 */
export function questionTitle(raw: string | undefined, max = TITLE_MAX): string {
  const line = (raw ?? '')
    .replace(/\(\s*\bJ-\d+\b\s*\)/g, '')
    .replace(/\bJ-\d+\b:?/g, '')
    // Хеш коммита: 7–40 шестнадцатеричных знаков, среди которых есть цифра.
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, '')
    .replace(/\(\s*[,;]?\s*\)/g, '')
    .replace(/\s+([,.;:!?»)])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/g, '')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Что показать заголовком: короткая суть, а у старых вопросов — весь текст. */
export const questionHeadline = (q: Pick<OwnerQuestion, 'title' | 'text'>): string =>
  q.title?.trim() || q.text;

/**
 * Привести разметку к виду для хранения: пустое выбрасываем, суть чистим и
 * режем, `proposal` без `confirm` и `confirm` без `proposal` не храним —
 * подтверждать нечего.
 */
export function tidyQuestionMeta(meta: QuestionMeta | undefined): QuestionMeta {
  if (!meta) return {};
  const out: QuestionMeta = {};
  const title = questionTitle(meta.title);
  if (title) out.title = title;
  const details = meta.details?.trim();
  if (details) out.details = details;
  const proposal = meta.proposal?.trim();
  if (meta.confirm && proposal) { out.confirm = true; out.proposal = proposal; }
  const group = meta.groupKey?.trim();
  if (group) out.groupKey = group;
  return out;
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

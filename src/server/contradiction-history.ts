/**
 * История противоречий журнала: по каким записям владельца уже спрашивали и
 * что он ответил. Чистые функции без состояния офиса — их зовёт ритуал
 * противоречий (rituals.ts → handleContradiction) и тест
 * scripts/test-contradictions-history.ts.
 *
 * Зачем отдельно от памяти пар (contradictions.ts → resolvedPairs): память пар
 * появилась позже вопросов, и старые ответы владельца в неё не попали. А модель
 * при каждом прогоне цитирует тему заново — то с теми же id, то с соседней
 * записью той же темы, то без id вовсе. Поэтому разобранное ищем по самим
 * вопросам и записям вида contradiction, а не только по ключу пары.
 */
import type { FactView, OwnerQuestion } from '../shared/types';

type QuestionLike = Pick<OwnerQuestion, 'id' | 'kind' | 'text' | 'askedAt' | 'answer' | 'answeredAt' | 'dismissedAt' | 'mergedInto'>;
type FactLike = Pick<FactView, 'id' | 'kind' | 'text' | 'source'>;

/** Чем найденное противоречие уже покрыто: вопрос владельцу или запись журнала. */
export interface PriorContradiction {
  questionId?: string;
  factId?: string;
}

/** Сравниваем тексты без кавычек, регистра и лишних пробелов. */
export function normText(s: string): string {
  return s.toLowerCase().replace(/[«»“”"'`…]/g, '').replace(/\s+/g, ' ').trim();
}

/** Сколько начала записи должно совпасть, чтобы считать её процитированной. */
const QUOTE_PREFIX = 60;
/** Короче этого текст записи слишком общий, чтобы искать его вхождением. */
const QUOTE_MIN = 20;

/**
 * Упомянута ли запись в тексте: по id целым словом или цитатой начала текста.
 * Вопрос режет цитату на 160 символах, поэтому сверяем только начало записи.
 */
export function mentionsFact(text: string, fact: Pick<FactView, 'id' | 'text'>): boolean {
  if (new RegExp(`(^|[^A-Za-z0-9-])${fact.id}(?![0-9])`).test(text)) return true;
  const head = normText(fact.text).slice(0, QUOTE_PREFIX);
  return head.length >= QUOTE_MIN && normText(text).includes(head);
}

/** Цитаты из абзаца вопроса: куски между кавычками, без шаблона по краям. */
function quotedChunks(head: string): string[] {
  const parts = head.split(/[«»“”]/);
  return parts.slice(1, -1)
    .map((p) => p.replace(/^\s*[A-Z]+-\d+\s*(\[[^\]]*\])?:?\s*/, '').trim())
    .filter((p) => p.length >= QUOTE_MIN);
}

/**
 * Была ли запись стороной вопроса. Кроме id и начала текста ищем обратное:
 * цитата вопроса взята из середины записи или пересказана близко к тексту.
 */
export function questionMentions(head: string, fact: Pick<FactView, 'id' | 'text'>): boolean {
  if (mentionsFact(head, fact)) return true;
  const body = normText(fact.text);
  return quotedChunks(head).some((chunk) => body.includes(normText(chunk).slice(0, QUOTE_PREFIX))
    || (words(chunk).size >= QUOTE_WORDS_MIN && sameTopic(chunk, fact.text)));
}

/** Сколько значимых слов нужно цитате, чтобы сверять её с записью по теме. */
const QUOTE_WORDS_MIN = 5;

/** Вопрос о противоречии, который считается заданным: не влит в другой. */
function contradictionQuestions(questions: QuestionLike[]): QuestionLike[] {
  return questions
    .filter((q) => q.kind === 'contradiction' && !q.mergedInto)
    .sort((x, y) => x.askedAt - y.askedAt);
}

/**
 * Записи, по которым владельца уже спрашивали о противоречии, → первый такой
 * вопрос. Сюда же попадают записи «В: … — О: …» с ответом на такой вопрос:
 * это след разбора, а не новое утверждение.
 */
export function ruledFacts(questions: QuestionLike[], facts: FactLike[]): Map<string, string> {
  const ruled = new Map<string, string>();
  const asked = contradictionQuestions(questions);
  const askedIds = new Set(asked.map((q) => q.id));
  for (const q of asked) {
    // Абзац с цитатами; вывод разбора ниже упоминает id, но спрашивали не о нём.
    const head = q.text.split('\n\n')[0];
    for (const f of facts) {
      if (!ruled.has(f.id) && questionMentions(head, f)) ruled.set(f.id, q.id);
    }
  }
  for (const f of facts) {
    const qid = f.source?.questionId;
    if (qid && askedIds.has(qid) && !ruled.has(f.id)) ruled.set(f.id, qid);
  }
  return ruled;
}

/** Значимые слова: от четырёх букв, без знаков по краям. */
function words(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of normText(s).split(/[\s,;:()\[\]{}!?]+/)) {
    const t = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (t.length >= 4) out.add(t);
  }
  return out;
}

/** Минимум значимых слов, чтобы сравнивать формулировки темы. */
const SIMILAR_MIN_WORDS = 3;
/** Доля общих слов от меньшего набора, с которой темы считаем одной. */
const SIMILAR_SHARE = 0.6;

/** Одна ли тема у двух коротких формулировок противоречия. */
export function sameTopic(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size < SIMILAR_MIN_WORDS || y.size < SIMILAR_MIN_WORDS) return false;
  let common = 0;
  for (const w of x) if (y.has(w)) common += 1;
  return common / Math.min(x.size, y.size) >= SIMILAR_SHARE;
}

/**
 * Разбиралось ли это противоречие раньше. Порядок проверок:
 * 1) одна из найденных сторон уже была стороной вопроса о противоречии —
 *    владелец эту тему видел, ответ лежит в журнале;
 * 2) обе цитаты (без найденной записи) есть в тексте прежнего вопроса;
 * 3) формулировка совпадает по теме с записью вида contradiction.
 * Ничего не нашли — null, противоречие новое.
 */
export function findPriorContradiction(
  c: { a: string; b: string; text: string },
  sides: Array<FactLike | null>,
  questions: QuestionLike[],
  facts: FactLike[],
): PriorContradiction | null {
  const ruled = ruledFacts(questions, facts);
  for (const side of sides) {
    const qid = side && ruled.get(side.id);
    if (qid) return { questionId: qid };
  }

  const core = (quote: string): string =>
    normText(quote.replace(/^-?\s*[A-Z]+-\d+\s*(\[[^\]]*\])?:?/, '')).slice(0, QUOTE_PREFIX);
  const qa = core(c.a);
  const qb = core(c.b);
  if (qa.length >= QUOTE_MIN && qb.length >= QUOTE_MIN) {
    for (const q of contradictionQuestions(questions)) {
      const t = normText(q.text);
      if (t.includes(qa) && t.includes(qb)) return { questionId: q.id };
    }
  }

  if (c.text.trim()) {
    const hit = facts.find((f) => f.kind === 'contradiction' && sameTopic(f.text, c.text));
    if (hit) return { factId: hit.id };
  }
  return null;
}

/**
 * Открытые вопросы-повторы: вопрос о противоречии без ответа, у которого есть
 * более ранний вопрос о той же записи журнала. Возвращает пары «повтор →
 * прежний вопрос»; закрывает их вызывающий (questions.ts → dismissQuestion).
 */
export function repeatedQuestions(
  questions: QuestionLike[],
  facts: FactLike[],
): Array<{ repeat: QuestionLike; prior: QuestionLike }> {
  const asked = contradictionQuestions(questions);
  const mentioned = new Map<string, Set<string>>();
  for (const q of asked) {
    const head = q.text.split('\n\n')[0];
    mentioned.set(q.id, new Set(facts.filter((f) => questionMentions(head, f)).map((f) => f.id)));
  }
  const out: Array<{ repeat: QuestionLike; prior: QuestionLike }> = [];
  for (let i = 0; i < asked.length; i += 1) {
    const q = asked[i];
    if (q.answeredAt || q.dismissedAt) continue;
    const ids = mentioned.get(q.id)!;
    const earlier = asked.slice(0, i);
    // Предпочитаем отвеченный: ссылка на ответ полезнее ссылки на другой открытый.
    const prior = earlier.find((p) => p.answeredAt && [...ids].some((id) => mentioned.get(p.id)!.has(id)))
      ?? earlier.find((p) => !p.dismissedAt && [...ids].some((id) => mentioned.get(p.id)!.has(id)));
    if (prior) out.push({ repeat: q, prior });
  }
  return out;
}

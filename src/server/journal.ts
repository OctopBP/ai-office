/**
 * Журнал офиса (docs/design/living-office/spec.md §4): что офис узнал о
 * проекте, что решил и на чём обжёгся.
 *
 * Не база знаний о мире, а память команды — производная от доски. Пишут её
 * ритуалы (консолидация, противоречия), ответы владельца и менеджер
 * инструментом `note_fact`; читают её все сессии: живые записи едут в
 * системный промпт рядом с OFFICE.md, отфильтрованные по области.
 *
 * Объём ограничен намеренно: чем больше система помнит, тем хуже отвечает.
 * Поэтому здесь же живёт забывание (§5.4): факт, который давно не
 * подтверждался, протухает молча, а решение и урок — только через вопрос
 * владельцу, потому что забыть решение молча — значит его отменить.
 */
import type { FactPage } from '../shared/types';
import { toFactView, type Fact, type OfficeState, type Task } from './state';

/** Сколько записей одной области едет в промпт. */
export const PROMPT_FACTS = 25;

/** Размер страницы журнала, если его не попросили: столько же, сколько в ленте. */
export const PAGE_FACTS = 50;

/**
 * Больше этого за один раз не отдаём, сколько бы ни попросили: ответ собирается
 * в памяти процесса, который в это же время ведёт сессии агентов.
 */
export const PAGE_FACTS_MAX = 200;

/** Через сколько недель без подтверждения запись протухает, а протухшая — уходит в архив. */
export const STALE_AFTER_MS = 3 * 7 * 24 * 60 * 60 * 1000;

/**
 * Записи, которые видит роль: общие для проекта и её собственные. Менеджер
 * вместо своих получает офисные — про команду и процесс.
 */
export function factsFor(state: OfficeState, roleId: string | null): Fact[] {
  const own = roleId ? `role:${roleId}` : 'office';
  return state.factList()
    .filter((f) => f.status === 'live' && f.kind !== 'contradiction')
    .filter((f) => f.scope === 'project' || f.scope === own)
    .sort((a, b) => b.confirmedAt - a.confirmedAt)
    .slice(0, PROMPT_FACTS);
}

/**
 * Журнал для системного промпта. Пусто — офис ещё ничего не запомнил, и
 * пустой заголовок только сбивал бы модель с толку.
 */
export function journalBrief(state: OfficeState, roleId: string | null): string {
  const facts = factsFor(state, roleId);
  if (!facts.length) return '';
  const lines = facts.map((f) => `- [${state.say(`journal.kind.${f.kind}`)}] ${f.text}`);
  return `\n\n${state.say('journal.header')}\n${lines.join('\n')}`;
}

// ------------------------------------------------------- постраничная выдача

/**
 * Номер записи из её id (`J-12` → 12). На номерах держится курсор: они идут в
 * том же порядке, что и заведение записей, и остаются сравнимыми, даже если
 * саму запись курсора к следующему запросу уже стёрли (`removeFact`).
 * Не наш id — null, и вызывающий считает такой курсор отсутствующим.
 */
function factSeq(id: string): number | null {
  const found = /^J-(\d+)$/.exec(id.trim());
  if (!found) return null;
  const seq = Number(found[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}

/**
 * Что из запроса реально применяем. Параметры приходят из сети строками (а то
 * и мусором), и падать на них нельзя: страница журнала — чтение, худшее, что
 * может сделать неверный параметр, — это вернуть первую страницу.
 *
 * `limit`: не число, ноль или меньше — размер по умолчанию; больше предела —
 * предел; дробное — вниз до целого.
 * `cursor`: не наш id — как будто его не присылали, то есть с начала журнала.
 */
export function normalizeFactPage(query: { limit?: unknown; cursor?: unknown }): {
  limit: number; after: number;
} {
  const asked = typeof query.limit === 'number' ? query.limit : Number(String(query.limit ?? '').trim());
  const limit = Number.isFinite(asked) && Math.floor(asked) >= 1
    ? Math.min(Math.floor(asked), PAGE_FACTS_MAX)
    : PAGE_FACTS;
  const cursor = typeof query.cursor === 'string' ? factSeq(query.cursor) : null;
  return { limit, after: cursor ?? 0 };
}

/**
 * Страница журнала. Порядок — тот же, что у `factList` и у снапшота (по
 * заведению), поэтому запрос без параметров — это ровно начало прежнего
 * списка: потребитель, читающий только `items`, ничего не теряет.
 *
 * Фильтров по статусу и области здесь нет намеренно: снапшот отдаёт журнал
 * целиком, и постраничная выдача должна показывать то же самое, иначе два
 * способа прочитать журнал разошлись бы в том, что в нём есть.
 */
export function pageFacts(state: OfficeState, query: { limit?: unknown; cursor?: unknown } = {}): FactPage {
  const { limit, after } = normalizeFactPage(query);
  const all = state.factList();
  // Записи без номера в id завестись не могут, но если такая попадётся, пусть
  // выйдет на первой странице, а не потеряется между страницами.
  const rest = after > 0 ? all.filter((f) => (factSeq(f.id) ?? 0) > after) : all;
  const items = rest.slice(0, limit);
  const hasMore = rest.length > items.length;
  return {
    items: items.map(toFactView),
    total: all.length,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
    hasMore,
    limit,
  };
}

/**
 * Задача закрылась чисто: записи, которые она видела, не помешали — значит,
 * подтвердились. Записи новее старта задачи не считаются: их в промпте не было.
 */
export function confirmFactsFor(state: OfficeState, task: Task, now = Date.now()): number {
  const startedAt = task.startedAt ?? task.createdAt;
  let n = 0;
  for (const fact of factsFor(state, task.roleId)) {
    if (fact.createdAt > startedAt) continue;
    state.updateFact(fact.id, { confirmedAt: now });
    n += 1;
  }
  return n;
}

/** Ответ владельца подтверждает запись, а сомнение — снимает. */
export function confirmFact(state: OfficeState, id: string, now = Date.now()): boolean {
  const fact = state.facts.get(id);
  if (!fact) return false;
  state.updateFact(id, { confirmedAt: now, status: 'live', askedAt: null });
  return true;
}

export function archiveFact(state: OfficeState, id: string): boolean {
  const fact = state.facts.get(id);
  if (!fact) return false;
  state.updateFact(id, { status: 'archived' });
  return true;
}

export interface ForgetResult {
  /** Факты, ушедшие из промптов. */
  staled: Fact[];
  /** Протухшие ещё раньше — теперь в архиве. */
  archived: Fact[];
  /** Решения и уроки, о которых надо спросить владельца. */
  toAsk: Fact[];
}

/**
 * Забывание. Механика без модели: смотрит только на даты.
 *
 * Факт без подтверждения K недель — `stale`, ещё через K — `archived`.
 * Решение и урок сами не протухают: они превращаются в вопрос владельцу
 * «это ещё в силе?», и только ответ их архивирует или продлевает. Спрашиваем
 * один раз (`askedAt`): без ответа запись так и висит живой — молчание не
 * отменяет решение.
 */
export function forget(state: OfficeState, now = Date.now()): ForgetResult {
  const result: ForgetResult = { staled: [], archived: [], toAsk: [] };
  for (const fact of state.factList()) {
    if (fact.status === 'archived') continue;
    const idle = now - fact.confirmedAt;
    if (idle < STALE_AFTER_MS) continue;
    if (fact.kind === 'decision' || fact.kind === 'lesson') {
      if (fact.askedAt === null) {
        state.updateFact(fact.id, { askedAt: now });
        result.toAsk.push(fact);
      }
      continue;
    }
    if (fact.status === 'live') {
      state.updateFact(fact.id, { status: 'stale' });
      result.staled.push(fact);
    } else if (idle >= 2 * STALE_AFTER_MS) {
      state.updateFact(fact.id, { status: 'archived' });
      result.archived.push(fact);
    }
  }
  return result;
}

/**
 * Всё, что сервер говорит словами: лента событий офиса, отказы форм, подписи
 * в чате, вывод в терминал — и отдельно то, что он говорит моделям: брифы
 * ролей, системные промпты и описания инструментов.
 *
 * Словари серверные, а не общие: интерфейсу они не нужны, а тащить в бандл
 * браузера страницы промптов про worktree и конвейер ревью незачем.
 *
 * Файлов на язык три, а словарь один: разделены они по размеру и по тому, кто
 * читает текст, — фразы человеку, брифы ролей и промпты агентов правятся в
 * разное время и разными руками. Ключи при этом лежат в одном пространстве,
 * и `t()` у всего офиса одна.
 */
import { makeTranslator, DEFAULT_LANG, asLang, type Lang, type Vars } from '../../shared/i18n';
import { en as messagesEn } from './en';
import { ru as messagesRu } from './ru';
import { rolesEn } from './roles-en';
import { rolesRu } from './roles-ru';
import { promptsEn } from './prompts-en';
import { promptsRu } from './prompts-ru';

const en = { ...messagesEn, ...rolesEn, ...promptsEn };
const ru = { ...messagesRu, ...rolesRu, ...promptsRu };

export type ServerKey = keyof typeof en;

const translate = makeTranslator({ en, ru });

/** Фраза на языке офиса. Язык обязателен: у каждого офиса он свой. */
export function t(lang: Lang, key: ServerKey, vars?: Vars): string {
  return translate(lang, key, vars);
}

/** Есть ли такой ключ в словаре. Нужен там, где ключ собирается из данных. */
export const hasKey = (key: string): key is ServerKey => key in en;

/**
 * Язык вывода в терминал. Терминал у процесса один, а офисов в нём несколько,
 * и своего языка у консольной строки нет: берём язык последнего открытого
 * офиса. Пока не открыт ни один — тот, с которым запустили процесс
 * (`OFFICE_LANG`), а если и его не задали — базовый.
 */
let processLang: Lang | null = null;

export const setProcessLang = (lang: unknown): void => { processLang = asLang(lang); };

const consoleLang = (): Lang => processLang ?? asLang(process.env.OFFICE_LANG ?? DEFAULT_LANG);

/** Фраза для терминала — на языке процесса. */
export const c = (key: ServerKey, vars?: Vars): string => translate(consoleLang(), key, vars);

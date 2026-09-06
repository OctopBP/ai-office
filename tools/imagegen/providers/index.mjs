/**
 * Реестр провайдеров генерации картинок.
 *
 * Провайдер — это чужое API, и меняется оно не по нашему расписанию: у одного
 * задача заводится и опрашивается, у другого картинка приходит в том же
 * ответе; один принимает исходники ссылками, другой файлами. Поэтому контракт
 * взят по наибольшему знаменателю — «завести задачу» и «спросить, как она», —
 * а синхронный провайдер отдаёт готовое сразу полем `done`.
 *
 * Что провайдер обязан о себе рассказать, кроме умения генерировать:
 * какие соотношения сторон он знает, сколько картинок отдаёт за запрос и как
 * принимает исходники. Без этого вызывающий гадает, а роль тратит ходы на
 * запросы, которые API отвергнет.
 *
 * @typedef {Object} ImageRequest
 * @property {string} prompt        описание картинки
 * @property {string} [aspect]      соотношение сторон, например '16:9'
 * @property {number} [count]       сколько вариантов
 * @property {string[]} [refUrls]   исходники ссылками (режим правки)
 * @property {string[]} [refPaths]  исходники файлами (режим правки)
 *
 * @typedef {{ url?: string, data?: Buffer, mime?: string }} Image
 * @typedef {{ state: 'working'|'done'|'failed', images?: Image[], error?: string }} Progress
 * @typedef {{ taskId: string, done?: Progress }} Started
 *
 * @typedef {Object} Provider
 * @property {string} id
 * @property {string} title
 * @property {string} keyEnv                   имя переменной окружения с ключом
 * @property {string[]} aspects                поддерживаемые соотношения сторон
 * @property {number} maxCount                 картинок за один запрос
 * @property {'url'|'file'|'none'} refs        как принимаются исходники для правки
 * @property {(req: ImageRequest) => Promise<Started>} start
 * @property {(taskId: string) => Promise<Progress>} poll
 * @property {() => Promise<string>} [credits] остаток на счёте, если API умеет
 */
import { nanobanana } from './nanobanana.mjs';
import { gemini } from './gemini.mjs';

/** Все провайдеры. Первый — по умолчанию. */
export const PROVIDERS = [nanobanana, gemini];

/**
 * Провайдер по имени. Пусто — берётся `IMAGEGEN_PROVIDER` из окружения, а
 * если и его нет, первый из списка. Имя выбирает вызывающий (у инструмента
 * есть поле `provider`), потому что ключи бывают не ко всем сразу.
 */
export function providerBy(id) {
  const wanted = (id || process.env.IMAGEGEN_PROVIDER || '').trim();
  if (!wanted) return PROVIDERS[0];
  const found = PROVIDERS.find((p) => p.id === wanted);
  if (!found) {
    throw new Error(`Провайдер «${wanted}» неизвестен. Есть: ${PROVIDERS.map((p) => p.id).join(', ')}.`);
  }
  return found;
}

/** Есть ли ключ у провайдера. Настройка снаружи, поэтому спрашиваем окружение. */
export const hasKey = (p) => Boolean((process.env[p.keyEnv] || '').trim());

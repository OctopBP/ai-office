/**
 * Язык интерфейса и всего, что офис говорит человеку.
 *
 * Общий контракт: тип языка едет по проводу в настройках офиса, а движок
 * словарей одинаков и на сервере, и в вебе. Сами словари лежат по разные
 * стороны (`src/web/i18n`, `src/server/i18n`, `src/server/prompts`): фразы
 * интерфейса браузеру нужны, а страницы системных промптов — нет, и тащить
 * их в бандл незачем.
 */

/** Языки, на которых офис умеет говорить. Первый — базовый. */
export const LANGS = ['en', 'ru'] as const;

export type Lang = (typeof LANGS)[number];

/**
 * Язык по умолчанию и он же запасной: ключа нет в словаре — берём отсюда.
 * Базовым выбран английский, поэтому недостающий перевод превращается в
 * английскую фразу, а не в голый ключ.
 */
export const DEFAULT_LANG: Lang = 'en';

/** Название языка на нём самом — так его подписывают в переключателе. */
export const LANG_TITLE: Record<Lang, string> = {
  en: 'English',
  ru: 'Русский',
};

/**
 * Как называется язык для модели. Уезжает в системный промпт агента, поэтому
 * пишется по-английски: инструкцию «отвечай на Русский» модель читает хуже,
 * чем «reply in Russian».
 */
export const LANG_NAME_EN: Record<Lang, string> = {
  en: 'English',
  ru: 'Russian',
};

/** Тег локали для дат, времени и чисел. */
export const LANG_LOCALE: Record<Lang, string> = {
  en: 'en-US',
  ru: 'ru-RU',
};

/**
 * Язык пришёл по сети или из правленого руками файла состояния: чужое
 * значение осело бы в настройках офиса навсегда.
 */
export const isLang = (value: unknown): value is Lang =>
  typeof value === 'string' && (LANGS as readonly string[]).includes(value);

/** Язык из чего угодно: непригодное значение превращается в базовый. */
export const asLang = (value: unknown): Lang => (isLang(value) ? value : DEFAULT_LANG);

/** Подстановки в фразу: `{name}` в тексте заменяется значением. */
export type Vars = Record<string, string | number>;

/**
 * Номер формы множественного числа. У английского их две, у русского три,
 * и правило у каждого своё — форматтер выбирает форму по языку, а не по
 * тому, на чьём языке писали словарь.
 */
export function pluralIndex(lang: Lang, n: number): number {
  const abs = Math.abs(Math.floor(n));
  if (lang === 'ru') {
    const mod10 = abs % 10;
    const mod100 = abs % 100;
    if (mod10 === 1 && mod100 !== 11) return 0;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 1;
    return 2;
  }
  return abs === 1 ? 0 : 1;
}

/**
 * Подставить значения в фразу. Формы множественного числа пишутся в словаре
 * через `|` («{n} task|{n} tasks»), и нужная выбирается по `vars.n`: держать
 * их в одной строке проще, чем плодить ключи `.one`, `.few`, `.many`.
 */
export function format(lang: Lang, template: string, vars?: Vars): string {
  let text = template;
  if (text.includes('|')) {
    const forms = text.split('|');
    const n = Number(vars?.n);
    // Форм может быть меньше, чем требует правило языка: тогда берём последнюю.
    const idx = Number.isFinite(n) ? Math.min(pluralIndex(lang, n), forms.length - 1) : 0;
    text = forms[idx] ?? forms[0] ?? '';
  }
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    (name in vars ? String(vars[name]) : whole));
}

/**
 * Переводчик по паре словарей. Словарь базового языка задаёт набор ключей, и
 * второй обязан его повторить — иначе несобранная фраза всплыла бы у
 * пользователя, а не на типизации.
 */
export function makeTranslator<D extends Record<string, string>>(dicts: Record<Lang, D>) {
  return (lang: Lang, key: keyof D & string, vars?: Vars): string => {
    const dict = dicts[lang] ?? dicts[DEFAULT_LANG];
    // Ключ мог появиться в базовом словаре раньше, чем в переводе.
    const template = dict[key] ?? dicts[DEFAULT_LANG][key];
    // Ключа нет нигде — показываем сам ключ: молчаливая пустота в интерфейсе
    // выглядит как поломка вёрстки, а видимый ключ читается как недоделка.
    if (template === undefined) return key;
    return format(lang, template, vars);
  };
}

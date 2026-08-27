/**
 * Язык интерфейса.
 *
 * Настоящий язык офиса живёт на сервере (`Settings.language`) и приезжает в
 * снимке состояния. Здесь он дублируется в localStorage — не как второй
 * источник правды, а как ответ на вопрос «на каком языке рисовать меню
 * офисов», который задаётся раньше, чем открыт хоть один офис.
 *
 * Функция `t()` берёт язык из модуля, а не из React-контекста: подписи нужны
 * не только компонентам, но и стору, спрайтам и сцене, а прокидывать туда
 * хук неоткуда. Чтобы смена языка не оставила на экране половину старых
 * подписей, приложение перемонтируется целиком (`main.tsx`).
 */
import { asLang, LANG_LOCALE, makeTranslator, type Lang, type Vars } from '../../shared/i18n';
import { en } from './en';
import { ru } from './ru';

export type UiKey = keyof typeof en;

const translate = makeTranslator({ en, ru });

const STORAGE_KEY = 'office-lang';

let current: Lang = asLang(localStorage.getItem(STORAGE_KEY));

/** Язык, на котором интерфейс говорит прямо сейчас. */
export const lang = (): Lang => current;

/** Локаль для дат, времени и чисел — из того же языка. */
export const locale = (): string => LANG_LOCALE[current];

/**
 * Запомнить язык офиса. Возвращает true, если он изменился, — по этому
 * признаку стор решает, надо ли перерисовывать приложение целиком.
 */
export function setLang(next: unknown): boolean {
  const value = asLang(next);
  if (value === current) return false;
  current = value;
  localStorage.setItem(STORAGE_KEY, value);
  document.documentElement.lang = value;
  return true;
}

/**
 * Есть ли такая фраза в словаре. Нужна там, где ключ собирается из данных:
 * у пресетов, которые едут в комплекте, подпись переводится вместе с
 * интерфейсом, а у заведённых руками — берётся из них самих.
 */
export const has = (key: string): key is UiKey => key in en;

/** Фраза интерфейса. Подстановки — `{name}`, формы числа — через `|`. */
export const t = (key: UiKey, vars?: Vars): string => translate(current, key, vars);

document.documentElement.lang = current;

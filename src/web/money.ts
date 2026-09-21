/**
 * Как офис пишет про деньги, токены и лимиты. Отдельным модулем, а не внутри
 * доски расходов: те же суммы и та же строка про токены стоят в карточке
 * сотрудника и в его дровере, и разъехавшиеся форматы читались бы как разные
 * числа про одно и то же.
 */
import type { LimitWindow, Usage } from '../shared/types';
import { limitReset } from '../shared/types';
import { locale, t } from './i18n';

/** Сумма: мелочь до цента не округляем — на ней и видно цену одной задачи. */
export const money = (v: number): string => `$${v.toFixed(v < 1 ? 3 : 2)}`;

export const usageMoney = (usage: Usage): string => usage.costUnavailable ? t('usage.costUnavailable') : money(usage.costUsd);

/** Токены: точное число здесь никому не нужно, а порядок — нужен. */
export const tok = (v: number): string => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M`
  : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v));

/**
 * Доля ввода, которую модель прочитала из кеша. Считаем от всего ввода,
 * а не от суммы всех токенов: вывод к кешу отношения не имеет.
 */
export function cacheShare(u: Usage): number | null {
  const input = u.tokensIn + u.cacheRead;
  return input > 0 ? Math.round((u.cacheRead / input) * 100) : null;
}

/** Строка «38k in / 6k out · кеш 91%» — одна формулировка на весь интерфейс. */
export function usageLine(u: Usage): string {
  const share = cacheShare(u);
  return `${tok(u.tokensIn)} in / ${tok(u.tokensOut)} out` +
    (share === null ? '' : t('usage.cacheShare', { share }));
}

/** Время в часах и минутах местной локали — «19:40». */
export const clock = (at: number): string =>
  new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

/**
 * Сколько осталось ждать. Секунды не показываем нигде: до сброса лимита часы,
 * и бегущие секунды в такой шкале — шум, а не точность.
 */
export function until(at: number, now = Date.now()): string {
  const left = Math.max(0, at - now);
  const minutes = Math.ceil(left / 60000);
  if (minutes < 60) return t('limits.left.m', { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('limits.left.hm', { h: hours, m: minutes % 60 });
  return t('limits.left.dh', { d: Math.floor(hours / 24), h: hours % 24 });
}

/**
 * Подпись под шкалой окна: когда оно обнулится. Уже обнулившееся окно так и
 * говорит: цифры на нём от прошлого окна, и выдавать их за текущие нельзя.
 */
export function resetLine(w: LimitWindow, now = Date.now()): string {
  if (w.resetsAt === null) return t('limits.resetUnknown');
  if (limitReset(w, now)) return t('limits.resetPassed');
  return t('limits.resetsIn', { time: until(w.resetsAt, now), at: clock(w.resetsAt) });
}

/**
 * Цвет шкалы. Пороги те же, на которых человек меняет поведение: до 75%
 * можно не думать, после 90% пора решать, на что тратить остаток.
 */
export const limitTone = (utilization: number): 'ok' | 'warn' | 'hot' =>
  (utilization >= 90 ? 'hot' : utilization >= 75 ? 'warn' : 'ok');

/** «обновлено 3 мин назад» — шкала лимита стоит ровно столько, сколько её не трогали. */
export function freshness(at: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return t('limits.fresh.now');
  if (minutes < 60) return t('limits.fresh.m', { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('limits.fresh.h', { h: hours });
  return t('limits.fresh.d', { d: Math.floor(hours / 24) });
}

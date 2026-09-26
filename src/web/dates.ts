import { t, locale } from './i18n';

/**
 * Время и дни в лентах — чате и логе событий. Одна точка, чтобы «Сегодня»,
 * формат часов и полная дата в подсказке не расходились между лентами.
 * Язык и формат берутся из языка интерфейса.
 */

// Старые записи (до появления `at` в конкретном снимке состояния или из
// ручной правки state.json) могут прийти без времени — тогда просто не
// рисуем метку и не считаем их точкой разрыва дня.
export const hasTime = (at: unknown): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0;

const startOfDay = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Ключ календарного дня — по нему решаем, вставлять ли разделитель дат. */
export const dayKey = (at: number) => String(startOfDay(at));

/** «Сегодня» / «Вчера» / «12 мая» / «12 мая 2025». */
export const formatDayLabel = (at: number): string => {
  const daysAgo = Math.round((startOfDay(Date.now()) - startOfDay(at)) / 86400000);
  if (daysAgo <= 0) return t('chat.date.today');
  if (daysAgo === 1) return t('chat.date.yesterday');
  const sameYear = new Date(at).getFullYear() === new Date().getFullYear();
  return new Date(at).toLocaleDateString(locale(), sameYear
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' });
};

export const formatClock = (at: number): string =>
  new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

export const formatFullDateTime = (at: number): string =>
  new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

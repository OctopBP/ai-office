/**
 * Горячие клавиши офиса — одно место для подписей: плашки в рейле, в шапках
 * окон и в подсказках берут буквы отсюда. Сам обработчик живёт в `App.tsx`
 * (там же — те же буквы в русской раскладке); меняя клавишу, менять оба.
 */
export const HOTKEY = {
  board: 'B',
  money: 'E',
  log: 'L',
  merge: 'Q',
  life: 'J',
  flows: 'P',
  meeting: 'M',
  task: 'ENTER',
  pause: 'SPACE',
  close: 'ESC',
} as const;

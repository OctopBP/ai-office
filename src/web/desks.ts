import type { Desk } from '../shared/types';

/**
 * Полная раскладка рабочих мест — та же, что на сервере в state.ts.
 * Клиенту она нужна, чтобы рисовать свободные места, за которыми пока
 * никто не сидит: с сервера приходят только занятые.
 */
export const DESKS_ALL: Desk[] = [
  { index: 0, x: 1, y: 4 },
  { index: 1, x: 6, y: 4 }, { index: 2, x: 11, y: 4 }, { index: 3, x: 16, y: 4 },
  { index: 4, x: 1, y: 8 }, { index: 5, x: 6, y: 8 },  { index: 6, x: 11, y: 8 },
  { index: 7, x: 16, y: 8 }, { index: 8, x: 10, y: 12 }, { index: 9, x: 14, y: 12 },
];

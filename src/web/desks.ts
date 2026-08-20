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

interface Pos { x: number; y: number }

/**
 * Зона кухни в тайлах — совпадает с площадью, которую в Office.tsx занимают
 * плитка пола (kitchen_tiles), стойка, холодильник и столы. Задана
 * прямоугольником, а не списком точек, чтобы места ниже можно было
 * раскладывать сеткой любой плотности.
 */
const KITCHEN_AREA = { x0: 19.0, y0: 10.75, x1: 23.75, y1: 14.5 };

/**
 * Посадочные места на кухне — там сидят свободные исполнители, пока им не
 * назначили задачу. Количество мест считается от числа рабочих столов
 * исполнителей (все DESKS_ALL, кроме стола PM с индексом 0), а не задано
 * жёстким списком координат: если столов в офисе станет больше, кухня
 * подстроится сама и место найдётся каждому. Раскладка — равномерная сетка
 * внутри зоны кухни, поэтому места не накладываются ни при каком количестве.
 */
export const KITCHEN_SEATS: Pos[] = buildKitchenSeats(
  DESKS_ALL.filter((d) => d.index !== 0).length,
);

function buildKitchenSeats(count: number): Pos[] {
  const n = Math.max(count, 1);
  const areaW = KITCHEN_AREA.x1 - KITCHEN_AREA.x0;
  const areaH = KITCHEN_AREA.y1 - KITCHEN_AREA.y0;
  // Число колонок подбирается так, чтобы ячейка сетки была близка к квадрату —
  // тогда места распределены равномерно, а не вытянуты в одну длинную полосу.
  const cols = Math.max(1, Math.round(Math.sqrt((n * areaW) / areaH)));
  const rows = Math.ceil(n / cols);
  const seats: Pos[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    seats.push({
      x: KITCHEN_AREA.x0 + (col + 0.5) * (areaW / cols),
      y: KITCHEN_AREA.y0 + (row + 0.5) * (areaH / rows),
    });
  }
  return seats;
}

/** Место на кухне для стола с данным индексом — привязка стабильная, один в один. */
export function kitchenSeatFor(deskIndex: number): Pos {
  const i = (deskIndex - 1 + KITCHEN_SEATS.length) % KITCHEN_SEATS.length;
  return KITCHEN_SEATS[i];
}

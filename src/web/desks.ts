import { GRID } from '../shared/types';
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
 * Обеденный стол на кухне — координаты и размер совпадают с dining_table
 * в DECOR (Office.tsx): 6 тайлов в ширину, стоит по центру нижней части
 * кухонной зоны. Места раскладываются вдоль его длинных (верхней и нижней)
 * сторон, а не сеткой по всей зоне — так они не попадают ни в стол, ни в
 * ряд тумб над ним.
 */
const TABLE = { x0: 17.0, y0: 12.2, x1: 23.0, y1: 13.575 };
/** Минимальный шаг между соседними местами вдоль стола. */
const SEAT_STEP = 0.85;
/** Отступ дополнительного ряда мест от предыдущего, если один ряд не вмещает всех. */
const ROW_GAP = 0.9;
/** Место у стороны стола, ближней к тумбам — стоит перед ними, не залезая внутрь. */
const NORTH_Y = TABLE.y0 - 0.75;
/**
 * Высота спрайта агента — 72px при тайле 48px (см. .office .agent .body в
 * styles.css), т.е. 1.5 тайла. Место указывает верхний левый угол спрайта,
 * без смещения вверх (в отличие от места за рабочим столом), поэтому нижний
 * край фигуры уходит на seat.y + AGENT_H.
 */
const AGENT_H = 1.5;
/**
 * Место у южной стороны стола — до нижней стены зоны у него меньше запаса,
 * чем кажется: комната всего GRID.cells тайлов высотой, и фигура высотой
 * AGENT_H, поставленная у самого края стола (TABLE.y1 + отступ), утыкается
 * в стену и обрезается overflow: hidden у .office. Прижимаем место так,
 * чтобы низ фигуры не доходил до стены с небольшим запасом.
 */
const SOUTH_Y = GRID.cells - AGENT_H - 0.2;

/**
 * Посадочные места на кухне — там сидят свободные исполнители, пока им не
 * назначили задачу. Количество мест считается от числа рабочих столов
 * исполнителей (все DESKS_ALL, кроме стола PM с индексом 0), а не задано
 * жёстким списком координат: если столов в офисе станет больше, кухня
 * подстроится сама и место найдётся каждому.
 */
export const KITCHEN_SEATS: Pos[] = buildKitchenSeats(
  DESKS_ALL.filter((d) => d.index !== 0).length,
);

/**
 * Раскладка мест: сначала поровну на обе длинные стороны стола, при
 * нехватке — дополнительными рядами со стороны прохода (там больше запаса
 * до края зоны, чем со стороны тумб). Раскладка детерминированная, поэтому
 * место конкретного стола остаётся стабильным, пока не меняется штат.
 */
function buildKitchenSeats(count: number): Pos[] {
  const n = Math.max(count, 1);
  const width = TABLE.x1 - TABLE.x0;
  const perRow = Math.max(1, Math.floor(width / SEAT_STEP) + 1);
  const seats: Pos[] = [];
  const addRow = (y: number, k: number) => {
    for (let i = 0; i < k; i++) {
      seats.push({ x: TABLE.x0 + (i + 0.5) * (width / k), y });
    }
  };
  let remaining = n;
  const northCount = Math.min(perRow, Math.ceil(n / 2));
  addRow(NORTH_Y, northCount);
  remaining -= northCount;
  let ring = 0;
  while (remaining > 0) {
    const k = Math.min(perRow, remaining);
    addRow(SOUTH_Y + ring * ROW_GAP, k);
    remaining -= k;
    ring++;
  }
  return seats;
}

/** Место на кухне для стола с данным индексом — привязка стабильная, один в один. */
export function kitchenSeatFor(deskIndex: number): Pos {
  const i = (deskIndex - 1 + KITCHEN_SEATS.length) % KITCHEN_SEATS.length;
  return KITCHEN_SEATS[i];
}

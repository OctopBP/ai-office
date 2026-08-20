import type { MeetingSeat } from '../shared/types';

/**
 * Геометрия зоны переговорки в тайлах — центр и базовые радиусы эллипса
 * мест вокруг стола. Согласована с расширенным столом/ковром в DECOR
 * (см. Office.tsx), чтобы человечки садились рядом со столом, а не мимо.
 */
const TABLE_CENTER = { x: 4.2, y: 12.2 };
const BASE_RADIUS = { rx: 2.6, ry: 1.5 };
/** Столько мест умещается по периметру базового эллипса без нахлёста. */
const BASE_CAPACITY = 8;

/**
 * Место за столом переговорки для участника seatIndex из total.
 * Места равномерно распределены по эллипсу вокруг стола: пока участников
 * не больше BASE_CAPACITY, эллипс фиксированного размера; сверх — плавно
 * растёт вместе с числом участников, чтобы дуга между соседними местами
 * не сужалась и человечки не накладывались друг на друга при найме.
 */
export function meetingSeat(seatIndex: number, total: number): MeetingSeat {
  const n = Math.max(total, 1);
  const grow = n > BASE_CAPACITY ? n / BASE_CAPACITY : 1;
  const angle = (seatIndex / n) * Math.PI * 2 - Math.PI / 2;
  return {
    x: TABLE_CENTER.x + Math.cos(angle) * BASE_RADIUS.rx * grow,
    y: TABLE_CENTER.y + Math.sin(angle) * BASE_RADIUS.ry * grow,
  };
}

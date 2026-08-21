import { desks, kitchenSeats } from '../shared/layout';
import type { Catalog, Layout, Pos } from '../shared/layout';
import { GRID } from '../shared/types';

/**
 * Каталог спрайтов и раскладка офиса читаются прямо из design/ (как и
 * спрайты в sprites.ts) — сервер их вебу пока не отдаёт (§8, задача
 * следующего этапа). Общий модуль src/shared/layout.ts считает из них
 * столы и посадочные места (docs/design/office-layout/spec.md §3, §4).
 */
const catalogModules = import.meta.glob('../../design/sprites/out/catalog.json', {
  eager: true, import: 'default',
}) as Record<string, Catalog>;
export const catalog: Catalog = Object.values(catalogModules)[0];

const layoutModules = import.meta.glob('../../design/layouts/classic.json', {
  eager: true, import: 'default',
}) as Record<string, Layout>;
export const layout: Layout = Object.values(layoutModules)[0];

/** Отступ дополнительного ряда мест кухни, если базовых из каталога не хватает. */
const ROW_GAP = 0.9;

/**
 * Высота фигуры агента: все agent_* спрайты одного размера по арту (§3.1
 * места не знают про высоту фигуры, это отрисовка Office.tsx). Нужна, чтобы
 * прижать нижний ряд мест кухни к границе комнаты — иначе он в неё утыкается.
 */
const AGENT_H = Math.max(
  ...Object.entries(catalog.sprites)
    .filter(([name]) => name.startsWith('agent_'))
    .map(([, sprite]) => sprite.size[1]),
);

/**
 * Запас между низом фигуры и стеной, тайлов. Комната обрезана `overflow:
 * hidden` ровно по GRID.cells (styles.css `.office`), а место указывает
 * верхний левый угол фигуры без офсета (Office.tsx: `top: px(work.y)`),
 * поэтому нижний край уходит на seat.y + AGENT_H и может вылезти за стену.
 * Тот самый SOUTH_Y-хак старого кода (desks.ts) — но не в общем
 * src/shared/layout.ts (спека §4 явно не пускает размеры комнаты в общий
 * модуль), а здесь, в веб-модуле, где GRID уже используется (layoutData.ts).
 */
const MAX_SEAT_Y = GRID.cells - AGENT_H - 0.2;

/** Не даёт месту уехать ниже видимой области комнаты. */
function clampToRoom(seat: Pos): Pos {
  return seat.y > MAX_SEAT_Y ? { x: seat.x, y: MAX_SEAT_Y } : seat;
}

/**
 * Добирает места кухни вторым (третьим, ...) рядом, если базовых мест из
 * слотов стола не хватает на всех: обеденный стол даёт фиксированные 8
 * мест (по слотам в каталоге), а рабочих столов в раскладке может быть
 * больше (в classic — 9 у исполнителей, не считая стол PM). Ряды
 * достраиваются в ту же сторону, в которую уже «смотрит» исходный ряд
 * (прочь от центра стола), с тем же шагом по x. Раскладка детерминированная
 * и зависит только от need, поэтому у конкретного стола место не прыгает.
 */
function extendSeats(base: Pos[], need: number): Pos[] {
  if (base.length === 0 || need <= base.length) return base;
  const rows = new Map<number, number[]>();
  for (const seat of base) {
    const xs = rows.get(seat.y) ?? [];
    xs.push(seat.x);
    rows.set(seat.y, xs);
  }
  const rowList = [...rows.entries()].map(([y, xs]) => ({ y, xs }));
  const centerY = rowList.reduce((sum, r) => sum + r.y, 0) / rowList.length;
  const seats = [...base];
  for (let gen = 1; seats.length < need; gen++) {
    for (const row of rowList) {
      if (seats.length >= need) break;
      const sign = row.y < centerY ? -1 : 1;
      const y = row.y + sign * gen * ROW_GAP;
      for (const x of row.xs) {
        if (seats.length >= need) break;
        seats.push({ x, y });
      }
    }
  }
  return seats;
}

/**
 * Все места кухни — на случай, если сразу все исполнители окажутся
 * свободными. Число столов исполнителей (без PM) — верхняя граница штата:
 * сервер не даёт нанять больше сотрудников, чем в офисе рабочих мест
 * (`hire()` в state.ts отказывает, если свободных столов нет), поэтому
 * места кухни считаем один раз от числа столов, а не от текущего штата.
 */
export const KITCHEN_SEATS: Pos[] = extendSeats(
  kitchenSeats(layout, catalog),
  Math.max(desks(layout, catalog).length - 1, 1),
).map(clampToRoom);

/** Место на кухне для стола с данным индексом — привязка стабильная, один в один. */
export function kitchenSeatFor(deskIndex: number): Pos {
  const i = (deskIndex - 1 + KITCHEN_SEATS.length) % KITCHEN_SEATS.length;
  return KITCHEN_SEATS[i];
}

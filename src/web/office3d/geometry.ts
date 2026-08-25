/**
 * Раскладка офиса → коробки для трёхмерной сцены (шаг 1 перевода офиса в 3D).
 *
 * Модуль намеренно ничего не знает про three.js: на вход — та же `Layout`,
 * что читает плоский рендер, на выходе — прямоугольные параллелепипеды в
 * тайлах. Это позволяет считать геометрию без канваса (в тестах) и держать
 * всю арифметику планировки в одном месте, отдельно от материалов и света.
 *
 * Система координат. План двумерный: `x` вправо, `y` вниз. В сцене «вниз по
 * плану» — это «от камеры вглубь», то есть ось Z, а вверх смотрит Y. Значит
 * везде ниже `[x, y]` раскладки превращается в `[x, 0, y]` мира, и высота —
 * третья, новая величина, которой в раскладке нет вообще.
 *
 * Единица измерения — тайл, как и в раскладке (docs/design/office-layout/spec.md §2).
 * Ни в какие метры не переводим: тайл остаётся тайлом, масштаб задаёт камера.
 */
import type { Layout, LayoutRoom, LayoutWall } from '../../shared/layout';

/**
 * Высота стены, тайлов. Ниже реальной (офисная стена — это ~3.6 тайла при
 * тайле в 0.75 м): низкие стены меньше загораживают комнату при облёте и
 * дают «кукольный» вид, ради которого всё и затевалось.
 */
export const WALL_H = 2.6;

/**
 * Толщина стены, тайлов. В плане стена занимает целый тайл (её клетка
 * непроходима — `passability`), но рисуется тоньше и по центру этого тайла:
 * стена в тайл толщиной превращает офис в бункер.
 */
export const WALL_THICK = 0.4;

/** Проём окна по высоте: от подоконника до перемычки. Стена в клетке с окном
 *  разрезается на две коробки, между ними — дырка, сквозь которую идёт свет. */
export const WINDOW_SILL = 0.9;
export const WINDOW_HEAD = 1.9;

/** Толщина плиты пола. Нужна только чтобы у комнаты был видимый торец. */
export const FLOOR_THICK = 0.12;

/** Коробка: центр в плане, габариты по трём осям, отметка низа. */
export interface Box3 {
  /** «стекло» — заполнение оконного проёма: прозрачное и тени не бросает */
  glass?: true;
  /** центр коробки в плане, тайлы */
  cx: number;
  cy: number;
  /** габарит вдоль плана: `w` по x, `d` по y */
  w: number;
  d: number;
  /** высота и отметка низа, тайлы */
  h: number;
  base: number;
}

/**
 * Пол комнаты — одна плита на комнату, а не тайл на тайл: варианты тайлов
 * пола в плоском рендере подменяли текстуру спрайтом, в 3D это делает
 * материал, а геометрически комната всё равно плоская.
 */
export interface Floor3 extends Box3 {
  id: string;
  material: LayoutRoom['floor'];
}

/**
 * Стена как целый отрезок раскладки, а не набор клеток. Группировка нужна
 * гашению: гасить надо всю северную стену разом, иначе при облёте она
 * растворяется кусками. Внутри — коробки (сплошные участки, подоконники и
 * перемычки окон), снаружи — ось, центр и нормаль, по которым считается,
 * загораживает ли отрезок комнату от камеры.
 */
export interface Wall3 {
  /** ось отрезка в плане: 'x' — горизонтальный, 'y' — вертикальный */
  axis: 'x' | 'y';
  /** центр отрезка в плане, тайлы — точка отсчёта для гашения */
  center: [number, number];
  /** нормаль отрезка в плане (единичная, перпендикуляр к оси) */
  normal: [number, number];
  boxes: Box3[];
}

export interface Scene3 {
  /** размер раскладки в тайлах */
  size: [number, number];
  floors: Floor3[];
  walls: Wall3[];
}

/** Из чего состоит клетка стены. Дверной проём не даёт геометрии вовсе. */
type CellKind = 'solid' | 'window' | 'gap';

/**
 * Разбор одного отрезка стены на клетки — повторяет чтение раскладки в
 * `wallGeometry` (`src/shared/layout.ts`): двери задаются как `[смещение,
 * длина]` от точки `a` вдоль отрезка, окна — одиночными смещениями, и окно
 * внутри дверного проёма не считается. Дублирование сознательное: там на
 * выходе тайлы с масками автотайлинга — свойство плоского арта, которого в
 * 3D нет, — а здесь нужны только виды клеток.
 */
function wallCells(wall: LayoutWall) {
  const [ax, ay] = wall.a;
  const [bx, by] = wall.b;
  const horizontal = ay === by;
  const rawLen = horizontal ? bx - ax : by - ay;
  const dir = rawLen < 0 ? -1 : 1;
  const len = Math.abs(rawLen);

  const kinds: CellKind[] = new Array(len).fill('solid');
  for (const [offset, span] of wall.doors ?? []) {
    for (let i = Math.max(offset, 0); i < Math.min(offset + span, len); i++) kinds[i] = 'gap';
  }
  for (const offset of wall.windows ?? []) {
    if (offset >= 0 && offset < len && kinds[offset] !== 'gap') kinds[offset] = 'window';
  }

  const cellAt = (i: number): [number, number] =>
    horizontal ? [ax + i * dir, ay] : [ax, ay + i * dir];

  return { kinds, cellAt, horizontal, len };
}

/**
 * Коробка на сплошном участке из клеток `cells`. Клетка `[x, y]` занимает
 * квадрат `[x, x+1) × [y, y+1)`, поэтому участок тянется от минимальной
 * координаты до максимальной + 1, а поперёк — `WALL_THICK` по центру тайла.
 * Отрезок может быть задан справа налево, поэтому границы берутся минимумом,
 * а не первой клеткой.
 */
function runBox(
  cells: [number, number][], horizontal: boolean, base: number, h: number,
): Box3 {
  const x0 = Math.min(...cells.map(([x]) => x));
  const y0 = Math.min(...cells.map(([, y]) => y));
  const along = cells.length;
  return horizontal
    ? { cx: x0 + along / 2, cy: y0 + 0.5, w: along, d: WALL_THICK, h, base }
    : { cx: x0 + 0.5, cy: y0 + along / 2, w: WALL_THICK, d: along, h, base };
}

/** Геометрия сцены из раскладки. Чистая функция: те же данные — та же сцена. */
export function scene3(layout: Layout): Scene3 {
  const floors: Floor3[] = (layout.rooms ?? []).map((room) => {
    const [x0, y0, x1, y1] = room.rect;
    return {
      id: room.id,
      material: room.floor,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      w: x1 - x0,
      d: y1 - y0,
      h: FLOOR_THICK,
      base: -FLOOR_THICK,
    };
  });

  const walls: Wall3[] = [];
  for (const wall of layout.walls ?? []) {
    const { kinds, cellAt, horizontal, len } = wallCells(wall);
    const boxes: Box3[] = [];

    // Подряд идущие клетки одного вида собираются в одну коробку: длинная
    // стена — это один меш, а не тридцать, и стыков между ними не видно.
    let i = 0;
    while (i < len) {
      const kind = kinds[i];
      let j = i;
      while (j < len && kinds[j] === kind) j++;
      if (kind !== 'gap') {
        const cells: [number, number][] = [];
        for (let k = i; k < j; k++) cells.push(cellAt(k));
        if (kind === 'solid') {
          boxes.push(runBox(cells, horizontal, 0, WALL_H));
        } else {
          boxes.push(runBox(cells, horizontal, 0, WINDOW_SILL));
          boxes.push(runBox(cells, horizontal, WINDOW_HEAD, WALL_H - WINDOW_HEAD));
          // Стекло тоньше стены, чтобы не спорить с ней за пиксели на стыке.
          const glass = runBox(cells, horizontal, WINDOW_SILL, WINDOW_HEAD - WINDOW_SILL);
          if (horizontal) glass.d = WALL_THICK * 0.25; else glass.w = WALL_THICK * 0.25;
          boxes.push({ ...glass, glass: true });
        }
      }
      i = j;
    }
    if (boxes.length === 0) continue;

    const [ax, ay] = wall.a;
    const [bx, by] = wall.b;
    walls.push({
      axis: horizontal ? 'x' : 'y',
      center: [(ax + bx) / 2, (ay + by) / 2],
      normal: horizontal ? [0, 1] : [1, 0],
      boxes,
    });
  }

  return { size: layout.size, floors, walls };
}

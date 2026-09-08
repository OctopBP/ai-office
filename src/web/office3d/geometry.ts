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

/**
 * Насколько коробка участка выходит за центр своей крайней клетки. Стена —
 * объект осевой: тело идёт по центрам клеток, а концы отпускаются по-разному,
 * и именно этим концом стена стыкуется с соседями.
 *
 *  - `JOIN` — конец упирается в стену из соседней клетки: коробка доводится
 *    до её оси и прячется внутри. Меньше нельзя — на стыке останется щель.
 *  - `OPENING` — конец граничит с проёмом или окном внутри того же отрезка:
 *    коробка доводится до границы клетки, и проём выходит ровно той ширины,
 *    какая записана в раскладке.
 *  - `CAP` — свободный конец: коробка обрывается на пол-толщины за осью.
 *    Ради этого случая всё и считается по осям: раньше каждая стена
 *    заполняла свои клетки целиком и на углу выезжала на 0.3 тайла за
 *    внешнюю грань перпендикулярной соседки — угол превращался в крест.
 */
const JOIN = 1;
const OPENING = 0.5;
const CAP = WALL_THICK / 2;

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
  /**
   * У коробки стены: смотрит ли каждая из двух её боковых граней в комнату.
   * `pos` — грань по положительной оси поперёк стены (+Y плана у
   * горизонтальной, +X у вертикальной), `neg` — противоположная. Грань, за
   * которой нет комнаты, — наружная: у неё своя текстура (`Office3D.tsx`).
   */
  sides?: { pos: boolean; neg: boolean };
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

  return { kinds, cellAt, horizontal, dir, len };
}

/**
 * Коробка на сплошном участке из клеток `cells`. Клетка `[x, y]` занимает
 * квадрат `[x, x+1) × [y, y+1)`, но тело стены идёт по центрам клеток: вдоль
 * отрезка коробка тянется от центра первой клетки до центра последней, и уже
 * от них отпускается на `extLo`/`extHi` (`JOIN`/`OPENING`/`CAP`). Поперёк —
 * `WALL_THICK` по центру тайла.
 *
 * Продолжения приходят в порядке координат, а не клеток: отрезок может быть
 * задан справа налево, поэтому границы берутся минимумом и максимумом.
 */
function runBox(
  cells: [number, number][], horizontal: boolean, base: number, h: number,
  extLo: number, extHi: number,
): Box3 {
  const x0 = Math.min(...cells.map(([x]) => x));
  const y0 = Math.min(...cells.map(([, y]) => y));
  const lo = (horizontal ? x0 : y0) + 0.5 - extLo;
  const hi = (horizontal ? x0 : y0) + cells.length - 0.5 + extHi;
  const along = hi - lo;
  const mid = (lo + hi) / 2;
  return horizontal
    ? { cx: mid, cy: y0 + 0.5, w: along, d: WALL_THICK, h, base }
    : { cx: x0 + 0.5, cy: mid, w: WALL_THICK, d: along, h, base };
}

/**
 * Клетки всех стен раскладки, где есть тело стены. Проём не в счёт: в него
 * стена не упирается, а выходит — упереться там не во что. По этому набору
 * конец отрезка и узнаёт, стыкуется он с соседкой или обрывается свободно.
 */
function wallBodyCells(layout: Layout): Set<string> {
  const body = new Set<string>();
  for (const wall of layout.walls ?? []) {
    const { kinds, cellAt, len } = wallCells(wall);
    for (let i = 0; i < len; i++) {
      if (kinds[i] === 'gap') continue;
      const [x, y] = cellAt(i);
      body.add(`${x},${y}`);
    }
  }
  return body;
}

/**
 * Куда смотрят бока коробки стены. Клетка стены лежит внутри комнаты, на её
 * крайнем ряду, поэтому смотрят на соседнюю клетку поперёк стены: есть там
 * комната — грань внутренняя, нет — наружная. Считается по всем клеткам
 * коробки разом: если хоть за одной комната есть, вся грань внутренняя, —
 * коробка одна, и текстуру ей не разрезать.
 */
function sidesOf(
  cells: [number, number][], horizontal: boolean, rooms: LayoutRoom[],
): { pos: boolean; neg: boolean } {
  const inRoom = (x: number, y: number) => rooms.some(({ rect: [x0, y0, x1, y1] }) =>
    x >= x0 && x < x1 && y >= y0 && y < y1);
  const across = (dir: number) => cells.some(([x, y]) =>
    horizontal ? inRoom(x, y + dir) : inRoom(x + dir, y));
  return { pos: across(1), neg: across(-1) };
}

/** Геометрия сцены из раскладки. Чистая функция: те же данные — та же сцена. */
export function scene3(layout: Layout): Scene3 {
  const rooms = layout.rooms ?? [];
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

  const body = wallBodyCells(layout);
  const walls: Wall3[] = [];
  for (const wall of layout.walls ?? []) {
    const { kinds, cellAt, horizontal, dir, len } = wallCells(wall);
    const boxes: Box3[] = [];

    /**
     * Продолжение коробки за центр крайней клетки участка; `outside` — индекс
     * соседней клетки за этим концом. Если она внутри отрезка, там проём или
     * окно и коробка идёт до границы клетки; если снаружи — конец либо
     * стыкуется с соседней стеной, либо обрывается свободно.
     */
    const ext = (outside: number) => {
      if (outside >= 0 && outside < len) return OPENING;
      const [x, y] = cellAt(outside);
      return body.has(`${x},${y}`) ? JOIN : CAP;
    };

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
        // Продолжения нумеруются по клеткам, а коробка живёт в координатах:
        // у отрезка, заданного справа налево, первая клетка — правая.
        const extFirst = ext(i - 1);
        const extLast = ext(j);
        const extLo = dir > 0 ? extFirst : extLast;
        const extHi = dir > 0 ? extLast : extFirst;
        const sides = sidesOf(cells, horizontal, rooms);
        if (kind === 'solid') {
          boxes.push({ ...runBox(cells, horizontal, 0, WALL_H, extLo, extHi), sides });
        } else {
          boxes.push({ ...runBox(cells, horizontal, 0, WINDOW_SILL, extLo, extHi), sides });
          boxes.push({ ...runBox(
            cells, horizontal, WINDOW_HEAD, WALL_H - WINDOW_HEAD, extLo, extHi), sides });
          // Стекло тоньше стены, чтобы не спорить с ней за пиксели на стыке.
          const glass = runBox(
            cells, horizontal, WINDOW_SILL, WINDOW_HEAD - WINDOW_SILL, extLo, extHi);
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

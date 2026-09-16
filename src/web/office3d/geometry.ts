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
 *  - `JOIN` — конец упирается в перпендикулярную стену из соседней клетки:
 *    коробка доводится до её ближней грани, но не дальше. Раньше конец
 *    уходил до оси соседки, и верх двух коробок лежал в одной плоскости —
 *    на стыке мерцало.
 *  - `ABUT` — соседняя клетка продолжает стену той же оси (другой отрезок):
 *    коробка доводится до границы клеток, навстречу такой же.
 *  - `OPENING` — конец граничит с проёмом или окном внутри того же отрезка:
 *    коробка доводится до границы клетки, и проём выходит ровно той ширины,
 *    какая записана в раскладке.
 *  - `CAP` — свободный конец: коробка обрывается на пол-толщины за осью.
 *  - `YIELD` — крайняя клетка общая с перпендикулярной стеной (угол, Т-стык):
 *    клетку забирает соседка, а эта коробка отступает к её грани.
 *
 * Стены сходятся встык, а не внахлёст: у двух коробок, заходящих друг в
 * друга, наружная грань одной ложится в плоскость торца другой, и на углу
 * две текстуры дерутся за пиксели (z-fighting). Встык же соприкасаются
 * только грани с противоположными нормалями, а из них видна всегда одна.
 */
const JOIN = 1 - WALL_THICK / 2;
const ABUT = 0.5;
const OPENING = 0.5;
const CAP = WALL_THICK / 2;
const YIELD = -WALL_THICK / 2;

/** Проём окна по высоте: от подоконника до перемычки. Стена в клетке с окном
 *  разрезается на две коробки, между ними — дырка, сквозь которую идёт свет. */
export const WINDOW_SILL = 0.9;
export const WINDOW_HEAD = 1.9;

/** Толщина плиты пола. Нужна только чтобы у комнаты был видимый торец. */
export const FLOOR_THICK = 0.12;

/**
 * Отметка низа стены — низ плиты пола, а не ноль. Пол у наружной стены
 * кончается внутри неё, и стена, стоящая на нуле, висела бы над щелью в
 * толщину пола; опущенная, она закрывает торец пола и стоит на общей плите.
 */
const WALL_BASE = -FLOOR_THICK;

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
  /**
   * То же для торцов коробки вдоль стены: `lo` — у меньшей координаты, `hi` —
   * у большей. Торец углового участка смотрит на улицу и должен быть
   * наружным, торец в дверном проёме — внутренним.
   */
  ends?: { lo: boolean; hi: boolean };
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
  /**
   * Прямоугольник общей плиты под офисом `[x0, y0, x1, y1]`, тайлы: от
   * наружной грани стен до наружной грани, а не по размеру раскладки — иначе
   * плита торчит за стенами на те же пол-тайла, что и пол.
   */
  ground: [number, number, number, number];
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
 * Клетки всех стен раскладки, где есть тело стены, — отдельно для
 * горизонтальных и вертикальных. Проём не в счёт: в него стена не упирается,
 * а выходит — упереться там не во что. По этим наборам конец отрезка и
 * узнаёт, с кем он стыкуется и кому уступает общую клетку.
 *
 * `all` — все клетки стен вместе с проёмами: по ним пол узнаёт, что его край
 * лежит под стеной.
 */
function wallBodyCells(layout: Layout) {
  const x = new Set<string>();
  const y = new Set<string>();
  const all = new Set<string>();
  for (const wall of layout.walls ?? []) {
    const { kinds, cellAt, horizontal, len } = wallCells(wall);
    for (let i = 0; i < len; i++) {
      const [cx, cy] = cellAt(i);
      all.add(`${cx},${cy}`);
      if (kinds[i] === 'gap') continue;
      (horizontal ? x : y).add(`${cx},${cy}`);
    }
  }
  return { x, y, all };
}

const inRoomOf = (rooms: LayoutRoom[]) => (x: number, y: number) =>
  rooms.some(({ rect: [x0, y0, x1, y1] }) => x >= x0 && x < x1 && y >= y0 && y < y1);

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
  const inRoom = inRoomOf(rooms);
  const across = (dir: number) => cells.some(([x, y]) =>
    horizontal ? inRoom(x, y + dir) : inRoom(x + dir, y));
  return { pos: across(1), neg: across(-1) };
}

/**
 * Насколько пол комнаты не доходит до края её прямоугольника: от границы
 * клетки до оси стены, что стоит на крайнем ряду. Не до наружной грани:
 * тогда торец плиты пола ложится в одну плоскость с наружной гранью стены
 * и мерцает. Край, спрятанный в тело стены, не виден вовсе.
 */
const FLOOR_TRIM = 0.5;

/**
 * Пол комнаты обрезается под стеной, по её оси. Комната в раскладке может
 * включать клетки своих стен, а стена стоит по центру клетки — и снаружи
 * от неё оставалась полоска паркета. Край режется, только если весь его ряд
 * — клетки стен (с проёмами) и за ним нет другой комнаты: пол между двумя
 * комнатами трогать незачем.
 */
function floorOf(room: LayoutRoom, wallCells: Set<string>, inRoom: (x: number, y: number) => boolean): Floor3 {
  let [x0, y0, x1, y1] = room.rect;
  const edge = (cells: [number, number][], beyond: [number, number][]) =>
    cells.every(([x, y]) => wallCells.has(`${x},${y}`)) && !beyond.some(([x, y]) => inRoom(x, y));
  const col = (x: number): [number, number][] =>
    Array.from({ length: y1 - y0 }, (_, i) => [x, y0 + i]);
  const row = (y: number): [number, number][] =>
    Array.from({ length: x1 - x0 }, (_, i) => [x0 + i, y]);
  const trimL = edge(col(x0), col(x0 - 1)) ? FLOOR_TRIM : 0;
  const trimR = edge(col(x1 - 1), col(x1)) ? FLOOR_TRIM : 0;
  const trimT = edge(row(y0), row(y0 - 1)) ? FLOOR_TRIM : 0;
  const trimB = edge(row(y1 - 1), row(y1)) ? FLOOR_TRIM : 0;
  x0 += trimL; x1 -= trimR; y0 += trimT; y1 -= trimB;
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
}

/** Геометрия сцены из раскладки. Чистая функция: те же данные — та же сцена. */
export function scene3(layout: Layout): Scene3 {
  const rooms = layout.rooms ?? [];
  const inRoom = inRoomOf(rooms);
  const body = wallBodyCells(layout);
  const floors = rooms.map((room) => floorOf(room, body.all, inRoom));

  const walls: Wall3[] = [];
  for (const wall of layout.walls ?? []) {
    const { kinds, cellAt, horizontal, dir, len } = wallCells(wall);
    const same = horizontal ? body.x : body.y;
    const perp = horizontal ? body.y : body.x;
    const boxes: Box3[] = [];

    /**
     * Продолжение коробки за центр крайней клетки участка; `edge` — индекс
     * самой крайней клетки, `outside` — соседней за этим концом.
     *
     * Сначала — делит ли крайняя клетка стену с перпендикулярной соседкой.
     * Клетку забирает та, что проходит через неё насквозь; если обе в ней
     * кончаются (обычный угол), — горизонтальная. Уступившая отступает к
     * грани забравшей. Дальше — по соседней клетке: проём своего отрезка,
     * перпендикулярная стена, продолжение по той же оси или пустота.
     */
    const ext = (edge: number, outside: number) => {
      const [ex, ey] = cellAt(edge);
      if (perp.has(`${ex},${ey}`)) {
        const through = horizontal
          ? perp.has(`${ex},${ey - 1}`) && perp.has(`${ex},${ey + 1}`)
          : perp.has(`${ex - 1},${ey}`) && perp.has(`${ex + 1},${ey}`);
        if (through || !horizontal) return YIELD;
      }
      if (outside >= 0 && outside < len) return OPENING;
      const [x, y] = cellAt(outside);
      if (perp.has(`${x},${y}`)) return JOIN;
      if (same.has(`${x},${y}`)) return ABUT;
      return CAP;
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
        const extFirst = ext(i, i - 1);
        const extLast = ext(j - 1, j);
        const extLo = dir > 0 ? extFirst : extLast;
        const extHi = dir > 0 ? extLast : extFirst;
        const sides = sidesOf(cells, horizontal, rooms);
        // Торец наружный, если за ним — клетка вне комнат (угол офиса).
        const [fx, fy] = cellAt(i - 1);
        const [lx, ly] = cellAt(j);
        const firstIn = inRoom(fx, fy);
        const lastIn = inRoom(lx, ly);
        const ends = dir > 0 ? { lo: firstIn, hi: lastIn } : { lo: lastIn, hi: firstIn };
        if (kind === 'solid') {
          boxes.push({ ...runBox(cells, horizontal, WALL_BASE, WALL_H - WALL_BASE, extLo, extHi), sides, ends });
        } else {
          boxes.push({ ...runBox(cells, horizontal, WALL_BASE, WINDOW_SILL - WALL_BASE, extLo, extHi), sides, ends });
          boxes.push({ ...runBox(
            cells, horizontal, WINDOW_HEAD, WALL_H - WINDOW_HEAD, extLo, extHi), sides, ends });
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

  // Плита — по габариту того, что на ней стоит: полов и стен.
  const boxes = [...floors, ...walls.flatMap((w) => w.boxes)];
  const ground: Scene3['ground'] = boxes.length === 0
    ? [0, 0, layout.size[0], layout.size[1]]
    : [
      Math.min(...boxes.map((b) => b.cx - b.w / 2)),
      Math.min(...boxes.map((b) => b.cy - b.d / 2)),
      Math.max(...boxes.map((b) => b.cx + b.w / 2)),
      Math.max(...boxes.map((b) => b.cy + b.d / 2)),
    ];

  return { size: layout.size, floors, walls, ground };
}

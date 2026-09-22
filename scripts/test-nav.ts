/**
 * Проверки ходьбы по карте (docs/design/office-layout/spec.md §7).
 *
 * Ходьба — единственная часть офиса, которую нельзя проверить глазами
 * надёжно: агент проходит сквозь стол раз в десять минут и в тот момент, на
 * который никто не смотрит. Поэтому проверяется не картинка, а свойство
 * маршрута: ломаная из `findPath` не должна касаться занятых клеток нигде,
 * кроме клеток своих же концов (в клетку сиденья агент и должен зайти — он
 * туда садится).
 *
 * Запуск: npm run test:nav
 */
import {
  adjacentFree, deskFacing, deskPoint, desks, findPath, FOOT_DX, FOOT_DY, isBlocked,
  kitchenSeats, meetingSeat, nearestFree, oppositeSide, passability, propBox,
  propFootprint, propPivot, restSeats, rotateSide, SIDE_BIT, slotPoint, spriteOf,
  standingAt, talkSeats, walkerCell, yawOfSide,
} from '../src/shared/layout';
import type { Layout, LayoutProp, Passability, Pos, Rotation, Side } from '../src/shared/layout';
import { catalog, layoutIds, loadLayout } from '../src/server/layout';

// Раскладки и каталог спрайтов читаем тем же модулем, что и сервер: корень
// считает src/server/root.ts, а список пресетов — сама директория. Свой
// список имён здесь уже подводил — проверка падала на слитом дереве, где
// раскладку успели удалить в main (см. layoutIds).
const LAYOUT_IDS = layoutIds();

let passed = 0;
const failures: string[] = [];

function check(ok: boolean, what: string): void {
  if (ok) passed += 1;
  else failures.push(what);
}

/**
 * Клетка точки маршрута — по ногам, а не по якорю.
 *
 * Маршрут записан якорями фигуры (левый верхний угол спрайта), а занимает
 * человек клетку, в которой стоит: она лежит строкой ниже. Проверять якорь
 * значит проверять пустое место над головой — ровно та ошибка, из-за которой
 * агенты ходили сквозь стены, а проверки этого не видели.
 */
function tileKey(p: Pos): string {
  const cell = walkerCell(p);
  return `${cell.x},${cell.y}`;
}

/** Шаг выборки вдоль отрезка — впятеро мельче тайла: срезанный угол не проскочит. */
const SAMPLE = 0.2;

/**
 * Клетки, по которым маршруту разрешено идти вопреки занятости: клетка цели и
 * соседние места того же предмета.
 *
 * Место человека лежит на самой мебели, и зайти на неё — это и есть «сесть».
 * Соседние подушки того же дивана считаются вместе с ней: если проход перед
 * половиной дивана перегорожен журнальным столиком, на дальнюю подушку
 * заходят с открытого края и переходят по дивану — так и садятся люди.
 */
function seatCellsAround(p: Passability, goal: Pos): Set<string> {
  const cell = walkerCell(goal);
  const out = new Set([`${cell.x},${cell.y}`]);
  const entry = p.entries.get(cell.y * p.cols + cell.x);
  if (!entry) return out;
  for (const [idx, e] of p.entries) {
    if (e.prop === entry.prop) out.add(`${idx % p.cols},${Math.floor(idx / p.cols)}`);
  }
  return out;
}

/**
 * Ломаная не задевает занятых клеток.
 *
 * Послабление сделано мебели на концах маршрута, и только ей. Место человека
 * лежит на самом предмете: «сесть» — это и есть шаг на занятый тайл, а
 * «встать» — шаг с него. Поэтому клетки мест того предмета, с которого агент
 * встаёт, и того, на который садится, разрешены (`seatCellsAround`). Стены и
 * вся остальная мебель — нет, нигде и никогда.
 */
function pathIsClean(p: Passability, path: Pos[]): string | null {
  const allowed = seatCellsAround(p, path[path.length - 1]);
  for (const key of seatCellsAround(p, path[0])) allowed.add(key);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / SAMPLE));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const cell = walkerCell({ x, y });
      if (!isBlocked(p, cell.x, cell.y)) continue;
      if (allowed.has(`${cell.x},${cell.y}`)) continue;
      return `отрезок ${i} (${a.x.toFixed(2)},${a.y.toFixed(2)})→(${b.x.toFixed(2)},${b.y.toFixed(2)})`
        + ` идёт по занятой клетке (${cell.x},${cell.y})`;
    }
  }
  return null;
}

/**
 * Середина маршрута идёт ровно по карте: каждый отрезок между точками —
 * либо вдоль оси, либо строго под 45°. Первый и последний отрезок свободны:
 * это доводка до точной точки места внутри клетки.
 */
function pathIsOnGrid(path: Pos[]): string | null {
  for (let i = 2; i < path.length - 1; i++) {
    const dx = Math.abs(path[i].x - path[i - 1].x);
    const dy = Math.abs(path[i].y - path[i - 1].y);
    const axis = dx < 1e-6 || dy < 1e-6;
    const diagonal = Math.abs(dx - dy) < 1e-6;
    if (!axis && !diagonal) {
      return `отрезок ${i} идёт не по сетке: dx=${dx.toFixed(3)}, dy=${dy.toFixed(3)}`;
    }
  }
  return null;
}

/** Все точки, куда офис водит агентов: рабочие места, места отдыха, переговорка. */
function targetsOf(layout: Layout): { label: string; at: Pos }[] {
  const list: { label: string; at: Pos }[] = [];
  for (const d of desks(layout, catalog)) {
    list.push({ label: `стол #${d.index}`, at: deskPoint(layout, catalog, d.index, 'work') });
  }
  kitchenSeats(layout, catalog).forEach((at, i) => list.push({ label: `место отдыха ${i}`, at }));
  const total = desks(layout, catalog).length;
  for (let i = 0; i < total; i++) {
    list.push({ label: `переговорка ${i}/${total}`, at: meetingSeat(layout, catalog, i, total) });
  }
  for (const [i, zone] of (layout.zones ?? []).entries()) {
    talkSeats(zone).forEach((seat, j) => list.push({ label: `разговор ${i}${'ab'[j]}`, at: seat.at }));
  }
  return list;
}

for (const id of LAYOUT_IDS) {
  const layout = loadLayout(id);
  const p = passability(layout, catalog);
  const targets = targetsOf(layout);

  // 1. След мебели герметичен: внутри него нет свободных клеток. Раньше
  //    расчистка слотов пробивала в столе клетку под табличкой, и кратчайший
  //    путь шёл сквозь стол.
  for (const prop of layout.props) {
    const sprite = spriteOf(catalog, prop.sprite);
    if (!sprite?.blocks) continue;
    // След берём повёрнутый (`propFootprint`) — тот же, по которому считает
    // `passability`. Считать здесь `footprint` из каталога значило бы, что
    // проверка и карта расходятся ровно на повёрнутых предметах.
    const { x: x0, y: y0, w, h } = propFootprint(prop, sprite);
    const x1 = x0 + w;
    const y1 = y0 + h;
    const holes: string[] = [];
    // Только клетки целиком внутри следа: задетые кромкой — вопрос точности
    // следа (docs/design/office-units/spec.md §4), а не проходимости.
    for (let y = Math.ceil(y0); y + 1 <= Math.floor(y1); y++) {
      for (let x = Math.ceil(x0); x + 1 <= Math.floor(x1); x++) {
        if (!isBlocked(p, x, y)) holes.push(`(${x},${y})`);
      }
    }
    check(holes.length === 0, `${id}: в следе ${prop.sprite} @${prop.at} дыры ${holes.join(' ')}`);
  }

  // 2. До каждого места есть путь, и он не задевает занятых клеток.
  for (const from of targets) {
    for (const to of targets) {
      if (from === to) continue;
      const path = findPath(p, from.at, to.at, { bestEffort: true });
      check(!!path, `${id}: нет маршрута ${from.label} → ${to.label}`);
      if (!path) continue;
      const dirty = pathIsClean(p, path);
      check(!dirty, `${id}: ${from.label} → ${to.label}: ${dirty}`);
      const offGrid = pathIsOnGrid(path);
      check(!offGrid, `${id}: ${from.label} → ${to.label}: ${offGrid}`);
    }
  }
  // Дошёл ли маршрут до самой точки места — вопрос не к поиску пути, а к
  // раскладке: место бывает заперто мебелью или вынесено за край комнаты.
  // Спрашивает его `npm run test:reach`, который умеет назвать виноватый
  // файл раскладки; здесь проверяется, что путь честен, а не что он есть.

  // 3. Строгий режим по-прежнему строгий: занятая клетка — это null, а не
  //    молчаливая подмена. На нём стоит диагностика раскладок.
  const wall = firstBlocked(p);
  if (wall) {
    check(findPath(p, targets[0].at, wall) === null, `${id}: строгий поиск дошёл до занятой клетки`);
  }

  // 4. Замена занятой клетке находится и она свободна.
  if (wall) {
    const free = nearestFree(p, wall.x, wall.y);
    check(!!free && !isBlocked(p, free.x, free.y), `${id}: nearestFree вернул занятую клетку`);
  }

  // 5. Место «встать рядом» существует у каждого стола и свободно.
  for (const d of desks(layout, catalog)) {
    const beside = adjacentFree(p, deskPoint(layout, catalog, d.index, 'work'));
    const cell = beside ? walkerCell(beside) : null;
    check(!!cell && !isBlocked(p, cell.x, cell.y),
      `${id}: у стола #${d.index} некуда встать рядом`);
  }

  // 6. Место точечного слота лежит внутри следа своего предмета.
  //
  //    Ловит перекос от дробной расстановки: след округляется до целых
  //    тайлов, а точка места — нет, и предмет, поставленный на полтайла,
  //    разъезжается со своим же местом. В `studio` диван стоял на 9.5:
  //    подушки оказывались в задней половине следа, а перед ними — сам
  //    диван, и сесть было нельзя ниоткуда.
  for (const prop of layout.props) {
    const sprite = spriteOf(catalog, prop.sprite);
    if (!sprite?.blocks) continue;
    for (const slot of sprite.slots ?? []) {
      if (slot.kind !== 'seat' || !('x' in slot)) continue;
      const cell = walkerCell(slotPoint(prop, sprite, slot));
      check(isBlocked(p, cell.x, cell.y),
        `${id}: место ${prop.sprite}@${prop.at} лежит вне следа предмета`
        + ` — клетка (${cell.x},${cell.y}) свободна, предмет стоит не на целых тайлах`);
    }
  }

  // 7. Вход соблюдается: последний шаг на место идёт с объявленной стороны.
  for (const to of targets) {
    const cell = walkerCell(to.at);
    const entry = p.entries.get(cell.y * p.cols + cell.x);
    if (!entry) continue;
    const path = findPath(p, targets[0].at, to.at, { bestEffort: true });
    if (!path || path.length < 2) continue;
    const end = path[path.length - 1];
    if (Math.hypot(end.x - to.at.x, end.y - to.at.y) > 1e-6) continue;
    const prev = walkerCell(path[path.length - 2]);
    if (prev.x === cell.x && prev.y === cell.y) continue;
    const sameProp = p.entries.get(prev.y * p.cols + prev.x)?.prop === entry.prop;
    const dx = cell.x - prev.x;
    const dy = cell.y - prev.y;
    const bit = dx > 0 ? 4 : dx < 0 ? 8 : dy > 0 ? 1 : 2; // w, e, n, s
    check(sameProp || (dx === 0 || dy === 0) && (entry.sides & bit) !== 0,
      `${id}: на «${to.label}» заходят не с объявленной стороны — из (${prev.x},${prev.y})`);
  }
}

// ---------- Поворот предмета (§3.2, `LayoutProp.rot`) ----------
//
// Проверяется на предмете, стоящем в пустой комнате в одиночестве: у поворота
// свойства точные — габарит меняет стороны местами, место уезжает вместе с
// предметом, войти на него можно с повёрнутой стороны, — и соседняя мебель
// тут только мешала бы понять, что именно сломалось.

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

/** Пустая комната с одним предметом. */
function alone(prop: LayoutProp): Layout {
  return { version: 1, id: 'rot', title: 'поворот', size: [16, 16], props: [prop] };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** Сторона, с которой шагнули из клетки `from` в клетку `to`. */
function stepSide(from: Pos, to: Pos): Side | null {
  if (to.x === from.x && to.y === from.y) return null;
  if (to.x !== from.x && to.y !== from.y) return null;
  if (to.x !== from.x) return to.x > from.x ? 'w' : 'e';
  return to.y > from.y ? 'n' : 's';
}

const sofaSprite = spriteOf(catalog, 'sofa');
const deskSprite = spriteOf(catalog, 'desk');
check(!!sofaSprite && !!deskSprite, 'поворот: в каталоге нет sofa или desk');

if (sofaSprite && deskSprite) {
  // 1. Старый предмет — тот, у которого поля вовсе нет, — читается как rot: 0
  //    и считается ровно так же. Это и есть обратная совместимость раскладок,
  //    написанных до поворота.
  const plain: LayoutProp = { sprite: 'sofa', at: [5, 5] };
  const explicitZero: LayoutProp = { ...plain, rot: 0 };
  const a = propFootprint(plain, sofaSprite);
  const b = propFootprint(explicitZero, sofaSprite);
  check(near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h),
    'поворот: предмет без поля rot считается не как rot: 0');
  check(JSON.stringify(restSeats(alone(plain), catalog))
    === JSON.stringify(restSeats(alone(explicitZero), catalog)),
    'поворот: места предмета без поля rot разошлись с rot: 0');

  // 2. Габарит поворачивается вместе с предметом: у 3×2 при 90° занятые
  //    клетки становятся 2×3, а угол следа остаётся на месте — предмет
  //    разворачивается, а не уезжает, и с целых тайлов не съезжает.
  const base = propFootprint(plain, sofaSprite);
  for (const rot of ROTATIONS) {
    const turned = propFootprint({ ...plain, rot }, sofaSprite);
    const swapped = rot === 90 || rot === 270;
    check(near(turned.w, swapped ? base.h : base.w) && near(turned.h, swapped ? base.w : base.h),
      `поворот ${rot}°: стороны следа не поменялись местами`);
    check(near(turned.x, base.x) && near(turned.y, base.y),
      `поворот ${rot}°: след уехал с угла предмета`);
    const box = propBox({ ...plain, rot }, sofaSprite);
    const plainBox = propBox(plain, sofaSprite);
    check(near(box.w, swapped ? plainBox.h : plainBox.w)
      && near(box.h, swapped ? plainBox.w : plainBox.h),
      `поворот ${rot}°: габарит предмета не повернулся`);
  }

  // 3. Углы, не кратные прямому, и обороты сверх круга приводятся к четырём
  //    положениям: −90 это 270, 450 это 90.
  for (const [given, same] of [[-90, 270], [450, 90], [359, 0], [46, 90]] as const) {
    const one = propFootprint({ ...plain, rot: given }, sofaSprite);
    const two = propFootprint({ ...plain, rot: same }, sofaSprite);
    check(near(one.x, two.x) && near(one.y, two.y) && near(one.w, two.w) && near(one.h, two.h),
      `поворот: ${given}° не привёлся к ${same}°`);
  }

  // 4. Сторона предмета разворачивается вместе с ним: север повёрнутого на
  //    90° смотрит на восток, а «лицом к предмету» остаётся напротив.
  check(rotateSide('n', 90) === 'e' && rotateSide('e', 90) === 's'
    && rotateSide('s', 90) === 'w' && rotateSide('w', 90) === 'n',
    'поворот: сторона предмета разворачивается не по часовой стрелке');
  check(oppositeSide('n') === 's' && oppositeSide('w') === 'e',
    'поворот: противоположная сторона названа неверно');

  // 5. Места дивана уезжают вместе с ним: остаются на самом предмете, а
  //    взгляд разворачивается на тот же угол.
  const flat = restSeats(alone(plain), catalog);
  for (const rot of ROTATIONS) {
    const prop: LayoutProp = { ...plain, rot };
    const layout = alone(prop);
    const grid = passability(layout, catalog);
    const seats = restSeats(layout, catalog);
    check(seats.length === flat.length, `поворот ${rot}°: мест у дивана стало другое число`);
    seats.forEach((seat, i) => {
      const cell = walkerCell(seat.at);
      check(isBlocked(grid, cell.x, cell.y),
        `поворот ${rot}°: место ${i} съехало с дивана — клетка (${cell.x},${cell.y}) свободна`);
      check(seat.facing === rotateSide(flat[i].facing, rot),
        `поворот ${rot}°: место ${i} смотрит ${seat.facing}, а должно`
        + ` ${rotateSide(flat[i].facing, rot)}`);
      check(near(seat.yaw, yawOfSide(seat.facing)),
        `поворот ${rot}°: у места ${i} yaw не совпал со стороной взгляда`);
    });
  }

  // 6. На диване сидят от спинки — туда, откуда на место и заходят.
  check(flat.every((s) => s.facing === 's'),
    'поворот: на неповёрнутом диване сидят не лицом от спинки');

  // 7. За столом смотрят в стол, и поворот стола разворачивает взгляд.
  const deskProp: LayoutProp = { sprite: 'desk', at: [5, 5] };
  for (const rot of ROTATIONS) {
    const layout = alone({ ...deskProp, rot });
    check(deskFacing(layout, catalog, 0) === rotateSide('s', rot),
      `поворот ${rot}°: сидящий за столом смотрит не в стол`);
    // Место уехало на ту сторону, куда стол повёрнут: у оси предмета и точки
    // места одна и та же сторона до и после поворота.
    const at = deskPoint(layout, catalog, 0, 'work');
    const pivot = propPivot({ ...deskProp, rot }, deskSprite);
    const away = oppositeSide(deskFacing(layout, catalog, 0));
    const foot = { x: at.x + FOOT_DX, y: at.y + FOOT_DY };
    const side: Side = Math.abs(foot.x - pivot.x) >= Math.abs(foot.y - pivot.y)
      ? (foot.x >= pivot.x ? 'e' : 'w')
      : (foot.y >= pivot.y ? 's' : 'n');
    check(side === away, `поворот ${rot}°: рабочее место осталось на прежней стороне стола`);
  }

  // 8. К повёрнутому месту подходят с той стороны, где оно доступно, и не
  //    сквозь мебель: маршрут доходит до самой точки, последний шаг идёт с
  //    объявленной (повёрнутой) стороны, и по занятым клеткам он не гуляет.
  for (const prop of [plain, deskProp]) {
    for (const rot of ROTATIONS) {
      const layout = alone({ ...prop, rot });
      const grid = passability(layout, catalog);
      const targets = prop === plain
        ? restSeats(layout, catalog).map((s) => s.at)
        : [deskPoint(layout, catalog, 0, 'work')];
      const start = standingAt(1, 1);
      targets.forEach((to, i) => {
        const path = findPath(grid, start, to, { bestEffort: true });
        const end = path?.[path.length - 1];
        check(!!end && near(end.x, to.x) && near(end.y, to.y),
          `поворот ${rot}° (${prop.sprite}): до места ${i} не дойти`);
        if (!path) return;
        const dirty = pathIsClean(grid, path);
        check(!dirty, `поворот ${rot}° (${prop.sprite}): путь к месту ${i} — ${dirty}`);
        const cell = walkerCell(to);
        const entry = grid.entries.get(cell.y * grid.cols + cell.x);
        if (!entry || path.length < 2) return;
        const prev = walkerCell(path[path.length - 2]);
        if (prev.x === cell.x && prev.y === cell.y) return;
        const sameProp = grid.entries.get(prev.y * grid.cols + prev.x)?.prop === entry.prop;
        const side = stepSide(prev, cell);
        check(sameProp || (!!side && (entry.sides & SIDE_BIT[side]) !== 0),
          `поворот ${rot}° (${prop.sprite}): на место ${i} зашли не с объявленной стороны`);
      });
    }
  }
}

/** Занятая клетка как точка маршрута: якорь фигуры, которая на ней стоит. */
function firstBlocked(p: Passability): Pos | null {
  for (let y = 0; y < p.rows; y++) {
    for (let x = 0; x < p.cols; x++) if (isBlocked(p, x, y)) return standingAt(x, y);
  }
  return null;
}

if (failures.length > 0) {
  console.error(`Провалено ${failures.length} из ${passed + failures.length}:`);
  for (const f of failures.slice(0, 500)) console.error('  ✗', f);
  if (failures.length > 500) console.error(`  … и ещё ${failures.length - 500}`);
  process.exit(1);
}
console.log(`Ходьба по карте: ${passed} проверок прошли.`);

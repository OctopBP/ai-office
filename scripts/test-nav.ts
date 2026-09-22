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
  adjacentFree, deskPoint, desks, findPath, isBlocked, kitchenSeats, meetingSeat,
  nearestFree, passability, propScale, propSize, spriteOf, standingAt, talkSeats,
  walkerCell,
} from '../src/shared/layout';
import type { Layout, Passability, Pos } from '../src/shared/layout';
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
    const [fx, fy, fw, fh] = sprite.footprint ?? [0, 0, sprite.size[0], sprite.size[1]];
    const [kx, ky] = propScale(prop, sprite);
    const x0 = prop.at[0] + fx * kx;
    const y0 = prop.at[1] + fy * ky;
    const x1 = x0 + fw * kx;
    const y1 = y0 + fh * ky;
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
    const [sx, sy] = propScale(prop, sprite);
    for (const slot of sprite.slots ?? []) {
      if (slot.kind !== 'seat' || !('x' in slot)) continue;
      const cell = walkerCell({ x: prop.at[0] + slot.x * sx, y: prop.at[1] + slot.y * sy });
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

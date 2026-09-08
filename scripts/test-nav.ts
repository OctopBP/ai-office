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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adjacentFree, deskPoint, desks, findPath, isBlocked, kitchenSeats, meetingSeat,
  nearestFree, passability, propScale, propSize, spriteOf, talkSeats,
} from '../src/shared/layout';
import type { Catalog, Layout, Passability, Pos } from '../src/shared/layout';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(
  readFileSync(resolve(ROOT, 'design/sprites/out/catalog.json'), 'utf8'),
) as Catalog;
const LAYOUT_IDS = ['classic', 'studio', 'studio_2'];

let passed = 0;
const failures: string[] = [];

function check(ok: boolean, what: string): void {
  if (ok) passed += 1;
  else failures.push(what);
}

function tileKey(p: Pos): string {
  return `${Math.floor(p.x)},${Math.floor(p.y)}`;
}

/** Шаг выборки вдоль отрезка — впятеро мельче тайла: срезанный угол не проскочит. */
const SAMPLE = 0.2;

/**
 * Ломаная не задевает занятых клеток.
 *
 * Двум отрезкам сделано послабление, и оба — про мебель, а не про стены.
 * Последний может зайти в клетку цели: место на диване лежит на самом диване,
 * и «сесть» — это и есть шаг на занятый тайл. Первый не проверяется вовсе,
 * если агент застигнут сидящим: он с этого дивана встаёт, и выход наружу
 * тоже идёт по занятым клеткам.
 */
function pathIsClean(p: Passability, path: Pos[]): string | null {
  const allowed = new Set([tileKey(path[path.length - 1])]);
  const leavingSeat = isBlocked(p, Math.floor(path[0].x), Math.floor(path[0].y));
  for (let i = 1; i < path.length; i++) {
    if (i === 1 && leavingSeat) continue;
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / SAMPLE));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if (!isBlocked(p, Math.floor(x), Math.floor(y))) continue;
      if (allowed.has(`${Math.floor(x)},${Math.floor(y)}`)) continue;
      return `отрезок ${i} (${a.x.toFixed(2)},${a.y.toFixed(2)})→(${b.x.toFixed(2)},${b.y.toFixed(2)})`
        + ` идёт по занятой клетке (${Math.floor(x)},${Math.floor(y)})`;
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
  const layout = JSON.parse(readFileSync(resolve(ROOT, `design/layouts/${id}.json`), 'utf8')) as Layout;
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
      const end = path[path.length - 1];
      const arrived = Math.hypot(end.x - to.at.x, end.y - to.at.y) < 1e-6;
      check(arrived, `${id}: ${from.label} → ${to.label}: не доходит до цели`
        + ` — встал в (${end.x.toFixed(2)},${end.y.toFixed(2)})`
        + ` вместо (${to.at.x.toFixed(2)},${to.at.y.toFixed(2)})`);
    }
  }

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
    check(!!beside && !isBlocked(p, Math.floor(beside.x), Math.floor(beside.y)),
      `${id}: у стола #${d.index} некуда встать рядом`);
  }
}

function firstBlocked(p: Passability): Pos | null {
  for (let y = 0; y < p.rows; y++) {
    for (let x = 0; x < p.cols; x++) if (isBlocked(p, x, y)) return { x: x + 0.5, y: y + 0.5 };
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

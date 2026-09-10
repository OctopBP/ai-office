/**
 * Проверка достижимости: для каждой раскладки строит сетку проходимости
 * (passability) и проверяет через A* (findPath), что до каждой значимой
 * точки — рабочих столов, мест кухни, мест переговорки (4 и 8 участников)
 * и зоны входа — можно дойти от заведомо свободной точки опенспейса.
 *
 * Код проекта не меняет: только читает layout.ts, раскладки и каталог.
 * Запуск: npm run test:reach
 *
 * Была разовой диагностикой и всегда выходила нулём — потому недостижимые
 * места переговорки (T-141) и прожили в main незамеченными: скрипт печатал
 * FAIL, а конвейеру это ни о чём не говорило. Теперь код выхода 1 при первой
 * же недостижимой точке, и проверка годится в пред-merge гейт.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  desks, deskPoint, findPath, isBlocked, kitchenSeats, meetingSeat, passability,
} from '../src/shared/layout';

import type { Catalog, Layout, Pos } from '../src/shared/layout';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const catalog = readJson<Catalog>(resolve(ROOT, 'design/sprites/out/catalog.json'));
const LAYOUT_IDS = ['classic', 'studio', 'studio_2', 'studio_3', 'studio_4'];

/** Свободная точка опенспейса — ближайшая к центру сетки, ищем спиралью колец. */
function findOpenspaceStart(p: ReturnType<typeof passability>): Pos {
  const cx = Math.floor(p.cols / 2);
  const cy = Math.floor(p.rows / 2);
  for (let r = 0; r < Math.max(p.cols, p.rows); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!isBlocked(p, x, y)) return { x: x + 0.5, y: y + 0.5 };
      }
    }
  }
  throw new Error('в раскладке нет ни одной свободной клетки');
}

interface CheckTarget { label: string; point: Pos }

interface Row {
  label: string;
  point: Pos;
  reachable: boolean;
  reason: string;
}

function checkAll(layout: Layout): { start: Pos; rows: Row[] } {
  const p = passability(layout, catalog);
  const start = findOpenspaceStart(p);

  const targets: CheckTarget[] = [];

  const deskList = desks(layout, catalog);
  for (const d of deskList) {
    targets.push({ label: `стол #${d.index} work`, point: deskPoint(layout, catalog, d.index, 'work') });
  }

  kitchenSeats(layout, catalog).forEach((pt, i) => {
    targets.push({ label: `кухня, место ${i}`, point: pt });
  });

  for (const total of [4, 8]) {
    for (let i = 0; i < total; i++) {
      const pt = meetingSeat(layout, catalog, i, total);
      targets.push({ label: `переговорка, ${total} уч., место ${i}`, point: pt });
    }
  }

  for (const zone of layout.zones ?? []) {
    if (zone.kind === 'entrance' && zone.at) {
      targets.push({ label: 'зона входа', point: { x: zone.at[0], y: zone.at[1] } });
    }
  }

  const rows: Row[] = targets.map(({ label, point }) => {
    // Точка места вполне может лежать на занятом тайле — сиденье это сама
    // мебель, — поэтому «достижимо» значит не «тайл свободен», а «маршрут
    // кончается в самой точке»: подошёл вплотную и сел.
    const path = findPath(p, start, point, { bestEffort: true });
    const end = path?.[path.length - 1];
    if (end && Math.hypot(end.x - point.x, end.y - point.y) < 1e-6) {
      return { label, point, reachable: true, reason: '' };
    }
    const reason = end
      ? `дошли только до (${end.x.toFixed(2)}, ${end.y.toFixed(2)}) — дальше не пускает карта`
      : 'из опенспейса нет пути вовсе';
    return { label, point, reachable: false, reason };
  });

  return { start, rows };
}

let unreachable = 0;
for (const id of LAYOUT_IDS) {
  const layout = readJson<Layout>(resolve(ROOT, `design/layouts/${id}.json`));
  const { start, rows } = checkAll(layout);
  console.log(`\n=== Раскладка «${id}» — старт (${start.x.toFixed(2)}, ${start.y.toFixed(2)}) ===`);
  const ok = rows.filter((r) => r.reachable);
  const bad = rows.filter((r) => !r.reachable);
  console.log(`Достижимо: ${ok.length}/${rows.length}`);
  for (const r of ok) {
    console.log(`  OK   ${r.label.padEnd(32)} (${r.point.x.toFixed(2)}, ${r.point.y.toFixed(2)})`);
  }
  if (bad.length > 0) {
    unreachable += bad.length;
    // Файл раскладки в начале строки — по нему пред-merge гейт называет
    // виновника в отчёте (`errorFiles` разбирает «путь(строка,колонка)»).
    console.log(`Недостижимо: ${bad.length}`);
    for (const r of bad) {
      console.error(`design/layouts/${id}.json(1,1): FAIL ${r.label} `
        + `(${r.point.x.toFixed(2)}, ${r.point.y.toFixed(2)}) — ${r.reason}`);
    }
  }
}

if (unreachable > 0) {
  console.error(`\nНедостижимых точек всего: ${unreachable}. Раскладку правили — места заперты.`);
  process.exit(1);
}
console.log('\nВсе значимые точки достижимы во всех раскладках.');

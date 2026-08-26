import {
  desks, floorTiles as sharedFloorTiles, kitchenSeats, passability, propKeys, wallTiles as sharedWallTiles,
} from '../shared/layout';
import type { Catalog, FloorTile, Layout, LayoutZone, Passability, Pos } from '../shared/layout';
import type { Desk } from '../shared/types';

/**
 * Каталог спрайтов читается прямо из design/ (как и спрайты в sprites.ts) —
 * сервер его вебу не отдаёт. Общий модуль src/shared/layout.ts считает из
 * него столы и посадочные места (docs/design/office-layout/spec.md §3, §4).
 */
const catalogModules = import.meta.glob('../../design/sprites/out/catalog.json', {
  eager: true, import: 'default',
}) as Record<string, Catalog>;
export const catalog: Catalog = Object.values(catalogModules)[0];

/**
 * Все раскладки из design/layouts — веб не знает заранее, сколько их и как
 * называются файлы, поэтому берёт глобом всё сразу и раскладывает по полю
 * `id` (оно и есть Settings.layoutId). Список для выбора в интерфейсе едет
 * от сервера отдельно (ServerEvent.layouts) — здесь только сами данные для
 * отрисовки комнаты.
 */
const layoutModules = import.meta.glob('../../design/layouts/*.json', {
  eager: true, import: 'default',
}) as Record<string, Layout>;
const LAYOUTS: Record<string, Layout> = Object.fromEntries(
  Object.values(layoutModules).map((l) => [l.id, l]),
);

export const DEFAULT_LAYOUT_ID = 'classic';

/** Раскладка по id; неизвестный (старое сохранение, рассинхрон со списком сервера) — запасной classic. */
export function layoutFor(layoutId: string): Layout {
  return LAYOUTS[layoutId] ?? LAYOUTS[DEFAULT_LAYOUT_ID];
}

/** Отступ дополнительного ряда мест кухни, если базовых из каталога не хватает. */
const ROW_GAP = 0.9;

/**
 * Шаг между свободными агентами в зоне отдыха. Больше кухонного: там места
 * заданы слотами стола и люди сидят вплотную, а здесь они стоят, и в объёме
 * фигуры с шагом в 0.9 тайла (это 0.7 м) просто пересекаются телами. В виде
 * сверху этого не было видно — спрайт занимал ровно тайл.
 */
const ZONE_GAP = 1.6;

/**
 * Высота фигуры агента: все agent_* спрайты одного размера по арту (§3.1
 * места не знают про высоту фигуры, это отрисовка Office.tsx).
 */
const AGENT_H = Math.max(
  ...Object.entries(catalog.sprites)
    .filter(([name]) => name.startsWith('agent_'))
    .map(([, sprite]) => sprite.size[1]),
);

/**
 * Запас между низом фигуры и стеной, тайлов. Комната обрезана `overflow:
 * hidden` ровно по высоте раскладки (styles.css `.office`), а место
 * указывает верхний левый угол фигуры без офсета (Office.tsx: `top:
 * px(work.y)`), поэтому нижний край уходит на seat.y + AGENT_H и может
 * вылезти за стену. Высота своя у каждой раскладки — тот же SOUTH_Y-хак
 * старого кода (desks.ts), но не в общем src/shared/layout.ts (спека §4
 * явно не пускает размеры комнаты в общий модуль), а здесь.
 */
function clampToRoom(seat: Pos, roomCells: number): Pos {
  const maxY = roomCells - AGENT_H - 0.2;
  return seat.y > maxY ? { x: seat.x, y: maxY } : seat;
}

/**
 * Добирает места кухни вторым (третьим, ...) рядом, если базовых мест из
 * слотов стола не хватает на всех: обеденный стол даёт фиксированные места
 * по слотам в каталоге, а рабочих столов в раскладке может быть больше.
 * Ряды достраиваются в ту же сторону, в которую уже «смотрит» исходный ряд
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
 * Места отдыха по зоне, когда в раскладке нет ни одного предмета с местами.
 * Так бывает не от недосмотра, а по замыслу: обстановку можно свести к
 * необходимому — рабочие столы, стол переговорки, диван, — и тогда кухонного
 * стола со слотами в комнате просто нет. Свободным агентам всё равно нужно
 * куда-то сесть, а зона `idle` уже говорит, в какой комнате они отдыхают:
 * рассаживаем их рядами по её середине, отступив от стены.
 *
 * Раскладка детерминированная и зависит только от `need` — как и у
 * `extendSeats`, место конкретного стола не прыгает между перерисовками.
 */
function zoneSeats(layout: Layout, need: number): Pos[] {
  const zone = layout.zones?.find((z) => z.kind === 'idle' && z.room);
  const room = layout.rooms?.find((r) => r.id === zone?.room);
  if (!room) return [];
  const [x0, y0, x1, y1] = room.rect;
  const perRow = Math.max(1, Math.floor((x1 - x0 - 1) / ZONE_GAP));
  const seats: Pos[] = [];
  for (let i = 0; i < need; i++) {
    seats.push({
      x: x0 + 0.8 + (i % perRow) * ZONE_GAP,
      y: y0 + (y1 - y0) * 0.5 + Math.floor(i / perRow) * ZONE_GAP,
    });
  }
  return seats;
}

/**
 * Места кухни для конкретной раскладки — на случай, если сразу все
 * исполнители окажутся свободными. Число столов исполнителей (без PM) —
 * верхняя граница штата (сервер не даёт нанять больше сотрудников, чем в
 * офисе рабочих мест), поэтому места считаются один раз от числа столов
 * раскладки, а не от текущего штата.
 *
 * Кешируется по ссылке на объект `Layout`, а не по `layoutId`: расстановку
 * рисуем по итоговому layout из снапшота (пресет с наложенным оверрайдом),
 * а не по файлу пресета, и сервер шлёт новый объект `layout` при каждой
 * правке (событие `layout`). WeakMap по ссылке инвалидируется сам — старый
 * layout просто выпадает из кеша вместе со сборкой мусора, ручного сброса
 * не нужно.
 */
const kitchenSeatsCache = new WeakMap<Layout, Pos[]>();
function kitchenSeatsFor(layout: Layout): Pos[] {
  const cached = kitchenSeatsCache.get(layout);
  if (cached) return cached;
  const need = Math.max(desks(layout, catalog).length - 1, 1);
  const fromProps = kitchenSeats(layout, catalog);
  const seats = extendSeats(
    fromProps.length > 0 ? fromProps : zoneSeats(layout, need),
    need,
  ).map((s) => clampToRoom(s, layout.size[1]));
  kitchenSeatsCache.set(layout, seats);
  return seats;
}

/**
 * Место на кухне для стола с данным индексом — привязка стабильная, один в
 * один. `null`, если сесть в раскладке негде вовсе: ни предмета с местами,
 * ни зоны отдыха. Вызывающий решает, что делать; см. `homePos` в store.ts.
 */
export function kitchenSeatFor(layout: Layout, deskIndex: number): Pos | null {
  const seats = kitchenSeatsFor(layout);
  if (seats.length === 0) return null;
  const i = (deskIndex - 1 + seats.length) % seats.length;
  return seats[i];
}

/**
 * Сетка проходимости раскладки (docs/design/office-layout/spec.md §7) — нужна
 * ходьбе по ломаной в store.ts. Кеш по ссылке на `Layout` — см. пояснение
 * у `kitchenSeatsCache` выше.
 */
const passabilityCache = new WeakMap<Layout, Passability>();
export function passabilityFor(layout: Layout): Passability {
  const cached = passabilityCache.get(layout);
  if (cached) return cached;
  const grid = passability(layout, catalog);
  passabilityCache.set(layout, grid);
  return grid;
}

// --- Планировка комнаты для отрисовки (docs/design/office-layout/spec.md §3, §5) ---
// Хотспоты пока не формализованы в src/shared/layout.ts (§8 — задача следующего
// этапа), поэтому их форма описана здесь же.
export interface LayoutHotspot { panel: 'board' | 'log'; sprite: string; at: [number, number]; key: string; title: string }
export interface RenderProp { key: string; sprite: string; x: number; y: number; scale?: number; rot?: number; z: number }
export interface WallRenderTile { key: string; sprite: string; x: number; y: number; z: number }

export function spriteSize(name: string): [number, number] {
  return catalog.sprites[name]?.size ?? [1, 1];
}

/** Порядок отрисовки мебели вместо ручных zIndex (спека §5): чем ниже нижняя кромка спрайта, тем позже рисуем. */
export function furnitureZ(x: number, y: number, sprite: string): number {
  const [, h] = spriteSize(sprite);
  return 100 + Math.round((y + h) * 10);
}

function bbox(x: number, y: number, sprite: string) {
  const [w, h] = spriteSize(sprite);
  return { x0: x, y0: y, x1: x + w, y1: y + h };
}

/**
 * Предметы, накрытые другой мебелью (кофемашина на тумбе, кружки на столе):
 * своя высота у них меньше, чем у мебели под ними, поэтому чистый y-сорт
 * задвинул бы их назад. Если bbox предмета целиком внутри чужого — рисуем
 * его следом за этим предметом, а не по формуле.
 */
function liftToppings(items: RenderProp[]): void {
  for (const item of items) {
    const ib = bbox(item.x, item.y, item.sprite);
    for (const host of items) {
      if (host === item) continue;
      const hb = bbox(host.x, host.y, host.sprite);
      const inside = ib.x0 >= hb.x0 && ib.x1 <= hb.x1 && ib.y0 >= hb.y0 && ib.y1 <= hb.y1;
      if (inside && item.z <= host.z) item.z = host.z + 1;
    }
  }
}

// Настенное — окна, доска, экран, часы (спека §5): рисуются поверх всей
// мебели и людей, стена от их положения не зависит.
const WALL_MOUNTED = new Set(['clock', 'window', 'board', 'logscreen']);
// Наложения на пол — ковры и плитка: всегда под мебелью, что на них стоит.
const FLOOR_OVERLAY = new Set(['rug', 'kitchen_tiles']);

export interface RoomData {
  layout: Layout;
  placedProps: RenderProp[];
  entrance: LayoutZone;
  hotspots: LayoutHotspot[];
  allDesks: Desk[];
  floorTiles: FloorTile[];
  wallTiles: WallRenderTile[];
  doorZ: number;
}

/**
 * Всё, что нужно Office.tsx для отрисовки конкретной раскладки: мебель по
 * z-порядку, стены/пол поштучными тайлами (если раскладка их описывает —
 * §6.1), рабочие столы и хотспоты. Кеш по ссылке на `Layout` — см. пояснение
 * у `kitchenSeatsCache` в этом же файле: комната рисуется по итоговому
 * layout из снапшота (с наложенным оверрайдом), и правка расстановки должна
 * пересчитать геометрию, а не показать старые координаты из кеша.
 *
 * `key` каждого предмета — то же стабильное имя, что и в оверрайде сервера
 * (`propKeys`, src/shared/layout.ts): им редактор расстановки помечает
 * предмет в команде `layout_edit`, и React использует его же как ключ списка.
 */
const roomCache = new WeakMap<Layout, RoomData>();
export function roomFor(layout: Layout): RoomData {
  const cached = roomCache.get(layout);
  if (cached) return cached;

  const keys = propKeys(layout);
  const fixed: RenderProp[] = [];
  const sorted: RenderProp[] = [];
  layout.props.forEach((p, i) => {
    // Предметы, у которых есть только модель, плоский рендер пропускает:
    // рисовать ему нечем. В каталоге они есть — там их габариты, след и
    // посадочные места, — но картинки у них нет и не будет.
    if (catalog.sprites[p.sprite]?.modelOnly) return;
    const item: RenderProp = {
      key: keys[i], sprite: p.sprite, x: p.at[0], y: p.at[1], scale: p.scale, rot: p.rot, z: 0,
    };
    if (WALL_MOUNTED.has(p.sprite)) fixed.push({ ...item, z: 900 });
    else if (FLOOR_OVERLAY.has(p.sprite)) fixed.push({ ...item, z: 1 });
    else sorted.push({ ...item, z: furnitureZ(item.x, item.y, item.sprite) });
  });
  liftToppings(sorted);
  const placedProps = [...fixed, ...sorted];

  const entrance = layout.zones!.find((z) => z.kind === 'entrance')!;
  const doorZ = furnitureZ(entrance.at![0], entrance.at![1], entrance.sprite!);
  const hotspots = (layout.hotspots ?? []) as LayoutHotspot[];
  const allDesks = desks(layout, catalog);
  const floorTilesList = sharedFloorTiles(layout);
  const wallTilesList: WallRenderTile[] = sharedWallTiles(layout).map((t) => {
    // Якорь спрайта — верхний левый угол; footprint стены сдвинут на 0.5
    // тайла вниз от якоря (§6.2), поэтому клетка сетки (t.x, t.y) рисуется
    // с якорем на полтайла выше. z считается той же формулой y-сортировки
    // (спека §5), что и для остальной мебели — по нижней кромке спрайта.
    const x = t.x;
    const y = t.y - 0.5;
    return { key: `wall-${t.x}-${t.y}`, sprite: t.sprite, x, y, z: furnitureZ(x, y, t.sprite) };
  });

  const data: RoomData = {
    layout, placedProps, entrance, hotspots, allDesks,
    floorTiles: floorTilesList, wallTiles: wallTilesList, doorZ,
  };
  roomCache.set(layout, data);
  return data;
}

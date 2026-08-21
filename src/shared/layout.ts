/**
 * Производные планировки офиса: считает позиции мебели и посадочных мест
 * из раскладки (`design/layouts/<id>.json`) и каталога спрайтов
 * (`design/sprites/out/catalog.json`) — docs/design/office-layout/spec.md §3, §4.
 *
 * Модуль общий для сервера и веба: без импортов из src/web, без браузерных API.
 */

import type { Desk, MeetingSeat } from './types';

export interface Pos { x: number; y: number }

/** Слот-точка: явная координата относительно якоря предмета (§3.1). */
export interface SlotPoint {
  kind: 'work' | 'plate' | 'mount' | 'seat';
  x: number;
  y: number;
}

/** Ряд мест вдоль стороны предмета — шаг считается от его размера (§3.1). */
export interface SlotSide {
  kind: 'seat';
  side: 'n' | 's' | 'e' | 'w';
  count: number;
}

/** Эллипс мест вокруг центра предмета, растущий при участниках сверх ring (§3.1). */
export interface SlotRing {
  kind: 'seat';
  ring: number;
  rx: number;
  ry: number;
  grow?: boolean;
}

export type CatalogSlot = SlotPoint | SlotSide | SlotRing;

export interface CatalogSprite {
  size: [number, number];
  footprint?: [number, number, number, number];
  layer?: string;
  slots?: CatalogSlot[];
}

export interface Catalog {
  version: number;
  tile: number;
  scale: number;
  sprites: Record<string, CatalogSprite>;
}

export interface LayoutProp {
  sprite: string;
  at: [number, number];
  id?: string;
  flip?: boolean;
  scale?: number;
}

export interface LayoutZone {
  kind: string;
  at?: [number, number];
  sprite?: string;
  title?: string;
  prop?: string;
  room?: string;
}

/** Комната — прямоугольник (углы [x0,y0,x1,y1] в тайлах) и материал пола (§3.2, §6.1). */
export interface LayoutRoom {
  id: string;
  rect: [number, number, number, number];
  floor: 'parquet' | 'carpet' | 'tile';
}

/**
 * Отрезок стены по сетке (только горизонтальный или вертикальный), толщина
 * всегда 1 тайл (§3.2). `doors` — проёмы `[смещение, длина]` от точки `a`
 * вдоль отрезка. `windows` — одиночные тайлы-окна (смещение от `a`); art
 * `wall_window` нарисован только для горизонтального ракурса (§6.2), поэтому
 * на вертикальных отрезках смещения из `windows` игнорируются.
 */
export interface LayoutWall {
  a: [number, number];
  b: [number, number];
  doors?: [number, number][];
  windows?: number[];
}

export interface Layout {
  version: number;
  id: string;
  title: string;
  size: [number, number];
  props: LayoutProp[];
  rooms?: LayoutRoom[];
  walls?: LayoutWall[];
  zones?: LayoutZone[];
  hotspots?: unknown[];
}

/** Отступ ряда мест от кромки предмета, тайлов (§3.1, по умолчанию). */
const SEAT_GAP = 0.75;

function isSide(slot: CatalogSlot): slot is SlotSide {
  return 'side' in slot;
}

function isRing(slot: CatalogSlot): slot is SlotRing {
  return 'ring' in slot;
}

function isPoint(slot: CatalogSlot): slot is SlotPoint {
  return 'x' in slot && 'y' in slot;
}

function spriteOf(catalog: Catalog, name: string): CatalogSprite | undefined {
  return catalog.sprites[name];
}

function propRef(layout: Layout, id: string): LayoutProp | undefined {
  return layout.props.find((p) => p.id === id);
}

/** Абсолютная точка слота-координаты предмета: якорь плюс смещение с учётом scale. */
function resolvePoint(prop: LayoutProp, slot: SlotPoint): Pos {
  const scale = prop.scale ?? 1;
  return { x: prop.at[0] + slot.x * scale, y: prop.at[1] + slot.y * scale };
}

/** Центр габарита предмета — якорь плюс половина размера с учётом scale. */
function propCenter(prop: LayoutProp, sprite: CatalogSprite): Pos {
  const scale = prop.scale ?? 1;
  const [w, h] = sprite.size;
  return { x: prop.at[0] + (w * scale) / 2, y: prop.at[1] + (h * scale) / 2 };
}

interface DeskProp { prop: LayoutProp; sprite: CatalogSprite }

/** Предметы с work-слотом, в порядке объявления в раскладке (§3.3). */
function deskProps(layout: Layout, catalog: Catalog): DeskProp[] {
  const found: DeskProp[] = [];
  for (const prop of layout.props) {
    const sprite = spriteOf(catalog, prop.sprite);
    const hasWork = sprite?.slots?.some((s) => s.kind === 'work');
    if (sprite && hasWork) found.push({ prop, sprite });
  }
  return found;
}

/**
 * Рабочие столы (включая стол PM) — из предметов с work-слотом, индекс по
 * порядку объявления в раскладке (§3.3). Контракт с сервером: `Desk.index`.
 */
export function desks(layout: Layout, catalog: Catalog): Desk[] {
  return deskProps(layout, catalog).map(({ prop }, index) => ({
    index, x: prop.at[0], y: prop.at[1],
  }));
}

/**
 * Стол менеджера — тот, у которого спрайт `desk_pm`; если такого нет,
 * менеджер садится за место с индексом 0 (§3.3).
 */
export function pmDeskIndex(layout: Layout, catalog: Catalog): number {
  const list = deskProps(layout, catalog);
  const i = list.findIndex(({ prop }) => prop.sprite === 'desk_pm');
  return i === -1 ? 0 : i;
}

/** Точка work (где стоит человечек) или plate (табличка с кодом задачи) у стола с данным индексом. */
export function deskPoint(layout: Layout, catalog: Catalog, deskIndex: number, kind: 'work' | 'plate'): Pos {
  const list = deskProps(layout, catalog);
  const found = list[deskIndex];
  if (!found) throw new Error(`layout: нет рабочего стола с индексом ${deskIndex}`);
  const slot = found.sprite.slots?.find((s): s is SlotPoint => isPoint(s) && s.kind === kind);
  if (!slot) throw new Error(`layout: у стола ${found.prop.sprite} нет слота ${kind}`);
  return resolvePoint(found.prop, slot);
}

/** Первый предмет в раскладке, у чьего спрайта есть ring-слот мест (переговорка). */
function findRingSeat(layout: Layout, catalog: Catalog, propId?: string) {
  const props = propId ? [propRef(layout, propId)].filter((p): p is LayoutProp => !!p) : layout.props;
  for (const prop of props) {
    const sprite = spriteOf(catalog, prop.sprite);
    const slot = sprite?.slots?.find(isRing);
    if (sprite && slot) return { prop, sprite, slot };
  }
  return undefined;
}

/**
 * Место seatIndex из total за столом переговорки: эллипс вокруг центра
 * предмета, фиксированного размера, пока участников не больше ring, дальше
 * растёт вместе с их числом (§3.1, meetingSeat()/meetingSeats.ts:22 — то же
 * поведение один в один).
 */
export function meetingSeat(
  layout: Layout, catalog: Catalog, seatIndex: number, total: number, propId?: string,
): MeetingSeat {
  const found = findRingSeat(layout, catalog, propId);
  if (!found) throw new Error('layout: в раскладке нет стола со слотом seat/ring');
  const { prop, sprite, slot } = found;
  const center = propCenter(prop, sprite);
  const n = Math.max(total, 1);
  const grow = slot.grow && n > slot.ring ? n / slot.ring : 1;
  const angle = (seatIndex / n) * Math.PI * 2 - Math.PI / 2;
  return {
    x: center.x + Math.cos(angle) * slot.rx * grow,
    y: center.y + Math.sin(angle) * slot.ry * grow,
  };
}

/** Места вдоль одной стороны предмета — шаг width/count, отступ от кромки SEAT_GAP (§3.1). */
function sideSeats(prop: LayoutProp, sprite: CatalogSprite, slot: SlotSide): Pos[] {
  const scale = prop.scale ?? 1;
  const [w, h] = sprite.size;
  const width = w * scale;
  const height = h * scale;
  const along = slot.side === 'n' || slot.side === 's' ? width : height;
  const step = along / slot.count;
  const seats: Pos[] = [];
  for (let i = 0; i < slot.count; i++) {
    const offset = (i + 0.5) * step;
    switch (slot.side) {
      case 'n': seats.push({ x: prop.at[0] + offset, y: prop.at[1] - SEAT_GAP }); break;
      case 's': seats.push({ x: prop.at[0] + offset, y: prop.at[1] + height + SEAT_GAP }); break;
      case 'w': seats.push({ x: prop.at[0] - SEAT_GAP, y: prop.at[1] + offset }); break;
      case 'e': seats.push({ x: prop.at[0] + width + SEAT_GAP, y: prop.at[1] + offset }); break;
    }
  }
  return seats;
}

/**
 * Места кухни — фиксированный список из side-слотов предмета (обеденный
 * стол), в порядке слотов в каталоге. Без propId берётся первый предмет в
 * раскладке, у чьего спрайта есть такие слоты.
 */
export function kitchenSeats(layout: Layout, catalog: Catalog, propId?: string): Pos[] {
  const props = propId ? [propRef(layout, propId)].filter((p): p is LayoutProp => !!p) : layout.props;
  for (const prop of props) {
    const sprite = spriteOf(catalog, prop.sprite);
    const sideSlots = sprite?.slots?.filter(isSide) ?? [];
    if (sideSlots.length === 0) continue;
    return sideSlots.flatMap((slot) => sideSeats(prop, sprite!, slot));
  }
  return [];
}

// ---------- Пол и стены поштучными тайлами (§6, §3.2) ----------

export interface FloorTile { x: number; y: number; sprite: string }
export interface WallTile { x: number; y: number; sprite: string }

/** Число нарисованных вариантов на материал пола — по 4 у parquet/carpet/tile (§6.1). */
const FLOOR_VARIANTS = 4;

/**
 * Детерминированный хеш координаты тайла — целочисленный, без Math.random,
 * чтобы вариант пола не «дрожал» между перерисовками (§6.1). Формула — из
 * стандартного приёма хеширования 2D-сетки (умножение на большие простые,
 * XOR координат), тут важна только детерминированность и разброс по модулю.
 */
function tileHash(x: number, y: number): number {
  const h = (x * 374761393 + y * 668265263) | 0;
  return Math.abs(h ^ (h >>> 13));
}

/**
 * Пол комнат раскладки — поштучные тайлы материала на каждую клетку
 * прямоугольника комнаты, вариант выбран детерминированно от координаты
 * (§6.1). Раскладки без `rooms` (пока это `classic`, §6.1) возвращают
 * пустой список — рендер остаётся на цельном `floor.png`.
 */
export function floorTiles(layout: Layout): FloorTile[] {
  const tiles: FloorTile[] = [];
  for (const room of layout.rooms ?? []) {
    const [x0, y0, x1, y1] = room.rect;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const variant = tileHash(x, y) % FLOOR_VARIANTS;
        tiles.push({ x, y, sprite: `floor_${room.floor}_${variant}` });
      }
    }
  }
  return tiles;
}

const WALL_N = 1;
const WALL_E = 2;
const WALL_S = 4;
const WALL_W = 8;

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Автотайлинг стен по 4-битной маске соседей (§6.2): разрывы дверей не
 * считаются соседями, поэтому клетки проёма просто не попадают в множество
 * `present`, а маска у их соседей естественно теряет соответствующий бит.
 * Края проёма на горизонтальных отрезках дополнительно помечаются
 * `wall_door_l`/`wall_door_r` (наличник), окна — `wall_window`. Оба спрайта
 * нарисованы только для горизонтального ракурса (E/W, §6.2) — на
 * вертикальных отрезках проём режет стену корректно (клетки нет в `present`,
 * ходьба и маска соседей это увидят), но без наличника: своего арта для
 * вертикального проёма пока нет (см. отчёт задачи).
 */
export function wallTiles(layout: Layout): WallTile[] {
  const walls = layout.walls ?? [];
  const present = new Set<string>();
  const doorEdge = new Map<string, 'l' | 'r'>();
  const windowCell = new Set<string>();

  for (const wall of walls) {
    const [ax, ay] = wall.a;
    const [bx, by] = wall.b;
    const horizontal = ay === by;
    const rawLen = horizontal ? bx - ax : by - ay;
    const dir = rawLen < 0 ? -1 : 1;
    const len = Math.abs(rawLen);
    const gap = new Array<boolean>(len).fill(false);
    for (const [offset, span] of wall.doors ?? []) {
      for (let i = Math.max(offset, 0); i < Math.min(offset + span, len); i++) gap[i] = true;
    }
    const cellAt = (i: number): [number, number] => (horizontal ? [ax + i * dir, ay] : [ax, ay + i * dir]);
    for (let i = 0; i < len; i++) {
      if (gap[i]) continue;
      const [x, y] = cellAt(i);
      present.add(cellKey(x, y));
    }
    if (horizontal) {
      for (const [offset, span] of wall.doors ?? []) {
        const gapXs: number[] = [];
        for (let i = Math.max(offset, 0); i < Math.min(offset + span, len); i++) gapXs.push(cellAt(i)[0]);
        if (gapXs.length === 0) continue;
        const gapMinX = Math.min(...gapXs);
        const before = offset - 1;
        const after = offset + span;
        if (before >= 0 && before < len && !gap[before]) {
          const [x, y] = cellAt(before);
          doorEdge.set(cellKey(x, y), x < gapMinX ? 'l' : 'r');
        }
        if (after < len && !gap[after]) {
          const [x, y] = cellAt(after);
          doorEdge.set(cellKey(x, y), x < gapMinX ? 'l' : 'r');
        }
      }
      for (const offset of wall.windows ?? []) {
        if (offset >= 0 && offset < len && !gap[offset]) windowCell.add(cellKey(...cellAt(offset)));
      }
    }
  }

  const tiles: WallTile[] = [];
  for (const key of present) {
    const [x, y] = key.split(',').map(Number);
    let mask = 0;
    if (present.has(cellKey(x, y - 1))) mask |= WALL_N;
    if (present.has(cellKey(x + 1, y))) mask |= WALL_E;
    if (present.has(cellKey(x, y + 1))) mask |= WALL_S;
    if (present.has(cellKey(x - 1, y))) mask |= WALL_W;
    const edge = doorEdge.get(key);
    const sprite = edge ? `wall_door_${edge}` : windowCell.has(key) ? 'wall_window' : `wall_${mask}`;
    tiles.push({ x, y, sprite });
  }
  return tiles;
}

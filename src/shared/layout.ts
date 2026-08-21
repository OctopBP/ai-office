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

export interface Layout {
  version: number;
  id: string;
  title: string;
  size: [number, number];
  props: LayoutProp[];
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

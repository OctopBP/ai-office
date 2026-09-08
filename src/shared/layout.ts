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
  /**
   * Чем на месте занимаются. Только у мест отдыха и только для оживления
   * комнаты: у приставки играют, на свободной подушке просто сидят. Пусто —
   * место без своего занятия, на нём сидят.
   */
  use?: 'sit' | 'game';
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
  /**
   * У предмета есть только модель, картинки нет и не будет. В каталоге он
   * ради габаритов, следа и посадочных мест — их читают оба рендера, — но
   * плоский офис его пропускает: рисовать ему нечем.
   */
  modelOnly?: boolean;
  footprint?: [number, number, number, number];
  /** footprint блокирует проходимость (§7) — иначе это только визуальный габарит. */
  blocks?: boolean;
  layer?: string;
  slots?: CatalogSlot[];
  /** Человекочитаемое название пресета внешности — показывается в выборе внешности роли. */
  label?: string;
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
  /**
   * Поворот предмета вокруг своей оси, градусы по часовой стрелке. Плоский
   * рендер его не знает и знать не может: развернуть спрайт вида сверху —
   * это нарисовать его заново, по кадру на сторону. Трёхмерный рендер
   * поворачивает меш одним числом, ради чего поле и заведено.
   *
   * След предмета (`footprint`, а значит и проходимость) считается **без**
   * поворота: `passability` живёт в общем модуле и обслуживает обоих
   * рендеров, а повёрнутого следа у плоского не бывает. Пока повёрнутых
   * предметов в пресетах нет, расхождения не возникает; когда редактор
   * научится поворачивать (шаг 6), след придётся поворачивать здесь же.
   */
  rot?: number;
  /**
   * Явный габарит предмета в тайлах — «этот стол 2×3» независимо от того,
   * какого разрешения картинка (§3.2). Главнее и размера из каталога, и
   * `scale`: коэффициенты растяжения по осям считаются как size / размер
   * спрайта, поэтому предмет занимает ровно заявленные тайлы — и на экране,
   * и в сетке проходимости, и в слотах (место у стола, табличка).
   */
  size?: [number, number];
}

export interface LayoutZone {
  kind: string;
  at?: [number, number];
  sprite?: string;
  title?: string;
  prop?: string;
  room?: string;
  /**
   * Ось, вдоль которой стоят собеседники у зоны `talk`: они встают по обе
   * стороны от `at` и разворачиваются друг к другу. Без оси разговор
   * пришлось бы описывать двумя точками, а это то же самое, только руками.
   */
  axis?: 'x' | 'y';
}

/** Комната — прямоугольник (углы [x0,y0,x1,y1] в тайлах) и материал пола (§3.2, §6.1). */
export interface LayoutRoom {
  id: string;
  rect: [number, number, number, number];
  /**
   * Материал пола. Три нарисованных — `parquet`, `carpet`, `tile` — есть и в
   * плоском арте (по четыре спрайта на каждый, §6.1), и в палитре 3D. Любое
   * другое имя — текстура из `design/textures/floor/<имя>.jpg`: 3D кладёт
   * её на комнату, плоский вид такого материала не знает и оставляет клетки
   * пустыми.
   */
  floor: 'parquet' | 'carpet' | 'tile' | (string & {});
  /**
   * Как комната называется для человека: подпись чипа, которым камера
   * наводится на неё (`office3d/Camera3D.tsx`). Необязательное — без него
   * подпись берётся из запасного списка по `id`, а незнакомая комната
   * называется собственным `id`.
   */
  title?: string;
}

/**
 * Отрезок стены по сетке (только горизонтальный или вертикальный), толщина
 * всегда 1 тайл (§3.2). `doors` — проёмы `[смещение, длина]` от точки `a`
 * вдоль отрезка. `windows` — одиночные тайлы-окна (смещение от `a`);
 * ориентация арта (`wall_window`/`wall_window_v`) определяется ориентацией
 * отрезка автоматически (§6.2).
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

/**
 * Правка одного предмета поверх пресета (§8). Поля необязательные: правится
 * только то, что поменяли, — сдвиг стола это `key` и `at`.
 */
export interface LayoutPropEdit {
  /** Стабильное имя предмета: `id` из пресета либо автоимя `<sprite>#<n>` (§3.2). */
  key: string;
  /** Новая позиция якоря в тайлах. */
  at?: [number, number];
  flip?: boolean;
  scale?: number;
  /** Новый поворот в градусах — см. `LayoutProp.rot`. */
  rot?: number;
  /** Новый габарит предмета в тайлах (§3.2). Перекрывает `scale`. */
  size?: [number, number];
  /** Убрать предмет из расстановки офиса. Пресет при этом не меняется. */
  removed?: boolean;
  /**
   * Спрайт добавленного предмета — того, которого в пресете нет вовсе.
   * У правки существующего предмета спрайт не меняется: это был бы другой
   * предмет с тем же именем.
   */
  sprite?: string;
}

/**
 * Оверрайд расстановки: разница между тем, что видит офис, и пресетом
 * `design/layouts/<id>.json` (§8). Хранится у офиса, файлы пресетов не
 * переписываются — иначе правка одного офиса переставляла бы мебель всем.
 */
export interface LayoutOverride {
  version: 1;
  /** По одной записи на предмет; порядок — порядок правок, на результат не влияет. */
  props: LayoutPropEdit[];
}

/** Пустой ли оверрайд — офис с таким выглядит ровно как пресет. */
export function isEmptyOverride(override: LayoutOverride | null | undefined): boolean {
  return !override || override.props.length === 0;
}

/**
 * Стабильные имена предметов раскладки, по индексам массива `props`.
 * Без явного `id` предмет получает автоимя `<sprite>#<n>`, где n — его номер
 * среди предметов того же спрайта, считая с единицы (§3.2). Имя обязано
 * зависеть только от содержимого пресета: по нему офис узнаёт свой сдвинутый
 * стол после перезапуска.
 */
export function propKeys(layout: Layout): string[] {
  const seen = new Map<string, number>();
  return layout.props.map((prop) => {
    const n = (seen.get(prop.sprite) ?? 0) + 1;
    seen.set(prop.sprite, n);
    return prop.id ?? `${prop.sprite}#${n}`;
  });
}

/**
 * Пресет с наложенным оверрайдом — то, как офис выглядит на самом деле (§8).
 *
 * Порядок предметов сохраняется, а добавленные уходят в конец: индекс
 * рабочего места — это номер стола в списке `props` (§3.3) и контракт с
 * сохранением (`PersistedInstance.deskIndex`), поэтому переставлять список
 * нельзя. Удаление предмета индексы всё-таки сдвигает — там пересадка
 * неизбежна, и она делается тем же способом, что при смене пресета.
 */
export function applyOverride(layout: Layout, override: LayoutOverride | null | undefined): Layout {
  if (isEmptyOverride(override)) return layout;
  const edits = new Map(override!.props.map((e) => [e.key, e]));
  const keys = propKeys(layout);
  const props: LayoutProp[] = [];
  for (let i = 0; i < layout.props.length; i++) {
    const edit = edits.get(keys[i]);
    edits.delete(keys[i]);
    if (edit?.removed) continue;
    props.push(edit ? editedProp(layout.props[i], edit) : layout.props[i]);
  }
  // Осталось то, чего в пресете нет: добавленные офисом предметы. Правку без
  // спрайта здесь пропускаем молча — предмет, к которому она относилась, мог
  // исчезнуть из пресета, и падать из-за этого офису незачем.
  for (const edit of edits.values()) {
    if (edit.removed || !edit.sprite || !edit.at) continue;
    props.push(editedProp({ sprite: edit.sprite, at: edit.at, id: edit.key }, edit));
  }
  return { ...layout, props };
}

function editedProp(prop: LayoutProp, edit: LayoutPropEdit): LayoutProp {
  const next: LayoutProp = { ...prop };
  if (edit.at) next.at = [edit.at[0], edit.at[1]];
  if (edit.flip !== undefined) next.flip = edit.flip;
  if (edit.rot !== undefined) next.rot = edit.rot;
  if (edit.scale !== undefined) next.scale = edit.scale;
  if (edit.size) next.size = [edit.size[0], edit.size[1]];
  return next;
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

export function spriteOf(catalog: Catalog, name: string): CatalogSprite | undefined {
  return catalog.sprites[name];
}

function propRef(layout: Layout, id: string): LayoutProp | undefined {
  return layout.props.find((p) => p.id === id);
}

/**
 * Насколько предмет растянут относительно своего арта, по каждой оси
 * отдельно (§3.2). `scale` — общий множитель, `size` — явный габарит в
 * тайлах, и он главнее: коэффициент считается от размера спрайта в
 * каталоге, поэтому «стол 2×3» занимает ровно 2×3 тайла при любом
 * разрешении картинки. Оси разные, потому что заявленный габарит не обязан
 * повторять пропорции арта.
 */
export function propScale(prop: LayoutProp, sprite?: CatalogSprite): [number, number] {
  const [bw, bh] = sprite?.size ?? [1, 1];
  if (prop.size) {
    return [bw > 0 ? prop.size[0] / bw : 1, bh > 0 ? prop.size[1] / bh : 1];
  }
  const k = prop.scale ?? 1;
  return [k, k];
}

/** Габарит предмета в тайлах — то, что реально занимает на сетке (§3.2). */
export function propSize(prop: LayoutProp, sprite?: CatalogSprite): [number, number] {
  if (prop.size) return [prop.size[0], prop.size[1]];
  const [w, h] = sprite?.size ?? [1, 1];
  const k = prop.scale ?? 1;
  return [w * k, h * k];
}

/** Абсолютная точка слота-координаты предмета: якорь плюс смещение с учётом растяжения. */
function resolvePoint(prop: LayoutProp, sprite: CatalogSprite | undefined, slot: SlotPoint): Pos {
  const [sx, sy] = propScale(prop, sprite);
  return { x: prop.at[0] + slot.x * sx, y: prop.at[1] + slot.y * sy };
}

/** Центр габарита предмета — якорь плюс половина размера. */
function propCenter(prop: LayoutProp, sprite: CatalogSprite): Pos {
  const [w, h] = propSize(prop, sprite);
  return { x: prop.at[0] + w / 2, y: prop.at[1] + h / 2 };
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
  return deskProps(layout, catalog).map(({ prop, sprite }, index) => {
    const [w, h] = propSize(prop, sprite);
    return { index, x: prop.at[0], y: prop.at[1], w, h };
  });
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

/**
 * Спрайт стола с данным индексом — `desk` или `desk_pm`.
 *
 * Нужен трёхмерному рендеру: посадка за столом описана у спрайта (на чём
 * сидят, где столешница), а стор оперирует номером стола.
 */
export function deskSprite(layout: Layout, catalog: Catalog, deskIndex: number): string | undefined {
  return deskProps(layout, catalog)[deskIndex]?.prop.sprite;
}

/** Точка work (где стоит человечек) или plate (табличка с кодом задачи) у стола с данным индексом. */
export function deskPoint(layout: Layout, catalog: Catalog, deskIndex: number, kind: 'work' | 'plate'): Pos {
  const list = deskProps(layout, catalog);
  const found = list[deskIndex];
  if (!found) throw new Error(`layout: нет рабочего стола с индексом ${deskIndex}`);
  const slot = found.sprite.slots?.find((s): s is SlotPoint => isPoint(s) && s.kind === kind);
  if (!slot) throw new Error(`layout: у стола ${found.prop.sprite} нет слота ${kind}`);
  return resolvePoint(found.prop, found.sprite, slot);
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

/** Позиции ring-слота при заданном total — та же формула, что в `meetingSeat()`. */
function ringSeatsAt(prop: LayoutProp, sprite: CatalogSprite, slot: SlotRing, total: number): Pos[] {
  const center = propCenter(prop, sprite);
  const n = Math.max(total, 1);
  const grow = slot.grow && n > slot.ring ? n / slot.ring : 1;
  const seats: Pos[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    seats.push({ x: center.x + Math.cos(angle) * slot.rx * grow, y: center.y + Math.sin(angle) * slot.ry * grow });
  }
  return seats;
}

/** Места вдоль одной стороны предмета — шаг width/count, отступ от кромки SEAT_GAP (§3.1). */
function sideSeats(prop: LayoutProp, sprite: CatalogSprite, slot: SlotSide): Pos[] {
  const [width, height] = propSize(prop, sprite);
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
 * Те же места, но одними координатами — для тех, кому назначение неважно.
 *
 * Мест бывает два вида, и оба здесь равноправны. `side` — ряд вдоль стороны
 * предмета: шаг считается от его размера, и подходит обеденному столу, за
 * который садится сколько влезет. Точечные — там, где мест ровно столько,
 * сколько их нарисовано: у дивана две подушки, и третьего на него не
 * посадишь, как ни считай шаг.
 */
/** Место отдыха: где сидеть и чем там заняты (`use` из слота, §3.1). */
export interface RestSeat {
  at: Pos;
  use?: SlotPoint['use'];
  /** Чей это предмет — по нему трёхмерный рендер находит доводку посадки. */
  sprite: string;
  /**
   * Который это по счёту seat-слот у предмета.
   *
   * Нужен доводке: поправка посадки описана у каждого места отдельно
   * (`seat.offset` в пресете), а у дивана мест три, и подушки у него разные.
   * Без номера трёхмерный рендер знал бы только «это диван» и сажал бы всех
   * троих по поправке первой подушки.
   *
   * Считается по объявлению, а не по порядку обхода ниже: ряд вдоль стороны
   * стола — это **один** слот, сколько бы мест он ни разложил, и все они
   * доводятся одной поправкой.
   */
  seat: number;
}

/**
 * Все места отдыха раскладки, по всем предметам, в порядке предметов и слотов.
 *
 * Собираются именно со всех, а не с первого попавшегося: мест для отдыха в
 * комнате бывает несколько — диван, кресло, обеденный стол, — и брать только
 * первый предмет значило бы, что второе кресло никто никогда не займёт.
 */
export function restSeats(layout: Layout, catalog: Catalog, propId?: string): RestSeat[] {
  const props = propId ? [propRef(layout, propId)].filter((p): p is LayoutProp => !!p) : layout.props;
  const seats: RestSeat[] = [];
  for (const prop of props) {
    const sprite = spriteOf(catalog, prop.sprite);
    const slots = sprite?.slots ?? [];
    // Номер места — по объявлению у предмета, а не по порядку обхода: обход
    // идёт двумя проходами (сперва ряды, потом точки), и его порядок к
    // данным отношения не имеет.
    const seatSlots = slots.filter((s) => s.kind === 'seat');
    for (const slot of slots.filter(isSide)) {
      for (const at of sideSeats(prop, sprite!, slot)) {
        seats.push({ at, sprite: prop.sprite, seat: seatSlots.indexOf(slot) });
      }
    }
    for (const slot of slots) {
      if (!isPoint(slot) || slot.kind !== 'seat') continue;
      seats.push({
        at: resolvePoint(prop, sprite, slot),
        use: slot.use,
        sprite: prop.sprite,
        seat: seatSlots.indexOf(slot),
      });
    }
  }
  return seats;
}

export function kitchenSeats(layout: Layout, catalog: Catalog, propId?: string): Pos[] {
  return restSeats(layout, catalog, propId).map((s) => s.at);
}

/** Насколько собеседники расходятся от центра зоны разговора, тайлы. */
const TALK_GAP = 0.75;

/** Место в разговоре: куда встать и куда смотреть (радианы вокруг вертикали). */
export interface TalkSeat { at: Pos; yaw: number }

/**
 * Два места зоны `talk`: собеседники стоят по обе стороны от `at` вдоль
 * `axis` и смотрят друг на друга — поворот это направление на соседа, а не
 * на комнату.
 *
 * Каждое место прилипает к ближайшей целой клетке. Стоящий агент — это
 * фигура на клетке, как и все точки, куда офис его водит; дробная координата
 * (`at` ± 0.75) ставила его на стык двух клеток, и пара разговаривала,
 * стоя между плитками пола. Разброс `TALK_GAP` при этом остаётся смыслом,
 * а не точной координатой: центр на целой клетке даёт собеседникам клетку
 * между ними, центр на стыке (x.5) — соседние клетки.
 */
export function talkSeats(zone: LayoutZone): TalkSeat[] {
  if (zone.kind !== 'talk' || !zone.at) return [];
  const [x, y] = zone.at;
  const cell = (v: number): number => Math.round(v);
  return (zone.axis ?? 'x') === 'x'
    ? [
      { at: { x: cell(x - TALK_GAP), y: cell(y) }, yaw: Math.PI / 2 },
      { at: { x: cell(x + TALK_GAP), y: cell(y) }, yaw: -Math.PI / 2 },
    ]
    : [
      { at: { x: cell(x), y: cell(y - TALK_GAP) }, yaw: 0 },
      { at: { x: cell(x), y: cell(y + TALK_GAP) }, yaw: Math.PI },
    ];
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
 * Края проёма дополнительно помечаются наличником: на горизонтальном
 * отрезке — `wall_door_l`/`wall_door_r`, на вертикальном — `wall_door_t`
 * (верхний край, стена продолжается на север) / `wall_door_b` (нижний край,
 * стена продолжается на юг). Окна — `wall_window` на горизонтальном отрезке,
 * `wall_window_v` на вертикальном.
 */
interface WallGeometry {
  present: Set<string>;
  doorEdge: Map<string, 'l' | 'r' | 't' | 'b'>;
  windowOrient: Map<string, 'h' | 'v'>;
}

/**
 * Геометрия стен раскладки без проёмов дверей — общая для рендера
 * (`wallTiles`) и сетки проходимости (`passability`, §7): разрывы дверей не
 * попадают в `present`, поэтому оба потребителя видят один и тот же проход.
 */
function wallGeometry(layout: Layout): WallGeometry {
  const walls = layout.walls ?? [];
  const present = new Set<string>();
  const doorEdge = new Map<string, 'l' | 'r' | 't' | 'b'>();
  const windowOrient = new Map<string, 'h' | 'v'>();

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
    const alongCoord = (i: number): number => (horizontal ? cellAt(i)[0] : cellAt(i)[1]);
    for (let i = 0; i < len; i++) {
      if (gap[i]) continue;
      const [x, y] = cellAt(i);
      present.add(cellKey(x, y));
    }
    for (const [offset, span] of wall.doors ?? []) {
      const gapCoords: number[] = [];
      for (let i = Math.max(offset, 0); i < Math.min(offset + span, len); i++) gapCoords.push(alongCoord(i));
      if (gapCoords.length === 0) continue;
      const gapMin = Math.min(...gapCoords);
      const before = offset - 1;
      const after = offset + span;
      const edgeFor = (i: number): 'l' | 'r' | 't' | 'b' => {
        const near = alongCoord(i) < gapMin;
        return horizontal ? (near ? 'l' : 'r') : (near ? 't' : 'b');
      };
      if (before >= 0 && before < len && !gap[before]) {
        const [x, y] = cellAt(before);
        doorEdge.set(cellKey(x, y), edgeFor(before));
      }
      if (after < len && !gap[after]) {
        const [x, y] = cellAt(after);
        doorEdge.set(cellKey(x, y), edgeFor(after));
      }
    }
    for (const offset of wall.windows ?? []) {
      if (offset >= 0 && offset < len && !gap[offset]) {
        windowOrient.set(cellKey(...cellAt(offset)), horizontal ? 'h' : 'v');
      }
    }
  }

  return { present, doorEdge, windowOrient };
}

export function wallTiles(layout: Layout): WallTile[] {
  const { present, doorEdge, windowOrient } = wallGeometry(layout);
  const tiles: WallTile[] = [];
  for (const key of present) {
    const [x, y] = key.split(',').map(Number);
    let mask = 0;
    if (present.has(cellKey(x, y - 1))) mask |= WALL_N;
    if (present.has(cellKey(x + 1, y))) mask |= WALL_E;
    if (present.has(cellKey(x, y + 1))) mask |= WALL_S;
    if (present.has(cellKey(x - 1, y))) mask |= WALL_W;
    const edge = doorEdge.get(key);
    const orient = windowOrient.get(key);
    const sprite = edge
      ? `wall_door_${edge}`
      : orient
        ? (orient === 'v' ? 'wall_window_v' : 'wall_window')
        : `wall_${mask}`;
    tiles.push({ x, y, sprite });
  }
  return tiles;
}

// ---------- Проходимость (§7) ----------

/** Сетка проходимости раскладки: cols×rows, построчно; 1 в `blocked` — тайл занят. */
export interface Passability {
  cols: number;
  rows: number;
  blocked: Uint8Array;
}

function cellIndex(p: Passability, x: number, y: number): number {
  return y * p.cols + x;
}

/** Тайл вне сетки или помеченный непроходимым (стена, крупная мебель). */
export function isBlocked(p: Passability, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= p.cols || y >= p.rows) return true;
  return p.blocked[cellIndex(p, x, y)] === 1;
}

/**
 * Клетки, которые занимает след предмета по одной оси: от `from` длиной `len`.
 *
 * След округляется до целых тайлов, а не занимает тайл по касанию
 * (docs/design/office-units/spec.md §4: «след — целые тайлы»). Пока пресеты
 * не переехали на целые числа, округление и есть способ выполнить это правило:
 * захват по касанию отбирает у комнаты лишний ряд клеток на каждый предмет —
 * стол глубиной 2.4 тайла занимал три ряда, а не два, и рабочее место соседа
 * снизу оказывалось внутри чужого следа, куда не подойти.
 *
 * Меньше одного тайла след не бывает: мелкий предмет (горшок, торшер) иначе
 * округлился бы в ноль и перестал мешать вовсе.
 */
function tileSpan(from: number, len: number): [number, number] {
  const a = Math.round(from);
  return [a, Math.max(Math.round(from + len), a + 1)];
}

/**
 * Сетка проходимости раскладки (§7): непроходимы тайлы стен (те же, что рисует
 * `wallTiles` — проёмы дверей в `present` не попадают, поэтому там, где стена
 * разорвана, клетка остаётся свободной) плюс footprint мебели, помеченной
 * `blocks` в каталоге. Если у такого спрайта нет `footprint`, занятой считается
 * вся его площадь `size`.
 *
 * И больше ничего. Раньше следом шёл проход, расчищавший клетки всех слотов —
 * чтобы агент «мог встать на своё место»: рабочая точка стола, подушка дивана,
 * места вокруг стола переговорки при всех мыслимых числах участников. Расчистка
 * решала не ту задачу. Место человека — это не проходимая клетка, а точка,
 * **к которой подходят**: подушка дивана лежит на самом диване, и она обязана
 * оставаться занятой, иначе через диван пройдёт кратчайший путь. Куда встать,
 * чтобы сесть, теперь считает `nearestFree` в момент поиска пути, а последний
 * короткий отрезок с этой клетки на саму точку — это и есть «сел».
 *
 * Расчистка же оставляла в мебели сквозные дыры: клетка под табличкой с кодом
 * задачи (`plate`) лежит посреди столешницы, и путь через стол был по карте
 * законным.
 */
export function passability(layout: Layout, catalog: Catalog): Passability {
  const [cols, rows] = layout.size;
  const blocked = new Uint8Array(cols * rows);
  const p: Passability = { cols, rows, blocked };
  const mark = (x: number, y: number, value: 0 | 1) => {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return;
    blocked[cellIndex(p, cx, cy)] = value;
  };

  const { present } = wallGeometry(layout);
  for (const key of present) {
    const [x, y] = key.split(',').map(Number);
    mark(x, y, 1);
  }

  for (const prop of layout.props) {
    const sprite = spriteOf(catalog, prop.sprite);
    if (!sprite?.blocks) continue;
    const [sx, sy] = propScale(prop, sprite);
    const [fx, fy, fw, fh] = sprite.footprint ?? [0, 0, sprite.size[0], sprite.size[1]];
    const [x0, x1] = tileSpan(prop.at[0] + fx * sx, fw * sx);
    const [y0, y1] = tileSpan(prop.at[1] + fy * sy, fh * sy);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) mark(x, y, 1);
    }
  }

  return p;
}

// ---------- Поиск пути A* (§7) ----------

/** Ортогональный шаг стоит 1, диагональный — √2 (единицы — тайлы). */
const STEP_ORTHO = 1;
const STEP_DIAGONAL = Math.SQRT2;

/**
 * Надбавка за смену направления — меньше разницы между любыми двумя ценами
 * шага, поэтому длину кратчайшего пути она не меняет, а из одинаково коротких
 * выбирает тот, где меньше поворотов. Без неё A* на пустом полу выдаёт
 * лесенку «вправо-вниз-вправо-вниз» той же длины, что и честная диагональ, и
 * агент идёт по ней зигзагом.
 */
const TURN_PENALTY = 1e-3;

/** 8 направлений соседей: [dx, dy, цена шага]. */
const NEIGHBORS: [number, number, number][] = [
  [1, 0, STEP_ORTHO], [-1, 0, STEP_ORTHO], [0, 1, STEP_ORTHO], [0, -1, STEP_ORTHO],
  [1, 1, STEP_DIAGONAL], [1, -1, STEP_DIAGONAL], [-1, 1, STEP_DIAGONAL], [-1, -1, STEP_DIAGONAL],
];

/** Октильная эвристика — согласована с ценой диагонали, не переоценивает путь. */
function octileHeuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (STEP_DIAGONAL - 1) * Math.min(dx, dy);
}

/**
 * Докуда ищется свободная клетка взамен занятой, тайлы.
 *
 * Четыре — это ширина самого крупного предмета в раскладках: с любой точки
 * внутри его следа выход наружу находится. Больше брать незачем: если
 * свободного тайла нет и в этом кольце, дело не в том, что человек стоит на
 * стуле, а в том, что раскладка непроходима, и честнее это увидеть.
 */
const SNAP_RADIUS = 4;

/**
 * Ближайшая свободная клетка к заданной — кольцами по возрастанию радиуса, в
 * кольце по настоящему расстоянию. Нужна на обоих концах пути: место человека
 * бывает описано точкой, которая попала на занятый тайл (сиденье кресла — это
 * само кресло), а сам он бывает застигнут стоящим на такой же.
 *
 * `null` — свободных клеток нет во всей округе.
 */
export function nearestFree(p: Passability, x: number, y: number, radius = SNAP_RADIUS): Pos | null {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (!isBlocked(p, cx, cy)) return { x: cx, y: cy };
  for (let r = 1; r <= radius; r++) {
    let best: Pos | null = null;
    let bestDist = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (isBlocked(p, nx, ny)) continue;
        // Считаем от исходной точки, а не от центра клетки: точка места лежит
        // внутри тайла не по центру, и ближайший к ней выход — не всегда
        // ближайший к центру.
        const dist = Math.hypot(nx + 0.5 - x, ny + 0.5 - y);
        if (dist < bestDist) { bestDist = dist; best = { x: nx, y: ny }; }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Клетка, с которой подходят к месту на занятом тайле (сиденье — это сама
 * мебель). Годятся только те, откуда последний шаг пересекает ровно две
 * клетки: свою и клетку места. Поэтому сперва четыре ортогональных соседа, и
 * лишь потом диагональные — те из них, у которых свободны оба ортогональных
 * companion'а угла (то же правило, по которому A* не пускает диагональ сквозь
 * угол: иначе шаг наискось прошёл бы по третьей, занятой клетке).
 */
function approachCell(p: Passability, goal: Pos): Pos | null {
  const gx = Math.floor(goal.x);
  const gy = Math.floor(goal.y);
  let best: Pos | null = null;
  let bestScore = Infinity;
  for (const [dx, dy] of NEIGHBORS) {
    const nx = gx + dx;
    const ny = gy + dy;
    if (isBlocked(p, nx, ny)) continue;
    const diagonal = dx !== 0 && dy !== 0;
    if (diagonal && (isBlocked(p, gx + dx, gy) || isBlocked(p, gx, gy + dy))) continue;
    // Ортогональные соседи всегда предпочтительнее диагональных при прочих
    // равных: с них подход короче и заведомо не задевает угла.
    const score = Math.hypot(nx + 0.5 - goal.x, ny + 0.5 - goal.y) + (diagonal ? 0.5 : 0);
    if (score < bestScore) { bestScore = score; best = { x: nx, y: ny }; }
  }
  return best;
}

/** Направление шага как одно число — чтобы сравнивать «тот же поворот или нет». */
function dirCode(dx: number, dy: number): number {
  return (dx + 1) * 3 + (dy + 1);
}

export interface PathOptions {
  /**
   * Цель занята или недостижима — вести как можно ближе к ней, а не
   * отказываться. Так ходят агенты: не дойти до места — это остановиться
   * рядом, а не пройти сквозь стену и не остаться на месте навсегда.
   * Без флага (диагностика, проверки раскладки) недостижимость — это `null`.
   */
  bestEffort?: boolean;
}

/**
 * Путь по клеткам от старта к цели — цепочка индексов, восстановленная по
 * `cameFrom`.
 */
function reconstructCells(cameFrom: Map<number, number>, cols: number, endIdx: number): Pos[] {
  const path: Pos[] = [];
  let idx: number | undefined = endIdx;
  while (idx !== undefined) {
    path.push({ x: idx % cols, y: Math.floor(idx / cols) });
    idx = cameFrom.get(idx);
  }
  path.reverse();
  return path;
}

/**
 * Выкидывает клетки в середине прямого отрезка: три подряд идущие клетки с
 * одним и тем же направлением шага — это одна прямая, и промежуточная точка
 * на ней ничего не добавляет. Геометрия пути при этом не меняется ни на
 * тайл — в отличие от прежнего «протягивания», которое спрямляло путь
 * поверх карты и умело срезать угол вплотную к кромке предмета.
 */
function mergeCollinear(cells: Pos[]): Pos[] {
  if (cells.length <= 2) return cells;
  const out: Pos[] = [cells[0]];
  for (let i = 1; i < cells.length - 1; i++) {
    const prev = cells[i - 1];
    const cur = cells[i];
    const next = cells[i + 1];
    if (cur.x - prev.x === next.x - cur.x && cur.y - prev.y === next.y - cur.y) continue;
    out.push(cur);
  }
  out.push(cells[cells.length - 1]);
  return out;
}

/** Две точки пути ближе этого считаются одной — ломаная не должна топтаться. */
const PATH_EPS = 1e-3;

function samePoint(a: Pos, b: Pos): boolean {
  return Math.abs(a.x - b.x) < PATH_EPS && Math.abs(a.y - b.y) < PATH_EPS;
}

/** Лежит ли точка в этой клетке. */
function inCell(pt: Pos, cell: Pos): boolean {
  return Math.floor(pt.x) === cell.x && Math.floor(pt.y) === cell.y;
}

/**
 * Ломаная в мировых координатах по цепочке клеток: точный старт, центры
 * клеток между ними, точная цель.
 *
 * Центр крайней клетки выкидывается, если конец пути и так лежит внутри
 * неё, — иначе заход в центр выглядел бы шагом назад перед выходом и шагом
 * назад перед посадкой. Срезать при этом нечего: две соседние клетки цепочки
 * свободны обе, а у диагонального шага A* дополнительно требует свободными
 * обоих ортогональных соседей, — отрезок из любой точки одной клетки в центр
 * соседней не выходит за пределы этих четырёх.
 *
 * Если же конец лежит **вне** крайней клетки (место оказалось на занятом
 * тайле — сиденье кресла это само кресло), её центр остаётся: с него агент и
 * делает последний короткий шаг на место. Выкинуть его значило бы соединить
 * прямой две точки через полкомнаты.
 */
function toWorldPath(cells: Pos[], start: Pos, goal: Pos): Pos[] {
  const merged = mergeCollinear(cells);
  const last = merged.length - 1;
  const points: Pos[] = [{ ...start }];
  for (let i = 0; i < merged.length; i++) {
    if (i === 0 && inCell(start, merged[0])) continue;
    if (i === last && inCell(goal, merged[last])) continue;
    points.push({ x: merged[i].x + 0.5, y: merged[i].y + 0.5 });
  }
  points.push({ ...goal });
  return points.filter((pt, i) => i === 0 || !samePoint(pt, points[i - 1]));
}

/**
 * Поиск пути A* по сетке проходимости (§7): 8 направлений, диагональ дороже
 * ортогонали (√2), диагональ запрещена, если хотя бы один из двух
 * ортогональных соседей угла занят, — иначе путь срезал бы угол сквозь стену
 * вплотную к её кромке. Из одинаково коротких путей выбирается тот, где
 * меньше поворотов (`TURN_PENALTY`).
 *
 * Возвращается ломаная в мировых координатах: концы — ровно переданные
 * `start`/`goal`, между ними центры клеток. Путь никуда не спрямляется:
 * агент идёт ровно по карте, а по диагонали — только там, где по карте
 * диагональ есть.
 *
 * Без `bestEffort` поведение прежнее и строгое: занятый старт или цель, а
 * равно недостижимая цель — это `null`. С `bestEffort` занятые концы
 * подменяются ближайшей свободной клеткой (`nearestFree`), а недостижимая
 * цель — ближайшей к ней разведанной: агент подходит настолько, насколько
 * пускает карта. Сквозь стены он не идёт ни в каком случае.
 */
export function findPath(p: Passability, start: Pos, goal: Pos, opts?: PathOptions): Pos[] | null {
  const bestEffort = opts?.bestEffort ?? false;

  let sx = Math.floor(start.x);
  let sy = Math.floor(start.y);
  let gx = Math.floor(goal.x);
  let gy = Math.floor(goal.y);

  if (isBlocked(p, sx, sy)) {
    if (!bestEffort) return null;
    const free = nearestFree(p, start.x, start.y);
    if (!free) return null;
    sx = free.x; sy = free.y;
  }
  /**
   * Цель на занятом тайле — это место на самой мебели: подушка дивана, кресло,
   * стул у стола. Подходить к нему надо с **соседней** клетки: последний шаг
   * тогда пересекает только её и клетку места, а не всё, что между. Соседней
   * свободной нет — значит, сесть некуда: доводим до ближайшей свободной и
   * там останавливаемся, а не проезжаем сквозь мебель к точке внутри неё.
   */
  let finish: Pos = goal;
  if (isBlocked(p, gx, gy)) {
    if (!bestEffort) return null;
    const beside = approachCell(p, goal);
    const free = beside ?? nearestFree(p, goal.x, goal.y);
    if (!free) return null;
    gx = free.x; gy = free.y;
    if (!beside) finish = { x: free.x + 0.5, y: free.y + 0.5 };
  }

  if (sx === gx && sy === gy) {
    const direct = [{ ...start }, { ...finish }];
    return samePoint(direct[0], direct[1]) ? [direct[0]] : direct;
  }

  const startIdx = cellIndex(p, sx, sy);
  const goalIdx = cellIndex(p, gx, gy);

  const gScore = new Map<number, number>([[startIdx, 0]]);
  const cameFrom = new Map<number, number>();
  const dirFrom = new Map<number, number>();
  const open = new Map<number, number>([[startIdx, octileHeuristic(sx, sy, gx, gy)]]);
  const closed = new Set<number>();

  /** Ближайшая к цели разведанная клетка — запасной финиш для `bestEffort`. */
  let nearestIdx = startIdx;
  let nearestH = octileHeuristic(sx, sy, gx, gy);

  while (open.size > 0) {
    let currentIdx = -1;
    let bestF = Infinity;
    for (const [idx, f] of open) {
      if (f < bestF) { bestF = f; currentIdx = idx; }
    }
    if (currentIdx === goalIdx) {
      return toWorldPath(reconstructCells(cameFrom, p.cols, currentIdx), start, finish);
    }
    open.delete(currentIdx);
    closed.add(currentIdx);
    const cx = currentIdx % p.cols;
    const cy = Math.floor(currentIdx / p.cols);
    const currentG = gScore.get(currentIdx)!;
    const currentDir = dirFrom.get(currentIdx);

    const h = octileHeuristic(cx, cy, gx, gy);
    if (h < nearestH) { nearestH = h; nearestIdx = currentIdx; }

    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (isBlocked(p, nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (isBlocked(p, cx + dx, cy) || isBlocked(p, cx, cy + dy))) continue;
      const nIdx = cellIndex(p, nx, ny);
      if (closed.has(nIdx)) continue;
      const dir = dirCode(dx, dy);
      const tentativeG = currentG + cost
        + (currentDir !== undefined && currentDir !== dir ? TURN_PENALTY : 0);
      if (tentativeG < (gScore.get(nIdx) ?? Infinity)) {
        cameFrom.set(nIdx, currentIdx);
        dirFrom.set(nIdx, dir);
        gScore.set(nIdx, tentativeG);
        open.set(nIdx, tentativeG + octileHeuristic(nx, ny, gx, gy));
      }
    }
  }

  if (!bestEffort) return null;
  // Цель за стеной или в отрезанной комнате: доводим до ближайшей к ней
  // клетки, до которой дорога есть. Конец ломаной — её центр, а не сама
  // цель: туда пути нет, и делать вид, что есть, незачем.
  if (nearestIdx === startIdx) return [{ ...start }];
  const cells = reconstructCells(cameFrom, p.cols, nearestIdx);
  const last = cells[cells.length - 1];
  return toWorldPath(cells, start, { x: last.x + 0.5, y: last.y + 0.5 });
}

/**
 * Свободная клетка рядом с точкой, но не та, в которой точка лежит, — место,
 * с которого к ней подходят. По ней менеджер встаёт у чужого стола: вставать
 * в саму рабочую точку значило бы влезть в человека, за ней сидящего.
 */
export function adjacentFree(p: Passability, at: Pos): Pos | null {
  const cx = Math.floor(at.x);
  const cy = Math.floor(at.y);
  let best: Pos | null = null;
  let bestDist = Infinity;
  for (const [dx, dy] of NEIGHBORS) {
    const nx = cx + dx;
    const ny = cy + dy;
    if (isBlocked(p, nx, ny)) continue;
    if (dx !== 0 && dy !== 0 && (isBlocked(p, cx + dx, cy) || isBlocked(p, cx, cy + dy))) continue;
    const dist = Math.hypot(nx + 0.5 - at.x, ny + 0.5 - at.y);
    if (dist < bestDist) { bestDist = dist; best = { x: nx + 0.5, y: ny + 0.5 }; }
  }
  return best;
}

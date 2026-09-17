/**
 * Производные планировки офиса: считает позиции мебели и посадочных мест
 * из раскладки (`design/layouts/<id>.json`) и каталога спрайтов
 * (`design/sprites/out/catalog.json`) — docs/design/office-layout/spec.md §3, §4.
 *
 * Модуль общий для сервера и веба: без импортов из src/web, без браузерных API.
 */

import type { Desk, MeetingSeat } from './types';

export interface Pos { x: number; y: number }

/** Сторона клетки или предмета: север — меньший `y`, юг — больший. */
export type Side = 'n' | 's' | 'e' | 'w';

/**
 * С каких сторон заходят на место.
 *
 * Место человека почти всегда лежит на самом предмете: подушка дивана — это
 * диван, стул у стола — это клетка перед столом. Клетка занята, и вопрос «как
 * туда попасть» карта проходимости сама не решает: без входов агент заходил на
 * подушку с любой стороны, до которой дотягивалась соседняя свободная клетка,
 * — в том числе из-за спинки и через подлокотник.
 *
 * Стороны записаны у предмета в его собственных координатах и поворот не
 * учитывают — ровно как `footprint` (см. `LayoutProp.rot`): повёрнутых
 * предметов в раскладках пока нет, а когда появятся, поворачивать придётся и
 * след, и входы, и в одном месте.
 */
export type Approach = Side[];

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
  /** С каких сторон на это место заходят и с каких уходят. Пусто — с любой. */
  approach?: Approach;
}

/** Ряд мест вдоль стороны предмета — шаг считается от его размера (§3.1). */
export interface SlotSide {
  kind: 'seat';
  side: Side;
  count: number;
  /** Пусто — с любой стороны, кроме противоположной: сквозь стол не садятся. */
  approach?: Approach;
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

/**
 * Где у фигуры ноги относительно её якоря, тайлы.
 *
 * Спрайт человечка в раскладке ставится левым верхним углом (`pos` и слоты
 * `work` — это его координаты), а модель стоит ногами: по горизонтали ноги
 * приходятся на середину спрайта шириной в тайл.
 *
 * По вертикали смещение меньше высоты спрайта (1.5), и намеренно. В виде
 * сверху нижняя часть фигуры честно заезжала на стол — так и рисуют человека
 * за рабочим местом, стол просто закрывает его снизу. В объёме такой наезд
 * превращается в тело внутри столешницы, поэтому ноги ставятся туда, где у
 * плоского спрайта примерно пояс: фигура оказывается вплотную к столу, но
 * снаружи него.
 *
 * Живёт здесь, а не в рендере, потому что обратная задача — «поставить
 * фигуру на такую-то клетку» — решается в раскладке (`standingAt`), и оба
 * конца должны считать одно и то же число.
 */
export const FOOT_DX = 0.5;
export const FOOT_DY = 1.05;

/**
 * Якорь фигуры, стоящей посреди клетки `(cx, cy)`: ноги — в её центре.
 *
 * Целый якорь этого не даёт: по вертикали ноги уходят на `FOOT_DY` вниз и
 * встают ровно на линию сетки между строками — так собеседники и стояли
 * «между двух клеток». Всем стоячим местам (разговоры, стоящие без занятия)
 * якорь считается отсюда.
 */
export function standingAt(cx: number, cy: number): Pos {
  return { x: cx + 0.5 - FOOT_DX, y: cy + 0.5 - FOOT_DY };
}

/**
 * Обратное к `standingAt`: клетка, в которой стоит фигура с якорем `at`.
 *
 * Это и есть та клетка, которую занимает человек, и единственная, о которой
 * имеет смысл спрашивать карту проходимости. Якорь — левый верхний угол
 * спрайта, он висит в воздухе выше и левее ног; клетка якоря и клетка ног у
 * одного и того же человека разные — по вертикали ровно на строку.
 *
 * Пока поиск пути считал по якорю, вся ходьба была сдвинута на эту строку:
 * маршрут обходил препятствия, которых на пути ног не было, и шёл сквозь те,
 * что были, — агенты проходили по стене, стоящей строкой ниже нарисованного
 * маршрута.
 */
export function walkerCell(at: Pos): Pos {
  return { x: Math.floor(at.x + FOOT_DX), y: Math.floor(at.y + FOOT_DY) };
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
 * Каждое место — ближайшая целая клетка, и фигура стоит в её центре
 * (`standingAt`). Дробная координата (`at` ± 0.75) ставила собеседника на
 * стык двух клеток, и пара разговаривала, стоя между плитками пола. Разброс
 * `TALK_GAP` при этом остаётся смыслом, а не точной координатой: центр на
 * целой клетке даёт собеседникам клетку между ними, центр на стыке (x.5) —
 * соседние клетки.
 */
export function talkSeats(zone: LayoutZone): TalkSeat[] {
  if (zone.kind !== 'talk' || !zone.at) return [];
  const [x, y] = zone.at;
  const cell = (v: number): number => Math.round(v);
  return (zone.axis ?? 'x') === 'x'
    ? [
      { at: standingAt(cell(x - TALK_GAP), cell(y)), yaw: Math.PI / 2 },
      { at: standingAt(cell(x + TALK_GAP), cell(y)), yaw: -Math.PI / 2 },
    ]
    : [
      { at: standingAt(cell(x), cell(y - TALK_GAP)), yaw: 0 },
      { at: standingAt(cell(x), cell(y + TALK_GAP)), yaw: Math.PI },
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

/** Стороны клетки как биты — маска входов помещается в одно число. */
export const SIDE_BIT: Record<Side, number> = { n: 1, s: 2, w: 4, e: 8 };
const ALL_SIDES = SIDE_BIT.n | SIDE_BIT.s | SIDE_BIT.w | SIDE_BIT.e;

/** Противоположная сторона: выходя из клетки на север, входишь в соседнюю с юга. */
const OPPOSITE_BIT: Record<number, number> = {
  [SIDE_BIT.n]: SIDE_BIT.s, [SIDE_BIT.s]: SIDE_BIT.n,
  [SIDE_BIT.w]: SIDE_BIT.e, [SIDE_BIT.e]: SIDE_BIT.w,
};

/**
 * Клетка с объявленными входами: маска разрешённых сторон и номер предмета,
 * которому она принадлежит.
 *
 * Предмет нужен, чтобы отличить «зайти на диван» от «переползти по дивану на
 * соседнюю подушку». Первое разрешено только с объявленной стороны, второе —
 * всегда: три подушки одного дивана это одно место для сидения, и если
 * журнальный столик занял проход перед двумя из них, человек заходит со
 * свободного края и садится, куда собирался, а не встаёт рядом с диваном.
 */
export interface CellEntry {
  /** Биты сторон (`SIDE_BIT`), с которых можно войти и на которые выйти. */
  sides: number;
  /** Номер предмета в `layout.props` — общий у всех клеток одного предмета. */
  prop: number;
}

/** Сетка проходимости раскладки: cols×rows, построчно; 1 в `blocked` — тайл занят. */
export interface Passability {
  cols: number;
  rows: number;
  blocked: Uint8Array;
  /**
   * Клетки мест (подушка дивана, стул у стола) — по индексу клетки. Всё, что
   * сюда не попало, обычная клетка: свободна — иди, занята — обходи.
   */
  entries: Map<number, CellEntry>;
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
 * Клетка — место (подушка дивана, стул у стола). На ней не стоят, к ней
 * подходят: стоячее занятие на такой клетке поставило бы человека в чужое
 * кресло.
 */
export function isEntry(p: Passability, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= p.cols || y >= p.rows) return false;
  return p.entries.has(cellIndex(p, x, y));
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
  const p: Passability = { cols, rows, blocked, entries: new Map() };
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

  layout.props.forEach((prop, index) => markEntries(p, prop, index, spriteOf(catalog, prop.sprite)));

  return p;
}

/** Маска сторон слота: пусто — вход с любой стороны. */
function sidesMask(approach: Approach | undefined, fallback = ALL_SIDES): number {
  if (!approach || approach.length === 0) return fallback;
  return approach.reduce((mask, side) => mask | SIDE_BIT[side], 0);
}

/**
 * Клетки мест предмета и стороны, с которых на них заходят.
 *
 * Клетка места считается **по ногам** (`walkerCell`): точка места — это якорь
 * фигуры, а занимает человек ту клетку, где стоит, — она и есть вход.
 *
 * Ряд мест вдоль стороны (обеденный стол) по умолчанию заходится с любой
 * стороны, кроме противоположной: сквозь стол не садятся. У точечных мест
 * умолчания нет — не объявлено, значит, заходят откуда угодно, как было до
 * появления входов.
 */
function markEntries(
  p: Passability, prop: LayoutProp, index: number, sprite: CatalogSprite | undefined,
): void {
  const put = (at: Pos, sides: number) => {
    const { x, y } = walkerCell(at);
    if (x < 0 || y < 0 || x >= p.cols || y >= p.rows) return;
    const idx = cellIndex(p, x, y);
    const was = p.entries.get(idx);
    // Две подушки в одной клетке (мелкий предмет, крупный тайл) — стороны
    // складываются: место одно, входов у него столько, сколько объявлено.
    p.entries.set(idx, { sides: was ? was.sides | sides : sides, prop: was?.prop ?? index });
  };

  for (const slot of sprite?.slots ?? []) {
    if (isSide(slot)) {
      // Умолчание ряда — «с любой стороны, кроме самого предмета»: за
      // северный край стола садятся хоть с севера, хоть сбоку, но не сквозь
      // стол. Той же меркой мерится рабочее место у стола (`approach` в
      // пресете `desk`), и это одно и то же правило, а не совпадение.
      const sides = sidesMask(slot.approach, ALL_SIDES & ~OPPOSITE_BIT[SIDE_BIT[slot.side]]);
      for (const at of sideSeats(prop, sprite!, slot)) put(at, sides);
    } else if (isPoint(slot) && (slot.kind === 'seat' || slot.kind === 'work')) {
      if (!slot.approach || slot.approach.length === 0) continue;
      put(resolvePoint(prop, sprite, slot), sidesMask(slot.approach));
    }
  }
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
 * Ближайшая свободная клетка к заданной точке — кольцами по возрастанию
 * радиуса, в кольце по настоящему расстоянию. Точка считается по ногам
 * (`walkerCell`): спрашивать карту про якорь бессмысленно, он висит выше и
 * левее человека.
 *
 * `null` — свободных клеток нет во всей округе.
 */
export function nearestFree(p: Passability, x: number, y: number, radius = SNAP_RADIUS): Pos | null {
  const here = walkerCell({ x, y });
  const cx = here.x;
  const cy = here.y;
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
        // Считаем от клетки, в которой человек стоит, а не от его якоря:
        // ближайший выход — это ближайшая клетка к ногам.
        const dist = Math.hypot(nx - cx, ny - cy);
        if (dist < bestDist) { bestDist = dist; best = { x: nx, y: ny }; }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Клетки, по которым разрешено идти вопреки тому, что они заняты, — места
 * предмета, с которого агент встаёт или на который садится.
 *
 * Место человека лежит на самой мебели: подушка дивана — это диван, стул у
 * стола — клетка перед столом. Дойти до такого места значит зайти на занятый
 * тайл, и другого способа нет. Поэтому концы маршрута — и только они —
 * открываются вместе со своими соседями по предмету: диван, у которого
 * журнальный столик перегородил проход перед двумя подушками из трёх,
 * остаётся диваном на троих — заходят с открытого края и садятся куда
 * собирались.
 *
 * Стены и прочая мебель так не открываются никогда: сюда попадает клетка
 * конца маршрута, если она занята, и клетки того же предмета, у которых
 * объявлены входы.
 */
function softCells(p: Passability, cell: Pos, into: Set<number>, anyway: boolean): void {
  if (cell.x < 0 || cell.y < 0 || cell.x >= p.cols || cell.y >= p.rows) return;
  if (!isBlocked(p, cell.x, cell.y)) return;
  const idx = cellIndex(p, cell.x, cell.y);
  const entry = p.entries.get(idx);
  // Занятая клетка, у которой не объявлено входов, — это не место, а мебель
  // или стена. Строгий поиск в неё не ходит: `findPath` без `bestEffort` —
  // диагностика раскладки, и «дошёл до стены» там должно быть провалом.
  // Агентам (`bestEffort`) конец маршрута открывается всё равно: точка места
  // бывает описана неточно, и упереться в неё лучше, чем застыть.
  if (!entry && !anyway) return;
  into.add(idx);
  if (!entry) return;
  for (const [other, e] of p.entries) {
    if (e.prop === entry.prop) into.add(other);
  }
}

/**
 * Карта, в которой у клетки старта сняты ограничения на выход.
 *
 * Зайти на место можно только с объявленной стороны — это правило. Уйти с
 * него — тоже, но у правила есть предел: если объявленный выход перегорожен
 * (диван задвинут к стене, перед ним журнальный столик), человек не остаётся
 * на диване навсегда, он встаёт и выходит боком. Ограничение снимается
 * только у той клетки, на которой агента застигли, и только когда выйти по
 * правилам действительно некуда.
 */
function withEscape(p: Passability, from: Pos, soft: Set<number>): Passability {
  if (from.x < 0 || from.y < 0 || from.x >= p.cols || from.y >= p.rows) return p;
  const idx = cellIndex(p, from.x, from.y);
  const entry = p.entries.get(idx);
  if (!entry) return p;
  const canLeave = NEIGHBORS.some(([dx, dy]) => canStep(p, from.x, from.y, dx, dy, soft));
  if (canLeave) return p;
  const entries = new Map(p.entries);
  entries.set(idx, { sides: ALL_SIDES, prop: entry.prop });
  return { ...p, entries };
}

/**
 * Разрешён ли шаг из одной клетки в соседнюю по объявленным входам.
 *
 * Правило одно и работает в обе стороны: если у клетки объявлены входы, то
 * войти в неё и выйти из неё можно только через объявленную сторону и только
 * прямо — по диагонали на место не заходят и с места не сходят, человек
 * садится ровно, а не наискось через угол подлокотника.
 *
 * Исключение — шаг внутри одного предмета: с подушки на подушку переходят
 * как угодно, это перемещение по мебели, а не заход на неё.
 */
function stepAllowed(p: Passability, ax: number, ay: number, bx: number, by: number): boolean {
  const from = p.entries.get(cellIndex(p, ax, ay));
  const to = p.entries.get(cellIndex(p, bx, by));
  if (!from && !to) return true;
  if (from && to && from.prop === to.prop) return true;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx !== 0 && dy !== 0) return false;
  // Сторона клетки `b`, через которую в неё входят; у `a` — противоположная.
  const into = dx > 0 ? SIDE_BIT.w : dx < 0 ? SIDE_BIT.e : dy > 0 ? SIDE_BIT.n : SIDE_BIT.s;
  if (to && (to.sides & into) === 0) return false;
  if (from && (from.sides & OPPOSITE_BIT[into]) === 0) return false;
  return true;
}

/**
 * Можно ли встать на клетку в этом маршруте: свободна — да, занята — только
 * если это конец маршрута или соседнее место того же предмета (`softCells`).
 */
function isWalkable(p: Passability, x: number, y: number, soft: Set<number>): boolean {
  if (x < 0 || y < 0 || x >= p.cols || y >= p.rows) return false;
  if (!isBlocked(p, x, y)) return true;
  return soft.has(cellIndex(p, x, y));
}

/**
 * Шаг из клетки в соседнюю целиком: и клетка проходима, и вход разрешён, и
 * диагональ не срезает угол.
 *
 * Про угол: диагональный шаг запрещён, если занят хотя бы один из двух
 * ортогональных соседей угла, — иначе путь прошёл бы наискось сквозь стык
 * двух стен или впритирку к кромке предмета. Открытые клетки места здесь не
 * считаются свободными нарочно: мимо угла дивана ходят по полу.
 */
function canStep(
  p: Passability, cx: number, cy: number, dx: number, dy: number, soft: Set<number>,
): boolean {
  const nx = cx + dx;
  const ny = cy + dy;
  if (!isWalkable(p, nx, ny, soft)) return false;
  if (dx !== 0 && dy !== 0 && (isBlocked(p, cx + dx, cy) || isBlocked(p, cx, cy + dy))) return false;
  return stepAllowed(p, cx, cy, nx, ny);
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

/** Стоит ли человек с этим якорем в этой клетке. */
function inCell(pt: Pos, cell: Pos): boolean {
  const at = walkerCell(pt);
  return at.x === cell.x && at.y === cell.y;
}

/**
 * Ломаная в мировых координатах по цепочке клеток: точный старт, середины
 * клеток между ними, точная цель.
 *
 * Точки ломаной — якоря фигуры, как и концы: рендер ставит человека ровно в
 * них. Середина клетки в этих координатах — `standingAt`: ноги в центре
 * тайла, якорь выше и левее.
 *
 * Середина крайней клетки выкидывается, если конец пути и так лежит внутри
 * неё, — иначе заход в центр выглядел бы шагом назад перед выходом и шагом
 * назад перед посадкой. Срезать при этом нечего: две соседние клетки цепочки
 * проходимы обе, а у диагонального шага дополнительно требуются свободными
 * оба ортогональных соседа, — отрезок из любой точки одной клетки в середину
 * соседней не выходит за пределы этих четырёх.
 */
function toWorldPath(cells: Pos[], start: Pos, goal: Pos): Pos[] {
  const merged = mergeCollinear(cells);
  const last = merged.length - 1;
  const points: Pos[] = [{ ...start }];
  for (let i = 0; i < merged.length; i++) {
    if (i === 0 && inCell(start, merged[0])) continue;
    if (i === last && inCell(goal, merged[last])) continue;
    points.push(standingAt(merged[i].x, merged[i].y));
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
 * Координаты — якоря фигуры (как слоты `work`, `seat` и `standingAt`), а
 * карта спрашивается по ногам (`walkerCell`). Это одно и то же место,
 * записанное двумя способами, и путать их нельзя: якорь лежит строкой выше
 * ног, и поиск по якорю водил агентов сквозь стены, стоящие как раз в этой
 * строке.
 *
 * Возвращается ломаная: концы — ровно переданные `start`/`goal`, между ними
 * середины клеток. Путь никуда не спрямляется: агент идёт ровно по карте, а
 * по диагонали — только там, где по карте диагональ есть.
 *
 * Занятые концы — это норма, а не ошибка: место человека лежит на самой
 * мебели. Такая клетка открывается вместе с соседними местами того же
 * предмета (`softCells`), а зайти на неё и сойти с неё можно только с
 * объявленной стороны (`stepAllowed`) — с той, с которой к предмету и
 * подходят.
 *
 * Без `bestEffort` поведение строгое: не дошли до цели — `null`. С
 * `bestEffort` маршрут доводится до ближайшей к цели разведанной клетки:
 * агент подходит настолько, насколько пускает карта, и останавливается. Ни в
 * каком случае он не идёт сквозь стены.
 */
export function findPath(
  p: Passability, start: Pos, goal: Pos, opts?: PathOptions,
): Pos[] | null {
  const bestEffort = opts?.bestEffort ?? false;

  const from = walkerCell(start);
  const to = walkerCell(goal);

  const soft = new Set<number>();
  softCells(p, from, soft, true);
  softCells(p, to, soft, bestEffort);
  // Дальше карта своя: у клетки, на которой стоит агент, может быть снят
  // запрет на выход, если по правилам выйти некуда.
  p = withEscape(p, from, soft);

  /**
   * Куда ведём на самом деле. Обычно это сама цель; подмена нужна только
   * тогда, когда её клетки нет на карте вовсе (координата уехала за пределы
   * комнаты) — тогда ведём в ближайшую клетку, которая на карте есть.
   */
  let finish: Pos = goal;

  // Занятый конец сюда не попадает: он открыт как место (`softCells`).
  // Непроходимым остаётся только то, чего на карте нет, — клетка за краем.
  if (!isWalkable(p, from.x, from.y, soft)) {
    if (!bestEffort) return null;
    const free = nearestFree(p, start.x, start.y);
    if (!free) return [{ ...start }];
    from.x = free.x; from.y = free.y;
  }
  if (!isWalkable(p, to.x, to.y, soft)) {
    if (!bestEffort) return null;
    const free = nearestFree(p, goal.x, goal.y);
    if (!free) return [{ ...start }];
    to.x = free.x; to.y = free.y;
    finish = standingAt(free.x, free.y);
  }

  const sx = from.x;
  const sy = from.y;
  const gx = to.x;
  const gy = to.y;

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
      if (!canStep(p, cx, cy, dx, dy, soft)) continue;
      const nx = cx + dx;
      const ny = cy + dy;
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
  // Цель за стеной, в отрезанной комнате или на месте, к которому не подойти
  // с его стороны: доводим до ближайшей к ней клетки, до которой дорога есть.
  // Конец ломаной — её середина, а не сама цель: туда пути нет, и делать
  // вид, что есть, незачем.
  // Не сдвинулись ни на клетку: идти отсюда решительно некуда — комната
  // отрезана, дверь заставлена. Стоим, где стояли: единственная честная
  // альтернатива — прыжок сквозь то, что мешает.
  if (nearestIdx === startIdx) return [{ ...start }];
  const cells = reconstructCells(cameFrom, p.cols, nearestIdx);
  const last = cells[cells.length - 1];
  return toWorldPath(cells, start, standingAt(last.x, last.y));
}

/**
 * Свободная клетка рядом с точкой, но не та, в которой точка лежит, — место,
 * с которого к ней подходят. По ней менеджер встаёт у чужого стола: вставать
 * в саму рабочую точку значило бы влезть в человека, за ней сидящего.
 *
 * Возвращается якорь фигуры (`standingAt`), а не клетка: результат идёт
 * прямо в маршрут, а маршрут считается в якорях.
 */
export function adjacentFree(p: Passability, at: Pos): Pos | null {
  const here = walkerCell(at);
  let best: Pos | null = null;
  let bestDist = Infinity;
  for (const [dx, dy] of NEIGHBORS) {
    const nx = here.x + dx;
    const ny = here.y + dy;
    if (isBlocked(p, nx, ny)) continue;
    if (dx !== 0 && dy !== 0 && (isBlocked(p, here.x + dx, here.y) || isBlocked(p, here.x, here.y + dy))) continue;
    if (!stepAllowed(p, here.x, here.y, nx, ny)) continue;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) { bestDist = dist; best = standingAt(nx, ny); }
  }
  return best;
}

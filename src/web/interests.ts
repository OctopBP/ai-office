/**
 * Чем заняты свободные агенты.
 *
 * Раньше свободный садился на место с номером своего стола — привязка
 * стабильная, но мёртвая: восемь одинаковых фигур в ряд. Здесь у комнаты
 * появляются **занятия**: постоять вдвоём и поговорить, поиграть на приставке
 * (вдвоём веселее), просто посидеть, поотжиматься, выпить кофе стоя,
 * потанцевать. Кому что достанется, решает раздача ниже — случайно, но не
 * то же самое, чем человек занимался только что.
 *
 * Занятие не навсегда: у каждого свой срок, полминуты–полторы, после
 * которого он бросает дело и берётся за другое. Срок случайный и у каждого
 * свой нарочно — общий таймер поднимал бы всю комнату разом, и это снова был
 * бы кордебалет, только раз в минуту. Кто просрочил, спрашивает стор
 * (`rotateInterests`); заново раздаёт та же `interestsFor`.
 *
 * Это целиком слой визуализации. Задачам всё равно, играет агент или сидит, и
 * сервер об этом не знает — офис остаётся картинкой по событиям, а не их
 * источником (CONCEPT.md §2). Поэтому и раздача живёт на клиенте, рядом с
 * ходьбой, а не в состоянии офиса.
 */
import {
  deskPoint, desks, isBlocked, isEntry, restSeats, standingAt, talkSeats, walkerCell,
} from '../shared/layout';
import type { Catalog, Layout, LayoutZone, Pos } from '../shared/layout';
import type { InstanceView, RoleView } from '../shared/types';
import { isBusy } from './agentState';
import { passabilityFor } from './layoutData';

export type InterestKind = 'talk' | 'game' | 'sit' | 'stand' | 'pushup' | 'drink' | 'dance';

export interface Interest {
  kind: InterestKind;
  /** Куда встать — якорь фигуры, как у слотов `work` и `seat`. */
  at: Pos;
  /** Куда смотреть, радианы вокруг вертикали. Пусто — как обычно, на юг. */
  yaw?: number;
  /** С кем: собеседник или напарник по игре. */
  partner?: string;
  /** Предмет, на котором сидят: по нему трёхмерный рендер находит доводку
   *  посадки под конкретную модель. У разговоров и стоячих мест его нет. */
  sprite?: string;
  /** Которое место предмета занято: у дивана подушки разные (`RestSeat.seat`). */
  seat?: number;
}

/** Вид места: где разговаривают, где играют, где сидят, где просто пол. */
type SpotKind = 'talk' | 'game' | 'sit' | 'floor';

/**
 * Занятия на полу — те, для которых не нужен предмет, только свободная
 * клетка. `stand` среди них самое скучное, и вес у него ниже: это «ничего
 * не делать», а не занятие.
 */
const FLOOR_KINDS: readonly InterestKind[] = ['stand', 'drink', 'dance', 'pushup'];

/**
 * Насколько охотно выбирают занятие. Разговор дороже остальных: это самое
 * живое, что есть в комнате, и он должен случаться чаще, чем стояние столбом.
 */
const WEIGHT: Record<InterestKind, number> = {
  talk: 3, game: 2, sit: 2, drink: 2, dance: 2, pushup: 2, stand: 1,
};

/** Сколько длится одно занятие, мс: случайно в этих пределах, у каждого своё. */
const STAY_MIN = 30_000;
const STAY_MAX = 90_000;

interface Seat {
  at: Pos;
  yaw: number;
  sprite?: string;
  seat?: number;
  /** Клетка южнее тоже свободна — можно лечь на отжимания. */
  long?: boolean;
}

/** Место занятия: одно или два посадочных/стоячих места с поворотом. */
interface Spot {
  id: string;
  kind: SpotKind;
  seats: Seat[];
  /**
   * Место работает только заполненным целиком. У разговора это так: один
   * человек, стоящий лицом к пустому месту, выглядит хуже, чем тот же
   * человек, отошедший заняться чем-то другим. У дивана — нет: играть можно
   * и одному.
   */
  requiresAll: boolean;
}

/**
 * Шаг между стоящими, клетки. Стоящий агент — фигура на целой клетке, как и
 * собеседники (`talkSeats`), поэтому шаг тоже целый: через клетку. Ближе
 * нельзя — на соседних клетках фигуры в объёме пересекаются; танцующий
 * машет руками ещё на две трети клетки в стороны.
 */
const FLOOR_GAP = 2;

/** Как далеко от места отдыха (клеток) стоят, если зоны отдыха в раскладке нет. */
const FLOOR_REACH = 2;

/**
 * Насколько отжимающийся сдвинут к югу от центра своей клетки, тайлы.
 *
 * Лёжа человек длиннее клетки: по замеру клипа тело тянется примерно на 0.85
 * тайла в обе стороны от точки ног — ступни к северу, голова к югу (фигура
 * смотрит на юг). Со сдвигом почти на полклетки он ложится ровно на свою
 * клетку и следующую за ней, а не торчит на четверть в ту, что севернее, где
 * через ряд стоит сосед. Чуть меньше половины — чтобы клетка ног (`walkerCell`)
 * не попала на самую границу и не прыгала от ошибки округления.
 */
const PUSHUP_SHIFT = 0.45;

/**
 * Места разговоров, отдыха и клетки пола, выведенные из раскладки.
 *
 * Разговоры описаны зонами (`kind: 'talk'`) — они не привязаны к мебели,
 * стоят просто посреди комнаты, на целых клетках. Места отдыха приходят
 * слотами предмета: диван сам знает, где у него подушки и какая из них у
 * приставки. Клетки пола — свободные клетки зоны отдыха через одну.
 */
function spotsOf(layout: Layout, catalog: Catalog): Spot[] {
  const spots: Spot[] = [];

  // Где стоят собеседники, знает раскладка (`talkSeats`): те же точки
  // проверяет на проходимость `scripts/test-nav.ts`, и считать их здесь ещё
  // раз — значит однажды разойтись.
  (layout.zones ?? []).forEach((zone: LayoutZone, i) => {
    const seats = talkSeats(zone);
    if (seats.length === 0) return;
    spots.push({ id: `talk-${i}`, kind: 'talk', requiresAll: true, seats });
  });

  /**
   * Места отдыха берутся из тех же слотов, что и `kitchenSeats`, но здесь
   * важно ещё и назначение слота. Соседние места одного назначения
   * объединяются в одно занятие: две подушки у приставки — это «поиграть
   * вдвоём», а не два одиночных сидения.
   */
  const seatPoints = restSeats(layout, catalog);
  const gamers = seatPoints.filter((s) => s.use === 'game');
  if (gamers.length > 0) {
    spots.push({
      id: 'game',
      kind: 'game',
      requiresAll: false,
      seats: gamers.map((s) => ({ at: s.at, yaw: 0, sprite: s.sprite, seat: s.seat })),
    });
  }
  seatPoints.filter((s) => s.use !== 'game').forEach((s, i) => {
    spots.push({
      id: `sit-${i}`, kind: 'sit', requiresAll: false,
      seats: [{ at: s.at, yaw: 0, sprite: s.sprite, seat: s.seat }],
    });
  });

  spots.push(...floorSpots(
    layout, catalog, spots.filter((s) => s.kind === 'talk'), spots.filter((s) => s.kind !== 'talk'),
  ));
  return spots;
}

/**
 * Клетки пола в зоне отдыха, на которых можно стоять.
 *
 * Берутся с сетки проходимости, а не «внутри прямоугольника комнаты»: в
 * лаунже стоят диваны, столики, торшеры, и стоячее место посреди дивана —
 * это человек, торчащий из подушки. Через одну по обеим осям, чтобы фигуры
 * не пересекались; ряд начинается снизу, от южной стены, — как и раньше
 * стояли те, кому места не хватило.
 *
 * Клетки вплотную к собеседникам и к рабочим точкам столов не берутся:
 * разговор — это пара на целых клетках с клеткой между ними, и третий,
 * вставший к ним впритык, стоит у одного из них за спиной; то же с
 * работающим за столом.
 *
 * Отжимания занимают две клетки: свою и южнее. Клетка южнее лежит между
 * рядами сетки, и никто другой на ней стоять не будет, — но она может быть
 * занята мебелью или выходить за комнату, и тогда на этом месте только стоят.
 *
 * Зоны отдыха в раскладке может и не быть (`classic`): тогда комната — вся
 * раскладка, а стоят только около мест отдыха (`FLOOR_REACH`).
 */
function floorSpots(layout: Layout, catalog: Catalog, talks: Spot[], rests: Spot[]): Spot[] {
  const zone = layout.zones?.find((z) => z.kind === 'idle' && z.room);
  const room = layout.rooms?.find((r) => r.id === zone?.room);
  const grid = passabilityFor(layout);
  const [x0, y0, x1, y1] = room?.rect ?? [0, 0, layout.size[0], layout.size[1]];
  const talkCells = talks.flatMap((s) => s.seats.map((seat) => walkerCell(seat.at)));
  const restCells = rests.flatMap((s) => s.seats.map((seat) => walkerCell(seat.at)));
  /**
   * Раскладке без зоны отдыха (`classic`) пол весь — но стоять посреди
   * опенспейса между чужими столами нелепо. Там стоячие клетки берутся
   * только рядом с местами отдыха: у дивана, у кухонного стола. Есть зона —
   * она и есть «рядом», ограничивать нечего.
   */
  const nearRest = (x: number, y: number): boolean => !!room
    || restCells.some((c) => Math.abs(c.x - x) <= FLOOR_REACH && Math.abs(c.y - y) <= FLOOR_REACH);
  // Рабочие точки столов: стоять вплотную к ним — значит танцевать у
  // работающего за спиной. В раскладке с зоной отдыха столов в ней нет, а в
  // `classic` места отдыха стоят через клетку от столов.
  const deskCells = desks(layout, catalog).map((_, i) => walkerCell(deskPoint(layout, catalog, i, 'work')));
  const near = (cells: Pos[], x: number, y: number): boolean => cells
    .some((c) => Math.abs(c.x - x) <= 1 && Math.abs(c.y - y) <= 1);
  const open = (x: number, y: number): boolean => x >= x0 && x < x1 && y >= y0 && y < y1
    && !isBlocked(grid, x, y) && !isEntry(grid, x, y) && nearRest(x, y)
    && !near(talkCells, x, y) && !near(deskCells, x, y);

  const spots: Spot[] = [];
  for (let cy = y1 - 1; cy >= y0; cy -= FLOOR_GAP) {
    for (let cx = x0 + 1; cx < x1; cx += FLOOR_GAP) {
      if (!open(cx, cy)) continue;
      spots.push({
        id: `floor-${cx}-${cy}`, kind: 'floor', requiresAll: false,
        seats: [{ at: standingAt(cx, cy), yaw: 0, long: open(cx, cy + 1) }],
      });
    }
  }
  return spots;
}

/**
 * Кто где сидит и стоит — сохраняется между пересчётами.
 *
 * Раздача обязана быть **липкой**. Пересчитывается она на каждое событие
 * сервера, и если каждый раз раскладывать заново, свободные агенты будут
 * бегать по комнате от любого чиха. Поэтому занятые места остаются за своими,
 * а меняется только то, что должно: ушёл собеседник — разговор распался, и
 * оставшемуся ищется новое занятие; вышел срок — человек идёт за новым.
 */
let occupancy = new Map<string, (string | null)[]>();
let signature = '';
/**
 * Кто у приставки играет, а кто просто сидит рядом. Липко по той же причине,
 * что и места: решай заново на каждое событие — и сидящий то брал бы
 * джойстик, то бросал.
 */
let activity = new Map<string, 'game' | 'sit'>();

/** Чем занят каждый, на каком месте и до какого времени (мс эпохи). */
interface Stay { spot: string; kind: InterestKind; until: number }
let stays = new Map<string, Stay>();
/**
 * Чем занимался в прошлый раз — чтобы новое занятие было другим. Живёт
 * дольше самого занятия и переживает уход на работу: вернувшись с задачи,
 * человек не садится на то же самое место.
 */
const lastKind = new Map<string, InterestKind>();

function reset(spots: Spot[]): void {
  occupancy = new Map(spots.map((s) => [s.id, s.seats.map(() => null)]));
  activity = new Map();
  stays = new Map();
}

/** Стабильное число от id: чтобы третий на диване выбирал сам, но всегда одно и то же. */
function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Занятия на диване у приставки. Все подушки там размечены «играть», но
 * трое с джойстиками в ряд — тот же кордебалет, от которого уходили. Поэтому
 * играет тот, кто пришёл к пустой приставке; второй садится рядом смотреть,
 * а дальше каждый выбирает по своему id. Кто уже сел — своё занятие хранит.
 */
function gameActivities(seats: (string | null)[]): void {
  const here = seats.filter((id): id is string => !!id);
  const hereSet = new Set(here);
  for (const id of [...activity.keys()]) {
    if (!hereSet.has(id)) activity.delete(id);
  }
  for (const id of here) {
    if (activity.has(id)) continue;
    const mine = here.map((o) => activity.get(o)).filter(Boolean);
    activity.set(id, !mine.includes('game') ? 'game'
      : !mine.includes('sit') ? 'sit'
        : hash(id) % 2 === 0 ? 'game' : 'sit');
  }
}

/** Случайный элемент; у пустого списка — ничего. */
function sample<T>(list: T[]): T | undefined {
  return list.length > 0 ? list[Math.floor(Math.random() * list.length)] : undefined;
}

/** Случайный ключ с весами из `WEIGHT`. */
function weighted(kinds: InterestKind[]): InterestKind {
  const total = kinds.reduce((sum, k) => sum + WEIGHT[k], 0);
  let r = Math.random() * total;
  for (const k of kinds) {
    r -= WEIGHT[k];
    if (r < 0) return k;
  }
  return kinds[kinds.length - 1];
}

/** Место, куда сесть или встать: номер места в нём и занятие. */
interface Pick { spot: Spot; seat: number; kind: InterestKind }

/**
 * Выбрать занятие тому, кто стоит в очереди.
 *
 * Сначала выбирается **что** делать — среди того, что сейчас доступно, с
 * весами и без прошлого занятия, если есть из чего выбирать, — и только потом
 * **где**: случайное свободное место этого вида. Порядок важен: мест на полу
 * с десяток, разговор один, и выбирай мы место наугад, разговор выпадал бы
 * раз в десять реже, чем стояние на полу.
 *
 * Разговор можно взять, только если в очереди есть с кем: сажать одного
 * ждать собеседника — это та самая поза, от которой уходили.
 */
function choose(spots: Spot[], hasMate: boolean, avoid: InterestKind | undefined): Pick | null {
  const vacant = (s: Spot): number[] => (occupancy.get(s.id) ?? [])
    .map((id, i) => (id === null ? i : -1)).filter((i) => i >= 0);
  const options = new Map<InterestKind, Pick[]>();
  const offer = (kind: InterestKind, pick: Pick) => {
    options.set(kind, [...(options.get(kind) ?? []), pick]);
  };
  for (const spot of spots) {
    const free = vacant(spot);
    if (free.length === 0) continue;
    if (spot.kind === 'talk') {
      if (hasMate && free.length === spot.seats.length) offer('talk', { spot, seat: 0, kind: 'talk' });
    } else if (spot.kind === 'floor') {
      for (const kind of FLOOR_KINDS) {
        if (kind === 'pushup' && !spot.seats[0].long) continue;
        offer(kind, { spot, seat: 0, kind });
      }
    } else {
      offer(spot.kind, { spot, seat: free[0], kind: spot.kind });
    }
  }
  let kinds = [...options.keys()];
  if (kinds.length === 0) return null;
  if (avoid && kinds.length > 1) kinds = kinds.filter((k) => k !== avoid);
  return sample(options.get(weighted(kinds))!) ?? null;
}

/**
 * Раздать свободным агентам занятия.
 *
 * Занятые места остаются за своими. Новые раздаются тем, у кого места нет:
 * только что освободившимся от работы и тем, у кого вышел срок. Что кому —
 * решает `choose`.
 */
export function interestsFor(
  layout: Layout, catalog: Catalog, instances: Record<string, InstanceView>, roles: RoleView[],
): Map<string, Interest> {
  const spots = spotsOf(layout, catalog);
  const sig = `${layout.id}:${spots.map((s) => s.id).join(',')}`;
  if (sig !== signature) {
    signature = sig;
    reset(spots);
  }

  const free = Object.values(instances)
    .filter((i) => !isBusy(i, roles))
    .map((i) => i.id)
    .sort();
  const freeSet = new Set(free);

  // Занятия тех, кто ушёл работать, освобождаются; распавшиеся разговоры —
  // целиком, вместе с оставшимся собеседником.
  for (const spot of spots) {
    const seats = (occupancy.get(spot.id) ?? spot.seats.map(() => null))
      .map((id) => (id && freeSet.has(id) ? id : null));
    const filled = seats.filter(Boolean).length;
    occupancy.set(spot.id, spot.requiresAll && filled < seats.length ? seats.map(() => null) : seats);
  }

  // Срок и место сверяются с занятостью: кто потерял место — ушёл на работу,
  // остался без собеседника, просрочил, — тот больше ничем не занят, и
  // прошлое занятие запоминается, чтобы следующее было другим.
  const seatOf = new Map<string, string>();
  for (const [spotId, seats] of occupancy) {
    for (const id of seats) if (id) seatOf.set(id, spotId);
  }
  for (const [id, stay] of stays) {
    if (seatOf.get(id) !== stay.spot) {
      stays.delete(id);
      lastKind.set(id, stay.kind);
    }
  }

  const queue = free.filter((id) => !seatOf.has(id));
  const leftovers: string[] = [];
  const now = Date.now();
  while (queue.length > 0) {
    const id = queue.shift()!;
    const pick = choose(spots, queue.length > 0, lastKind.get(id));
    if (!pick) {
      leftovers.push(id);
      continue;
    }
    const seats = occupancy.get(pick.spot.id)!;
    const until = now + STAY_MIN + Math.random() * (STAY_MAX - STAY_MIN);
    if (pick.spot.kind === 'talk') {
      // Разговор берут парой, и срок у пары один: чей бы ни вышел первым,
      // разговор кончается для обоих.
      const mate = queue.shift()!;
      seats[0] = id;
      seats[1] = mate;
      stays.set(id, { spot: pick.spot.id, kind: 'talk', until });
      stays.set(mate, { spot: pick.spot.id, kind: 'talk', until });
    } else {
      seats[pick.seat] = id;
      stays.set(id, { spot: pick.spot.id, kind: pick.kind, until });
    }
  }

  const result = new Map<string, Interest>();
  for (const spot of spots) {
    const seats = occupancy.get(spot.id)!;
    if (spot.kind === 'game') gameActivities(seats);
    seats.forEach((id, i) => {
      if (!id) return;
      const mate = seats.find((other, j) => other && j !== i) ?? undefined;
      const kind: InterestKind = spot.kind === 'game' ? activity.get(id)!
        : spot.kind === 'floor' ? (stays.get(id)?.kind ?? 'stand')
          : spot.kind;
      const seat = spot.seats[i];
      result.set(id, {
        kind,
        at: kind === 'pushup' ? { x: seat.at.x, y: seat.at.y + PUSHUP_SHIFT } : seat.at,
        yaw: seat.yaw,
        sprite: seat.sprite,
        seat: seat.seat,
        partner: mate ?? undefined,
      });
    });
  }

  // Кому места не хватило — стоят рядами в зоне отдыха, как и раньше.
  leftovers.forEach((id, i) => {
    result.set(id, { kind: 'stand', at: overflowSpot(layout, i) });
  });
  return result;
}

/**
 * Снять с занятий тех, у кого вышел срок.
 *
 * Только снять: новое занятие им раздаст `interestsFor`, когда стор спросит,
 * куда их вести. Отдельным шагом, а не внутри `interestsFor`, потому что ту
 * зовут отовсюду — на каждое событие сервера и из рендера, — а смена занятия
 * должна случаться в один известный момент, за которым следует маршрут:
 * иначе человек менял бы позу на месте, а шёл на новое место секундой позже.
 *
 * Возвращает, кого сняли. Собеседник снятого остаётся в списке занятых, но
 * разговор без него распадётся в `interestsFor` — поэтому стор после
 * ротации сверяет цели у всех свободных, а не только у снятых.
 */
export function rotateInterests(now: number = Date.now()): string[] {
  const due: string[] = [];
  for (const [id, stay] of stays) {
    if (stay.until > now) continue;
    const seats = occupancy.get(stay.spot);
    const i = seats?.indexOf(id) ?? -1;
    if (seats && i >= 0) seats[i] = null;
    stays.delete(id);
    lastKind.set(id, stay.kind);
    due.push(id);
  }
  return due;
}

/**
 * Куда встать тому, кому занятия не досталось. Внутри зоны отдыха, рядами —
 * та же раскладка, что была у мест кухни, когда их не хватало на всех. Ряд
 * начинается на второй клетке комнаты от стены и идёт с высоты примерно
 * двух третей комнаты; каждый стоит в центре своей клетки (`standingAt`).
 */
function overflowSpot(layout: Layout, i: number): Pos {
  const zone = layout.zones?.find((z) => z.kind === 'idle' && z.room);
  const room = layout.rooms?.find((r) => r.id === zone?.room);
  if (!room) return standingAt(1, 1);
  const [x0, y0, x1, y1] = room.rect;
  const perRow = Math.max(1, Math.floor((x1 - x0 - 1) / FLOOR_GAP));
  return standingAt(
    Math.round(x0 + 1 + (i % perRow) * FLOOR_GAP),
    Math.round(y0 + (y1 - y0) * 0.72) + Math.floor(i / perRow) * FLOOR_GAP,
  );
}

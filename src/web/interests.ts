/**
 * Чем заняты свободные агенты.
 *
 * Раньше свободный садился на место с номером своего стола — привязка
 * стабильная, но мёртвая: восемь одинаковых фигур в ряд. Здесь у комнаты
 * появляются **занятия**: постоять вдвоём и поговорить, поиграть на приставке
 * (вдвоём веселее), просто посидеть. Кому что достанется, решает раздача
 * ниже.
 *
 * Это целиком слой визуализации. Задачам всё равно, играет агент или сидит, и
 * сервер об этом не знает — офис остаётся картинкой по событиям, а не их
 * источником (CONCEPT.md §2). Поэтому и раздача живёт на клиенте, рядом с
 * ходьбой, а не в состоянии офиса.
 */
import { restSeats } from '../shared/layout';
import type { Catalog, Layout, LayoutZone, Pos } from '../shared/layout';
import type { InstanceView, RoleView } from '../shared/types';
import { isBusy } from './agentState';

export type InterestKind = 'talk' | 'game' | 'sit' | 'stand';

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

/** Место занятия: одно или два посадочных/стоячих места с поворотом. */
interface Spot {
  id: string;
  kind: Exclude<InterestKind, 'stand'>;
  seats: { at: Pos; yaw: number; sprite?: string; seat?: number }[];
  /**
   * Место работает только заполненным целиком. У разговора это так: один
   * человек, стоящий лицом к пустому месту, выглядит хуже, чем тот же
   * человек, отошедший заняться чем-то другим. У дивана — нет: играть можно
   * и одному.
   */
  requiresAll: boolean;
}

/** Насколько собеседники расходятся от центра зоны разговора, тайлы. */
const TALK_GAP = 0.75;

/**
 * Места разговоров и отдыха, выведенные из раскладки.
 *
 * Разговоры описаны зонами (`kind: 'talk'`) — они не привязаны к мебели,
 * стоят просто посреди комнаты. Места отдыха приходят слотами предмета: диван
 * сам знает, где у него подушки и какая из них у приставки.
 */
function spotsOf(layout: Layout, catalog: Catalog): Spot[] {
  const spots: Spot[] = [];

  (layout.zones ?? []).forEach((zone: LayoutZone, i) => {
    if (zone.kind !== 'talk' || !zone.at) return;
    const [x, y] = zone.at;
    const alongX = (zone.axis ?? 'x') === 'x';
    spots.push({
      id: `talk-${i}`,
      kind: 'talk',
      requiresAll: true,
      // Собеседники стоят по обе стороны точки и смотрят друг на друга:
      // поворот — это направление на соседа, а не на комнату.
      seats: alongX
        ? [
          { at: { x: x - TALK_GAP, y }, yaw: Math.PI / 2 },
          { at: { x: x + TALK_GAP, y }, yaw: -Math.PI / 2 },
        ]
        : [
          { at: { x, y: y - TALK_GAP }, yaw: 0 },
          { at: { x, y: y + TALK_GAP }, yaw: Math.PI },
        ],
    });
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

  return spots;
}

/**
 * Кто где сидит и стоит — сохраняется между пересчётами.
 *
 * Раздача обязана быть **липкой**. Пересчитывается она на каждое событие
 * сервера, и если каждый раз раскладывать заново, свободные агенты будут
 * бегать по комнате от любого чиха. Поэтому занятые места остаются за своими,
 * а меняется только то, что должно: ушёл собеседник — разговор распался, и
 * оставшемуся ищется новое занятие.
 */
let occupancy = new Map<string, (string | null)[]>();
let signature = '';

function reset(spots: Spot[]): void {
  occupancy = new Map(spots.map((s) => [s.id, s.seats.map(() => null)]));
}

/**
 * Раздать свободным агентам занятия.
 *
 * Порядок заполнения не случаен: сначала разговоры, потом приставка, потом
 * одиночные места. Разговор — самое живое, что есть в комнате, и он должен
 * случаться, пока есть кому разговаривать; сидеть в одиночку можно и потом.
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

  const taken = new Set([...occupancy.values()].flat().filter((id): id is string => !!id));
  const queue = free.filter((id) => !taken.has(id));
  const order: Spot[] = [
    ...spots.filter((s) => s.kind === 'talk'),
    ...spots.filter((s) => s.kind === 'game'),
    ...spots.filter((s) => s.kind === 'sit'),
  ];

  for (const spot of order) {
    const seats = occupancy.get(spot.id)!;
    const vacancies = seats.filter((s) => s === null).length;
    // Разговор занимают только парой: посадить одного, чтобы он ждал
    // собеседника, — это и есть та поза, от которой мы уходим.
    if (spot.requiresAll && (queue.length < vacancies || vacancies < seats.length)) continue;
    for (let i = 0; i < seats.length && queue.length > 0; i++) {
      if (seats[i] === null) seats[i] = queue.shift()!;
    }
  }

  const result = new Map<string, Interest>();
  for (const spot of spots) {
    const seats = occupancy.get(spot.id)!;
    seats.forEach((id, i) => {
      if (!id) return;
      const mate = seats.find((other, j) => other && j !== i) ?? undefined;
      result.set(id, {
        kind: spot.kind,
        at: spot.seats[i].at,
        yaw: spot.seats[i].yaw,
        sprite: spot.seats[i].sprite,
        seat: spot.seats[i].seat,
        partner: mate ?? undefined,
      });
    });
  }

  // Кому места не хватило — стоят рядами в зоне отдыха, как и раньше.
  queue.forEach((id, i) => {
    result.set(id, { kind: 'stand', at: overflowSpot(layout, i) });
  });
  return result;
}

/** Шаг между стоящими, тайлы: в объёме фигуры с меньшим шагом пересекаются. */
const OVERFLOW_GAP = 1.6;

/**
 * Куда встать тому, кому занятия не досталось. Внутри зоны отдыха, рядами —
 * та же раскладка, что была у мест кухни, когда их не хватало на всех.
 */
function overflowSpot(layout: Layout, i: number): Pos {
  const zone = layout.zones?.find((z) => z.kind === 'idle' && z.room);
  const room = layout.rooms?.find((r) => r.id === zone?.room);
  if (!room) return { x: 1, y: 1 };
  const [x0, y0, x1, y1] = room.rect;
  const perRow = Math.max(1, Math.floor((x1 - x0 - 1) / OVERFLOW_GAP));
  return {
    x: x0 + 0.8 + (i % perRow) * OVERFLOW_GAP,
    y: y0 + (y1 - y0) * 0.72 + Math.floor(i / perRow) * OVERFLOW_GAP,
  };
}

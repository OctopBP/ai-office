/**
 * Что известно про каждый предмет обстановки в трёх измерениях.
 *
 * Таблица ниже сознательно короткая: почти всё про предмет уже посчитано в
 * `design/sprites/out/catalog.json` — ширина, след на полу, — и посчитано по
 * пикселям арта, то есть не может разъехаться с картинкой. Каталог не знает
 * ровно одного: **высоты**. В виде сверху её негде было взять, и `size[1]`
 * там — это высота арта, в которой глубина предмета и его рост слиты в одно
 * число. Поэтому здесь у предмета всего два поля: высота и, если каталог не
 * описал след, глубина.
 *
 * `shape` — временная заглушка. Предметы собраны из примитивов, чтобы комнату
 * было чем обставить сейчас; когда появятся настоящие модели, поле станет
 * ссылкой на файл модели, а таблица и вся арифметика размещения ниже
 * останутся теми же. Это и есть шов, ради которого таблица отдельная.
 */
import type { Catalog, Layout, LayoutProp } from '../../shared/layout';
import { WALL_THICK } from './geometry';

/** Какой примитив рисуется вместо предмета. См. `Props3D.tsx`. */
export type Shape =
  | 'desk'      // столешница на тумбе плюс монитор
  | 'table'     // прямоугольная столешница на ножках
  | 'round'     // круглый стол
  | 'chair'     // сиденье со спинкой
  | 'cabinet'   // высокая коробка с лицевой панелью
  | 'appliance' // техника: коробка со скруглением и полосой
  | 'counter'   // кухонная тумба со столешницей
  | 'soft'      // мягкое: диван, кресло-мешок
  | 'plant'     // горшок и крона
  | 'panel'     // плоское на стене: доска, экран, постер, часы, дверь
  | 'slab'      // плоское на полу: ковёр, плитка, коврик у двери
  | 'box';      // мелочь и всё, чего нет в таблице

/** Одна модель в составе предмета: файл из набора и где она стоит. */
export interface ModelPart {
  /** Имя файла в `design/models/furniture`, без расширения. */
  file: string;
  /** Куда поставить основание модели относительно центра следа, тайлы. */
  at?: [number, number, number];
  /** Довернуть модель вокруг вертикали, градусы. */
  rot?: number;
}

export interface Prop3 {
  shape: Shape;
  /**
   * Настоящая модель вместо примитивов. Когда она есть, `shape` не рисуется
   * вовсе — он остаётся запасным вариантом для предметов, которым модели ещё
   * не нашлось. Это и есть тот шов, ради которого таблица заводилась
   * отдельно: замена коробок на модель — одна строка на предмет.
   *
   * Список, а не одна модель: стол в наборе идёт без монитора, и компьютер
   * ставится на него отдельной моделью. Собирать предмет из нескольких —
   * нормальный способ пользоваться набором, а не исключение.
   */
  models?: ModelPart[];
  /** Высота, тайлы. Тайл — примерно 0.75 м (стол шириной 2 тайла = 1.5 м). */
  h: number;
  /** Глубина следа, тайлы. Нужна только там, где в каталоге нет `footprint`. */
  d?: number;
  /** Высота низа над полом для настенного: часы висят, доска висит, дверь нет. */
  wall?: number;
  /** Материал — ключ в `palette.prop`. */
  tone?: 'wood' | 'metal' | 'fabric' | 'leaf' | 'screen' | 'accent' | 'light';
  /**
   * ── РУЧКА ПОДБОРА ПОСАДКИ ──────────────────────────────────────────────
   *
   * Куда сдвинуть сидящего относительно места из каталога, тайлы.
   * `[вправо, вверх, вперёд]` — то есть x вдоль ширины предмета, y от пола,
   * z от спинки к переднему краю. Тайл — 0.75 метра, так что 0.1 это 7.5 см.
   *
   * Числа в каталоге описывают предмет как таковой и общие для обоих
   * рендеров; здесь — доводка под конкретную модель и под то, как её
   * понимает анимация Mixamo (она сажает человека так, будто сиденье на
   * высоте сорока пяти сантиметров, а у моделей набора оно своё).
   *
   * Правится руками, подхватывается на лету — регенерировать каталог не
   * нужно. Подобранное сюда и остаётся: это свойство модели, а не предмета.
   */
  seat?: [number, number, number];
}

/**
 * Высоты взяты от человека, а не от арта: стол — 0.75 м, столешница кухни —
 * 0.9 м, спинка стула — 0.9 м, шкаф — под два метра. В тайлах это 1.0, 1.2,
 * 1.2 и 2.5 соответственно.
 */
/**
 * Тайлов в одной единице модели.
 *
 * Набор Kenney нарисован в масштабе «единица = 2 метра»: стол там 0.384
 * единицы высотой, это 77 сантиметров — ровно столько, сколько положено
 * столу. Тайл у нас 0.75 метра, отсюда и число. Оно одно на весь набор:
 * предметы в нём соразмерны друг другу, и подгонять каждый под свой след
 * значило бы эту соразмерность сломать.
 */
export const MODEL_SCALE = 2 / 0.75;

/**
 * Стол с компьютером: в наборе это две отдельные модели.
 *
 * Оба развёрнуты на 180°. Набор смотрит «лицом» в +Z, а сидят за нашим столом
 * с северной стороны — это −Z: слот `work` у стола объявлен выше его якоря.
 * Без разворота стол стоит к человеку задом, а монитор — экраном в стену.
 *
 * Монитор при этом стоит у дальней от человека кромки (+Z) и смотрит на
 * него: так стоит монитор на любом рабочем столе.
 */
const DESK_MODELS: ModelPart[] = [
  { file: 'desk', rot: 180 },
  { file: 'computerScreen', at: [-0.1, 1.02, 0.3], rot: 180 },
];

export const PROPS: Record<string, Prop3> = {
  desk: { shape: 'desk', h: 1.0, tone: 'wood', models: DESK_MODELS },
  desk_pm: { shape: 'desk', h: 1.0, tone: 'wood', models: DESK_MODELS },
  dining_table: { shape: 'table', h: 1.0, tone: 'wood' },
  round_table: { shape: 'round', h: 1.0, d: 1.375, tone: 'wood' },
  // Стул не разворачивается: в наборе он и так стоит спинкой к столу, то есть
  // лицом туда же, куда смотрит сидящий. Разворот, который понадобился столу,
  // ему только вредит.
  chair: { shape: 'chair', h: 1.2, d: 0.65, tone: 'fabric', models: [{ file: 'chairDesk' }] },

  bookshelf: { shape: 'cabinet', h: 2.5, d: 0.5, tone: 'wood' },
  server_rack: { shape: 'cabinet', h: 2.5, d: 0.8, tone: 'metal' },
  arcade: { shape: 'cabinet', h: 2.3, d: 0.9, tone: 'accent' },

  fridge: { shape: 'appliance', h: 2.4, d: 0.9, tone: 'metal' },
  cooler: { shape: 'appliance', h: 1.6, d: 0.6, tone: 'metal' },
  coffee_machine: { shape: 'appliance', h: 0.6, d: 0.6, tone: 'metal' },

  counter_straight: { shape: 'counter', h: 1.2, tone: 'wood' },
  sink_counter: { shape: 'counter', h: 1.2, tone: 'wood' },
  counter_corner: { shape: 'counter', h: 1.2, tone: 'wood' },

  sofa: {
    shape: 'soft', h: 1.2, d: 1.25, tone: 'fabric',
    models: [{ file: 'loungeSofa' }],
    seat: [0, 0, 0],
  },
  // Кресло существует только моделью — пиксельного арта у него нет, и
  // плоский офис его не рисует. Запасная форма всё равно объявлена: она
  // понадобится, если модель не приедет.
  armchair: {
    shape: 'soft', h: 1.2, d: 1.25, tone: 'fabric',
    models: [{ file: 'loungeChair' }],
    seat: [0, 0, 0],
  },
  beanbag: { shape: 'soft', h: 0.7, d: 0.85, tone: 'accent' },

  plant_big: { shape: 'plant', h: 1.9, tone: 'leaf' },
  plant_small: { shape: 'plant', h: 0.95, tone: 'leaf' },

  // Настенное. `wall` — высота низа: доску и экран вешают на уровень глаз,
  // часы выше, дверь стоит на полу.
  board: { shape: 'panel', h: 1.3, d: 0.12, wall: 1.0, tone: 'screen' },
  logscreen: { shape: 'panel', h: 1.1, d: 0.12, wall: 1.1, tone: 'screen' },
  tv: { shape: 'panel', h: 1.1, d: 0.12, wall: 1.1, tone: 'screen' },
  poster: { shape: 'panel', h: 1.1, d: 0.06, wall: 1.1, tone: 'accent' },
  clock: { shape: 'panel', h: 0.7, d: 0.08, wall: 1.7, tone: 'light' },
  neon_sign: { shape: 'panel', h: 0.9, d: 0.08, wall: 1.4, tone: 'light' },
  window: { shape: 'panel', h: 1.0, d: 0.08, wall: 0.9, tone: 'light' },
  door: { shape: 'panel', h: 2.1, d: 0.12, wall: 0, tone: 'wood' },

  // Плоское на полу: след равен всему арту, высоты почти нет.
  rug: { shape: 'slab', h: 0.03, tone: 'fabric' },
  game_rug: { shape: 'slab', h: 0.03, tone: 'fabric' },
  kitchen_tiles: { shape: 'slab', h: 0.02, tone: 'metal' },
  doormat: { shape: 'slab', h: 0.03, tone: 'fabric' },

  // Мелочь, которая стоит на мебели.
  console: { shape: 'box', h: 0.25, d: 0.5, tone: 'metal' },
  gamepad: { shape: 'box', h: 0.12, d: 0.35, tone: 'accent' },
  coin: { shape: 'box', h: 0.12, d: 0.55, tone: 'light' },
  kitchen_mugs: { shape: 'box', h: 0.3, d: 0.45, tone: 'light' },
  kitchen_snack: { shape: 'box', h: 0.35, d: 0.45, tone: 'accent' },
};

/**
 * Запасной вариант для предмета, которого в таблице нет: коробка размером с
 * арт. Лучше кубик не на своём месте, чем дырка в комнате, — новый спрайт
 * должен быть виден сразу, а не через полчаса поисков.
 */
const FALLBACK: Prop3 = { shape: 'box', h: 1.0, tone: 'metal' };

/** Прямоугольник на полу в тайлах: левый верхний угол и габарит. */
export interface FloorRect {
  x: number;
  y: number;
  w: number;
  d: number;
}

/** Предмет, готовый к отрисовке: где стоит, какого размера, чем повёрнут. */
export interface Placed3 {
  key: string;
  sprite: string;
  def: Prop3;
  /** Якорь предмета в раскладке (`at`) — то, чем оперирует правка расстановки.
   *  Центр `cx/cy` для неё не годится: он посчитан из следа и у разных
   *  предметов отстоит от якоря по-разному. */
  ax: number;
  ay: number;
  /** центр в плане, тайлы */
  cx: number;
  cy: number;
  /** габарит: ширина по x, глубина по y, высота */
  w: number;
  d: number;
  h: number;
  /** отметка низа: 0 — на полу, выше — стоит на другом предмете или висит */
  base: number;
  /** поворот вокруг своей оси, радианы */
  rot: number;
}

export function defOf(sprite: string): Prop3 {
  return PROPS[sprite] ?? FALLBACK;
}

/**
 * След предмета на полу.
 *
 * Общее правило: **след прижат к нижней кромке арта**. Так нарисован вид
 * сверху — дальний край предмета уходит вверх по картинке, ближний совпадает
 * с тем, где предмет стоит, — и так же посчитаны `footprint` в каталоге
 * (у стола `0.4 + 1.0 = 1.4` при высоте арта `1.375`). Поэтому когда каталог
 * след описал, берём его; когда нет — строим от нижней кромки на глубину из
 * таблицы.
 *
 * `scale` из раскладки растягивает только след. Высоту он не трогает
 * намеренно: она задана человеком, а не артом, и «стол в полтора раза
 * больше» означает столешницу шире, а не стол по грудь.
 */
export function floorRect(cat: Catalog, prop: LayoutProp): FloorRect {
  const sprite = cat.sprites[prop.sprite];
  const def = defOf(prop.sprite);
  const s = prop.scale ?? 1;
  const [ax, ay] = prop.at;
  if (!sprite) return { x: ax, y: ay, w: s, d: s };

  const w = sprite.size[0] * s;
  const artH = sprite.size[1] * s;

  if (def.shape === 'slab') return { x: ax, y: ay, w, d: artH };

  if (sprite.footprint) {
    const [fx, fy, fw, fh] = sprite.footprint;
    return { x: ax + fx * s, y: ay + fy * s, w: fw * s, d: fh * s };
  }

  const d = Math.min((def.d ?? artH * 0.6) * s, artH);
  return { x: ax, y: ay + artH - d, w, d };
}

/**
 * Разложить предметы раскладки по сцене.
 *
 * Две вещи считаются здесь, а не в отрисовке, потому что обе про отношения
 * предметов между собой, а не про то, как они выглядят:
 *
 * 1. **Что на чём стоит.** Если след предмета целиком внутри следа другого —
 *    он на нём и стоит: кружки на столе, приставка на тумбе. Это тот же
 *    приём, что `liftToppings` в плоском рендере, только там он поднимал
 *    предмет по z-порядку, а здесь — на настоящую высоту хозяина.
 * 2. **Куда повёрнуто настенное.** Пресеты писались под плоский рендер и
 *    поворотов не содержат вовсе, но доска, часы и экран обязаны смотреть в
 *    комнату. Ось берётся у ближайшей стены, сторона — по направлению к
 *    центру раскладки. Явный `rot` в раскладке всегда сильнее догадки.
 */
export function place3(
  layout: Layout, cat: Catalog, props: (LayoutProp & { key: string })[],
): Placed3[] {
  const [cols, rows] = layout.size;
  const items: Placed3[] = props.map((prop) => {
    const def = defOf(prop.sprite);
    const r = floorRect(cat, prop);
    return {
      key: prop.key,
      sprite: prop.sprite,
      def,
      ax: prop.at[0],
      ay: prop.at[1],
      cx: r.x + r.w / 2,
      cy: r.y + r.d / 2,
      w: r.w,
      d: def.wall !== undefined ? (def.d ?? 0.12) : r.d,
      h: def.h,
      base: def.wall ?? 0,
      rot: prop.rot !== undefined ? (prop.rot * Math.PI) / 180 : 0,
    };
  });

  // Что на чём стоит. Настенное не поднимаем: оно уже висит, а его тонкая
  // панель легко оказывается «внутри» следа стоящего рядом шкафа.
  for (const item of items) {
    if (item.def.wall !== undefined || item.def.shape === 'slab') continue;
    let lift = 0;
    for (const host of items) {
      if (host === item || host.def.wall !== undefined) continue;
      if (host.def.shape === 'slab') continue;
      const inside =
        item.cx - item.w / 2 >= host.cx - host.w / 2 - 1e-6 &&
        item.cx + item.w / 2 <= host.cx + host.w / 2 + 1e-6 &&
        item.cy - item.d / 2 >= host.cy - host.d / 2 - 1e-6 &&
        item.cy + item.d / 2 <= host.cy + host.d / 2 + 1e-6;
      if (inside) lift = Math.max(lift, host.base + host.h);
    }
    item.base = lift;
  }

  // Настенное прижимается к стене и разворачивается в комнату.
  const walls = layout.walls ?? [];
  for (const item of items) {
    if (item.def.wall === undefined) continue;
    let best: { horizontal: boolean; at: number; dist: number } | null = null;
    for (const wall of walls) {
      const [ax, ay] = wall.a;
      const [bx, by] = wall.b;
      const horizontal = ay === by;
      // Расстояние до отрезка меряем по одной оси — вдоль другой он тянется,
      // и попадание в его пределы проверяем отдельно.
      const along = horizontal ? item.cx : item.cy;
      const lo = Math.min(horizontal ? ax : ay, horizontal ? bx : by);
      const hi = Math.max(horizontal ? ax : ay, horizontal ? bx : by);
      if (along < lo - 1 || along > hi + 1) continue;
      const at = horizontal ? ay : ax;
      const dist = Math.abs((horizontal ? item.cy : item.cx) - at);
      if (!best || dist < best.dist) best = { horizontal, at, dist };
    }

    // В какую сторону комната. Якорь настенного предмета в раскладке стоит на
    // самой стене, поэтому «в какой половине комнаты он оказался» и есть
    // ответ, с какой стороны стены жизнь. Для внутренней стены, у которой
    // комнаты с обеих сторон, правило врёт — там нужен явный `rot`.
    const horizontal = best?.horizontal ?? true;
    const inner = horizontal ? item.cy < rows / 2 : item.cx < cols / 2;
    const side = inner ? 1 : -1;

    // Панель ложится на внутреннюю грань стены: клетка стены `at` занимает
    // [at, at+1), сама стена нарисована толщиной WALL_THICK по её центру.
    if (best) {
      const face = best.at + 0.5 + side * (WALL_THICK / 2 + (item.def.d ?? 0.12) / 2);
      if (horizontal) item.cy = face; else item.cx = face;
    }
    if (item.rot === 0) {
      item.rot = horizontal
        ? (side > 0 ? 0 : Math.PI)
        : (side > 0 ? Math.PI / 2 : -Math.PI / 2);
    }
  }

  return items;
}

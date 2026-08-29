/**
 * Размещение предметов в сцене: раскладка плюс пресеты → коробки на полу.
 *
 * Раньше здесь же лежала таблица `PROPS` — то, что известно про каждый
 * предмет. Теперь это знание живёт в `design/presets/<id>/preset.json`
 * (docs/design/office-presets/spec.md), а модуль занимается только тем, ради
 * чего был нужен: считает, где предмет стоит, какого размера, что на чём и
 * куда повёрнуто настенное.
 *
 * Про материалы, свет и модели здесь по-прежнему ничего нет — это `Props3D`,
 * `Lights3D` и палитра.
 */
import type { Preset } from '../../shared/preset';
import type { Catalog, Layout, LayoutProp } from '../../shared/layout';
import { propScale } from '../../shared/layout';
import { WALL_THICK } from './geometry';
import { isFlat, presetOf, wallMount } from './presets';

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
  def: Preset;
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

/**
 * След предмета на полу.
 *
 * Раньше здесь было три ветки: у плоского на полу след равен всему арту, у
 * описанного в каталоге взят оттуда, у остальных построен от нижней кромки на
 * глубину из таблицы. Три ветки на одно число — и, как выяснилось при
 * переносе, второе такое же число считалось по другому правилу в
 * `passability`: диван рисовался глубиной 1.25 тайла, а перегораживал 1.75.
 *
 * Теперь след записан в пресете, один на оба применения, и веток нет.
 *
 * Растяжение из раскладки (`scale` или явный `size`, §3.2) трогает только
 * след. Высоту оно не трогает намеренно: она задана человеком, а не артом, и
 * «стол в полтора раза больше» означает столешницу шире, а не стол по грудь.
 */
export function floorRect(cat: Catalog, prop: LayoutProp): FloorRect {
  const sprite = cat.sprites[prop.sprite];
  const def = presetOf(prop.sprite);
  const [sx, sy] = propScale(prop, sprite);
  const [ax, ay] = prop.at;
  const [fx, fy, fw, fh] = def.footprint;
  return { x: ax + fx * sx, y: ay + fy * sy, w: fw * sx, d: fh * sy };
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
    const def = presetOf(prop.sprite);
    const wall = wallMount(def);
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
      // У настенного глубина — это толщина панели, а не след: висящая доска
      // пола не занимает вовсе.
      d: wall ? (wall.thickness ?? 0.12) : r.d,
      h: def.h,
      base: wall ? wall.at : 0,
      rot: prop.rot !== undefined ? (prop.rot * Math.PI) / 180 : 0,
    };
  });

  // Что на чём стоит. Настенное не поднимаем: оно уже висит, а его тонкая
  // панель легко оказывается «внутри» следа стоящего рядом шкафа.
  for (const item of items) {
    if (wallMount(item.def) || isFlat(item.def)) continue;
    let lift = 0;
    for (const host of items) {
      if (host === item || wallMount(host.def) || isFlat(host.def)) continue;
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
    const wall = wallMount(item.def);
    if (!wall) continue;
    let best: { horizontal: boolean; at: number; dist: number } | null = null;
    for (const w of walls) {
      const [ax, ay] = w.a;
      const [bx, by] = w.b;
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
      const face = best.at + 0.5 + side * (WALL_THICK / 2 + item.d / 2);
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

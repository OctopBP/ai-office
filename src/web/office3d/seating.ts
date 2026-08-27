/**
 * Правило посадки: где оказывается фигура, приведённая к месту.
 *
 * Считается из трёх источников, и ни один не подобран на глаз:
 *
 * — **место** говорит, где сидят в плане (каталог, общий с плоским рендером);
 * — **мебель** говорит, на какой высоте у неё подушка и столешница — это
 *   замер по модели (`measure.ts`), а не габарит из каталога: в каталоге
 *   записан предмет целиком, а сесть надо на сиденье;
 * — **клип** говорит, где в этой позе таз относительно ступней, — тоже замер,
 *   потому что клипы нарисованы под человека обычного сложения, а перенесены
 *   на скелет с короткими ногами.
 *
 * Дальше правило одно: стоячая поза ставится ступнями на пол, сидячая — тазом
 * на подушку. Разница между «поставить ступнями» и «поставить тазом» и есть
 * те двадцать сантиметров, на которые фигура тонула в стуле.
 *
 * Живёт отдельно от `Agents3D`, потому что то же самое считает стенд
 * подгонки: показывать он должен ровно то, что окажется в комнате, а не
 * похожее.
 */
import { PROPS } from './props';
import { placeFit, poseFit, type Fit } from './fit';
import type { ModelMeasure, PoseMeasure } from './measure';

export interface Seating {
  /** Куда поднять фигуру относительно точки места: вправо, вверх, вперёд. */
  lift: [number, number, number];
  /** Высота, на которую тянуть кисти, или null — тянуть не надо. */
  handsY: number | null;
  /** Садится ли фигура тазом (иначе стоит ступнями). */
  sits: boolean;
  /** Что удалось измерить — стенду показать, откуда взялись числа. */
  seatY?: number;
  surfaceY?: number;
}

/**
 * Посадка для позы в месте.
 *
 * `sprite` — предмет места (стол, диван, автомат) или ничего, если человек
 * просто стоит посреди комнаты. `shape` — замер той позы, в которой он на
 * месте окажется.
 */
export function seatingFor(
  fit: Fit,
  models: Record<string, ModelMeasure>,
  shape: PoseMeasure,
  pose: string,
  sprite: string | undefined,
  tall: number,
): Seating {
  const def = sprite ? PROPS[sprite] : undefined;
  const place = placeFit(fit, sprite);
  const rest = poseFit(fit, pose);
  const scale = fit.figure.furniture;

  const seatY = def?.fit?.seat ? models[def.fit.seat]?.seat : undefined;
  const surfaceY = place.surface ?? (def?.fit?.surface
    ? models[def.fit.surface]?.surface
    : undefined);

  /**
   * Сидячая поза ставится тазом. Мест без замеренного сиденья это не
   * касается: у пуфика модели нет, и агент садится на него так же, как
   * садился раньше, — ступнями в точку места.
   */
  const sits = rest.anchor === 'hips' && seatY !== undefined;
  const lift: [number, number, number] = sits
    ? [
      place.seat[0] + rest.offset[0] - shape.hips[0] * tall,
      (seatY as number) * scale + fit.seated.hipsOverSeat + place.seat[1]
        + rest.offset[1] - shape.hips[1] * tall,
      place.seat[2] + rest.offset[2] - shape.hips[2] * tall,
    ]
    : [...rest.offset];

  /**
   * Куда тянуть кисти — высота рабочей поверхности. Только высота: где
   * именно на столе лежат руки, решает клип, и придумывать за него положение
   * клавиатуры не наше дело. Нет поверхности (диван, приставка) — не тянем.
   */
  const handsY = rest.reach && surfaceY !== undefined && fit.seated.ik
    ? surfaceY * scale + fit.seated.handsOverSurface
    : null;

  return { lift, handsY, sits, seatY, surfaceY };
}

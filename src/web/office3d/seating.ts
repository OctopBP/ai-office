/**
 * Правило посадки: где оказывается фигура, приведённая к месту.
 *
 * Считается из трёх источников, и ни один не подобран на глаз:
 *
 * — **место** говорит, где сидят в плане (компонент `seat` или `work`);
 * — **мебель** говорит, на какой высоте у неё подушка и столешница — это
 *   замер по модели (`measure.ts`), а не габарит предмета: в габарите записан
 *   предмет целиком, а сесть надо на сиденье;
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
import { componentOf } from '../../shared/preset';
import { presetOf, resolveRef } from './presets';
import { poseFit, type Fit } from './fit';
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
  const preset = sprite ? presetOf(sprite) : undefined;
  const rest = poseFit(fit, pose);
  const scale = fit.figure.furniture;

  /**
   * Чем сидят — берётся у того компонента места, который на этом предмете
   * есть. У дивана это `seat`, у стола — `work`: за столом не два места, а
   * одно, и посадка описана прямо в нём (см. `shared/preset.ts`).
   */
  const at = preset
    ? componentOf(preset, 'seat') ?? componentOf(preset, 'work')
    : undefined;
  const offset = at?.offset ?? [0, 0, 0];

  const seatY = preset && at?.on
    ? at.height ?? models[resolveRef(preset, at.on)]?.seat
    : undefined;
  const surface = preset ? componentOf(preset, 'surface') : undefined;
  const surfaceY = preset && surface
    ? surface.height ?? models[resolveRef(preset, surface.on)]?.surface
    : undefined;

  /**
   * Сидячая поза ставится тазом. Мест без замеренного сиденья это не
   * касается: у пуфика модели нет, и агент садится на него так же, как
   * садился раньше, — ступнями в точку места.
   */
  const sits = rest.anchor === 'hips' && seatY !== undefined;
  const lift: [number, number, number] = sits
    ? [
      offset[0] + rest.offset[0] - shape.hips[0] * tall,
      (seatY as number) * scale + fit.seated.hipsOverSeat + offset[1]
        + rest.offset[1] - shape.hips[1] * tall,
      offset[2] + rest.offset[2] - shape.hips[2] * tall,
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

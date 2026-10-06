/**
 * Режим «узкое окно» (спека окон §2.9): размер окна → что помещается.
 * Чистые функции без React и DOM; режим вычисляется, в сохранённое состояние
 * не пишется. Перенос вкладок боковых доков вниз — `displayLayout` в model.ts.
 */
import { NARROW_W, type DockId } from './model';

/** Ниже — рейл сворачивается сам (≥ NARROW_W он ещё нужен как есть). */
export const RAIL_AUTO_W = 1100;
/** Доля ширины колонки под левый и правый доки вместе на средней ширине. */
export const SIDE_RATIO = 0.4;
/** Ниже этой высоты окна нижний док не больше половины колонки. */
export const SHORT_H = 520;
export const BOTTOM_RATIO_SHORT = 0.5;
/** Нижняя граница боковых доков при дележе бюджета 40 %. */
export const SIDE_FLOOR = 120;

export type NarrowTier = 'wide' | 'medium' | 'narrow';

export interface NarrowMode {
  tier: NarrowTier;
  /** Рейл сворачивается в 70 px автоматически. */
  collapseRail: boolean;
  /** Боковые доки показываются вкладками нижнего. */
  sideToBottom: boolean;
  /** Бюджет ширины боковых доков вместе, доля колонки; null — без ограничения сверх модели. */
  sideRatio: number | null;
  /** Потолок нижнего дока, доля высоты колонки; null — без ограничения сверх модели. */
  bottomRatio: number | null;
}

export function narrowMode(viewport: { w: number; h: number }): NarrowMode {
  const tier: NarrowTier = viewport.w < NARROW_W ? 'narrow' : viewport.w < RAIL_AUTO_W ? 'medium' : 'wide';
  return {
    tier,
    collapseRail: tier !== 'wide',
    sideToBottom: tier === 'narrow',
    sideRatio: tier === 'medium' ? SIDE_RATIO : null,
    bottomRatio: viewport.h < SHORT_H ? BOTTOM_RATIO_SHORT : null,
  };
}

/**
 * Размеры доков под режим. Левый и правый вместе не шире бюджета (делятся
 * пропорционально, но не меньше SIDE_FLOOR); нижний — не выше доли высоты.
 * Нет дока (размер 0) — не трогаем.
 */
export function fitDockSizes(
  sizes: Partial<Record<DockId, number>>,
  mode: NarrowMode,
  col: { w: number; h: number },
): Partial<Record<DockId, number>> {
  const out = { ...sizes };
  if (mode.sideRatio !== null) {
    const budget = Math.floor(col.w * mode.sideRatio);
    const l = out.left ?? 0;
    const r = out.right ?? 0;
    if (l + r > budget) {
      const k = budget / (l + r);
      if (l) out.left = Math.max(SIDE_FLOOR, Math.floor(l * k));
      if (r) out.right = Math.max(SIDE_FLOOR, Math.floor(r * k));
    }
  }
  if (mode.bottomRatio !== null && out.bottom) {
    out.bottom = Math.min(out.bottom, Math.floor(col.h * mode.bottomRatio));
  }
  return out;
}

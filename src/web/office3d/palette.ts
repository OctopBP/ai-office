/**
 * Цвета и свет трёхмерной сцены — единственное место, где живёт «как это
 * выглядит». Ассеты сюда не приходят: на шаге 1 вся сцена собрана из коробок,
 * материалы плоские (без текстур и отражений), поэтому вид офиса — это
 * буквально десяток чисел ниже.
 *
 * День и ночь в 3D перестают быть вторым набором картинок и становятся
 * другим освещением: тот же меш, другой свет. Пока темы отличаются цветом и
 * силой источников, а не геометрией.
 */
import type { Theme } from '../sprites';
import type { Floor3 } from './geometry';

export interface Palette {
  /** фон за пределами комнаты */
  backdrop: string;
  /** плита под всей раскладкой — то, на чём стоят стены */
  ground: string;
  /** материалы пола комнат */
  floor: Record<Floor3['material'], string>;
  /** стена и её торец сверху */
  wall: string;
  wallTop: string;
  /** заливка оконного проёма (тонкое «стекло» в дырке) */
  glass: string;
  glassOpacity: number;
  light: {
    /** заполняющий свет: цвет неба, цвет отражения от пола, сила */
    skyColor: string;
    groundColor: string;
    ambient: number;
    /** основной направленный источник — он же единственный, кто даёт тени */
    keyColor: string;
    keyIntensity: number;
    /**
     * Положение источника относительно центра комнаты, тайлы. Важна не сила,
     * а высота: почти отвесный свет даёт тень короче полуметра, и её не
     * видно вовсе. Здесь солнце держится около 40° над горизонтом — тень
     * стены выходит длиной примерно в три тайла и наконец читается.
     */
    keyOffset: [number, number, number];
    /**
     * Заполняющий направленный источник с противоположной стороны. Без него
     * стены, повёрнутые от основного света, освещены одним полусферическим
     * и уходят в грязно-серое: сцена из плоских цветов очень чувствительна к
     * тому, что у неё есть ровно одно направление света. Теней не бросает —
     * иначе их было бы две, и обе неправдоподобные.
     */
    fillColor: string;
    fillIntensity: number;
    fillOffset: [number, number, number];
  };
}

export const PALETTES: Record<Theme, Palette> = {
  day: {
    backdrop: '#e8eaee',
    ground: '#c8ccd4',
    floor: {
      parquet: '#d9b183',
      carpet: '#9aa8bb',
      tile: '#dfe4ea',
    },
    wall: '#f0f2f5',
    wallTop: '#dcdfe6',
    glass: '#bcd8e8',
    glassOpacity: 0.25,
    light: {
      skyColor: '#ffffff',
      groundColor: '#e2e6ec',
      ambient: 0.6,
      keyColor: '#fff4e6',
      keyIntensity: 2.2,
      keyOffset: [-20, 20, -15],
      fillColor: '#dfe9ff',
      fillIntensity: 0.28,
      fillOffset: [16, 11, 14],
    },
  },
  night: {
    backdrop: '#14171f',
    ground: '#20242e',
    floor: {
      parquet: '#6b543d',
      carpet: '#414c5e',
      tile: '#4a5260',
    },
    wall: '#333a47',
    wallTop: '#252b36',
    glass: '#1a2634',
    glassOpacity: 0.45,
    light: {
      skyColor: '#8ea2d0',
      groundColor: '#3a414f',
      ambient: 0.45,
      keyColor: '#ffd9a0',
      keyIntensity: 1.5,
      keyOffset: [-16, 15, -12],
      fillColor: '#6f86bd',
      fillIntensity: 0.2,
      fillOffset: [12, 9, 11],
    },
  },
};

export function paletteOf(theme: Theme): Palette {
  return PALETTES[theme] ?? PALETTES.day;
}

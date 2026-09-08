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
import type { LampKind, Tone } from '../../shared/preset';

type PropTone = Tone;

export interface Palette {
  /** фон за пределами комнаты */
  backdrop: string;
  /** плита под всей раскладкой — то, на чём стоят стены */
  ground: string;
  /** материалы пола комнат — цвет, когда текстуры материала нет; материал
   *  не из этого списка без текстуры рисуется цветом плиты `ground` */
  floor: Partial<Record<Floor3['material'], string>>;
  /**
   * Тон текстуры пола: ею умножается картинка из `design/textures/floor`.
   * Днём — белый, картинка как есть; ночью — серый, чтобы пол гас вместе
   * с остальной палитрой, а не светился дневным деревом в тёмной комнате.
   */
  floorTint: string;
  /** линии сетки тайлов по полу; вторая — каждая пятая линия */
  grid: string;
  gridMajor: string;
  /**
   * Режим разработчика (`Dev3D.tsx`): линии сетки, заливка занятой клетки
   * карты проходимости, линия маршрута агента и метка его цели. Сетка здесь
   * не серая линейка, а яркая — в этом режиме её должно быть видно поверх
   * любой текстуры пола и красной заливки. Остальные цвета намеренно
   * «служебные» — красный и бирюзовый не встречаются в обстановке, чтобы
   * оверлей читался поверх любой комнаты и не путался с мебелью.
   */
  dev: { grid: string; blocked: string; route: string; target: string };
  /** стена и её торец сверху — цвет, когда текстуры нет */
  wall: string;
  wallTop: string;
  /** тон текстур стен из `design/textures/wall`, как `floorTint` у пола */
  wallTint: string;
  /** заливка оконного проёма (тонкое «стекло» в дырке) */
  glass: string;
  glassOpacity: number;
  /**
   * Материалы обстановки. Не «цвет стола», а «цвет дерева»: предметов три
   * десятка, а материалов семь, и когда мебель заменят на настоящие модели,
   * эти семь останутся тем, подо что модели красить.
   */
  prop: Record<PropTone, string>;
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
  /**
   * Светильники самой комнаты — то, чем офис отличается от макета под
   * солнцем. Солнце и заполняющий свет выше рисуют объём, но одинаково по
   * всей раскладке; уют начинается там, где у света есть источник: лампа под
   * потолком, торшер в лаунже, вывеска, экран монитора. Каждый из них —
   * точечный источник с затуханием, поэтому у него есть не только цвет и
   * сила, но и радиус, за которым он ничего не освещает.
   *
   * Теней они не бросают: карта теней у каждого точечного источника — это
   * шесть проходов рендера, и на десяток ламп в комнате их не напасёшься.
   * Тени в сцене по-прежнему одни, солнечные.
   */
  lamp: Record<LampKind | 'ceiling', LampLight>;
}

/** Один сорт светильника. */
export interface LampLight {
  /** цвет самого света */
  color: string;
  /**
   * Цвет светящейся поверхности — экрана, трубки вывески. Нужен только тем
   * лампам, у которых эта поверхность в сцене есть; у потолочной её нет —
   * плафон не рисуется (см. `CeilingLamp`), — и цвета свечения у неё тоже.
   */
  glow?: string;
  /** сила в канделах: у настоящей лампы освещённость падает как квадрат расстояния */
  intensity: number;
  /** радиус, дальше которого источник не светит вовсе, тайлы */
  distance: number;
  /**
   * Как быстро свет убывает с расстоянием. Двойка — физика; меньше — свет
   * растекается шире, чем в жизни.
   *
   * Честная двойка на потолочном светильнике даёт под ним белое пятно, а в
   * трёх шагах — уже темноту: комната распадается на круги света и провалы
   * между ними. Плафон под потолком — это не точка, а рассеиватель, и
   * пологое затухание передаёт его лучше, чем точный закон для точки.
   * Экранам и вывескам, наоборот, оставлена двойка: их свет и должен
   * кончаться у края стола.
   */
  decay: number;
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
    floorTint: '#ffffff',
    grid: '#8b8f98',
    gridMajor: '#4d525c',
    dev: { grid: '#1b5cff', blocked: '#e0443a', route: '#0f9b8e', target: '#e0443a' },
    wall: '#f0f2f5',
    wallTop: '#dcdfe6',
    wallTint: '#ffffff',
    glass: '#bcd8e8',
    glassOpacity: 0.25,
    prop: {
      wood: '#c9a06b',
      metal: '#b3bac6',
      fabric: '#8a93a8',
      leaf: '#6f9e63',
      screen: '#39414f',
      accent: '#d98b6a',
      light: '#f0e3c2',
    },
    light: {
      skyColor: '#ffffff',
      groundColor: '#e9e3d8',
      ambient: 0.5,
      keyColor: '#ffeed4',
      keyIntensity: 2.2,
      keyOffset: [-20, 20, -15],
      fillColor: '#dfe9ff',
      fillIntensity: 0.28,
      fillOffset: [16, 11, 14],
    },
    lamp: {
      ceiling: { color: '#ffdcae', intensity: 3.4, distance: 15, decay: 1.2 },
      warm: { color: '#ffca85', glow: '#ffe6bd', intensity: 3, distance: 9, decay: 1.4 },
      neon: { color: '#ff7ad9', glow: '#ffa8e6', intensity: 4, distance: 6, decay: 2 },
      screen: { color: '#cfe2ff', glow: '#9fc2ee', intensity: 0.5, distance: 3.5, decay: 2 },
    },
  },
  night: {
    backdrop: '#161a23',
    ground: '#2b313d',
    floor: {
      parquet: '#836848',
      carpet: '#4e5a73',
      tile: '#59626f',
    },
    floorTint: '#8a8f9a',
    grid: '#8d97a8',
    gridMajor: '#c6d0e0',
    dev: { grid: '#6aa8ff', blocked: '#ff6b5e', route: '#3fd6c6', target: '#ff6b5e' },
    wall: '#4a5464',
    wallTop: '#39424f',
    wallTint: '#8a8f9a',
    glass: '#1a2634',
    glassOpacity: 0.45,
    prop: {
      wood: '#7a6244',
      metal: '#5f6775',
      fabric: '#4d5468',
      leaf: '#456b45',
      screen: '#242b38',
      accent: '#8f5c46',
      light: '#c9b78d',
    },
    light: {
      skyColor: '#8ea2d0',
      groundColor: '#453f47',
      ambient: 0.38,
      keyColor: '#ffcb8a',
      keyIntensity: 1.1,
      keyOffset: [-16, 15, -12],
      fillColor: '#6f86bd',
      fillIntensity: 0.14,
      fillOffset: [12, 9, 11],
    },
    lamp: {
      ceiling: { color: '#ffc47e', intensity: 6.4, distance: 17, decay: 1.2 },
      warm: { color: '#ffa947', glow: '#ffd291', intensity: 5.5, distance: 11, decay: 1.4 },
      neon: { color: '#ff5ecb', glow: '#ff8ade', intensity: 8, distance: 8, decay: 2 },
      screen: { color: '#9fc8ff', glow: '#7ba7e0', intensity: 0.9, distance: 4, decay: 2 },
    },
  },
};

export function paletteOf(theme: Theme): Palette {
  return PALETTES[theme] ?? PALETTES.day;
}

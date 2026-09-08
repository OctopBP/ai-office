/**
 * Настройки картинки трёхмерного офиса. Живут на клиенте: это про то, как
 * выглядит комната на этом экране, а не про то, как устроен офис, — поэтому
 * не едут на сервер вместе с остальными настройками, а лежат в localStorage
 * рядом с темой и выбором рендера.
 */

export interface Graphics {
  /** Пикселизация: рендер в низком разрешении с контуром по граням. */
  pixelate: boolean;
  /** Сторона экранного «пикселя» в css-точках. */
  pixelSize: number;
  /** Светлый контур на изломах поверхности (по нормалям). */
  normalEdge: number;
  /** Тёмный контур на границе предметов (по глубине). */
  depthEdge: number;
  /**
   * Сетка тайлов по всему полу — линейка, а не украшение.
   *
   * След предмета задаётся в тайлах, проходимость считается по ним же, а на
   * глаз в комнате тайла не видно: мебель, ставшая вдвое больше, выглядит
   * просто крупной мебелью. С сеткой это становится измеримым — видно, на
   * сколько клеток предмет лёг и совпадает ли это с тем, что записано в
   * пресете.
   */
  grid: boolean;
  /**
   * Режим разработчика: сетка тайлов, занятые клетки карты проходимости и
   * маршруты, по которым стор ведёт агентов (`Dev3D.tsx`).
   *
   * Отдельный флаг, а не «сетка плюс ещё что-то»: сетка — линейка, ею
   * пользуются и при расстановке мебели, а занятые клетки и ломаные путей
   * отвечают на другой вопрос — «почему агент пошёл именно так и почему не
   * дошёл». Смотреть на них постоянно незачем, включаются клавишей G.
   */
  dev: boolean;
}

/**
 * Умолчания. Пикселизация включена: ветка трёхмерного офиса ради этого вида и
 * заведена, а выключатель рядом. Размер пикселя мельче, чем в примере three.js
 * (там 6): офис — это план комнаты целиком, и на крупном пикселе стол
 * перестаёт быть столом.
 *
 * Сила контуров взята из примера как есть — она подобрана под ту же связку
 * «низкое разрешение плюс два контура» и на нашей сцене читается так же.
 */
export const DEFAULT_GRAPHICS: Graphics = {
  pixelate: true,
  pixelSize: 4,
  normalEdge: 0.3,
  depthEdge: 0.4,
  grid: false,
  dev: false,
};

/** Пределы ползунков — они же границы, по которым чинится значение из
 *  localStorage. Диапазоны из примера three.js, шаг подобран под них. */
export const GRAPHICS_RANGE = {
  pixelSize: { min: 1, max: 16, step: 1 },
  normalEdge: { min: 0, max: 2, step: 0.05 },
  depthEdge: { min: 0, max: 1, step: 0.05 },
} as const;

const KEY = 'office-graphics';

function clamp(v: unknown, fallback: number, range: { min: number; max: number }): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(range.max, Math.max(range.min, v))
    : fallback;
}

/**
 * Прочитать сохранённое. Настройки картинки переживают и правку руками, и
 * смену набора полей между версиями, поэтому каждое значение проверяется
 * отдельно, а не берётся целиком: испорченный ключ должен стоить дефолтной
 * картинки, а не пустого экрана.
 */
export function loadGraphics(): Graphics {
  let saved: Partial<Graphics> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) saved = JSON.parse(raw) as Partial<Graphics>;
  } catch {
    saved = {};
  }
  return {
    pixelate: typeof saved.pixelate === 'boolean' ? saved.pixelate : DEFAULT_GRAPHICS.pixelate,
    pixelSize: Math.round(
      clamp(saved.pixelSize, DEFAULT_GRAPHICS.pixelSize, GRAPHICS_RANGE.pixelSize)),
    normalEdge: clamp(saved.normalEdge, DEFAULT_GRAPHICS.normalEdge, GRAPHICS_RANGE.normalEdge),
    depthEdge: clamp(saved.depthEdge, DEFAULT_GRAPHICS.depthEdge, GRAPHICS_RANGE.depthEdge),
    grid: typeof saved.grid === 'boolean' ? saved.grid : DEFAULT_GRAPHICS.grid,
    dev: typeof saved.dev === 'boolean' ? saved.dev : DEFAULT_GRAPHICS.dev,
  };
}

export function saveGraphics(g: Graphics): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    // Приватный режим браузера — настройка просто не переживёт перезагрузку.
  }
}

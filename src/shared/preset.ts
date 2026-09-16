/**
 * Пресет предмета обстановки — схема и разбор (docs/design/office-presets/spec.md).
 *
 * Предмет описан одним файлом `design/presets/<id>/preset.json`, а не четырьмя
 * записями в четырёх форматах, как было до этого: размер и след жили в
 * `catalog.json` (и заполнялись рукописными таблицами внутри генератора арта),
 * высота и материал — в `PROPS`, список моделей — в `models.ts`, поправки
 * посадки — в `fit.json`. Забыть одно из четырёх было легко, и ошибка выходила
 * молчаливой: предмет без `blocks` проходим насквозь, предмет без строки в
 * `models.ts` рисуется кубиком.
 *
 * Файл делится надвое, и деление это смысловое, а не для красоты:
 *
 * — **ядро** — то, чем предмет является: размер, след, высота, из каких
 *   моделей собран. Есть у любого предмета, поэтому лежит плоскими полями:
 *   заворачивать в компоненты то, что есть всегда, значит заставить каждого
 *   читателя искать заведомо имеющееся;
 *
 * — **компоненты** — то, что предмет умеет: на нём сидят, он светит, у него
 *   есть рабочая поверхность. Это открытый набор, поэтому массив
 *   тегированного объединения, а не набор необязательных полей. Массив, а не
 *   поля, ещё и потому, что способность бывает не одна: у аркадного автомата
 *   сегодня ровно одна лампа только оттого, что поле `lamp` было одиночным.
 *
 * Чего здесь нет намеренно: высоты сиденья, высоты столешницы и цвета света.
 * Первые две — факты, они меряются лучом по модели при загрузке (`measure.ts`)
 * и меняются сами вместе с моделью; в схеме им отведён только необязательный
 * `null`-перебив. Цвет и сила света принадлежат теме (`palette.ts`), которая
 * различает день и ночь: записанный в пресете `#ffffff` означал бы лампу,
 * которая на смену времени суток не реагирует.
 */
import { z } from 'zod';
import type { CatalogSlot, CatalogSprite } from './layout';

/** Материал предмета — ключ в `palette.prop`, а не цвет (см. шапку). */
export const TONES = ['wood', 'metal', 'fabric', 'leaf', 'screen', 'accent', 'light'] as const;
export type Tone = (typeof TONES)[number];

/** Запасной примитив: чем рисовать предмет, пока модели нет. */
export const SHAPES = [
  'desk', 'table', 'round', 'chair', 'cabinet', 'appliance',
  'counter', 'soft', 'plant', 'panel', 'slab', 'box',
] as const;
export type Shape = (typeof SHAPES)[number];

/** Сорт светильника. Цвет, силу, радиус и затухание задаёт палитра. */
export const LAMP_KINDS = ['warm', 'neon', 'screen'] as const;
export type LampKind = (typeof LAMP_KINDS)[number];

const vec2 = z.tuple([z.number(), z.number()]);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const rect = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/**
 * Одна модель в составе предмета.
 *
 * `name` — то, чем часть зовут компоненты (`on`). Имя, а не индекс: индекс
 * сломается при первой же вставке части в середину списка, и сломается тихо.
 */
export const partSchema = z.strictObject({
  file: z.string().min(1),
  name: z.string().min(1).optional(),
  at: vec3.optional(),
  rot: z.number().optional(),
  /**
   * Куда бить лучом, чтобы померить поверхность, — точка в плане модели.
   *
   * Высоту сиденья габаритом не узнать: габарит стула — это спинка, а сидят
   * не на ней. Куда именно целиться — свойство конкретной модели (у стула
   * подушка чуть впереди центра), поэтому число живёт при части, а не в
   * таблице по имени файла, как жило раньше.
   */
  probe: z.strictObject({
    seat: vec2.optional(),
    surface: vec2.optional(),
  }).optional(),
});
export type Part = z.infer<typeof partSchema>;

/** Имя части: `"desk"` — своя, `"chair/model"` — чужая (только меряется). */
const partRef = z.string().min(1);

// ---------------------------------------------------------------------------
// Компоненты
// ---------------------------------------------------------------------------

/**
 * Где сидят.
 *
 * Сливает три прежние формы слота (`SlotPoint`/`SlotSide`/`SlotRing`), ссылку
 * `PROPS.fit.seat` и поправку из `fit.json → places[].seat`. Форма выбирается
 * полем `shape`, а не отдельным типом компонента: сорт места один и тот же,
 * различается только способ разложить места по предмету.
 *
 * Разделение измеряемого и вкусового проходит прямо внутри: `at` — решение
 * («сидеть у переднего края подушки, а не в середине предмета, где спинка»),
 * `height` — факт, который меряется по модели.
 */
/** Стороны, с которых заходят на место: север — меньший `y`, юг — больший. */
const approachSides = z.array(z.enum(['n', 's', 'e', 'w'])).min(1);

export const seatSchema = z.strictObject({
  type: z.literal('seat'),
  shape: z.enum(['point', 'side', 'ring']),
  /** Чем на месте занимаются: у приставки играют, на свободном просто сидят. */
  use: z.enum(['sit', 'game']).optional(),
  /**
   * С каких сторон на место заходят и с каких с него сходят.
   *
   * Место лежит на самом предмете — подушка дивана это диван, — и клетка под
   * ним занята. Без этого поля поиск пути считал годным любой заход на неё:
   * агент садился на диван, зайдя из-за спинки или перелезши подлокотник.
   * Стороны — в координатах предмета, поворот не учитывается (как и у
   * `footprint`).
   */
  approach: approachSides.optional(),
  /** Часть, по которой мерить высоту подушки. */
  on: partRef.optional(),
  /** Перебив измеренной высоты сиденья; null — мерить. */
  height: z.number().nullable().optional(),
  /** Поправка посадки — её крутит стенд `?fit=1`. */
  offset: vec3.optional(),
  // shape: 'point'
  at: vec2.optional(),
  // shape: 'side' — ряд вдоль стороны, шаг считается от размера предмета
  side: z.enum(['n', 's', 'e', 'w']).optional(),
  count: z.number().int().positive().optional(),
  // shape: 'ring' — эллипс мест вокруг центра, растущий при лишних участниках
  ring: z.number().int().positive().optional(),
  rx: z.number().optional(),
  ry: z.number().optional(),
  grow: z.boolean().optional(),
}).superRefine((v, ctx) => {
  // Проверяем не «есть ли поле», а «то ли поле»: слот-точка с `count` — это
  // не безобидный мусор, а признак того, что автор имел в виду другую форму.
  const need: Record<string, string[]> = {
    point: ['at'],
    side: ['side', 'count'],
    ring: ['ring', 'rx', 'ry'],
  };
  const all = ['at', 'side', 'count', 'ring', 'rx', 'ry', 'grow'];
  const mine = new Set(need[v.shape].concat(v.shape === 'ring' ? ['grow'] : []));
  for (const key of need[v.shape]) {
    if ((v as Record<string, unknown>)[key] === undefined) {
      ctx.addIssue({ code: 'custom', message: `seat/${v.shape}: нет обязательного «${key}»` });
    }
  }
  for (const key of all) {
    if (!mine.has(key) && (v as Record<string, unknown>)[key] !== undefined) {
      ctx.addIssue({ code: 'custom', message: `seat/${v.shape}: лишнее поле «${key}»` });
    }
  }
});

/**
 * Рабочее место.
 *
 * Носит те же поля посадки, что и `seat`, и это не дубль: за столом **не два
 * места, а одно**. Прежние данные описывали его врозь — точка в слоте `work`
 * каталога, модель для замера в `PROPS.fit.seat`, поправка в `fit.json`, — и
 * связь держалась на том, что у стола не бывает слота `seat`. Компонент,
 * который знает про себя всё, эту негласную договорённость снимает.
 *
 * От `seat` отличается тем, что при нём работают: к `surface` тянутся кисти.
 */
export const workSchema = z.strictObject({
  type: z.literal('work'),
  at: vec2,
  /** С каких сторон садятся за стол — обычно со всех, кроме самого стола. */
  approach: approachSides.optional(),
  /** Часть, по которой мерить высоту сиденья. Обычно чужая — стул рядом. */
  on: partRef.optional(),
  height: z.number().nullable().optional(),
  offset: vec3.optional(),
});

/** Табличка с именем владельца стола. */
export const plateSchema = z.strictObject({
  type: z.literal('plate'),
  at: vec2,
});

/** Рабочая поверхность: к ней тянутся кисти обратной кинематикой. */
export const surfaceSchema = z.strictObject({
  type: z.literal('surface'),
  on: partRef,
  /** Перебив измеренной высоты столешницы; null — мерить. */
  height: z.number().nullable().optional(),
});

/**
 * Свой источник света.
 *
 * Объявляется только сорт: одна и та же настольная лампа днём и ночью светит
 * по-разному, и знать об этом должна тема, а не предмет. `gain` — множитель к
 * палитре, а не замена ей: относительная поправка переживает смену темы,
 * абсолютный цвет — нет.
 */
export const lampSchema = z.strictObject({
  type: z.literal('lamp'),
  lamp: z.enum(LAMP_KINDS),
  at: vec3.optional(),
  /** Светится вся лицевая сторона, а не одна точка: экран, вывеска. */
  face: z.literal(true).optional(),
  /** Горит, только пока за предметом работают. Монитор — не лампа. */
  busy: z.literal(true).optional(),
  gain: z.number().positive().optional(),
  /**
   * Половинный угол конуса, градусы. Есть угол — лампа светит не во все
   * стороны, а вниз, пятном на полу: торшер под абажуром. Без угла источник
   * точечный: вывеска, экран.
   */
  cone: z.number().gt(0).max(90).optional(),
});

/**
 * Материал внутри модели, который зажигается вместе с лампой, — стекло
 * монитора. Подменять именованный материал надёжнее, чем угадывать по
 * геометрии, где у модели лицо: ошибка в имени видна сразу, ошибка в
 * координате — нет.
 */
export const glowSchema = z.strictObject({
  type: z.literal('glow'),
  material: z.string().min(1),
  /** Какая лампа зажигает, если их несколько. */
  with: z.string().min(1).optional(),
});

/**
 * Висит на стене.
 *
 * Это настоящий компонент, а не поле: его наличие меняет **логику
 * размещения** — предмет прижимается к ближайшей стене, разворачивается в
 * комнату и не поднимается на другие предметы, как поднялись бы кружки на
 * стол.
 */
export const wallMountedSchema = z.strictObject({
  type: z.literal('wall_mounted'),
  /** Высота низа над полом: доску вешают на уровень глаз, дверь стоит на полу. */
  at: z.number(),
  /** Толщина панели. Не глубина следа: настенное следа не оставляет. */
  thickness: z.number().positive().optional(),
});

export const componentSchema = z.discriminatedUnion('type', [
  seatSchema, workSchema, plateSchema, surfaceSchema,
  lampSchema, glowSchema, wallMountedSchema,
]);

export type Component = z.infer<typeof componentSchema>;
export type ComponentType = Component['type'];
export type OfType<T extends ComponentType> = Extract<Component, { type: T }>;

/**
 * Кратность — часть схемы, а не соглашение в голове.
 *
 * Второй `surface` у одного стола — ошибка данных, и она обязана падать при
 * разборе. Молча выигранный первый или последний зависит от того, кто как
 * написал цикл, и разъезжается между рендерами.
 */
export const MULTIPLICITY: Record<ComponentType, 'one' | 'many'> = {
  seat: 'many',
  work: 'one',
  plate: 'one',
  surface: 'one',
  lamp: 'many',
  glow: 'many',
  wall_mounted: 'one',
};

export const COMPONENT_TYPES = Object.keys(MULTIPLICITY) as ComponentType[];

// ---------------------------------------------------------------------------
// Пресет
// ---------------------------------------------------------------------------

export const presetSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+$/, 'id: строчные латинские, цифры и подчёркивание'),
  /** Человеку: подпись в редакторе расстановки. */
  title: z.string().min(1),
  /** Габарит арта в тайлах. Единственное число, посчитанное по пикселям. */
  size: vec2,
  /**
   * След на полу от якоря предмета. Обязателен: раньше его не было у половины
   * предметов и он достраивался из глубины `d` по формуле в `floorRect` — то
   * есть след нельзя было прочитать, его надо было вычислить, зная две
   * таблицы сразу.
   */
  footprint: rect,
  /** След непроходим. Ковёр не мешает, шкаф мешает. */
  blocks: z.boolean().optional(),
  /** Слой отрисовки в плоском рендере. */
  layer: z.string().optional(),
  /** Высота, тайлы. */
  h: z.number().nonnegative(),
  tone: z.enum(TONES).optional(),
  /** Чем рисовать, пока модели нет. */
  fallback: z.enum(SHAPES),
  /**
   * У предмета нет и не будет пиксельного арта — он существует только
   * моделью. Плоский рендер такой предмет пропускает.
   */
  modelOnly: z.literal(true).optional(),
  parts: z.array(partSchema).optional(),
  components: z.array(componentSchema),
});

export type Preset = z.infer<typeof presetSchema>;

/** Что разбор нашёл: сам пресет и то, о чём стоит сказать вслух. */
export interface ParseResult {
  preset: Preset;
  warnings: string[];
}

/**
 * Разобрать пресет.
 *
 * Незнакомый тип компонента — предупреждение, а не падение: пресет с
 * `"type": "door"` обязан открываться клиентом, который про двери ещё не
 * знает. Иначе любое расширение схемы превращается в синхронную выкатку
 * клиента и данных, а это ровно та связанность, от которой уходим.
 *
 * Всё остальное — ошибка. Опечатка в имени поля, лишний ключ, нарушенная
 * кратность: данные пишет человек, и молчаливо проглоченная опечатка находится
 * через неделю глазами.
 */
export function parsePreset(data: unknown, where = '<preset>'): ParseResult {
  const warnings: string[] = [];

  // Незнакомые типы отсеиваются до схемы: `discriminatedUnion` о них скажет
  // «неизвестный вариант», и отличить забытую дверь от опечатки в `seat`
  // будет уже нельзя.
  if (data && typeof data === 'object' && Array.isArray((data as { components?: unknown }).components)) {
    const known = new Set<string>(COMPONENT_TYPES);
    const src = (data as { components: unknown[] }).components;
    const kept = src.filter((c) => {
      const type = (c as { type?: unknown })?.type;
      if (typeof type === 'string' && !known.has(type)) {
        warnings.push(`${where}: компонент «${type}» неизвестен, пропущен`);
        return false;
      }
      return true;
    });
    if (kept.length !== src.length) data = { ...(data as object), components: kept };
  }

  const preset = presetSchema.parse(data);

  if (preset.id !== undefined && where !== '<preset>' && !where.includes(preset.id)) {
    warnings.push(`${where}: id «${preset.id}» не совпадает с именем папки`);
  }

  const seen = new Map<ComponentType, number>();
  for (const c of preset.components) seen.set(c.type, (seen.get(c.type) ?? 0) + 1);
  for (const [type, count] of seen) {
    if (MULTIPLICITY[type] === 'one' && count > 1) {
      throw new Error(`${where}: компонент «${type}» одиночный, а его ${count}`);
    }
  }

  return { preset, warnings };
}

/** Все компоненты этого сорта, в порядке объявления. */
export function componentsOf<T extends ComponentType>(preset: Preset, type: T): OfType<T>[] {
  return preset.components.filter((c): c is OfType<T> => c.type === type);
}

/**
 * Единственный компонент этого сорта. Кратность уже проверена разбором,
 * поэтому здесь достаточно взять первый.
 */
export function componentOf<T extends ComponentType>(preset: Preset, type: T): OfType<T> | undefined {
  return preset.components.find((c): c is OfType<T> => c.type === type);
}

/** Имя части: своё (`"desk"`) или чужое (`"chair/model"` → пресет `chair`). */
export function splitRef(ref: string): { preset?: string; part: string } {
  const i = ref.indexOf('/');
  return i < 0 ? { part: ref } : { preset: ref.slice(0, i), part: ref.slice(i + 1) };
}

/** Как зовётся часть, если имя не задано явно: имя файла без расширения. */
export function partName(part: Part): string {
  return part.name ?? part.file.replace(/\.[^.]+$/, '');
}

// ---------------------------------------------------------------------------
// Запись каталога
// ---------------------------------------------------------------------------

/**
 * Слоты каталога из компонентов.
 *
 * Порядок сохраняется: слоты каталога и компоненты пресета идут в одном
 * порядке. Это намеренно строго — переставленные слоты у стола означали бы,
 * что рабочее место и табличка поменялись местами.
 *
 * Живёт здесь, а не в скриптах сборки, где было написано, потому что читателя
 * у этого перевода два. Первый — сборка каталога (`npm run presets:catalog`).
 * Второй — стенд: чтобы показать места живого пресета **теми же** формулами,
 * какими их считает комната (`restSeats`, `meetingSeat`), ему нужен каталог,
 * собранный из пресета прямо в браузере. Второй способ разложить ряд мест
 * вдоль стороны стола был бы ровно тем «похоже», от которого стенд и уходит.
 */
export function slotsOf(preset: Preset): CatalogSlot[] {
  const slots: CatalogSlot[] = [];
  for (const c of preset.components) {
    const approach = 'approach' in c && c.approach ? { approach: c.approach } : {};
    if (c.type === 'work') slots.push({ kind: 'work', x: c.at[0], y: c.at[1], ...approach });
    else if (c.type === 'plate') slots.push({ kind: 'plate', x: c.at[0], y: c.at[1] });
    else if (c.type === 'seat') {
      if (c.shape === 'point') {
        slots.push({ kind: 'seat', x: c.at![0], y: c.at![1], ...(c.use ? { use: c.use } : {}), ...approach });
      } else if (c.shape === 'side') {
        slots.push({ kind: 'seat', side: c.side!, count: c.count!, ...approach });
      } else {
        slots.push({ kind: 'seat', ring: c.ring!, rx: c.rx!, ry: c.ry!, ...(c.grow ? { grow: true } : {}) });
      }
    }
  }
  return slots;
}

/** Запись каталога. Порядок ключей — как у `gen.py:dump_catalog`, ради чистого дифа. */
export function entryOf(preset: Preset): CatalogSprite {
  const slots = slotsOf(preset);
  return {
    size: preset.size,
    ...(preset.modelOnly ? { modelOnly: true as const } : {}),
    footprint: preset.footprint,
    ...(preset.layer ? { layer: preset.layer } : {}),
    ...(slots.length ? { slots } : {}),
    ...(preset.blocks ? { blocks: true } : {}),
    label: preset.title,
  };
}

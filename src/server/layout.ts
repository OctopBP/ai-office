import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOverride, desks as deskList, isEmptyOverride, pmDeskIndex, propKeys } from '../shared/layout';
import type { Catalog, Layout, LayoutOverride, LayoutPropEdit } from '../shared/layout';
import type { Desk, LayoutOption } from '../shared/types';

/**
 * Раскладка офиса для сервера: каталог спрайтов и раскладки лежат в design/,
 * столы из них считает общий модуль src/shared/layout.ts
 * (docs/design/office-layout/spec.md §3, §4). Веб берёт те же файлы через
 * import.meta.glob (src/web/layoutData.ts), на сервере его нет — читаем с диска.
 *
 * Путь считаем от файла модуля, а не от cwd: рабочий каталог процесса —
 * не обязательно корень репозитория офиса.
 *
 * Здесь нет ни одной величины «текущая раскладка»: офисов в памяти несколько,
 * у каждого свой layoutId, и любая функция получает его аргументом.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LAYOUTS_DIR = resolve(ROOT, 'design/layouts');

/** Раскладка офиса, если своя не выбрана: то, как офис выглядел всегда. */
export const DEFAULT_LAYOUT_ID = 'classic';

/**
 * id раскладки приходит от клиента и подставляется в путь файла, поэтому
 * форма проверяется отдельно от существования: «../../etc/passwd» не должен
 * доходить даже до чтения с диска.
 */
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Каталог спрайтов — свойство арта, общее на процесс: он один на весь репозиторий. */
export const catalog = readJson<Catalog>(resolve(ROOT, 'design/sprites/out/catalog.json'));

/**
 * Раскладка с наложенным оверрайдом и посчитанные по ней столы. Пресет без
 * оверрайда — тот же вариант с пустым ключом.
 */
interface Variant {
  layout: Layout;
  plan?: DeskPlan;
}

/**
 * Разобранные пресеты и посчитанные по ним столы. Ключ — id раскладки, а не
 * офис: содержимое файла от офиса не зависит, и двум офисам с одной раскладкой
 * обязаны достаться одинаковые столы. Раскладки в этом проекте правят прямо во
 * время работы офиса, поэтому запись сверяется с mtime файла, а не живёт до
 * перезапуска процесса.
 *
 * Оверрайд офиса не ломает это правило: варианты лежат внутри записи пресета
 * под ключом самого оверрайда, так что два офиса с одинаковой правкой снова
 * получают один и тот же план, а разные — разные.
 */
const parsed = new Map<string, { mtimeMs: number; layout: Layout; variants: Map<string, Variant> }>();

/**
 * Сколько вариантов оверрайда держим на пресет. Редактор шлёт правку на каждое
 * отпускание мыши, и без потолка карта росла бы всю сессию; вариантов, которыми
 * пользуются одновременно, — по одному на офис.
 */
const MAX_VARIANTS = 8;

/** Ключ варианта: пустая строка — чистый пресет. */
function variantKey(override: LayoutOverride | null | undefined): string {
  return isEmptyOverride(override) ? '' : JSON.stringify(override!.props);
}

/** Свежая запись кэша по id или undefined, если файл изменился с прошлого раза. */
function cached(id: string, mtimeMs: number) {
  const hit = parsed.get(id);
  return hit && hit.mtimeMs === mtimeMs ? hit : undefined;
}

/** Время правки файла раскладки. Бросает, если пресета нет или он не читается. */
function layoutMtime(id: string): number {
  if (!ID_RE.test(id)) throw new Error(`недопустимый id раскладки «${id}»`);
  try {
    return statSync(resolve(LAYOUTS_DIR, `${id}.json`)).mtimeMs;
  } catch (err) {
    throw new Error(`раскладка «${id}» не читается: ${(err as Error).message}`);
  }
}

/** Раскладка по id. Бросает, если пресета нет или он не читается. */
export function loadLayout(id: string): Layout {
  const mtimeMs = layoutMtime(id);
  const hit = cached(id, mtimeMs);
  if (hit) return hit.layout;
  let data: Layout;
  try {
    data = readJson<Layout>(resolve(LAYOUTS_DIR, `${id}.json`));
  } catch (err) {
    throw new Error(`раскладка «${id}» не читается: ${(err as Error).message}`);
  }
  parsed.set(id, { mtimeMs, layout: data, variants: new Map([['', { layout: data }]]) });
  return data;
}

/**
 * Пресеты из design/layouts для выбора в интерфейсе. Директорию перечитываем
 * на каждый вызов: список короткий, а раскладки в этом проекте добавляют прямо
 * во время работы офиса — кэш показывал бы вчерашний набор. Разбор файлов при
 * этом закэширован по mtime, так что вызов стоит readdir и одного stat на пресет.
 */
export function layoutOptions(): LayoutOption[] {
  let files: string[];
  try {
    files = readdirSync(LAYOUTS_DIR);
  } catch (err) {
    console.log(`⚠️  Раскладки не читаются (${(err as Error).message})`);
    return [];
  }
  const options: LayoutOption[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;
    try {
      // Подпись берём из самой раскладки: название пресета живёт рядом с ним,
      // а не вторым списком на сервере, который забудут дополнить.
      options.push({ id, title: loadLayout(id).title || id });
    } catch (err) {
      // Битый пресет не должен ронять список остальных — говорим и идём дальше.
      console.log(`⚠️  Раскладка ${file} пропущена: ${(err as Error).message}`);
    }
  }
  return options;
}

/** Есть ли такой пресет — проверка перед тем, как принять выбор от клиента. */
export function hasLayout(id: string): boolean {
  if (!ID_RE.test(id)) return false;
  try {
    loadLayout(id);
    return true;
  } catch {
    return false;
  }
}

/** Подпись раскладки для сообщений человеку; у нечитаемой — её же id. */
export function layoutTitle(id: string): string {
  try {
    return loadLayout(id).title || id;
  } catch {
    return id;
  }
}

/** Рабочие места одной раскладки: всё, что офису нужно знать о рассадке. */
export interface DeskPlan {
  /** id раскладки, по которой посчитан план: может отличаться от запрошенного (см. deskPlan). */
  layoutId: string;
  /**
   * Рабочие места. Индекс — порядок объявления столов в раскладке (§3.3)
   * и контракт с сохранением состояния (`PersistedInstance.deskIndex`).
   */
  desks: Desk[];
  /** Индекс стола менеджера: спрайт desk_pm, иначе место 0 (§3.3). */
  pmIndex: number;
}

/**
 * Столы конкретной раскладки. Считается один раз на файл и лежит в том же
 * кэше, что и разобранная раскладка, — спрашивают план на каждый найм и на
 * каждого сотрудника из сохранения.
 *
 * Раскладку, которая перестала читаться (файл удалили из-под работающего
 * офиса), подменяем на classic: офис без мебели — не то состояние, в котором
 * его можно оставить. Если и classic не читается, бросаем: без столов сажать
 * людей некуда, и молчать об этом нельзя.
 */
export function deskPlan(layoutId: string, override?: LayoutOverride | null): DeskPlan {
  const { id, variant } = variantOf(layoutId, override);
  if (!variant.plan) {
    variant.plan = {
      layoutId: id,
      desks: deskList(variant.layout, catalog),
      pmIndex: pmDeskIndex(variant.layout, catalog),
    };
  }
  return variant.plan;
}

/**
 * Итоговая раскладка офиса: пресет плюс его оверрайд (§8). Ровно по ней
 * считаются столы — источник один, иначе сдвинутый стол существовал бы
 * только в оверрайде, а люди садились бы по голому пресету.
 */
export function effectiveLayout(layoutId: string, override?: LayoutOverride | null): Layout {
  return variantOf(layoutId, override).variant.layout;
}

/**
 * Вариант раскладки из кэша: пресет (с той же подменой на classic, что и
 * раньше, — офис без мебели не то состояние, в котором его можно оставить)
 * и наложенный на него оверрайд.
 */
function variantOf(layoutId: string, override?: LayoutOverride | null):
  { id: string; variant: Variant } {
  let id = layoutId;
  let preset: Layout;
  try {
    preset = loadLayout(id);
  } catch (err) {
    if (id === DEFAULT_LAYOUT_ID) throw err;
    console.log(`⚠️  ${(err as Error).message} — считаю столы по «${DEFAULT_LAYOUT_ID}»`);
    id = DEFAULT_LAYOUT_ID;
    preset = loadLayout(id);
  }
  // loadLayout выше уже положил свежую запись в кэш — она здесь всегда есть.
  const entry = parsed.get(id)!;
  const key = variantKey(override);
  let variant = entry.variants.get(key);
  if (!variant) {
    variant = { layout: applyOverride(preset, override) };
    // Самый старый вариант вытесняем, кроме чистого пресета: его спрашивают
    // и офисы без оверрайда, и сравнение «что вообще изменено».
    for (const old of entry.variants.keys()) {
      if (entry.variants.size < MAX_VARIANTS) break;
      if (old !== '') entry.variants.delete(old);
    }
    entry.variants.set(key, variant);
  }
  return { id, variant };
}

/** Границы координаты предмета: чуть за кромку комнаты — законно (§3.2, мебель у стен). */
const OUT_OF_ROOM = 1;
/** Разумные пределы масштаба предмета: ковёр 1.2, стол переговорки 1.6. */
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
/**
 * Пределы явного габарита предмета в тайлах (§3.2). Верхний — размер самой
 * комнаты: предмет во всю комнату это уже пол, а не мебель, и footprint такого
 * размера перекрыл бы проходимость целиком.
 */
const MIN_PROP_SIZE = 0.1;

/**
 * Проверить и причесать одну правку расстановки. Возвращает либо готовую
 * правку, либо причину отказа по-русски: правка приходит от человека, а мебель
 * за стеной или NaN в позиции сломали бы и рендер, и сетку проходимости.
 */
export function checkPropEdit(
  layoutId: string, override: LayoutOverride | null, edit: LayoutPropEdit,
): LayoutPropEdit | { error: string } {
  // Известными считаем и убранные офисом предметы: правка `removed: false`
  // возвращает предмет на место, и отказывать ей «такого нет» — неправда.
  const layout = effectiveLayout(layoutId, override && {
    ...override,
    props: override.props.map(({ removed: _removed, ...rest }) => rest),
  });
  const key = typeof edit.key === 'string' ? edit.key.trim() : '';
  if (!key) return { error: 'В правке расстановки не указан предмет.' };
  const known = propKeys(layout).includes(key);
  if (!known && !edit.sprite) {
    return { error: `Предмета «${key}» нет в раскладке «${layout.title || layoutId}».` };
  }
  const clean: LayoutPropEdit = { key };
  if (!known) {
    if (!catalog.sprites[edit.sprite!]) return { error: `Спрайта «${edit.sprite}» нет в каталоге.` };
    if (!edit.at) return { error: `Для нового предмета «${key}» нужна позиция.` };
    clean.sprite = edit.sprite;
  }
  if (edit.at !== undefined) {
    const [x, y] = Array.isArray(edit.at) ? edit.at : [NaN, NaN];
    const [cols, rows] = layout.size;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'Позиция предмета — не число.' };
    if (x < -OUT_OF_ROOM || y < -OUT_OF_ROOM || x > cols + OUT_OF_ROOM || y > rows + OUT_OF_ROOM) {
      return { error: `Позиция [${x}, ${y}] выходит за пределы комнаты ${cols}×${rows}.` };
    }
    // Округляем до тысячных: позиция придёт из пикселей мыши, и хвост вроде
    // 6.000000000000001 попал бы и в сохранение, и в ключ кэша.
    clean.at = [round3(x), round3(y)];
  }
  if (edit.flip !== undefined) clean.flip = Boolean(edit.flip);
  if (edit.rot !== undefined) {
    if (!Number.isFinite(edit.rot)) return { error: `Поворот предмета «${key}» — не число.` };
    // Приводим к [0, 360): поворот на 450° и на 90° — один и тот же предмет,
    // но в файле состояния это были бы две разные записи.
    clean.rot = round3(((edit.rot % 360) + 360) % 360);
  }
  if (edit.scale !== undefined) {
    if (!Number.isFinite(edit.scale) || edit.scale < MIN_SCALE || edit.scale > MAX_SCALE) {
      return { error: `Масштаб предмета «${key}» должен быть числом от ${MIN_SCALE} до ${MAX_SCALE}.` };
    }
    clean.scale = round3(edit.scale);
  }
  if (edit.size !== undefined) {
    const [w, h] = Array.isArray(edit.size) ? edit.size : [NaN, NaN];
    const [cols, rows] = layout.size;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return { error: `Размер предмета «${key}» — не число.` };
    if (w < MIN_PROP_SIZE || h < MIN_PROP_SIZE || w > cols || h > rows) {
      return { error: `Размер предмета «${key}» должен быть от ${MIN_PROP_SIZE} до размеров комнаты ${cols}×${rows}.` };
    }
    clean.size = [round3(w), round3(h)];
  }
  if (edit.removed !== undefined) {
    if (edit.removed && !known) return { error: `Предмета «${key}» в раскладке и так нет.` };
    clean.removed = Boolean(edit.removed);
  }
  return clean;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

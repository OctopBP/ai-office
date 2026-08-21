import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desks as deskList, pmDeskIndex } from '../shared/layout';
import type { Catalog, Layout } from '../shared/layout';
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

const catalog = readJson<Catalog>(resolve(ROOT, 'design/sprites/out/catalog.json'));

/**
 * Разобранные пресеты и посчитанные по ним столы. Ключ — id раскладки, а не
 * офис: содержимое файла от офиса не зависит, и двум офисам с одной раскладкой
 * обязаны достаться одинаковые столы. Раскладки в этом проекте правят прямо во
 * время работы офиса, поэтому запись сверяется с mtime файла, а не живёт до
 * перезапуска процесса.
 */
const parsed = new Map<string, { mtimeMs: number; layout: Layout; plan?: DeskPlan }>();

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
  parsed.set(id, { mtimeMs, layout: data });
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
export function deskPlan(layoutId: string): DeskPlan {
  let id = layoutId;
  let layout: Layout;
  try {
    layout = loadLayout(id);
  } catch (err) {
    if (id === DEFAULT_LAYOUT_ID) throw err;
    console.log(`⚠️  ${(err as Error).message} — считаю столы по «${DEFAULT_LAYOUT_ID}»`);
    id = DEFAULT_LAYOUT_ID;
    layout = loadLayout(id);
  }
  // loadLayout выше уже положил свежую запись в кэш — она здесь всегда есть.
  const entry = parsed.get(id)!;
  if (!entry.plan) {
    entry.plan = {
      layoutId: id,
      desks: deskList(layout, catalog),
      pmIndex: pmDeskIndex(layout, catalog),
    };
  }
  return entry.plan;
}

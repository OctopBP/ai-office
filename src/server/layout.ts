import { readdirSync, readFileSync } from 'node:fs';
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
 * Столы пока считаются по classic и от настройки офиса не зависят: перевод
 * рассадки на выбранную раскладку — следующая задача. Здесь сейчас только то,
 * что нужно настройке: список пресетов и проверка выбранного id.
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

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8')) as T;
}

const catalog = readJson<Catalog>('design/sprites/out/catalog.json');
const layout = readJson<Layout>('design/layouts/classic.json');

/** Разобранные пресеты по id: файлы за время работы процесса не меняются. */
const parsed = new Map<string, Layout>();

/** Раскладка по id. Бросает, если пресета нет или он не читается. */
export function loadLayout(id: string): Layout {
  const cached = parsed.get(id);
  if (cached) return cached;
  if (!ID_RE.test(id)) throw new Error(`недопустимый id раскладки «${id}»`);
  let data: Layout;
  try {
    data = readJson<Layout>(`design/layouts/${id}.json`);
  } catch (err) {
    throw new Error(`раскладка «${id}» не читается: ${(err as Error).message}`);
  }
  parsed.set(id, data);
  return data;
}

/**
 * Пресеты из design/layouts для выбора в интерфейсе. Директорию перечитываем
 * на каждый вызов: список короткий, а раскладки в этом проекте добавляют прямо
 * во время работы офиса — кэш показывал бы вчерашний набор. Разбор самих файлов
 * при этом закэширован, так что вызов стоит одного readdir.
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

/**
 * Рабочие места офиса. Индекс — порядок объявления столов в раскладке (§3.3)
 * и контракт с сохранением состояния (`PersistedInstance.deskIndex`).
 */
export const DESKS: Desk[] = deskList(layout, catalog);

/** Индекс стола менеджера: спрайт desk_pm, иначе место 0 (§3.3). */
export const PM_DESK_INDEX = pmDeskIndex(layout, catalog);

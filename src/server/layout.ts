import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desks as deskList, pmDeskIndex } from '../shared/layout';
import type { Catalog, Layout } from '../shared/layout';
import type { Desk } from '../shared/types';

/**
 * Раскладка офиса для сервера: каталог спрайтов и раскладка лежат в design/,
 * столы из них считает общий модуль src/shared/layout.ts
 * (docs/design/office-layout/spec.md §3, §4). Веб берёт те же файлы через
 * import.meta.glob (src/web/layoutData.ts), на сервере его нет — читаем с диска.
 *
 * Путь считаем от файла модуля, а не от cwd: рабочий каталог процесса —
 * не обязательно корень репозитория офиса.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8')) as T;
}

const catalog = readJson<Catalog>('design/sprites/out/catalog.json');
const layout = readJson<Layout>('design/layouts/classic.json');

/**
 * Рабочие места офиса. Индекс — порядок объявления столов в раскладке (§3.3)
 * и контракт с сохранением состояния (`PersistedInstance.deskIndex`).
 */
export const DESKS: Desk[] = deskList(layout, catalog);

/** Индекс стола менеджера: спрайт desk_pm, иначе место 0 (§3.3). */
export const PM_DESK_INDEX = pmDeskIndex(layout, catalog);

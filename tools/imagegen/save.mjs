/**
 * Куда и как ложатся сгенерированные картинки.
 *
 * Периметр здесь не украшение. Внешний MCP-сервер поднимается процессом
 * офиса, а не сессией, и о рабочей копии сотрудника ничего не знает: его
 * текущая директория — та, из которой запущен сервер офиса. Поэтому рабочую
 * копию офис кладёт в `OFFICE_WORKDIR`, относительные пути считаются от неё,
 * а запись наружу отклоняется. Без этого «сохрани в assets/hero.png» уехало
 * бы в корень офиса мимо ветки задачи, и следующий сотрудник этого файла бы
 * не увидел.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, extname } from 'node:path';

/** Рабочая копия сотрудника. Пусто — директория запуска: так сервер годен и для проверок руками. */
export const workdir = () => resolve(process.env.OFFICE_WORKDIR || process.cwd());

/** Потолок на файл: чужой ответ читается в память целиком, и верить его размеру нельзя. */
const MAX_BYTES = 32 * 1024 * 1024;

/** Расширение по типу содержимого; неизвестное — png, в нём приходит почти всё. */
function extOf(mime, url) {
  if (/jpe?g/i.test(mime || '')) return '.jpg';
  if (/webp/i.test(mime || '')) return '.webp';
  if (/png/i.test(mime || '')) return '.png';
  const fromUrl = extname(new URL(url || 'https://x/y.png', 'https://x').pathname).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(fromUrl) ? fromUrl : '.png';
}

/**
 * Полный путь файла из того, что попросили. Всё, что вне рабочей копии, —
 * отказ с объяснением: это не техническая невозможность, а граница.
 */
export function safePath(wanted, ext) {
  const root = workdir();
  const raw = String(wanted || '').trim();
  if (!raw) throw new Error('Не сказано, куда сохранять: поле path обязательно.');
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    throw new Error(`Писать можно только внутри рабочей копии (${root}), а путь ведёт наружу: ${abs}`);
  }
  // Расширение ставим сами: модель отдаёт что отдаёт, и `hero` без
  // расширения — это файл, который не откроется двойным щелчком.
  return extname(abs) ? abs : abs + ext;
}

/** Второй и следующие варианты — с номером: `hero.png`, `hero-2.png`, `hero-3.png`. */
const numbered = (path, n) => (n === 0 ? path : path.replace(/(\.[^.]+)$/, `-${n + 1}$1`));

/** Байты картинки: у одного провайдера они в ответе, у другого за ссылкой. */
async function bytesOf(image) {
  if (image.data) return Buffer.from(image.data);
  const res = await fetch(image.url);
  if (!res.ok) throw new Error(`картинка не скачалась: HTTP ${res.status} ${res.statusText} (${image.url})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`картинка больше ${MAX_BYTES / 1024 / 1024} МБ — не сохраняем`);
  return buf;
}

/**
 * Сохранить готовые картинки. Возвращает пути относительно рабочей копии:
 * именно ими роль будет пользоваться дальше, и абсолютный путь в отчёте
 * рассказал бы человеку про чужие директории, а не про его репозиторий.
 */
export async function saveImages(images, wanted) {
  const root = workdir();
  const base = safePath(wanted, extOf(images[0]?.mime, images[0]?.url));
  await mkdir(dirname(base), { recursive: true });

  const saved = [];
  for (const [i, image] of images.entries()) {
    const file = numbered(base, i);
    await writeFile(file, await bytesOf(image));
    saved.push(file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file);
  }
  return saved;
}

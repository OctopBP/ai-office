/**
 * Пути к файлам в тексте реплики: «Описание лежит в docs/design/T-189/ui.md,
 * рядом снимки providers-tab.png и first-launch.png» — три ссылки на файлы.
 *
 * Чистые функции без React: разметка (Markdown.tsx) режет текст на куски, а
 * что из этого файл и относительно какого каталога его искать — решается здесь.
 * Сам файл ищет сервер (GET /api/file, src/server/files.ts): он же проверяет
 * путь, поэтому здесь достаточно не ошибаться в сторону «лишней ссылки».
 */

/** Расширения, по которым голое имя без каталогов считаем файлом. */
export const BARE_EXTENSIONS = ['md', 'txt', 'json', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'pdf', 'glb', 'gltf'];

/** Что открыть: путь как написан и каталог, в котором сначала искать голое имя. */
export interface FileRef {
  path: string;
  base?: string;
}

/** Кусок текста: либо обычный текст, либо файл. */
export type FileSegment = string | { text: string; ref: FileRef };

/**
 * Состояние разбора одной реплики. Голое имя ищется рядом с ближайшим
 * предыдущим путём, а куски одной реплики разбираются по очереди (абзацы,
 * пункты, инлайн-код) — поэтому каталог переезжает от куска к куску здесь.
 */
export interface PathScan {
  dir: string | null;
}

export const newScan = (): PathScan => ({ dir: null });

/**
 * Путь с каталогами — с любым расширением (docs/…/x.md, src/…/y.ts), голое
 * имя — только с известным: иначе «Node.js» и «v0.5.2» стали бы файлами.
 * Перед совпадением не должно быть букв, слеша, точки, двоеточия и тильды —
 * так отсекаются абсолютные пути, «~/…», хвосты адресов и «a.b/c.md» внутри
 * слова. После — ни буквы, ни слеша: «ui.md.» в конце фразы годится.
 */
const PATH = new RegExp(
  '(?<![\\w/.:@~\\\\-])'
  + '(?:'
  + '(?:\\./)?((?:[\\w@.-]+/)+)[\\w.-]*\\w\\.[A-Za-z][A-Za-z0-9]{0,7}' // 1 — каталог пути
  + '|'
  + `[\\w-][\\w.-]*\\.(?:${BARE_EXTENSIONS.join('|')})`
  + ')'
  + '(?![\\w/\\\\-]|\\.\\w)',
  'gi',
);

/** Адрес со схемой: внутри него путей не ищем (в инлайн-коде адрес бывает). */
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** «www.site.com/a.md» — адрес без схемы, а не путь: в первом каталоге есть точка не в начале. */
const looksLikeHost = (dir: string) => /^[^./][^/]*\.[^/]+\//.test(dir);

const trimDir = (dir: string) => dir.replace(/^\.\//, '').replace(/\/+$/, '');

/** Найти файлы в куске без адресов. Каталог пути запоминается в `scan`. */
function splitPlain(text: string, scan: PathScan, out: FileSegment[]): void {
  let last = 0;
  PATH.lastIndex = 0;
  for (let m = PATH.exec(text); m; m = PATH.exec(text)) {
    const dir = m[1];
    if (dir && looksLikeHost(dir.replace(/^\.\//, ''))) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    const path = m[0];
    let ref: FileRef;
    if (dir) {
      ref = { path };
      scan.dir = trimDir(path.slice(0, path.lastIndexOf('/') + 1));
    } else {
      ref = scan.dir ? { path, base: scan.dir } : { path };
    }
    out.push({ text: path, ref });
    last = m.index + path.length;
  }
  if (last < text.length) out.push(text.slice(last));
}

/**
 * Разрезать текст на обычные куски и файлы. Адреса (http… и любые «схема://»)
 * остаются текстом целиком. Соседние текстовые куски не склеиваются — для
 * отрисовки это неважно.
 */
export function splitFilePaths(text: string, scan: PathScan): FileSegment[] {
  const out: FileSegment[] = [];
  let last = 0;
  URL.lastIndex = 0;
  for (let m = URL.exec(text); m; m = URL.exec(text)) {
    if (m.index > last) splitPlain(text.slice(last, m.index), scan, out);
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) splitPlain(text.slice(last), scan, out);
  return out;
}

/**
 * Адрес markdown-ссылки `[подпись](docs/x.md)` как файл. Схема, якорь и
 * абсолютный путь — не файл проекта.
 */
export function fileHref(href: string, scan: PathScan): FileRef | null {
  const h = href.trim();
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('/') || h.startsWith('#')) return null;
  const parts = splitFilePaths(h, scan);
  const only = parts.length === 1 ? parts[0] : null;
  return only && typeof only !== 'string' ? only.ref : null;
}

/** Первая упомянутая задача «T-N» в тексте — к ней привязываем файлы реплики. */
export function mentionedTask(text: string): string | null {
  return /(?<![\w-])T-\d+(?![\w-])/.exec(text)?.[0] ?? null;
}

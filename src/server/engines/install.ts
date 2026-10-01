/**
 * Установка движков: скачать пакет платформы из npm в папку движков офиса.
 *
 * Раньше это делало приложение до старта сервера (desktop/engine.js) и только
 * для Claude Code. Теперь движок ставит сервер по кнопке «Установить» на
 * экране «Провайдеры» — для того провайдера, которого выбрал человек, — и
 * шлёт прогресс в веб.
 *
 * Внутрь установщика движки не кладутся сознательно: бинарь Claude Code
 * проприетарный, раздавать его со своих релизов нельзя (docs/design/
 * desktop-app/spec.md §3). Берём его ровно оттуда, откуда его берёт `npm ci`.
 *
 * Раскладка: `<папка движков>/<движок>/<версия>/` — содержимое пакета целиком
 * (рядом с бинарём бывают нужные ему файлы). Обновился SDK — приедет новая
 * версия, а старая останется на месте и не помешает откату.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, cpSync, chmodSync, accessSync, constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { EngineId, InstallProgress } from './types';

/**
 * Куда ставятся движки. Приложение передаёт папку данных (`OFFICE_ENGINE_DIR`),
 * офис из исходников кладёт рядом с кешем пакетов маркета.
 */
export const engineDir = (): string =>
  resolve(process.env.OFFICE_ENGINE_DIR ?? join(homedir(), '.office', 'engines'));

/** Файл есть и его можно запустить. */
export function runnable(path: string): boolean {
  if (!path) return false;
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Числовое сравнение версий «1.2.10» > «1.2.9»; хвосты вроде -alpha не учитываются. */
function newer(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Поставленный движок: путь к бинарю внутри `<движок>/<версия>/`. `version` —
 * нужна ровно эта; без неё — самая свежая из поставленных.
 */
export function installedBin(engine: EngineId, bin: string, version?: string): { path: string; version: string } | null {
  const root = join(engineDir(), engine);
  let versions: string[];
  try {
    versions = readdirSync(root).filter((v) => !v.startsWith('.'));
  } catch {
    return null;
  }
  const pick = version ? versions.filter((v) => v === version) : versions.sort(newer).reverse();
  for (const v of pick) {
    const path = join(root, v, bin);
    if (runnable(path)) return { path, version: v };
  }
  return null;
}

/**
 * Распаковка .tgz системным tar: он есть и в macOS, и в Windows 10+.
 *
 * На Windows — по полному пути из System32: первым в PATH бывает tar из Git
 * или MSYS, а он читает «C:\…» как адрес удалённой машины «C:» и падает.
 * Архив передаётся именем относительно рабочей папки, а не полным путём:
 * так tar не видит ни пробелов, ни кириллицы из имени пользователя.
 */
function untar(archive: string, dir: string): Promise<void> {
  const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const tar = process.platform === 'win32' && existsSync(system) ? system : 'tar';
  return new Promise((done, fail) => {
    execFile(tar, ['-xzf', basename(archive)], { cwd: dir }, (err) => (err ? fail(err) : done()));
  });
}

export interface NpmEngine {
  engine: EngineId;
  /** Пакет npm с бинарём под эту платформу. */
  pkg: string;
  /** Версия или dist-tag: по тегу берётся то, что npm сейчас считает последним. */
  version: string;
  /** Путь к бинарю внутри пакета (`package/` уже снят). */
  bin: string;
  /** Под каким именем версии класть: по умолчанию — то, что ответил npm. */
  folder?: (npmVersion: string) => string;
}

/**
 * Скачать и разложить движок. Адрес и контрольная сумма берутся из
 * метаданных npm, а не собираются строкой: так сумма приходит из того же
 * ответа, что и файл, и подменённый архив не пройдёт проверку.
 */
export async function installFromNpm(
  spec: NpmEngine,
  onProgress: (p: InstallProgress) => void,
  signal: AbortSignal,
): Promise<{ path: string }> {
  const metaUrl = `https://registry.npmjs.org/${spec.pkg.replace('/', '%2f')}/${encodeURIComponent(spec.version)}`;
  const metaRes = await fetch(metaUrl, { signal });
  if (!metaRes.ok) {
    throw new Error(`npm ответил ${metaRes.status} на ${spec.pkg}@${spec.version} — движок под ${process.platform}-${process.arch} не найден`);
  }
  const meta = await metaRes.json() as { version?: string; dist?: { tarball?: string; integrity?: string } };
  const { tarball, integrity } = meta.dist ?? {};
  if (!tarball || !meta.version) throw new Error(`в метаданных ${spec.pkg}@${spec.version} нет архива`);

  const work = join(tmpdir(), `ai-office-engine-${spec.engine}-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    const archive = join(work, 'engine.tgz');
    const res = await fetch(tarball, { signal });
    if (!res.ok || !res.body) throw new Error(`не скачался архив движка: ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0) || undefined;
    const hash = createHash('sha512');
    let got = 0;
    const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    source.on('data', (chunk: Buffer) => {
      got += chunk.length;
      hash.update(chunk);
      onProgress({ share: total ? got / total : 0, bytes: got, totalBytes: total });
    });
    await pipeline(source, createWriteStream(archive), { signal });

    if (integrity?.startsWith('sha512-') && hash.digest('base64') !== integrity.slice('sha512-'.length)) {
      throw new Error('контрольная сумма архива не сошлась — движок не ставим');
    }

    await untar(archive, work);
    const unpacked = join(work, 'package');
    if (!existsSync(join(unpacked, spec.bin))) throw new Error(`в архиве движка нет ${spec.bin}`);

    const target = join(engineDir(), spec.engine, spec.folder?.(meta.version) ?? meta.version);
    mkdirSync(join(engineDir(), spec.engine), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    try {
      renameSync(unpacked, target);
    } catch {
      // Временная папка и папка данных могут оказаться на разных томах —
      // тогда переименование не работает, а копирование работает.
      cpSync(unpacked, target, { recursive: true });
    }
    const path = join(target, spec.bin);
    // Права из архива npm бывают без бита запуска.
    if (process.platform !== 'win32') chmodSync(path, 0o755);
    if (!runnable(path)) throw new Error(`движок поставлен, но не запускается: ${path}`);
    onProgress({ share: 1, bytes: got, totalBytes: total });
    return { path };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

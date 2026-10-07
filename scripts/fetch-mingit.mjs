/**
 * MinGit в ресурсы приложения — git для Windows-сборки.
 *
 * На Windows git не предустановлен, а без него офис теряет то, на чём стоит
 * изоляция задач: ветку и worktree на задачу. Требовать «поставьте сначала Git
 * for Windows» — значит отправлять человека в терминал на первом же шаге,
 * поэтому свой git едет внутри приложения. MinGit — официальная сборка Git for
 * Windows под встраивание, лицензия GPL, распространять можно; системный git
 * она не трогает (см. docs/design/desktop-app/spec.md §3).
 *
 * Версия закреплена в коде вместе с адресом ассета и его sha256: сборка не
 * должна меняться от того, что вышло на GitHub сегодня утром, и не должна
 * зависеть от API GitHub — анонимный лимит в 60 запросов в час на общем IP
 * раннера кончается, и выпуск падает с 403. Архив качается по прямой ссылке
 * и проверяется по закреплённому хешу, так что ловится и битая загрузка, и
 * подмена файла в релизе.
 *
 * Флаг --latest берёт последний релиз через API — чтобы обновить закреплённую
 * версию. Токен из GITHUB_TOKEN или GH_TOKEN, если задан, уходит заголовком.
 *
 *   node scripts/fetch-mingit.mjs [папка назначения] [--latest]
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';

const TAG = 'v2.55.0.windows.5';
const ASSET = 'MinGit-2.55.0.5-64-bit.zip';
const URL_ = `https://github.com/git-for-windows/git/releases/download/${TAG}/${ASSET}`;
const SHA256 = '56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e';

const ATTEMPTS = 3;
const PAUSE_MS = 3000;
// Отметка рядом с распакованным git: какой архив здесь лежит. Сверяется с
// закреплённым хешем, чтобы не качать то же самое при повторной сборке.
const STAMP = '.mingit';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const latest = args.includes('--latest');
const out = args.find((a) => !a.startsWith('--')) ?? resolve(root, 'desktop/resources/git');

const untar = (archive, dir) => new Promise((done, fail) => {
  // tar из Windows 10+ и macOS одинаково распаковывает zip — отдельного
  // распаковщика в зависимости тянуть не надо.
  execFile('tar', ['-xf', archive, '-C', dir], (err) => (err ? fail(err) : done()));
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Ошибка ответа со статусом и данными лимита — их видно в логе сборки. */
class HttpError extends Error {
  constructor(what, res) {
    const limit = [
      ['x-ratelimit-remaining', 'осталось запросов'],
      ['x-ratelimit-reset', 'сброс лимита'],
    ]
      .map(([header, label]) => {
        const value = res.headers.get(header);
        if (value === null) return null;
        if (header === 'x-ratelimit-reset') return `${label} ${new Date(Number(value) * 1000).toISOString()} (${value})`;
        return `${label} ${value}`;
      })
      .filter(Boolean);
    super(`${what}: GitHub ответил ${res.status}${limit.length ? `, ${limit.join(', ')}` : ''}`);
    this.status = res.status;
  }
}

/** Повторять ли: сеть, лимит (403/429) и ошибки сервера — да, остальное — нет. */
const retriable = (err) => !(err instanceof HttpError) || err.status === 403 || err.status === 429 || err.status >= 500;

/** Выполнить шаг до ATTEMPTS раз с растущей паузой между попытками. */
async function withRetry(what, step) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (failure) {
      // «fetch failed» без причины в логе ничего не говорит — добавляем код сети.
      const code = failure.cause?.code ?? failure.cause?.cause?.code;
      const err = code && !failure.message.includes(code) ? Object.assign(failure, { message: `${failure.message} (${code})` }) : failure;
      if (attempt >= ATTEMPTS || !retriable(err)) {
        throw new Error(`${what}: не вышло за ${attempt} попыт${attempt === 1 ? 'ку' : 'ки'} — ${err.message}`, { cause: err });
      }
      const pause = PAUSE_MS * attempt;
      console.warn(`${what}: попытка ${attempt} не удалась (${err.message}), повтор через ${pause / 1000} с`);
      await sleep(pause);
    }
  }
}

/** Заголовки для api.github.com: с токеном, если он есть в окружении. */
function apiHeaders() {
  const headers = { accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** Последний MinGit через API — только по --latest, для обновления закрепа. */
async function latestAsset() {
  const api = 'https://api.github.com/repos/git-for-windows/git/releases/latest';
  const release = await withRetry('последний релиз Git for Windows', async () => {
    const res = await fetch(api, { headers: apiHeaders() });
    if (!res.ok) throw new HttpError(api, res);
    return res.json();
  });
  const asset = release.assets.find((a) => /^MinGit-[\d.]+-64-bit\.zip$/.test(a.name));
  if (!asset) throw new Error(`в релизе ${release.tag_name} нет 64-битного MinGit`);
  const digest = asset.digest ?? '';
  if (!digest.startsWith('sha256:')) throw new Error(`у ${asset.name} в релизе нет sha256`);
  console.log(`последний MinGit: ${release.tag_name}, ${asset.name}, sha256 ${digest.slice(7)}`);
  return { name: asset.name, url: asset.browser_download_url, sha256: digest.slice('sha256:'.length) };
}

const target = latest ? await latestAsset() : { name: ASSET, url: URL_, sha256: SHA256 };
const stamp = resolve(out, STAMP);

if (existsSync(resolve(out, 'cmd/git.exe')) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === target.sha256) {
  console.log(`MinGit уже на месте: ${out}`);
  process.exit(0);
}

const work = resolve(tmpdir(), `mingit-${process.pid}`);
mkdirSync(work, { recursive: true });
const archive = resolve(work, target.name);

try {
  // Прямая ссылка релиза отдаёт редирект на CDN — без API и его лимита.
  // Хеш сверяется внутри попытки: оборванная загрузка тоже повод повторить.
  await withRetry(`скачивание ${target.name}`, async () => {
    const res = await fetch(target.url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new HttpError(target.url, res);
    const hash = createHash('sha256');
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => hash.update(chunk));
    await pipeline(source, createWriteStream(archive));
    const got = hash.digest('hex');
    if (got !== target.sha256) throw new Error(`контрольная сумма ${target.name} не сошлась: ждали ${target.sha256}, пришло ${got}`);
  });

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await untar(archive, out);
  writeFileSync(stamp, `${target.sha256}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`MinGit распакован: ${out}`);

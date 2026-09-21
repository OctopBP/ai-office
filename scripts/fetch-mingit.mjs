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
 * Версия закреплена в коде: сборка не должна меняться от того, что вышло на
 * GitHub сегодня утром. Контрольная сумма берётся из того же ответа API, что и
 * адрес, — она ловит битую загрузку, а не подмену релиза.
 *
 *   node scripts/fetch-mingit.mjs [папка назначения]
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';

const TAG = 'v2.55.0.windows.5';
const ASSET = 'MinGit-2.55.0.5-64-bit.zip';

const root = resolve(import.meta.dirname, '..');
const out = process.argv[2] ?? resolve(root, 'desktop/resources/git');

const untar = (archive, dir) => new Promise((done, fail) => {
  // tar из Windows 10+ и macOS одинаково распаковывает zip — отдельного
  // распаковщика в зависимости тянуть не надо.
  execFile('tar', ['-xf', archive, '-C', dir], (err) => (err ? fail(err) : done()));
});

if (existsSync(resolve(out, 'cmd/git.exe'))) {
  console.log(`MinGit уже на месте: ${out}`);
  process.exit(0);
}

const api = `https://api.github.com/repos/git-for-windows/git/releases/tags/${TAG}`;
const release = await fetch(api, { headers: { accept: 'application/vnd.github+json' } })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub ответил ${r.status}`))));
const asset = release.assets.find((a) => a.name === ASSET);
if (!asset) throw new Error(`в релизе ${TAG} нет ${ASSET}`);

const work = resolve(tmpdir(), `mingit-${process.pid}`);
mkdirSync(work, { recursive: true });
const archive = resolve(work, ASSET);

const res = await fetch(asset.browser_download_url, { redirect: 'follow' });
if (!res.ok || !res.body) throw new Error(`не скачался ${ASSET}: ${res.status}`);
const hash = createHash('sha256');
const source = Readable.fromWeb(res.body);
source.on('data', (chunk) => hash.update(chunk));
await pipeline(source, createWriteStream(archive));

const digest = asset.digest ?? '';
if (digest.startsWith('sha256:') && hash.digest('hex') !== digest.slice('sha256:'.length)) {
  rmSync(work, { recursive: true, force: true });
  throw new Error('контрольная сумма MinGit не сошлась');
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await untar(archive, out);
rmSync(work, { recursive: true, force: true });
console.log(`MinGit распакован: ${out}`);

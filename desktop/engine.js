/**
 * Движок агентов: нативный Claude Code, которым Agent SDK и считает.
 *
 * Внутрь установщика он не кладётся сознательно — бинарь проприетарный, «all
 * rights reserved», и раздавать его со своих релизов нельзя (см.
 * docs/design/desktop-app/spec.md §3). Поэтому приложение сначала ищет уже
 * поставленный Claude Code, а если его нет — скачивает ровно ту версию, под
 * которую собран SDK, из npm: то же место, откуда его берёт `npm ci`, и тот
 * же бинарь.
 *
 * Скачанное лежит в папке данных, рядом с версией: обновился SDK — приедет
 * новый движок, а старый останется на месте и не помешает откату.
 */

const { execFile, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, chmodSync, constants, accessSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { engineDir, resourcesDir } = require('./paths');

const exe = () => (process.platform === 'win32' ? 'claude.exe' : 'claude');

/** Версия SDK, который поедет в сессии: движок должен быть ровно такой же. */
function sdkVersion() {
  const file = join(resourcesDir(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

/** Имя npm-пакета с нативным бинарём под эту машину. */
function platformPackage() {
  return `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
}

/** Куда кладётся скачанный движок. Пусто — версию SDK прочитать не вышло. */
function installedPath() {
  try {
    return join(engineDir(), sdkVersion(), exe());
  } catch {
    // Ресурсы битые — это поломка установки, но не повод падать на старте
    // без единого слова: движок просто «не найден», и об этом скажет офис.
    return '';
  }
}

/** Файл есть и его можно запустить. */
function runnable(path) {
  if (!path) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Движок из PATH — так его находит человек, поставивший Claude Code раньше. */
function fromPath() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [exe()], { encoding: 'utf8', timeout: 5000 });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * Где движок лежит прямо сейчас — или пустая строка. Порядок неслучаен:
 * сначала то, что человек задал руками, потом своё скачанное (его версия
 * заведомо сходится с SDK), и только потом чужие установки.
 */
function find() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    process.env.OFFICE_CLAUDE_BIN ?? '',
    installedPath(),
    // Куда кладёт официальный установщик Anthropic.
    home ? join(home, '.local', 'bin', exe()) : '',
    // Пакет рядом с SDK: так движок выглядит в офисе из исходников.
    join(resourcesDir(), 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, exe()),
    fromPath(),
  ];
  return candidates.find((p) => runnable(p)) ?? '';
}

/** Распаковка .tgz системным tar: он есть и в macOS, и в Windows 10+. */
function untar(archive, dir) {
  return new Promise((done, fail) => {
    execFile('tar', ['-xzf', archive, '-C', dir], (err) => (err ? fail(err) : done()));
  });
}

/**
 * Скачать движок. `onProgress(доля 0..1, байт)` зовётся по мере загрузки:
 * качается больше сотни мегабайт, и молчать столько нельзя.
 *
 * Адрес и контрольная сумма берутся из метаданных npm, а не собираются
 * строкой: так сумма приходит из того же ответа, что и файл, и подменённый
 * архив не пройдёт проверку.
 */
async function install(onProgress = () => {}) {
  const version = sdkVersion();
  const pkg = platformPackage();
  const metaUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/${version}`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) {
    throw new Error(`npm ответил ${metaRes.status} на ${pkg}@${version} — движок под ${process.platform}-${process.arch} не найден`);
  }
  const meta = await metaRes.json();
  const { tarball, integrity } = meta.dist ?? {};
  if (!tarball) throw new Error(`в метаданных ${pkg}@${version} нет архива`);

  const work = join(tmpdir(), `ai-office-engine-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const archive = join(work, 'engine.tgz');

  const res = await fetch(tarball);
  if (!res.ok || !res.body) throw new Error(`не скачался архив движка: ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const hash = createHash('sha512');
  let got = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    got += chunk.length;
    hash.update(chunk);
    onProgress(total ? got / total : 0, got);
  });
  await pipeline(source, createWriteStream(archive));

  if (integrity && integrity.startsWith('sha512-')) {
    const want = integrity.slice('sha512-'.length);
    const have = hash.digest('base64');
    if (have !== want) {
      rmSync(work, { recursive: true, force: true });
      throw new Error('контрольная сумма архива не сошлась — движок не ставим');
    }
  }

  await untar(archive, work);
  const unpacked = join(work, 'package', exe());
  if (!existsSync(unpacked)) throw new Error('в архиве движка нет бинарника');

  const target = installedPath();
  mkdirSync(join(engineDir(), version), { recursive: true });
  rmSync(target, { force: true });
  try {
    renameSync(unpacked, target);
  } catch {
    // Временная папка и папка данных могут оказаться на разных томах —
    // тогда переименование не работает, а копирование работает.
    const { copyFileSync } = require('node:fs');
    copyFileSync(unpacked, target);
  }
  if (process.platform !== 'win32') chmodSync(target, 0o755);
  rmSync(work, { recursive: true, force: true });
  return target;
}

module.exports = { find, install, installedPath, platformPackage, sdkVersion };

/**
 * Копия данных офисов перед откатом версии (спека
 * docs/design/release-channels/spec.md §7.4).
 *
 * Копируется ровно каталог состояния `<userData>/office/` — то, что уже лежит
 * на диске. Секреты из системной связки ключей (src/server/keys.ts) сюда не
 * выгружаются: модуль связку не трогает вовсе. Каталог копии и папка копий —
 * только для владельца учётной записи (0700): в копии задачи, переписка и,
 * возможно, ключи офисов.
 *
 * Модуль без require('electron'), поэтому проверяется обычным node.
 */

const { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { join, relative } = require('node:path');

/** Права каталога копии: читать и писать может только владелец. */
const PRIVATE_DIR = 0o700;

/** Отметка времени для имени папки: `2026-10-06-151903` — сортируется как строка. */
function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Каталог только для владельца. mkdir с mode урезается umask-ом, поэтому права ставим отдельно. */
function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
  if (process.platform !== 'win32') chmodSync(dir, PRIVATE_DIR);
}

/** Файлы копии с размерами — для manifest.json. Ссылки не раскрываем: копируются как ссылки. */
function listFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, full, out);
    else out.push({ path: relative(root, full), size: entry.isFile() ? statSync(full).size : 0 });
  }
  return out;
}

/**
 * Сделать копию `<dataDir>/office/` в `<dataDir>/backups/<время>-before-downgrade-<версия>/`.
 * Внутри: `office/` — копия состояния, `manifest.json` — версия, канал, время
 * и список файлов. Не вышло — бросает ошибку и убирает недописанную копию:
 * откат без копии не идёт.
 *
 * @returns {{ dir: string, manifest: object }}
 */
function backupBeforeDowngrade({ dataDir, version, channel, now = new Date() }) {
  const backups = join(dataDir, 'backups');
  privateDir(backups);
  const base = `${stamp(now)}-before-downgrade-${String(version).replace(/[^0-9A-Za-z.-]/g, '_')}`;
  let dir = join(backups, base);
  for (let n = 2; existsSync(dir); n++) dir = join(backups, `${base}-${n}`);
  try {
    privateDir(dir);
    const source = join(dataDir, 'office');
    const target = join(dir, 'office');
    if (existsSync(source)) cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
    const manifest = {
      version,
      channel,
      at: now.toISOString(),
      files: existsSync(target) ? listFiles(target) : [],
    };
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { dir, manifest };
  } catch (err) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* убрать не вышло — пусть лежит, это не данные */ }
    throw err;
  }
}

module.exports = { backupBeforeDowngrade, PRIVATE_DIR };

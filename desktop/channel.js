/**
 * Канал обновлений — то, что не зависит от Electron и electron-updater
 * (спека docs/design/release-channels/spec.md §7.1–7.2).
 *
 * Здесь только данные: какой канал записан в настройках, пререлиз ли версия
 * и как настроить electron-updater под канал. Диалоги согласия и откат версии
 * сюда не относятся — они в updater.js. Модуль без require('electron'),
 * поэтому проверяется обычным node.
 */

const { readFileSync, renameSync, writeFileSync } = require('node:fs');

/** Каналы от самого спокойного к самому сырому. */
const CHANNELS = ['stable', 'beta', 'alpha'];

const isChannel = (value) => CHANNELS.includes(value);

/** Суффикс пререлиза: `1.5.0-beta.3` → `beta.3`, стабильная версия — ''. */
function prereleaseOf(version) {
  const m = /^v?\d+\.\d+\.\d+-([0-9A-Za-z.-]+?)(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version ?? '').trim());
  return m ? m[1] : '';
}

/** Пререлиз ли версия: есть суффикс `-beta…`, `-alpha…` или любой другой. */
const isPrerelease = (version) => prereleaseOf(version) !== '';

/** Насколько канал сырой: 0 — stable, 2 — alpha. Переход вверх требует согласия (§7.7). */
const channelRank = (channel) => CHANNELS.indexOf(channel);

/**
 * Сравнение версий по semver: <0, 0, >0. Своё, а не пакет semver: модуль
 * должен грузиться без node_modules. Сборка (`+…`) не учитывается.
 * Нечитаемая версия — null: сравнивать её не с чем.
 */
function compareVersions(a, b) {
  const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+?))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? '').trim());
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  // Без пререлиза версия старше той же с пререлизом: 1.5.0 > 1.5.0-beta.3.
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const xs = x[4].split('.');
  const ys = y[4].split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const xn = /^\d+$/.test(xs[i]);
    const yn = /^\d+$/.test(ys[i]);
    if (xn && yn) {
      const d = Number(xs[i]) - Number(ys[i]);
      if (d) return Math.sign(d);
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (xs[i] !== ys[i]) {
      return xs[i] < ys[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Канал по установленной версии — когда настроек ещё нет (§7.1). Для
 * обычной сборки это stable; скачанный руками бета-установщик остаётся на бете.
 */
function channelOfVersion(version) {
  const tag = prereleaseOf(version).split('.')[0];
  return tag === 'beta' || tag === 'alpha' ? tag : 'stable';
}

/**
 * Настройки канала из `update-channel.json`. Файла нет или он битый — канал
 * по версии. Прочие поля файла (согласие §7.7) отдаются как есть, чтобы
 * запись канала их не теряла.
 */
function readPrefs(file, version) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && isChannel(raw.channel)) return { ...raw, fromFile: true };
  } catch { /* нет файла или он битый — выводим по версии */ }
  return { channel: channelOfVersion(version), fromFile: false };
}

/** Записать настройки: сначала во временный файл, потом переименованием — без половинок. */
function writePrefs(file, prefs) {
  const { fromFile: _, ...data } = prefs;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Настройки electron-updater для канала (§7.2).
 *
 * `allowPrerelease` выставляем явно: electron-updater включает его сам, если
 * установлен пререлиз, и вернувшийся на stable продолжал бы получать беты.
 * Сеттер `channel` сам включает `allowDowngrade`, а откат версии без спроса
 * не нужен — поэтому `allowDowngrade = false` после него. Для stable пишем
 * `latest`, а не null: вернуть null сеттер не даст.
 */
function applyChannel(updater, channel) {
  updater.allowPrerelease = channel !== 'stable';
  updater.channel = channel === 'stable' ? 'latest' : channel;
  updater.allowDowngrade = false;
}

module.exports = {
  CHANNELS, isChannel, prereleaseOf, isPrerelease, channelRank, compareVersions, channelOfVersion, readPrefs, writePrefs, applyChannel,
};

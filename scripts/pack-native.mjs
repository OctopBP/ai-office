/**
 * Нативный модуль сервера в ресурсах приложения: node-pty для встроенного
 * терминала (src/server/terminal.ts).
 *
 * В бандл сервера его не собрать: lib/utils.js ищет pty.node по путям от
 * своего файла (`prebuilds/<платформа>-<архитектура>`), а unixTerminal.js
 * рядом с ним же — spawn-helper. Поэтому пакет внешний (build-server.mjs) и
 * едет папкой в resources/node_modules, как Agent SDK. Модуль N-API, бинари
 * готовые: пересобирать под Electron не нужно, ABI не важен. Разбор —
 * docs/backend/T-292/terminal-pty.md, §3 и §6.
 *
 *   node scripts/pack-native.mjs --verify-app desktop/out
 *     — проверить подпись spawn-helper в собранных .app (только macOS)
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';

export const NATIVE_PACKAGE = 'node-pty';

/**
 * Папки prebuilds под цель сборки. На macOS — обе архитектуры: одна машина
 * собирает и arm64, и x64, а модуль берёт папку по process.arch уже в
 * установленном приложении. На Windows цель NSIS только x64.
 */
export function nativeTargets(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return ['darwin-arm64', 'darwin-x64'];
  if (platform === 'win32') return ['win32-x64'];
  // Linux-установщика нет; ресурсы собираются разве что для отладки.
  return [`${platform}-${arch}`];
}

/**
 * Пропускает только то, что нужно в рантайме: package.json, LICENSE, lib/
 * без тестов и карт, prebuilds цели без .pdb. Исходники, deps/, third_party/,
 * scripts/, typings/ и build/ — мимо. build/ особенно: utils.js проверяет его
 * раньше prebuilds, и собранный на машине разработчика pty.node под одну
 * архитектуру перебил бы готовые бинари.
 */
function nativeFilter(base, targets) {
  return (src) => {
    const rel = relative(base, src);
    if (rel === '') return true;
    const parts = rel.split(sep);
    if (parts.length === 1 && (rel === 'package.json' || rel === 'LICENSE')) return true;
    if (parts[0] === 'lib') return !rel.endsWith('.test.js') && !rel.endsWith('.map');
    if (parts[0] === 'prebuilds') {
      if (parts.length === 1) return true;
      return targets.includes(parts[1]) && !rel.endsWith('.pdb');
    }
    return false;
  };
}

/**
 * Копирует node-pty из node_modules репозитория в `<out>/node_modules/node-pty`
 * и возвращает путь копии. После копии — проверка ресурсов: что-то не
 * доехало, и сборка падает здесь, а не у пользователя терминалом «недоступен».
 */
export function packServerNative(root, out, platform = process.platform) {
  const src = resolve(root, 'node_modules', NATIVE_PACKAGE);
  if (!existsSync(join(src, 'package.json'))) {
    throw new Error(`нет ${NATIVE_PACKAGE} в node_modules: npm ci`);
  }
  const dest = resolve(out, 'node_modules', NATIVE_PACKAGE);
  const targets = nativeTargets(platform);
  mkdirSync(resolve(dest, '..'), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true, filter: nativeFilter(src, targets) });

  // cpSync режим сохраняет, но пакет уже приезжал из npm без бита исполнения
  // (1.1.0) — и тогда pty.spawn падает с EACCES только в установленном
  // приложении. Ставим бит явно.
  for (const target of targets) {
    const helper = join(dest, 'prebuilds', target, 'spawn-helper');
    if (target.startsWith('darwin') && existsSync(helper)) chmodSync(helper, 0o755);
  }

  const problems = checkServerNative(out, platform);
  if (problems.length) {
    throw new Error(`${NATIVE_PACKAGE} в ресурсах неполный:\n  ${problems.join('\n  ')}`);
  }
  return dest;
}

/** Что обязано лежать в prebuilds под каждую цель. */
function requiredFiles(target) {
  if (target.startsWith('darwin')) return ['pty.node', 'spawn-helper'];
  if (target.startsWith('win32')) {
    return ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'];
  }
  return ['pty.node'];
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/**
 * Проверка собранных ресурсов: возвращает список бед, пустой — всё на месте.
 * На macOS у обоих spawn-helper должен стоять бит исполнения.
 */
export function checkServerNative(out, platform = process.platform) {
  const dir = resolve(out, 'node_modules', NATIVE_PACKAGE);
  const problems = [];
  for (const file of ['package.json', 'lib/index.js']) {
    if (!existsSync(join(dir, file))) problems.push(`нет ${file}`);
  }
  for (const target of nativeTargets(platform)) {
    for (const file of requiredFiles(target)) {
      const path = join(dir, 'prebuilds', target, file);
      if (!existsSync(path)) {
        problems.push(`нет prebuilds/${target}/${file}`);
      } else if (file === 'spawn-helper' && (statSync(path).mode & 0o111) === 0) {
        problems.push(`prebuilds/${target}/spawn-helper без бита исполнения`);
      }
    }
  }
  if (existsSync(dir)) {
    for (const file of walk(dir)) {
      const rel = relative(dir, file);
      if (rel.endsWith('.pdb')) problems.push(`лишний ${rel}`);
      if (rel.startsWith(`build${sep}`)) problems.push(`лишний ${rel}: перебил бы prebuilds`);
    }
  }
  return problems;
}

/**
 * Подпись spawn-helper в собранном приложении. electron-builder обходит весь
 * бандл, включая Contents/Resources, и переподписывает каждый Mach-O — эта
 * проверка подтверждает, что так и вышло:
 * - бит исполнения пережил упаковку;
 * - `codesign --verify --strict` проходит;
 * - подпись не та, что приехала из npm (`linker-signed`): значит, сборщик
 *   её заменил, иначе нотаризация отвергнет приложение;
 * - при подписи сертификатом — `Authority=Developer ID Application` и
 *   защищённая среда (`runtime` во флагах).
 * В конце — `codesign --verify --deep --strict` всего приложения.
 */
export function checkSignedApp(app, { signed = false } = {}) {
  const problems = [];
  const base = join(app, 'Contents/Resources/node_modules', NATIVE_PACKAGE, 'prebuilds');
  for (const target of nativeTargets('darwin')) {
    const helper = join(base, target, 'spawn-helper');
    if (!existsSync(helper)) {
      problems.push(`${target}: нет spawn-helper`);
      continue;
    }
    if ((statSync(helper).mode & 0o111) === 0) problems.push(`${target}: spawn-helper без бита исполнения`);
    const verify = codesign(['--verify', '--strict', helper]);
    if (!verify.ok) problems.push(`${target}: подпись spawn-helper не проходит проверку: ${verify.text}`);
    const info = codesignInfo(helper);
    if (/linker-signed/.test(info)) problems.push(`${target}: spawn-helper с подписью линкера из npm — сборщик его не переподписал`);
    if (signed) {
      if (!/Authority=Developer ID Application/.test(info)) problems.push(`${target}: spawn-helper подписан не Developer ID`);
      if (!/flags=\S*\(.*runtime.*\)/.test(info)) problems.push(`${target}: у spawn-helper нет hardened runtime`);
    }
  }
  const deep = codesign(['--verify', '--deep', '--strict', app]);
  if (!deep.ok) problems.push(`приложение не проходит codesign --verify --deep --strict: ${deep.text}`);
  return problems;
}

function codesign(args) {
  try {
    const text = execFileSync('codesign', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: `${err.stderr ?? ''}${err.stdout ?? ''}`.trim() || String(err.message) };
  }
}

// -dv печатает в stderr и при успехе: execFileSync его не возвращает, поэтому
// для сведений о подписи зовём через оболочку-обёртку с 2>&1.
function codesignInfo(file) {
  try {
    return execFileSync('/bin/sh', ['-c', 'codesign -dv --verbose=4 "$1" 2>&1', 'sh', file], { encoding: 'utf8' });
  } catch (err) {
    return `${err.stdout ?? ''}`;
  }
}

/** Все .app в папке выхода electron-builder: out/mac-arm64, out/mac и т.п. */
export function findApps(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .flatMap((entry) => readdirSync(join(outDir, entry.name))
      .filter((name) => name.endsWith('.app'))
      .map((name) => join(outDir, entry.name, name)));
}

/**
 * Проверить все собранные .app и упасть, если хоть одна беда. Признак
 * подписи сертификатом — тот же, что в desktop/builder.config.js.
 */
export function verifySignedApps(outDir) {
  if (process.platform !== 'darwin') throw new Error('проверка подписи — только на macOS');
  const apps = findApps(outDir);
  if (!apps.length) throw new Error(`в ${outDir} нет собранных .app`);
  const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
  let failed = false;
  for (const app of apps) {
    const problems = checkSignedApp(app, { signed });
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${app} (${signed ? 'Developer ID' : 'ad-hoc'})`);
    for (const problem of problems) console.log(`     ${problem}`);
    if (problems.length) failed = true;
  }
  if (failed) throw new Error('spawn-helper в собранном приложении подписан не так, как нужно');
}

const flag = process.argv.indexOf('--verify-app');
if (flag !== -1 && import.meta.filename === resolve(process.argv[1] ?? '')) {
  verifySignedApps(resolve(process.argv[flag + 1] ?? 'desktop/out'));
}

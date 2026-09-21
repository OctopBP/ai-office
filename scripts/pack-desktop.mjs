/**
 * Ресурсы приложения: всё, что сервер читает с диска, рядом с собранным
 * сервером.
 *
 * Внутри приложения нет репозитория, а сервер читает из него не только код:
 * пакеты ролей, процессы, реестр маркета, раскладки офиса, свой mcp-сервер
 * картинок. Из исходников это `ROOT` — папка репозитория; в приложении —
 * `OFFICE_ROOT`, то есть вот эта папка ресурсов. Список ниже — исчерпывающий:
 * если сервер начнёт читать что-то ещё, добавлять надо сюда, иначе оно
 * найдётся только на машине разработчика.
 *
 *   node scripts/pack-desktop.mjs
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildServer } from './build-server.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'desktop/resources');

const copy = (from, to) => {
  const src = resolve(root, from);
  if (!existsSync(src)) throw new Error(`нет ресурса ${from}`);
  const dest = resolve(out, to);
  mkdirSync(resolve(dest, '..'), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Сервер одним файлом. Собирается здесь, а не отдельной командой до этой:
// папка ресурсов очищается выше, и собранное раньше просто исчезло бы.
await buildServer(resolve(out, 'server/index.mjs'));

// Собранный веб: его раздаёт сам сервер, как и при `npm run office`.
copy('dist', 'web');

// Файлы, которые сервер читает от ROOT.
copy('packages', 'packages');
copy('workflows', 'workflows');
copy('registry', 'registry');
copy('design/layouts', 'design/layouts');
copy('design/sprites/out/catalog.json', 'design/sprites/out/catalog.json');

// Agent SDK остаётся отдельной папкой, а не бандлится: он ищет нативный
// бинарь относительно собственного файла. Пакеты с самим бинарём не копируем
// — движок приложение ставит отдельно (desktop/engine.js).
copy('node_modules/@anthropic-ai/claude-agent-sdk', 'node_modules/@anthropic-ai/claude-agent-sdk');

// Сервер картинок ходит в MCP по stdio и живёт своим процессом. Его тоже
// складываем в один файл: иначе пришлось бы тащить рядом node_modules ради
// одной зависимости.
await build({
  entryPoints: [resolve(root, 'tools/imagegen/server.mjs')],
  outfile: resolve(out, 'tools/imagegen/server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  logLevel: 'warning',
});

// Свой git — только в Windows-сборке: на macOS он системный. Сборка идёт на
// той системе, под которую собирают (см. .github/workflows/release.yml), так
// что признак системы здесь и есть признак цели.
if (process.platform === 'win32' || process.argv.includes('--mingit')) {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [resolve(root, 'scripts/fetch-mingit.mjs'), resolve(out, 'git')], { stdio: 'inherit' });
}

console.log(`ресурсы приложения собраны: ${out}`);

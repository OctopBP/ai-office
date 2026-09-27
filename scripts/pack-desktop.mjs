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
 *   node scripts/pack-desktop.mjs             — только ресурсы, как всегда
 *   node scripts/pack-desktop.mjs --publish   — ресурсы, установщики и черновик релиза
 *
 * Режим публикации собирает установщики под текущую систему и выкладывает их
 * вместе с latest*.yml и .blockmap в черновик GitHub Release (куда именно —
 * поле publish в desktop/builder.config.js). Токен берётся только из
 * окружения, GH_TOKEN: в репозиторий и в аргументы команды он не попадает.
 * Без флага не публикуется ничего.
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildServer } from './build-server.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'desktop/resources');
const publish = process.argv.includes('--publish');

// Всё, что может сорвать публикацию, проверяем до сборки: иначе ошибка
// всплыла бы через несколько минут, уже после очистки resources/.
if (publish) {
  if (!process.env.GH_TOKEN) {
    throw new Error('для --publish нужен GH_TOKEN в окружении (токен GitHub с правом contents: write)');
  }
  if (!existsSync(resolve(root, 'desktop/node_modules/electron-builder'))) {
    throw new Error('нет зависимостей оболочки: npm ci --prefix desktop');
  }
  // Версию релиза electron-builder берёт из desktop/package.json, а офис
  // показывает версию из корневого. Разойдутся — обновлятор будет сравнивать
  // не то, что видит пользователь.
  const version = (file) => JSON.parse(readFileSync(resolve(root, file), 'utf8')).version;
  if (version('package.json') !== version('desktop/package.json')) {
    throw new Error(`версии расходятся: package.json ${version('package.json')}, desktop/package.json ${version('desktop/package.json')}`);
  }
}

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

if (publish) {
  // Цель — текущая система: dmg и zip подписываются только на macOS, а
  // Windows-сборка тянет свой git (см. выше). Вторую систему выпускают
  // тем же флагом на ней, в тот же черновик — по версии он один.
  const target = process.platform === 'darwin' ? 'dist:mac' : process.platform === 'win32' ? 'dist:win' : null;
  if (!target) throw new Error(`публикация с ${process.platform} не поддерживается: только macOS и Windows`);
  const { execFileSync } = await import('node:child_process');
  execFileSync('npm', ['run', target, '--', '--publish', 'always'], {
    cwd: resolve(root, 'desktop'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  console.log('установщики выложены в черновик релиза на GitHub');
}

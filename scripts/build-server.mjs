/**
 * Сборка сервера офиса в один файл для приложения.
 *
 * Приложению негде взять `tsx` и `node_modules`: внутри него нет ни
 * репозитория, ни npm. Поэтому сервер складывается esbuild'ом в один файл.
 *
 * Формат — ESM, и это не вкусовщина: Agent SDK существует только как ESM,
 * а CommonJS-бандл звал бы его через require и падал бы на запуске.
 *
 * Снаружи остаётся ровно одна зависимость — Agent SDK: он ищет свой нативный
 * бинарь относительно собственного файла, и внутри бандла этот поиск сломался
 * бы. SDK кладётся рядом отдельной папкой (см. scripts/pack-desktop.mjs).
 */

import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/** Собрать сервер в один файл. Путь по умолчанию — ресурсы приложения. */
export const buildServer = (out = resolve(root, 'desktop/resources/server/index.mjs')) => build({
  entryPoints: [resolve(root, 'src/server/index.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  // Внутри бандла оказываются зависимости, написанные под CommonJS: они
  // ждут require, __dirname и __filename, которых в ESM нет. Шапка их
  // возвращает — без неё сборка проходит, а запуск падает на первом же
  // таком месте.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirnameOf } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirnameOf(__filename);',
    ].join('\n'),
  },
  external: [
    '@anthropic-ai/claude-agent-sdk',
    // Необязательные ускорители ws: их может не быть, ws это переживает сам.
    'bufferutil',
    'utf-8-validate',
  ],
  logLevel: 'info',
});

// Запущен напрямую — собираем; импортирован сборщиком ресурсов — он решит сам.
if (process.argv[1] === resolve(import.meta.dirname, 'build-server.mjs')) {
  await buildServer(process.argv[2]);
}

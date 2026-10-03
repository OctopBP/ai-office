/**
 * Свои MCP-серверы офиса для ресурсов приложения: tools/imagegen и
 * tools/browser. Вынесено из pack-desktop.mjs, чтобы проверить этот шаг
 * отдельно (npm run test:packtools) — без сборки сервера и веба.
 *
 * Серверы живут своими процессами и запускаются от ROOT, а в установленном
 * приложении ROOT — это Contents/Resources: чего здесь не положили, того у
 * роли просто нет (так QA однажды остался без браузера).
 */

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Зависимости, которые не бандлятся, а кладутся папкой в resources/node_modules.
 * playwright-core ищет свои файлы (browsers.json, lib/…) относительно себя,
 * так что в один файл его не собрать. Своих зависимостей у него нет.
 */
export const EXTERNAL_TOOL_DEPS = ['playwright-core'];

/** Серверы, которые собираются в один файл каждый. */
export const TOOL_SERVERS = ['tools/imagegen/server.mjs', 'tools/browser/server.mjs'];

/**
 * Собрать серверы из `root` в `out` (папку ресурсов) и положить рядом
 * внешние зависимости. Остальные зависимости (MCP SDK, zod) уходят в бандл:
 * иначе пришлось бы тащить их node_modules целиком.
 */
export async function packTools(root, out) {
  for (const entry of TOOL_SERVERS) {
    await build({
      entryPoints: [resolve(root, entry)],
      outfile: resolve(out, entry),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      external: EXTERNAL_TOOL_DEPS,
      logLevel: 'warning',
    });
  }
  for (const dep of EXTERNAL_TOOL_DEPS) {
    const src = resolve(root, 'node_modules', dep);
    if (!existsSync(src)) throw new Error(`нет зависимости ${dep}: npm ci`);
    const dest = resolve(out, 'node_modules', dep);
    mkdirSync(resolve(dest, '..'), { recursive: true });
    cpSync(src, dest, { recursive: true, dereference: true });
  }
}

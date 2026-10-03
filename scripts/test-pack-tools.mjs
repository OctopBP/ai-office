// Проверка шага сборки приложения со своими MCP-серверами: tools/browser и
// playwright-core обязаны попасть в ресурсы, иначе у QA в установленном
// приложении нет браузера. npm run test:packtools
//
// Собираем во временную папку тем же packTools, что зовёт pack-desktop.mjs,
// и проверяем, что собранный server.mjs находит playwright-core из ресурсов,
// а не из node_modules репозитория.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { EXTERNAL_TOOL_DEPS, packTools, TOOL_SERVERS } from './pack-tools.mjs';

const root = resolve(import.meta.dirname, '..');
// realpath: на macOS tmpdir идёт через симлинк, а require отдаёт настоящий путь.
const out = realpathSync(mkdtempSync(join(tmpdir(), 'pack-tools-')));

let failed = 0;
const check = (what, ok, got) => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(52)} → ${got}`);
};

try {
  await packTools(root, out);

  check('в списке серверов есть браузер', TOOL_SERVERS.includes('tools/browser/server.mjs'), TOOL_SERVERS.join(', '));
  for (const entry of TOOL_SERVERS) {
    check(`собран ${entry}`, existsSync(join(out, entry)), join(out, entry));
  }
  check('playwright-core внешний, а не в бандле', EXTERNAL_TOOL_DEPS.includes('playwright-core'), EXTERNAL_TOOL_DEPS.join(', '));

  const pkg = join(out, 'node_modules/playwright-core/package.json');
  check('playwright-core лежит в ресурсах', existsSync(pkg), pkg);

  const bundled = readFileSync(join(out, 'tools/browser/server.mjs'), 'utf8');
  check('бандл импортирует playwright-core', /from\s*["']playwright-core["']/.test(bundled), 'import из playwright-core');

  // Разрешаем модуль так же, как node при запуске бандла: от его файла вверх.
  const found = createRequire(join(out, 'tools/browser/server.mjs')).resolve('playwright-core');
  check('из бандла находится копия в ресурсах', found.startsWith(out + sep), found);
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} провал(ов)`);
  process.exit(1);
}
console.log('\nвсё в порядке');

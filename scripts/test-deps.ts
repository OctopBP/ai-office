/**
 * Зависимости слитого дерева (T-351, T-346): гейт не берёт node_modules
 * основной копии, если тот не сходится с lock-файлом, даже когда задача lock
 * не меняла. Без npm: установку не запускаем, проверяем решение — сверку lock
 * с node_modules (`lockSatisfied`) и то, что устаревшая основная копия не
 * подставляется симлинком вместо уже поставленного своего каталога.
 *
 * Запуск: node --import tsx/esm scripts/test-deps.ts
 */
import { execFileSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  DEPS_MARKER, lockSatisfied, manifestsHash, prepareDeps,
} from '../src/server/deps';

const failed: string[] = [];
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failed.push(name);
};

const write = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};
const json = (v: unknown) => JSON.stringify(v, null, 2);

const lock = json({
  name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'fixture', version: '1.0.0', dependencies: { a: '^1.0.0', '@x/term': '^6.0.0' } },
    'node_modules/a': { version: '1.0.0' },
    'node_modules/@x/term': { version: '6.0.0' },
    'node_modules/a/node_modules/b': { version: '2.0.0', dev: true },
    'node_modules/only-mac': { version: '1.0.0', optional: true },
    'node_modules/local': { resolved: 'vendor/local', link: true },
  },
});

/** Поставить пакет `path` (путь внутри node_modules) версии `version` в `nm`. */
const pkg = (nm: string, path: string, version: string) =>
  write(resolve(nm, path, 'package.json'), json({ name: path, version }));

/** Основная копия как после `npm ci` по `lock`, но без пакетов из `skip`. */
const install = (nm: string, skip: string[] = []) => {
  const all: Record<string, string> = {
    a: '1.0.0', '@x/term': '6.0.0', 'a/node_modules/b': '2.0.0', local: '0.0.1',
  };
  for (const [path, version] of Object.entries(all)) if (!skip.includes(path)) pkg(nm, path, version);
};

const root = mkdtempSync(resolve(tmpdir(), 'office-deps-'));
try {
  // 1. Сверка lock-файла с node_modules дерева.
  {
    let n = 0;
    const tree = (skip: string[] = []) => {
      const dir = resolve(root, `tree-${n++}`);
      write(resolve(dir, 'package-lock.json'), lock);
      install(resolve(dir, 'node_modules'), skip);
      return dir;
    };
    check('всё стоит — годится', lockSatisfied(tree()));
    check('нет пакета — устарел', !lockSatisfied(tree(['@x/term'])));
    check('нет вложенного пакета — устарел', !lockSatisfied(tree(['a/node_modules/b'])));
    const old = tree();
    pkg(resolve(old, 'node_modules'), 'a', '0.9.0');
    check('другая версия — устарел', !lockSatisfied(old));
    check('необязательный пакет не требуется', lockSatisfied(tree()));
    check('ссылки нет — устарел', !lockSatisfied(tree(['local'])));
    const broken = resolve(root, 'broken');
    write(resolve(broken, 'package-lock.json'), '{');
    check('битый lock сверить нечем — годится', lockSatisfied(broken));
    check('нет lock-файла — сверять нечего', lockSatisfied(resolve(root, 'nolock')));
  }

  // 2. prepareDeps: lock как в базе, а основная копия устарела.
  {
    const repoDir = resolve(root, 'main');
    const worktree = resolve(root, 'copy');
    write(resolve(worktree, '.gitignore'), 'node_modules\n');
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    for (const dir of [repoDir, worktree]) {
      write(resolve(dir, 'package.json'), json({ name: 'fixture', version: '1.0.0' }));
      write(resolve(dir, 'package-lock.json'), lock);
    }
    const mainNm = resolve(repoDir, 'node_modules');
    const own = resolve(worktree, 'node_modules');
    const kind = () => {
      try { return lstatSync(own).isSymbolicLink() ? 'link' : 'dir'; } catch { return 'none'; }
    };

    // Основная копия без @x/term — как main после T-317 без npm ci.
    install(mainNm, ['@x/term']);
    // Свой каталог копии офиса уже поставлен под этот lock прошлым прогоном.
    write(resolve(own, DEPS_MARKER), `${manifestsHash(worktree)}\n`);
    const stale = await prepareDeps(repoDir, worktree, false, 'ru');
    check('lock не менялся, основная копия устарела: свой каталог, не симлинк',
      stale.kind === 'cached' && kind() === 'dir');

    // Основную копию довели до lock, своего каталога нет — гейт берёт симлинк.
    pkg(mainNm, '@x/term', '6.0.0');
    rmSync(own, { recursive: true, force: true });
    const fresh = await prepareDeps(repoDir, worktree, false, 'ru');
    check('lock не менялся, основная копия сходится: симлинк, без установки',
      fresh.kind === 'same' && kind() === 'link');
    const again = await prepareDeps(repoDir, worktree, false, 'ru');
    check('повторный прогон идемпотентен', again.kind === 'same' && kind() === 'link');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed.length) {
  console.error(`\nПровалено: ${failed.length}`);
  process.exit(1);
}
console.log('\nВсе проверки зелёные');

/**
 * Записи registry/registry.json для пакетов из этого же репозитория (T-691).
 *
 * Офис сливает задачи squash-коммитом, и коммит из ветки задачи в main не
 * попадает: так запись @office/unity 0.3.0 указала на 1370559 из ветки T-688,
 * которого в main нет. Установка из git по такой записи ломается, как только
 * ветку удалят. Здесь каждый коммит записи должен быть достижим из main
 * (или из HEAD, если локальной main нет), а версия в plugin.json пакета на
 * этом коммите — совпадать с версией записи.
 *
 * Запуск: node --import tsx/esm scripts/test-registry-commits.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args: string[]): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() };
  } catch {
    return { ok: false, out: '' };
  }
};

let failed = 0;
const fail = (what: string): void => { failed++; console.log(`  ✗ ${what}`); };

if (git(['rev-parse', '--is-shallow-repository']).out === 'true') {
  console.log('мелкий клон без истории — проверку достижимости пропускаю');
  process.exit(0);
}
const target = git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).ok ? 'main' : 'HEAD';

interface Entry { name: string; repo: string; path: string; versions: Array<{ version: string; commit: string }> }
const registry = JSON.parse(readFileSync(resolve(repo, 'registry/registry.json'), 'utf8')) as { packages: Entry[] };
// Свои пакеты — те, что лежат в packages/ этого репозитория.
const own = registry.packages.filter((p) => /OctopBP\/ai-office(\.git)?$/.test(p.repo));

let checked = 0;
for (const pkg of own) {
  for (const v of pkg.versions) {
    const where = `${pkg.name} ${v.version} (${v.commit.slice(0, 7)})`;
    if (!git(['cat-file', '-e', `${v.commit}^{commit}`]).ok) { fail(`${where}: коммита нет в репозитории`); continue; }
    if (!git(['merge-base', '--is-ancestor', v.commit, target]).ok) { fail(`${where}: не достижим из ${target}`); continue; }
    const plugin = git(['show', `${v.commit}:${pkg.path}/.claude-plugin/plugin.json`]);
    if (plugin.ok) {
      const version = (JSON.parse(plugin.out) as { version?: string }).version;
      if (version !== v.version) fail(`${where}: в plugin.json версия ${version ?? '—'}`);
    }
    checked++;
  }
}

console.log(failed ? `\nпровалено записей: ${failed}` : `\nвсе записи достижимы из ${target}: ${checked}`);
process.exit(failed ? 1 : 0);

/**
 * «Читать чужое можно, менять нельзя» у исполнителя (docs/design/subprojects/spec.md
 * §5.2, пп. 2–3): ранний отказ классификатора на запись вне зоны и список
 * файлов вне зоны, который видит finish_task по рабочей копии.
 *
 * Запуск: npm run test:zone-write
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Subproject } from '../src/shared/types';
import { outsideZone, writeZone } from '../src/server/subprojects';
import { classify, decide } from '../src/server/permissions';
import { worktreeOwnFiles } from '../src/server/premerge';

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  results.push(`  ${ok ? '✅' : '❌'} ${what}`);
};
const same = (a: string[], b: string[]): boolean => JSON.stringify(a) === JSON.stringify(b);

const sub = (extra: Partial<Subproject> = {}): Subproject => ({
  id: 'web', name: 'Веб', kind: 'folder', root: 'web', summary: '', color: 'accent-1', createdAt: 0, ...extra,
});

const temp: string[] = [];

function classifier(): void {
  results.push('Классификатор (§5.2, п. 3):');
  const copy = resolve(tmpdir(), 'office-zone-copy');
  const zone = { ...writeZone(sub())!, base: copy };
  const at = (file: string) => resolve(copy, file);

  const own = classify('Write', { file_path: at('web/a.ts'), content: 'x' }, copy, 'ru', zone);
  check('запись в свою зону — обычная запись', own.risk === 'write' && !own.deny);
  const edit = classify('Edit', { file_path: at('server/api.ts'), new_string: 'x' }, copy, 'ru', zone);
  check('Edit чужой зоны — отказ с путём от корня копии', edit.deny === true && edit.detail === 'server/api.ts');
  check('Write чужой зоны — отказ',
    classify('Write', { file_path: at('server/new.ts'), content: 'x' }, copy, 'ru', zone).deny === true);
  check('MultiEdit чужой зоны — отказ',
    classify('MultiEdit', { file_path: at('server/api.ts'), edits: [] }, copy, 'ru', zone).deny === true);
  check('NotebookEdit чужой зоны — отказ',
    classify('NotebookEdit', { notebook_path: at('server/n.ipynb') }, copy, 'ru', zone).deny === true);
  check('по сегментам: web не пускает в webhooks/',
    classify('Write', { file_path: at('webhooks/h.ts'), content: 'x' }, copy, 'ru', zone).deny === true);
  check('отказ сильнее режима «разрешать всё»', decide('auto', edit.risk, edit.deny) === 'deny');
  check('без отказа режим решает как раньше', decide('auto', own.risk, own.deny) === 'allow');
  const rel = classify('Write', { file_path: 'server/x.ts', content: 'x' }, at('web'), 'ru', zone);
  check('относительный путь — от рабочей папки (web/server/x.ts — своя зона)', rel.deny !== true);
  check('корневой lock-файл — общий путь зоны',
    !classify('Write', { file_path: at('package-lock.json'), content: '{}' }, copy, 'ru', zone).deny);
  check('файл вне копии зона не судит (его держит outside)',
    classify('Write', { file_path: '/etc/hosts', content: 'x' }, copy, 'ru', zone).deny !== true);

  check('Read чужой зоны разрешён',
    classify('Read', { file_path: at('server/api.ts') }, copy, 'ru', zone).risk === 'safe');
  check('Grep по чужой зоне разрешён',
    classify('Grep', { pattern: 'x', path: at('server') }, copy, 'ru', zone).risk === 'safe');
  check('Glob по чужой зоне разрешён',
    classify('Glob', { pattern: 'server/**/*.ts', path: copy }, copy, 'ru', zone).risk === 'safe');
  check('без зоны запись не ограничена',
    !classify('Write', { file_path: at('server/api.ts'), content: 'x' }, copy, 'ru').deny);
}

async function finishTask(): Promise<void> {
  results.push('Проверка при сдаче (§5.2, п. 2):');
  const dir = mkdtempSync(resolve(tmpdir(), 'office-zone-write-'));
  temp.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (name: string, body: string) => {
    mkdirSync(resolve(dir, name, '..'), { recursive: true });
    writeFileSync(resolve(dir, name), body);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  write('web/app.ts', '1\n');
  write('server/api.ts', '1\n');
  git('add', '-A');
  git('commit', '-qm', 'Начало');
  const zone = writeZone(sub())!;

  // База ушла вперёд в чужой зоне, ветка её подтянула — это не нарушение.
  git('checkout', '-q', '-b', 'task/T-1');
  write('web/app.ts', '2\n');
  git('commit', '-qam', 'T-1');
  git('checkout', '-q', 'main');
  write('server/other.ts', 'чужое\n');
  git('add', '-A');
  git('commit', '-qm', 'чужая работа');
  git('checkout', '-q', 'task/T-1');
  git('merge', '-q', '--no-edit', 'main');
  check('подтянутая база — не нарушение', same(outsideZone(zone, await worktreeOwnFiles(dir, 'main')), []));

  write('server/api.ts', 'правка без коммита\n');
  write('server/new.ts', 'новый файл\n');
  write('web/more.ts', 'своё\n');
  check('незакоммиченное и новое вне зоны видно',
    same(outsideZone(zone, await worktreeOwnFiles(dir, 'main')), ['server/api.ts', 'server/new.ts']));

  git('checkout', '-q', '--', 'server/api.ts');
  rmSync(resolve(dir, 'server/new.ts'));
  git('mv', 'server/api.ts', 'web/api.ts');
  git('commit', '-qm', 'перенос');
  check('перенос из чужой папки в свою — удаление чужого',
    same(outsideZone(zone, await worktreeOwnFiles(dir, 'main')), ['server/api.ts']));
}

try {
  classifier();
  await finishTask();
} finally {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.includes('❌')).length;
console.log(failed ? `\n❌ провалено: ${failed}` : '\n✅ всё зелёное');
process.exit(failed ? 1 : 0);

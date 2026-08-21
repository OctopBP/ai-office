/**
 * Проверка мержабельности и очереди слияния на настоящем репозитории,
 * без единого токена: создаём временный репозиторий с расходящимися ветками
 * и гоняем по нему сухую проверку и очередь.
 *
 * Запуск: npm run test:merge
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { office } from '../src/server/state';
import { checkMergeable } from '../src/server/git';
import { mergeQueue, refreshMergeChecks } from '../src/server/merge';

/** Тестовый репозиторий: main, три ветки задач, свой скрипт typecheck. */
function fixture(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'office-merge-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (name: string, body: string) => writeFileSync(resolve(dir, name), body);

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { typecheck: 'node check.js' } }));
  // Проверка сборки падает, если в дереве появился файл boom — так одна из
  // веток «ломает сборку», ничего не собирая по-настоящему.
  write('check.js', "const fs=require('fs');if(fs.existsSync('boom')){console.error('сломано: boom');process.exit(1);}");
  write('shared.txt', 'общая строка\n');
  git('add', '-A');
  git('commit', '-qm', 'Начало');

  const branch = (name: string, files: Record<string, string>) => {
    git('checkout', '-q', '-b', name, 'main');
    for (const [file, body] of Object.entries(files)) write(file, body);
    git('add', '-A');
    git('commit', '-qm', name);
    git('checkout', '-q', 'main');
  };
  branch('task/T-1', { 'a.txt': 'A\n', 'shared.txt': 'строка от T-1\n' });
  branch('task/T-2', { 'b.txt': 'B\n', 'shared.txt': 'строка от T-2\n' });
  branch('task/T-3', { boom: 'ломаем сборку\n' });
  return dir;
}

async function main(): Promise<void> {
  office.setStateFile(resolve(tmpdir(), `office-merge-state-${process.pid}.json`));
  const dir = fixture();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const results: string[] = [];

  office.seed();
  office.projectDir = dir;
  for (let i = 1; i <= 3; i += 1) {
    const task = office.createTask({ title: `Задача ${i}`, description: '', criteria: [], roleId: 'backend' });
    office.updateTask(task.id, {
      status: 'done', branch: `task/${task.id}`, baseBranch: 'main', repoDir: dir,
    });
  }

  // 1. Сухая проверка ничего не меняет в основной ветке.
  const head = git('rev-parse', 'HEAD');
  const dry = await checkMergeable(dir, 'task/T-1', 'main');
  results.push(
    `чистая ветка видна как clean: ${dry.state === 'clean'}`,
    `main после проверки не сдвинулся: ${git('rev-parse', 'HEAD') === head}`,
    `рабочая копия чиста: ${git('status', '--porcelain') === ''}`,
  );

  // 2. Статусы по всем завершённым задачам: до слияний конфликтов нет.
  const before = await refreshMergeChecks();
  results.push(
    `статус есть у всех трёх задач: ${before.length === 3}`,
    `до слияний все сливаются чисто: ${before.every((c) => c.state === 'clean')}`,
  );

  // 3. Очередь: T-1 вливается, после чего T-2 конфликтует с ним по shared.txt.
  const run = await mergeQueue(['T-1', 'T-2']);
  const first = run?.steps[0];
  const second = run?.steps[1];
  results.push(
    `первая задача влита: ${first?.status === 'merged'}`,
    `проверка сборки после слияния прошла: ${first?.typecheck?.ok === true && first.typecheck.skipped === false}`,
    `очередь встала на второй: ${second?.status === 'conflict'}`,
    `названы конфликтные файлы: ${second?.conflicts.join(',') === 'shared.txt'}`,
    `в итоге сказано, где встали: ${Boolean(run && run.summary.includes('T-2') && run.summary.includes('shared.txt'))}`,
    `конфликт не оставил следов в main: ${git('status', '--porcelain') === ''}`,
    `T-1 отмечена слитой: ${office.tasks.get('T-1')?.merged === true}`,
    `T-2 слитой не отмечена: ${office.tasks.get('T-2')?.merged === false}`,
  );

  // 4. Пересчёт после слияния: T-2 теперь конфликтует, хотя раньше был clean.
  const after = office.mergeChecks.get('T-2');
  results.push(
    `после слияния статус T-2 пересчитан в conflict: ${after?.state === 'conflict'}`,
    `в статусе перечислены файлы: ${after?.conflicts.join(',') === 'shared.txt'}`,
  );

  // 5. Ветка сливается чисто, но ломает сборку — очередь это ловит.
  const broken = await mergeQueue(['T-3']);
  const step = broken?.steps[0];
  results.push(
    `падение сборки остановило очередь: ${step?.status === 'typecheck-failed'}`,
    `вывод проверки ушёл в результат: ${Boolean(step?.typecheck && !step.typecheck.ok && step.typecheck.output.includes('boom'))}`,
  );

  rmSync(dir, { recursive: true, force: true });
  office.wipe();

  // Прошедшей считается только строка, кончающаяся на true: «не false» пропускало
  // в зачёт всё, что вообще не булево, — например undefined из-за опечатки.
  const failed = results.filter((r) => !r.endsWith('true'));
  for (const r of results) console.log(`  ${r.endsWith('true') ? '✅' : '❌'} ${r}`);
  if (results.length === 0) {
    console.error('не выполнено ни одной проверки — прогону верить нельзя');
    process.exit(2);
  }
  console.log(failed.length
    ? `ПРОВАЛЕНО: ${failed.length} из ${results.length}`
    : `Все проверки прошли: ${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

// Упавший прогон обязан быть виден как провал, а не как тихо оборванный успех.
void main().catch((err) => {
  console.error(`прогон сорвался: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(2);
});

/**
 * Проверка мержабельности и очереди слияния на настоящем репозитории,
 * без единого токена: создаём временный репозиторий с расходящимися ветками
 * и гоняем по нему сухую проверку и очередь.
 *
 * Запуск: npm run test:merge
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice } from '../src/server/state';
import { checkMergeable } from '../src/server/git';
import { integrationDir, mergeQueue, refreshMergeChecks } from '../src/server/merge';

// Проверки сверяют тексты офиса дословно и написаны по-русски — значит,
// и офисы здесь должны быть русскими. Язык нового офиса берётся из
// окружения, и задать его надо до того, как офис откроется.
process.env.OFFICE_LANG = 'ru';

/** Офис проверки — по id: общего «текущего офиса» на процесс больше нет. */
const office = getOffice('o-1');

/**
 * Вложенный репозиторий внутри родительского: у офиса они разные у разных
 * ролей, а имя основной ветки у всех одно — на этом совпадении и держалась
 * ошибка. Родительскому он не виден (лежит в .gitignore), как и бывает.
 */
function nested(parent: string, name: string, branch: string): string {
  const dir = resolve(parent, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, 'readme.txt'), `${name}\n`);
  git('add', '-A');
  git('commit', '-qm', 'Начало');
  git('checkout', '-q', '-b', branch);
  writeFileSync(resolve(dir, 'work.txt'), `работа ${branch}\n`);
  git('add', '-A');
  git('commit', '-qm', branch);
  git('checkout', '-q', 'main');
  appendFileSync(resolve(parent, '.gitignore'), `${name}/\n`);
  execFileSync('git', ['add', '-A'], { cwd: parent });
  execFileSync('git', ['commit', '-qm', `игнорируем ${name}`], { cwd: parent });
  return dir;
}

/** Общая служебная директория репозитория — по ней видно, чей это worktree. */
const commonDir = (dir: string): string => realpathSync(resolve(dir,
  execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, encoding: 'utf8' }).trim()));

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
  write('.gitignore', '.office/\n');
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
  process.chdir(dir);
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
  const dry = await checkMergeable(dir, 'task/T-1', 'main', 'ru');
  results.push(
    `чистая ветка видна как clean: ${dry.state === 'clean'}`,
    `main после проверки не сдвинулся: ${git('rev-parse', 'HEAD') === head}`,
    `рабочая копия чиста: ${git('status', '--porcelain') === ''}`,
  );

  // 2. Статусы по всем завершённым задачам: до слияний конфликтов нет.
  const before = await refreshMergeChecks(office);
  results.push(
    `статус есть у всех трёх задач: ${before.length === 3}`,
    `до слияний все сливаются чисто: ${before.every((c) => c.state === 'clean')}`,
  );

  // 3. Очередь: T-1 вливается, после чего T-2 конфликтует с ним по shared.txt.
  const run = await mergeQueue(['T-1', 'T-2'], office);
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

  // 5. Ветка сливается чисто, но ломает сборку — очередь ловит это ДО того,
  //    как основная ветка сдвинется: сломанная сборка в main не попадает вовсе.
  const headBeforeBroken = git('rev-parse', 'main');
  const broken = await mergeQueue(['T-3'], office);
  const step = broken?.steps[0];
  results.push(
    `падение сборки остановило очередь: ${step?.status === 'typecheck-failed'}`,
    `вывод проверки ушёл в результат: ${Boolean(step?.typecheck && !step.typecheck.ok && step.typecheck.output.includes('boom'))}`,
    `сломанная ветка в main не влита: ${git('rev-parse', 'main') === headBeforeBroken}`,
    `T-3 слитой не отмечена: ${office.tasks.get('T-3')?.merged === false}`,
    `файл, ломающий сборку, в рабочую копию не попал: ${git('status', '--porcelain') === ''}`,
  );

  // 6. Незакоммиченная правка человека больше не мешает слиянию: оно
  //    собирается в рабочей копии офиса, а не в его.
  git('checkout', '-q', '-b', 'task/T-4', 'main');
  writeFileSync(resolve(dir, 'later.txt'), 'работа T-4\n');
  git('add', '-A');
  git('commit', '-qm', 'T-4');
  git('checkout', '-q', 'main');
  const t4 = office.createTask({ title: 'Задача 4', description: '', criteria: [], roleId: 'backend' });
  office.updateTask(t4.id, { status: 'done', branch: 'task/T-4', baseBranch: 'main', repoDir: dir });
  writeFileSync(resolve(dir, 'shared.txt'), 'человек правит и не коммитит\n');

  const withDirty = await mergeQueue([t4.id], office);
  results.push(
    `грязная копия человека не остановила слияние: ${withDirty?.steps[0]?.status === 'merged'}`,
    `правка человека цела: ${readFileSync(resolve(dir, 'shared.txt'), 'utf8').includes('человек правит')}`,
    `влитое доехало до рабочей копии: ${existsSync(resolve(dir, 'later.txt'))}`,
  );
  git('checkout', '--', 'shared.txt');

  // 7. Несколько репозиториев в одном офисе. Копия офиса для слияний одна на
  //    репозиторий: пока она была одна на офис, ветка вложенного репозитория
  //    приезжала в копию родительского, где её просто нет, — и ни одна задача
  //    вложенного репозитория не сливалась никогда.
  const back = nested(dir, 'back', 'task/T-5');
  const front = nested(dir, 'front', 'task/T-6');
  const inBack = office.createTask({ title: 'Во вложенном back', description: '', criteria: [], roleId: 'backend' });
  office.updateTask(inBack.id, {
    status: 'done', branch: 'task/T-5', baseBranch: 'main', repoDir: back,
  });
  const inFront = office.createTask({ title: 'Во вложенном front', description: '', criteria: [], roleId: 'backend' });
  office.updateTask(inFront.id, {
    status: 'done', branch: 'task/T-6', baseBranch: 'main', repoDir: front,
  });

  const parentMain = git('rev-parse', 'main');
  const nestedRun = await mergeQueue([inBack.id, inFront.id], office);
  const at = (repo: string, ref: string) =>
    execFileSync('git', ['rev-parse', ref], { cwd: repo, encoding: 'utf8' }).trim();
  /** Влита ли ветка в основную этого репозитория. Слияние идёт --no-ff. */
  const merged = (repo: string, branch: string) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', branch, 'main'], { cwd: repo });
      return true;
    } catch {
      return false;
    }
  };
  results.push(
    `задача вложенного репозитория влита: ${nestedRun?.steps[0]?.status === 'merged'}`,
    `задача второго вложенного влита: ${nestedRun?.steps[1]?.status === 'merged'}`,
    `ветка доехала до main вложенного back: ${merged(back, 'task/T-5')}`,
    `ветка доехала до main вложенного front: ${merged(front, 'task/T-6')}`,
    `main родительского репозитория не тронут: ${git('rev-parse', 'main') === parentMain}`,
    `у каждого репозитория своя копия офиса: ${new Set([
      integrationDir(office, dir), integrationDir(office, back), integrationDir(office, front),
    ]).size === 3}`,
    `копия офиса заведена от своего репозитория: ${existsSync(resolve(integrationDir(office, back), '.git'))
      && commonDir(integrationDir(office, back)) === commonDir(back)}`,
  );

  // 8. Ветки задачи нет в её репозитории — это поломка настройки, а не гонка
  //    с базой: очередь обязана встать и назвать репозиторий, а не молча
  //    слить что-то в чужом.
  const lost = office.createTask({ title: 'Ветка не в том репозитории', description: '', criteria: [], roleId: 'backend' });
  office.updateTask(lost.id, {
    status: 'done', branch: 'task/T-1', baseBranch: 'main', repoDir: back,
  });
  const backMain = at(back, 'main');
  const lostRun = await mergeQueue([lost.id], office);
  const lostStep = lostRun?.steps[0];
  results.push(
    `чужая ветка не выдана за конфликт: ${lostStep?.status === 'failed'}`,
    `в отказе назван репозиторий: ${Boolean(lostStep?.message.includes(back))}`,
    `в отказе названа ветка: ${Boolean(lostStep?.message.includes('task/T-1'))}`,
    `в чужом репозитории ничего не влито: ${at(back, 'main') === backMain}`,
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

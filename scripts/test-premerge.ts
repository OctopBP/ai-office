/**
 * Пред-merge гейт на настоящем репозитории, без единого токена: создаём
 * временный репозиторий, где ветка зелена в одиночку и красна вместе с main,
 * и проверяем четыре вещи — грязная копия останавливает слияние, красное слитое
 * дерево не уезжает в main, зелёный сценарий сливает как раньше и, наконец, что
 * то же самое умеет автоматический конвейер офиса, а не только консоль.
 *
 * Запуск: npm run test:premerge
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  defaultIntegrationDir, formatReport, mergeChecks, preMergeGate,
} from '../src/server/premerge';
import { getOffice } from '../src/server/state';
import { runPipeline, setPipelineAgents } from '../src/server/review';

// Сообщения гейта сверяются дословно и написаны по-русски.
process.env.OFFICE_LANG = 'ru';

/**
 * Репозиторий-стенд. «Сборка» — скрипт, который сверяет версию api.txt с тем,
 * что вызывают файлы use*.txt: так ветка может быть зелёной сама по себе и
 * красной вместе с main, ни разу не конфликтуя по файлам.
 */
const CHECK = `const fs=require('fs');
const api=fs.readFileSync('api.txt','utf8').trim();
const bad=fs.readdirSync('.').filter(n=>/^use.*\\.txt$/.test(n))
  .filter(n=>fs.readFileSync(n,'utf8').trim()!==api)
  .map(n=>n+'(1,1): error TS2554: ожидался '+api+', вызывается '+fs.readFileSync(n,'utf8').trim());
if(bad.length){console.error(bad.join('\\n'));process.exit(1);}
console.log('сборка чиста');
`;
const TESTS = "console.log('тесты прошли');\n";

function fixture(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'office-premerge-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (name: string, body: string) => writeFileSync(resolve(dir, name), body);

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  write('package.json', JSON.stringify({
    name: 'fixture', scripts: { typecheck: 'node check.js', test: 'node tests.js' },
  }));
  write('check.js', CHECK);
  write('tests.js', TESTS);
  write('.gitignore', '.office/\n');
  write('api.txt', 'v1\n');
  write('use.txt', 'v1\n');
  git('add', '-A');
  git('commit', '-qm', 'Начало: api v1');

  // Ветка, зелёная в одиночку: новый вызов той же версии api, что была в базе.
  git('checkout', '-q', '-b', 'task/T-red', 'main');
  write('use2.txt', 'v1\n');
  git('add', '-A');
  git('commit', '-qm', 'T-red: новый вызов api v1');
  git('checkout', '-q', 'main');

  // Ветка, зелёная и после слияния.
  git('checkout', '-q', '-b', 'task/T-green', 'main');
  write('readme.txt', 'просто текст\n');
  git('add', '-A');
  git('commit', '-qm', 'T-green: файл, ни на что не влияющий');
  git('checkout', '-q', 'main');
  return dir;
}

/**
 * Тот же гейт, но в автоматическом конвейере офиса (T-145).
 *
 * Стенд повторяет ровно ту слепоту, из-за которой поломки жили в main: узел
 * `checks` конвейера гоняет по ветке только сборку, а расхождение видит другая,
 * дешёвая проверка проекта — она и стоит в наборе гейта. Ветка при этом зелена
 * сама по себе: пока main не уехал, весь набор на ней проходит.
 */
function pipelineFixture(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'office-premerge-pipe-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (name: string, body: string) => writeFileSync(resolve(dir, name), body);

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  write('package.json', JSON.stringify({
    name: 'fixture', scripts: { typecheck: 'node check.js', 'test:state': 'node api-check.js' },
  }));
  // Сборка: слепа к версии api — ровно как typecheck в настоящем проекте.
  write('check.js', "const fs=require('fs');if(fs.existsSync('boom')){console.error('сломано: boom');process.exit(1);}\n");
  write('api-check.js', CHECK);
  write('.gitignore', '.office/\n');
  write('api.txt', 'v1\n');
  write('use.txt', 'v1\n');
  git('add', '-A');
  git('commit', '-qm', 'Начало: api v1');
  return dir;
}

async function pipelineGate(check: (name: string, ok: boolean) => void): Promise<void> {
  const office = getOffice('o-premerge');
  const dir = pipelineFixture();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const home = process.cwd();
  // Рабочие копии задач конвейер кладёт рядом с рабочей директорией процесса.
  process.chdir(dir);
  office.setStateFile(resolve(tmpdir(), `office-premerge-state-${process.pid}.json`));
  office.seed();
  office.projectDir = dir;
  office.settings.autoPipeline = true;

  const pm: string[] = [];
  setPipelineAgents({
    async review() {
      return { verdict: 'approve', text: 'Замечаний нет.', reviewerId: 'reviewer#1' };
    },
    async rework() { return { ok: true, message: 'ничего не менял' }; },
    notifyPm(_state, text) { pm.push(text); },
  });

  const task = office.createTask({
    title: 'Новый вызов api', description: 'тестовая', criteria: ['готово'], roleId: 'backend',
  });
  git('checkout', '-q', '-b', `task/${task.id}`, 'main');
  writeFileSync(resolve(dir, 'use2.txt'), 'v1\n');
  git('add', '-A');
  git('commit', '-qm', `${task.id}: новый вызов api v1`);
  git('checkout', '-q', 'main');
  office.updateTask(task.id, {
    status: 'review', branch: `task/${task.id}`, baseBranch: 'main',
    repoDir: dir, worktreePath: null, result: 'сделано',
  });

  // Набор гейта берётся из package.json репозитория: придуманных команд в нём
  // не бывает, а test:pm не бывает никогда — за слияние офис не платит.
  const commands = mergeChecks(dir);
  check('в наборе гейта только скрипты проекта',
    commands.length === 2 && commands[0].includes('typecheck') && commands[1].includes('test:state'));
  check('test:pm в набор не попал', commands.every((c) => !c.includes('test:pm')));

  // 1. Пока main не уехал, ветка зелена под всем набором — сама по себе.
  const alone = await preMergeGate({
    repoDir: dir, branch: `task/${task.id}`, base: 'main', merge: false, checks: commands,
  });
  check('ветка зелена в одиночку', alone.ok && alone.stage === 'checked'
    && alone.checks.length === 2 && alone.checks.every((c) => c.ok));

  // 2. main уезжает вперёд — и вместе они уже не сходятся.
  writeFileSync(resolve(dir, 'api.txt'), 'v2\n');
  writeFileSync(resolve(dir, 'use.txt'), 'v2\n');
  git('add', '-A');
  git('commit', '-qm', 'main: api v2');
  // Человек прямо сейчас правит свой файл и не коммитит: это не должно ничего
  // менять ни в ту, ни в другую сторону (то же проверяет test:merge).
  writeFileSync(resolve(dir, 'human.txt'), 'человек правит и не коммитит\n');
  const headV2 = git('rev-parse', 'main');

  await runPipeline(office, task.id);

  const pr = office.prOf(task.id);
  const note = pr?.note ?? '';
  console.log('\n▶ Красная после слияния ветка не вливается конвейером');
  check('конвейер встал', pr?.stage === 'stuck');
  check('задача не отмечена слитой', office.tasks.get(task.id)?.merged !== true);
  check('main не сдвинулся', git('rev-parse', 'main') === headV2);
  check('ветка задачи цела', git('branch', '--list', `task/${task.id}`).length > 0);
  check('в причине названа упавшая команда', note.includes('test:state'));
  check('в причине назван файл с ошибкой', note.includes('use2.txt'));
  check('в причине есть текст ошибки', note.includes('error TS2554'));
  check('причина по-русски', note.includes('падает проверка') && note.includes('не тронута'));
  check('менеджеру сказали, что конвейер встал',
    pr?.needsDecision === true && pm.some((m) => m.includes(task.id) && m.includes('test:state')));
  check('правка человека цела',
    readFileSync(resolve(dir, 'human.txt'), 'utf8').includes('человек правит'));

  process.chdir(home);
  office.wipe();
  rmSync(defaultIntegrationDir(dir), { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Занятый каталог интеграции (T-56, T-58).
 *
 * Гейт собирает слияние в фиксированном каталоге, и занять его может кто
 * угодно — хоть посторонний ручной прогон офиса из той же папки. Раньше на этом
 * в основную ветку переставало вливаться вообще всё, а человек читал
 * бессмысленное «база уезжает быстрее, чем задача успевает слиться». Проверяем
 * три исхода: свой застрявший worktree офис снимает сам, чужой обходит запасным
 * каталогом, а то, что обойти нельзя, доезжает отдельной стадией с текстом ошибки.
 */
async function busyIntegration(check: (name: string, ok: boolean) => void): Promise<void> {
  const dir = fixture();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const holder = mkdtempSync(resolve(tmpdir(), 'office-base-'));

  console.log('\n▶ Занятый каталог интеграции');

  // 1а. Протухшая запись: worktree в git числится, а каталога уже нет.
  //     Лечится `worktree prune` — офис обязан сделать это сам.
  const stale = resolve(holder, 'stale', '_base');
  execFileSync('git', ['worktree', 'add', '--detach', stale, 'main'], { cwd: dir });
  rmSync(stale, { recursive: true, force: true });
  const headBefore = git('rev-parse', 'main');

  const afterStale = await preMergeGate({
    repoDir: dir, branch: 'task/T-green', base: 'main', integrationDir: stale,
  });
  check('протухшая запись worktree не мешает слиянию',
    afterStale.ok === true && afterStale.stage === 'merged');
  check('слияние собрано в основном каталоге', afterStale.integrationDir === stale);
  check('main сдвинулся', git('rev-parse', 'main') !== headBefore);
  check('в отчёте сказано про prune',
    afterStale.warnings.some((w) => w.includes('worktree prune')));
  rmSync(stale, { recursive: true, force: true });
  execFileSync('git', ['worktree', 'prune'], { cwd: dir });

  // 1б. Свой же worktree, застрявший в каталоге негодным: запись есть, каталог
  //     есть, а копия сломана — её и переиспользовать нельзя, и git на неё
  //     ругается. Офис снимает её сам (`worktree remove --force`).
  const broken = resolve(holder, 'broken', '_base');
  execFileSync('git', ['worktree', 'add', '--detach', broken, 'main'], { cwd: dir });
  rmSync(resolve(broken, '.git'), { force: true });
  const headBroken = git('rev-parse', 'main');

  const afterBroken = await preMergeGate({
    repoDir: dir, branch: 'task/T-red', base: 'main', integrationDir: broken,
  });
  check('застрявший worktree офиса не мешает слиянию',
    afterBroken.ok === true && afterBroken.stage === 'merged');
  check('слияние собрано в основном каталоге', afterBroken.integrationDir === broken);
  check('в отчёте сказано, что копию пересобрали',
    afterBroken.warnings.some((w) => w.includes('пересобираем')));
  check('main сдвинулся после снятия застрявшей копии',
    git('rev-parse', 'main') !== headBroken);
  rmSync(broken, { recursive: true, force: true });
  execFileSync('git', ['worktree', 'prune'], { cwd: dir });

  // 2. Каталог занят ЧУЖИМ worktree — из другого репозитория. Трогать его
  //    нельзя, а сливать надо: слияние уезжает в запасной каталог рядом.
  const other = mkdtempSync(resolve(tmpdir(), 'office-other-'));
  const oth = (...args: string[]) => execFileSync('git', args, { cwd: other, encoding: 'utf8' }).trim();
  oth('init', '-q', '-b', 'main');
  oth('config', 'user.email', 'office@local');
  oth('config', 'user.name', 'AI Office');
  writeFileSync(resolve(other, 'readme.txt'), 'чужой репозиторий\n');
  oth('add', '-A');
  oth('commit', '-qm', 'Чужое начало');
  const busy = resolve(holder, 'busy', '_base');
  oth('worktree', 'add', '--detach', busy, 'main');
  writeFileSync(resolve(busy, 'чужое.txt'), 'чужая несохранённая работа\n');

  git('checkout', '-q', '-b', 'task/T-aside', 'main');
  writeFileSync(resolve(dir, 'aside.txt'), 'работа в обход занятого каталога\n');
  git('add', '-A');
  git('commit', '-qm', 'T-aside');
  git('checkout', '-q', 'main');
  const headBusy = git('rev-parse', 'main');
  const aside = await preMergeGate({
    repoDir: dir, branch: 'task/T-aside', base: 'main', integrationDir: busy,
  });
  check('чужой каталог не остановил слияние', aside.ok === true && aside.stage === 'merged');
  check('слияние ушло в запасной каталог рядом',
    aside.integrationDir !== busy && aside.integrationDir.startsWith(`${busy}-`));
  check('запасной каталог после себя убран', !existsSync(aside.integrationDir));
  check('в отчёте назван обход',
    aside.warnings.some((w) => w.includes('запасном каталоге')));
  check('main сдвинулся', git('rev-parse', 'main') !== headBusy);
  check('чужая работа цела',
    readFileSync(resolve(busy, 'чужое.txt'), 'utf8').includes('чужая несохранённая'));
  check('чужой worktree остался на месте', oth('worktree', 'list').includes(busy));

  // 3. Каталог поднять нельзя вовсе: родительская папка закрыта на запись.
  //    Такая беда обязана доехать своей стадией и текстом ошибки, а не
  //    притвориться расхождением с базой.
  git('checkout', '-q', '-b', 'task/T-locked', 'main');
  writeFileSync(resolve(dir, 'locked.txt'), 'работа третьей задачи\n');
  git('add', '-A');
  git('commit', '-qm', 'T-locked');
  git('checkout', '-q', 'main');
  const readonly = resolve(holder, 'readonly');
  mkdirSync(readonly, { recursive: true });
  chmodSync(readonly, 0o500);
  const headLocked = git('rev-parse', 'main');
  const locked = await preMergeGate({
    repoDir: dir, branch: 'task/T-locked', base: 'main',
    integrationDir: resolve(readonly, 'wt', '_base'),
  });
  check('неустранимая беда останавливает гейт', locked.ok === false);
  check('у неё своя стадия, а не «конфликт»', locked.stage === 'integration');
  check('в сообщении назван каталог', locked.message.includes(readonly));
  check('в сообщении есть текст ошибки', locked.message.includes('EACCES'));
  check('сказано, что основная ветка не тронута', locked.message.includes('не тронута'));
  check('main не сдвинулся', git('rev-parse', 'main') === headLocked);
  chmodSync(readonly, 0o700);

  rmSync(holder, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const dir = fixture();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const results: string[] = [];
  const check = (name: string, ok: boolean) => results.push(`${name}: ${ok}`);

  // 1. Грязная рабочая копия main останавливает слияние (ситуация из J-4).
  writeFileSync(resolve(dir, 'use.txt'), 'человек правит и не коммитит\n');
  const headBefore = git('rev-parse', 'main');
  const dirty = await preMergeGate({ repoDir: dir, branch: 'task/T-green', base: 'main' });
  check('грязная копия останавливает гейт', dirty.ok === false && dirty.stage === 'dirty');
  check('в сообщении назван грязный файл', dirty.message.includes('use.txt'));
  check('в сообщении сказано, что делать',
    dirty.message.includes('stash') && dirty.message.includes('Слияние не выполнено'));
  check('ветка не влита', git('rev-parse', 'main') === headBefore);
  check('правка человека цела',
    readFileSync(resolve(dir, 'use.txt'), 'utf8').includes('человек правит'));
  check('проверки на грязной копии не гонялись', dirty.checks.length === 0);
  check('время шага измерено', dirty.totalMs > 0 && dirty.gateMs > 0);

  // 1б. С --stash та же грязная копия проходит: правки уезжают и возвращаются.
  const stashed = await preMergeGate({
    repoDir: dir, branch: 'task/T-green', base: 'main', stash: true,
  });
  check('со stash гейт проходит', stashed.ok === true && stashed.stage === 'merged');
  check('правки вернулись из stash',
    readFileSync(resolve(dir, 'use.txt'), 'utf8').includes('человек правит')
    && stashed.warnings.length === 0);
  check('T-green влита', git('rev-parse', 'main') !== headBefore);
  git('checkout', '--', 'use.txt');

  // 2. Ветка зелена в одиночку — гейт это подтверждает на текущей базе.
  const aloneGreen = await preMergeGate({
    repoDir: dir, branch: 'task/T-red', base: 'main', merge: false,
  });
  check('T-red в одиночку зелена', aloneGreen.ok === true && aloneGreen.stage === 'checked');
  check('проверки правда гонялись', aloneGreen.checks.length === 2
    && aloneGreen.checks.every((c) => c.ok));

  // ...а потом main уезжает вперёд, и вместе они уже не собираются.
  writeFileSync(resolve(dir, 'api.txt'), 'v2\n');
  writeFileSync(resolve(dir, 'use.txt'), 'v2\n');
  git('add', '-A');
  git('commit', '-qm', 'main: api v2');
  const headV2 = git('rev-parse', 'main');

  const red = await preMergeGate({ repoDir: dir, branch: 'task/T-red', base: 'main' });
  check('красное слитое дерево останавливает слияние',
    red.ok === false && red.stage === 'checks');
  check('слияния не было', red.merged === false && git('rev-parse', 'main') === headV2);
  check('названа упавшая команда',
    Boolean(red.failed && red.failed.command.includes('typecheck')));
  check('в отчёте виден файл с ошибкой',
    Boolean(red.failed?.files.includes('use2.txt')));
  check('в отчёте виден текст ошибки',
    Boolean(red.failed?.output.includes('error TS2554')));
  check('конфликта при этом не было', red.conflicts.length === 0);
  check('копия офиса не осталась с красным деревом', git('status', '--porcelain') === '');
  const printed = formatReport(red, 'ru');
  check('печатный отчёт называет файл и ошибку',
    printed.includes('use2.txt') && printed.includes('error TS2554'));

  // 3. Зелёный сценарий: чиним ветку и сливаем — как раньше, с замером времени.
  git('checkout', '-q', 'task/T-red');
  writeFileSync(resolve(dir, 'use2.txt'), 'v2\n');
  git('add', '-A');
  git('commit', '-qm', 'T-red: догнали api v2');
  git('checkout', '-q', 'main');

  const green = await preMergeGate({ repoDir: dir, branch: 'task/T-red', base: 'main' });
  check('зелёный сценарий сливает', green.ok === true && green.stage === 'merged' && green.merged);
  check('main сдвинулся', git('rev-parse', 'main') !== headV2);
  check('влитое доехало до рабочей копии человека',
    readFileSync(resolve(dir, 'use2.txt'), 'utf8').trim() === 'v2');
  check('в ветке main проверки зелены', green.checks.every((c) => c.ok));
  check('время гейта измерено и меньше времени шага',
    green.gateMs > 0 && green.totalMs >= green.gateMs);
  check('рабочая копия осталась чистой', git('status', '--porcelain') === '');

  // 4. Повторный прогон: сливать уже нечего, и это не провал.
  const again = await preMergeGate({ repoDir: dir, branch: 'task/T-red', base: 'main' });
  check('повторный прогон говорит «нечего сливать»',
    again.ok === true && again.stage === 'nothing');

  // Копия офиса живёт вне репозитория и репозиторий её не переживает — убираем
  // сами, иначе после каждого прогона во временном каталоге оставался бы
  // worktree от стенда, которого уже нет.
  rmSync(defaultIntegrationDir(dir), { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });

  await busyIntegration(check);
  await pipelineGate(check);

  const failed = results.filter((r) => !r.endsWith('true'));
  for (const r of results) console.log(`  ${r.endsWith('true') ? '✅' : '❌'} ${r}`);
  if (!results.length) {
    console.error('не выполнено ни одной проверки — прогону верить нельзя');
    process.exit(2);
  }
  console.log(failed.length
    ? `ПРОВАЛЕНО: ${failed.length} из ${results.length}`
    : `Все проверки прошли: ${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

void main().catch((err) => {
  console.error(`прогон сорвался: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(2);
});

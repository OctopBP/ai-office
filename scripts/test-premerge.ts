/**
 * Пред-merge гейт на настоящем репозитории, без единого токена: создаём
 * временный репозиторий, где ветка зелена в одиночку и красна вместе с main,
 * и проверяем три вещи — грязная копия останавливает слияние, красное слитое
 * дерево не уезжает в main, зелёный сценарий сливает как раньше.
 *
 * Запуск: npm run test:premerge
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { defaultIntegrationDir, formatReport, preMergeGate } from '../src/server/premerge';

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

/**
 * Проверки состояния офиса без единого токена: пауза, критерии готовности
 * и разнесение расходов. Всё это — чистая логика в state.ts, и ловить её
 * регрессии сценариями PM дорого и медленно.
 *
 * Запуск: npm run test:state
 */
import { office } from '../src/server/state';
import { cloudProblem, setGithubToken } from '../src/server/cloud';

async function main(): Promise<void> {
  office.seed();
  const results: string[] = [];

  // 1. Не на паузе — ожидание не блокирует.
  let done = false;
  void office.whenResumed().then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 20));
  results.push(`без паузы не ждём: ${done}`);

  // 2. На паузе — висит, пока не снимут.
  office.setPaused(true);
  let resumed = false;
  void office.whenResumed().then(() => { resumed = true; });
  await new Promise((r) => setTimeout(r, 50));
  const stayed = !resumed;
  office.setPaused(false);
  await new Promise((r) => setTimeout(r, 20));
  results.push(`на паузе ждём: ${stayed}`, `после снятия продолжаем: ${resumed}`);

  // 3. Прерванная сессия просыпается, не дожидаясь снятия паузы.
  office.setPaused(true);
  const abort = new AbortController();
  let woke = false;
  void office.whenResumed(abort.signal).then(() => { woke = true; });
  abort.abort();
  await new Promise((r) => setTimeout(r, 20));
  results.push(`остановленная задача не висит на паузе: ${woke}`);
  office.setPaused(false);

  // 4. Критерии: отметка, повторная отметка и несуществующий номер.
  const task = office.createTask({
    title: 'проверка', description: '', roleId: 'backend',
    criteria: ['первый пункт', 'второй пункт'],
  });
  const first = office.checkCriterion(task.id, 1);
  const bad = office.checkCriterion(task.id, 5);
  results.push(
    `критерий отмечен: ${first.ok && task.criteria[0].done}`,
    `прогресс 1/2: ${task.criteria.filter((c) => c.done).length === 1}`,
    `несуществующий номер отклонён: ${!bad.ok}`,
    `снятие отметки работает: ${office.checkCriterion(task.id, 1, false).ok && !task.criteria[0].done}`,
  );

  // 5. Расходы: разнесены по задаче, агенту, дню и офису.
  const inst = office.instances.get('backend#1')!;
  inst.currentTaskId = task.id;
  office.addUsage('backend#1', { costUsd: 0.25, tokensIn: 1000, tokensOut: 200, cacheRead: 9000, cacheWrite: 500 });
  office.addUsage('backend#1', { costUsd: 0.25, tokensIn: 1000, tokensOut: 200, cacheRead: 9000, cacheWrite: 500 });
  results.push(
    `расход задачи: ${task.usage.costUsd.toFixed(2)} = 0.50 → ${task.usage.costUsd === 0.5}`,
    `расход агента: ${inst.usage.tokensIn === 2000 && inst.usage.cacheRead === 18000}`,
    `расход за сегодня: ${Object.values(inst.daily)[0]?.costUsd === 0.5}`,
    `расход офиса: ${office.totalCost() === 0.5 && office.usageDays().length === 1}`,
  );

  // 6. Облачный режим не запускается, пока не собраны все три условия.
  const withoutKey = cloudProblem();
  const hadKey = Boolean(process.env.ANTHROPIC_API_KEY);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const withoutRepo = cloudProblem();
  office.updateSettings({ cloudRepoUrl: 'https://github.com/owner/repo' });
  const withoutToken = cloudProblem();
  setGithubToken('test-token');
  const ready = cloudProblem();
  setGithubToken('');
  if (!hadKey) delete process.env.ANTHROPIC_API_KEY;
  results.push(
    `без ключа API облако отказывает: ${/ANTHROPIC_API_KEY/.test(withoutKey ?? '')}`,
    `без репозитория отказывает: ${/репозитор/i.test(withoutRepo ?? '')}`,
    `без токена отказывает: ${/токен/i.test(withoutToken ?? '')}`,
    `со всеми тремя — готово: ${ready === null}`,
  );

  const failed = results.filter((r) => r.endsWith('false'));
  for (const r of results) console.log(`  ${r.endsWith('false') ? '❌' : '✅'} ${r}`);
  console.log(failed.length ? `ПРОВАЛЕНО: ${failed.length}` : 'Все проверки прошли');
  process.exit(failed.length ? 1 : 0);
}

void main();

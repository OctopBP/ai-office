/**
 * Проверки состояния офиса без единого токена: пауза, критерии готовности
 * и разнесение расходов. Всё это — чистая логика в state.ts, и ловить её
 * регрессии сценариями PM дорого и медленно.
 *
 * Запуск: npm run test:state
 */
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  DEFAULT_SETTINGS, getOffice, office, openOfficeState, subscribeOffices,
} from '../src/server/state';
import { flushAll, load, save, wipe, type Persisted } from '../src/server/store';
import { cloudProblem, setGithubToken } from '../src/server/cloud';
import { noStaffReason, teamSummary } from '../src/server/agents';

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

  // 7. Состав команды: увольнение последнего, наём обратно, лимит и защиты.
  // Состояние с этого момента пишем во временный файл: дальше проверяется
  // восстановление состава, и настоящее сохранение офиса трогать нельзя.
  office.setStateFile(resolve(tmpdir(), `office-test-state-${process.pid}.json`));
  const fireLast = office.fire('smm#1');
  results.push(
    `последнего сотрудника роли можно уволить: ${fireLast === null}`,
    `роль осталась с нулём сотрудников: ${office.staffOf('smm').length === 0}`,
    `роль не исчезла из реестра: ${office.roleViews().some((r) => r.id === 'smm' && r.active === 0)}`,
    // Менеджер должен увидеть пустую роль как вакансию, а не решить, что её нет.
    `list_team показывает роль без сотрудников: ${/smm[\s\S]*?сотрудников нет \(можно нанять\)/.test(teamSummary())}`,
    // Назначение на пустую роль обязано быть понятным отказом, а не падением.
    `assign_task на роль без сотрудников отказывает: ${/вакансия открыта/.test(noStaffReason('smm') ?? '')}`,
    `роль с сотрудниками задачи берёт: ${noStaffReason('backend') === null}`,
    `PM уволить нельзя: ${/PM/.test(office.fire('pm#1') ?? '')}`,
    // backend#1 занят задачей из проверки расходов выше.
    `занятого не увольняем и объясняем почему: ${/работает над задачей/.test(office.fire('backend#1') ?? '')}`,
  );

  const hireBack = office.hire('smm');
  const smmLimit = office.roleViews().find((r) => r.id === 'smm')!.maxInstances;
  results.push(
    `нанять обратно можно: ${hireBack === null && office.staffOf('smm').length === 1}`,
    `нанятый получил рабочее место: ${office.staffOf('smm')[0]?.desk !== undefined}`,
  );
  while (office.staffOf('smm').length < smmLimit) office.hire('smm');
  results.push(
    `лимит клонов соблюдён: ${/лимит|уже нанято/.test(office.hire('smm') ?? '')}`,
    `несуществующая роль отклонена: ${/нет в офисе/.test(office.hire('нет-такой') ?? '')}`,
  );

  // Номер освобождается вместе с сотрудником и не затирает живого соседа.
  const second = office.staffOf('smm')[1]!.id;
  office.fire('smm#1');
  office.hire('smm');
  results.push(
    `новый сотрудник не затёр соседа: ${office.instances.has(second) && office.staffOf('smm').length === 2}`,
  );

  // Уволенная роль не воскресает при перезапуске: состав берётся из сохранения.
  for (const i of office.staffOf('smm')) office.fire(i.id);
  const extraBackend = office.hire('backend') === null;
  office.projectDir = office.projectDir || process.cwd();
  office.flush();
  const restored = office.restore();
  results.push(
    `состояние восстановлено: ${restored}`,
    `уволенная роль не воскресла после перезапуска: ${office.staffOf('smm').length === 0}`,
    `нанятые сверх одного сохранились: ${extraBackend && office.staffOf('backend').length === 2}`,
    `столы не разъехались: ${new Set([...office.instances.values()].map((i) => i.desk.index)).size === office.instances.size}`,
  );
  office.wipe();

  // 8. Хранилище пер-офисное: сохранение одного офиса не отменяет сохранение
  // другого. С общим на процесс таймером второй save() просто заменял первый
  // снимок, и данные офиса A не доезжали до диска.
  const fileA = resolve(tmpdir(), `office-test-store-a-${process.pid}.json`);
  const fileB = resolve(tmpdir(), `office-test-store-b-${process.pid}.json`);
  const stamp = (dir: string): Persisted => ({
    version: 1, projectDir: dir, taskSeq: 0, tasks: [], chat: [], log: [],
    instances: [], settings: { ...DEFAULT_SETTINGS }, roleOverrides: {}, savedAt: Date.now(),
  });
  save(fileA, () => stamp('/office-a'));
  save(fileB, () => stamp('/office-b'));
  flushAll();
  results.push(
    `запись офиса A не потерялась: ${load(fileA)?.projectDir === '/office-a'}`,
    `запись офиса B не потерялась: ${load(fileB)?.projectDir === '/office-b'}`,
  );
  wipe(fileA);
  wipe(fileB);

  // 9. Реестр офисов: повторное открытие берёт то же состояние, а подписчик
  // рассылки не теряется при переключении и не удваивается.
  const regA = resolve(tmpdir(), `office-test-reg-a-${process.pid}.json`);
  const regB = resolve(tmpdir(), `office-test-reg-b-${process.pid}.json`);
  let heard = 0;
  const ear = (): void => { heard += 1; };
  subscribeOffices(ear);
  subscribeOffices(ear);   // повторная подписка тем же обработчиком — не дубль

  const a = openOfficeState({ id: 'o-test-a', projectDir: resolve(tmpdir(), 'office-a'), stateFile: regA });
  const heardBefore = heard;
  a.state.addLog(null, 'system', 'проверка рассылки');
  const onceNotTwice = heard - heardBefore === 1;
  const taskInA = a.state.createTask({ title: 'в офисе A', description: '', criteria: [], roleId: null });

  const b = openOfficeState({ id: 'o-test-b', projectDir: resolve(tmpdir(), 'office-b'), stateFile: regB });
  const heardBeforeB = heard;
  b.state.addLog(null, 'system', 'проверка рассылки после переключения');
  const heardFromB = heard - heardBeforeB === 1;

  const backToA = openOfficeState({ id: 'o-test-a', projectDir: resolve(tmpdir(), 'office-a'), stateFile: regA });
  results.push(
    `один OfficeState на офис: ${getOffice('o-test-a') === a.state && a.state !== b.state}`,
    `повторное открытие не пересоздаёт состояние: ${backToA.reused && backToA.state === a.state}`,
    `доска офиса переживает переключение: ${backToA.state.tasks.has(taskInA.id)}`,
    `office указывает на текущий офис: ${office.officeId === 'o-test-a'}`,
    `подписчик рассылки не дублируется: ${onceNotTwice}`,
    `события офиса, открытого позже, доходят: ${heardFromB}`,
  );
  wipe(regA);
  wipe(regB);

  const failed = results.filter((r) => r.endsWith('false'));
  for (const r of results) console.log(`  ${r.endsWith('false') ? '❌' : '✅'} ${r}`);
  console.log(failed.length ? `ПРОВАЛЕНО: ${failed.length}` : 'Все проверки прошли');
  process.exit(failed.length ? 1 : 0);
}

void main();

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
import { MAX_TASK_MAX_TURNS } from '../src/shared/types';
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

  // 7b. Режим доступа: офисный, личный режим сотрудника и наследование.
  // Права не должны появляться сами, а выданные — молча пропадать.
  const defaultMode = office.roleViews().find((r) => r.id === 'backend')!.effectivePermissionMode;
  office.updateRole('reviewer', { permissionMode: null });
  office.updateSettings({ officePermissionMode: 'auto' });
  const inheritedAuto = office.roleViews().find((r) => r.id === 'reviewer')?.effectivePermissionMode;
  // Мусор из сети не должен становиться режимом офиса.
  office.updateSettings({ officePermissionMode: 'всё можно' as never });
  const junkIgnored = office.settings.officePermissionMode === 'auto';
  office.updateSettings({ officePermissionMode: 'ask-writes' });
  office.setAgentPermissionMode('backend#1', 'auto');
  const personal = office.instanceViews().find((i) => i.id === 'backend#1');

  // 7c. Лимит шагов исполнителя: он настраивается, но нулём и мусором его
  // испортить нельзя — с ними сессия падала бы на первом же ходу.
  const turnsDefault = office.settings.taskMaxTurns === 60;
  office.updateSettings({ taskMaxTurns: 200 });
  office.updateSettings({ taskMaxTurns: 0 });
  const zeroIgnored = office.settings.taskMaxTurns === 200;
  office.updateSettings({ taskMaxTurns: -5 });
  office.updateSettings({ taskMaxTurns: '120' as never });
  const junkTurnsIgnored = office.settings.taskMaxTurns === 200;
  office.updateSettings({ taskMaxTurns: 99999 });
  const cappedTurns = office.settings.taskMaxTurns === MAX_TASK_MAX_TURNS;
  office.updateSettings({ taskMaxTurns: null });
  const unlimitedTurns = office.settings.taskMaxTurns === null;
  office.updateSettings({ taskMaxTurns: 150 });

  office.flush();
  const restored = office.restore();
  const afterRestart = office.instanceViews().find((i) => i.id === 'backend#1');
  results.push(
    `состояние восстановлено: ${restored}`,
    `уволенная роль не воскресла после перезапуска: ${office.staffOf('smm').length === 0}`,
    `нанятые сверх одного сохранились: ${extraBackend && office.staffOf('backend').length === 2}`,
    `столы не разъехались: ${new Set([...office.instances.values()].map((i) => i.desk.index)).size === office.instances.size}`,
    `по умолчанию у роли прежний режим: ${defaultMode === 'ask-risky'}`,
    `роль без своего режима наследует офисный: ${inheritedAuto === 'auto'}`,
    `неизвестный режим не принимается: ${junkIgnored}`,
    `личный режим сильнее офисного: ${personal?.effectivePermissionMode === 'auto'}`,
    `сосед по роли остался на режиме роли: ${office.instanceViews().find((i) => i.id === 'backend#2')?.effectivePermissionMode === 'ask-risky'}`,
    `личный режим пережил перезапуск: ${afterRestart?.permissionMode === 'auto'}`,
    `режим офиса пережил перезапуск: ${office.settings.officePermissionMode === 'ask-writes'}`,
    `лимит шагов по умолчанию прежний: ${turnsDefault}`,
    `ноль не становится лимитом шагов: ${zeroIgnored}`,
    `мусор не становится лимитом шагов: ${junkTurnsIgnored}`,
    `слишком большой лимит шагов срезан: ${cappedTurns}`,
    `лимит шагов можно снять совсем: ${unlimitedTurns}`,
    `лимит шагов пережил перезапуск: ${office.settings.taskMaxTurns === 150}`,
    // Смена режима — не тихая настройка: человек должен видеть её в ленте.
    `смена режима записана в ленту: ${office.log.some((e) => /Режим доступа офиса/.test(e.text))}`,
  );
  office.updateSettings({
    officePermissionMode: DEFAULT_SETTINGS.officePermissionMode,
    taskMaxTurns: DEFAULT_SETTINGS.taskMaxTurns,
  });
  office.setAgentPermissionMode('backend#1', null);
  office.updateRole('reviewer', { permissionMode: 'ask-risky' });
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
  // Метка офиса — то, по чему сервер решает, какому сокету слать событие.
  const from: string[] = [];
  const ear = (_e: unknown, officeId: string): void => { heard += 1; from.push(officeId); };
  subscribeOffices(ear);
  subscribeOffices(ear);   // повторная подписка тем же обработчиком — не дубль

  const a = openOfficeState({ id: 'o-test-a', projectDir: resolve(tmpdir(), 'office-a'), stateFile: regA });
  const heardBefore = heard;
  a.state.addLog(null, 'system', 'проверка рассылки');
  const onceNotTwice = heard - heardBefore === 1;
  const labelledA = from[from.length - 1] === 'o-test-a';
  const taskInA = a.state.createTask({ title: 'в офисе A', description: '', criteria: [], roleId: null });

  const b = openOfficeState({ id: 'o-test-b', projectDir: resolve(tmpdir(), 'office-b'), stateFile: regB });
  const heardBeforeB = heard;
  b.state.addLog(null, 'system', 'проверка рассылки после переключения');
  const heardFromB = heard - heardBeforeB === 1 && from[from.length - 1] === 'o-test-b';

  // Покинутый офис продолжает работать: его сессии пишут в него, а не в тот,
  // который человек открыл сейчас. Это и есть свободное переключение.
  const heardBeforeBg = heard;
  a.state.addLog(null, 'system', 'задача в покинутом офисе продолжается');
  const taskInBackground = a.state.createTask({
    title: 'начата без клиента', description: '', criteria: [], roleId: null,
  });
  const bgLabelled = heard - heardBeforeBg === 2 && from[from.length - 1] === 'o-test-a';
  // Текущий офис — B, а работа легла в A: именно так ведёт себя сессия,
  // начатая до переключения.
  const bgStayedHome = office.officeId === 'o-test-b'
    && a.state.tasks.has(taskInBackground.id) && !b.state.tasks.has(taskInBackground.id);

  const backToA = openOfficeState({ id: 'o-test-a', projectDir: resolve(tmpdir(), 'office-a'), stateFile: regA });
  // Повторный вход не должен удваивать доставку: подписка ставится один раз
  // на состояние, а не заново при каждом открытии офиса.
  const heardBeforeReturn = heard;
  backToA.state.addLog(null, 'system', 'после возвращения');
  const noDoubleAfterReturn = heard - heardBeforeReturn === 1;

  results.push(
    `один OfficeState на офис: ${getOffice('o-test-a') === a.state && a.state !== b.state}`,
    `повторное открытие не пересоздаёт состояние: ${backToA.reused && backToA.state === a.state}`,
    `доска офиса переживает переключение: ${backToA.state.tasks.has(taskInA.id)}`,
    `office указывает на текущий офис: ${office.officeId === 'o-test-a'}`,
    `подписчик рассылки не дублируется: ${onceNotTwice}`,
    `событие помечено своим офисом: ${labelledA}`,
    `события офиса, открытого позже, доходят: ${heardFromB}`,
    `покинутый офис продолжает слать события под своей меткой: ${bgLabelled}`,
    `работа покинутого офиса остаётся в нём: ${bgStayedHome}`,
    `повторный вход не удваивает рассылку: ${noDoubleAfterReturn}`,
  );
  wipe(regA);
  wipe(regB);

  // Прошедшей считается только строка, кончающаяся на true. Раньше проверялось
  // обратное — «не false», — и любая строка, где вместо булева оказалось
  // undefined или текст, молча шла в зачёт.
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

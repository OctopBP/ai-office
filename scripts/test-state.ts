/**
 * Проверки состояния офиса без единого токена: пауза, критерии готовности
 * и разнесение расходов. Всё это — чистая логика в state.ts, и ловить её
 * регрессии сценариями PM дорого и медленно.
 *
 * Запуск: npm run test:state
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog, deskPlan, effectiveLayout } from '../src/server/layout';
import { deskPoint } from '../src/shared/layout';
import {
  DEFAULT_SETTINGS, getOffice, openOfficeState, subscribeOffices, totalRunningWorkers,
  unloadOfficeState,
} from '../src/server/state';
import { flushAll, load, save, wipe, type Persisted } from '../src/server/store';
import { DEFAULT_OFFICE_WORKERS, MAX_OFFICE_WORKERS, MAX_TASK_MAX_TURNS } from '../src/shared/types';
import { cloudProblem, setGithubToken } from '../src/server/cloud';
import {
  noStaffReason, officeAssign, releaseSlot, resetSessions, sendUserMessage, slotProblem, teamSummary,
} from '../src/server/agents';
import { MessageQueue } from '../src/server/queue';
import { tellPm } from '../src/server/review';

/**
 * Офис проверок держим за явную ссылку по id: состояния живут в реестре по
 * офисам, «текущего на процесс» больше нет — и проверка обязана называть тот
 * офис, о котором говорит, ровно так же, как это делает сервер.
 */
const office = getOffice('o-1');

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
  const withoutKey = cloudProblem(office);
  const hadKey = Boolean(process.env.ANTHROPIC_API_KEY);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const withoutRepo = cloudProblem(office);
  office.updateSettings({ cloudRepoUrl: 'https://github.com/owner/repo' });
  const withoutToken = cloudProblem(office);
  setGithubToken('test-token');
  const ready = cloudProblem(office);
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
    `list_team показывает роль без сотрудников: ${/smm[\s\S]*?сотрудников нет \(можно нанять\)/.test(teamSummary(office))}`,
    // Назначение на пустую роль обязано быть понятным отказом, а не падением.
    `assign_task на роль без сотрудников отказывает: ${/вакансия открыта/.test(noStaffReason('smm', office) ?? '')}`,
    `роль с сотрудниками задачи берёт: ${noStaffReason('backend', office) === null}`,
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

  // 7c. Раскладка офиса как настройка: значение по умолчанию, отказ по
  // неизвестному id и список пресетов, из которого выбирают. Что по ней
  // считаются столы — отдельно, в разделе 10.
  const layoutByDefault = office.settings.layoutId === 'classic';
  const badLayout = office.updateSettings({ layoutId: 'нет-такой' });
  const layoutKept = office.settings.layoutId === 'classic';
  const okLayout = office.updateSettings({ layoutId: 'studio' });
  const layoutList = office.layouts();
  // Контракт с вебом: и выбранная раскладка, и список, из которого выбирают,
  // едут одним снапшотом — UI выбора (задача D2) ничего не запрашивает отдельно.
  const layoutSnap = office.snapshot();
  const choiceInSnapshot = layoutSnap.t === 'snapshot'
    && layoutSnap.settings.layoutId === 'studio'
    && layoutSnap.layouts.some((l) => l.id === 'studio' && l.title.length > 0)
    && layoutSnap.layouts.some((l) => l.id === 'classic');
  results.push(
    `по умолчанию офис работает по classic: ${layoutByDefault}`,
    `неизвестная раскладка отклонена по-русски: ${/нет в design\/layouts/.test(badLayout ?? '')}`,
    `после отказа раскладка прежняя: ${layoutKept}`,
    `известная раскладка принята: ${okLayout === null && office.settings.layoutId === 'studio'}`,
    `смена раскладки записана в ленту: ${office.log.some((e) => /Раскладка офиса/.test(e.text))}`,
    `список раскладок несёт classic и studio: ${['classic', 'studio'].every((id) => layoutList.some((l) => l.id === id))}`,
    `у каждой раскладки есть подпись: ${layoutList.length > 0 && layoutList.every((l) => l.title.length > 0)}`,
    `выбранная раскладка и список выбора едут в снапшоте: ${choiceInSnapshot}`,
  );

  // 7d. Лимит шагов исполнителя: он настраивается, но нулём и мусором его
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

  // 7e. Лимит одновременных исполнителей: настраивается, границы держатся,
  // «без ограничения» здесь не бывает. Ноль означал бы офис, в котором ни одна
  // задача больше не стартует, — такое значение принимать нельзя.
  const workersDefault = office.settings.maxConcurrentWorkers === DEFAULT_OFFICE_WORKERS;
  office.updateSettings({ maxConcurrentWorkers: 5 });
  office.updateSettings({ maxConcurrentWorkers: 0 });
  const zeroWorkersIgnored = office.settings.maxConcurrentWorkers === 5;
  office.updateSettings({ maxConcurrentWorkers: null as never });
  office.updateSettings({ maxConcurrentWorkers: '4' as never });
  const junkWorkersIgnored = office.settings.maxConcurrentWorkers === 5;
  office.updateSettings({ maxConcurrentWorkers: 999 });
  const cappedWorkers = office.settings.maxConcurrentWorkers === MAX_OFFICE_WORKERS;
  office.updateSettings({ maxConcurrentWorkers: 2 });

  // 7f. Свой лимит шагов у роли: ревьюеру хватает десятка ходов, а разработчику
  // на большой задаче не хватает и сотни. Пустое значение у роли — «как в
  // офисе», а не «без ограничения»: снять лимит совсем можно только офису.
  const backendView = office.roleViews().find((r) => r.id === 'backend')!;
  const roleTurnsInherited = backendView.maxTurns === null
    && backendView.effectiveMaxTurns === office.settings.taskMaxTurns;
  office.updateRole('backend', { maxTurns: 300 });
  const roleTurnsWin = office.turnsFor(office.role('backend')!) === 300;
  const neighbourRoleUntouched =
    office.turnsFor(office.role('reviewer')!) === office.settings.taskMaxTurns;
  office.updateRole('backend', { maxTurns: 0 });
  office.updateRole('backend', { maxTurns: '80' as never });
  const junkRoleTurnsIgnored = office.role('backend')!.maxTurns === 300;
  office.updateRole('backend', { maxTurns: 99999 });
  const cappedRoleTurns = office.role('backend')!.maxTurns === MAX_TASK_MAX_TURNS;
  office.updateRole('backend', { maxTurns: 300 });
  office.updateRole('reviewer', { maxTurns: 12 });
  office.updateRole('reviewer', { maxTurns: null });
  const roleBackToOffice = office.role('reviewer')!.maxTurns === null
    && office.turnsFor(office.role('reviewer')!) === office.settings.taskMaxTurns;
  results.push(
    `у роли по умолчанию своего лимита шагов нет: ${roleTurnsInherited}`,
    `лимит роли сильнее офисного: ${roleTurnsWin}`,
    `соседняя роль осталась на офисном лимите: ${neighbourRoleUntouched}`,
    `мусор не становится лимитом шагов роли: ${junkRoleTurnsIgnored}`,
    `слишком большой лимит шагов роли срезан: ${cappedRoleTurns}`,
    `пустой лимит роли возвращает её к офисному: ${roleBackToOffice}`,
  );

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
    `раскладка пережила перезапуск: ${office.settings.layoutId === 'studio'}`,
    `лимит шагов по умолчанию прежний: ${turnsDefault}`,
    `ноль не становится лимитом шагов: ${zeroIgnored}`,
    `мусор не становится лимитом шагов: ${junkTurnsIgnored}`,
    `слишком большой лимит шагов срезан: ${cappedTurns}`,
    `лимит шагов можно снять совсем: ${unlimitedTurns}`,
    `лимит шагов пережил перезапуск: ${office.settings.taskMaxTurns === 150}`,
    `лимит шагов роли пережил перезапуск: ${office.role('backend')?.maxTurns === 300}`,
    `лимит исполнителей по умолчанию прежний (3): ${workersDefault}`,
    `ноль не становится лимитом исполнителей: ${zeroWorkersIgnored}`,
    `мусор не становится лимитом исполнителей: ${junkWorkersIgnored}`,
    `слишком большой лимит исполнителей срезан: ${cappedWorkers}`,
    `лимит исполнителей пережил перезапуск: ${office.settings.maxConcurrentWorkers === 2}`,
    // Смена лимита меняет расход офиса в минуту — человек должен видеть её в ленте.
    `смена лимита исполнителей записана в ленту: ${
      office.log.some((e) => /Одновременно исполнителей в офисе/.test(e.text))}`,
    // Смена режима — не тихая настройка: человек должен видеть её в ленте.
    `смена режима записана в ленту: ${office.log.some((e) => /Режим доступа офиса/.test(e.text))}`,
  );
  office.updateSettings({
    officePermissionMode: DEFAULT_SETTINGS.officePermissionMode,
    layoutId: DEFAULT_SETTINGS.layoutId,
    taskMaxTurns: DEFAULT_SETTINGS.taskMaxTurns,
    maxConcurrentWorkers: DEFAULT_SETTINGS.maxConcurrentWorkers,
  });
  office.setAgentPermissionMode('backend#1', null);
  office.updateRole('reviewer', { permissionMode: 'ask-risky' });
  office.updateRole('backend', { maxTurns: null });
  office.wipe();

  // 7g. Файл состояния правят руками, а лимит шагов роли уезжает прямо в SDK:
  // испорченное значение обрушило бы каждую задачу этой роли. Такую правку
  // выкидываем поштучно — остальные настройки роли должны уцелеть.
  const junkFile = resolve(tmpdir(), `office-test-roleturns-${process.pid}.json`);
  const junkDir = resolve(tmpdir(), 'roleturns-office');
  save(junkFile, () => ({
    version: 1, projectDir: junkDir, taskSeq: 0, tasks: [], chat: [], log: [],
    instances: [], settings: { ...DEFAULT_SETTINGS }, savedAt: Date.now(),
    roleOverrides: { backend: { maxTurns: 0, model: 'claude-haiku-4-5' } },
  }));
  flushAll();
  const junkOffice = openOfficeState({
    id: 'o-roleturns', projectDir: junkDir, stateFile: junkFile,
  }).state;
  results.push(
    `испорченный лимит роли из файла не применён: ${junkOffice.role('backend')?.maxTurns == null}`,
    `роль вернулась к офисному лимиту: ${
      junkOffice.turnsFor(junkOffice.role('backend')!) === DEFAULT_SETTINGS.taskMaxTurns}`,
    `остальные правки роли из файла уцелели: ${
      junkOffice.role('backend')?.model === 'claude-haiku-4-5'}`,
  );
  unloadOfficeState('o-roleturns');
  wipe(junkFile);

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
  // Работа легла в A, хотя открыт был B: именно так ведёт себя сессия,
  // начатая до переключения. Общего «текущего офиса» тут нет вовсе — доски
  // разошлись по своим состояниям, каждое из которых зовут по id.
  const bgStayedHome = a.state.tasks.has(taskInBackground.id)
    && !b.state.tasks.has(taskInBackground.id);

  const backToA = openOfficeState({ id: 'o-test-a', projectDir: resolve(tmpdir(), 'office-a'), stateFile: regA });
  // Повторный вход не должен удваивать доставку: подписка ставится один раз
  // на состояние, а не заново при каждом открытии офиса.
  const heardBeforeReturn = heard;
  backToA.state.addLog(null, 'system', 'после возвращения');
  const noDoubleAfterReturn = heard - heardBeforeReturn === 1;

  // Выгрузка и возвращение офиса подписчиков тоже не копят: состояние уходит
  // из реестра вместе со своей единственной подпиской, а вернувшийся офис
  // заводит новое состояние и подписывается ровно один раз.
  unloadOfficeState('o-test-b');
  const reborn = openOfficeState({ id: 'o-test-b', projectDir: resolve(tmpdir(), 'office-b'), stateFile: regB });
  const heardBeforeReborn = heard;
  reborn.state.addLog(null, 'system', 'после выгрузки и возвращения');
  const noDoubleAfterReload = heard - heardBeforeReborn === 1 && reborn.state !== b.state;

  results.push(
    `один OfficeState на офис: ${getOffice('o-test-a') === a.state && a.state !== b.state}`,
    `повторное открытие не пересоздаёт состояние: ${backToA.reused && backToA.state === a.state}`,
    `доска офиса переживает переключение: ${backToA.state.tasks.has(taskInA.id)}`,
    `состояние берётся по id офиса: ${getOffice('o-test-b') === reborn.state}`,
    `подписчик рассылки не дублируется: ${onceNotTwice}`,
    `событие помечено своим офисом: ${labelledA}`,
    `события офиса, открытого позже, доходят: ${heardFromB}`,
    `покинутый офис продолжает слать события под своей меткой: ${bgLabelled}`,
    `работа покинутого офиса остаётся в нём: ${bgStayedHome}`,
    `повторный вход не удваивает рассылку: ${noDoubleAfterReturn}`,
    `выгрузка и возвращение не удваивают рассылку: ${noDoubleAfterReload}`,
  );
  wipe(regA);
  wipe(regB);

  // 10. Столы считаются по раскладке ТОГО офиса, который спрашивает. Два офиса
  // с разными раскладками живут в памяти одновременно, и общей на процесс
  // «текущей раскладки» быть не должно: иначе второй офис переставлял бы мебель
  // первому. Заодно проверяем, что classic остался прежним.
  const layA = resolve(tmpdir(), `office-test-lay-a-${process.pid}.json`);
  const layB = resolve(tmpdir(), `office-test-lay-b-${process.pid}.json`);
  const classicPlan = deskPlan('classic');
  const studioPlan = deskPlan('studio');
  const oc = openOfficeState({ id: 'o-lay-classic', projectDir: resolve(tmpdir(), 'lay-a'), stateFile: layA }).state;
  const os_ = openOfficeState({ id: 'o-lay-studio', projectDir: resolve(tmpdir(), 'lay-b'), stateFile: layB }).state;
  os_.updateSettings({ layoutId: 'studio' });
  // Набираем штат заново уже на studio: пересадка тех, кто сидел за столами
  // прежней раскладки, — следующая задача, здесь проверяется сам расчёт.
  os_.seed();
  // Нанятый после смены раскладки садится за стол новой раскладки: место
  // выбирает уже studio, а не зашитый classic.
  os_.fire(os_.staffOf('backend')[0]!.id);
  const hiredInStudio = os_.spawn('backend');
  const classicPm = oc.staffOf('pm')[0]!.desk;
  const studioPm = os_.staffOf('pm')[0]!.desk;
  // Сравниваем со столом того же индекса в обеих раскладках: совпасть с studio
  // и разойтись с classic — это ровно «место взято из раскладки офиса».
  const sameIdxStudio = hiredInStudio ? studioPlan.desks[hiredInStudio.desk.index] : undefined;
  const sameIdxClassic = hiredInStudio ? classicPlan.desks[hiredInStudio.desk.index] : undefined;
  const atStudioDesk = !!hiredInStudio && !!sameIdxStudio && !!sameIdxClassic
    && hiredInStudio.desk.x === sameIdxStudio.x && hiredInStudio.desk.y === sameIdxStudio.y
    && (sameIdxClassic.x !== sameIdxStudio.x || sameIdxClassic.y !== sameIdxStudio.y);
  const classicUntouched = oc.staffOf('backend').every((i) => classicPlan.desks
    .some((d) => d.index === i.desk.index && d.x === i.desk.x && d.y === i.desk.y));
  results.push(
    `classic сажает PM за свой стол, как раньше: ${classicPm.index === classicPlan.pmIndex
      && classicPm.x === classicPlan.desks[classicPlan.pmIndex].x
      && classicPm.y === classicPlan.desks[classicPlan.pmIndex].y}`,
    `studio сажает PM за стол своей раскладки: ${studioPm.x === studioPlan.desks[studioPlan.pmIndex].x
      && studioPm.y === studioPlan.desks[studioPlan.pmIndex].y}`,
    `раскладки правда разные, проверка не вырождена: ${classicPlan.desks
      .some((d, i) => d.x !== studioPlan.desks[i]?.x || d.y !== studioPlan.desks[i]?.y)}`,
    `новичок садится за стол раскладки своего офиса: ${atStudioDesk}`,
    `соседний офис не переставил мебель первому: ${classicUntouched}`,
  );

  // Лимит штата — число столов в раскладке офиса, а не константа. Проверяем на
  // временной тесной раскладке: в ней мест меньше, чем уже нанятых людей.
  const layoutsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'design/layouts');
  const tightFile = resolve(layoutsDir, 'tight-test.json');
  writeFileSync(tightFile, JSON.stringify({
    version: 1, id: 'tight-test', title: 'Тесная', size: [8, 6],
    props: [{ sprite: 'desk_pm', at: [1, 2] }, { sprite: 'desk', at: [4, 2] }],
  }));
  try {
    oc.updateSettings({ layoutId: 'tight-test' });
    const refusal = oc.hire('backend') ?? '';
    // Столов меньше, чем людей: кого можно — усадили, остальные стоят внутри
    // комнаты, а не за её стеной с координатами прежней раскладки.
    const tightDesks = deskPlan('tight-test').desks;
    const seated = [...oc.instances.values()]
      .filter((i) => tightDesks.some((d) => d.index === i.desk.index));
    const standing = [...oc.instances.values()].filter((i) => !seated.includes(i));
    const insideRoom = standing.every((i) => i.desk.x >= 0 && i.desk.x < 8 && i.desk.y >= 0 && i.desk.y < 6);
    const spotsDistinct = new Set([...oc.instances.values()]
      .map((i) => `${i.desk.x},${i.desk.y}`)).size === oc.instances.size;
    const toldAboutStanding = standing.every((i) => oc.log
      .some((e) => e.text.startsWith(`${i.label} остался без рабочего места`)));
    // Индекс места безместные сохраняют: вернулась просторная раскладка — и
    // каждый снова за своим столом, а не на случайном свободном.
    const before = [...oc.instances.values()].map((i) => [i.id, i.desk.index] as const);
    oc.updateSettings({ layoutId: 'studio' });
    const backHome = before.every(([id, index]) => {
      const inst = [...oc.instances.values()].find((i) => i.id === id);
      const desk = studioPlan.desks[index];
      return !!inst && inst.desk.index === index && inst.desk.x === desk.x && inst.desk.y === desk.y;
    });
    results.push(
      `отказ в найме считает места по раскладке офиса: ${/«Тесная» 2 рабочих мест/.test(refusal)}`,
      `в соседнем офисе лимит остался свой: ${deskPlan(os_.settings.layoutId).desks.length === studioPlan.desks.length}`,
      `в тесной раскладке заняты все её столы: ${seated.length === tightDesks.length}`,
      `безместные стоят внутри комнаты, а не за стеной: ${standing.length > 0 && insideRoom}`,
      `никто не стоит на одной клетке с другим: ${spotsDistinct}`,
      `про каждого безместного сказано по-русски: ${toldAboutStanding}`,
      `возврат просторной раскладки сажает всех на свои места: ${backHome}`,
    );
  } finally {
    // Пресет — временный: оставленный файл попал бы в список выбора раскладок.
    rmSync(tightFile, { force: true });
  }
  wipe(layA);
  wipe(layB);

  // 10б. Пересадка при смене раскладки на живом офисе. Раньше новую раскладку
  // видела только мебель: люди оставались сидеть по координатам прежней
  // комнаты. Проверяем три вещи разом — все пересели, номера мест уцелели,
  // а клиенту про это сказали событиями.
  const moveFile = resolve(tmpdir(), `office-test-move-${process.pid}.json`);
  const om = openOfficeState({
    id: 'o-move', projectDir: resolve(tmpdir(), 'move-office'), stateFile: moveFile,
  }).state;
  om.seed();
  const beforeMove = [...om.instances.values()].map((i) => [i.id, i.desk.index] as const);
  const movedIds = new Set<string>();
  let layoutEventsOnSwitch = 0;
  const stopMove = om.subscribe((e) => {
    if (e.t === 'instance') movedIds.add(e.instance.id);
    if (e.t === 'layout') layoutEventsOnSwitch += 1;
  });
  om.updateSettings({ layoutId: 'studio' });
  const seatedInStudio = beforeMove.every(([id, index]) => {
    const inst = om.instances.get(id);
    const desk = studioPlan.desks[index];
    return !!inst && !inst.deskless && inst.desk.index === index
      && inst.desk.x === desk.x && inst.desk.y === desk.y;
  });
  // Проверка не должна пройти «сама собой»: столы classic и studio обязаны
  // стоять по-разному, иначе пересадку не отличить от бездействия.
  const reallyMoved = beforeMove.every(([id, index]) => {
    const inst = om.instances.get(id);
    return !!inst && (classicPlan.desks[index].x !== inst.desk.x
      || classicPlan.desks[index].y !== inst.desk.y);
  });
  results.push(
    `смена раскладки пересадила весь штат: ${seatedInStudio}`,
    `номера мест при пересадке уцелели: ${beforeMove.length === om.instances.size && seatedInStudio}`,
    `столы новой раскладки правда другие: ${reallyMoved}`,
    `о каждом пересевшем клиенту сказано событием: ${beforeMove
      .every(([id]) => movedIds.has(id))}`,
    `клиент получил и саму раскладку: ${layoutEventsOnSwitch === 1}`,
  );

  // Стол PM закреплён раскладкой, а не номером места: в пресете ниже desk_pm
  // объявлен вторым, значит PM обязан переехать на место №1, а тот, кто там
  // сидел, — на освободившееся. Обе раскладки из design/layouts объявляют
  // desk_pm первым, и на них эта ошибка была бы не видна.
  const pmSecondFile = resolve(layoutsDir, 'pm-second-test.json');
  writeFileSync(pmSecondFile, JSON.stringify({
    version: 1,
    id: 'pm-second-test',
    title: 'PM вторым',
    size: [24, 15],
    props: [
      { sprite: 'desk', at: [1, 4] },
      { sprite: 'desk_pm', at: [6, 4] },
      { sprite: 'desk', at: [11, 4] },
      { sprite: 'desk', at: [16, 4] },
      { sprite: 'desk', at: [1, 8] },
      { sprite: 'desk', at: [6, 8] },
      { sprite: 'desk', at: [11, 8] },
      { sprite: 'desk', at: [16, 8] },
    ],
  }));
  try {
    om.updateSettings({ layoutId: 'pm-second-test' });
    const pmPlan = deskPlan('pm-second-test');
    const pm = om.staffOf('pm')[0]!;
    const displaced = om.instances.get('backend#1')!;
    // Все, кроме PM и вытесненного им соседа, сидят на своих прежних номерах.
    const keptOthers = beforeMove
      .filter(([id]) => id !== pm.id && id !== displaced.id)
      .every(([id, index]) => om.instances.get(id)?.desk.index === index);
    results.push(
      `PM сел за стол PM новой раскладки: ${pmPlan.pmIndex === 1
        && pm.desk.index === pmPlan.pmIndex
        && pm.desk.x === pmPlan.desks[1].x && pm.desk.y === pmPlan.desks[1].y}`,
      `вытесненный менеджером не потерялся: ${!displaced.deskless
        && pmPlan.desks.some((d) => d.index === displaced.desk.index)}`,
      `остальные остались на своих номерах: ${keptOthers}`,
      `на одном столе не оказалось двоих: ${new Set([...om.instances.values()]
        .map((i) => i.desk.index)).size === om.instances.size}`,
    );
  } catch (e) {
    rmSync(pmSecondFile, { force: true });
    throw e;
  }

  // Столов меньше, чем людей: посаженные садятся, остальные переходят в
  // «без стола» — не исчезают и не остаются с координатами чужой комнаты.
  // Пресет «PM вторым» пока не убираем: офис назовёт его в совете «вернуть
  // прежнюю раскладку», а безымянный id в этом совете человеку не поможет.
  const crampedFile = resolve(layoutsDir, 'cramped-test.json');
  writeFileSync(crampedFile, JSON.stringify({
    version: 1, id: 'cramped-test', title: 'Каморка', size: [10, 8],
    props: [
      { sprite: 'desk_pm', at: [1, 2] },
      { sprite: 'desk', at: [5, 2] },
      { sprite: 'desk', at: [1, 5] },
    ],
  }));
  try {
    const staffBefore = om.instances.size;
    const chatBefore = om.chat.length;
    om.updateSettings({ layoutId: 'cramped-test' });
    const crampedPlan = deskPlan('cramped-test');
    const all = [...om.instances.values()];
    const seated = all.filter((i) => !i.deskless);
    const standing = all.filter((i) => i.deskless);
    const notice = om.chat.slice(chatBefore).find((c) => c.from === 'офис' && /без стола/i.test(c.text));
    results.push(
      `никто не потерян при нехватке столов: ${om.instances.size === staffBefore}`,
      `заняты все места тесной раскладки: ${seated.length === crampedPlan.desks.length}`,
      `PM среди посаженных: ${!om.staffOf('pm')[0]!.deskless}`,
      `остальные помечены «без стола»: ${standing.length === staffBefore - crampedPlan.desks.length}`,
      `безместные стоят внутри каморки, а не за её стеной: ${standing.length > 0
        && standing.every((i) => i.desk.x >= 0 && i.desk.x < 10 && i.desk.y >= 0 && i.desk.y < 8)}`,
      `безместные помнят свой номер места: ${standing
        .every((i) => beforeMove.some(([id, index]) => id === i.id && index === i.desk.index)
          || !crampedPlan.desks.some((d) => d.index === i.desk.index))}`,
      `офис написал в чат, кого не посадили: ${!!notice
        && standing.every((i) => notice.text.includes(i.label))}`,
      `в сообщении сказано, что делать: ${!!notice
        && /уволить/.test(notice.text) && /вернуть прежнюю раскладку «PM вторым»/.test(notice.text)}`,
    );

    // Безместный обязан пережить перезапуск: раньше restore молча выбрасывал
    // сотрудника, которому не хватило стола, вместе с его сессией и расходами.
    om.flush();
    const restoredCramped = om.restore();
    results.push(
      `после перезапуска в тесной раскладке штат цел: ${restoredCramped
        && om.instances.size === staffBefore}`,
      `безместные остались безместными: ${[...om.instances.values()]
        .filter((i) => i.deskless).length === staffBefore - crampedPlan.desks.length}`,
      `и стоят внутри комнаты, а не в углу-заглушке: ${[...om.instances.values()]
        .filter((i) => i.deskless).every((i) => i.desk.x > 0 || i.desk.y > 0)}`,
    );

    // Просторная раскладка возвращает всех за столы, и «без стола» снимается.
    om.updateSettings({ layoutId: 'classic' });
    results.push(
      `просторная раскладка вернула всех за столы: ${[...om.instances.values()]
        .every((i) => !i.deskless && classicPlan.desks
          .some((d) => d.index === i.desk.index && d.x === i.desk.x && d.y === i.desk.y))}`,
      `и снова никто не делит стол с соседом: ${new Set([...om.instances.values()]
        .map((i) => i.desk.index)).size === om.instances.size}`,
    );
  } finally {
    // Пресеты временные: оставленные файлы попали бы в список выбора раскладок.
    rmSync(crampedFile, { force: true });
    rmSync(pmSecondFile, { force: true });
    stopMove();
    wipe(moveFile);
  }

  // 11. Оверрайд расстановки (§8): офис двигает мебель поверх пресета. Пресет
  // остаётся эталоном на диске, место за столом обязано переехать вместе со
  // столом (иначе человечек сидел бы в воздухе), а сама правка — пережить
  // перезапуск, как и остальное состояние офиса.
  const ovFile = resolve(tmpdir(), `office-test-ov-${process.pid}.json`);
  const classicFile = resolve(layoutsDir, 'classic.json');
  const presetBefore = readFileSync(classicFile, 'utf8');
  const ovDir = resolve(tmpdir(), 'ov-office');
  const oo = openOfficeState({ id: 'o-ov', projectDir: ovDir, stateFile: ovFile }).state;
  // desk#1 — первый обычный стол classic (автоимя `<sprite>#<n>`, §3.2).
  const MOVED_KEY = 'desk#1';
  const presetPlan = deskPlan('classic');
  const movedIndex = presetPlan.desks.findIndex((d) => d.x === 6 && d.y === 4);
  const seatBefore = deskPoint(effectiveLayout('classic', null), catalog, movedIndex, 'work');
  const moveProblem = oo.editLayout([{ key: MOVED_KEY, at: [7, 5] }]);
  const seatAfter = deskPoint(oo.layout(), catalog, movedIndex, 'work');
  results.push(
    `сдвиг стола двигает и место за ним: ${moveProblem === null
      && seatAfter.x === seatBefore.x + 1 && seatAfter.y === seatBefore.y + 1}`,
    `файл пресета не переписан: ${readFileSync(classicFile, 'utf8') === presetBefore}`,
  );

  // Перезапуск: состояние поднимается с диска заново, и подвинутый стол
  // обязан остаться подвинутым — иначе мебель разъезжалась бы при каждом старте.
  oo.flush();
  const ovRestored = oo.restore();
  results.push(
    `оверрайд пережил перезапуск: ${ovRestored
      && deskPlan('classic', oo.override()).desks[movedIndex].x === 7
      && deskPlan('classic', oo.override()).desks[movedIndex].y === 5}`,
  );
  wipe(ovFile);

  // 12. Раскладка как контракт с клиентом (§8): команды правки и сброса ходят
  // через те же методы, что дёргает index.ts на layout_edit/layout_reset.
  // Проверяем ровно то, что видит веб: событие при изменении, снапшот при
  // подключении и отказ по-русски вместо испорченной расстановки.
  const cmdFile = resolve(tmpdir(), `office-test-cmd-${process.pid}.json`);
  const olc = openOfficeState({
    id: 'o-cmd', projectDir: resolve(tmpdir(), 'cmd-office'), stateFile: cmdFile,
  }).state;
  olc.seed();
  const layoutEvents: { props: number; override: number | null }[] = [];
  const unsubscribe = olc.subscribe((e) => {
    if (e.t === 'layout') {
      layoutEvents.push({ props: e.layout.props.length, override: e.override?.props.length ?? null });
    }
  });

  // Невалидное отклоняем целиком: ни одна из правок пачки не должна осесть в
  // оверрайде, иначе половина мебели переехала бы, а половина нет.
  const noSuchProp = olc.editLayout([{ key: 'дивана-тут-нет', at: [2, 2] }]);
  const outOfRoom = olc.editLayout([{ key: MOVED_KEY, at: [999, 4] }]);
  const notANumber = olc.editLayout([{ key: MOVED_KEY, at: [Number.NaN, 4] }]);
  const emptyEdits = olc.editLayout([]);
  const partialBatch = olc.editLayout([{ key: MOVED_KEY, at: [7, 5] }, { key: 'мусор', at: [1, 1] }]);
  results.push(
    `неизвестный предмет отклонён по-русски: ${/нет в раскладке/.test(noSuchProp ?? '')}`,
    `позиция за пределами комнаты отклонена: ${/за пределы комнаты/.test(outOfRoom ?? '')}`,
    `нечисловая позиция отклонена: ${/не число/.test(notANumber ?? '')}`,
    `пустая правка отклонена: ${/ни одного предмета/.test(emptyEdits ?? '')}`,
    `плохая правка в пачке отменяет всю пачку: ${partialBatch !== null && olc.override() === null}`,
    `отклонённые правки не породили событий: ${layoutEvents.length === 0}`,
  );

  // Принятая правка: и событие с итоговой раскладкой, и снапшот новому клиенту.
  const applied = olc.editLayout([{ key: MOVED_KEY, at: [7, 5] }]);
  const cmdSnap = olc.snapshot();
  const inSnapshot = cmdSnap.t === 'snapshot'
    && cmdSnap.layout.props.some((p) => p.at[0] === 7 && p.at[1] === 5)
    && cmdSnap.layoutOverride?.props.length === 1;
  const presetProps = effectiveLayout('classic', null).props.length;
  results.push(
    `правка расстановки принята: ${applied === null}`,
    `правка прислала событие с итоговой раскладкой: ${layoutEvents.length === 1
      && layoutEvents[0].props === presetProps && layoutEvents[0].override === 1}`,
    `итоговая раскладка и оверрайд едут в снапшоте: ${inSnapshot}`,
    `в снапшоте именно итоговая, а не пресет: ${cmdSnap.t === 'snapshot'
      && !cmdSnap.layout.props.some((p) => p.at[0] === 6 && p.at[1] === 4)}`,
  );

  // Перезапуск: правленая раскладка поднимается с диска и снова едет клиенту.
  olc.flush();
  const cmdRestored = olc.restore();
  const afterLayoutRestart = olc.snapshot();
  results.push(
    `правка пережила перезапуск: ${cmdRestored && afterLayoutRestart.t === 'snapshot'
      && afterLayoutRestart.layout.props.some((p) => p.at[0] === 7 && p.at[1] === 5)}`,
  );

  // Сброс: сначала один предмет, потом — весь оверрайд. Оба возвращают пресет.
  olc.editLayout([{ key: 'plant_small#1', flip: true }]);
  const resetUnknown = olc.resetLayout('дивана-тут-нет');
  const resetOne = olc.resetLayout(MOVED_KEY);
  const afterResetOne = olc.snapshot();
  const resetAll = olc.resetLayout();
  const afterResetAll = olc.snapshot();
  const resetTwice = olc.resetLayout();
  results.push(
    `сброс несуществующего предмета отклонён: ${/и так стоит там/.test(resetUnknown ?? '')}`,
    `сброс одного предмета принят: ${resetOne === null}`,
    `сброшенный предмет вернулся на место пресета: ${afterResetOne.t === 'snapshot'
      && afterResetOne.layout.props.some((p) => p.at[0] === 6 && p.at[1] === 4)
      && afterResetOne.layoutOverride?.props.length === 1}`,
    `сброс целиком вернул пресет: ${resetAll === null && afterResetAll.t === 'snapshot'
      && afterResetAll.layoutOverride === null
      && afterResetAll.layout.props.length === presetProps}`,
    `сбрасывать нечего — говорим об этом: ${/совпадает с пресетом/.test(resetTwice ?? '')}`,
    `сброс тоже прислал событие с раскладкой: ${layoutEvents.length === 4
      && layoutEvents[3].override === null}`,
    `файл пресета не переписан ни правкой, ни сбросом: ${
      readFileSync(classicFile, 'utf8') === presetBefore}`,
  );
  unsubscribe();
  wipe(cmdFile);

  // 13. Лимит одновременных исполнителей на деле. Настоящих сессий тут нет —
  // считается счётчик running, а запуск заменяет dryRun: проверяется решение
  // «пускать или ставить в очередь», а не работа Agent SDK.
  const capA = resolve(tmpdir(), `office-test-cap-a-${process.pid}.json`);
  const capB = resolve(tmpdir(), `office-test-cap-b-${process.pid}.json`);
  // Потолок процесса на время проверки — 4: с умолчанием в 6 пришлось бы
  // держать шесть «работающих» сессий, а проверяется правило, а не число.
  process.env.OFFICE_MAX_WORKERS = '4';
  // Задача в dryRun завершается по таймеру: растягиваем его, чтобы успеть
  // увидеть её именно в работе, а не уже сделанной.
  const prevDelay = process.env.OFFICE_DRY_RUN_DELAY;
  process.env.OFFICE_DRY_RUN_DELAY = '5000';
  const ca = openOfficeState({ id: 'o-cap-a', projectDir: resolve(tmpdir(), 'cap-a'), stateFile: capA }).state;
  const cb = openOfficeState({ id: 'o-cap-b', projectDir: resolve(tmpdir(), 'cap-b'), stateFile: capB }).state;
  ca.seed();
  cb.seed();
  ca.dryRun = true;
  cb.dryRun = true;
  ca.updateSettings({ maxConcurrentWorkers: 3 });
  cb.updateSettings({ maxConcurrentWorkers: 3 });

  // (а) Пер-офисный лимит: третий исполнитель в офисе — это уже потолок офиса,
  // и соседний офис на это решение не влияет.
  ca.running = 2;
  const underOfficeLimit = slotProblem(ca) === null;
  ca.running = 3;
  const officeLimitHolds = /в офисе уже работают 3 исполнителей из 3/.test(slotProblem(ca) ?? '');

  // (б) Общий потолок: у каждого офиса лимит 3, но вместе им нельзя больше 4.
  // Офис B под своим лимитом (2 из 3) и всё равно не стартует.
  ca.running = 2;
  cb.running = 2;
  const totalCounted = totalRunningWorkers() >= 4;
  const capHolds = /общий потолок на процесс/.test(slotProblem(cb) ?? '')
    && /общий потолок на процесс/.test(slotProblem(ca) ?? '');
  // Менеджера потолок не касается: сессия PM через слоты не проходит вовсе.
  // Проверяем это на конвейере — он тоже идёт мимо очереди (см. slotProblem).

  // (в) На потолке задача не падает, а встаёт в очередь с объяснением.
  const capTask = ca.createTask({
    title: 'ждёт слота', description: '', criteria: [], roleId: 'backend',
  });
  const refused = officeAssign(ca, capTask.id);
  const queued = !refused.ok && ca.waitingForSlot.has(capTask.id)
    && ca.tasks.get(capTask.id)?.status === 'backlog';
  const toldWhy = ca.chat.some((c) => c.text.includes(capTask.id) && /ждёт очереди/.test(c.text));
  // Повторная раздача той же задачи не должна плодить в ленте одно и то же.
  const chatBefore = ca.chat.length;
  officeAssign(ca, capTask.id);
  const noSpam = ca.chat.length === chatBefore;

  // (г) Слот освободился в СОСЕДНЕМ офисе — ждущая задача обязана поехать:
  // потолок общий, и держать её дальше не за чем.
  releaseSlot(cb);
  await new Promise((r) => setTimeout(r, 30));
  const startedAfterRelease = ca.tasks.get(capTask.id)?.status === 'in_progress'
    && !ca.waitingForSlot.has(capTask.id);
  const startAnnounced = ca.chat.some((c) => c.text.includes(capTask.id) && /слот освободился/.test(c.text));

  // (д) Теперь в потолок упирается сам офис: работающих в нём двое, и лимит
  // офиса тоже двое. Следующая задача снова встаёт в очередь — на этот раз
  // по офисной причине, а не по общей.
  ca.updateSettings({ maxConcurrentWorkers: 2 });
  const nextTask = ca.createTask({
    title: 'следом за первой', description: '', criteria: [], roleId: 'backend',
  });
  const nextRefused = officeAssign(ca, nextTask.id);
  const stillQueued = !nextRefused.ok && ca.waitingForSlot.has(nextTask.id)
    && /в офисе уже работают/.test(nextRefused.message);

  // (е) Поднятый лимит офиса действует на лету: очередь едет, не дожидаясь,
  // пока кто-нибудь доработает.
  ca.updateSettings({ maxConcurrentWorkers: 4 });
  await new Promise((r) => setTimeout(r, 30));
  const startedAfterRaise = ca.tasks.get(nextTask.id)?.status === 'in_progress';

  results.push(
    `под лимитом офиса слот свободен: ${underOfficeLimit}`,
    `пер-офисный лимит соблюдён: ${officeLimitHolds}`,
    `сессии офисов складываются в общий счётчик: ${totalCounted}`,
    `общий потолок не даёт превысить сумму по офисам: ${capHolds}`,
    `на потолке задача встаёт в очередь, а не падает: ${queued}`,
    `в ленте объяснено, почему исполнитель не стартовал: ${toldWhy}`,
    `повторная раздача не засоряет ленту: ${noSpam}`,
    `после освобождения слота ждущая задача пошла в работу: ${startedAfterRelease}`,
    `о старте из очереди сказано в ленте: ${startAnnounced}`,
    `следующая задача снова ждёт очереди: ${stillQueued}`,
    `поднятый лимит офиса отпускает очередь сразу: ${startedAfterRaise}`,
  );
  // Убираем за собой окружение. Таймеры dryRun не гасим намеренно: их
  // прерывание — это «остановлено пользователем», а оно зовёт менеджера, и
  // проверка состояния подняла бы настоящую сессию PM. Прогон заканчивается
  // раньше, чем таймеры дотикают, и process.exit уносит их с собой.
  delete process.env.OFFICE_MAX_WORKERS;
  if (prevDelay === undefined) delete process.env.OFFICE_DRY_RUN_DELAY;
  else process.env.OFFICE_DRY_RUN_DELAY = prevDelay;
  wipe(capA);
  wipe(capB);

  // 14. Очередь менеджера принадлежит офису, а не процессу. Настоящей сессии
  // PM тут нет и быть не должно: очередь с циклом подставляются заранее, и
  // startPm видит менеджера уже поднятым. Проверяется адресация — в чью
  // очередь ложится сообщение и чью гасит закрытие сессий.
  const pmFileA = resolve(tmpdir(), `office-test-pm-a-${process.pid}.json`);
  const pmFileB = resolve(tmpdir(), `office-test-pm-b-${process.pid}.json`);
  const pa = openOfficeState({ id: 'o-pm-a', projectDir: resolve(tmpdir(), 'pm-a'), stateFile: pmFileA }).state;
  const pb = openOfficeState({ id: 'o-pm-b', projectDir: resolve(tmpdir(), 'pm-b'), stateFile: pmFileB }).state;
  pa.seed();
  pb.seed();
  const qa = new MessageQueue();
  const qb = new MessageQueue();
  pa.pmQueue = qa;
  pa.pmLoop = Promise.resolve();
  pb.pmQueue = qb;
  pb.pmLoop = Promise.resolve();
  const ia = qa[Symbol.asyncIterator]();
  const ib = qb[Symbol.asyncIterator]();
  /** Прочитать сообщение очереди, не подвесив прогон, если его нет. */
  const took = async (it: AsyncIterator<{ message: { content: unknown } }>): Promise<string | null> => {
    const r = await Promise.race([
      it.next(),
      new Promise<null>((res) => { setTimeout(() => res(null), 30); }),
    ]);
    return r && !r.done ? String(r.value.message.content) : null;
  };

  // (а) Сообщение пользователя уходит менеджеру того офиса, где его написали.
  sendUserMessage(pa, 'вопрос в офис A');
  sendUserMessage(pb, 'вопрос в офис B');
  const gotA = await took(ia);
  const gotB = await took(ib);
  const routedByOffice = gotA === 'вопрос в офис A' && gotB === 'вопрос в офис B';
  const chatByOffice = pa.chat.some((c) => c.text === 'вопрос в офис A')
    && !pb.chat.some((c) => c.text === 'вопрос в офис A');

  // (б) Системное уведомление конвейера — тот же адресат: очередь офиса задачи.
  tellPm(pb, '[СИСТЕМА] отчёт офиса B');
  const notifiedB = await took(ib) === '[СИСТЕМА] отчёт офиса B';
  const notLeakedToA = await took(ia) === null;

  // (в) Остановленные вручную задачи считаются по офису: id задач в разных
  // офисах совпадают, и общий набор путал бы «остановлено» с «упало».
  pa.stoppedByUser.add('T-1');
  const stopsByOffice = pa.stoppedByUser.has('T-1') && !pb.stoppedByUser.has('T-1');

  // (г) Сброс сессий гасит очередь своего офиса и не трогает соседнюю:
  // иначе сброс доски в одном офисе рвал бы разговор в другом.
  resetSessions(pa);
  const closedOwn = pa.pmQueue === null && pa.pmLoop === null
    && (await ia.next()).done === true && pa.stoppedByUser.size === 0;
  const neighbourAlive = pb.pmQueue === qb && pb.pmLoop !== null;
  sendUserMessage(pb, 'офис B всё ещё говорит');
  const neighbourStillTakes = await took(ib) === 'офис B всё ещё говорит';

  results.push(
    `сообщение пользователя уходит в очередь своего офиса: ${routedByOffice}`,
    `лента сообщения тоже остаётся в своём офисе: ${chatByOffice}`,
    `системное уведомление адресуется офису задачи: ${notifiedB}`,
    `в чужую очередь ничего не протекло: ${notLeakedToA}`,
    `остановленные вручную задачи считаются по офису: ${stopsByOffice}`,
    `сброс сессий гасит очередь своего офиса: ${closedOwn}`,
    `очередь соседнего офиса от этого не пострадала: ${neighbourAlive}`,
    `и продолжает принимать сообщения: ${neighbourStillTakes}`,
  );
  unloadOfficeState('o-pm-a');
  unloadOfficeState('o-pm-b');
  wipe(pmFileA);
  wipe(pmFileB);

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

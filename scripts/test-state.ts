/**
 * Проверки состояния офиса без единого токена: пауза, критерии готовности
 * и разнесение расходов. Всё это — чистая логика в state.ts, и ловить её
 * регрессии сценариями PM дорого и медленно.
 *
 * Запуск: npm run test:state
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog, deskPlan, effectiveLayout } from '../src/server/layout';
import { deskPoint } from '../src/shared/layout';
import { LOOKS } from '../src/shared/looks';
import {
  criticalEnvFail, DEFAULT_SETTINGS, getOffice, openOfficeState, subscribeOffices, toTaskView,
  totalRunningWorkers, unloadOfficeState,
} from '../src/server/state';
import { refreshEnvChecks } from '../src/server/envcheck';
import { flushAll, load, save, wipe, type Persisted } from '../src/server/store';
import {
  DEFAULT_OFFICE_WORKERS, DEFAULT_PM_CONTEXT_LIMIT, DEFAULT_WORKER_CONTEXT_LIMIT, isOfficeSender, MAX_AGENT_NAME,
  MAX_OFFICE_WORKERS, MAX_TASK_MAX_TURNS, OFFICE_SENDER, type Settings,
} from '../src/shared/types';
import { cloudProblem, setGithubToken } from '../src/server/cloud';
import {
  compactPm, completePmCompaction, completePmRotation, noStaffReason, officeAssign, pmNeedsRotation, releaseSlot,
  resetSessions, rotatePm, sendUserMessage, slotProblem, teamSummary,
} from '../src/server/agents';
import { MessageQueue } from '../src/server/queue';
import { defaultRole, defaultRoles } from '../src/server/roles';
import { tellPm } from '../src/server/review';

/**
 * Проверки сверяют тексты офиса дословно, а написаны они по-русски — значит,
 * и офисы здесь должны быть русскими. Язык нового офиса берётся из окружения,
 * и задать его надо ДО первого открытия: ниже офис заводится сразу же.
 */
process.env.OFFICE_LANG = 'ru';

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
  results.push(
    `нанять обратно можно: ${hireBack === null && office.staffOf('smm').length === 1}`,
    `нанятый получил рабочее место: ${office.staffOf('smm')[0]?.desk !== undefined}`,
    `второго в ту же роль не нанять: ${/уже нанят/.test(office.hire('smm') ?? '')}`,
    `несуществующая роль отклонена: ${/нет в офисе/.test(office.hire('нет-такой') ?? '')}`,
  );

  // Ещё один такой же — не клон внутри роли, а отдельный сотрудник: своя роль
  // из того же пакета, те же настройки, своё название и своя внешность.
  const smm = office.role('smm')!;
  const copyProblem = office.hireCopy('smm');
  const smmCopy = office.roles().find((r) => r.id !== 'smm' && r.package?.name === smm.package?.name);
  results.push(
    `ещё один такой же пришёл отдельной ролью: ${copyProblem === null && smmCopy !== undefined
      && office.staffOf(smmCopy!.id).length === 1}`,
    `у второго своё название: ${Boolean(smmCopy) && smmCopy!.title !== smm.title}`,
    `у второго своя внешность: ${Boolean(smmCopy?.sprite) && smmCopy!.sprite !== smm.sprite}`,
    `настройки те же: ${smmCopy?.brief === smm.brief && smmCopy?.model === smm.model
      && smmCopy?.isolate === smm.isolate}`,
    `второго менеджера не нанять: ${/менеджер/i.test(office.hireCopy('pm') ?? '')}`,
  );
  // Роль второго уходит вместе с ним только по воле человека: увольнение
  // оставляет вакансию, и следующий найм из пакета закрывает именно её.
  office.fire(office.staffOf(smmCopy!.id)[0]!.id);
  const backToVacancy = office.hireCopy('smm') === null
    && office.staffOf(smmCopy!.id).length === 1
    && office.roles().filter((r) => r.package?.name === smm.package?.name).length === 2;
  results.push(`найм в пустую копию не плодит третью роль: ${backToVacancy}`);

  // Уволенная роль не воскресает при перезапуске: состав берётся из сохранения.
  for (const i of office.roles().filter((r) => r.package?.name === smm.package?.name)
    .flatMap((r) => office.staffOf(r.id))) office.fire(i.id);
  const secondBackend = office.hireCopy('backend') === null;
  const backendCopyId = office.roles().find((r) => r.id !== 'backend'
    && r.package?.name === office.role('backend')?.package?.name)?.id ?? '';
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

  // 7b'. Имя сотрудника: подпись берётся из имени, имя переживает
  // переименование роли и перезапуск, а занятое или длинное имя — отказ.
  const viewOf = (id: string) => office.instanceViews().find((i) => i.id === id);
  const backendTitle = office.role('backend')!.title;
  const namedOk = office.setAgentName('backend#1', '  Вася   Пупкин ') === null;
  const named = viewOf('backend#1');
  const dupe = office.setAgentName('pm#1', 'вася пупкин');
  const other = office.instanceViews().find((i) => i.id !== 'backend#1' && i.id !== 'pm#1')!;
  const clash = office.setAgentName('pm#1', other.label);
  const tooLong = office.setAgentName('pm#1', 'в'.repeat(MAX_AGENT_NAME + 1));
  office.updateRole('backend', { title: 'Другое название' });
  const keptOnRename = viewOf('backend#1')?.label === 'Вася Пупкин';
  office.updateRole('backend', { title: backendTitle });
  office.flush();
  const savedName = load(resolve(tmpdir(), `office-test-state-${process.pid}.json`))
    ?.instances.find((i) => i.id === 'backend#1')?.name;
  const unnamedOk = office.setAgentName('backend#1', '   ') === null;
  const unnamed = viewOf('backend#1');
  results.push(
    `сотруднику можно дать имя: ${namedOk && named?.name === 'Вася Пупкин' && named.label === 'Вася Пупкин'}`,
    `переименование записано в ленту: ${office.log.some((e) => e.agentId === 'backend#1' && /зовётся Вася Пупкин/.test(e.text))}`,
    `занятое имя отклонено без учёта регистра: ${/уже есть «Вася Пупкин»/.test(dupe ?? '') && viewOf('pm#1')?.name === null}`,
    `имя, совпадающее с подписью безымянного, тоже занято: ${/уже есть/.test(clash ?? '')}`,
    `слишком длинное имя отклонено: ${/длинное/.test(tooLong ?? '')}`,
    `имя переживает переименование роли: ${keptOnRename}`,
    `имя уходит в сохранение: ${savedName === 'Вася Пупкин'}`,
    `пустое имя снимает имя и возвращает подпись по роли: ${unnamedOk && unnamed?.name === null && unnamed.label === backendTitle}`,
  );

  // 7c. Раскладка офиса как настройка: значение по умолчанию, отказ по
  // неизвестному id и список пресетов, из которого выбирают. Что по ней
  // считаются столы — отдельно, в разделе 10.
  const layoutByDefault = office.settings.layoutId === 'studio_4';
  const badLayout = office.updateSettings({ layoutId: 'нет-такой' });
  const layoutKept = office.settings.layoutId === 'studio_4';
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
    `новый офис заводится со studio_4: ${layoutByDefault}`,
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
    `второй такой же сотрудник сохранился: ${secondBackend
      && office.staffOf(backendCopyId).length === 1}`,
    `столы не разъехались: ${new Set([...office.instances.values()].map((i) => i.desk.index)).size === office.instances.size}`,
    `по умолчанию у роли прежний режим: ${defaultMode === 'ask-risky'}`,
    `роль без своего режима наследует офисный: ${inheritedAuto === 'auto'}`,
    `неизвестный режим не принимается: ${junkIgnored}`,
    `личный режим сильнее офисного: ${personal?.effectivePermissionMode === 'auto'}`,
    `второй такой же остался на режиме своей роли: ${office.instanceViews().find((i) => i.roleId === backendCopyId)?.effectivePermissionMode === 'ask-risky'}`,
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
  // Сохранение сделано в формате до переезда ролей в офис: набора ролей в нём
  // нет вовсе, а есть только правки поверх базового. Такой файл обязан
  // подняться без потерь и дальше храниться уже набором целиком.
  save(junkFile, () => junkOffice.toPersisted());
  flushAll();
  const migrated = JSON.parse(readFileSync(junkFile, 'utf8')) as Persisted;
  results.push(
    `испорченный лимит роли из файла не применён: ${junkOffice.role('backend')?.maxTurns == null}`,
    `роль вернулась к офисному лимиту: ${
      junkOffice.turnsFor(junkOffice.role('backend')!) === DEFAULT_SETTINGS.taskMaxTurns}`,
    `остальные правки роли из файла уцелели: ${
      junkOffice.role('backend')?.model === 'claude-haiku-4-5'}`,
    `старое сохранение подняло весь базовый набор ролей: ${
      junkOffice.roles().length === defaultRoles('ru').length}`,
    `перенесённый набор сохранён целиком: ${Array.isArray(migrated.roles)
      && migrated.roles.some((r) => r.id === 'backend' && r.model === 'claude-haiku-4-5')
      && migrated.roles.some((r) => r.id === 'reviewer')}`,
    `в перенесённом наборе ровно один менеджер: ${
      (migrated.roles ?? []).filter((r) => r.isManager).length === 1}`,
  );
  unloadOfficeState('o-roleturns');
  wipe(junkFile);

  // 7h′. Сохранение, заведённое до настройки раскладки: поля нет вовсе. Такой
  // офис обязан подняться по classic — так он выглядел всегда, — а не по
  // раскладке, с которой заводятся новые офисы.
  const oldLayoutFile = resolve(tmpdir(), `office-test-oldlayout-${process.pid}.json`);
  const oldLayoutDir = resolve(tmpdir(), 'oldlayout-office');
  const { layoutId: _dropped, ...settingsWithoutLayout } = DEFAULT_SETTINGS;
  save(oldLayoutFile, () => ({
    version: 1, projectDir: oldLayoutDir, taskSeq: 0, tasks: [], chat: [], log: [],
    instances: [], settings: settingsWithoutLayout as Settings, savedAt: Date.now(),
  }));
  flushAll();
  const oldLayoutOffice = openOfficeState({
    id: 'o-oldlayout', projectDir: oldLayoutDir, stateFile: oldLayoutFile,
  }).state;
  results.push(
    `новый офис заводится не по classic: ${DEFAULT_SETTINGS.layoutId !== 'classic'}`,
    `сохранение без раскладки поднимается по classic: ${oldLayoutOffice.settings.layoutId === 'classic'}`,
  );
  unloadOfficeState('o-oldlayout');
  wipe(oldLayoutFile);

  // 7h″. Приоритет задачи: умолчание, смена и перезапуск. Проверяется ровно
  // то, на чём приоритет соврал бы незаметно, — задача из сохранения старше
  // поля (её приоритет обязан быть средним, а не пустым) и правленый руками
  // файл с чужим словом вместо приоритета.
  const prioFile = resolve(tmpdir(), `office-test-priority-${process.pid}.json`);
  const prioDir = resolve(tmpdir(), 'priority-office');
  const prioOffice = openOfficeState({ id: 'o-priority', projectDir: prioDir, stateFile: prioFile }).state;
  prioOffice.seed();
  const plain = prioOffice.createTask({
    title: 'обычная работа', description: '', criteria: [], roleId: 'backend',
  });
  const urgent = prioOffice.createTask({
    title: 'блокирует владельца', description: '', criteria: [], roleId: 'backend',
    priority: 'high',
  });
  const later = prioOffice.createTask({
    title: 'когда угодно', description: '', criteria: [], roleId: 'backend',
  });
  const lowered = prioOffice.setTaskPriority(later.id, 'low');
  const noSuchTask = prioOffice.setTaskPriority('T-404', 'high');
  results.push(
    `по умолчанию приоритет средний: ${plain.priority === 'normal'}`,
    `create_task принимает высокий: ${urgent.priority === 'high'}`,
    `приоритет меняется на низкий: ${lowered === null && later.priority === 'low'}`,
    `приоритет уходит в снимок для веба: ${toTaskView(urgent).priority === 'high'}`,
    `смена приоритета у несуществующей задачи — отказ словами: ${
      typeof noSuchTask === 'string' && noSuchTask.includes('T-404')}`,
    `смена видна в ленте офиса: ${prioOffice.log.some((e) => e.text.includes('низкий'))}`,
  );

  flushAll();
  const reopenedPrio = openOfficeState({
    id: 'o-priority-again', projectDir: prioDir, stateFile: prioFile,
  }).state;
  results.push(
    `высокий пережил перезапуск: ${reopenedPrio.tasks.get(urgent.id)?.priority === 'high'}`,
    `низкий пережил перезапуск: ${reopenedPrio.tasks.get(later.id)?.priority === 'low'}`,
  );
  unloadOfficeState('o-priority-again');

  // Сохранение, сделанное до приоритета, поля не знает вовсе; а в правленом
  // руками файле на его месте может оказаться что угодно.
  const rawPrio = JSON.parse(readFileSync(prioFile, 'utf8')) as {
    tasks: Array<Record<string, unknown>>;
  };
  for (const t of rawPrio.tasks) {
    if (t.id === urgent.id) t.priority = 'НЕМЕДЛЕННО';
    else delete t.priority;
  }
  writeFileSync(prioFile, JSON.stringify(rawPrio, null, 2), 'utf8');
  const oldPrioOffice = openOfficeState({
    id: 'o-priority-old', projectDir: prioDir, stateFile: prioFile,
  }).state;
  results.push(
    `задача из сохранения без приоритета читается средней: ${
      oldPrioOffice.tasks.get(plain.id)?.priority === 'normal'}`,
    `чужое слово вместо приоритета становится средним: ${
      oldPrioOffice.tasks.get(urgent.id)?.priority === 'normal'}`,
    `и доска из старого сохранения не потерялась: ${oldPrioOffice.tasks.size === 3}`,
  );
  unloadOfficeState('o-priority-old');
  unloadOfficeState('o-priority');
  wipe(prioFile);

  // 7i. История совещаний переживает перезапуск, а реплики привязаны к своему
  // совещанию. Совещание, застигнутое перезапуском, поднимается сорвавшимся:
  // сессий участников больше нет, и «идёт» оно только на бумаге.
  const meetFile = resolve(tmpdir(), `office-test-meetings-${process.pid}.json`);
  const meetDir = resolve(tmpdir(), 'meetings-office');
  const meetOffice = openOfficeState({ id: 'o-meetings', projectDir: meetDir, stateFile: meetFile }).state;
  meetOffice.seed();
  const doneMeeting = {
    id: 'M-done', topic: 'Как хранить заметки', participants: ['backend#1', 'frontend#1'],
    speaking: null, status: 'done' as const, startedAt: 1000, finishedAt: 2000,
  };
  meetOffice.setMeeting({ ...doneMeeting, status: 'running', finishedAt: null });
  meetOffice.addChat('backend#1', 'Хранить в JSON.', 'meeting', 'M-done');
  meetOffice.setMeeting(doneMeeting);
  meetOffice.setMeeting({
    id: 'M-cut', topic: 'Оборванное', participants: ['backend#1', 'frontend#1'],
    speaking: 'backend#1', status: 'running', startedAt: 3000, finishedAt: null,
  });
  meetOffice.addChat(OFFICE_SENDER, 'уже идёт', 'meeting');
  save(meetFile, () => meetOffice.toPersisted());
  flushAll();
  unloadOfficeState('o-meetings');
  const meetAgain = openOfficeState({ id: 'o-meetings', projectDir: meetDir, stateFile: meetFile }).state;
  const cut = meetAgain.meetings.find((m) => m.id === 'M-cut');
  results.push(
    `история совещаний поднялась из файла: ${meetAgain.meetings.length === 2}`,
    `закончившееся совещание осталось закончившимся: ${
      meetAgain.meetings.find((m) => m.id === 'M-done')?.status === 'done'}`,
    `совещание не дописывается дважды в историю: ${
      meetAgain.meetings.filter((m) => m.id === 'M-done').length === 1}`,
    `оборванное перезапуском совещание сорвалось, а не идёт: ${
      cut?.status === 'failed' && cut.speaking === null && cut.finishedAt !== null}`,
    `реплика помнит своё совещание: ${
      meetAgain.chat.filter((c) => c.meetingId === 'M-done').length === 1}`,
    `служебный ответ офиса совещанию не принадлежит: ${
      meetAgain.chat.every((c) => c.meetingId === 'M-done' || c.meetingId === undefined)}`,
  );
  unloadOfficeState('o-meetings');
  wipe(meetFile);

  // 7h. Набор инструментов базовой роли живёт в коде, а не в сохранении: из UI
  // он не правится, и сохранённая копия старого набора означала бы, что новый
  // инструмент не доедет ни до одного заведённого офиса — роль осталась бы со
  // скилом и без того, чем он работает.
  const toolsFile = resolve(tmpdir(), `office-test-roletools-${process.pid}.json`);
  const toolsDir = resolve(tmpdir(), 'roletools-office');
  save(toolsFile, () => ({
    version: 1, projectDir: toolsDir, taskSeq: 0, tasks: [], chat: [], log: [],
    instances: [], settings: { ...DEFAULT_SETTINGS }, savedAt: Date.now(),
    roles: [{ ...defaultRole('design', 'ru')!, tools: ['Read', 'Write'] }],
  }));
  flushAll();
  const toolsOffice = openOfficeState({
    id: 'o-roletools', projectDir: toolsDir, stateFile: toolsFile,
  }).state;
  const designTools = toolsOffice.role('design')?.tools ?? [];
  results.push(
    `набор инструментов базовой роли взят из кода: ${
      designTools.includes('Bash') && designTools.includes('Artifact')}`,
  );
  unloadOfficeState('o-roletools');
  wipe(toolsFile);

  // 7h. Роли принадлежат офису, а не процессу: у каждого проекта свой набор,
  // он хранится в его состоянии и переживает перезапуск. Ломается тут первым
  // делом одно из двух — правка роли в одном офисе видна в другом, либо роль
  // одного офиса появляется в соседнем. Общего реестра ролей нет вовсе: офис
  // у любой роли спрашивают явно.
  const roleFileA = resolve(tmpdir(), `office-test-roles-a-${process.pid}.json`);
  const roleFileB = resolve(tmpdir(), `office-test-roles-b-${process.pid}.json`);
  const ra = openOfficeState({
    id: 'o-roles-a', projectDir: resolve(tmpdir(), 'roles-a'), stateFile: roleFileA,
  }).state;
  const rb = openOfficeState({
    id: 'o-roles-b', projectDir: resolve(tmpdir(), 'roles-b'), stateFile: roleFileB,
  }).state;
  const baseModel = defaultRole('backend', 'ru')!.model;
  ra.updateRole('backend', { model: 'claude-haiku-4-5', title: 'Бэкенд офиса A' });
  results.push(
    `правка роли применилась в своём офисе: ${ra.role('backend')?.model === 'claude-haiku-4-5'}`,
    `в соседнем офисе роль осталась прежней: ${rb.role('backend')?.model === baseModel
      && rb.role('backend')?.title === defaultRole('backend', 'ru')!.title}`,
    `правка не дошла и до базового набора: ${defaultRole('backend', 'ru')!.model === baseModel}`,
  );

  // Своя роль офиса A. Из интерфейса их будет заводить следующая задача, а
  // здесь набор правится в файле состояния — том самом, где он теперь живёт.
  ra.flush();
  const savedA = JSON.parse(readFileSync(roleFileA, 'utf8')) as Persisted;
  savedA.roles = [
    ...(savedA.roles ?? []),
    // Ссылку на пакет снимаем: роль с ней считается из пакета, и чужие id с
    // названием в файле означали бы не «своя роль», а «дизайнер под другим id».
    { ...defaultRole('design', 'ru')!, package: undefined, id: 'writer', title: 'Технический писатель' },
  ];
  writeFileSync(roleFileA, JSON.stringify(savedA, null, 2));
  const rolesRestored = ra.restore();
  const managers = (o: typeof ra): number => o.roles().filter((r) => r.isManager).length;
  results.push(
    `набор ролей поднялся с диска: ${rolesRestored}`,
    `правка роли пережила перезапуск: ${ra.role('backend')?.model === 'claude-haiku-4-5'
      && ra.role('backend')?.title === 'Бэкенд офиса A'}`,
    `своя роль офиса поднялась: ${ra.role('writer')?.title === 'Технический писатель'}`,
    `в соседнем офисе этой роли нет: ${rb.role('writer') === undefined}`,
    `наборы ролей офисов разошлись: ${ra.roles().length === rb.roles().length + 1}`,
    `PM есть в обоих офисах: ${ra.role('pm')?.isManager === true && rb.role('pm')?.isManager === true}`,
    `и в каждом он ровно один: ${managers(ra) === 1 && managers(rb) === 1}`,
    // Своя роль офиса — не запись в списке, а рабочее место: в неё нанимают
    // там, где она есть, и не могут нанять там, где её нет.
    `в свою роль офиса можно нанять сотрудника: ${ra.hire('writer') === null
      && ra.staffOf('writer').length === 1}`,
    `в соседнем офисе такой роли для найма нет: ${/нет в офисе/.test(rb.hire('writer') ?? '')}`,
  );
  unloadOfficeState('o-roles-a');
  unloadOfficeState('o-roles-b');
  wipe(roleFileA);
  wipe(roleFileB);

  // 7j. Переезд ролей на единую палитру. Манифест пакета красит только новый
  // найм: у роли, нанятой раньше, старый цвет лежит в состоянии офиса — либо
  // прямо в поле роли, либо оверрайдом ссылки на пакет. Разовая миграция при
  // загрузке снимает именно прежнее умолчание — и не трогает цвет, который
  // владелец выбрал руками. Второй перезапуск обязан не менять ничего.
  const paletteFile = resolve(tmpdir(), `office-test-palette-${process.pid}.json`);
  const rp = openOfficeState({
    id: 'o-palette', projectDir: resolve(tmpdir(), 'palette'), stateFile: paletteFile,
  }).state;
  rp.flush();
  const savedP = JSON.parse(readFileSync(paletteFile, 'utf8')) as Persisted;
  const linkWith = (role: string, color: string) => {
    const link = defaultRole(role, 'ru')!.package!;
    return { ...link, overrides: { ...link.overrides, color } };
  };
  savedP.roles = [
    // Сохранение старше пакетов: ссылки нет, цвет — прежнее умолчание бэкенда.
    { ...defaultRole('backend', 'ru')!, package: undefined, color: '#3b82f6' },
    // Ссылка есть, но старый цвет застрял в ней оверрайдом.
    { ...defaultRole('reviewer', 'ru')!, color: '#f97316', package: linkWith('reviewer', '#f97316') },
    // Ручная покраска чужим старым значением: у дизайна умолчанием оно
    // никогда не было — значит, это выбор человека, и его не трогают.
    { ...defaultRole('design', 'ru')!, color: '#f97316', package: linkWith('design', '#f97316') },
    // Ручная покраска цветом, которого в прежнем наборе нет вовсе.
    { ...defaultRole('smm', 'ru')!, color: '#123456', package: linkWith('smm', '#123456') },
    // Своя роль офиса: пакета нет, сверять не с чем, кроме самого значения.
    { ...defaultRole('design', 'ru')!, package: undefined, id: 'writer', title: 'Писатель', color: '#14b8a6' },
  ];
  writeFileSync(paletteFile, JSON.stringify(savedP, null, 2));
  rp.restore();
  const colorOf = (id: string): string | undefined => rp.role(id)?.color;
  results.push(
    `застрявшее умолчание переехало на палитру: ${colorOf('backend') === '#2f7bf6'}`,
    `оверрайд с прежним умолчанием снят: ${colorOf('reviewer') === '#ea580c'}`,
    `чужое старое значение принято за ручное: ${colorOf('design') === '#f97316'}`,
    `цвет вне прежнего набора не тронут: ${colorOf('smm') === '#123456'}`,
    `роль без пакета тоже переехала: ${colorOf('writer') === '#0d9488'}`,
  );
  // Идемпотентность: сохранённое состояние после миграции поднимается второй
  // раз — и ни цвета, ни файл не должны сдвинуться ни на байт.
  rp.flush();
  // Момент сохранения у двух записей разный по определению — сверяем всё
  // остальное: миграция не должна добавить в файл ни одного нового байта.
  const stateBody = (): string => {
    const { savedAt: _savedAt, ...rest } = JSON.parse(readFileSync(paletteFile, 'utf8')) as Persisted;
    return JSON.stringify(rest);
  };
  const afterFirst = stateBody();
  rp.restore();
  rp.flush();
  results.push(
    `повторный запуск цвета не менял: ${colorOf('backend') === '#2f7bf6'
      && colorOf('reviewer') === '#ea580c' && colorOf('design') === '#f97316'
      && colorOf('smm') === '#123456' && colorOf('writer') === '#0d9488'}`,
    `и состояние на диске не тронул: ${stateBody() === afterFirst}`,
  );
  unloadOfficeState('o-palette');
  wipe(paletteFile);

  // 7i. Заведение, правка и архивация ролей — то, чем пользуется окно
  // управления агентами. Ломается тут в первую очередь три вещи: id роли,
  // собранный по русскому названию, наезжает на уже занятый; архивная роль
  // перестаёт находиться по id, и история задач разваливается; PM оказывается
  // архивируемым или переименовываемым — и офис остаётся без менеджера.
  const crudFile = resolve(tmpdir(), `office-test-roles-crud-${process.pid}.json`);
  const crudDir = resolve(tmpdir(), `roles-crud-office-${process.pid}`);
  mkdirSync(crudDir, { recursive: true });
  const rc = openOfficeState({ id: 'o-roles-crud', projectDir: crudDir, stateFile: crudFile }).state;

  // (а) Создание: id выдаёт сервер, форма присылает только поля. Внешность —
  // id из shared/looks.ts, то есть имя скина трёхмерной модели: плоские
  // пресеты (`agent_p3`) остались только в старых сохранениях.
  const made = await rc.createRole({
    title: 'Технический писатель',
    model: 'claude-haiku-4-5',
    sprite: LOOKS[0].id,
    brief: 'Пишет документацию к тому, что сделала команда.',
  });
  const writer = 'role' in made ? made.role : null;
  const writerId = writer?.id ?? '';
  results.push(
    `роль заведена: ${writer !== null}`,
    `id собран сервером из русского названия: ${writerId === 'tehnicheskiy-pisatel'}`,
    `поля формы доехали до роли: ${writer?.model === 'claude-haiku-4-5'
      && writer?.sprite === LOOKS[0].id}`,
    `новая роль не менеджер и не в архиве: ${writer?.isManager === false && writer?.archived === false}`,
    `роль видна менеджеру: ${rc.workerRoles().some((r) => r.id === writerId)}`,
  );

  // (б) В id не должно остаться ничего, кроме латиницы, цифр и дефиса, —
  // он уезжает в имя ветки, в путь worktree и в id сотрудника «роль#номер».
  const messy = await rc.createRole({ title: 'Контент /// №1 (черновик)!' });
  const messyId = 'role' in messy ? messy.role.id : '#';
  const emptyish = await rc.createRole({ title: '«»— ()' });
  const emptyishId = 'role' in emptyish ? emptyish.role.id : '#';
  results.push(
    `мусор из названия в id не попал: ${/^[a-z0-9-]+$/.test(messyId)
      && !messyId.startsWith('-') && !messyId.endsWith('-')}`,
    `решётки в id нет — она делит id сотрудника: ${!messyId.includes('#')}`,
    `название из одних символов даёт рабочий id: ${/^[a-z0-9-]+$/.test(emptyishId)}`,
  );

  // (в) Коллизии: разные названия дают одну и ту же основу id, а занятыми
  // считаются и базовые роли — даже те, которых в этом офисе нет.
  const clash1 = await rc.createRole({ title: 'Backend' });
  const clash2 = await rc.createRole({ title: 'Backend!' });
  const id1 = 'role' in clash1 ? clash1.role.id : '';
  const id2 = 'role' in clash2 ? clash2.role.id : '';
  const allIds = rc.roles().map((r) => r.id);
  results.push(
    `id не наехал на базовую роль: ${id1 !== 'backend' && id1.startsWith('backend')}`,
    `второй такой же основе достался свой id: ${id2 !== id1 && id2.startsWith('backend')}`,
    `в наборе нет двух ролей с одним id: ${new Set(allIds).size === allIds.length}`,
    `роль с занятым названием не заводится: ${'errors' in await rc.createRole({ title: 'Backend' })}`,
    `роль без названия не заводится: ${'errors' in await rc.createRole({ title: '   ' })}`,
  );

  // (г) Архивация не может застать роль врасплох: ни с живым сотрудником,
  // ни с незакрытой задачей — иначе работа осталась бы без роли.
  rc.hire(writerId);
  const withStaff = rc.archiveRole(writerId, true);
  const fired = rc.fire(`${writerId}#1`);
  const writerTask = rc.createTask({
    title: 'описать API', description: '', criteria: ['готово'], roleId: writerId,
  });
  rc.updateTask(writerTask.id, { status: 'in_progress' });
  const withTask = rc.archiveRole(writerId, true);
  rc.updateTask(writerTask.id, { status: 'done' });
  const archived = rc.archiveRole(writerId, true);
  results.push(
    `с живым сотрудником архивация отклонена: ${withStaff.length === 1
      && /уволите/.test(withStaff[0].message)}`,
    `сотрудник уволен: ${fired === null}`,
    `с незакрытой задачей архивация отклонена: ${withTask.length === 1
      && withTask[0].message.includes(writerTask.id)}`,
    `после увольнения и закрытия задачи роль ушла в архив: ${archived.length === 0
      && rc.role(writerId)?.archived === true}`,
  );

  // (д) Архив — это «пропала из найма», а не «исчезла»: roleId лежит в
  // задачах, логах и сохранённых сотрудниках, и находиться по нему обязан.
  const historyTask = rc.tasks.get(writerTask.id)!;
  const archivedView = rc.roleViews().find((r) => r.id === writerId);
  results.push(
    `архивной роли нет в перечне для менеджера: ${!rc.workerRoles().some((r) => r.id === writerId)}`,
    `в архивную роль не нанять: ${/архиве/.test(rc.hire(writerId) ?? '')}`,
    `архивная роль резолвится по id из задачи: ${
      rc.role(historyTask.roleId!)?.title === 'Технический писатель'}`,
    `UI видит её отдельно, а не теряет: ${archivedView?.archived === true}`,
    `в наборе она осталась: ${rc.roles().some((r) => r.id === writerId)}`,
    `из архива роль возвращается: ${rc.archiveRole(writerId, false).length === 0
      && rc.workerRoles().some((r) => r.id === writerId)}`,
  );
  rc.archiveRole(writerId, true);

  // (д2) Что видит менеджер. Перечень ролей уезжает к нему двумя путями:
  // текстом list_team и описанием поля roleId у create_task. Оба обязаны
  // говорить одно и то же, иначе менеджер назначит на роль, которой нет.
  const summaryWithArchived = teamSummary(rc);
  const menuIds = rc.workerRoles().map((r) => r.id);
  const untouched = getOffice('o-1');
  results.push(
    `архивной роли нет в составе команды для менеджера: ${
      !summaryWithArchived.includes(`- ${writerId} (`)}`,
    `живые роли в составе остались: ${menuIds.includes('backend')
      && summaryWithArchived.includes('- backend (')}`,
    // Сколько исполнителей должен видеть менеджер, считаем по набору, а не
    // «все минус менеджер»: в наборе может появиться роль, заведённая в
    // архиве, и вычитание единицы молча превратило бы эту проверку в
    // проверку длины списка. В наборе есть и нанятые вторыми такими же —
    // отдельные роли из тех же пакетов, и их менеджер тоже обязан видеть.
    `в офисе без архива менеджер видит всех исполнителей: ${
      untouched.workerRoles().length === untouched.roles().filter((r) => !r.isManager).length
      && defaultRoles('ru').filter((r) => !r.isManager)
        .every((d) => untouched.workerRoles().some((r) => r.id === d.id))
      && untouched.workerRoles().every((r) => teamSummary(untouched).includes(`- ${r.id} (`))}`,
  );

  // (е) PM защищён со всех сторон: без менеджера офису не с кем разговаривать,
  // а «Проектный менеджер», переименованный в верстальщика, — это тот же офис
  // без менеджера, только менеджер в списке ещё числится.
  const pmArchive = rc.archiveRole('pm', true);
  const pmRemove = rc.removeRole('pm');
  const pmRename = await rc.editRole('pm', { title: 'Верстальщик' });
  const pmEmoji = await rc.editRole('pm', { emoji: '🧭' });
  results.push(
    `PM не архивируется: ${pmArchive.length === 1 && rc.role('pm')?.archived !== true}`,
    `PM не удаляется: ${pmRemove.length === 1 && rc.role('pm') !== undefined}`,
    `PM не переименовать в другую роль: ${pmRename.length === 1
      && pmRename[0].field === 'title' && rc.role('pm')?.title === defaultRole('pm', 'ru')!.title}`,
    `остальные поля PM править можно: ${pmEmoji.length === 0 && rc.role('pm')?.emoji === '🧭'}`,
  );

  // (ж) Физическое удаление — только для роли без следа в истории. Всё
  // остальное уходит в архив, иначе доска перестанет читаться.
  const removeUsed = rc.removeRole(writerId);
  const removeFresh = rc.removeRole(messyId);
  const freshView = rc.roleViews().find((r) => r.id === emptyishId);
  const usedView = rc.roleViews().find((r) => r.id === writerId);
  results.push(
    `роль с задачами насовсем не стереть: ${removeUsed.length === 1
      && /архив/.test(removeUsed[0].message) && rc.role(writerId) !== undefined}`,
    `роль без следов стирается насовсем: ${removeFresh.length === 0
      && rc.role(messyId) === undefined}`,
    `UI знает, какую роль можно стереть: ${freshView?.removable === true
      && usedView?.removable === false}`,
  );

  // (з) Ошибки возвращаются по полям формы, а не общим тостом: человек правит
  // ровно то, что не так. Репозиторий проверяется той же проверкой, что и на
  // старте офиса, — путь должен существовать, быть директорией и репозиторием.
  const noSuchDir = resolve(tmpdir(), `roles-crud-net-takoy-${process.pid}`);
  const plainFile = resolve(crudDir, 'ne-direktoriya.txt');
  writeFileSync(plainFile, 'просто файл');
  const notRepoDir = resolve(tmpdir(), `roles-crud-bez-git-${process.pid}`);
  mkdirSync(notRepoDir, { recursive: true });
  const realRepo = resolve(tmpdir(), `roles-crud-repo-${process.pid}`);
  mkdirSync(realRepo, { recursive: true });
  execFileSync('git', ['init', '-q', realRepo]);
  execFileSync('git', [
    '-C', realRepo, '-c', 'user.email=office@test', '-c', 'user.name=office',
    'commit', '--allow-empty', '-q', '-m', 'первый',
  ]);
  const errMissing = await rc.editRole(emptyishId, { repoDir: noSuchDir });
  const errFile = await rc.editRole(emptyishId, { repoDir: plainFile });
  const errNoGit = await rc.editRole(emptyishId, { repoDir: notRepoDir });
  const okRepo = await rc.editRole(emptyishId, { repoDir: realRepo });
  const shaped = [errMissing, errFile, errNoGit].every((list) => list.length === 1
    && list[0].field === 'repoDir' && list[0].message.length > 0);
  results.push(
    `несуществующий путь отклонён под полем репозитория: ${errMissing.length === 1
      && errMissing[0].field === 'repoDir'}`,
    `файл вместо директории отклонён: ${errFile.length === 1 && errFile[0].field === 'repoDir'}`,
    `директория без git отклонена: ${errNoGit.length === 1 && errNoGit[0].field === 'repoDir'}`,
    `все ошибки пришли парой {field, message}: ${shaped}`,
    `настоящий репозиторий принят: ${okRepo.length === 0
      && rc.role(emptyishId)?.repoDir === realRepo}`,
    `негодный путь до роли не доехал: ${rc.role(emptyishId)?.repoDir !== noSuchDir}`,
  );

  // (и) Правка работает со всеми полями, включая внешность, а несуществующая
  // внешность отклоняется — иначе человечек в комнате просто не нарисуется.
  // Плоский пресет (`agent_p7`) в старых сохранениях ещё встречается и
  // рисуется, но выбрать его заново нельзя: комнате нужен скин модели.
  const badSprite = await rc.editRole(emptyishId, { sprite: 'agent_takogo_net' });
  const legacySprite = await rc.editRole(emptyishId, { sprite: 'agent_p7' });
  const fullEdit = await rc.editRole(emptyishId, {
    title: 'Аналитик данных', emoji: '📊', color: '#22d3ee', model: 'claude-opus-5',
    permissionMode: 'readonly', isolate: false, maxTurns: 40,
    sprite: LOOKS[1].id, brief: 'Считает метрики.',
  });
  const edited = rc.role(emptyishId);
  results.push(
    `несуществующий спрайт отклонён под своим полем: ${badSprite.length === 1
      && badSprite[0].field === 'sprite'}`,
    `старый плоский пресет внешности заново не выбрать: ${legacySprite.length === 1
      && legacySprite[0].field === 'sprite'}`,
    `правка приняла все поля разом: ${fullEdit.length === 0
      && edited?.title === 'Аналитик данных' && edited?.emoji === '📊'
      && edited?.model === 'claude-opus-5' && edited?.permissionMode === 'readonly'
      && edited?.isolate === false
      && edited?.maxTurns === 40 && edited?.sprite === LOOKS[1].id}`,
    // Роль, заведённая руками, копируется сама собой: пакета у неё нет, и
    // второй такой же получает её настройки, но своё название и внешность.
    `копия роли без пакета берёт её настройки: ${(() => {
      if (rc.hire(emptyishId) !== null) return false;
      // Столы в этом офисе к этому моменту заняты, а проверяется копирование
      // настроек, а не расчёт мест: освобождаем одно сами.
      const donor = rc.roles().find((r) => !r.isManager && r.id !== emptyishId
        && rc.staffOf(r.id).some((i) => !i.currentTaskId));
      const who = donor ? rc.staffOf(donor.id).find((i) => !i.currentTaskId) : null;
      if (who) rc.fire(who.id);
      if (rc.hireCopy(emptyishId) !== null) return false;
      const copy = rc.roles().find((r) => r.id !== emptyishId && r.brief === edited?.brief);
      return copy !== undefined && copy.title !== edited?.title
        && copy.model === edited?.model && copy.package === undefined
        && rc.staffOf(copy.id).length === 1;
    })()}`,
  );
  // Патч приезжает из сети: с ним доехали бы и архивация, и второй менеджер
  // в обход всех проверок — белый список полей это отсекает.
  await rc.editRole(emptyishId, { archived: true, isManager: true } as unknown as Parameters<typeof rc.editRole>[1]);
  results.push(
    `правкой роли нельзя ни заархивировать, ни назначить менеджером: ${
      rc.role(emptyishId)?.archived !== true && rc.role(emptyishId)?.isManager === false}`,
  );

  // (к) Перечень ролей вшит в описание assign и в бриф PM в момент старта
  // сессии. Значит, после правки набора сессию надо перезапустить — иначе
  // менеджер назначает на роль, которой уже нет. Настоящей сессии здесь нет:
  // очередь с циклом подставлены, проверяется решение о перезапуске.
  rc.spawn('pm');
  const idleQueue = new MessageQueue();
  rc.pmQueue = idleQueue;
  rc.pmLoop = Promise.resolve();
  rc.setState('pm#1', 'idle', null);
  await rc.createRole({ title: 'Тестировщик' });
  const restartedIdle = rc.pmQueue === null && rc.pmLoop === null;

  const busyQueue = new MessageQueue();
  rc.pmQueue = busyQueue;
  rc.pmLoop = Promise.resolve();
  rc.setState('pm#1', 'thinking', 'думает');
  const busyRole = await rc.createRole({ title: 'Аудитор' });
  const busyId = 'role' in busyRole ? busyRole.role.id : '';
  const keptWhileBusy = rc.pmQueue === busyQueue && rc.pmLoop !== null;
  rc.setState('pm#1', 'idle', null);

  // Правка, не меняющая перечень (цвет), сессию трогать не должна: перезапуск
  // не бесплатный, и дёргать его на каждую мелочь незачем.
  await rc.editRole(busyId, { color: '#111111' });
  const keptOnCosmetics = rc.pmQueue === busyQueue;
  // А переименование — меняет: название роли стоит в описании assign.
  await rc.editRole(busyId, { title: 'Внутренний аудитор' });
  const restartedOnRename = rc.pmQueue === null;
  rc.pmQueue = null;
  rc.pmLoop = null;
  results.push(
    `свободный менеджер перезапущен сразу: ${restartedIdle}`,
    `занятого менеджера не оборвали на полуслове: ${keptWhileBusy}`,
    `правка цвета сессию не перезапускает: ${keptOnCosmetics}`,
    `переименование роли перезапускает: ${restartedOnRename}`,
  );

  // Набор ролей переживает перезапуск целиком — вместе с архивом и внешностью.
  rc.flush();
  const crudSaved = JSON.parse(readFileSync(crudFile, 'utf8')) as Persisted;
  const savedWriter = (crudSaved.roles ?? []).find((r) => r.id === writerId);
  results.push(
    `архивная роль сохранена на диск: ${savedWriter?.archived === true}`,
    `внешность роли сохранена: ${(crudSaved.roles ?? []).some((r) => r.sprite === LOOKS[1].id)}`,
    `после восстановления архив остался архивом: ${rc.restore()
      && rc.role(writerId)?.archived === true
      && !rc.workerRoles().some((r) => r.id === writerId)}`,
  );
  unloadOfficeState('o-roles-crud');
  wipe(crudFile);
  rmSync(crudDir, { recursive: true, force: true });
  rmSync(notRepoDir, { recursive: true, force: true });
  rmSync(realRepo, { recursive: true, force: true });

  // Менеджера в наборе нельзя ни потерять, ни задвоить: файл состояния правят
  // руками, а офис без PM не с кем разговаривать. Дубль роли по id так же
  // недопустим — половина офиса работала бы по одной роли, половина по другой.
  const pmRolesFile = resolve(tmpdir(), `office-test-roles-pm-${process.pid}.json`);
  const pmRolesDir = resolve(tmpdir(), 'roles-pm-office');
  save(pmRolesFile, () => ({
    version: 1, projectDir: pmRolesDir, taskSeq: 0, tasks: [], chat: [], log: [],
    // Язык в сохранении задан явно: набор ролей ниже русский, и офис,
    // поднявшийся английским, дополнил бы его английским же менеджером.
    instances: [], settings: { ...DEFAULT_SETTINGS, language: 'ru' }, savedAt: Date.now(),
    roles: [
      // PM в файле нет вовсе, зато менеджером объявлен backend — и он же
      // записан дважды, вторым разом с другой моделью.
      { ...defaultRole('backend', 'ru')!, isManager: true },
      { ...defaultRole('backend', 'ru')!, model: 'claude-opus-5' },
      { ...defaultRole('reviewer', 'ru')!, maxTurns: 0 },
    ],
  }));
  flushAll();
  const pmRoles = openOfficeState({
    id: 'o-roles-pm', projectDir: pmRolesDir, stateFile: pmRolesFile,
  }).state;
  results.push(
    `PM вернулся в набор, где его не было: ${pmRoles.role('pm')?.isManager === true
      && pmRoles.role('pm')?.title === defaultRole('pm', 'ru')!.title}`,
    `второй менеджер разжалован: ${pmRoles.role('backend')?.isManager === false
      && pmRoles.roles().filter((r) => r.isManager).length === 1}`,
    `дубль роли по id выкинут: ${pmRoles.roles().filter((r) => r.id === 'backend').length === 1
      && pmRoles.role('backend')?.model === defaultRole('backend', 'ru')!.model}`,
    `испорченный лимит роли из набора не применён: ${pmRoles.role('reviewer')?.maxTurns == null}`,
    `PM в наборе один и первый: ${pmRoles.roles()[0]?.id === 'pm'}`,
  );
  unloadOfficeState('o-roles-pm');
  wipe(pmRolesFile);

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
  // Новый офис заводится не по classic — выбираем его явно: этот раздел
  // проверяет именно старую раскладку.
  oc.updateSettings({ layoutId: 'classic' });
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
    // Ещё один такой же: роль заведётся, а сажать некуда — офис откажет по
    // столам своей раскладки.
    const refusal = oc.hireCopy('backend') ?? '';
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

  // 10б. Смена раскладки на лету на уже набранном штате: офис жил на classic и
  // переезжает в studio, где мест столько же. Ломается тут первым делом одно из
  // двух — либо столы остаются от прежней раскладки (человечки сидят в воздухе),
  // либо кто-то пропадает из штата. Дальше по разделу — стол PM в новой
  // раскладке и раскладки, в которые штат уже не влезает.
  const moveFile = resolve(tmpdir(), `office-test-move-${process.pid}.json`);
  const om = openOfficeState({
    id: 'o-lay-move', projectDir: resolve(tmpdir(), 'lay-move'), stateFile: moveFile,
  }).state;
  om.seed();
  const beforeMove = [...om.instances.values()].map((i) => [i.id, i.desk.index] as const);
  const movedIds = new Set<string>();
  let layoutEventsOnSwitch = 0;
  const stopMove = om.subscribe((e) => {
    if (e.t === 'instance') movedIds.add(e.instance.id);
    if (e.t === 'layout') layoutEventsOnSwitch += 1;
  });
  const moveAccepted = om.updateSettings({ layoutId: 'studio' }) === null;
  const afterMove = [...om.instances.values()];
  // Место человека обязано совпасть со столом того же индекса в studio: это и
  // есть «столы пересчитались по новой раскладке», а не по прежней.
  const atNewDesks = afterMove.every((i) => {
    const desk = studioPlan.desks[i.desk.index];
    return !!desk && i.desk.x === desk.x && i.desk.y === desk.y;
  });
  const nobodyLost = afterMove.length === beforeMove.length
    && beforeMove.every(([id]) => afterMove.some((i) => i.id === id));
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
    `смена раскладки принята: ${moveAccepted}`,
    `после смены все сидят за столами новой раскладки: ${afterMove.length > 0 && atNewDesks}`,
    `при смене раскладки никто не потерялся: ${nobodyLost}`,
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
    const notice = om.chat.slice(chatBefore).find((c) => isOfficeSender(c.from) && /без стола/i.test(c.text));
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
    unloadOfficeState('o-lay-move');
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
  // Правки ниже написаны по столам classic — переводим офис на него явно.
  oo.updateSettings({ layoutId: 'classic' });
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

  // Оверрайд принадлежит офису, а не пресету: сосед на том же classic обязан
  // видеть голый пресет и хранить свою пустую расстановку. Ломается тут кэш
  // раскладок — он один на процесс, и вариант с чужой правкой не должен
  // доставаться офису, который ничего не двигал.
  const ovNextFile = resolve(tmpdir(), `office-test-ov2-${process.pid}.json`);
  const onext = openOfficeState({
    id: 'o-ov2', projectDir: resolve(tmpdir(), 'ov-office-2'), stateFile: ovNextFile,
  }).state;
  onext.updateSettings({ layoutId: 'classic' });
  const nextDesk = deskPlan(onext.settings.layoutId, onext.override()).desks[movedIndex];
  onext.flush();
  const nextSaved = JSON.parse(readFileSync(ovNextFile, 'utf8')) as {
    layoutOverrides?: Record<string, unknown>;
  };
  results.push(
    `у соседнего офиса на том же пресете расстановка своя: ${onext.override() === null
      && nextDesk.x === presetPlan.desks[movedIndex].x
      && nextDesk.y === presetPlan.desks[movedIndex].y}`,
    `в сохранении соседа чужого оверрайда нет: ${
      Object.keys(nextSaved.layoutOverrides ?? {}).length === 0}`,
    `правка первого офиса от этого не пропала: ${
      deskPlan('classic', oo.override()).desks[movedIndex].x === 7}`,
  );
  unloadOfficeState('o-ov2');
  wipe(ovNextFile);
  unloadOfficeState('o-ov');
  wipe(ovFile);

  // 12. Раскладка как контракт с клиентом (§8): команды правки и сброса ходят
  // через те же методы, что дёргает index.ts на layout_edit/layout_reset.
  // Проверяем ровно то, что видит веб: событие при изменении, снапшот при
  // подключении и отказ по-русски вместо испорченной расстановки.
  const cmdFile = resolve(tmpdir(), `office-test-cmd-${process.pid}.json`);
  const olc = openOfficeState({
    id: 'o-cmd', projectDir: resolve(tmpdir(), 'cmd-office'), stateFile: cmdFile,
  }).state;
  // Ключи и координаты ниже — из classic: выбираем его явно.
  olc.updateSettings({ layoutId: 'classic' });
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
  // Роль другая: сотрудник в роли один, и вторая задача бэкенду ждала бы не
  // слота, а его самого — проверялось бы уже не то.
  const nextTask = ca.createTask({
    title: 'следом за первой', description: '', criteria: [], roleId: 'frontend',
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

  // 15. Сжатие памяти менеджера по порогу контекста. Настоящей сессии нет:
  // очередь с циклом подставлены, проверяется решение о сжатии, команда
  // /compact, буфер сообщений на это время, что остаётся после, а также
  // запасной путь через передачу дел, когда границы сжатия не пришло.
  const rotFile = resolve(tmpdir(), `office-test-pm-rot-${process.pid}.json`);
  const pr = openOfficeState({ id: 'o-pm-rot', projectDir: resolve(tmpdir(), 'pm-rot'), stateFile: rotFile }).state;
  pr.seed();
  const rq = new MessageQueue();
  pr.pmQueue = rq;
  pr.pmLoop = Promise.resolve();
  const ir = rq[Symbol.asyncIterator]();
  pr.setSessionId('pm#1', 'sess-old');
  pr.noteContext('pm#1', 50_000);
  const underLimit = !pmNeedsRotation(pr);
  pr.noteContext('pm#1', 120_000);
  const overLimit = pmNeedsRotation(pr);
  // Порог из правленого файла или с клиента: мусор не принимается, а
  // поднятый порог откладывает ротацию.
  pr.updateSettings({ pmContextLimit: 5 });
  const junkLimitIgnored = pr.pmContextLimit() === DEFAULT_PM_CONTEXT_LIMIT;
  pr.updateSettings({ pmContextLimit: 200_000 });
  const raisedDefers = !pmNeedsRotation(pr);
  pr.updateSettings({ pmContextLimit: 100_000 });
  // Окно автосжатия исполнителя: ниже минимума SDK не принимается.
  pr.updateSettings({ workerContextLimit: 50_000 });
  const junkWorkerLimitIgnored = pr.workerContextLimit() === DEFAULT_WORKER_CONTEXT_LIMIT;
  pr.updateSettings({ workerContextLimit: 150_000 });
  const workerLimitKept = pr.workerContextLimit() === 150_000 && pr.toPersisted().settings.workerContextLimit === 150_000;
  const contextShown = pr.instanceView(pr.instances.get('pm#1')!).contextTokens === 120_000;

  compactPm(pr);
  const askedCompact = await took(ir);
  const askedCompaction = pr.pmRotating && pr.pmRotationKind === 'compact' && askedCompact !== null
    && askedCompact.startsWith('/compact ') && askedCompact.includes('журнале офиса');
  // Пока сессия ужимает память, сообщения копятся, а не уходят в очередь.
  sendUserMessage(pr, 'а это подождёт');
  tellPm(pr, '[СИСТЕМА] отчёт во время сжатия');
  // В очередь не заглядываем: незакрытый took съел бы следующее сообщение.
  const bufferedCompact = pr.pmPending.length === 2;
  // Граница сжатия пришла: сессия живёт дальше, контекст — по границе,
  // накопленное возвращается в ту же очередь.
  pr.pmCompactedTo = 30_000;
  pr.noteContext('pm#1', 30_000);
  const afterCompact = completePmCompaction(pr, null);
  const pmC = pr.instances.get('pm#1');
  const compacted = !pr.pmRotating && pr.pmQueue === rq && pmC?.sessionId === 'sess-old'
    && pmC?.contextTokens === 30_000 && afterCompact.length === 2
    && afterCompact[0].text === 'а это подождёт' && pr.pmPending.length === 0 && !pmNeedsRotation(pr);
  const noticedCompact = pr.chat.some((c) => isOfficeSender(c.from) && c.text.includes('Память менеджера ужата'));

  // Границы не было — сжатие не удалось, и офис идёт запасным путём:
  // просит передачу дел; накопленное продолжает ждать.
  pr.noteContext('pm#1', 120_000);
  compactPm(pr);
  await took(ir);
  sendUserMessage(pr, 'и это тоже');
  const fallbackPending = completePmCompaction(pr, 'сессия сломалась');
  const asked = await took(ir);
  const askedHandoff = fallbackPending.length === 0 && pr.pmRotating && pr.pmRotationKind === 'handoff'
    && asked !== null && asked.startsWith('[СИСТЕМА]') && asked.includes('передачу дел')
    && pr.log.some((e) => e.agentId === 'pm#1' && e.kind === 'error' && e.text.includes('сессия сломалась'));
  // Пока менеджер пишет передачу, сообщения копятся, а не уходят в очередь.
  tellPm(pr, '[СИСТЕМА] отчёт во время ротации');
  const buffered = pr.pmPending.length === 2 && pr.pmPending[0].fromUser === true
    && pr.pmPending[1].fromUser === false && (await took(ir)) === null;
  const pending = completePmRotation(pr, 'Обсуждаем заметки; жду «поехали» по фиче E-1.');
  const pm = pr.instances.get('pm#1');
  const rotated = !pr.pmRotating && pr.pmQueue === null && pr.pmLoop === null
    && pm?.sessionId === '' && pm?.contextTokens === 0 && (await ir.next()).done === true;
  const handoffKept = pr.pmHandoff?.includes('E-1') === true && pr.toPersisted().pmHandoff?.includes('E-1') === true;
  const pendingReturned = pending.length === 2 && pending[0].text === 'и это тоже' && pr.pmPending.length === 0;
  const noticed = pr.chat.some((c) => isOfficeSender(c.from) && c.text.includes('Сессия менеджера обновлена'));
  pr.hardReset();
  const resetForgets = pr.pmHandoff === null && pr.instances.get('pm#1')?.contextTokens === 0;
  results.push(
    `до порога ротация не нужна: ${underLimit}`,
    `за порогом — нужна: ${overLimit}`,
    `мусорный порог не принимается: ${junkLimitIgnored}`,
    `окно исполнителя ниже минимума SDK не принимается: ${junkWorkerLimitIgnored}`,
    `окно исполнителя сохраняется: ${workerLimitKept}`,
    `поднятый порог откладывает ротацию: ${raisedDefers}`,
    `размер контекста виден в карточке: ${contextShown}`,
    `по порогу в очередь уходит /compact с наказом: ${askedCompaction}`,
    `на время сжатия сообщения копятся: ${bufferedCompact}`,
    `после сжатия сессия та же, контекст по границе, накопленное вернулось: ${compacted}`,
    `пользователю сказали о сжатии: ${noticedCompact}`,
    `без границы сжатия — запасной путь через передачу дел: ${askedHandoff}`,
    `на время ротации сообщения копятся: ${buffered}`,
    `после ротации сессия закрыта и забыта: ${rotated}`,
    `передача дел сохранена: ${handoffKept}`,
    `накопленное возвращается для новой сессии: ${pendingReturned}`,
    `пользователю сказали об обновлении сессии: ${noticed}`,
    `полный сброс забывает передачу дел: ${resetForgets}`,
  );
  unloadOfficeState('o-pm-rot');
  wipe(rotFile);

  // 16. Мёртвое окружение. Пока критичная предполётная проверка красная, ни
  // одна задача не выполнима, и запускать её — значит платить за
  // гарантированный провал. Проверяется решение «держать или пускать»: сессий
  // здесь нет, запуск заменяет dryRun.
  const envFile = resolve(tmpdir(), `office-test-env-${process.pid}.json`);
  const prevEnvDelay = process.env.OFFICE_DRY_RUN_DELAY;
  process.env.OFFICE_DRY_RUN_DELAY = '5000';
  // Директории намеренно нет: это самая честная красная критичная проверка —
  // такую же офис увидит, когда рабочую папку унесут у него из-под ног.
  const eo = openOfficeState({
    id: 'o-env',
    projectDir: resolve(tmpdir(), `office-test-env-gone-${process.pid}`),
    stateFile: envFile,
  }).state;
  eo.seed();
  eo.dryRun = true;

  // (а) Пропавшая рабочая директория критична: без неё не выполнима ни одна
  // задача, а не «одна роль пострадала».
  await refreshEnvChecks(eo);
  const workdirCritical = criticalEnvFail(eo.env.checks)?.id === 'workdir';

  // (б) Раздача отказывает: задача остаётся в бэклоге без исполнителя, с
  // причиной ожидания и без единой поднятой сессии.
  const envTask = eo.createTask({
    title: 'ждёт окружения', description: '', criteria: [], roleId: 'backend',
  });
  const envRefused = officeAssign(eo, envTask.id);
  const envHeld = !envRefused.ok && eo.tasks.get(envTask.id)?.status === 'backlog'
    && eo.tasks.get(envTask.id)?.assigneeId === null && eo.running === 0;
  const envReasonShown = eo.tasks.get(envTask.id)?.envWait?.includes('Рабочая директория') === true;
  const envToldWhy = eo.chat.some((c) => c.text.includes(envTask.id) && /ждёт окружения/.test(c.text));
  // Раздачу дёргает надзор каждый проход — одно и то же в ленту не пишем.
  const envChatBefore = eo.chat.length;
  officeAssign(eo, envTask.id);
  const envNoSpam = eo.chat.length === envChatBefore;

  // (в) Окружение починили мимо офиса — очередь обязана поехать сама, без
  // «нажмите ещё раз».
  eo.setEnv(eo.env.checks.map((ch) => ({ ...ch, status: 'ok' as const, fix: '' })));
  await new Promise((r) => setTimeout(r, 30));
  const envStartedAfterFix = eo.tasks.get(envTask.id)?.status === 'in_progress'
    && eo.tasks.get(envTask.id)?.envWait === null;

  results.push(
    `пропавшая рабочая директория считается критичной: ${workdirCritical}`,
    `на красном окружении задача остаётся в бэклоге и не тратит денег: ${envHeld}`,
    `причина ожидания записана в задаче: ${envReasonShown}`,
    `в ленте объяснено, чего задача ждёт: ${envToldWhy}`,
    `повторная раздача не засоряет ленту: ${envNoSpam}`,
    `после позеленения проверки задача пошла в работу сама: ${envStartedAfterFix}`,
  );
  if (prevEnvDelay === undefined) delete process.env.OFFICE_DRY_RUN_DELAY;
  else process.env.OFFICE_DRY_RUN_DELAY = prevEnvDelay;
  wipe(envFile);

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

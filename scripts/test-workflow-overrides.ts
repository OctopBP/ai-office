/**
 * Правки процесса офиса (docs/design/workflows/spec.md, «Правки процесса
 * офиса»): сборка действующего процесса, валидатор, история и лента — и
 * настоящий конвейер на временном репозитории с заглушками вместо агентов.
 *
 * Проверяется: выключенный ревью — задача после гейта идёт прямо в слияние;
 * условный пропуск только для задач backend; выключить слияние и гейт нельзя;
 * сброс возвращает базу; идущий прогон доезжает по тому, с чем начинал.
 *
 * Запуск: npm run test:workflow-overrides
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, type Task } from '../src/server/state';
import { runPipeline, setPipelineAgents } from '../src/server/review';
import { builtinWorkflow } from '../src/server/workflows';
import { ROOT } from '../src/server/root';
import {
  disableNode, effectiveWorkflowById, enableNode, overridesOf, resetOverrides,
} from '../src/server/workflow-overrides';
import { applyOverrides, overridesProblem, REQUIRED_RUNS } from '../src/shared/workflow-overrides';
import { nodeOf, type TaskType } from '../src/shared/workflow';

process.env.OFFICE_LANG = 'ru';

const office = getOffice('o-1');

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  const line = `  ${ok ? '✅' : '❌'} ${what}: ${ok}`;
  results.push(line);
  console.log(line);
};
const say = (text: string) => { results.push(text); console.log(text); };

const git = (dir: string, ...args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
};

/** Репозиторий с main; проверки проекта — `npm run typecheck`, всегда зелёные. */
function fixture(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'office-wfo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'office@local');
  git(dir, 'config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { typecheck: 'node -e 0' } }));
  writeFileSync(resolve(dir, '.gitignore'), '.office/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'Начало');
  return dir;
}

/** Ветка задачи с готовой работой — как её оставляет исполнитель. */
function taskBranch(dir: string, name: string, roleId: string, type: TaskType = 'code'): Task {
  const task = office.createTask({
    title: `Задача ${name}`, description: 'тестовая', criteria: ['готово'], roleId, type,
  });
  git(dir, 'checkout', '-q', '-b', `task/${task.id}`, 'main');
  writeFileSync(resolve(dir, `${name}.txt`), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `${task.id}: работа`);
  git(dir, 'checkout', '-q', 'main');
  office.updateTask(task.id, {
    status: 'review', branch: `task/${task.id}`, baseBranch: 'main',
    repoDir: dir, worktreePath: null, result: 'сделано',
    handoff: { did: 'сделано', assumed: 'ничего', left: 'ничего' },
  });
  return office.tasks.get(task.id) as Task;
}

/** Заглушки агентов: ревьюер одобряет и считает вызовы. */
function stub(): { reviews: number } {
  const calls = { reviews: 0 };
  setPipelineAgents({
    async review() {
      calls.reviews += 1;
      return { verdict: 'approve', text: 'Замечаний нет.', reviewerId: 'reviewer#1' };
    },
    async rework() { return { ok: true, message: 'ничего не потребовалось' }; },
    notifyPm() { /* менеджер здесь не нужен */ },
  });
  return calls;
}

/** Узлы, которые прогон задачи прошёл, по порядку. */
const path = (taskId: string): string[] => (office.runOf(taskId)?.steps ?? []).map((s) => s.node);
const logHas = (part: string): boolean => office.log.some((l) => l.text.includes(part));

async function main(): Promise<void> {
  office.setStateFile(resolve(tmpdir(), `office-wfo-state-${process.pid}.json`));
  const dir = fixture();
  process.chdir(dir);
  office.seed();
  office.projectDir = dir;
  office.settings.autoPipeline = true;
  const feature = builtinWorkflow('feature');
  const fileBefore = readFileSync(resolve(ROOT, 'workflows', 'feature.json'), 'utf8');

  // ---------- сборка без офиса ----------
  say('▶ Сборка: выключенный ревью вынимается вместе с доработкой');
  {
    const wf = applyOverrides(feature, [{ node: 'review' }]);
    check('узла review нет', !nodeOf(wf, 'review'));
    check('доработка по отзыву выпала: её некому вызвать', !nodeOf(wf, 'rework'));
    check('открытие PR ведёт сразу к пересинхронизации', nodeOf(wf, 'open-pr')?.next.pass.to === 'resync');
    check('слияние и проверки на месте', !!nodeOf(wf, 'merge') && !!nodeOf(wf, 'recheck'));
    check('база не тронута', !!nodeOf(feature, 'review'));
    const first = applyOverrides(feature, [{ node: 'sync' }]);
    check('выключенный первый узел — процесс начинается со следующего', first.nodes[0].id === 'checks');
    const cond = [{ node: 'review', when: { roles: ['backend'] } }];
    check('условная правка без задачи не действует', !!nodeOf(applyOverrides(feature, cond), 'review'));
    check('условная правка для backend действует', !nodeOf(applyOverrides(feature, cond, { roleId: 'backend' }), 'review'));
    check('условная правка для frontend не действует', !!nodeOf(applyOverrides(feature, cond, { roleId: 'frontend' }), 'review'));
    check('тип и зона складываются через «и»', !!nodeOf(applyOverrides(feature,
      [{ node: 'review', when: { types: ['code'], zones: ['web'] } }], { type: 'code', zone: 'server' }), 'review'));
  }

  say('▶ Валидатор');
  {
    check('обязательные узлы перечислены явно', REQUIRED_RUNS.includes('office:merge') && REQUIRED_RUNS.includes('office:checks'));
    check('merge выключить нельзя', (overridesProblem(feature, [{ node: 'merge' }]) ?? '').includes('обязательный'));
    check('гейт с проверками выключить нельзя', (overridesProblem(feature, [{ node: 'recheck' }]) ?? '').includes('обязательный'));
    check('и по условию тоже', (overridesProblem(feature, [{ node: 'merge', when: { roles: ['backend'] } }]) ?? '').includes('обязательный'));
    check('неизвестный узел — понятная ошибка', (overridesProblem(feature, [{ node: 'nope' }]) ?? '').includes('нет узла «nope»'));
    check('исход обхода должен существовать', (overridesProblem(feature, [{ node: 'review', outcome: 'zzz' }]) ?? '').includes('нет исхода'));
    check('пустое условие отклоняется', (overridesProblem(feature, [{ node: 'review', when: {} }]) ?? '').includes('пустое условие'));
    check('выключенный ревью — годный набор', overridesProblem(feature, [{ node: 'review' }]) === null);
    // Синхронизация перед слиянием обходит его в «stuck»: без пути до конца.
    check('правка, после которой нет пути до конца, отклоняется',
      overridesProblem(feature, [{ node: 'open-pr', outcome: 'fail' }]) !== null);
  }

  // ---------- офис ----------
  say('▶ Офис: правки отклоняются понятно и не пишутся');
  {
    const merge = disableNode(office, { workflowId: 'feature', node: 'merge', why: 'хочу быстрее' });
    check('попытка выключить merge отклонена', !merge.ok && merge.message.includes('обязательный'));
    const unknownWf = disableNode(office, { workflowId: 'nope', node: 'review', why: 'x' });
    check('неизвестный процесс — понятная ошибка', !unknownWf.ok && unknownWf.message.includes('процесса «nope» нет'));
    const noWhy = disableNode(office, { workflowId: 'feature', node: 'review', why: ' ' });
    check('без причины правка не принимается', !noWhy.ok);
    const badType = disableNode(office, { workflowId: 'feature', node: 'review', why: 'x', when: { types: ['nope' as TaskType] } });
    check('неизвестный тип задачи в условии отклонён', !badType.ok && badType.message.includes('неизвестный тип'));
    check('ни одна отклонённая правка не записана', overridesOf(office, 'feature').rev === 0);
  }

  say('▶ Выключенный ревью: после гейта задача идёт прямо в слияние');
  {
    const res = disableNode(office, { workflowId: 'feature', node: 'review', why: 'ревьюер в отпуске', by: 'owner' });
    check('правка принята', res.ok);
    const set = overridesOf(office, 'feature');
    check('правка в состоянии офиса', set.rules.length === 1 && set.rules[0].node === 'review');
    check('история: кто, когда, почему', set.history.length === 1 && set.history[0].by === 'owner'
      && set.history[0].why === 'ревьюер в отпуске' && set.history[0].at > 0 && set.history[0].action === 'disable');
    check('событие в ленте с причиной', logHas('узел «review» выключен') && logHas('ревьюер в отпуске'));
    check('правки уходят в сохранение', (office.toPersisted().workflowOverrides ?? []).some((s) => s.workflowId === 'feature'));
    check('файл workflows/feature.json не тронут',
      readFileSync(resolve(ROOT, 'workflows', 'feature.json'), 'utf8') === fileBefore);

    const calls = stub();
    const task = taskBranch(dir, 'a', 'backend');
    await runPipeline(office, task.id);
    const steps = path(task.id);
    check('задача влита', office.tasks.get(task.id)?.merged === true && existsSync(resolve(dir, 'a.txt')));
    check('ревьюера не звали', calls.reviews === 0 && !steps.includes('review'));
    check('после гейта проверок — сразу слияние', steps.slice(-2).join('>') === 'recheck>merge');
    check('прогон запомнил действующий процесс', !!office.runOf(task.id)?.plan && !nodeOf(office.runOf(task.id)!.plan!, 'review'));
  }

  say('▶ Идущая задача доезжает по процессу, с которым начинала');
  {
    // Ревью выключено на старте; посреди пути правки сбрасывают.
    const calls = stub();
    const task = taskBranch(dir, 'b', 'backend');
    let fired = false;
    const off = office.subscribe((e) => {
      if (fired || e.t !== 'run' || e.run.subject.taskId !== task.id || e.run.nodeId !== 'open-pr') return;
      fired = true;
      resetOverrides(office, { workflowId: 'feature', why: 'посреди пути' });
    });
    await runPipeline(office, task.id);
    off();
    check('сброс случился посреди прогона', fired && overridesOf(office, 'feature').rules.length === 0);
    check('задача доехала без ревью, как начинала', calls.reviews === 0 && office.tasks.get(task.id)?.merged === true);

    // И наоборот: начинала по базе, посреди пути ревью выключили — ревью будет.
    const calls2 = stub();
    const task2 = taskBranch(dir, 'c', 'backend');
    let fired2 = false;
    const off2 = office.subscribe((e) => {
      if (fired2 || e.t !== 'run' || e.run.subject.taskId !== task2.id || e.run.nodeId !== 'open-pr') return;
      fired2 = true;
      disableNode(office, { workflowId: 'feature', node: 'review', why: 'посреди пути' });
    });
    await runPipeline(office, task2.id);
    off2();
    check('начатая по базе задача прошла ревью', fired2 && calls2.reviews === 1 && path(task2.id).includes('review'));
    check('у неё нет снимка — она шла по базе', !office.runOf(task2.id)?.plan);
    resetOverrides(office, { workflowId: 'feature', why: 'к следующей проверке' });
  }

  say('▶ Условный пропуск: ревью пропускается только у задач backend');
  {
    const res = disableNode(office, {
      workflowId: 'feature', node: 'review', when: { roles: ['backend'] }, why: 'бэкенд проверяют тесты',
    });
    check('условная правка принята', res.ok && logHas('роль: backend'));
    const calls = stub();
    const back = taskBranch(dir, 'd', 'backend');
    await runPipeline(office, back.id);
    check('backend: без ревью и влита', !path(back.id).includes('review') && office.tasks.get(back.id)?.merged === true);
    const front = taskBranch(dir, 'e', 'frontend');
    await runPipeline(office, front.id);
    check('frontend: ревью было и влита', path(front.id).includes('review') && office.tasks.get(front.id)?.merged === true);
    check('ревьюера звали ровно раз', calls.reviews === 1);
    check('без задачи условная правка не действует', !!nodeOf(effectiveWorkflowById(office, 'feature')!, 'review'));
  }

  say('▶ Включить обратно и сброс');
  {
    const on = enableNode(office, { workflowId: 'feature', node: 'review', why: 'вернули ревью' });
    check('узел включён обратно, событие в ленте', on.ok && logHas('узел «review» включён обратно'));
    check('включать невыключенное — отказ', !enableNode(office, { workflowId: 'feature', node: 'review', why: 'x' }).ok);
    disableNode(office, { workflowId: 'feature', node: 'review', why: 'снова без ревью' });
    disableNode(office, { workflowId: 'feature', node: 'sync', why: 'и без первой синхронизации' });
    check('две правки действуют', overridesOf(office, 'feature').rules.length === 2);
    const reset = resetOverrides(office, { workflowId: 'feature', why: 'вернуть как было' });
    check('сброс принят, событие с причиной', reset.ok && logHas('правки офиса сброшены') && logHas('вернуть как было'));
    const eff = effectiveWorkflowById(office, 'feature')!;
    check('после сброса процесс — база', eff === feature);
    const set = overridesOf(office, 'feature');
    check('история сохранилась вместе со сбросом', set.history.at(-1)?.action === 'reset' && set.history.length >= 7);

    const calls = stub();
    const task = taskBranch(dir, 'f', 'backend');
    await runPipeline(office, task.id);
    check('после сброса задача снова идёт через ревью', calls.reviews === 1 && path(task.id).includes('review'));
  }

  const failed = results.filter((r) => r.includes('❌'));
  rmSync(dir, { recursive: true, force: true });
  office.wipe();
  if (failed.length) {
    console.error(`\nПровалено проверок: ${failed.length}`);
    process.exit(1);
  }
  console.log(`\nВсе проверки прошли: ${results.filter((r) => r.includes('✅')).length}`);
}

void main();

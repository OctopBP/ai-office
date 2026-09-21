/**
 * Процессы (docs/design/workflows/spec.md): разбор файла процесса, встроенные
 * процессы офиса и раннер — без git и без агентов. Действия узлов здесь
 * подставные: проверяется, что раннер ходит по переходам, считает петли и
 * сбрасывает счётчики так, как обещает спека.
 *
 * Запуск: npm run test:workflow
 */
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  edgeKey, loopBodies, loopMax, parseWorkflow, workflowStats, type Workflow,
} from '../src/shared/workflow';
import {
  builtinWorkflow, builtinWorkflows, resetProjectWorkflow, saveProjectWorkflow, workflowCatalog, workflowFor,
} from '../src/server/workflows';
import { drive, newRun, resumeRun, type Executor, type Halt, type RunHooks } from '../src/server/runs';
import { getOffice } from '../src/server/state';

process.env.OFFICE_LANG = 'ru';

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  const line = `  ${ok ? '✅' : '❌'} ${what}: ${ok}`;
  results.push(line);
  console.log(line);
};
const say = (text: string) => { results.push(text); console.log(text); };

/** Ошибка разбора текстом; null — разобралось. */
function problem(data: unknown): string | null {
  try {
    parseWorkflow(data, 'test');
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

const node = (id: string, next: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id, kind: 'check', run: `t:${id}`, next, ...extra });
const wf = (nodes: unknown[]) => ({ id: 'toy', version: 1, trigger: { on: 'manual' }, nodes });

interface Ctx { node: string }

async function main(): Promise<void> {
  // ---------- встроенные процессы ----------
  say('▶ Встроенные процессы читаются и сходятся с кодом');
  const all = builtinWorkflows();
  check('процесс feature есть', all.has('feature'));
  const feature = builtinWorkflow('feature');
  check('он начинается с подтягивания базы', feature.nodes[0].id === 'sync');
  check('и запускается сдачей задачи', feature.trigger.on === 'task.finished');
  check('ревьюер возвращает не больше двух раз', loopMax(feature, 'office:review', 'changes') === 2);
  check('у каждого узла есть действие', feature.nodes.every((n) => Boolean(n.run)));

  const bodies = loopBodies(feature);
  const rounds = bodies.get(edgeKey('review', 'rework')) as Set<string>;
  const fixes = bodies.get(edgeKey('checks', 'fix-checks')) as Set<string>;
  check('круг ревью проходит через открытие PR', rounds.has('open-pr'));
  check('и через сам узел ревью', rounds.has('review'));
  check('но не через починку проверок', !rounds.has('fix-checks'));
  check('петля проверок не включает подтягивание базы', !fixes.has('sync'));

  // ---------- разбор ----------
  say('▶ Ошибки в файле процесса не проглатываются');
  check('переход в несуществующий узел', (problem(wf([
    node('a', { pass: 'b' }),
  ])) ?? '').includes('такого узла нет'));
  check('узел объявлен дважды', (problem(wf([
    node('a', { pass: 'end' }), node('a', { pass: 'end' }),
  ])) ?? '').includes('дважды'));
  check('круг без предела', (problem(wf([
    node('a', { pass: 'b' }), node('b', { pass: 'a' }),
  ])) ?? '').includes('предела'));
  check('круг с пределом допустим', problem(wf([
    node('a', { pass: 'b' }), node('b', { pass: 'end', fail: { to: 'a', max: 1 } }),
  ])) === null);
  check('вложенные круги: хватает одного предела на каждый', problem(wf([
    node('a', { pass: 'b' }),
    node('b', { pass: 'c', fail: { to: 'fix', max: 1 } }),
    node('fix', { done: 'b' }),
    node('c', { ok: 'end', back: { to: 'a', max: 2 } }),
  ])) === null);
  check('артефакт, которого никто не производит', (problem(wf([
    node('a', { pass: 'end' }, { in: ['x'] }),
  ])) ?? '').includes('никто не производит'));
  check('служебное имя узла', (problem(wf([
    node('end', { pass: 'end' }),
  ])) ?? '').includes('служебное'));
  check('лишний ключ — ошибка', problem(wf([
    node('a', { pass: 'end' }, { colour: 'red' }),
  ])) !== null);

  // ---------- раннер ----------
  const office = getOffice('o-wf');
  office.setStateFile(resolve(tmpdir(), `office-wf-state-${process.pid}.json`));
  office.seed();

  // Тот же рисунок, что у feature: внутренняя петля починки проверок и
  // внешняя петля доработки по ревью.
  const toy: Workflow = parseWorkflow(wf([
    node('sync', { pass: 'checks' }),
    node('checks', { pass: 'review', fail: { to: 'fix', max: 1 } }, { out: 'checks' }),
    node('fix', { done: 'checks', failed: 'stuck' }, { in: ['checks'] }),
    node('review', { approve: 'end', changes: { to: 'rework', max: 2 } }),
    node('rework', { done: 'sync' }),
  ]), 'toy');

  const calls: Record<string, number> = {};
  const seenOutputs: string[] = [];
  const halts: Halt[] = [];
  let checksFailsPerVisit = 1;
  let verdicts: string[] = ['changes', 'changes', 'changes'];
  let fixOk = true;

  const hooks: RunHooks<Ctx> = {
    context: (n) => ({ node: n.id }),
    stuck: (_ctx, halt) => { halts.push(halt); },
  };
  const count = (id: string) => { calls[id] = (calls[id] ?? 0) + 1; };
  const pick = (n: { run?: string }) => executors[n.run ?? ''];
  let failsThisVisit = 0;
  const executors: Record<string, Executor<Ctx>> = {
    't:sync': { async run() { count('sync'); return { outcome: 'pass' }; } },
    't:checks': {
      async run() {
        count('checks');
        if (failsThisVisit < checksFailsPerVisit) {
          failsThisVisit += 1;
          return { outcome: 'fail', note: 'сломано', artifact: { kind: 'checks', text: `вывод ${calls.checks}` } };
        }
        failsThisVisit = 0;
        return { outcome: 'pass' };
      },
    },
    't:fix': {
      async run(ctx) {
        count('fix');
        seenOutputs.push(run.artifacts.checks?.text ?? '');
        return fixOk ? { outcome: 'done' } : { outcome: 'failed', note: `не смог в ${ctx.node}`, needsDecision: true };
      },
    },
    't:review': {
      async run() {
        count('review');
        return { outcome: verdicts.shift() ?? 'approve' };
      },
      exhausted(_ctx, _last, n) {
        return { note: `вернул ${n} раз`, needsDecision: true };
      },
    },
    't:rework': { async run() { count('rework'); return { outcome: 'done' }; } },
  };

  say('▶ Петли считаются так, как обещает спека');
  const run = newRun(toy, { taskId: 'T-1' });
  await drive(office, toy, run, pick, hooks);
  check('прогон встал', run.status === 'stuck');
  check('ревью было три раза', calls.review === 3);
  check('доработок — две', calls.rework === 2);
  check('проверки чинили в каждом круге заново', calls.fix === 3);
  check('счётчик кругов ревью — три', run.loops[edgeKey('review', 'rework')] === 3);
  check('остановку объяснило действие ревью', halts[0]?.note === 'вернул 3 раз' && halts[0]?.needsDecision === true);
  check('починка читала артефакт проверок', seenOutputs[0] === 'вывод 1' && seenOutputs[2] === 'вывод 5');
  check('прогон сохранён в офисе', office.runOf('T-1')?.id === run.id);
  check('и попадает в сохранение', office.toPersisted().runs?.some((r) => r.id === run.id) === true);

  say('▶ Перезапуск продолжает с того же узла и круги ревью помнит');
  verdicts = ['changes'];
  checksFailsPerVisit = 0;
  resumeRun(run);
  check('стоит на узле ревью', run.nodeId === 'review' && run.status === 'running');
  await drive(office, toy, run, pick, hooks);
  check('четвёртый возврат — сразу остановка', run.status === 'stuck' && calls.rework === 2);
  check('и счётчик показывает четыре', run.loops[edgeKey('review', 'rework')] === 4);
  check('ничего лишнего не переделывали', calls.sync === 3);

  say('▶ Предел без своего объяснения объясняет раннер');
  const run2 = newRun(toy, { taskId: 'T-2' });
  failsThisVisit = 0;
  checksFailsPerVisit = 5;
  verdicts = ['approve'];
  await drive(office, toy, run2, pick, hooks);
  check('после одной починки проверки больше не чинят', run2.status === 'stuck');
  check('причина — предел повторов', halts[halts.length - 1]?.note.includes('предел') === true);

  say('▶ Исход, ведущий в stuck, несёт причину и признак решения');
  const run3 = newRun(toy, { taskId: 'T-3' });
  failsThisVisit = 0;
  checksFailsPerVisit = 1;
  fixOk = false;
  await drive(office, toy, run3, pick, hooks);
  const last = halts[halts.length - 1];
  check('причина от действия', last?.note === 'не смог в fix');
  check('решение нужно', last?.needsDecision === true);
  check('прогон стоит на узле починки', run3.nodeId === 'fix' && run3.status === 'stuck');

  say('▶ Довести до конца');
  const run4 = newRun(toy, { taskId: 'T-4' });
  failsThisVisit = 0;
  fixOk = true;
  checksFailsPerVisit = 0;
  verdicts = ['approve'];
  await drive(office, toy, run4, pick, hooks);
  check('прогон закончен', run4.status === 'done' && run4.nodeId === 'end');

  say('▶ Действие вне процесса — ошибка, а не тихий стоп');
  const run5 = newRun(toy, { taskId: 'T-5' });
  failsThisVisit = 0;
  verdicts = ['maybe'];
  let crashed = '';
  await drive(office, toy, run5, pick, hooks).catch((err) => { crashed = (err as Error).message; });
  check('раннер упал с понятной ошибкой', crashed.includes('maybe'));
  check('прогон помечен вставшим', run5.status === 'stuck');

  // ---------- свои процессы проекта
  say('▶ Свой процесс проекта перекрывает встроенный, сломанный — нет');
  const projectDir = mkdtempSync(resolve(tmpdir(), 'office-wf-project-'));
  const project = { projectDir };
  check('без папки — все встроенные', workflowCatalog(project).every((e) => e.source === 'builtin'));
  const own = JSON.parse(workflowCatalog(project).find((e) => e.id === 'feature')!.text) as {
    version: number; nodes: Array<{ id: string; next: Record<string, { to: string; max?: number }> }>;
  };
  own.version = 2;
  const review = own.nodes.find((n) => n.id === 'review')!;
  review.next.changes = { to: 'rework', max: 3 };
  check('сохранение проходит разбор', saveProjectWorkflow(project, 'feature', JSON.stringify(own)) === null);
  check('офис едет по своему', workflowFor(project, 'feature')?.version === 2
    && loopMax(workflowFor(project, 'feature')!, 'office:review', 'changes') === 3);
  const entry = workflowCatalog(project).find((e) => e.id === 'feature');
  check('в каталоге он свой и перекрывает встроенный', entry?.source === 'project' && entry.overrides === true);
  check('сломанный текст не сохраняется', (saveProjectWorkflow(project, 'feature', '{"id":"feature"}') ?? '').length > 0);
  check('чужой id не сохраняется', (saveProjectWorkflow(project, 'feature', JSON.stringify({ ...own, id: 'other' })) ?? '').includes('id'));
  mkdirSync(resolve(projectDir, 'workflows'), { recursive: true });
  writeFileSync(resolve(projectDir, 'workflows', 'content.json'), '{ not json');
  const broken = workflowCatalog(project).find((e) => e.id === 'content');
  check('сломанный файл виден с ошибкой', Boolean(broken?.problem) && broken?.source === 'builtin');
  check('а офис едет по встроенному', workflowFor(project, 'content')?.id === 'content'
    && workflowFor(project, 'content')?.version === builtinWorkflow('content').version);
  check('сброс возвращает встроенный', resetProjectWorkflow(project, 'feature') === null
    && workflowFor(project, 'feature')?.version === 1);
  rmSync(projectDir, { recursive: true, force: true });

  say('▶ Расход по узлам считается по версии процесса');
  const stats = workflowStats([run, run2, run3, run4]);
  const toyStats = stats.find((s) => s.workflowId === 'toy');
  check('прогоны собраны', toyStats?.runs === 4 && toyStats.done === 1 && toyStats.stuck === 3);
  const reviewNode = toyStats?.nodes.find((n) => n.node === 'review');
  check('у узла — число заходов и исходы', (reviewNode?.runs ?? 0) >= 4
    && (reviewNode?.outcomes.changes ?? 0) >= 4 && reviewNode?.outcomes.approve === 1);
  check('шаги записаны с длительностью', run.steps.length > 0 && run.steps.every((s) => s.ms >= 0 && s.costUsd === 0));

  office.wipe();
  const failed = results.filter((r) => r.includes('❌'));
  if (failed.length) {
    console.error(`\nПровалено проверок: ${failed.length}`);
    process.exit(1);
  }
  console.log(`\nВсе проверки прошли: ${results.filter((r) => r.includes('✅')).length}`);
}

void main();

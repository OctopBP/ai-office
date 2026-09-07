/**
 * Проверки живого офиса (docs/design/living-office/spec.md) без единого
 * токена: исходы задач, откат, табель роли, планёрка. Всё это — чистая
 * логика поверх состояния, и ловить её регрессии сценариями с живой моделью
 * дорого и ненадёжно.
 *
 * Запуск: npm run test:life
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, unloadOfficeState } from '../src/server/state';
import { closeIfDone, detectReverts, mergedKind, recordOutcome } from '../src/server/outcomes';
import { cancelEpic, createPlan, setPlanAgents } from '../src/server/plan';
import { runStandup, standupDue, standupText } from '../src/server/rituals';
import { roleReport } from '../src/shared/report';
import { dayKey } from '../src/shared/types';

// Тексты офиса сверяем по-русски — значит, и офис должен быть русским.
process.env.OFFICE_LANG = 'ru';

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  results.push(`  ${ok ? '✅' : '❌'} ${what}: ${ok}`);
};

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Репозиторий с main и одним коммитом. */
function fixture(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'office-life-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'office@local');
  git(dir, 'config', 'user.name', 'AI Office');
  writeFileSync(resolve(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'Начало');
  return dir;
}

// План раздаём заглушкой: здесь важен исход, а не сессии.
setPlanAgents({
  assign: (state, taskId) => {
    state.updateTask(taskId, { status: 'in_progress', assigneeId: 'stub#1' });
    return { ok: true, message: 'stub#1' };
  },
  notifyPm() { /* менеджера здесь нет */ },
});

async function main(): Promise<void> {
  const office = getOffice('o-life');
  office.seed();
  office.opened = true;
  office.settings.autoPipeline = true;
  office.settings.planApproval = false;

  // ---------- исходы ----------
  console.log('исходы');

  // 1. Сдана без ветки — закрыта чисто.
  const plain = office.createTask({
    title: 'Документ', description: '', criteria: ['есть', 'проверен'], roleId: 'legal',
  });
  office.updateTask(plain.id, { status: 'done', startedAt: Date.now() - 5000, finishedAt: Date.now() });
  office.checkCriterion(plain.id, 1);
  closeIfDone(office, plain.id);
  const plainOut = office.tasks.get(plain.id)?.outcome;
  check('задача без ветки закрывается чисто', plainOut?.kind === 'clean');
  check('исход помнит роль и критерии', plainOut?.roleId === 'legal'
    && plainOut.criteria.total === 2 && plainOut.criteria.claimed === 1);
  check('исход помнит длительность', (plainOut?.durationMs ?? 0) >= 5000);
  check('исход виден в виде задачи', office.snapshot().t === 'snapshot'
    && (office.snapshot() as { tasks: Array<{ outcome: unknown }> }).tasks
      .some((t) => (t.outcome as { kind?: string } | null)?.kind === 'clean'));

  // 2. Второй исход поверх первого не пишется.
  check('повторный исход не перекрывает первый',
    recordOutcome(office, plain.id, 'failed') === null
    && office.tasks.get(plain.id)?.outcome?.kind === 'clean');

  // 3. Влита после возврата ревьюера — «с доработкой», после остановки — «вставала».
  const reworked = office.createTask({
    title: 'API', description: '', criteria: ['роуты'], roleId: 'backend',
  });
  office.updateTask(reworked.id, { branch: `task/${reworked.id}`, baseBranch: 'main', status: 'review' });
  office.startPr({ taskId: reworked.id, title: 'API', branch: `task/${reworked.id}`, base: 'main', repoDir: '/tmp' });
  office.patchPr(reworked.id, { rounds: 2, stuckTimes: 1 });
  check('возврат ревьюера весомее остановки', mergedKind(office, office.tasks.get(reworked.id)!) === 'reworked');
  office.updateTask(reworked.id, { status: 'done', merged: true });
  recordOutcome(office, reworked.id, mergedKind(office, office.tasks.get(reworked.id)!));
  const reworkedOut = office.tasks.get(reworked.id)?.outcome;
  check('исход «с доработкой» помнит круги и остановки',
    reworkedOut?.kind === 'reworked' && reworkedOut.reworks === 2 && reworkedOut.stuck === 1);

  const stuckTask = office.createTask({
    title: 'Экран', description: '', criteria: ['экран'], roleId: 'frontend',
  });
  office.startPr({ taskId: stuckTask.id, title: 'Экран', branch: `task/${stuckTask.id}`, base: 'main', repoDir: '/tmp' });
  office.patchPr(stuckTask.id, { stuckTimes: 2 });
  office.updateTask(stuckTask.id, { status: 'done', merged: true, branch: `task/${stuckTask.id}` });
  closeIfDone(office, stuckTask.id);
  check('влитая после остановок — «вставала»', office.tasks.get(stuckTask.id)?.outcome?.kind === 'stuck');

  // 4. Провал.
  const failed = office.createTask({
    title: 'Провал', description: '', criteria: ['x'], roleId: 'backend',
  });
  office.updateTask(failed.id, { status: 'failed' });
  recordOutcome(office, failed.id, 'failed');
  check('провал записан', office.tasks.get(failed.id)?.outcome?.kind === 'failed');

  // 5. Снятая фича закрывает свои незапущенные задачи исходом «снята».
  createPlan(office, [{
    title: 'Лишняя', goal: 'не нужна',
    tasks: [
      { key: 'a', title: 'первая', description: '', acceptanceCriteria: ['a'], roleId: 'backend' },
      { key: 'b', title: 'вторая', description: '', acceptanceCriteria: ['b'], roleId: 'backend', dependsOn: ['a'] },
    ],
  }]);
  const epic = office.epicList().find((e) => e.title === 'Лишняя')!;
  const [first, second] = office.tasksOfEpic(epic.id);
  cancelEpic(office, epic.id, 'передумали');
  check('фича от владельца по умолчанию', epic.origin === 'owner');
  check('запущенная задача снятой фичи исхода не получает', office.tasks.get(first.id)?.outcome === null);
  check('незапущенная задача снятой фичи — «снята»', office.tasks.get(second.id)?.outcome?.kind === 'cancelled');

  // ---------- табель ----------
  console.log('табель');
  const backend = roleReport([...office.tasks.values()].map((t) => ({
    roleId: t.roleId, outcome: t.outcome, usage: t.usage,
  })), 'backend');
  check('табель считает закрытые задачи роли', backend.closed === 3);
  check('табель раскладывает по исходам',
    backend.byKind.reworked === 1 && backend.byKind.failed === 1 && backend.byKind.cancelled === 1);
  check('доля чистых — среди сданных, а не среди всех', backend.cleanShare === 0);
  check('глубина переделки', backend.avgReworks === 2);
  check('честность критериев считается по переделанным',
    backend.claimedBeforeRework === 0);
  const legal = roleReport([...office.tasks.values()].map((t) => ({
    roleId: t.roleId, outcome: t.outcome, usage: t.usage,
  })), 'legal');
  check('чистая задача даёт долю 100%', legal.cleanShare === 1);
  check('окно табеля отсекает старое', roleReport([], 'legal', Date.now() + 1000).closed === 0);

  // ---------- откат ----------
  console.log('откат');
  const repo = fixture();
  const merged = office.createTask({
    title: 'Слитая', description: '', criteria: ['x'], roleId: 'backend',
  });
  writeFileSync(resolve(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', `${merged.id}: работа`);
  const head = git(repo, 'rev-parse', 'HEAD');
  office.updateTask(merged.id, {
    status: 'done', merged: true, branch: `task/${merged.id}`, baseBranch: 'main',
    repoDir: repo, mergeCommit: head,
  });
  recordOutcome(office, merged.id, 'clean');
  check('пока коммит в базе — откатов нет', (await detectReverts(office)).length === 0);
  git(repo, 'reset', '-q', '--hard', 'HEAD~1');
  const reverted = await detectReverts(office);
  check('пропавший коммит слияния — откат', reverted.length === 1 && reverted[0].id === merged.id);
  check('откат перекрывает прежний исход', office.tasks.get(merged.id)?.outcome?.kind === 'reverted');
  check('о откате сказано в чат', office.chat.some((c) => c.text.includes('откачена')));
  check('второй проход откат не удваивает', (await detectReverts(office)).length === 0);
  rmSync(repo, { recursive: true, force: true });

  // ---------- планёрка ----------
  console.log('планёрка');
  check('до первой планёрки она нужна', standupDue(office));
  const text = standupText(office);
  check('планёрка называет день', text.includes('Планёрка'));
  check('планёрка считает закрытые с исходом', text.includes('закрыто') && text.includes('чисто 1'));
  check('планёрка называет откат', text.includes('вы откатили: 1'));
  check('планёрка называет провал', text.includes('провалено: 1'));
  const before = office.chat.length;
  runStandup(office);
  check('планёрка ушла в чат', office.chat.length === before + 1 && office.chat[before].text.startsWith('☀️'));
  check('второй раз за день планёрки нет', !standupDue(office) && office.life.standupDay === dayKey());
  check('планёрка помнит момент', typeof office.life.standupAt === 'number');
  const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
  check('завтра планёрка снова нужна', standupDue(office, tomorrow));
  const quietOffice = getOffice('o-life-quiet');
  quietOffice.seed();
  check('в пустом офисе планёрка коротка', standupText(quietOffice).includes('Ничего не ждёт'));
  check('планёрка переживает сохранение', JSON.stringify(office.toPersisted()).includes('"standupDay"'));

  unloadOfficeState('o-life');
  unloadOfficeState('o-life-quiet');
  console.log(results.join('\n'));
  const failedChecks = results.filter((r) => r.includes('❌'));
  console.log(failedChecks.length ? `ПРОВАЛОВ: ${failedChecks.length}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
  process.exit(failedChecks.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

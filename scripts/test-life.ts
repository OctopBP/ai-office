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
import {
  adjustPortfolio, dueRitual, QUIET_MS, runRitual, runStandup, setRitualAgents, standupDue, standupText,
  triageWork,
} from '../src/server/rituals';
import { officeHealth } from '../src/server/health';
import { confirmFactsFor, factsFor, forget, journalBrief, STALE_AFTER_MS } from '../src/server/journal';
import {
  answerFromChat, answerQuestion, askOwner, dismissQuestion, openQuestions, pickForStandup,
} from '../src/server/questions';
import { setPipelineAgents } from '../src/server/review';
import { decideProposal, initiativeBudget, proposeFeature } from '../src/server/initiatives';
import { applyProposal } from '../src/server/selfchange';
import { roleReport } from '../src/shared/report';
import { dayKey, HEALTH_DIRECTION, OFFICE_SENDER } from '../src/shared/types';

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

  // ---------- журнал ----------
  console.log('журнал');
  const pmMessages: string[] = [];
  setPipelineAgents({
    async review() { return { verdict: 'approve', text: '', reviewerId: null }; },
    async rework() { return { ok: true, message: '' }; },
    notifyPm: (_state, text) => { pmMessages.push(text); },
  });
  const j = getOffice('o-life-journal');
  j.seed();
  j.opened = true;
  const f1 = j.addFact({ kind: 'fact', text: 'Сборка — vite', scope: 'project' });
  const f2 = j.addFact({ kind: 'lesson', text: 'Дизайнер читает рендер', scope: 'role:design' });
  const f3 = j.addFact({ kind: 'decision', text: 'Репозиторий один', scope: 'office' });
  check('роль видит общие и свои записи', factsFor(j, 'design').map((f) => f.id).join() === [f2.id, f1.id].join()
    || factsFor(j, 'design').length === 2);
  check('чужая роль своих не видит', factsFor(j, 'backend').every((f) => f.id !== f2.id));
  check('менеджер видит офисные', factsFor(j, null).some((f) => f.id === f3.id));
  const brief = journalBrief(j, 'design');
  check('журнал уезжает в промпт с пометкой вида', brief.includes('[урок] Дизайнер читает рендер'));
  check('пустой журнал не даёт заголовка', journalBrief(getOffice('o-life-quiet'), null) === '');
  check('журнал виден в снапшоте', (j.snapshot() as { facts: unknown[] }).facts.length === 3);

  // Чистое закрытие подтверждает записи, которые задача видела.
  const long = Date.now() - 10 * 24 * 60 * 60 * 1000;
  j.updateFact(f1.id, { confirmedAt: long });
  const seen = j.createTask({ title: 'Видела журнал', description: '', criteria: ['x'], roleId: 'backend' });
  j.updateTask(seen.id, { startedAt: Date.now(), status: 'done' });
  confirmFactsFor(j, j.tasks.get(seen.id)!);
  check('чистое закрытие подтверждает общую запись', (j.facts.get(f1.id)?.confirmedAt ?? 0) > long);

  // Забывание: факт протухает, решение — становится вопросом.
  const old = Date.now() - STALE_AFTER_MS - 1000;
  j.updateFact(f1.id, { confirmedAt: old });
  j.updateFact(f3.id, { confirmedAt: old });
  const forgot = forget(j);
  check('факт без подтверждения протухает', forgot.staled.length === 1 && j.facts.get(f1.id)?.status === 'stale');
  check('решение не протухает, а спрашивается', forgot.toAsk.length === 1 && j.facts.get(f3.id)?.status === 'live');
  check('второй раз про решение не спрашивают', forget(j).toAsk.length === 0);
  j.updateFact(f1.id, { confirmedAt: old - STALE_AFTER_MS });
  check('протухшее уходит в архив', forget(j).archived.length === 1 && j.facts.get(f1.id)?.status === 'archived');
  check('протухшее не едет в промпт', !journalBrief(j, 'backend').includes('vite'));

  // ---------- вопросы ----------
  console.log('вопросы');
  j.settings.ritualsEnabled = true;
  const asker = j.createTask({ title: 'С допущением', description: '', criteria: ['x'], roleId: 'backend' });
  const inst = j.staffOf('backend')[0];
  const first1 = askOwner(j, inst.id, asker.id, 'Пагинация нужна?', 'делаем без пагинации');
  const second1 = askOwner(j, inst.id, asker.id, 'А сортировка?', 'по дате');
  const third1 = askOwner(j, inst.id, asker.id, 'А фильтры?', 'нет');
  check('вопрос записывается и не блокирует', first1.ok && first1.text.includes('НЕ жди'));
  check('лимит вопросов на задачу', second1.ok && !third1.ok && third1.text.includes('исчерпан'));
  check('пустой вопрос отклоняется', !askOwner(j, inst.id, null, '   ', '').ok);
  check('открытых вопросов два', openQuestions(j).length === 2);
  const q1 = first1.question!;
  pmMessages.length = 0;
  check('ответ принимается', answerQuestion(j, q1.id, 'Да, нужна, по 20'));
  check('повторный ответ отклоняется', !answerQuestion(j, q1.id, 'ещё раз'));
  const fromAnswer = j.factList().find((f) => f.source.questionId === q1.id);
  check('ответ становится записью журнала роли', fromAnswer?.scope === 'role:backend' && fromAnswer.text.includes('по 20'));
  check('менеджер узнаёт об ответе', pmMessages.some((m) => m.includes(q1.id) && m.includes('по 20')));
  check('ответ из чата по «Q-N:»', answerFromChat(j, `${second1.question!.id}: по имени`) === second1.question!.id);
  check('обычное сообщение — не ответ', answerFromChat(j, 'сделай мне заметки') === null);
  const qOffice = askOwner(j, OFFICE_SENDER, null, 'От офиса', 'ничего').question!;
  check('снять вопрос можно', dismissQuestion(j, qOffice.id) && !dismissQuestion(j, qOffice.id));
  check('открытых не осталось', openQuestions(j).length === 0);

  // Варианты ответа: от агента, разобранные из текста и отброшенные.
  const withOpts = askOwner(j, OFFICE_SENDER, null, 'Какой стек берём?', 'Node',
    ['Node', 'Node', '  Go  ', '', 'x'.repeat(41)]).question!;
  check('варианты чистятся и сохраняются',
    JSON.stringify(withOpts.options) === JSON.stringify(['Node', 'Go']));
  const guessed = askOwner(j, OFFICE_SENDER, null, 'Пагинация: по 20 или по 50?', 'по 20').question!;
  check('варианты разбираются из текста',
    JSON.stringify(guessed.options) === JSON.stringify(['по 20', 'по 50']));
  const freeform = askOwner(j, OFFICE_SENDER, null, 'Как назвать раздел?', 'Жизнь офиса').question!;
  check('свободному вопросу варианты не выдумываются', freeform.options === undefined);
  const wordy = askOwner(j, OFFICE_SENDER, null,
    `Делаем ${'а'.repeat(50)} или ${'б'.repeat(50)}?`, 'первое').question!;
  check('длинные куски в варианты не идут', wordy.options === undefined);
  const single = askOwner(j, OFFICE_SENDER, null, 'Точно делаем?', 'да', ['Да']).question!;
  check('один вариант — не выбор', single.options === undefined);
  pmMessages.length = 0;
  check('ответ вариантом закрывает вопрос', answerQuestion(j, withOpts.id, withOpts.options![1]));
  check('ответ вариантом попал в журнал',
    j.factList().some((f) => f.source.questionId === withOpts.id && f.text.includes('Go')));
  check('менеджер узнаёт и об ответе вариантом', pmMessages.some((m) => m.includes(withOpts.id)));
  for (const q of openQuestions(j)) dismissQuestion(j, q.id);
  check('вопросы про варианты разобраны', openQuestions(j).length === 0);

  // Порция для планёрки: важные вперёд, показанные — один раз.
  const a1 = askOwner(j, inst.id, null, 'допущение', 'x').question!;
  j.addQuestion({ from: OFFICE_SENDER, taskId: null, kind: 'contradiction', text: 'противоречие', assumption: 'x' });
  const picked = pickForStandup(j, 1);
  check('противоречие важнее допущения', picked.length === 1 && picked[0].kind === 'contradiction');
  check('показанный вопрос помечен', picked[0].shownAt !== null);
  const rest = pickForStandup(j, 5);
  check('второй раз показывают остальное', rest.length === 1 && rest[0].id === a1.id);
  const standup = standupText(j, Date.now(), rest);
  check('планёрка печатает вопросы с допущением', standup.includes(a1.id) && standup.includes('исходили из'));

  // ---------- ритуалы ----------
  console.log('ритуалы');
  const r = getOffice('o-life-rituals');
  r.seed();
  r.opened = true;
  r.settings.ritualsEnabled = true;
  r.dryRun = true;
  let consolidations = 0;
  setRitualAgents({
    async consolidate(state, input) {
      consolidations += 1;
      return {
        facts: [{ kind: 'lesson', text: `Урок из ${input.closed.map((c) => c.id).join(',')}`, scope: 'role:backend' }],
        contradictions: [{ a: 'A', b: 'не A', text: 'расходится' }],
        questions: [{ text: 'Спросить владельца', assumption: 'пока так' }],
        costUsd: 0.01,
      };
    },
    async contradictions() { return { facts: [], contradictions: [], questions: [], costUsd: 0 }; },
    async reflect() { return { facts: [], contradictions: [], questions: [], costUsd: 0, features: [], rules: [], summary: '' }; },
  });
  check('пустому офису ритуал не нужен', dueRitual(r) === null);
  const closedTask = r.createTask({ title: 'Сделана', description: '', criteria: ['x'], roleId: 'backend' });
  r.updateTask(closedTask.id, { status: 'done', startedAt: Date.now() - 1000 });
  closeIfDone(r, closedTask.id);
  check('сразу после работы — не тихо', dueRitual(r) === null);
  r.lastWorkAt = Date.now() - QUIET_MS - 1;
  check('в тишине с дельтой пора консолидировать', dueRitual(r) === 'consolidate');
  r.settings.ritualsEnabled = false;
  check('выключенные ритуалы не идут', dueRitual(r) === null);
  r.settings.ritualsEnabled = true;
  r.running = 1;
  check('при живой сессии не тихо', dueRitual(r) === null);
  r.running = 0;
  const run = await runRitual(r, 'consolidate');
  check('консолидация прошла через агента', consolidations === 1 && run?.ritual === 'consolidate');
  check('запись легла в журнал с источником', r.factList().some((f) => f.kind === 'lesson' && f.source.ritual === 'consolidate'));
  check('противоречие стало записью и вопросом',
    r.factList().some((f) => f.kind === 'contradiction') && openQuestions(r).some((q) => q.kind === 'contradiction'));
  check('вопрос ритуала — от офиса', openQuestions(r).some((q) => q.from === OFFICE_SENDER && q.kind === 'assumption'));
  check('прогон записан с ценой', r.life.runs.some((x) => x.ritual === 'consolidate' && x.costUsd === 0.01));
  // Журнал появился — забывание ещё ни разу не шло, и оно первое в очереди:
  // без модели и без тишины.
  check('с журналом первым просится забывание', dueRitual(r) === 'forget');
  r.life.lastRun.forget = Date.now();
  // Следом просится здоровье проекта: оно тоже без модели и идёт раз в сутки.
  check('за забыванием — здоровье проекта', dueRitual(r) === 'health');
  r.life.lastRun.health = Date.now();
  // И рефлексия: за неделю есть исход, а она ещё не шла.
  check('за здоровьем — рефлексия', dueRitual(r) === 'reflect');
  r.life.lastRun.reflect = Date.now();
  check('после консолидации дельты нет', dueRitual(r) === null);
  check('ритуал виден клиенту', r.lifeView().lastRun.consolidate !== undefined && r.lifeView().running === null);
  check('забывание пора раз в неделю', (() => { r.life.lastRun.forget = Date.now() - 8 * 24 * 3600 * 1000; return dueRitual(r) === 'forget'; })());
  const forgetRun = await runRitual(r, 'forget');
  check('забывание прошло без модели', forgetRun?.ritual === 'forget' && forgetRun.costUsd === 0);
  check('ритуал по кнопке — планёрка', (await runRitual(r, 'standup'))?.ritual === 'standup');
  r.ritualRunning = 'consolidate';
  check('второй ритуал поверх идущего не идёт', (await runRitual(r, 'forget')) === null);
  r.ritualRunning = null;
  check('жизнь переживает сохранение', JSON.stringify(r.toPersisted()).includes('"consolidate"')
    && JSON.stringify(j.toPersisted()).includes('"questions"'));

  // ---------- разбор завалов ----------
  console.log('разбор завалов');
  const t = getOffice('o-life-triage');
  t.seed();
  t.opened = true;
  t.dryRun = true;
  t.settings.ritualsEnabled = true;
  t.settings.planApproval = false;
  // Второй заход — фича по направлению здоровья; в режиме off офис вправе
  // только предложить её, а здесь проверяется именно постановка в план.
  t.settings.initiativeMode = 'propose';
  // Тишина есть, и все прочие ритуалы только что прошли: дальше просится
  // ровно то, что нашёл разбор завалов, и ничего больше.
  const quietNow = Date.now();
  const hush = (): void => { t.lastWorkAt = Date.now() - QUIET_MS - 1; };
  for (const id of ['forget', 'consolidate', 'contradictions', 'health', 'reflect'] as const) {
    t.life.lastRun[id] = quietNow;
  }
  hush();
  const chatBefore = t.chat.length;
  const emptyRun = await runRitual(t, 'triage');
  check('на пустой сводке разбирать нечего',
    triageWork(t).failures.length === 0 && triageWork(t).branches.length === 0);
  check('на пустой сводке ритуал не просится', dueRitual(t) === null);
  check('прогон по пустой сводке ничего не делает и стоит ноль',
    emptyRun?.costUsd === 0 && t.factList().length === 0 && t.chat.length === chatBefore
    && emptyRun?.produced.noted === 0);

  // Провал, забракованный ревьюером: причина в журнал, второго захода нет.
  const flop = t.createTask({
    title: 'Упало', description: 'что требовалось', criteria: ['x'], roleId: 'backend',
  });
  t.updateTask(flop.id, {
    status: 'failed', startedAt: quietNow - 3600_000, finishedAt: quietNow,
  });
  t.startPr({ taskId: flop.id, title: 'Упало', branch: `task/${flop.id}`, base: 'main', repoDir: '/tmp' });
  t.addReview(flop.id, { at: quietNow, verdict: 'changes', reviewerId: 'rev#1', text: 'критерий 2 не сделан' });
  recordOutcome(t, flop.id, 'failed');
  t.life.lastRun.triage = 0;
  hush();
  check('провал без разбора попадает в разбор', triageWork(t).failures.length === 1);
  check('на непустой сводке ритуал просится', dueRitual(t) === 'triage');
  const flopRun = await runRitual(t, 'triage');
  const lesson = t.factList().find((f) => f.source.taskId === flop.id);
  check('по провалу осталась запись-урок с номером задачи и причиной',
    lesson?.kind === 'lesson' && lesson.source.ritual === 'triage'
    && lesson.text.includes(flop.id) && lesson.text.includes('критерий 2 не сделан'));
  check('разбор не стоит ничего', flopRun?.costUsd === 0);
  check('вердикт ревьюера второго захода не даёт',
    flopRun?.produced.returned === 0 && t.epicList().length === 0);
  check('разобранный провал уходит из сводки', triageWork(t).failures.length === 0);

  // Провал, оборванный лимитом плана: работу не забраковали — она вернётся.
  const limited = t.createTask({
    title: 'Отбило лимитом', description: 'доделать выгрузку', criteria: ['a', 'b'], roleId: 'backend',
  });
  t.updateTask(limited.id, { status: 'failed', limitedAt: quietNow, finishedAt: quietNow });
  recordOutcome(t, limited.id, 'failed');
  t.life.lastRun.triage = 0;
  const retryRun = await runRitual(t, 'triage');
  const retried = t.epicList().find((e) => e.title.includes(limited.id));
  check('провал от лимита вернулся в план вторым заходом',
    retryRun?.produced.returned === 1 && retried?.origin === 'office' && retried.approved === true);
  check('второй заход несёт критерии, описание и роль первого', (() => {
    const task = retried ? t.tasksOfEpic(retried.id)[0] : null;
    return task?.roleId === 'backend' && task.criteria.length === 2
      && task.description.includes('доделать выгрузку');
  })());
  check('и про возвращённый провал запись тоже есть',
    t.factList().some((f) => f.source.taskId === limited.id && f.text.includes('вернул её в план')));

  // Ветки: идущая задача — не забота разбора, закрытые — помечаются.
  const running = t.createTask({ title: 'Ещё идёт', description: '', criteria: ['x'], roleId: 'backend' });
  t.updateTask(running.id, {
    status: 'in_progress', branch: `task/${running.id}`, startedAt: quietNow - 3 * 24 * 3600 * 1000,
  });
  const unmerged = t.createTask({ title: 'Сдана, не слита', description: '', criteria: ['x'], roleId: 'backend' });
  t.updateTask(unmerged.id, {
    status: 'done', branch: `task/${unmerged.id}`,
    startedAt: quietNow - 3 * 24 * 3600 * 1000, finishedAt: quietNow - 2 * 24 * 3600 * 1000,
  });
  recordOutcome(t, unmerged.id, 'clean');
  const dead = t.createTask({ title: 'Провал с веткой', description: '', criteria: ['x'], roleId: 'frontend' });
  t.updateTask(dead.id, {
    status: 'failed', branch: `task/${dead.id}`,
    startedAt: quietNow - 3 * 24 * 3600 * 1000, finishedAt: quietNow - 2 * 24 * 3600 * 1000,
  });
  recordOutcome(t, dead.id, 'failed');
  check('сводка здоровья видит все три ветки', officeHealth(t).branches.length === 3);
  check('разбор берёт только ветки закрытых задач', (() => {
    const branches = triageWork(t).branches;
    return branches.length === 2 && branches.every((b) => b.task.id !== running.id);
  })());
  t.life.lastRun.triage = 0;
  await runRitual(t, 'triage');
  check('ветка незакрытой задачи не помечена', t.tasks.get(running.id)?.branchMark === null);
  check('сданная, но не слитая — «слить»', t.tasks.get(unmerged.id)?.branchMark === 'merge');
  check('ветка провала — «удалить»', t.tasks.get(dead.id)?.branchMark === 'drop');
  check('о метках сказано владельцу, и что офис ветки не трогает — тоже',
    t.chat.some((c) => c.text.includes('🧹') && c.text.includes('не сливает')));
  check('метка видна клиенту', (t.snapshot() as { tasks: Array<{ id: string; branchMark: unknown }> })
    .tasks.some((x) => x.id === unmerged.id && x.branchMark === 'merge'));
  check('метка переживает сохранение', JSON.stringify(t.toPersisted()).includes('"branchMark":"merge"'));
  t.life.lastRun.triage = 0;
  const again = await runRitual(t, 'triage');
  check('второй проход по тому же завалу ничего не переставляет',
    again?.produced.noted === 0 && again.produced.merge === 0 && again.produced.drop === 0
    && (t.tasks.get(unmerged.id)?.branchMarkAt ?? 0) > 0);
  t.life.lastRun.triage = 0;
  hush();
  check('разобранная сводка ритуала больше не просит', dueRitual(t) === null);

  // ---------- направления и инициативы ----------
  console.log('направления');
  const d = getOffice('o-life-dir');
  d.seed();
  d.opened = true;
  d.settings.planApproval = true;
  d.settings.focusEpics = 2;
  check('встроенное направление есть с рождения', d.directions.has(HEALTH_DIRECTION) && d.directionList().length === 1);
  check('встроенное не снимается', d.removeDirection(HEALTH_DIRECTION) !== null);
  check('пустое направление отклоняется', d.createDirection('  ') !== null);
  check('направление заводится', d.createDirection('Довести маркет до запуска') === null && d.directionList()[0].id === 'D-1');
  check('направление приостанавливается', d.updateDirection('D-1', { active: false }) === null && d.directions.get('D-1')?.active === false);
  check('направления в снапшоте', (d.snapshot() as { directions: unknown[] }).directions.length === 2);

  const feature = (title: string, directionId: string | null = 'D-1') => ({
    title, goal: 'цель', rationale: 'по направлению', directionId,
    tasks: [{ key: 'a', title: 'задача', description: '', acceptanceCriteria: ['x'], roleId: 'backend' }],
  });
  d.settings.initiativeMode = 'off';
  check('в режиме off — предложение, а не фича', proposeFeature(d, feature('Стенд')).ok
    && d.proposalList().length === 1 && d.epicList().length === 0);
  check('дубль предложения отклоняется', !proposeFeature(d, feature('Стенд')).ok);
  d.settings.initiativeMode = 'propose';
  check('в режиме propose — фича без согласия', proposeFeature(d, feature('OAuth')).ok
    && d.epicList().some((e) => e.title === 'OAuth' && e.origin === 'office' && !e.approved && e.directionId === 'D-1'));
  check('здоровье проекта не ждёт «поехали»', proposeFeature(d, feature('Починить', HEALTH_DIRECTION)).ok
    && d.epicList().some((e) => e.title === 'Починить' && e.approved));
  d.settings.initiativeMode = 'auto';
  check('в режиме auto — согласована сразу', proposeFeature(d, feature('Зеркало')).ok
    && d.epicList().some((e) => e.title === 'Зеркало' && e.approved));
  check('принятое предложение встаёт в план согласованным', decideProposal(d, 'P-1', true, applyProposal).ok
    && d.epicList().some((e) => e.title === 'Стенд' && e.approved && e.origin === 'office')
    && d.proposals.get('P-1')?.status === 'accepted');
  check('решённое второй раз не решается', !decideProposal(d, 'P-1', false, applyProposal).ok);
  check('инициатива в чате с обоснованием', d.chat.some((c) => c.text.includes('💡') && c.text.includes('по направлению')));

  // Доля на своё: пока владелец тратит, инициатива идёт в пределах доли.
  const day = dayKey();
  d.daily[day] = { costUsd: 10, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
  const mirror = d.epicList().find((e) => e.title === 'Зеркало')!;
  const mirrorTask = d.tasksOfEpic(mirror.id)[0];
  d.settings.initiativeShare = 0.2;
  let budget = initiativeBudget(d);
  check('доля считается от недельного расхода', budget.allowedUsd === 2 && !budget.exhausted);
  mirrorTask.daily[day] = { costUsd: 2.5, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
  budget = initiativeBudget(d);
  check('перерасход на своё исчерпывает долю', budget.spentUsd === 2.5 && budget.exhausted);
  d.settings.initiativeShare = 0.5;
  check('доля настраивается', !initiativeBudget(d).exhausted);
  d.daily[day].costUsd = 0;
  check('без расхода остаётся минимальный запас', initiativeBudget(d).allowedUsd === 1);

  // Правило принимается в приписку к брифу пакета.
  const rule = d.addProposal({
    kind: 'rule', title: 'Прогонять typecheck', text: 'Перед сдачей прогоняй npm run typecheck.',
    rationale: 'три возврата', roleId: 'backend', setting: null, directionId: null, plan: null,
  });
  check('правило дописывается в briefExtra роли', decideProposal(d, rule.id, true, applyProposal).ok
    && (d.role('backend')?.package?.briefExtra ?? d.role('backend')?.brief ?? '').includes('typecheck'));
  const setting = d.addProposal({
    kind: 'setting', title: 'Больше ходов', text: '', rationale: 'лимит', roleId: null,
    setting: { key: 'taskMaxTurns', value: 90 }, directionId: null, plan: null,
  });
  check('настройка из белого списка применяется', decideProposal(d, setting.id, true, applyProposal).ok
    && d.settings.taskMaxTurns === 90);
  const forbidden = d.addProposal({
    kind: 'setting', title: 'Полный доступ', text: '', rationale: 'нет', roleId: null,
    setting: { key: 'officePermissionMode', value: 'auto' }, directionId: null, plan: null,
  });
  check('настройка вне списка отклоняется', !decideProposal(d, forbidden.id, true, applyProposal).ok
    && d.settings.officePermissionMode !== 'auto');
  check('отклонённое остаётся отклонённым', decideProposal(d, d.addProposal({
    kind: 'rule', title: 'x', text: 'y', rationale: '', roleId: 'backend', setting: null, directionId: null, plan: null,
  }).id, false, applyProposal).ok);

  // Рефлексия через заглушку заводит фичу по направлению и пишет итог.
  console.log('рефлексия');
  setRitualAgents({
    async consolidate() { return { facts: [], contradictions: [], questions: [], costUsd: 0 }; },
    async contradictions() { return { facts: [], contradictions: [], questions: [], costUsd: 0 }; },
    async reflect(_state, input) {
      return {
        facts: [{ kind: 'lesson', text: `Урок недели по ${input.reports.length} табелям`, scope: 'project' }],
        contradictions: [], questions: [], costUsd: 0.05,
        features: [feature('Из рефлексии')],
        rules: [{ roleId: 'backend', text: 'Перед сдачей прогоняй проверки.', rationale: 'три возврата подряд' }],
        summary: 'Неделя прошла ровно.',
      };
    },
  });
  d.settings.initiativeMode = 'propose';
  const refl = await runRitual(d, 'reflect');
  check('рефлексия завела фичу по направлению', refl?.ritual === 'reflect'
    && d.epicList().some((e) => e.title === 'Из рефлексии' && e.origin === 'office'));
  check('рефлексия записала урок', d.factList().some((f) => f.source.ritual === 'reflect'));
  check('правило из рефлексии — предложение, а не правка',
    d.proposalList().some((p) => p.kind === 'rule' && p.status === 'pending' && p.roleId === 'backend')
    && !(d.role('backend')?.package?.briefExtra ?? '').includes('прогоняй проверки'));
  check('правило не предлагается дважды', (await (async () => {
    d.life.lastRun.reflect = 0; d.ritualRunning = null; await runRitual(d, 'reflect');
    return d.proposalList().filter((p) => p.kind === 'rule' && p.text.includes('прогоняй проверки')).length;
  })()) === 1);
  check('итог рефлексии в чате и в планёрке', d.chat.some((c) => c.text.includes('🪞'))
    && standupText(d).includes('Неделя прошла ровно'));
  d.life.policy.reflectionOn = false;
  d.life.lastRun.reflect = 0;
  d.life.lastRun.health = Date.now();
  d.life.lastRun.forget = Date.now();
  d.lastWorkAt = Date.now() - QUIET_MS - 1;
  check('выключенная рефлексия не просится', dueRitual(d) !== 'reflect');
  check('планёрка называет инициативу инициативой', standupText(d).includes('офис предлагает сам'));

  // ---------- портфель ----------
  console.log('портфель');
  const pf = getOffice('o-life-portfolio');
  pf.seed();
  pf.opened = true;
  // Записи консолидации недельной давности, все протухли: портфель смотрит на
  // последние две недели, и пятнадцать дней назад он бы уже не увидел.
  const tenDays = Date.now() - 10 * 24 * 3600 * 1000;
  const two = Date.now() - 15 * 24 * 3600 * 1000;
  for (let i = 0; i < 3; i += 1) {
    const f = pf.addFact({ kind: 'fact', text: `протухший ${i}`, scope: 'project', source: { ritual: 'consolidate' } });
    pf.updateFact(f.id, { status: 'archived', createdAt: tenDays, confirmedAt: tenDays });
  }
  const everyBefore = pf.life.policy.consolidateEveryMs;
  adjustPortfolio(pf);
  check('протухающие записи консолидации — консолидация реже', pf.life.policy.consolidateEveryMs === everyBefore * 2);
  for (let i = 0; i < 3; i += 1) {
    const q = pf.addQuestion({ from: OFFICE_SENDER, taskId: null, kind: 'assumption', text: `без ответа ${i}`, assumption: 'x' });
    pf.updateQuestion(q.id, { shownAt: two });
  }
  adjustPortfolio(pf);
  check('вопросы без ответа — порция меньше', pf.life.policy.questionsPerStandup === 3);
  pf.touchLife({ deferrals: 3 });
  adjustPortfolio(pf);
  check('частые отложенные — рефлексия выключена', pf.life.policy.reflectionOn === false && pf.life.deferrals === 0);
  adjustPortfolio(pf);
  check('неделя без отложенных — рефлексия снова включена', pf.life.policy.reflectionOn === true);
  for (let i = 0; i < 5; i += 1) {
    pf.noteRitualRun({ ritual: 'standup', at: Date.now() - (5 - i) * 24 * 3600 * 1000, costUsd: 0, produced: {}, note: '' });
  }
  adjustPortfolio(pf);
  check('нечитаные планёрки — без фразы менеджера', pf.life.policy.standupPmLine === false);
  check('портфель говорит о себе в ленте', pf.log.filter((l) => l.text.startsWith('Портфель')).length >= 4);
  check('портфель в снапшоте', (pf.snapshot() as { life: { policy: { standupPmLine: boolean } } }).life.policy.standupPmLine === false);

  unloadOfficeState('o-life');
  unloadOfficeState('o-life-quiet');
  unloadOfficeState('o-life-journal');
  unloadOfficeState('o-life-rituals');
  unloadOfficeState('o-life-triage');
  unloadOfficeState('o-life-dir');
  unloadOfficeState('o-life-portfolio');
  console.log(results.join('\n'));
  const failedChecks = results.filter((r) => r.includes('❌'));
  console.log(failedChecks.length ? `ПРОВАЛОВ: ${failedChecks.length}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
  process.exit(failedChecks.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

/**
 * Процессы самого офиса (docs/design/workflows/spec.md §6): «что дальше» на
 * пустой доске и совещание о развитии — без моделей, с подставными агентами.
 * Проверяется, когда офис будит менеджера, а когда честно молчит: дельта,
 * затухание, ожидание владельца, кулдаун совещания, память об отклонённом.
 *
 * Запуск: npm run test:flows
 */
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice } from '../src/server/state';
import {
  boardIdle, dueFlow, runFlow, setFlowAgents, whenFlowsIdle,
  type DecideInput, type DecideOutput,
} from '../src/server/flows';
import { QUIET_MS, runRitual } from '../src/server/rituals';
import { decideProposal } from '../src/server/initiatives';
import { cancelEpic } from '../src/server/plan';
import { builtinWorkflow } from '../src/server/workflows';

process.env.OFFICE_LANG = 'ru';

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  const line = `  ${ok ? '✅' : '❌'} ${what}: ${ok}`;
  results.push(line);
  console.log(line);
};
const say = (text: string) => { results.push(text); console.log(text); };

const feature = (title: string, directionId: string | null) => ({
  title, goal: 'цель', rationale: 'по направлению', directionId,
  tasks: [{ key: 'a', title: 'задача', description: '', acceptanceCriteria: ['x'], roleId: 'backend' }],
});

async function main(): Promise<void> {
  const office = getOffice('o-flows');
  office.setStateFile(resolve(tmpdir(), `office-flows-state-${process.pid}.json`));
  office.seed();
  office.opened = true;
  office.dryRun = true;
  office.settings.ritualsEnabled = true;
  office.settings.initiativeMode = 'propose';
  office.settings.autoPipeline = true;
  const beQuiet = () => { office.lastWorkAt = Date.now() - QUIET_MS - 1; };
  beQuiet();

  const flow = builtinWorkflow('what-next');
  const decisions: DecideOutput[] = [];
  const asked: DecideInput[] = [];
  const meetings: Array<{ topic: string; ids: string[] }> = [];
  let summaries = 0;
  setFlowAgents({
    async decide(_state, input) {
      asked.push(input);
      return decisions.shift() ?? { kind: 'nothing', costUsd: 0, why: 'нечего' };
    },
    async summarize() {
      summaries += 1;
      return { features: [feature('Стенд на публикации', 'D-1')], summary: 'итог совещания', costUsd: 0 };
    },
    async meeting(_state, topic, ids) {
      meetings.push({ topic, ids });
      return { ok: true, said: ids.map((id) => ({ id, title: id, text: `мнение ${id}` })) };
    },
  });
  // Пара миллисекунд между действиями: дельта считается по времени, а весь
  // сценарий без моделей укладывается в одну миллисекунду.
  const later = () => new Promise((r) => setTimeout(r, 3));
  const tick = async () => {
    await later();
    beQuiet();
    const due = dueFlow(office);
    if (due) await runFlow(office, due);
    await whenFlowsIdle(office);
    await later();
    return Boolean(due);
  };
  const mem = () => office.flowMemory(flow.id);
  const lastChat = () => office.chat[office.chat.length - 1]?.text ?? '';

  // ---------- пустая доска
  say('▶ Пустая доска без направлений — не повод будить менеджера');
  check('доска пуста', boardIdle(office));
  check('процессу пора', dueFlow(office)?.id === 'what-next');
  await tick();
  check('прогон прошёл и кончился', office.flowRun(flow.id)?.status === 'done');
  check('менеджера не звали', asked.length === 0);
  check('причина — нет направлений', mem().lastOutcome === 'skip'
    && office.log.some((l) => l.text.includes('нет ни одного активного направления')));
  check('следующий заход отложен', (mem().backoffUntil ?? 0) > Date.now());
  check('в затухании процессу не пора', dueFlow(office) === null);

  say('▶ Занятая доска — не пустая');
  const busy = office.createTask({ title: 'В работе', description: '', criteria: ['x'], roleId: 'backend' });
  office.updateTask(busy.id, { status: 'in_progress' });
  check('задача в работе — не пусто', !boardIdle(office));
  office.updateTask(busy.id, { status: 'done', merged: true });
  beQuiet();
  check('закрытая — снова пусто', boardIdle(office));
  office.settings.initiativeMode = 'off';
  check('в режиме off офис не ищет работу', !boardIdle(office));
  office.settings.initiativeMode = 'propose';

  // ---------- направление и фича
  say('▶ Есть направление — менеджер выводит фичу');
  check('направление завелось', office.createDirection('Довести стенд до публичного запуска') === null);
  office.touchFlow(flow.id, { backoffUntil: null });
  decisions.push({ kind: 'feature', feature: feature('Стенд: витрина', 'D-1'), costUsd: 0 });
  await tick();
  check('менеджера позвали один раз', asked.length === 1);
  check('в выжимке — направление', asked[0]?.digest.includes('публичного запуска') === true);
  const epic = office.epicList().find((e) => e.origin === 'office');
  check('фича заведена офисом', Boolean(epic) && epic?.title === 'Стенд: витрина');
  check('в режиме propose — без «поехали»', epic?.approved === false);
  check('исход прогона — фича', mem().lastOutcome === 'feature' && mem().idleStreak === 0);

  say('▶ Пока владелец не ответил, нового не заводим');
  office.touchFlow(flow.id, { backoffUntil: null });
  await tick();
  check('фича без «поехали» — ждём владельца', asked.length === 1 && mem().lastOutcome === 'skip'
    && office.log.some((l) => l.text.includes('фич без «поехали»')));
  cancelEpic(office, epic!.id, 'не надо');
  await later();
  office.touchFlow(flow.id, { backoffUntil: null, lastAt: Date.now() });
  await tick();
  check('без дельты менеджера не будят', asked.length === 1
    && office.log.some((l) => l.text.includes('ничего не изменилось')));

  // ---------- нечего и затухание
  say('▶ «Нечего» — затухание');
  office.touchFlow(flow.id, { backoffUntil: null, lastAt: Date.now() - 2 * 86_400_000 });
  decisions.push({ kind: 'nothing', why: 'направление закрыто', costUsd: 0 });
  await tick();
  check('менеджер сказал «нечего»', asked.length === 2 && mem().lastOutcome === 'nothing');
  check('владелец увидел почему', lastChat().includes('направление закрыто'));
  check('серия пустых заходов — один', mem().idleStreak === 1);
  const firstWait = (mem().backoffUntil ?? 0) - Date.now();
  check('пауза около часа', firstWait > 50 * 60_000 && firstWait <= 60 * 60_000);
  office.touchFlow(flow.id, { backoffUntil: null, lastAt: Date.now() - 2 * 86_400_000 });
  decisions.push({ kind: 'nothing', why: 'всё ещё нечего', costUsd: 0 });
  await tick();
  check('второй раз — молча, в лог', mem().idleStreak === 2 && !lastChat().includes('всё ещё нечего'));
  check('и пауза вдвое длиннее', (mem().backoffUntil ?? 0) - Date.now() > 110 * 60_000);

  // ---------- совещание
  say('▶ Совещание о развитии — последний ход перед простоем');
  office.touchFlow(flow.id, { backoffUntil: null, lastAt: Date.now() - 2 * 86_400_000 });
  decisions.push({ kind: 'meet', topic: 'Что делать со стендом', costUsd: 0 });
  await tick();
  check('совещание созвали', meetings.length === 1 && meetings[0].topic === 'Что делать со стендом');
  check('менеджер за столом', meetings[0].ids.includes('pm#1'));
  check('и не больше двух сотрудников разных ролей', meetings[0].ids.length >= 2 && meetings[0].ids.length <= 3);
  check('итог подведён', summaries === 1 && mem().lastOutcome === 'proposed');
  const proposal = office.proposalList().find((p) => p.title === 'Стенд на публикации');
  check('предложение ждёт владельца, а не заведено фичей', proposal?.status === 'pending'
    && !office.epicList().some((e) => e.title === 'Стенд на публикации'));
  check('владелец увидел итог', office.chat.some((c) => c.text.includes('итог совещания')));
  check('совещание запомнено', mem().lastMeetingAt !== null);

  say('▶ Второго совещания подряд не будет');
  office.touchFlow(flow.id, { backoffUntil: null });
  await tick();
  check('предложение без ответа — ждём владельца', mem().lastOutcome === 'skip' && asked.length === 4);
  decideProposal(office, proposal!.id, false);
  office.touchFlow(flow.id, { backoffUntil: null });
  decisions.push({ kind: 'meet', topic: 'Ещё раз', costUsd: 0 });
  await tick();
  check('ответ владельца — дельта, менеджера позвали', asked.length === 5);
  check('отклонённое передано менеджеру', asked[4]?.rejected.includes('Стенд на публикации') === true);
  check('совещание не разрешено', asked[4]?.canMeet === false);
  check('«созвать» без права — как «нечего»', meetings.length === 1 && mem().lastOutcome === 'nothing');

  // ---------- ритуал как прогон
  say('▶ Ритуал идёт тем же раннером');
  office.addFact({ kind: 'fact', text: 'Сборка — vite', scope: 'project' });
  const run = await runRitual(office, 'forget');
  check('ритуал прошёл', run?.ritual === 'forget');
  check('и оставил прогон процесса', office.flowRun('ritual-forget')?.status === 'done');

  office.wipe();
  const failed = results.filter((r) => r.includes('❌'));
  if (failed.length) {
    console.error(`\nПровалено проверок: ${failed.length}`);
    process.exit(1);
  }
  console.log(`\nВсе проверки прошли: ${results.filter((r) => r.includes('✅')).length}`);
}

void main();

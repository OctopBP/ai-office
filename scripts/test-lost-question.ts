/**
 * Вопрос ритуала о «пропавшем» вопросе владельца (T-698): «Q-N пропал из
 * списка открытых — ответьте или перезадайте». Владельцу такой вопрос не
 * уходит никогда: задача закрыта — тишина и строка в ленте, задача жива и
 * текст есть — исходный вопрос задаётся заново по существу, текста нет —
 * разбираться менеджеру. Токенов не нужно: агент ритуала — заглушка.
 *
 * Запуск: npm run test:lost-question
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { getOffice, unloadOfficeState } from '../src/server/state';
import { askOwner, deleteQuestion, dismissQuestion, openQuestions, settleLostQuestion } from '../src/server/questions';
import { runRitual, setRitualAgents, type RitualOutput } from '../src/server/rituals';
import { setPipelineAgents } from '../src/server/review';
import { OFFICE_SENDER } from '../src/shared/types';

process.env.OFFICE_LANG = 'ru';

let failed = 0;
const check = (what: string, ok: boolean): void => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${what}`);
};

const pmInbox: Array<{ text: string; taskId?: string | null }> = [];
setPipelineAgents({
  async review() { return { verdict: 'approve', text: '', reviewerId: null }; },
  async rework() { return { ok: true, message: '' }; },
  notifyPm: (_state, text, about) => { pmInbox.push({ text, taskId: about?.taskId ?? null }); },
});

const office = getOffice('o-lost-question');
office.seed();
office.opened = true;
office.dryRun = true;
office.settings.model = { provider: 'claude-code', model: 'claude-sonnet-5-5' };

/** Ритуал консолидации спросит ровно это. */
let ritualQuestions: RitualOutput['questions'] = [];
setRitualAgents({
  async consolidate() { return { facts: [], contradictions: [], questions: ritualQuestions, costUsd: 0 }; },
  async contradictions() { return { facts: [], contradictions: [], questions: [], costUsd: 0 }; },
  async reflect() { return { facts: [], contradictions: [], questions: [], costUsd: 0, features: [], rules: [], summary: '' }; },
});

const lostAsk = (qid: string, tid: string): RitualOutput['questions'][number] => ({
  title: `${qid} пропал: что отвечаете по ${tid}?`,
  text: `Вопрос ${qid} пропал из списка открытых, хотя задача ${tid} из-за него дважды возвращалась на доработку. `
    + 'Напишите ваш ответ по этому вопросу или перезадайте его.',
  assumption: 'Ждём ответа владельца.',
});

const newTask = (title: string) => office.createTask({ title, description: '', criteria: ['x'], roleId: 'backend' });
const ownerQuestions = () => openQuestions(office).filter((q) => q.from === OFFICE_SENDER);

async function main(): Promise<void> {
  // ---------- 1. Задача закрыта (снята) ----------
  console.log('задача закрыта');
  const cancelled = newTask('Аудит языка');
  office.updateTask(cancelled.id, { status: 'in_progress' });
  const asked = askOwner(office, 'backend#1', cancelled.id, 'На каком языке писать заметки к выпуску?',
    'Всё в репозитории — на языке реализации.', ['Как в допущении', 'Всё на языке общения']).question!;
  // Как в настоящем офисе: задачу сняли — её вопросы закрылись вместе с ней.
  office.updateTask(cancelled.id, { status: 'cancelled' });
  dismissQuestion(office, asked.id, `задача ${cancelled.id} снята`);
  const before = office.questionList().length;
  ritualQuestions = [lostAsk(asked.id, cancelled.id)];
  await runRitual(office, 'consolidate');
  check('вопрос владельцу не создан', office.questionList().length === before);
  check('менеджеру ничего не ушло', pmInbox.length === 0);
  check('в ленте строка о том, что спрашивать не о чем',
    office.log.some((l) => l.text.includes(asked.id) && l.text.includes('уже закрыта')));
  // Задачи нет совсем — тоже тишина.
  check('задачи нет — тоже не спрашиваем',
    settleLostQuestion(office, { text: 'Вопрос Q-9999 пропал, задача T-9999 ждёт.' })?.fate === 'closedTask');

  // ---------- 2. Задача жива, текст найден ----------
  console.log('задача жива, текст найден');
  const live = newTask('Пагинация заметок');
  office.updateTask(live.id, { status: 'in_progress' });
  const original = askOwner(office, 'backend#1', live.id, 'Делать страницы по 20 или по 50 записей?',
    'По 20 — как в журнале.', ['По 20', 'По 50'], [], null,
    { title: 'Сколько записей на странице?', details: 'journal.ts, GET /api/journal' }).question!;
  // Вопрос потерялся при живой задаче: снят офисом без ответа.
  dismissQuestion(office, original.id, 'слит при отзыве');
  ritualQuestions = [lostAsk(original.id, live.id)];
  await runRitual(office, 'consolidate');
  const again = ownerQuestions().find((q) => q.taskId === live.id);
  check('исходный вопрос задан заново', Boolean(again) && again!.id !== original.id);
  check('с исходным текстом и допущением',
    again?.text === original.text && again?.assumption === original.assumption);
  check('с вариантами и короткой сутью',
    JSON.stringify(again?.options) === JSON.stringify(['По 20', 'По 50']) && again?.title === 'Сколько записей на странице?');
  check('без «пропал» и номеров вопроса в тексте', !/пропал|Q-\d+/.test(`${again?.title} ${again?.text}`));
  check('менеджеру ничего не ушло', pmInbox.length === 0);
  // Владелец снял вопрос сам — его выбор, заново не спрашиваем.
  const mine = askOwner(office, 'backend#1', live.id, 'Кешировать выдачу?', 'Нет.').question!;
  dismissQuestion(office, mine.id);
  check('снятый владельцем вопрос не перезадаётся',
    settleLostQuestion(office, lostAsk(mine.id, live.id))?.fate === 'ownerDismissed');

  // ---------- 3. Задача жива, текста нет ----------
  console.log('задача жива, текста нет');
  const other = newTask('Иконка офиса');
  office.updateTask(other.id, { status: 'review' });
  const gone = office.addQuestion({
    from: 'frontend#1', taskId: other.id, kind: 'assumption', text: 'PNG или SVG?', assumption: 'SVG',
    options: [], chatId: null,
  });
  deleteQuestion(office, gone.id);
  const count = office.questionList().length;
  ritualQuestions = [lostAsk(gone.id, other.id)];
  await runRitual(office, 'consolidate');
  check('вопрос владельцу не создан', office.questionList().length === count);
  const told = pmInbox.at(-1);
  check('менеджеру ушло системное сообщение по задаче',
    pmInbox.length === 1 && told?.taskId === other.id && told.text.startsWith('[СИСТЕМА]'));
  check('в сообщении — переформулировать или закрыть по допущению',
    Boolean(told?.text.includes('ask_owner') && told.text.includes('допущению')));

  // ---------- обычный вопрос ритуала идёт как раньше ----------
  console.log('обычный вопрос');
  ritualQuestions = [{ text: 'Выпускать бету по пятницам?', assumption: 'Да.' }];
  await runRitual(office, 'consolidate');
  check('вопрос без ссылки на закрытый вопрос задан владельцу',
    ownerQuestions().some((q) => q.text === 'Выпускать бету по пятницам?'));
  check('повтор о том же вопросе не плодит второй вопрос', (() => {
    const n = office.questionList().length;
    const again2 = settleLostQuestion(office, lostAsk(original.id, live.id));
    return again2?.fate === 'reasked' && again2.questionId === again?.id && office.questionList().length === n;
  })());
  check('вопрос без ссылок на вопросы разбирать нечего', settleLostQuestion(office, { text: 'Без ссылок' }) === null);

  unloadOfficeState('o-lost-question');
  if (failed) {
    console.log(`\n✗ провалено: ${failed}`);
    process.exit(1);
  }
  console.log('\n✓ все проверки прошли');
}

main().catch((e) => { console.error(e); process.exit(1); });

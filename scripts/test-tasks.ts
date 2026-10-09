/**
 * Проверки правки, снятия и удаления задач (src/server/tasks.ts).
 *
 * Живой модели здесь нет и не нужно: всё это — решения кода, а не менеджера.
 * Проверяется ровно то, из-за чего работа и затевалась: правка не плодит
 * дублей, снятая задача больше никуда не уезжает, а стереть можно только то,
 * за чем не стоит работа.
 *
 * Запуск: npm run test:tasks
 */
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { getOffice, unloadOfficeState } from '../src/server/state';
import { dispatch, setPlanAgents } from '../src/server/plan';
import { deleteTask, dropTask, editTask } from '../src/server/tasks';
import { retryTask } from '../src/server/agents';
import { stuckPrs } from '../src/server/review';
import { standupText } from '../src/server/rituals';
import { reviewStatusText } from '../src/server/task-view';

// Тексты офиса сверяем по-русски — значит, и офис должен быть русским.
process.env.OFFICE_LANG = 'ru';

const office = getOffice('o-tasks');

/** Кого офис пытался запустить с прошлой проверки. */
let started: string[] = [];

setPlanAgents({
  assign: (state, taskId) => {
    started.push(taskId);
    state.updateTask(taskId, { status: 'in_progress', assigneeId: 'stub#1' });
    return { ok: true, message: 'stub#1' };
  },
  notifyPm: () => { /* сообщения менеджеру здесь не проверяем */ },
});

const took = (): string[] => {
  const list = started.sort();
  started = [];
  return list;
};

const add = (input: {
  title?: string; roleId?: string; status?: 'planned' | 'backlog'; dependsOn?: string[];
}) => office.createTask({
  title: input.title ?? 'Задача',
  description: 'ТЗ',
  criteria: ['раз', 'два'],
  roleId: input.roleId ?? 'backend',
  status: input.status ?? 'backlog',
  dependsOn: input.dependsOn ?? [],
});

async function main(): Promise<void> {
  office.seed();
  office.settings.autoPipeline = true;
  const results: string[] = [];
  const check = (what: string, ok: boolean): void => { results.push(`${what}: ${ok}`); };

  // ---------------------------------------------------------------- правка
  const edited = add({ title: 'Старый заголовок' });
  office.updateTask(edited.id, { criteria: [{ text: 'раз', done: true }] });
  const editOk = editTask(office, edited.id, {
    title: 'Новый заголовок',
    description: 'Новое ТЗ',
    criteria: ['первый', 'второй', 'третий'],
  });
  const afterEdit = office.tasks.get(edited.id);
  check('правка принята', editOk.ok);
  check('заголовок переписан', afterEdit?.title === 'Новый заголовок');
  check('ТЗ переписано', afterEdit?.description === 'Новое ТЗ');
  check('критерии заменены целиком', afterEdit?.criteria.length === 3);
  check('отметки прошлых критериев сброшены', afterEdit?.criteria.every((c) => !c.done) === true);
  check('новых задач правка не завела', office.tasks.size === 1);

  // Роль меняется вместе с типом работы: он был выведен из прежней роли.
  const roleMoved = editTask(office, edited.id, { roleId: 'frontend' });
  check('роль переписана', roleMoved.ok && office.tasks.get(edited.id)?.roleId === 'frontend');
  check('неизвестная роль отклонена', !editTask(office, edited.id, { roleId: 'нет-такой' }).ok);
  check('пустые критерии отклонены', !editTask(office, edited.id, { criteria: ['  '] }).ok);
  check('правка без изменений отклонена',
    !editTask(office, edited.id, { title: 'Новый заголовок' }).ok);

  // Важность правится тем же вызовом: «это срочно» приходит от человека так
  // же, как «перепиши ТЗ», и отдельного инструмента под это быть не должно.
  const hurried = editTask(office, edited.id, { priority: 'high' });
  check('важность правится вместе с остальным', hurried.ok);
  check('важность записалась', office.tasks.get(edited.id)?.priority === 'high');
  check('та же важность повторно не принимается',
    !editTask(office, edited.id, { priority: 'high' }).ok);

  const running = add({ title: 'Уже делают' });
  office.updateTask(running.id, { status: 'in_progress', assigneeId: 'backend#1' });
  check('идущую задачу править нельзя', !editTask(office, running.id, { title: 'Другое' }).ok);

  const closed = add({ title: 'Уже сделана' });
  office.updateTask(closed.id, { status: 'done', merged: true });
  check('закрытую задачу править нельзя', !editTask(office, closed.id, { title: 'Другое' }).ok);
  check('снять сделанную нельзя', !dropTask(office, closed.id).ok);
  check('несуществующую задачу править нельзя', !editTask(office, 'T-404', { title: 'x' }).ok);

  // ---------------------------------------------------------------- снятие
  const dropped = add({ title: 'Больше не надо' });
  const dropOk = dropTask(office, dropped.id, 'передумали');
  const afterDrop = office.tasks.get(dropped.id);
  check('снятие принято', dropOk.ok);
  check('задача в статусе «снята»', afterDrop?.status === 'cancelled');
  check('исход — «снята»', afterDrop?.outcome?.kind === 'cancelled');
  check('повторное снятие отклонено', !dropTask(office, dropped.id).ok);

  // Снятая задача никуда не уезжает: ни планом, ни надзором. Раздачу
  // проверяем через dispatch — им пользуются оба.
  took();
  dispatch(office);
  check('снятую задачу офис не раздаёт', !took().includes(dropped.id));

  // Зависимые снимаются вместе: без результата этой задачи делать их нечего.
  const base = add({ title: 'Основа', status: 'backlog' });
  const next = add({ title: 'Следом', status: 'planned', dependsOn: [base.id] });
  const last = add({ title: 'И следом за ним', status: 'planned', dependsOn: [next.id] });
  const chain = dropTask(office, base.id, 'отказались от направления');
  check('снятие с цепочкой принято', chain.ok);
  check('прямой зависимый снят', office.tasks.get(next.id)?.status === 'cancelled');
  check('дальний зависимый снят тоже', office.tasks.get(last.id)?.status === 'cancelled');
  check('в ответе перечислены снятые следом', chain.message.includes(next.id));

  // Задача на ревью: пока конвейер едет — снимать поздно, а вставший конвейер
  // ждёт ответа человека, и «снять» — такой же ответ, как «слить» или «на
  // доработку». Без него ветка, которую обогнала соседняя задача, оставалась
  // на доске навсегда: и кнопка, и инструмент менеджера отвечали отказом.
  const onReview = add({ title: 'Сдана и идёт по ревью' });
  office.updateTask(onReview.id, { status: 'review' });
  office.startPr({
    taskId: onReview.id, title: onReview.title,
    branch: `task/${onReview.id}`, base: 'main', repoDir: '/tmp/нет',
  });
  check('пока конвейер едет, снимать нельзя', !dropTask(office, onReview.id).ok);
  office.patchPr(onReview.id, { stage: 'stuck' });
  const stuckDrop = dropTask(office, onReview.id, 'дубль: работа уже на main');
  check('вставшую на ревью задачу снять можно', stuckDrop.ok);
  check('снятая с ревью закрыта', office.tasks.get(onReview.id)?.status === 'cancelled');
  check('исход снятой с ревью — «снята»',
    office.tasks.get(onReview.id)?.outcome?.kind === 'cancelled');
  // Конвейер снятой задачи закрыт: ни review_status, ни планёрка не держат
  // её «вставшей» — снять второй раз уже нельзя, и решать там нечего (T-507).
  check('конвейер снятой с ревью закрыт', office.prOf(onReview.id)?.stage === 'dropped');
  check('снятая не в списке вставших', !stuckPrs(office).some((p) => p.taskId === onReview.id));
  const statusLine = reviewStatusText(office.prs.values(), {}, 'ru')
    .split('\n').find((l) => l.startsWith(onReview.id)) ?? '';
  check('review_status не зовёт снятую вставшей', !statusLine.includes('ВСТАЛО'));
  check('в планёрке снятой нет', !standupText(office).includes(onReview.id));

  // Снятие на ходу: живой сессии в проверке нет, и задача закрывается сразу.
  const onTheFly = add({ title: 'Уже в работе' });
  office.updateTask(onTheFly.id, { status: 'in_progress', assigneeId: 'backend#1' });
  const flyDrop = dropTask(office, onTheFly.id);
  check('идущую задачу снять можно', flyDrop.ok);
  check('снятая на ходу закрыта', office.tasks.get(onTheFly.id)?.status === 'cancelled');

  // А с живой сессией задачу закрывает не снятие, а конец прерванной сессии:
  // сперва её надо оборвать, иначе исполнитель продолжит работать в фоне.
  const live = add({ title: 'Снимаем у живого исполнителя' });
  const worker = office.findFree('backend') ?? office.spawn('backend');
  if (!worker) throw new Error('некому отдать задачу: роль backend пуста');
  let aborted = false;
  worker.currentTaskId = live.id;
  worker.abort = { abort: () => { aborted = true; } } as AbortController;
  office.updateTask(live.id, { status: 'in_progress', assigneeId: worker.id });
  const liveDrop = dropTask(office, live.id);
  check('снятие живой задачи принято', liveDrop.ok);
  check('сессию исполнителя оборвали', aborted);
  check('задача помечена к снятию', office.cancelledByUser.has(live.id));
  check('но ещё не закрыта — её закроет конец сессии',
    office.tasks.get(live.id)?.status === 'in_progress');

  const inReview = add({ title: 'Сдана на ревью' });
  office.updateTask(inReview.id, { status: 'review', branch: 'task/T-x' });
  check('сданную на ревью снимать поздно', !dropTask(office, inReview.id).ok);

  // ------------------------------------------------------------- перезапуск
  // Перезапуск — второй конец правки: переписал остановленную задачу, и её
  // надо чем-то двинуть. Живых сессий здесь нет, поэтому проверяем отказы —
  // те самые, из-за которых менеджер иначе решил бы, что задача поехала.
  const chatBefore = office.chat.length;
  const goneRestart = await retryTask(office, 'T-404', { quiet: true });
  check('перезапуск несуществующей отклонён', !goneRestart.ok);
  check('в отказе назван id', goneRestart.message.includes('T-404'));
  check('снятую перезапускать нельзя', !(await retryTask(office, dropped.id, { quiet: true })).ok);
  check('слитую перезапускать нельзя', !(await retryTask(office, closed.id, { quiet: true })).ok);
  check('тихий отказ не сыплется в ленту офиса', office.chat.length === chatBefore);

  const loud = await retryTask(office, dropped.id);
  check('обычный отказ ленту не обходит', !loud.ok && office.chat.length > chatBefore);

  // ---------------------------------------------------------------- удаление
  const spare = add({ title: 'Завели по ошибке' });
  const dependant = add({ title: 'Ждёт лишнюю', status: 'planned', dependsOn: [spare.id] });
  const wiped = deleteTask(office, spare.id);
  check('нетронутая задача стирается', wiped.ok);
  check('её больше нет на доске', !office.tasks.has(spare.id));
  check('ссылка на неё убрана у соседа',
    office.tasks.get(dependant.id)?.dependsOn.includes(spare.id) === false);
  check('в ответе названы задачи, у которых убрали зависимость',
    wiped.message.includes(dependant.id));

  const withBranch = add({ title: 'За ней ветка' });
  office.updateTask(withBranch.id, { branch: 'task/T-9' });
  check('задачу с веткой стереть нельзя', !deleteTask(office, withBranch.id).ok);
  check('но снять можно', dropTask(office, withBranch.id).ok);
  check('снятую стереть тоже нельзя', !deleteTask(office, withBranch.id).ok);

  const spent = add({ title: 'На неё потратились' });
  office.updateTask(spent.id, {
    usage: { costUsd: 0.42, tokensIn: 10, tokensOut: 10, cacheRead: 0, cacheWrite: 0 },
  });
  check('задачу, на которую потратились, стереть нельзя', !deleteTask(office, spent.id).ok);
  check('несуществующую задачу стереть нельзя', !deleteTask(office, 'T-404').ok);

  // ---------------------------------------------------------------- чат задачи
  // Сообщения офиса о задаче ложатся в чат, где её завели (T-144), а не в
  // основной: иначе владелец видит ответ менеджера в одном чате, а «переписана»
  // и «снята» — в другом.
  const main = office.ensureMainChat();
  const side = office.createPmChat('Сторонний');
  const lastIn = (chatId: string): string =>
    [...office.chat].reverse().find((e) => e.thread === 'pm#1' && e.chatId === chatId)?.text ?? '';
  const inSide = add({ title: 'Заведена в стороннем' });
  office.updateTask(inSide.id, { chatId: side.id });
  editTask(office, inSide.id, { title: 'Переписана в стороннем' });
  check('правка — в чат задачи', lastIn(side.id).includes(inSide.id));
  check('правка — не в основной', !lastIn(main.id).includes(inSide.id));
  office.archivePmChat(side.id, true);
  dropTask(office, inSide.id, 'не нужна');
  check('снятие — в архивный чат задачи', lastIn(side.id).includes('не нужна'));
  const sideDeleted = add({ title: 'Стирается' });
  office.updateTask(sideDeleted.id, { chatId: side.id });
  deleteTask(office, sideDeleted.id);
  check('удаление — в чат задачи', lastIn(side.id).includes(sideDeleted.id));
  const loose = add({ title: 'Без чата' });
  editTask(office, loose.id, { title: 'Без чата, переписана' });
  check('без привязки — в основной', lastIn(main.id).includes(loose.id));
  const orphan = add({ title: 'Чат пропал' });
  office.updateTask(orphan.id, { chatId: 'C-404' });
  editTask(office, orphan.id, { title: 'Чат пропал, переписана' });
  check('с пропавшим чатом — в основной', lastIn(main.id).includes(orphan.id));

  // Снятые до T-507: задача уже «снята», а конвейер так и остался вставшим.
  // Миграция при загрузке закрывает его, задачу и ветку не трогая.
  const zombie = add({ title: 'Снята, а конвейер стоит' });
  office.startPr({
    taskId: zombie.id, title: zombie.title,
    branch: `task/${zombie.id}`, base: 'main', repoDir: '/tmp/нет',
  });
  office.patchPr(zombie.id, { stage: 'stuck', needsDecision: true, note: 'конфликт' });
  office.updateTask(zombie.id, { status: 'cancelled', branch: `task/${zombie.id}` });
  check('до миграции зомби в списке вставших', stuckPrs(office).some((p) => p.taskId === zombie.id));
  const savedFile = resolve(tmpdir(), `office-tasks-state-${process.pid}.json`);
  writeFileSync(savedFile, JSON.stringify(office.toPersisted()));
  const reload = (id: string) => {
    const state = getOffice(id);
    state.setStateFile(savedFile);
    state.projectDir = office.projectDir;
    return { state, ok: state.restore() };
  };
  const { state: again, ok: restored } = reload('o-tasks-restore');
  check('состояние поднялось с диска', restored);
  check('после загрузки конвейер зомби закрыт', again.prOf(zombie.id)?.stage === 'dropped');
  check('и решения не ждёт', again.prOf(zombie.id)?.needsDecision === false);
  check('задача осталась снятой', again.tasks.get(zombie.id)?.status === 'cancelled');
  check('ветка на месте', again.tasks.get(zombie.id)?.branch === `task/${zombie.id}`);
  check('после загрузки зомби не в списке вставших', !stuckPrs(again).some((p) => p.taskId === zombie.id));
  check('и в планёрке его нет', !standupText(again).includes(zombie.id));
  const zombieLine = reviewStatusText(again.prs.values(), { all: true }, 'ru')
    .split('\n').find((l) => l.startsWith(zombie.id)) ?? '';
  check('review_status не зовёт зомби вставшим', zombieLine !== '' && !zombieLine.includes('ВСТАЛО'));
  // Идемпотентность: закрытый конвейер вторая загрузка не трогает.
  writeFileSync(savedFile, JSON.stringify(again.toPersisted()));
  unloadOfficeState('o-tasks-restore');
  const { state: third } = reload('o-tasks-restore-2');
  check('повторная загрузка ничего не меняет',
    third.prOf(zombie.id)?.stage === 'dropped'
    && third.prOf(zombie.id)?.updatedAt === again.prOf(zombie.id)?.updatedAt);
  unloadOfficeState('o-tasks-restore-2');
  rmSync(savedFile, { force: true });

  unloadOfficeState('o-tasks');

  // Прошедшей считается только строка, кончающаяся на true: строка, где вместо
  // булева оказалось undefined, — это не «не false», а несостоявшаяся проверка.
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

void main().catch((err) => {
  console.error(`прогон сорвался: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(2);
});

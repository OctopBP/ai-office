/**
 * Надзор за конвейером: офис сам следит, что сданная работа доезжает до
 * основной ветки, и сам её подталкивает.
 *
 * Зачем отдельный сторож. Конвейер (review.ts) ведёт задачу только с момента
 * сдачи и только пока идёт: если он встал — из-за занятого исполнителя,
 * уехавшей базы, оборвавшейся сессии, перезапуска сервера, — дальше он ждёт,
 * пока кто-нибудь нажмёт «попробовать снова». А ждать некому: пользователь
 * не должен следить за ветками, ради этого всё и затевалось.
 *
 * Поэтому раз в минуту офис смотрит сам:
 * - есть сданные задачи со своей веткой, которых никто не ведёт (их сделали
 *   до появления конвейера, при выключенном конвейере или во время падения) —
 *   заводит их в конвейер;
 * - есть вставшие пулл-реквесты, которые могли встать по проходящей причине —
 *   перезапускает их с растущей паузой, а не долбит подряд;
 * - попытки кончились или причина не механическая — один раз зовёт менеджера
 *   и больше не дёргает никого.
 *
 * Тем же проходом офис смотрит и на саму доску — потому что встать может не
 * только слияние:
 * - задачу завели и не раздали (менеджер отвлёкся, все были заняты) — она
 *   стоит в очереди вечно, и заметить это некому;
 * - работу оборвал перезапуск сервера — сессия умерла вместе с процессом,
 *   задача осталась заблокированной навсегда;
 * - задача провалилась — о ней сказали менеджеру один раз в момент падения,
 *   и если он тогда ничего не сделал, больше о ней не вспомнит никто.
 *
 * Пользователя надзор не зовёт никогда: его дело — сказать, что нужно сделать,
 * а не следить, дошло ли.
 */
import type { PullRequestView } from '../shared/types';
import { office, type OfficeState, type Task } from './state';
import { pipelineProblem, runPipeline, tellPm } from './review';
import { officeAssign, retryTask, slotProblem } from './agents';

/** Как часто офис оглядывается на свои ветки. */
const TICK_MS = 60_000;

/**
 * Паузы перед повторными попытками. Растут: первая беда чаще всего проходящая
 * (кто-то был занят), а если не прошла с третьего раза — дело не во времени.
 */
const BACKOFF_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000];

/**
 * Сколько задач заводим в конвейер за один проход. Копившиеся неделями ветки
 * не нужно запускать все разом: каждая — это сессии исполнителя и ревьюера,
 * и толпа из двадцати задач просто выстроится в очередь, заняв весь офис.
 */
const START_PER_TICK = 2;

/** Сколько задача стоит в очереди, прежде чем офис заговорит о ней с менеджером. */
const IDLE_BACKLOG_MS = 5 * 60_000;

/**
 * Сколько ждём реакции менеджера, прежде чем раздать задачу самим. Менеджеру
 * даём походить первым не из вежливости: он знает порядок задач и зависимости
 * между ними, а надзор — нет. Но если он молчит, работа всё равно должна пойти.
 */
const PM_GRACE_MS = 10 * 60_000;

/** Сколько провалившихся задач показываем менеджеру в одном сообщении. */
const FAILED_BATCH = 8;

const clip = (s: string, n = 90): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/**
 * Таймеры надзора за офисом: отложенный первый проход и все дальнейшие.
 * Держим оба вместе, потому что гасить их надо тоже вместе — офис успевают
 * выгрузить раньше, чем дотикает первый проход.
 */
interface Watch {
  interval: NodeJS.Timeout;
  kickoff: NodeJS.Timeout;
}

const timers = new Map<string, Watch>();

/** Задачи, которые надзор ведёт: сданы, ветка своя, в основную не влиты. */
function unfinished(state: OfficeState): Task[] {
  return [...state.tasks.values()].filter((t) => (
    !t.merged && t.branch && t.baseBranch
    && (t.status === 'done' || t.status === 'review')
  ));
}

/** Один проход надзора. Вынесен отдельно ради тестов: их не заставишь ждать минуту. */
export async function superviseOffice(state: OfficeState = office): Promise<void> {
  if (!state.settings.autoPipeline || state.paused) return;

  const now = Date.now();

  // 1. Вставшие пулл-реквесты, которым пора попробовать снова.
  for (const pr of [...state.prs.values()]) {
    if (pr.stage !== 'stuck' || pr.needsDecision) continue;
    const task = state.tasks.get(pr.taskId);
    if (!task || task.merged) continue;

    if (pr.retries >= BACKOFF_MS.length) {
      giveUp(state, task, pr);
      continue;
    }
    if (pr.nextTryAt && now < pr.nextTryAt) continue;

    const retries = pr.retries + 1;
    state.patchPr(pr.taskId, {
      retries,
      // Время СЛЕДУЮЩЕЙ попытки ставим сразу: попытка идёт минутами, а
      // следующий проход не должен запустить её второй раз.
      nextTryAt: now + BACKOFF_MS[Math.min(retries, BACKOFF_MS.length - 1)],
      note: `${pr.note}\nОфис пробует снова сам (попытка ${retries} из ${BACKOFF_MS.length}).`,
    });
    state.addLog(null, 'system', `${pr.taskId}: надзор перезапускает конвейер, попытка ${retries}`);
    void runPipeline(state, pr.taskId);
  }

  // 2. Сданные задачи, которых никто не ведёт: заводим в конвейер сами.
  const orphans = unfinished(state)
    .filter((t) => !state.prOf(t.id))
    .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));

  let started = 0;
  for (const task of orphans) {
    if (started >= START_PER_TICK) break;
    if (await pipelineProblem(state, task)) continue;
    started += 1;
    state.addLog(null, 'system', `${task.id}: надзор нашёл незаведённую ветку и повёл её на ревью`);
    void runPipeline(state, task.id);
  }

  if (started && orphans.length > started) {
    state.addLog(null, 'system',
      `Осталось незаведённых веток: ${orphans.length - started} — возьму их следующими проходами.`);
  }

  await watchBoard(state, now);
}

/**
 * Доска не должна стоять. Три вида застоя, и у каждого свой ответ:
 * прерванную перезапуском задачу офис возобновляет сам, стоящую в очереди
 * сначала показывает менеджеру, а потом раздаёт сам, про провалившуюся —
 * рассказывает менеджеру ровно один раз.
 */
async function watchBoard(state: OfficeState, now: number): Promise<void> {
  const tasks = [...state.tasks.values()];
  let started = 0;

  // 1. Работу оборвал перезапуск — это не решение человека, а авария.
  for (const task of tasks.filter((t) => t.status === 'blocked' && t.interrupted)) {
    if (started >= START_PER_TICK) break;
    // Свободного исполнителя ждём молча: retryTask на занятой роли напишет
    // в чат отказ, и на каждом проходе это был бы один и тот же шум.
    if (!state.findFree(task.roleId ?? 'backend')) continue;
    // Ровно по той же причине молча ждём и свободный слот: на потолке
    // одновременных исполнителей возобновлять нечего, а строка в ленте
    // раз в минуту — это шум, а не сообщение.
    if (slotProblem(state)) continue;
    started += 1;
    state.addChat('офис', `${task.id}: работу оборвал перезапуск — возобновляю, сделанное сохранено в ветке.`);
    await retryTask(state, task.id);
  }

  // 2. Задачи, которые завели и не раздали.
  const queued = tasks.filter((t) => t.status === 'backlog');
  const unseen = queued.filter((t) => !t.attention && now - t.createdAt > IDLE_BACKLOG_MS);
  if (unseen.length) {
    for (const t of unseen) state.updateTask(t.id, { attention: now });
    tellPm(state,
      `[СИСТЕМА] На доске стоят задачи, которые никто не выполняет:\n` +
      unseen.map((t) => `${t.id} «${t.title}» (роль ${t.roleId ?? '—'})`).join('\n') +
      '\nРаздай их сами (assign_task) или закрой как неактуальные. Если ждёшь другую задачу — ' +
      `так и скажи в ответ; через ${Math.round(PM_GRACE_MS / 60000)} минут офис раздаст их сам.`);
  }

  const overdue = queued.filter((t) => t.attention && now - t.attention > PM_GRACE_MS);
  for (const task of overdue) {
    if (started >= START_PER_TICK) break;
    const outcome = officeAssign(state, task.id);
    if (!outcome.ok) {
      // Не вышло — ждём следующего окна, а не долбим каждую минуту.
      state.updateTask(task.id, { attention: now });
      state.addLog(null, 'system', `${task.id}: раздать не вышло — ${outcome.message}`);
      continue;
    }
    started += 1;
    state.addChat('офис', `${task.id}: стояла в очереди — отдал ${outcome.message}.`);
    tellPm(state,
      `[СИСТЕМА] Задача ${task.id} «${task.title}» стояла в очереди, и офис отдал её ${outcome.message}. ` +
      'Учти это в планах: раздавать её второй раз не нужно.');
  }

  // 3. Провалившиеся: один раз показываем менеджеру и больше не вспоминаем.
  const failed = tasks.filter((t) => t.status === 'failed' && !t.attention);
  if (failed.length) {
    for (const t of failed) state.updateTask(t.id, { attention: now });
    const shown = failed.slice(0, FAILED_BATCH);
    tellPm(state,
      '[СИСТЕМА] На доске лежат провалившиеся задачи, и никто ими не занимается:\n' +
      shown.map((t) => `${t.id} «${t.title}» — ${clip(t.result ?? 'без причины')}`).join('\n') +
      (failed.length > shown.length ? `\n…и ещё ${failed.length - shown.length}.` : '') +
      '\nРазбери их сам: что ещё нужно — поставь заново (можно меньшими кусками, если задача ' +
      'не влезла в лимит ходов), что устарело — оставь как есть. Не перезапускай всё подряд: ' +
      'это стоит денег. Пользователю пиши, только если нужен он сам (поднять лимит трат, нанять).');
  }
}

/**
 * Попытки кончились. Дальше не гадаем и не крутим круги: один раз говорим
 * менеджеру, что именно не поехало, и перестаём трогать этот пулл-реквест.
 */
function giveUp(state: OfficeState, task: Task, pr: PullRequestView): void {
  state.patchPr(task.id, {
    needsDecision: true,
    nextTryAt: null,
    note: `${pr.note}\nОфис пробовал сам ${pr.retries} раза — не поехало. Жду решения менеджера.`,
  });
  state.addChat('офис',
    `${task.id}: сам не разобрался за ${pr.retries} попытки — передал менеджеру.`);
  tellPm(state,
    `[СИСТЕМА] Задача ${task.id} «${task.title}» так и не доехала до ${pr.base}. ` +
    `Офис пробовал провести её сам ${pr.retries} раза, причина последней остановки:\n${pr.note}\n` +
    'Дальше решай ты и делай это сам: поставь задачу на исправление и назначь её, ' +
    'переформулируй эту или отдай другой роли. Пользователя дёргай, только если нужно ' +
    'то, чего никто в офисе сделать не может (нанять сотрудника, поднять бюджет), — ' +
    'и тогда скажи одной фразой, что именно от него нужно.');
}

/**
 * Включить надзор для офиса. Первый проход — сразу: после перезапуска сервера
 * незаведённые ветки и оборванные конвейеры должны поехать без чьей-либо кнопки.
 */
export function startSupervisor(state: OfficeState = office): void {
  stopSupervisor(state.officeId);
  const tick = () => {
    void superviseOffice(state).catch((err) => {
      state.addLog(null, 'error', `Надзор за конвейером споткнулся: ${(err as Error).message}`);
    });
  };
  const interval = setInterval(tick, TICK_MS);
  // Не держим процесс живым ради сторожа: он обслуживает работу, а не наоборот.
  interval.unref?.();
  const kickoff = setTimeout(tick, 3000);
  kickoff.unref?.();
  timers.set(state.officeId, { interval, kickoff });
}

export function stopSupervisor(officeId: string): void {
  const watch = timers.get(officeId);
  if (!watch) return;
  clearInterval(watch.interval);
  // Первый проход отложен на несколько секунд, и снять его обязательно:
  // иначе выгруженный офис просыпался бы уже после того, как его убрали, —
  // с сессиями, конвейером и походами в git.
  clearTimeout(watch.kickoff);
  timers.delete(officeId);
}

/**
 * Следит ли офис за своим конвейером прямо сейчас. Нужно тем, кто гасит офис
 * целиком: «надзор остановлен» — такая же часть выгрузки, как закрытые сессии.
 */
export function isSupervised(officeId: string): boolean {
  return timers.has(officeId);
}

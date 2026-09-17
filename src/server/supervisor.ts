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
 *   и если он тогда ничего не сделал, больше о ней не вспомнит никто;
 * - исполнителя отбил лимит плана подписки — задача стоит не по ошибке и не
 *   по чьему-то решению, а до сброса окна. Офис раз в час смотрит, наступил
 *   ли сброс, а когда наступил — зовёт менеджера продолжить работу с того же
 *   места; молчит менеджер — продолжает сам.
 *
 * Пользователя надзор не зовёт никогда: его дело — сказать, что нужно сделать,
 * а не следить, дошло ли.
 */
import type { PullRequestView } from '../shared/types';
import { OFFICE_SENDER } from '../shared/types';
import { criticalEnvFail, type OfficeState, type Task } from './state';
import { refreshEnvChecks } from './envcheck';
import { isPipelineRunning, pipelineProblem, runPipeline, tellPm } from './review';
import { officeAssign, resumeTask, retryTask, slotProblem } from './agents';
import { limitBlock, resetClock } from './limits';
import { dispatch } from './plan';
import { detectReverts } from './outcomes';
import { askAboutReverts, tickRituals } from './rituals';
import { refreshHealth } from './health';
import { tickFlows } from './flows';

/** Как часто офис оглядывается на свои ветки. */
const TICK_MS = 60_000;

/** Как часто ходим в git за откатами: они не горят, а проверка не бесплатна. */
const REVERT_CHECK_MS = 10 * 60_000;
/** Когда по каждому офису последний раз искали откаты. */
const revertChecks = new Map<string, number>();

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

/**
 * Как часто офис проверяет, не сброшен ли лимит плана, пока задачи стоят из-за
 * него. Сброс по названному SDK времени замечается сразу, на минутном тике;
 * час — это шаг, с которым офис говорит об ожидании вслух и пробует снова,
 * когда времени сброса SDK не назвал.
 */
const LIMIT_CHECK_MS = 60 * 60_000;
/** Когда по каждому офису последний раз проверяли лимит. */
const limitChecks = new Map<string, number>();

/** Забыть, когда проверяли лимит, — только для тестов. */
export function forgetLimitChecks(): void {
  limitChecks.clear();
}

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
export async function superviseOffice(state: OfficeState): Promise<void> {
  // Сводка здоровья — до всех проверок и до паузы: часть её записей появляется
  // не от события, а просто от времени (ветке стукнули сутки), а офис на паузе
  // или с выключенным конвейером стоит тем более и знать об этом нужно.
  refreshHealth(state, Date.now());

  // Окружение чинят мимо офиса: ключ кладут в переменную, директорию создают
  // руками. Пока критичная проверка красная, офис не берёт задачи, и узнать о
  // починке ему неоткуда — поэтому раз в минуту ходим и смотрим сами.
  // Позеленевшая проверка отпустит очередь через onEnvReady. Когда всё
  // зелено, не ходим вовсе: лишний git на каждом тике ни к чему.
  if (criticalEnvFail(state.env.checks)) await refreshEnvChecks(state);

  if (!state.settings.autoPipeline || state.paused) return;

  const now = Date.now();

  // Лимит плана закрыт — сессии не поднимаем: любая упёрлась бы в него же,
  // а перезапуск конвейера ещё и сжёг бы попытку из трёх впустую. Задачи,
  // вставшие по лимиту, ждут его сброса отдельно (watchLimits).
  const limited = await watchLimits(state, now);

  // 1. Вставшие пулл-реквесты, которым пора попробовать снова.
  for (const pr of limited ? [] : [...state.prs.values()]) {
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
      note: state.say('sup.retryNote', {
        note: pr.note, n: retries, max: BACKOFF_MS.length,
      }),
    });
    state.addLog(null, 'system', state.say('sup.retryLog', { task: pr.taskId, n: retries }));
    void runPipeline(state, pr.taskId);
  }

  // 2. Сданные задачи, которых никто не ведёт: заводим в конвейер сами.
  const orphans = unfinished(state)
    .filter((t) => !state.prOf(t.id))
    .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));

  let started = 0;
  for (const task of limited ? [] : orphans) {
    if (started >= START_PER_TICK) break;
    if (await pipelineProblem(state, task)) continue;
    started += 1;
    state.addLog(null, 'system', state.say('sup.orphanLog', { task: task.id }));
    void runPipeline(state, task.id);
  }

  if (started && orphans.length > started) {
    state.addLog(null, 'system', state.say('sup.orphansLeft', { n: orphans.length - started }));
  }

  // 3. Прогоны, стоявшие на согласовании в момент перезапуска: вопрос
  // владельцу никуда не делся, но ждать его ответа уже некому — возвращаем
  // прогон к его узлу, и тот ждёт дальше.
  for (const run of [...state.runs.values()]) {
    if (run.status !== 'waiting' || !run.subject.taskId) continue;
    if (isPipelineRunning(state, run.subject.taskId)) continue;
    state.addLog(null, 'system', state.say('sup.resumeWaiting', { task: run.subject.taskId }));
    void runPipeline(state, run.subject.taskId);
  }

  if (!limited) await watchBoard(state, now);

  // 3½. Откаты: слитую работу человек мог выбросить руками, и офис узнаёт об
  // этом только так. Ходить в git ради этого раз в минуту незачем — раз в
  // десять хватает: откат не горит, а исход задачи от этого не изменится.
  const lastReverts = revertChecks.get(state.officeId) ?? 0;
  if (now - lastReverts > REVERT_CHECK_MS) {
    revertChecks.set(state.officeId, now);
    askAboutReverts(state, await detectReverts(state, now));
  }

  // 3¾. Ритуалы — на тихом тике. Тем же проходом, что и всё остальное:
  // второго таймера в офисе не будет.
  await tickRituals(state, now);
  // Процессы по состоянию — «что дальше» на пустой доске. Не ждём: совещание
  // длится минутами, а надзору пора смотреть на ветки.
  tickFlows(state, now);

  // 4. План. Проход плана дублирует то, что и так делается по событиям
  // (завершилась задача, влилась ветка, согласовали фичу), — и он здесь
  // именно как подстраховка: событие могло не случиться из-за перезапуска
  // сервера или упавшей сессии, а план от этого стоять не должен.
  if (!limited) dispatch(state);
}

/**
 * Задачи, вставшие по лимиту плана. Возвращает, закрыт ли лимит прямо сейчас:
 * пока закрыт, остальному надзору делать нечего.
 *
 * Пока окно закрыто и время сброса известно — ничего не пробуем, раз в час
 * говорим в чат, чего ждём. Время неизвестно — раз в час пробуем: другого
 * способа узнать нет, а отбитый запрос ничего не стоит. Сброс наступил —
 * зовём менеджера: продолжить работу его дело, он знает, что из вставшего
 * ещё нужно. Молчит — продолжаем сами, как и с нерозданными задачами.
 */
async function watchLimits(state: OfficeState, now: number): Promise<boolean> {
  const halted = [...state.tasks.values()]
    .filter((t) => t.status === 'blocked' && t.limitedAt)
    .sort((a, b) => (a.limitedAt ?? 0) - (b.limitedAt ?? 0));
  const block = limitBlock(now);
  if (!halted.length) return Boolean(block);

  const last = limitChecks.get(state.officeId) ?? 0;
  const due = now - last >= LIMIT_CHECK_MS;
  const ids = halted.map((t) => t.id).join(', ');

  if (block?.resetsAt) {
    if (due) {
      limitChecks.set(state.officeId, now);
      state.addChat(OFFICE_SENDER, state.say('sup.limitWaiting', {
        tasks: ids, at: resetClock(block.resetsAt, state.lang(), now),
      }));
    }
    return true;
  }
  if (block) {
    if (!due) return true;
    state.addChat(OFFICE_SENDER, state.say('sup.limitProbe', { tasks: ids }));
  }
  limitChecks.set(state.officeId, now);

  // Сначала менеджер: раз в сброс, а не на каждом проходе.
  const unseen = halted.filter((t) => !t.attention);
  if (unseen.length) {
    for (const t of unseen) state.updateTask(t.id, { attention: now });
    if (!block) {
      state.addChat(OFFICE_SENDER, state.say('sup.limitReset', {
        tasks: ids, minutes: Math.round(PM_GRACE_MS / 60000),
      }));
    }
    tellPm(state, state.say('sup.pmLimitReset', {
      tasks: unseen.map((t) => `${t.id} «${t.title}» (${t.assigneeId ?? t.roleId ?? '—'})`).join('\n'),
      minutes: Math.round(PM_GRACE_MS / 60000),
    }));
  }

  // Менеджер промолчал — продолжаем сами, по паре за проход.
  const overdue = halted.filter((t) => t.attention && now - t.attention > PM_GRACE_MS);
  let started = 0;
  for (const task of overdue) {
    if (started >= START_PER_TICK) break;
    const outcome = resumeTask(state, task.id);
    if (!outcome.ok) {
      state.updateTask(task.id, { attention: now });
      state.addLog(null, 'system', state.say('sup.resumeFailed', { task: task.id, problem: outcome.message }));
      continue;
    }
    started += 1;
    state.addChat(OFFICE_SENDER, state.say('sup.limitResumed', { task: task.id, who: outcome.message }));
    tellPm(state, state.say('sup.limitResumedPm', {
      task: task.id, title: task.title, who: outcome.message,
    }));
  }
  return false;
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
    state.addChat(OFFICE_SENDER, state.say('sup.resumed', { task: task.id }));
    await retryTask(state, task.id);
  }

  // 2. Задачи, которые завели и не раздали. Стоящие в очереди за слотом сюда
  // не попадают: офис уже пообещал их запустить, и напоминать о них менеджеру
  // значит звать его чинить то, что и так едет.
  const queued = tasks.filter((t) => t.status === 'backlog' && !state.waitingForSlot.has(t.id));
  const unseen = queued.filter((t) => !t.attention && now - t.createdAt > IDLE_BACKLOG_MS);
  if (unseen.length) {
    for (const t of unseen) state.updateTask(t.id, { attention: now });
    tellPm(state, state.say('sup.pmUnassigned', {
      tasks: unseen.map((t) => `${t.id} «${t.title}» (${t.roleId ?? '—'})`).join('\n'),
      minutes: Math.round(PM_GRACE_MS / 60000),
    }));
  }

  const overdue = queued.filter((t) => t.attention && now - t.attention > PM_GRACE_MS);
  for (const task of overdue) {
    if (started >= START_PER_TICK) break;
    const outcome = officeAssign(state, task.id);
    if (!outcome.ok) {
      // Не вышло — ждём следующего окна, а не долбим каждую минуту.
      state.updateTask(task.id, { attention: now });
      state.addLog(null, 'system',
        state.say('sup.assignFailed', { task: task.id, problem: outcome.message }));
      continue;
    }
    started += 1;
    state.addChat(OFFICE_SENDER,
      state.say('sup.assignedChat', { task: task.id, who: outcome.message }));
    tellPm(state, state.say('sup.assignedPm', {
      task: task.id, title: task.title, who: outcome.message,
    }));
  }

  // 3. Провалившиеся: один раз показываем менеджеру и больше не вспоминаем.
  const failed = tasks.filter((t) => t.status === 'failed' && !t.attention);
  if (failed.length) {
    for (const t of failed) state.updateTask(t.id, { attention: now });
    const shown = failed.slice(0, FAILED_BATCH);
    tellPm(state, state.say('sup.pmFailed', {
      tasks: shown.map((t) => `${t.id} «${t.title}» — ${clip(t.result ?? '—')}`).join('\n'),
      more: failed.length > shown.length
        ? state.say('sup.pmFailedMore', { n: failed.length - shown.length })
        : '',
    }));
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
    note: state.say('sup.giveUpNote', { note: pr.note, n: pr.retries }),
  });
  state.addChat(OFFICE_SENDER,
    state.say('sup.giveUpChat', { task: task.id, n: pr.retries }));
  tellPm(state, state.say('sup.giveUpPm', {
    task: task.id, title: task.title, base: pr.base, n: pr.retries, note: pr.note,
  }));
}

/**
 * Включить надзор для офиса. Первый проход — сразу: после перезапуска сервера
 * незаведённые ветки и оборванные конвейеры должны поехать без чьей-либо кнопки.
 */
export function startSupervisor(state: OfficeState): void {
  stopSupervisor(state.officeId);
  const tick = () => {
    void superviseOffice(state).catch((err) => {
      state.addLog(null, 'error', state.say('sup.crashed', { error: (err as Error).message }));
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

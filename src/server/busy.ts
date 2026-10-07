/**
 * Занят ли офис прямо сейчас — для предупреждения перед перезапуском
 * приложения в новую версию (desktop/updater.js спрашивает `/api/busy`).
 *
 * Раньше это считалось по `activity.live`, а туда попадает и цикл сессии
 * менеджера, который живёт между сообщениями и ничего не делает. Поэтому
 * приложение писало «обновится, когда задачи закончатся» в офисе, где не
 * шло ни одной задачи. «Занят» здесь — только то, что перезапуск правда
 * оборвёт: задача в статусе assigned или in_progress, идущая сессия
 * исполнителя (в том числе ревью и доработка конвейера), ход менеджера,
 * совещание, конвейер задачи, очередь слияния, выпуск.
 *
 * Не работа: свободные исполнители, задачи в остальных статусах (failed,
 * cancelled, review, done и прочие), простаивающий менеджер, ритуалы на
 * тихом тике, вопросы владельцу, а также конвейер или выпуск, которые стоят
 * на вопросе владельцу (`waiting`) или встали (`stuck`). Последнее и давало
 * ложное «В офисе идёт работа» на пустой доске (T-435, T-436):
 * `runningPipelines` и `runningReleases` считали любой прогон, чей промис
 * ещё жив, а прогон на узле согласования живёт, пока владелец не ответит.
 *
 * Решение — чистая функция от снимка: снимок собирает `officeWork` в
 * index.ts, а проверяется функция отдельно (`npm run test:busy`). Вместе с
 * ответом уходят причины — приложение пишет их в свой лог, чтобы было видно,
 * что именно посчитано работой.
 */

/** Что прямо сейчас идёт в одном офисе. */
export interface WorkSnapshot {
  /** Задачи в статусе assigned или in_progress — их id. */
  tasks: string[];
  /** Живые сессии исполнителей — занятые слоты (`state.running`). */
  workers: number;
  /** Чаты менеджера, где он сейчас отвечает (`PmSession.busy`), а не ждёт сообщения. */
  pmTurns: number;
  /** Совещание идёт. */
  meeting: boolean;
  /** Конвейеры задач (ревью → слияние), которые идут прямо сейчас и не ждут владельца. */
  pipelines: number;
  /** Ручная очередь слияния идёт. */
  mergeQueue: boolean;
  /** Выпуски, которые идут прямо сейчас и не ждут владельца. */
  releases: number;
}

/**
 * Сколько из идущих прогонов (конвейеров или выпусков) правда работает.
 * Прогон, который стоит на вопросе владельцу («Согласовано?», «Выпускай?»,
 * статус `waiting`), ничего не делает: он ждёт ответа и после перезапуска
 * продолжит с того же узла. Встал (`stuck`) — тоже ничего не делает.
 * Раньше такой прогон считался работой, и выпуск, ждущий «Выпускай», держал
 * «В офисе идёт работа» часами на пустой доске (T-435). Прогона ещё нет
 * (`null`) — конвейер только стартует: это работа.
 */
export function countWorking(runs: ({ status: string } | null)[]): number {
  return runs.filter((run) => run?.status !== 'waiting' && run?.status !== 'stuck').length;
}

/** Что именно в снимке посчитано работой — пусто, если офис свободен. */
export function workReasons(s: WorkSnapshot): string[] {
  const reasons: string[] = [];
  if (s.tasks.length) reasons.push(`задачи в работе: ${s.tasks.join(', ')}`);
  if (s.workers > 0) reasons.push(`сессии исполнителей: ${s.workers}`);
  if (s.pmTurns > 0) reasons.push(`ход менеджера: ${s.pmTurns}`);
  if (s.meeting) reasons.push('идёт совещание');
  if (s.pipelines > 0) reasons.push(`конвейеры задач: ${s.pipelines}`);
  if (s.mergeQueue) reasons.push('идёт очередь слияния');
  if (s.releases > 0) reasons.push(`выпуски: ${s.releases}`);
  return reasons;
}

/** Занят ли офис по снимку. */
export function isWorking(s: WorkSnapshot): boolean {
  return workReasons(s).length > 0;
}

/** Ответ `/api/busy`: занят ли процесс, какие офисы заняты и почему. */
export interface BusyAnswer {
  busy: boolean;
  /** id занятых офисов — пусто, если `busy` ложно. */
  offices: string[];
  /** Причины по занятым офисам: «o-2: задачи в работе: T-5; …». Пусто, если `busy` ложно. */
  reasons: string[];
}

/** Сводка по офисам: занят процесс, если занят хоть один. */
export function busyAnswer(snapshots: { officeId: string; work: WorkSnapshot }[]): BusyAnswer {
  const busy = snapshots
    .map((s) => ({ officeId: s.officeId, reasons: workReasons(s.work) }))
    .filter((s) => s.reasons.length > 0);
  return {
    busy: busy.length > 0,
    offices: busy.map((s) => s.officeId),
    reasons: busy.map((s) => `${s.officeId}: ${s.reasons.join('; ')}`),
  };
}

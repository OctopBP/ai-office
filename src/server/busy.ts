/**
 * Занят ли офис прямо сейчас — для предупреждения перед перезапуском
 * приложения в новую версию (desktop/updater.js спрашивает `/api/busy`).
 *
 * Раньше это считалось по `activity.live`, а туда попадает и цикл сессии
 * менеджера, который живёт между сообщениями и ничего не делает. Поэтому
 * приложение писало «обновится, когда задачи закончатся» в офисе, где не
 * шло ни одной задачи. «Занят» здесь — только то, что перезапуск правда
 * оборвёт: идущая сессия исполнителя (в том числе ревью и доработка
 * конвейера), ход менеджера, совещание, конвейер задачи, очередь слияния,
 * выпуск. Задача, которая просто лежит на доске в любом статусе, и
 * простаивающий менеджер занятостью не считаются.
 *
 * Решение — чистая функция от снимка: снимок собирает `officeWork` в
 * index.ts, а проверяется функция отдельно (`npm run test:busy`).
 */

/** Что прямо сейчас идёт в одном офисе. */
export interface WorkSnapshot {
  /** Живые сессии исполнителей — занятые слоты (`state.running`). */
  workers: number;
  /** Чаты менеджера, где он сейчас отвечает (`PmSession.busy`), а не ждёт сообщения. */
  pmTurns: number;
  /** Совещание идёт. */
  meeting: boolean;
  /** Конвейеры задач (ревью → слияние), которые идут прямо сейчас. */
  pipelines: number;
  /** Ручная очередь слияния идёт. */
  mergeQueue: boolean;
  /** Выпуски, которые идут прямо сейчас. */
  releases: number;
}

/** Занят ли офис по снимку. */
export function isWorking(s: WorkSnapshot): boolean {
  return s.workers > 0 || s.pmTurns > 0 || s.meeting || s.pipelines > 0 || s.mergeQueue || s.releases > 0;
}

/** Ответ `/api/busy`: занят ли процесс и какие офисы заняты. */
export interface BusyAnswer {
  busy: boolean;
  /** id занятых офисов — пусто, если `busy` ложно. */
  offices: string[];
}

/** Сводка по офисам: занят процесс, если занят хоть один. */
export function busyAnswer(snapshots: { officeId: string; work: WorkSnapshot }[]): BusyAnswer {
  const offices = snapshots.filter((s) => isWorking(s.work)).map((s) => s.officeId);
  return { busy: offices.length > 0, offices };
}

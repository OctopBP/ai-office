import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MergeCheck, MergeRun, MergeStep, TypecheckResult } from '../shared/types';
import { office, taskRepo, type Task } from './state';
import { checkMergeable, mergeBranch, removeWorktree } from './git';

const run = promisify(execFile);

/**
 * Слияние остаётся решением человека: сервер только показывает, что во что
 * сольётся, и по команде идёт по выбранному списку. Ничего не сливается само,
 * ничего не откатывается задним числом.
 */

/**
 * Задачи, которые есть смысл сливать: работа закончена, ветка своя,
 * в основную ещё не влита. «review» — исполнитель сдал, менеджер ещё смотрит;
 * такие ветки пользователь тоже сливает, дожидаться закрытия не обязательно.
 */
export function mergeableTasks(): Task[] {
  return [...office.tasks.values()].filter(
    (t) => !t.merged && t.branch && t.baseBranch && (t.status === 'done' || t.status === 'review'),
  );
}

let checking = false;

/**
 * Пересчитать статусы мержабельности всех завершённых задач.
 * Проверка сухая: основная ветка не меняется. Считаем по очереди, а не
 * параллельно, — запасной путь проверки создаёт worktree, а два worktree
 * одного репозитория одновременно только мешают друг другу.
 */
export async function refreshMergeChecks(): Promise<MergeCheck[]> {
  if (checking) return [...office.mergeChecks.values()];
  checking = true;
  office.setMergeChecking(true);
  const checks: MergeCheck[] = [];
  try {
    for (const task of mergeableTasks()) {
      const branch = task.branch;
      const base = task.baseBranch;
      if (!branch || !base) continue;
      const result = await checkMergeable(taskRepo(task), branch, base);
      checks.push({
        taskId: task.id,
        state: result.state,
        conflicts: result.conflicts,
        message: result.message,
        checkedAt: Date.now(),
      });
    }
    office.setMergeChecks(checks);
    return checks;
  } catch (err) {
    office.setMergeChecking(false);
    office.addLog(null, 'error', `Проверка слияний не удалась: ${(err as Error).message}`);
    return [...office.mergeChecks.values()];
  } finally {
    checking = false;
  }
}

/** Сколько ждём проверку сборки, прежде чем считать её зависшей. */
const TYPECHECK_TIMEOUT_MS = 5 * 60 * 1000;
/** Хвост вывода: в интерфейс уходит конец лога, где и лежат ошибки. */
const OUTPUT_LIMIT = 4000;

const tail = (s: string): string => (s.length > OUTPUT_LIMIT
  ? `… (начало вывода отброшено)\n${s.slice(-OUTPUT_LIMIT)}`
  : s);

/** Есть ли в package.json репозитория такой npm-скрипт. */
function hasScript(repoDir: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return Boolean(pkg.scripts?.[name]);
  } catch {
    return false;
  }
}

/**
 * Прогнать проверку сборки в основной ветке репозитория. Запускается после
 * каждого успешного слияния: две ветки по отдельности собираются, а вместе
 * могут и не собраться — узнать об этом лучше сразу, а не через три слияния.
 */
export async function runTypecheck(repoDir: string): Promise<TypecheckResult> {
  const started = Date.now();
  if (!hasScript(repoDir, 'typecheck')) {
    return {
      ok: true, skipped: true, output: '', durationMs: 0,
      message: 'В проекте нет скрипта «npm run typecheck» — проверка сборки пропущена.',
    };
  }
  try {
    const { stdout, stderr } = await run('npm', ['run', '--silent', 'typecheck'], {
      cwd: repoDir,
      timeout: TYPECHECK_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    return {
      ok: true, skipped: false, output: tail(`${stdout}${stderr}`.trim()),
      message: 'npm run typecheck прошёл без ошибок.',
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: string | number; killed?: boolean };
    const output = tail(`${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || (e.message ?? ''));
    // npm вообще не запустился — это не провал сборки, а отсутствие инструмента.
    if (e.code === 'ENOENT') {
      return {
        ok: true, skipped: true, output, durationMs: Date.now() - started,
        message: 'npm не найден — проверку сборки прогнать нечем.',
      };
    }
    if (e.killed) {
      return {
        ok: false, skipped: false, output, durationMs: Date.now() - started,
        message: 'npm run typecheck не уложился в 5 минут — прогон прерван.',
      };
    }
    return {
      ok: false, skipped: false, output, durationMs: Date.now() - started,
      message: 'npm run typecheck падает.',
    };
  }
}

let queueRunning = false;

const pendingStep = (task: Task): MergeStep => ({
  taskId: task.id,
  title: task.title,
  status: 'pending',
  message: 'Очередь до этой задачи не дошла.',
  conflicts: [],
  typecheck: null,
});

/**
 * Слить выбранные задачи по порядку списка. Останавливаемся на первой беде —
 * конфликте, отказе git или упавшей проверке сборки — и говорим, где встали.
 * Уже слитое не откатываем: откат чужой работы был бы хуже остановки.
 */
export async function mergeQueue(taskIds: string[]): Promise<MergeRun | null> {
  if (queueRunning) {
    office.addChat('офис', 'Очередь слияния уже идёт — дождитесь, пока она закончится.');
    return office.mergeRun;
  }

  const tasks = taskIds
    .map((id) => office.tasks.get(id))
    .filter((t): t is Task => Boolean(t));
  if (!tasks.length) {
    office.addChat('офис', 'Сливать нечего: ни одной из выбранных задач нет на доске.');
    return null;
  }

  queueRunning = true;
  const runState: MergeRun = {
    id: `merge-${Date.now()}`,
    running: true,
    steps: tasks.map(pendingStep),
    summary: 'Очередь слияния запущена.',
    startedAt: Date.now(),
    finishedAt: null,
  };
  office.setMergeRun(runState);

  let merged = 0;
  let stoppedAt: MergeStep | null = null;

  try {
    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      const step = runState.steps[i];
      const branch = task.branch;
      const base = task.baseBranch;

      if (task.merged) {
        finishStep(runState, step, 'skipped', `${task.id} уже влита в ${task.baseBranch ?? 'основную ветку'}.`);
        continue;
      }
      if (!branch || !base) {
        finishStep(runState, step, 'skipped', `У ${task.id} нет своей ветки — сливать нечего.`);
        continue;
      }

      // Репозиторий берём с задачи: у ролей они разные, а настройка роли
      // могла смениться уже после того, как задачу сделали.
      const repo = taskRepo(task);
      const outcome = await mergeBranch(repo, branch, base);
      office.addChat('офис', `${task.id}: ${outcome.message}`);
      office.addLog(null, outcome.ok ? 'system' : 'error', `merge ${branch}: ${outcome.kind}`);

      if (outcome.kind === 'conflict') {
        finishStep(runState, step, 'conflict',
          `Конфликт с веткой ${base}. ${outcome.conflicts.length
            ? `Разойтись не дали файлы: ${outcome.conflicts.join(', ')}.`
            : outcome.message}`,
          outcome.conflicts);
        stoppedAt = step;
        break;
      }
      if (!outcome.ok) {
        finishStep(runState, step, 'failed', outcome.message);
        stoppedAt = step;
        break;
      }

      // Слияние прошло (или сливать было нечего) — worktree задаче больше не нужен.
      if (task.worktreePath) await removeWorktree(repo, task.worktreePath, branch);
      office.updateTask(task.id, { merged: true, worktreePath: null });

      if (outcome.kind === 'nothing') {
        finishStep(runState, step, 'nothing', `В ветке ${branch} не было коммитов сверх ${base} — слияние не потребовалось.`);
        continue;
      }

      merged += 1;
      const typecheck = await runTypecheck(repo);
      step.typecheck = typecheck;
      if (!typecheck.ok) {
        finishStep(runState, step, 'typecheck-failed',
          `Ветка влита в ${base}, но проверка сборки после этого падает: ${typecheck.message} ` +
          'Очередь остановлена — чинить поломку удобнее, пока сверху не легли другие задачи.',
          [], typecheck);
        stoppedAt = step;
        break;
      }
      finishStep(runState, step, 'merged',
        `Влита в ${base}. ${typecheck.skipped ? typecheck.message : 'Проверка сборки прошла.'}`,
        [], typecheck);

      // Порядок слияний меняет картину: после каждого успешного пересчитываем,
      // что теперь с чем конфликтует.
      await refreshMergeChecks();
    }

    runState.summary = summarize(runState, merged, stoppedAt);
  } catch (err) {
    runState.summary = `Очередь слияния оборвалась с ошибкой: ${(err as Error).message}`;
    office.addLog(null, 'error', runState.summary);
  } finally {
    queueRunning = false;
    runState.running = false;
    runState.finishedAt = Date.now();
    office.setMergeRun(runState);
    office.addChat('офис', runState.summary);
    // Финальный пересчёт: после остановки статусы остальных задач тоже другие.
    await refreshMergeChecks();
  }

  return runState;
}

function finishStep(
  runState: MergeRun, step: MergeStep, status: MergeStep['status'], message: string,
  conflicts: string[] = [], typecheck: TypecheckResult | null = null,
): void {
  step.status = status;
  step.message = message;
  step.conflicts = conflicts;
  if (typecheck) step.typecheck = typecheck;
  office.setMergeRun(runState);
}

/** Итог очереди одной фразой — её пользователь и читает первой. */
function summarize(runState: MergeRun, merged: number, stoppedAt: MergeStep | null): string {
  const skipped = runState.steps.filter((s) => s.status === 'pending').length;
  const head = merged ? `Слито задач: ${merged}.` : 'Ни одна задача не влита.';
  if (!stoppedAt) return `${head} Очередь прошла до конца.`;

  const where = `Встали на ${stoppedAt.taskId} «${stoppedAt.title}»`;
  const why = stoppedAt.status === 'conflict'
    ? (stoppedAt.conflicts.length
      ? `: конфликт в файлах ${stoppedAt.conflicts.join(', ')}.`
      : ': конфликт при слиянии.')
    : `: ${stoppedAt.message}`;
  const rest = skipped ? ` Не дошли до задач: ${runState.steps.filter((s) => s.status === 'pending').map((s) => s.taskId).join(', ')}.` : '';
  return `${head} ${where}${why}${rest} Уже слитые задачи не откатывались.`;
}

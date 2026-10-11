/**
 * Прогон проверок проекта в заданной рабочей копии: сборка (`npm run typecheck`)
 * и любые команды оболочки (тесты проекта).
 *
 * Вынесено из `merge.ts` отдельным модулем: те же проверки нужны пред-merge
 * гейту (`premerge.ts`), а тащить ради них в консольный скрипт состояние офиса,
 * план и шину событий незачем. `merge.ts` эти функции реэкспортирует, чтобы
 * старые импорты `from './merge'` продолжали работать.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TypecheckResult } from '../shared/types';
import type { Lang } from '../shared/i18n';
import { t } from './i18n';
import { projectEnv } from './childenv';

const run = promisify(execFile);

/** Сколько ждём проверку, прежде чем считать её зависшей. */
export const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
/** Хвост вывода: в интерфейс уходит конец лога, где и лежат ошибки. */
const OUTPUT_LIMIT = 4000;

export const tail = (s: string, lang: Lang, limit = OUTPUT_LIMIT): string => (s.length > limit
  ? `${t(lang, 'merge.outputClipped')}\n${s.slice(-limit)}`
  : s);

/**
 * Своя проверка проекта (spec процессов §8.2): команда оболочки в рабочей
 * копии задачи. Тот же лимит и тот же хвост вывода, что у проверки сборки.
 */
export async function runProjectCheck(
  cwd: string, command: string, lang: Lang,
  /**
   * Сборке выпуска нужно больше пяти минут и своё окружение: версия, номер,
   * заметки (docs/design/releases/spec.md §7.2). Остальным — как было.
   */
  opts: {
    timeoutMs?: number; env?: NodeJS.ProcessEnv; outputLimit?: number;
    /**
     * Чем закрыть секреты в выводе. Применяется к полному выводу ДО обрезки
     * хвоста: иначе обрезка могла бы разрезать значение и оставить его кусок.
     */
    mask?: (text: string) => string;
    /**
     * Снять команду снаружи (отмена выпуска). Команда с сигналом запускается
     * своей группой процессов и снимается вся: оболочка сама сборку не делает,
     * и сигнал ей одной оставил бы сборщик работать.
     */
    signal?: AbortSignal;
  } = {},
): Promise<{ ok: boolean; output: string; message: string; durationMs: number; timedOut?: boolean; aborted?: boolean }> {
  const started = Date.now();
  const mask = opts.mask ?? ((text: string) => text);
  const stop = opts.signal;
  try {
    // Оболочка своя на каждой системе: на Windows `/bin/sh` нет, и проверка
    // падала бы не на команде, а на попытке её запустить.
    const [shell, shellArgs] = process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', command]]
      : ['/bin/sh', ['-lc', command]];
    if (stop?.aborted) throw Object.assign(new Error('aborted'), { signal: 'SIGTERM' });
    const options = {
      cwd, timeout: opts.timeoutMs ?? CHECK_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
      env: projectEnv({ FORCE_COLOR: '0', ...opts.env }),
    };
    const { stdout, stderr } = stop
      ? await runGroup(shell as string, shellArgs as string[], options, stop)
      : await run(shell as string, shellArgs as string[], options);
    const output = tail(mask(`${stdout}${stderr}`.trim()), lang, opts.outputLimit);
    return { ok: true, output, message: output, durationMs: Date.now() - started };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string };
    const aborted = Boolean(stop?.aborted);
    const timedOut = !aborted && Boolean(e.killed && e.signal === 'SIGTERM');
    // Снятая сигналом проверка часто не успевает напечатать ничего: скрипты
    // проверок копят результаты до конца. Без этой строки в гейте оставалось
    // голое «Command failed», неотличимое от настоящего падения (T-508).
    const killed = timedOut
      ? t(lang, 'checks.timedOut', { min: String(Math.round((opts.timeoutMs ?? CHECK_TIMEOUT_MS) / 60_000)) })
      : e.signal ? t(lang, 'checks.killed', { signal: e.signal }) : '';
    const text = tail(mask(`${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || (e.message ?? '')), lang, opts.outputLimit);
    const output = killed ? `${text}\n${killed}` : text;
    return {
      ok: false, output, message: output, durationMs: Date.now() - started, timedOut, ...(aborted ? { aborted } : {}),
    };
  }
}

/**
 * Команда своей группой процессов, которую можно снять целиком. `execFile`
 * параметр `detached` не принимает, поэтому здесь `spawn`; итог и ошибка — той
 * же формы, что у `execFile`: вывод, `killed` и `signal` у снятой по таймауту.
 */
function runGroup(
  file: string, args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
  stop: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    const kill = () => killTree(child.pid);
    const timer = setTimeout(() => { killed = true; kill(); }, options.timeout);
    stop.addEventListener('abort', kill, { once: true });
    const settle = (err: Error | null, signal: NodeJS.Signals | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop.removeEventListener('abort', kill);
      if (err) reject(Object.assign(err, { stdout, stderr, killed, signal: signal ?? (killed ? 'SIGTERM' : undefined) }));
      else done({ stdout, stderr });
    };
    const keep = (chunk: string, was: string): string => {
      const next = was + chunk;
      if (next.length <= options.maxBuffer) return next;
      killed = true;
      kill();
      return next.slice(0, options.maxBuffer);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = keep(chunk, stdout); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = keep(chunk, stderr); });
    child.on('error', (err) => settle(err));
    child.on('close', (code, signal) => settle(code === 0 && !signal ? null : new Error(`Command failed: ${file} ${args.join(' ')}`), signal));
  });
}

/** Снять процесс вместе с потомками: группой на POSIX, деревом на Windows. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
    else process.kill(-pid, 'SIGTERM');
  } catch {
    // Группы нет (процесс уже завершился) — добиваем сам процесс на случай, если он жив.
    try { process.kill(pid, 'SIGTERM'); } catch { /* уже завершился */ }
  }
}

/** Есть ли в package.json репозитория такой npm-скрипт. */
export function hasScript(repoDir: string, name: string): boolean {
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
export async function runTypecheck(repoDir: string, lang: Lang): Promise<TypecheckResult> {
  const started = Date.now();
  if (!hasScript(repoDir, 'typecheck')) {
    return {
      ok: true, skipped: true, output: '', durationMs: 0,
      message: t(lang, 'merge.noTypecheck'),
    };
  }
  try {
    const { stdout, stderr } = await run('npm', ['run', '--silent', 'typecheck'], {
      cwd: repoDir,
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: projectEnv({ FORCE_COLOR: '0' }),
    });
    return {
      ok: true, skipped: false, output: tail(`${stdout}${stderr}`.trim(), lang),
      message: t(lang, 'merge.typecheckOk'),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: string | number; killed?: boolean };
    const output = tail(`${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || (e.message ?? ''), lang);
    // npm вообще не запустился — это не провал сборки, а отсутствие инструмента.
    if (e.code === 'ENOENT') {
      return {
        ok: true, skipped: true, output, durationMs: Date.now() - started,
        message: t(lang, 'merge.noNpm'),
      };
    }
    if (e.killed) {
      return {
        ok: false, skipped: false, output, durationMs: Date.now() - started,
        message: t(lang, 'merge.typecheckTimeout'),
      };
    }
    return {
      ok: false, skipped: false, output, durationMs: Date.now() - started,
      message: t(lang, 'merge.typecheckFailed'),
    };
  }
}

/**
 * Файлы, на которые ругнулась проверка. Разбираем вывод tsc
 * (`src/a.ts(12,3): error TS2322: …` и форму с двоеточиями `src/a.ts:12:3 -`),
 * а если формат чужой — просто пути с расширением из начала строки.
 * Порядок сохраняем, повторы убираем: в отчёте важно, какой файл назван первым.
 */
export function errorFiles(output: string): string[] {
  const found: string[] = [];
  const add = (file: string): void => {
    const clean = file.trim();
    if (clean && !found.includes(clean)) found.push(clean);
  };
  for (const line of output.split('\n')) {
    const tsc = /^\s*(?:\x1b\[\d+m)?([^\s()]+\.[a-zA-Z]{1,5})\((\d+),(\d+)\)/.exec(line);
    if (tsc) { add(tsc[1]); continue; }
    const colon = /^\s*([^\s:]+\.[a-zA-Z]{1,5}):(\d+):(\d+)/.exec(line);
    if (colon) { add(colon[1]); continue; }
    // Строка вида «at /путь/файл.ts:12» из стека ноды: файл там же, но не первым.
    const stack = /\s(\/[^\s():]+\.[a-zA-Z]{1,5}):(\d+)/.exec(line);
    if (stack) add(stack[1]);
  }
  return found;
}

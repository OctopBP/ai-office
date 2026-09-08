/**
 * Прогон проверок проекта в заданной рабочей копии: сборка (`npm run typecheck`)
 * и любые команды оболочки (тесты проекта).
 *
 * Вынесено из `merge.ts` отдельным модулем: те же проверки нужны пред-merge
 * гейту (`premerge.ts`), а тащить ради них в консольный скрипт состояние офиса,
 * план и шину событий незачем. `merge.ts` эти функции реэкспортирует, чтобы
 * старые импорты `from './merge'` продолжали работать.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TypecheckResult } from '../shared/types';
import type { Lang } from '../shared/i18n';
import { t } from './i18n';

const run = promisify(execFile);

/** Сколько ждём проверку, прежде чем считать её зависшей. */
export const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
/** Хвост вывода: в интерфейс уходит конец лога, где и лежат ошибки. */
const OUTPUT_LIMIT = 4000;

export const tail = (s: string, lang: Lang): string => (s.length > OUTPUT_LIMIT
  ? `${t(lang, 'merge.outputClipped')}\n${s.slice(-OUTPUT_LIMIT)}`
  : s);

/**
 * Своя проверка проекта (spec процессов §8.2): команда оболочки в рабочей
 * копии задачи. Тот же лимит и тот же хвост вывода, что у проверки сборки.
 */
export async function runProjectCheck(
  cwd: string, command: string, lang: Lang,
): Promise<{ ok: boolean; output: string; message: string; durationMs: number }> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run('/bin/sh', ['-lc', command], {
      cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const output = tail(`${stdout}${stderr}`.trim(), lang);
    return { ok: true, output, message: output, durationMs: Date.now() - started };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = tail(`${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || (e.message ?? ''), lang);
    return { ok: false, output, message: output, durationMs: Date.now() - started };
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
      env: { ...process.env, FORCE_COLOR: '0' },
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

/**
 * Пред-merge гейт: что должно случиться ДО того, как ветка попадёт в основную.
 *
 * Урок, ради которого он написан (журнал офиса, J-4 и урок про T-138): зелёный
 * прогон на ветке ничего не гарантирует. Ветка и основная могут независимо
 * починить одно и то же место, git сольёт их без единого конфликта, а слитое
 * дерево окажется красным. Поэтому проверки гоняются на РЕЗУЛЬТАТЕ слияния,
 * а не на ветке, и до того, как основная ветка сдвинется.
 *
 * Три шага, в этом порядке:
 *  1. рабочая копия основной ветки чиста (или её правки уходят в stash) —
 *     иначе слияние встанет на «Your local changes would be overwritten»;
 *  2. пробное слияние в рабочей копии офиса: конфликт — стоп, база не тронута;
 *  3. проверки (typecheck и тесты) на собранном слиянии: красные — стоп,
 *     в отчёте видно, какая команда упала, на каких файлах и с каким текстом.
 *
 * Зелёный гейт — слияние идёт как раньше, через `mergeBranch`.
 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { asLang, type Lang } from '../shared/i18n';
import { t } from './i18n';
import {
  assembleMerge, currentBranch, dirtyFiles, dropAssembled, mergeBranch,
  stashPop, stashPush,
} from './git';
import { errorFiles, hasScript, runProjectCheck } from './checks';
import { duplicateEdits, formatOverlapFiles, type DuplicateEdit } from './overlap';

/** Одна проверка на слитом дереве. */
export interface PreMergeCheck {
  command: string;
  ok: boolean;
  /** Хвост вывода команды — в нём и лежит текст ошибки. */
  output: string;
  /** Файлы, на которые ругнулась проверка (разобраны из вывода). */
  files: string[];
  durationMs: number;
}

/**
 * На чём остановился гейт:
 * 'dirty' — грязная рабочая копия; 'conflict' — пробное слияние не собралось;
 * 'checks' — проверки на слитом дереве красные; 'merge' — слияние не прошло;
 * 'nothing' — сливать было нечего; 'merged' — влито; 'checked' — гейт зелёный,
 * но слияние не просили (режим только проверки).
 */
export type PreMergeStage =
  | 'dirty' | 'conflict' | 'checks' | 'merge' | 'nothing' | 'merged' | 'checked';

export interface PreMergeReport {
  ok: boolean;
  stage: PreMergeStage;
  /** Итог одной фразой — его человек и читает первым. */
  message: string;
  branch: string;
  base: string;
  /** Незакоммиченные файлы рабочей копии на момент старта. */
  dirty: string[];
  /** Правки копии убраны в stash и возвращены обратно. */
  stashed: boolean;
  conflicts: string[];
  /**
   * Файлы, которые после точки ветвления правили обе стороны. Слияние не
   * останавливают — это предупреждение (см. overlap.ts и урок T-138).
   */
  overlaps: DuplicateEdit[];
  checks: PreMergeCheck[];
  /** Первая упавшая проверка — она и остановила гейт. */
  failed: PreMergeCheck | null;
  merged: boolean;
  /** Сколько занял сам гейт: статус, пробное слияние и проверки. */
  gateMs: number;
  /** Сколько занял шаг целиком, вместе со слиянием. */
  totalMs: number;
  /** Предупреждения, которые не отменяют исход (например, не вернулся stash). */
  warnings: string[];
}

/**
 * Где собирать пробное слияние, если место не задано: рядом с временными
 * файлами, а не внутри репозитория. Копия офиса — это отдельный worktree, и,
 * лежи он внутри проекта, git показывал бы его каталог как неотслеживаемый —
 * гейт сам делал бы рабочую копию грязной и на следующем прогоне вставал бы
 * на собственном следе. Имя устойчивое: репозиторий переиспользует свою копию.
 */
export const defaultIntegrationDir = (repoDir: string): string => resolve(
  tmpdir(), 'office-premerge',
  `${basename(repoDir)}-${createHash('sha1').update(repoDir).digest('hex').slice(0, 8)}`,
);

export interface PreMergeOptions {
  repoDir: string;
  branch: string;
  base: string;
  /** Рабочая копия офиса, в которой собирается слияние. */
  integrationDir?: string;
  lang?: Lang;
  /** Команды проверки. По умолчанию — сборка и тесты проекта, если они есть. */
  checks?: string[];
  /** Грязную копию убрать в stash и вернуть после, вместо остановки. */
  stash?: boolean;
  /** false — только проверить, не сливать. */
  merge?: boolean;
}

/**
 * Что гонять, если не сказано иное: сборка проекта и его тесты. Берём только
 * те скрипты, которые в проекте правда есть, — придуманная команда падала бы
 * «нет такого скрипта» и выглядела как красное слитое дерево.
 */
export function defaultChecks(repoDir: string): string[] {
  const commands: string[] = [];
  if (hasScript(repoDir, 'typecheck')) commands.push('npm run --silent typecheck');
  if (hasScript(repoDir, 'test')) commands.push('npm test --silent');
  return commands;
}

/** Время шага человеку: миллисекунды до секунды нечитаемы, секунды — читаемы. */
export const formatMs = (ms: number, lang: Lang): string => (ms < 1000
  ? t(lang, 'premerge.ms', { n: String(ms) })
  : t(lang, 'premerge.sec', { n: (ms / 1000).toFixed(1) }));

/** Пред-merge гейт целиком. Ничего не спрашивает и ничего не печатает — только отчёт. */
export async function preMergeGate(options: PreMergeOptions): Promise<PreMergeReport> {
  const {
    repoDir, branch, base, stash = false, merge = true,
  } = options;
  const lang = options.lang ?? asLang(process.env.OFFICE_LANG);
  const integrationDir = options.integrationDir ?? defaultIntegrationDir(repoDir);

  const started = Date.now();
  const report: PreMergeReport = {
    ok: false, stage: 'dirty', message: '', branch, base,
    dirty: [], stashed: false, conflicts: [], overlaps: [], checks: [], failed: null,
    merged: false, gateMs: 0, totalMs: 0, warnings: [],
  };
  const done = (stage: PreMergeStage, ok: boolean, message: string): PreMergeReport => {
    report.stage = stage;
    report.ok = ok;
    report.message = message;
    report.totalMs = Date.now() - started;
    // Гейт кончается там, где начинается слияние: если до него не дошли,
    // время гейта равно времени всего шага.
    if (!report.gateMs) report.gateMs = report.totalMs;
    return report;
  };

  // 1. Чистая ли рабочая копия. Это ровно ситуация из J-4: незакоммиченные
  //    правки в копии основной ветки роняли слияние на середине.
  report.dirty = await dirtyFiles(repoDir);
  const here = (await currentBranch(repoDir)) ?? base;
  if (report.dirty.length) {
    if (!stash) {
      return done('dirty', false, t(lang, 'premerge.dirty', {
        branch: here, files: report.dirty.join(', '),
      }));
    }
    if (!(await stashPush(repoDir, `office premerge ${branch}`))) {
      return done('dirty', false, t(lang, 'premerge.stashFailed', {
        files: report.dirty.join(', '),
      }));
    }
    report.stashed = true;
  }

  try {
    // 2. Пробное слияние: собирается в копии офиса, основная ветка не двигается.
    const built = await assembleMerge(repoDir, branch, base, integrationDir, lang);
    if (built.kind === 'conflict') {
      report.conflicts = built.conflicts;
      return done('conflict', false, t(lang, 'premerge.conflict', {
        branch, base, files: built.conflicts.join(', ') || built.message,
      }));
    }
    if (built.kind === 'nothing') {
      return done('nothing', true, t(lang, 'premerge.nothing', { branch, base }));
    }
    if (built.kind !== 'merged' || !built.worktree) {
      return done('conflict', false, t(lang, 'premerge.assembleFailed', { error: built.message }));
    }
    const worktree = built.worktree;

    // 2б. Дублирующие правки: что после точки ветвления правили обе стороны.
    //     Git слил это молча — конфликта нет, — но именно так расходятся две
    //     независимые починки одного места (урок T-138). Считаем ДО слияния:
    //     после него база уже содержит ветку и сравнивать будет не с чем.
    //     Ничего не блокирует: только пополняет отчёт.
    report.overlaps = await duplicateEdits(repoDir, base, branch);

    // 3. Проверки на слитом дереве. Первая красная останавливает: остальные
    //    всё равно ничего не изменят — слияния не будет. Набор по умолчанию
    //    берём из слитого дерева, а не из базы: ветка могла завести свои
    //    скрипты, и проверять её надо ими.
    const commands = options.checks ?? defaultChecks(worktree);
    for (const command of commands) {
      const res = await runProjectCheck(worktree, command, lang);
      const check: PreMergeCheck = {
        command, ok: res.ok, output: res.output,
        files: res.ok ? [] : errorFiles(res.output), durationMs: res.durationMs,
      };
      report.checks.push(check);
      if (!res.ok) {
        report.failed = check;
        break;
      }
    }
    report.gateMs = Date.now() - started;

    if (report.failed) {
      // Собранное слияние убираем: копия офиса не должна остаться с деревом,
      // которое мы только что признали красным.
      await dropAssembled(worktree, base);
      const failed = report.failed;
      return done('checks', false, t(lang, 'premerge.checkFailed', {
        command: failed.command,
        base,
        files: failed.files.length
          ? t(lang, 'premerge.checkFiles', { files: failed.files.join(', ') })
          : '',
      }));
    }

    if (!merge) {
      await dropAssembled(worktree, base);
      return done('checked', true, t(lang, 'premerge.checked', {
        branch, base, n: String(report.checks.length), time: formatMs(report.gateMs, lang),
      }));
    }

    // 4. Гейт зелёный — сливаем как раньше. Слияние пересобирается в той же
    //    копии офиса из тех же коммитов, поэтому проверенное дерево и влитое —
    //    одно и то же.
    const outcome = await mergeBranch(repoDir, branch, base, integrationDir, lang);
    if (outcome.kind === 'nothing') {
      return done('nothing', true, t(lang, 'premerge.nothing', { branch, base }));
    }
    if (!outcome.ok) {
      report.conflicts = outcome.conflicts;
      return done('merge', false, t(lang, 'premerge.mergeFailed', { message: outcome.message }));
    }
    report.merged = true;
    if (outcome.checkout.state === 'lagging') report.warnings.push(outcome.checkout.message);
    return done('merged', true, t(lang, 'premerge.merged', {
      branch, base, gate: formatMs(report.gateMs, lang),
    }));
  } finally {
    if (report.stashed) {
      const back = await stashPop(repoDir);
      if (!back.ok) {
        report.stashed = false;
        report.warnings.push(t(lang, 'premerge.stashPopFailed', { error: back.message }));
      }
    }
    report.totalMs = Date.now() - started;
  }
}

/** Отчёт словами: то, что печатает консольный скрипт и кладёт в ленту офис. */
export function formatReport(report: PreMergeReport, lang: Lang): string {
  const lines: string[] = [
    `${report.ok ? '✅' : '❌'} ${report.message}`,
    t(lang, 'premerge.reportBranch', { branch: report.branch, base: report.base }),
  ];
  if (report.dirty.length) {
    lines.push(t(lang, report.stashed ? 'premerge.reportStashed' : 'premerge.reportDirty', {
      files: report.dirty.join(', '),
    }));
  }
  if (report.conflicts.length) {
    lines.push(t(lang, 'premerge.reportConflicts', { files: report.conflicts.join(', ') }));
  }
  // Предупреждение печатается и у зелёного гейта: слияние оно не отменяет,
  // но человек должен увидеть его вместе с исходом, а не вместо него.
  if (report.overlaps.length) {
    lines.push(`⚠️ ${t(lang, 'premerge.reportOverlaps', {
      files: formatOverlapFiles(report.overlaps, lang),
    })}`);
  }
  for (const check of report.checks) {
    lines.push(`${check.ok ? '  ✅' : '  ❌'} ${check.command} — ${formatMs(check.durationMs, lang)}`);
  }
  if (report.failed) {
    if (report.failed.files.length) {
      lines.push(t(lang, 'premerge.reportFiles', { files: report.failed.files.join(', ') }));
    }
    lines.push(t(lang, 'premerge.reportOutput'), report.failed.output);
  }
  for (const warning of report.warnings) lines.push(`⚠️ ${warning}`);
  lines.push(t(lang, 'premerge.reportTime', {
    gate: formatMs(report.gateMs, lang), total: formatMs(report.totalMs, lang),
  }));
  return lines.join('\n');
}

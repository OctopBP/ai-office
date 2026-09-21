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
import type { GateReportView } from '../shared/types';
import { asLang, type Lang } from '../shared/i18n';
import { t } from './i18n';
import {
  assembleMerge, currentBranch, dirtyFiles, dropAssembled, mergeBranch,
  releaseIntegration, stashPop, stashPush, type Signature,
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
 * 'integration' — не поднялась рабочая копия офиса, в которой гейт собирает
 * слияние (занят каталог, нет прав); 'checks' — проверки на слитом дереве
 * красные; 'merge' — слияние не прошло; 'nothing' — сливать было нечего;
 * 'merged' — влито; 'checked' — гейт зелёный, но слияние не просили
 * (режим только проверки).
 *
 * 'integration' стоит отдельно намеренно: раньше любая неудача сборки слияния
 * приезжала стадией 'conflict', конвейер читал это как расхождение с базой и
 * показывал «база уезжает быстрее, чем задача успевает слиться» — при том что
 * ветка с базой не расходилась вовсе (T-56, T-58).
 */
export type PreMergeStage =
  | 'dirty' | 'conflict' | 'integration' | 'checks' | 'merge' | 'nothing'
  | 'merged' | 'checked';

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
  /**
   * Каталог, в котором гейт собирал слияние и гонял проверки. Может отличаться
   * от заказанного: основной бывает занят, и тогда берётся запасной.
   */
  integrationDir: string;
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
  /**
   * Незакоммиченные правки в рабочей копии — не повод останавливаться.
   * Так гейт зовёт конвейер офиса: слияние он собирает в своей копии, а копию
   * человека двигает `advanceBase`, которая его правки не трогает. В консоли
   * умолчание обратное: там за гейтом стоит человек, и молча сливать поверх
   * его несохранённой работы нельзя.
   */
  allowDirty?: boolean;
  /** Подпись коммита слияния. Не задана — подписывает сам офис. */
  sign?: Signature;
}

/**
 * Что офис гоняет на слитом дереве перед тем, как двинуть основную ветку.
 *
 * Только дешёвое: каждая проверка считается секундами и не поднимает ни одной
 * сессии агента. `test:pm` сюда не входит намеренно — он поднимает живого
 * менеджера, и платить за каждое слияние деньгами офис не должен.
 *
 * Это имена npm-скриптов, а не команды: берутся только те, что в проекте
 * правда есть (`hasScript`), поэтому в чужом репозитории список сам сжимается
 * до `typecheck` и `test`. Порядок — от дешёвого к дорогому: первая красная
 * проверка останавливает гейт, и чем раньше она найдётся, тем короче слияние.
 */
export const OFFICE_MERGE_CHECKS: readonly string[] = [
  'typecheck',
  'test:presets', 'test:nav', 'test:reach', 'test:perm',
  'test:state', 'test:merge', 'test:offices', 'test:review',
  // Общий прогон чужого проекта — последним: у нас его нет, а там он самый долгий.
  'test',
];

/** Переменная окружения, которой набор проверок перебивают на один запуск. */
export const MERGE_CHECKS_ENV = 'OFFICE_MERGE_CHECKS';

/**
 * Набор команд для гейта конвейера. Три источника, в порядке старшинства:
 * переменная окружения (разовая правка на запуск), настройка офиса
 * (`Settings.mergeChecks` — готовые команды оболочки; пустой список означает
 * именно «не гонять ничего», а не «взять умолчание») и, если ничего не задано,
 * `OFFICE_MERGE_CHECKS`, отфильтрованный по package.json репозитория.
 */
export function mergeChecks(
  repoDir: string, configured?: readonly string[] | null,
): string[] {
  const fromEnv = (process.env[MERGE_CHECKS_ENV] ?? '').trim();
  if (fromEnv) return fromEnv.split(',').map((c) => c.trim()).filter(Boolean);
  if (configured) return [...configured];
  return OFFICE_MERGE_CHECKS
    .filter((name) => hasScript(repoDir, name))
    .map((name) => `npm run --silent ${name}`);
}

/**
 * Что гонять, если не сказано иное. Тот же набор, что у конвейера, и это
 * важнее краткости: человек, прогнавший `npm run premerge` руками, должен
 * получить тот же вердикт, что получит офис, — иначе зелёная консоль
 * противоречила бы вставшему конвейеру, и верить было бы нечему.
 */
export const defaultChecks = (repoDir: string): string[] => mergeChecks(repoDir);

/** Время шага человеку: миллисекунды до секунды нечитаемы, секунды — читаемы. */
export const formatMs = (ms: number, lang: Lang): string => (ms < 1000
  ? t(lang, 'premerge.ms', { n: String(ms) })
  : t(lang, 'premerge.sec', { n: (ms / 1000).toFixed(1) }));

/** Пред-merge гейт целиком. Ничего не спрашивает и ничего не печатает — только отчёт. */
export async function preMergeGate(options: PreMergeOptions): Promise<PreMergeReport> {
  const {
    repoDir, branch, base, stash = false, merge = true, allowDirty = false,
  } = options;
  const lang = options.lang ?? asLang(process.env.OFFICE_LANG);
  const integrationDir = options.integrationDir ?? defaultIntegrationDir(repoDir);

  const started = Date.now();
  const report: PreMergeReport = {
    ok: false, stage: 'dirty', message: '', branch, base,
    dirty: [], stashed: false, conflicts: [], overlaps: [], checks: [], failed: null,
    merged: false, integrationDir, gateMs: 0, totalMs: 0, warnings: [],
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
  // Отцепленная копия человека — известная болячка офиса (advanceBase уводит
  // её с ветки, чтобы сдвинуть базу мимо незакоммиченных правок). Слиянию она
  // не мешает: база двигается ссылкой. Но молчать нельзя — влитого в такой
  // копии не видно, и человек решит, что слияния не было. `--abbrev-ref` на
  // отцепленной копии отвечает буквальным «HEAD», а не пустотой: отсюда и
  // сравнение, а не просто проверка на null.
  const branchHere = await currentBranch(repoDir);
  const detachedHere = !branchHere || branchHere === 'HEAD';
  const here = detachedHere ? base : branchHere;
  if (detachedHere) report.warnings.push(t(lang, 'premerge.detachedHead', { dir: repoDir, base }));
  if (report.dirty.length && !allowDirty) {
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
    const built = await assembleMerge(repoDir, branch, base, integrationDir, lang, options.sign);
    // Обходы по дороге (занятый каталог, снятые хвосты worktree) не отменяют
    // исхода, но человек должен их увидеть: слияние собралось не там, где обычно.
    report.warnings.push(...built.warnings);
    if (built.worktree) report.integrationDir = built.worktree;
    // Собранное слияние живёт в копии офиса: запасную после себя убираем.
    const release = async (): Promise<void> => {
      report.warnings.push(
        ...await releaseIntegration(repoDir, built.worktree, built.temporary, lang));
    };
    if (built.kind === 'conflict') {
      report.conflicts = built.conflicts;
      await release();
      return done('conflict', false, t(lang, 'premerge.conflict', {
        branch, base, files: built.conflicts.join(', ') || built.message,
      }));
    }
    if (built.kind === 'nothing') {
      await release();
      return done('nothing', true, t(lang, 'premerge.nothing', { branch, base }));
    }
    // Каталог для слияния поднять не вышло — это не расхождение с базой, а
    // своя беда с текстом git: отдаём её отдельной стадией, как есть.
    if (built.kind === 'no-copy') {
      await release();
      return done('integration', false, t(lang, 'premerge.integrationFailed', {
        dir: integrationDir, error: built.message,
      }));
    }
    if (built.kind !== 'merged' || !built.worktree) {
      await release();
      return done('merge', false, t(lang, 'premerge.assembleFailed', { error: built.message }));
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
      await release();
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
      await release();
      return done('checked', true, t(lang, 'premerge.checked', {
        branch, base, n: String(report.checks.length), time: formatMs(report.gateMs, lang),
      }));
    }

    // 4. Гейт зелёный — сливаем как раньше. Слияние пересобирается в той же
    //    копии офиса из тех же коммитов, поэтому проверенное дерево и влитое —
    //    одно и то же. Запасную копию перед этим отпускаем: слияние поднимет
    //    себе свою, а два одноразовых каталога рядом нам ни к чему.
    await release();
    const outcome = await mergeBranch(
      repoDir, branch, base, integrationDir, lang, undefined, options.sign);
    report.warnings.push(...outcome.warnings);
    if (outcome.worktree) report.integrationDir = outcome.worktree;
    if (outcome.kind === 'nothing') {
      return done('nothing', true, t(lang, 'premerge.nothing', { branch, base }));
    }
    if (outcome.kind === 'no-copy') {
      return done('integration', false, t(lang, 'premerge.integrationFailed', {
        dir: integrationDir, error: outcome.message,
      }));
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

/**
 * Отчёт гейта для карточки задачи (T-144): зелёно/красно, какая проверка
 * упала и с каким выводом, файлы-дубли. Кладётся на пулл-реквест сразу же,
 * как гейт прогнан, — независимо от того, чем он кончился: конвейер может
 * встать следующим шагом, а карточка должна показывать, что видел гейт.
 */
export function toGateView(report: PreMergeReport): GateReportView {
  return {
    ok: report.ok,
    message: report.message,
    checks: report.checks.map((c) => ({ command: c.command, ok: c.ok, durationMs: c.durationMs })),
    failed: report.failed
      ? { command: report.failed.command, output: report.failed.output, files: report.failed.files }
      : null,
    overlaps: report.overlaps.map((o) => ({ file: o.file, symbols: o.symbols })),
    gateMs: report.gateMs,
    checkedAt: Date.now(),
  };
}

/** Отчёт словами: то, что печатает консольный скрипт и кладёт в ленту офис. */
export function formatReport(report: PreMergeReport, lang: Lang): string {
  const lines: string[] = [
    `${report.ok ? '✅' : '❌'} ${report.message}`,
    t(lang, 'premerge.reportBranch', { branch: report.branch, base: report.base }),
    // Каталог сборки печатаем всегда: когда основной занят, слияние уезжает
    // в запасной, и человек должен видеть, где на самом деле гонялись проверки.
    t(lang, 'premerge.reportCopy', { dir: report.integrationDir }),
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

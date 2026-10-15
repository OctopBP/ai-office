/**
 * Уборка веток и worktree задач из консоли. По умолчанию — пробный прогон:
 * печатает таблицу и ничего не трогает.
 *
 *   npm run cleanup:branches
 *   npm run cleanup:branches -- --apply
 *   npm run cleanup:branches -- --days 30 --orphans --apply
 *   npm run cleanup:branches -- --office o-2 --repo ~/Projects/ai/office
 *
 * Флаги:
 *   --apply        удалить помеченное (без него — dry-run);
 *   --days N       ветки прошлых попыток старше N дней (по умолчанию 14);
 *   --orphans      удалять и сирот без задачи (по умолчанию только показывать);
 *   --all          показать и то, что оставлено;
 *   --office ID    какой офис из реестра (по умолчанию текущий);
 *   --state FILE   файл состояния; рядом с ним ищется реестр offices.json
 *                  (по умолчанию OFFICE_STATE_FILE, иначе .office/state.json).
 *                  С --office состояние берётся из записи офиса в реестре;
 *   --repo DIR     репозиторий (по умолчанию папка проекта офиса);
 *   --worktrees DIR каталог копий офиса (по умолчанию ищется рядом с состоянием);
 *   --json         вывод в JSON.
 *
 * Состояние офиса читается из файла как есть — сервер для этого не нужен.
 * Без файла состояния --apply отказывает: не зная статусов задач, любая ветка
 * выглядела бы сиротой, а удалять вслепую нельзя.
 * Код выхода: 0 — всё прошло, 1 — с --apply что-то удалить не вышло, 2 — ошибка.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_DAYS, REASON_LABEL, findStale, formatAge, prune,
  type Candidate, type CleanupTask,
} from '../src/server/cleanup';
import { isRepo } from '../src/server/git';

interface Args {
  apply: boolean;
  days: number;
  orphans: boolean;
  all: boolean;
  office: string | null;
  state: string | null;
  repo: string | null;
  worktrees: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false, days: DEFAULT_DAYS, orphans: false, all: false,
    office: null, state: null, repo: null, worktrees: null, json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => argv[++i] ?? '';
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--days') {
      const n = Number(next());
      if (!Number.isFinite(n) || n < 0) throw new Error('--days ждёт неотрицательное число');
      args.days = n;
    } else if (arg === '--orphans') args.orphans = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--office') args.office = next();
    else if (arg === '--state') args.state = resolve(next());
    else if (arg === '--repo') args.repo = resolve(next());
    else if (arg === '--worktrees') args.worktrees = resolve(next());
    else if (arg === '--json') args.json = true;
    else throw new Error(`неизвестный флаг: ${arg}`);
  }
  return args;
}

interface OfficeRef { id: string; projectDir: string; stateFile: string }

/** Офис из реестра `offices.json`, что лежит рядом с файлом состояния. */
function pickOffice(args: Args): { office: OfficeRef | null; registryDir: string } {
  const defaultState = resolve(process.env.OFFICE_STATE_FILE ?? '.office/state.json');
  const registryDir = dirname(args.state ?? defaultState);
  const file = resolve(registryDir, 'offices.json');
  if (!existsSync(file)) return { office: null, registryDir };
  const data = JSON.parse(readFileSync(file, 'utf8')) as { currentId?: string; offices?: OfficeRef[] };
  const id = args.office ?? data.currentId;
  const office = data.offices?.find((o) => o.id === id) ?? null;
  if (args.office && !office) throw new Error(`в реестре ${file} нет офиса ${args.office}`);
  return { office, registryDir };
}

/**
 * Каталог копий офиса: сервер кладёт их в `<рабочая папка>/.office/worktrees/<офис>`.
 * В разработке состояние лежит там же, в `.office`, а в приложении — в
 * `<данные>/office`, и рабочая папка сервера — `<данные>`. Берём тот, что есть.
 */
function officeWorktrees(registryDir: string, id: string): string | null {
  const places = [
    resolve(registryDir, 'worktrees', id),
    resolve(dirname(registryDir), '.office', 'worktrees', id),
  ];
  return places.find((p) => existsSync(p)) ?? null;
}

function readTasks(stateFile: string): CleanupTask[] {
  if (!existsSync(stateFile)) return [];
  const data = JSON.parse(readFileSync(stateFile, 'utf8')) as { tasks?: CleanupTask[] };
  return (data.tasks ?? []).map((t) => ({
    id: t.id, status: t.status, merged: t.merged,
    branch: t.branch ?? null, baseBranch: t.baseBranch ?? null, worktreePath: t.worktreePath ?? null,
  }));
}

function table(rows: Candidate[], now: number): string {
  const head = ['', 'что', 'ветка / путь', 'задача', 'статус', 'последний коммит', 'причина', 'решение'];
  const body = rows.map((c) => [
    c.remove ? '✗' : '·',
    c.kind === 'worktree' ? 'worktree' : 'ветка',
    c.kind === 'worktree' ? `${c.path}${c.branch ? ` [${c.branch}]` : ''}` : c.branch ?? '',
    c.taskId ?? '—',
    c.status ?? '—',
    formatAge(c.lastCommitAt, now),
    REASON_LABEL[c.reason],
    c.remove ? 'удалить' : `оставить: ${c.hold}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (r: string[]): string => r.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), ...body.map(line)].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { office, registryDir } = pickOffice(args);
  // У каждого офиса свой файл состояния: --state лишь указывает, где реестр.
  const stateFile = args.office && office
    ? resolve(office.stateFile)
    : args.state ?? (office ? resolve(office.stateFile) : resolve(registryDir, 'state.json'));
  const repoDir = args.repo ?? office?.projectDir ?? process.cwd();
  if (!(await isRepo(repoDir))) throw new Error(`${repoDir} — не git-репозиторий`);

  if (args.apply && !existsSync(stateFile)) {
    throw new Error(`нет файла состояния ${stateFile} — без статусов задач удалять не буду (укажите --state)`);
  }

  const now = Date.now();
  const scan = await findStale({
    repoDir,
    tasks: readTasks(stateFile),
    worktreesRoot: args.worktrees ?? (office ? officeWorktrees(registryDir, office.id) : null),
  }, { days: args.days, orphans: args.orphans, now, cwd: process.cwd() });

  const shown = args.all ? scan.candidates : scan.candidates.filter((c) => c.remove || c.reason !== 'active');
  if (!args.apply) {
    if (args.json) {
      console.log(JSON.stringify({ ...scan, dryRun: true }, null, 2));
      return;
    }
    console.log(`Репозиторий: ${scan.repoDir}`);
    console.log(`Состояние офиса: ${stateFile}${existsSync(stateFile) ? '' : ' (не найдено — все ветки без задачи)'}`);
    console.log(shown.length ? table(shown, now) : 'Кандидатов нет.');
    for (const w of scan.warnings) console.log(`Внимание: ${w}`);
    const n = scan.candidates.filter((c) => c.remove).length;
    console.log(`\nПробный прогон: к удалению ${n}. Удалить — с флагом --apply.`);
    return;
  }

  const report = await prune(scan.repoDir, scan.candidates);
  if (args.json) {
    console.log(JSON.stringify({ ...report, warnings: scan.warnings }, null, 2));
  } else {
    const name = (c: Candidate): string => (c.kind === 'worktree' ? `worktree ${c.path}` : `ветка ${c.branch}`);
    console.log(`Репозиторий: ${scan.repoDir}`);
    console.log(`Удалено: ${report.removed.length}`);
    for (const c of report.removed) console.log(`  ✗ ${name(c)} — ${REASON_LABEL[c.reason]}${c.taskId ? `, ${c.taskId}` : ''}`);
    const failed = report.skipped.filter((s) => s.candidate.remove);
    const kept = report.skipped.filter((s) => !s.candidate.remove);
    if (failed.length) {
      console.log(`Не удалось удалить: ${failed.length}`);
      for (const s of failed) console.log(`  ! ${name(s.candidate)} — ${s.why}`);
    }
    console.log(`Оставлено: ${kept.length}`);
    for (const s of kept) {
      if (args.all || s.candidate.reason !== 'active') console.log(`  · ${name(s.candidate)} — ${s.why}`);
    }
    for (const w of scan.warnings) console.log(`Внимание: ${w}`);
  }
  if (report.skipped.some((s) => s.candidate.remove)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`cleanup-branches: ${(err as Error).message}`);
  process.exit(2);
});

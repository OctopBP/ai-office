/**
 * Пред-merge гейт из консоли: проверить рабочую копию, собрать пробное слияние,
 * прогнать проверки на его результате — и слить, только если всё зелёное.
 *
 *   npm run premerge -- --branch task/T-142
 *   npm run premerge -- --branch task/T-142 --stash --check "npm run test:merge"
 *   npm run premerge -- --branch task/T-142 --check-only
 *
 * Код выхода: 0 — зелено (влито или проверено), 1 — гейт остановил слияние,
 * 2 — сам гейт сорвался. Ровно то, что нужно для шага в CI.
 */
import { resolve } from 'node:path';
import { asLang } from '../src/shared/i18n';
import { t } from '../src/server/i18n';
import { baseBranch, isRepo } from '../src/server/git';
import { formatReport, preMergeGate } from '../src/server/premerge';

interface Args {
  branch: string | null;
  base: string | null;
  repo: string;
  stash: boolean;
  checkOnly: boolean;
  checks: string[];
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    branch: null, base: null, repo: process.cwd(),
    stash: false, checkOnly: false, checks: [], json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => argv[++i] ?? '';
    if (arg === '--branch' || arg === '-b') args.branch = next();
    else if (arg === '--base') args.base = next();
    else if (arg === '--repo') args.repo = resolve(next());
    else if (arg === '--stash') args.stash = true;
    else if (arg === '--check-only' || arg === '--dry-run') args.checkOnly = true;
    else if (arg === '--check') args.checks.push(next());
    else if (arg === '--json') args.json = true;
    else if (!arg.startsWith('-') && !args.branch) args.branch = arg;
  }
  return args;
}

async function main(): Promise<void> {
  const lang = asLang(process.env.OFFICE_LANG);
  const args = parseArgs(process.argv.slice(2));

  if (!args.branch) {
    console.error(t(lang, 'premerge.cliNoBranch'));
    console.error(t(lang, 'premerge.cliUsage'));
    process.exit(2);
  }
  if (!(await isRepo(args.repo))) {
    console.error(t(lang, 'premerge.cliNoRepo', { dir: args.repo }));
    process.exit(2);
  }
  // База по умолчанию — ветка рабочей копии: гейт запускают из основной.
  const base = args.base ?? (await baseBranch(args.repo));
  if (!base) {
    console.error(t(lang, 'premerge.cliNoBase'));
    process.exit(2);
  }

  const report = await preMergeGate({
    repoDir: args.repo,
    branch: args.branch,
    base,
    lang,
    stash: args.stash,
    merge: !args.checkOnly,
    checks: args.checks.length ? args.checks : undefined,
  });

  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report, lang));
  process.exit(report.ok ? 0 : 1);
}

void main().catch((err) => {
  const lang = asLang(process.env.OFFICE_LANG);
  console.error(t(lang, 'premerge.cliCrashed', {
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  }));
  process.exit(2);
});

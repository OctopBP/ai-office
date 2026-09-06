/**
 * office-agent — инструменты автора пакета. `npm run office-agent -- <команда>`
 *
 *   init <dir> --name @scope/name [--title "…"] [--lang ru|en]
 *       заготовка пакета: манифест, бриф, стенд, README, CHANGELOG
 *   validate [dir]
 *       схема манифеста, plugin.json, скилы, секреты, части плагина, которые
 *       офис не берёт; ошибки — код выхода 1
 *   bench [dir] [n]
 *       стенд срабатывания скилов по bench/cases.json пакета (стоит токенов)
 *   publish [dir] [--registry <file>] [--repo <url>] [--tag] [--write]
 *       запись реестра для текущего коммита: печатает её, с --write вписывает
 *       в файл реестра, с --tag ставит тег версии на HEAD
 *   registry-check <file> [--fetch]
 *       проверка реестра: форма, области имён, а с --fetch — установка каждой
 *       старшей версии и сверка имени; для CI индекса
 *
 * Все команды работают по папке пакета и ничего из него не запускают.
 */
import { resolve } from 'node:path';
import { git } from '../server/git';
import { formatOutcome, readBenchCases, runBenchCase } from '../server/bench';
import { scaffoldPackage } from '../server/export';
import { validatePackage, type PackageProblem } from '../server/packages';
import {
  checkRegistry, packageAt, publishInfo, readRegistryFile, upsertEntry, writeRegistryFile,
} from '../server/publish';
import { roleFromPackage, roleIdFor } from '../server/roles';
import { asLang, type Lang } from '../shared/i18n';

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (v: string | true | undefined): string => (typeof v === 'string' ? v : '');

function printProblems(problems: PackageProblem[]): void {
  for (const p of problems) console.log(`  ${p.level === 'error' ? 'ERROR' : 'warn '} ${p.path}: ${p.message}`);
}

function usage(): never {
  console.log([
    'office-agent <command>',
    '  init <dir> --name @scope/name [--title "…"] [--lang ru|en]',
    '  validate [dir]',
    '  bench [dir] [n]',
    '  publish [dir] [--registry <file>] [--repo <url>] [--tag] [--write]',
    '  registry-check <file> [--fetch]',
  ].join('\n'));
  process.exit(2);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);

  if (command === 'init') {
    const dir = resolve(positional[0] ?? '');
    const name = str(flags.name);
    if (!positional[0] || !name) usage();
    const lang: Lang = asLang(str(flags.lang) || 'en');
    const title = str(flags.title) || name.split('/').pop() || name;
    const { problems } = scaffoldPackage(dir, {
      name,
      title: { [lang]: title },
      briefs: { [lang]: lang === 'ru'
        ? `Ты — ${title}. Опиши здесь обязанности и границы роли: за что отвечает, чего не делает, что считается сделанной работой.`
        : `You are ${title}. Describe the role's duties and limits here: what it owns, what it does not do, what counts as done.` },
    });
    console.log(`package ${name} created in ${dir}`);
    printProblems(problems);
    console.log('next: edit agent.json and brief/, add skills/<name>/SKILL.md, then `office-agent validate`');
    return 0;
  }

  if (command === 'validate') {
    const dir = resolve(positional[0] ?? '.');
    const problems = validatePackage(dir);
    const errors = problems.filter((p) => p.level === 'error').length;
    console.log(`${dir}: ${errors ? `${errors} error(s)` : 'ok'}${problems.length - errors ? `, ${problems.length - errors} warning(s)` : ''}`);
    printProblems(problems);
    return errors ? 1 : 0;
  }

  if (command === 'bench') {
    const dir = resolve(positional[0] ?? '.');
    const pkg = packageAt(dir);
    if ('error' in pkg) { console.error(pkg.error); return 1; }
    const lang: Lang = asLang(str(flags.lang) || 'en');
    const cases = readBenchCases(dir);
    if (!cases.length) { console.error(`no cases: put them in ${resolve(dir, 'bench/cases.json')}`); return 2; }
    const only = positional[1] ? Number(positional[1]) : null;
    const picked = only ? cases.filter((_, i) => i + 1 === only) : cases;
    if (!picked.length) { console.error(`no case #${only}: there are ${cases.length}`); return 2; }
    const role = roleFromPackage(pkg, lang, roleIdFor(pkg.name));
    console.log(`bench for ${pkg.name} ${pkg.version} (${picked.length} case(s); live sessions, costs tokens)\n`);
    let failed = 0;
    let spent = 0;
    for (const c of picked) {
      const outcome = await runBenchCase(role, c, { lang, cwd: dir });
      if (!outcome.ok) failed += 1;
      spent += outcome.costUsd;
      console.log(formatOutcome(outcome));
    }
    console.log(failed ? `failed ${failed} of ${picked.length}, spent $${spent.toFixed(4)}` : `all ${picked.length} passed, spent $${spent.toFixed(4)}`);
    return failed ? 1 : 0;
  }

  if (command === 'publish') {
    const dir = resolve(positional[0] ?? '.');
    const errors = validatePackage(dir).filter((p) => p.level === 'error');
    if (errors.length) { console.log('package has errors, fix them first:'); printProblems(errors); return 1; }
    const info = await publishInfo(dir, { repo: str(flags.repo) || undefined });
    if ('error' in info) { console.error(info.error); return 1; }
    if (info.dirty) console.log('warning: uncommitted changes in the package — the entry points at HEAD, not at them');
    if (!info.tagged) {
      if (flags.tag) {
        const made = await git(dir, ['tag', info.tag, info.commit]);
        if (!made.ok) { console.error(`cannot tag: ${made.stderr}`); return 1; }
        console.log(`tagged ${info.tag} at ${info.commit.slice(0, 7)}`);
        info.tagged = true;
      } else {
        console.log(`warning: no tag ${info.tag} at HEAD — add --tag to create it, or the registry entry will be the only pointer to this commit`);
      }
    }
    console.log(JSON.stringify(info.entry, null, 2));
    const file = str(flags.registry);
    if (flags.write) {
      if (!file) { console.error('--write needs --registry <file>'); return 1; }
      const registry = readRegistryFile(resolve(file));
      if ('error' in registry) { console.error(registry.error); return 1; }
      writeRegistryFile(resolve(file), upsertEntry(registry, info.entry));
      console.log(`written to ${file}: open a pull request with this change`);
    } else {
      console.log(file ? `add --write to put it into ${file}` : 'pass --registry <file> --write to put it into a registry file, then open a pull request');
    }
    return 0;
  }

  if (command === 'registry-check') {
    const file = positional[0];
    if (!file) usage();
    const { problems, checked } = await checkRegistry(resolve(file), { fetch: flags.fetch === true, log: (l) => console.log(`  ${l}`) });
    for (const p of problems) console.log(`  ERROR ${p.name ? `${p.name}: ` : ''}${p.message}`);
    console.log(problems.length ? `${file}: ${problems.length} problem(s)` : `${file}: ok${flags.fetch ? `, ${checked} package(s) fetched and verified` : ''}`);
    return problems.length ? 1 : 0;
  }

  usage();
}

process.exit(await main(process.argv.slice(2)));

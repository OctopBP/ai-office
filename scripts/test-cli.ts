// Проверка авторского пути: заготовка пакета, валидатор, экспорт роли из
// офиса, публикация в реестр и проверка реестра. npm run test:cli
//
// Сети нет: репозиторий автора собирается во времянке, «GitHub» в адресе
// origin подставляется руками — проверка областей смотрит на адрес, а не
// ходит по нему; выемка при `--fetch` идёт из того же локального пути.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = mkdtempSync(resolve(tmpdir(), 'office-cli-'));
process.env.OFFICE_PACKAGE_CACHE = resolve(root, 'cache');
process.env.OFFICE_EMPLOYEES_DIR = resolve(root, 'employees');
process.env.OFFICE_LANG = 'ru';

const { scaffoldPackage, exportRole, modelAlias } = await import('../src/server/export');
const { validatePackage, readPackage } = await import('../src/server/packages');
const {
  checkRegistry, githubSlug, publishInfo, readRegistryFile, scopeProblem, upsertEntry, writeRegistryFile,
} = await import('../src/server/publish');
const { readBenchCases } = await import('../src/server/bench');
const { openOfficeState, unloadOfficeState } = await import('../src/server/state');
const { wipe } = await import('../src/server/store');

let failed = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(52)} → ${JSON.stringify(got)?.slice(0, 120)}`
    + (ok ? '' : ` (ждали ${JSON.stringify(want)?.slice(0, 120)})`));
};
const cli = (args: string[]): { code: number; out: string } => {
  try {
    return { code: 0, out: execFileSync('node', ['--import', 'tsx/esm', 'src/cli/office-agent.ts', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
};

// ------------------------------------------------------------ заготовка

const fresh = resolve(root, 'fresh');
const made = scaffoldPackage(fresh, { name: '@alice/writer', title: { en: 'Writer' }, briefs: { en: 'You write.' } });
check('заготовка без ошибок', made.problems.filter((p) => p.level === 'error'), []);
check('заготовка предупреждает про лицензию', made.problems.some((p) => p.path === 'license'), true);
check('файлы заготовки на месте', ['agent.json', '.claude-plugin/plugin.json', 'brief/en.md', 'bench/cases.json', 'README.md', 'CHANGELOG.md'].every((f) => existsSync(resolve(fresh, f))), true);
check('заготовка читается как пакет', readPackage(fresh).pkg?.name, '@alice/writer');
check('в непустую папку не пишем', (() => { try { scaffoldPackage(fresh, { name: '@alice/x', title: {} }); return 'wrote'; } catch (e) { return /not empty/.test((e as Error).message); } })(), true);
check('плохое имя — отказ', (() => { try { scaffoldPackage(resolve(root, 'bad'), { name: 'writer', title: {} }); return 'wrote'; } catch { return 'refused'; } })(), 'refused');
check('стенд заготовки читается', readBenchCases(fresh).length, 1);
check('алиас модели из полного id', [modelAlias('claude-opus-5-5'), modelAlias('claude-x-1')], ['opus', 'claude-x-1']);

// ----------------------------------------------------------------- CLI

const viaCli = cli(['init', resolve(root, 'cli-init'), '--name', '@bob/analyst', '--title', 'Аналитик', '--lang', 'ru']);
check('office-agent init', [viaCli.code, existsSync(resolve(root, 'cli-init/brief/ru.md'))], [0, true]);
check('office-agent validate: ok', cli(['validate', resolve(root, 'cli-init')]).code, 0);
writeFileSync(resolve(root, 'cli-init/agent.json'), '{"schema":1,"name":"nope"}');
const bad = cli(['validate', resolve(root, 'cli-init')]);
check('office-agent validate: ошибки → код 1', [bad.code, /ERROR name/.test(bad.out)], [1, true]);
check('office-agent без команды — подсказка', cli([]).code, 2);

// ------------------------------------------------------- экспорт роли

const projectDir = resolve(root, 'project');
mkdirSync(projectDir, { recursive: true });
const stateFile = resolve(root, 'office.json');
const office = openOfficeState({ id: 'o-cli', projectDir, stateFile }).state;
office.seed();
// Роль из встроенного пакета с припиской и оверрайдом: экспорт — форк, бриф целиком.
office.updateRole('backend', { briefExtra: 'Стек: Fastify.', model: 'claude-haiku-4-5' });
const exported = exportRole(office.role('backend')!, '@alice/backend', '', projectDir, 'ru');
check('экспорт привязанной роли', exported.ok && exported.dir, resolve(projectDir, 'agents/backend'));
const expPkg = exported.ok ? readPackage(exported.dir).pkg : null;
check('манифест из роли: модель алиасом и внешность', [expPkg?.manifest.runtime.model, expPkg?.manifest.look], ['haiku', office.role('backend')!.sprite ?? '']);
check('бриф целиком с припиской', expPkg?.briefs.ru, `${office.role('backend')!.brief}`);
check('ссылки на исходный пакет в экспорте нет', JSON.stringify(readFileSync(resolve(projectDir, 'agents/backend/agent.json'), 'utf8')).includes('@office/backend'), false);
check('повторный экспорт в ту же папку — отказ', exportRole(office.role('backend')!, '@alice/backend', '', projectDir, 'ru').ok, false);
check('плохое имя — отказ текстом', (exportRole(office.role('backend')!, 'backend', 'x', projectDir, 'ru') as { error: string }).error.includes('@область/имя'), true);

// Роль, заведённая руками, со своим набором скилов в employees/<id>/ —
// имя папки равно id роли, а id офис собирает сам из названия.
const created = await office.createRole({ title: 'Писатель', brief: 'Пишешь тексты.', model: 'claude-sonnet-5' });
const writerId = 'role' in created ? created.role.id : '';
const legacy = resolve(root, 'employees', writerId);
mkdirSync(resolve(legacy, 'skills/prose'), { recursive: true });
mkdirSync(resolve(legacy, '.claude-plugin'), { recursive: true });
writeFileSync(resolve(legacy, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'writer', version: '0.0.1' }));
writeFileSync(resolve(legacy, 'skills/prose/SKILL.md'), '---\nname: prose\ndescription: Write prose.\n---\n\nWrite well.\n');
writeFileSync(resolve(legacy, 'pack.json'), JSON.stringify({ builtin: ['dataviz'] }));
const exported2 = exportRole(office.role(writerId)!, '@alice/writer', resolve(root, 'writer-pkg'), projectDir, 'ru');
const w = exported2.ok ? readPackage(exported2.dir).pkg : null;
check('экспорт ручной роли: скилы и встроенные из employees', [existsSync(resolve(root, 'writer-pkg/skills/prose/SKILL.md')), w?.manifest.builtin], [true, ['dataviz']]);
check('экспорт ручной роли: бриф и модель', [w?.briefs.ru, w?.manifest.runtime.model], ['Пишешь тексты.', 'sonnet']);
check('экспорт проходит валидатор', validatePackage(resolve(root, 'writer-pkg')).filter((p) => p.level === 'error'), []);
unloadOfficeState('o-cli');
wipe(stateFile);

// ----------------------------------------------------------- публикация

const repo = resolve(root, 'alice-agents');
const gitq = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
mkdirSync(repo, { recursive: true });
gitq(['init', '-q', '-b', 'main']);
gitq(['config', 'user.email', 't@e.com']);
gitq(['config', 'user.name', 't']);
// «origin» показывает на GitHub — для правила областей; выемка при проверке
// идёт по локальному пути, который подставим в реестр сами.
gitq(['remote', 'add', 'origin', 'git@github.com:Alice/agents.git']);
scaffoldPackage(resolve(repo, 'packages/writer'), { name: '@alice/writer', title: { en: 'Writer' }, briefs: { en: 'You write.' }, license: 'MIT' });
gitq(['add', '-A']);
gitq(['commit', '-q', '-m', 'writer 0.1.0']);
const head = gitq(['rev-parse', 'HEAD']);

const info = await publishInfo(resolve(repo, 'packages/writer'));
check('запись реестра: имя, путь, версия, коммит', 'error' in info ? info.error : [info.entry.name, info.entry.path, info.version, info.commit], ['@alice/writer', 'packages/writer', '0.1.0', head]);
check('ssh-адрес origin нормализован в https', 'error' in info ? '' : info.entry.repo, 'https://github.com/Alice/agents.git');
check('тега ещё нет', 'error' in info ? '' : [info.tag, info.tagged, info.dirty], ['writer@0.1.0', false, false]);
const registryFile = resolve(root, 'registry.json');
const published = cli(['publish', resolve(repo, 'packages/writer'), '--registry', registryFile, '--write', '--tag']);
check('office-agent publish --write --tag', [published.code, /tagged writer@0.1.0/.test(published.out)], [0, true]);
check('тег появился на HEAD', gitq(['rev-parse', 'writer@0.1.0^{commit}']), head);
const reg = readRegistryFile(registryFile);
check('реестр записан', 'error' in reg ? reg.error : reg.packages.map((e) => [e.name, e.trust, e.versions[0].commit]), [['@alice/writer', 'community', head]]);

// Вторая версия ложится сверху, доверие не трогается.
if (!('error' in reg)) {
  const withTrust = { ...reg, packages: reg.packages.map((e) => ({ ...e, trust: 'verified' as const })) };
  const next = upsertEntry(withTrust, { ...reg.packages[0], versions: [{ version: '0.2.0', commit: 'f'.repeat(40) }] });
  check('новая версия сверху, доверие сохранено', [next.packages[0].versions.map((v) => v.version), next.packages[0].trust], [['0.2.0', '0.1.0'], 'verified']);
}

// ----------------------------------------------------- проверка реестра

check('область по владельцу GitHub', scopeProblem('@alice/writer', 'https://github.com/Alice/agents.git'), null);
check('чужая область — ошибка', /does not match/.test(scopeProblem('@bob/writer', 'https://github.com/alice/agents.git') ?? ''), true);
check('@office только нашему репозиторию', [scopeProblem('@office/x', 'https://github.com/OctopBP/ai-office.git'), /reserved/.test(scopeProblem('@office/x', 'https://github.com/alice/x.git') ?? '')], [null, true]);
check('не GitHub — область не выдать', /only GitHub/.test(scopeProblem('@alice/x', '/tmp/repo') ?? ''), true);
check('slug из ssh и https', [githubSlug('git@github.com:A/b.git'), githubSlug('https://github.com/A/b')], ['A/b', 'A/b']);

const dry = await checkRegistry(registryFile);
check('реестр после publish проходит форму', dry.problems, []);
// Для выемки подменяем адрес на локальный путь: сети нет. Правило областей
// при этом споткнётся — проверим и это.
const local = readRegistryFile(registryFile) as unknown as { schema: 1; packages: Array<Record<string, unknown>> };
writeRegistryFile(resolve(root, 'registry-local.json'), { schema: 1, packages: [{ ...local.packages[0], repo }] } as never);
const fetched = await checkRegistry(resolve(root, 'registry-local.json'), { fetch: true });
check('выемка по коммиту подтверждает пакет', [fetched.checked, fetched.problems.map((p) => /only GitHub/.test(p.message))], [1, [true]]);
writeRegistryFile(resolve(root, 'registry-bad.json'), {
  schema: 1,
  packages: [
    { ...local.packages[0], repo, versions: [{ version: '0.1.0', commit: 'abc' }] },
    { name: '@alice/writer', repo, versions: [{ version: 'latest', commit: head }] },
    { name: 'oops' },
  ],
} as never);
const broken = await checkRegistry(resolve(root, 'registry-bad.json'));
// Разбор выкидывает записи без годной версии (короткий хеш) и без имени —
// проверка считает их ошибкой числом; у оставшейся — область и не-semver.
check('плохой реестр: битые записи, область, не semver', broken.problems.map((p) => p.message.split(' ')[0]).sort(), ['2', 'scope', 'version']);
const viaCheck = cli(['registry-check', resolve(root, 'registry-bad.json')]);
check('office-agent registry-check → код 1', viaCheck.code, 1);
check('office-agent registry-check: наш реестр по форме', cli(['registry-check', 'registry/registry.json']).code, 0);

rmSync(root, { recursive: true, force: true });
console.log(failed ? `\nпровалено кейсов: ${failed}` : '\nвсе кейсы прошли');
process.exit(failed ? 1 : 0);

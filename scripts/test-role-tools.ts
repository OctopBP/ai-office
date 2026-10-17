// Проверка фиксов ролей и инструментов движка (T-612, D-5 S1 и S3):
// - скилы роли, нанятой из кеша маркета, доезжают до сессии;
// - createRole сохраняет mcp и capabilities из черновика;
// - у каждого движка есть список встроенных инструментов, и он уходит вебу;
// - незнакомый движку инструмент даёт предупреждение в parseManifest и при найме.
// npm run test:roletools
//
// Кеш, встроенные пакеты и employees/ уводятся во времянку: прогон не трогает
// ни ~/.office, ни packages/ репозитория.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = mkdtempSync(resolve(tmpdir(), 'office-roletools-'));
const cache = resolve(root, 'cache');
const builtin = resolve(root, 'builtin');
process.env.OFFICE_PACKAGE_CACHE = cache;
process.env.OFFICE_PACKAGES_DIR = builtin;
process.env.OFFICE_EMPLOYEES_DIR = resolve(root, 'employees');
process.env.OFFICE_REGISTRY = resolve(root, 'registry.json');
process.env.OFFICE_LANG = 'ru';

/** Пакет на диске: манифест, плагин и, по желанию, один скил. */
function writePackage(
  dir: string, name: string, version: string,
  opts: { manager?: boolean; skill?: string; engine?: string; tools?: string[] } = {},
): void {
  const short = name.split('/').pop()!;
  mkdirSync(resolve(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(resolve(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: short, version, description: 'test' }));
  writeFileSync(resolve(dir, 'agent.json'), JSON.stringify({
    schema: 1, name, title: { ru: `Роль ${short}`, en: `Role ${short}` }, license: 'MIT',
    ...(opts.manager ? { manager: true } : {}),
    runtime: {
      ...(opts.engine ? { engine: opts.engine } : { model: 'haiku' }),
      ...(opts.tools ? { tools: opts.tools } : {}),
    },
  }));
  if (opts.skill) {
    mkdirSync(resolve(dir, 'skills', opts.skill), { recursive: true });
    writeFileSync(resolve(dir, 'skills', opts.skill, 'SKILL.md'),
      `---\nname: ${opts.skill}\ndescription: Проверочный скил.\n---\n\nСкажи «кеш».\n`);
  }
}

writePackage(resolve(builtin, '@office/pm'), '@office/pm', '0.1.0', { manager: true });
writeFileSync(resolve(builtin, 'default-office.json'), JSON.stringify({ roles: ['@office/pm'] }));

// Состояние первым: у модулей сервера круговые импорты, и порядок, как в
// живом сервере, обходит обращение к ещё не заданной константе.
const { openOfficeState } = await import('../src/server/state');
const { cacheDir, parseManifest, readPackage } = await import('../src/server/packages');
const { employeePack, employeeSkills } = await import('../src/server/skills');
const { ENGINE_BUILTIN_TOOLS, OFFICE_HANDS_TOOLS, unknownEngineTools } = await import('../src/shared/providers');
const { claudeCodeEngine } = await import('../src/server/engines/claude-code');
const { codexEngine } = await import('../src/server/engines/codex');
const { opencodeEngine } = await import('../src/server/engines/opencode');
const { officeCatalog } = await import('../src/server/providers/codex-tools');

let failed = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(60)} → ${JSON.stringify(got)?.slice(0, 120)}`
    + (ok ? '' : ` (ждали ${JSON.stringify(want)?.slice(0, 120)})`));
};

const projectDir = resolve(root, 'project');
mkdirSync(projectDir, { recursive: true });
const office = openOfficeState({ id: 'o-roletools', projectDir, stateFile: resolve(root, 'office.json') }).state;
office.seed();
office.updateSettings({ model: { provider: 'claude-code', model: 'claude-sonnet-5-5' } });
// Найму нужны столы: по умолчанию их хватает, но проверим явно, чтобы
// отказ «некуда сесть» не выдал себя за провал фикса.
const hireOk = (problem: string | null): boolean => problem === null;

// ------------------------------------------- S1.1: скилы пакета из кеша

console.log('\nСкилы роли из кеша маркета');
const writerDir = cacheDir('@acme/writer', '1.0.0', cache);
writePackage(writerDir, '@acme/writer', '1.0.0', { skill: 'drafts' });
const writer = readPackage(writerDir).pkg!;
check('пакет в кеше читается', writer?.name, '@acme/writer');
const source = { repo: resolve(root, 'acme-agents'), path: 'agents/writer', commit: 'a'.repeat(40) };
check('найм из кеша', hireOk(office.hireFromPackage(writer, source)), true);
const writerRole = office.roles().find((r) => r.package?.name === '@acme/writer')!;
check('у роли ссылка на источник', Boolean(writerRole?.package?.source), true);
check('пакет роли найден в кеше', employeePack(writerRole)?.dirs, [writerDir]);
check('скил пакета доезжает до сессии', employeeSkills(writerRole), ['writer:drafts']);
// Встроенный пакет по-прежнему из packages/.
writePackage(resolve(builtin, '@office/helper'), '@office/helper', '0.1.0', { skill: 'help' });
const helper = readPackage(resolve(builtin, '@office/helper')).pkg!;
check('найм встроенного', hireOk(office.hireFromPackage(helper, null)), true);
const helperRole = office.roles().find((r) => r.package?.name === '@office/helper')!;
check('скил встроенного пакета на месте', employeeSkills(helperRole), ['helper:help']);
// Пакета нет на диске — набора нет, а не чужая папка.
check('пакета нет — набора нет', employeePack({ ...writerRole, package: { ...writerRole.package!, version: '9.9.9' } }), null);

// ----------------------------------- S1.2: createRole не теряет поля

console.log('\ncreateRole сохраняет mcp и capabilities');
const made = await office.createRole({ title: 'Исследователь', mcp: ['imagegen'], capabilities: ['research.web', 'nope'] as never });
const madeRole = 'role' in made ? made.role : null;
check('роль создана', 'errors' in made ? made.errors : 'ok', 'ok');
check('mcp из черновика', madeRole?.mcp, ['imagegen']);
check('capabilities из черновика, без незнакомых', madeRole?.capabilities, ['research.web']);
check('в наборе офиса то же', office.role(madeRole?.id ?? '')?.mcp, ['imagegen']);
const bare = await office.createRole({ title: 'Пустышка' });
const bareRole = 'role' in bare ? bare.role : null;
check('без подписки — явный пустой список', bareRole?.mcp, []);
check('без умений — поля нет', bareRole && 'capabilities' in bareRole, false);

// --------------------------------------- S3: builtinTools у движков

console.log('\nВстроенные инструменты движков');
for (const engine of [claudeCodeEngine, codexEngine, opencodeEngine]) {
  check(`${engine.id}: builtinTools из общей матрицы`, engine.builtinTools, ENGINE_BUILTIN_TOOLS[engine.id]);
  check(`${engine.id}: руки офиса есть`, OFFICE_HANDS_TOOLS.every((t) => engine.builtinTools.includes(t)), true);
}
check('WebSearch: Claude Code и Codex, не OpenCode',
  [claudeCodeEngine, codexEngine, opencodeEngine].map((e) => e.builtinTools.includes('WebSearch')), [true, true, false]);
check('WebFetch только у Claude Code',
  [claudeCodeEngine, codexEngine, opencodeEngine].map((e) => e.builtinTools.includes('WebFetch')), [true, false, false]);
// Список рук офиса сверен с тем, что каталог реально заводит.
const catalog = await officeCatalog({ cwd: projectDir }, async () => ({ stdout: '', stderr: '', exitCode: 0 }), 'bash');
check('руки офиса = officeCatalog', catalog.tools.map((t) => t.name).sort(), [...OFFICE_HANDS_TOOLS].sort());
await catalog.close();
check('Skill не проверяется по списку', unknownEngineTools('opencode', ['Read', 'Skill', 'WebSearch']), ['WebSearch']);

// ---------------------------- S3: предупреждение о незнакомом инструменте

console.log('\nПредупреждение о незнакомом инструменте');
const warns = (raw: Record<string, unknown>): string[] =>
  parseManifest({ schema: 1, name: '@acme/x', title: 'X', ...raw }, '@acme/x').problems
    .filter((p) => p.path === 'runtime.tools').map((p) => `${p.level}: ${p.message}`);
check('codex + WebFetch — предупреждение', warns({ runtime: { engine: 'codex', tools: ['Read', 'WebFetch'] } }),
  ['warn: unknown tool "WebFetch" for engine codex']);
check('провайдер OpenCode — по его движку', warns({ runtime: { engine: 'xai', tools: ['WebSearch'] } }),
  ['warn: unknown tool "WebSearch" for engine opencode']);
check('claude-code + WebFetch — тихо', warns({ runtime: { tools: ['Read', 'WebFetch', 'Artifact'] } }), []);
check('опечатка — предупреждение', warns({ runtime: { tools: ['Raed'] } }), ['warn: unknown tool "Raed" for engine claude-code']);
check('без списка — тихо', warns({ runtime: {} }), []);
check('предупреждение не ломает пакет', parseManifest({ schema: 1, name: '@acme/x', title: 'X',
  runtime: { engine: 'codex', tools: ['WebFetch'] } }, '@acme/x').problems.some((p) => p.level === 'error'), false);

const coderDir = cacheDir('@acme/coder', '1.0.0', cache);
writePackage(coderDir, '@acme/coder', '1.0.0', { engine: 'codex', tools: ['Read', 'Bash', 'WebFetch'] });
const coder = readPackage(coderDir).pkg!;
const logBefore = office.log.length;
check('найм пакета на Codex', hireOk(office.hireFromPackage(coder, { ...source, path: 'agents/coder' })), true);
const coderRole = office.roles().find((r) => r.package?.name === '@acme/coder')!;
check('незнакомые инструменты роли', office.unknownRoleTools(coderRole), { engine: 'codex', tools: ['WebFetch'] });
const hireWarn = office.log.slice(logBefore).find((e) => /WebFetch/.test(e.text));
check('при найме — предупреждение в ленте', hireWarn?.kind, 'system');
check('текст называет движок', /codex/.test(hireWarn?.text ?? ''), true);
check('у знакомых инструментов предупреждения нет', office.unknownRoleTools(writerRole), null);

rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} проверок упало` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);

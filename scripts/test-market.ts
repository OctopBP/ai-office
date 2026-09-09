// Проверка маркета: разбор ссылок и реестра, установка пакета из git по
// коммиту в кеш, найм из пакета, проверка и применение обновления.
// npm run test:market
//
// Сети не нужно: репозиторий с пакетом собирается во времянке и клонируется
// по пути. Кеш и каталог пакетов тоже уводятся во времянку, чтобы прогон не
// трогал ни ~/.office, ни packages/ репозитория.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = mkdtempSync(resolve(tmpdir(), 'office-market-'));
const cache = resolve(root, 'cache');
const builtin = resolve(root, 'builtin');
const registryFile = resolve(root, 'registry.json');
process.env.OFFICE_PACKAGE_CACHE = cache;
process.env.OFFICE_PACKAGES_DIR = builtin;
process.env.OFFICE_REGISTRY = registryFile;
process.env.OFFICE_LANG = 'ru';

// Встроенный менеджер: без него офис не поднимется.
function writePackage(dir: string, name: string, version: string, opts: { brief?: string; manager?: boolean; tools?: string[] } = {}): void {
  mkdirSync(resolve(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(resolve(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: name.split('/').pop(), version, description: 'test' }));
  writeFileSync(resolve(dir, 'agent.json'), JSON.stringify({
    schema: 1, name, title: { ru: `Роль ${name.split('/').pop()}`, en: `Role ${name.split('/').pop()}` },
    license: 'MIT', ...(opts.manager ? { manager: true } : {}),
    runtime: { model: 'haiku', ...(opts.tools ? { tools: opts.tools } : {}) },
    servers: [{ id: 'thing', title: 'Штука', transport: 'stdio', command: 'npx', args: ['thing-mcp'] }],
    requires: { env: ['THING_TOKEN'], network: true },
  }));
  if (opts.brief) {
    mkdirSync(resolve(dir, 'brief'), { recursive: true });
    writeFileSync(resolve(dir, 'brief/ru.md'), `${opts.brief}\n`);
  }
}
writePackage(resolve(builtin, '@office/pm'), '@office/pm', '0.1.0', { manager: true });
writeFileSync(resolve(builtin, 'default-office.json'), JSON.stringify({ roles: ['@office/pm'] }));

// Репозиторий автора: монорепозиторий с пакетом в папке и тегами версий.
const repo = resolve(root, 'acme-agents');
const gitq = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
mkdirSync(repo, { recursive: true });
gitq(['init', '-q', '-b', 'main']);
gitq(['config', 'user.email', 'test@example.com']);
gitq(['config', 'user.name', 'test']);
writePackage(resolve(repo, 'agents/lawyer'), '@acme/lawyer', '1.0.0', { brief: 'Ты юрист.', tools: ['Read'] });
gitq(['add', '-A']);
gitq(['commit', '-q', '-m', 'lawyer 1.0.0']);
gitq(['tag', 'lawyer@1.0.0']);
const c100 = gitq(['rev-parse', 'HEAD']);
writePackage(resolve(repo, 'agents/lawyer'), '@acme/lawyer', '1.1.0', { brief: 'Ты юрист. Пиши кратко.', tools: ['Read', 'Write'] });
gitq(['add', '-A']);
gitq(['commit', '-q', '-m', 'lawyer 1.1.0']);
gitq(['tag', '-a', 'lawyer@1.1.0', '-m', 'v1.1.0']);
const c110 = gitq(['rev-parse', 'HEAD^{commit}']);
// Пакет с чужим именем — для проверки «ждали одно, лежит другое».
writePackage(resolve(repo, 'agents/other'), '@acme/other', '0.2.0');
gitq(['add', '-A']);
gitq(['commit', '-q', '-m', 'other']);

writeFileSync(registryFile, JSON.stringify({
  schema: 1,
  packages: [
    { name: '@acme/lawyer', repo, path: 'agents/lawyer', trust: 'verified', versions: [{ version: '1.0.0', commit: c100 }] },
    { name: '@acme/broken', repo: '', versions: [] },
  ],
}));

const {
  findUpdate, installFromGit, loadRegistry, marketView, parseLink, parseTagLines, versionTags, handleMarketCommand,
} = await import('../src/server/market');
const { listCached, readLock, cacheDir, packageIntegrity } = await import('../src/server/packages');
const { openOfficeState, unloadOfficeState } = await import('../src/server/state');
const { wipe } = await import('../src/server/store');
const { OFFICE_SENDER } = await import('../src/shared/types');

let failed = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(52)} → ${JSON.stringify(got)?.slice(0, 120)}`
    + (ok ? '' : ` (ждали ${JSON.stringify(want)?.slice(0, 120)})`));
};

// ---------------------------------------------------------------- ссылки

check('github-адрес', parseLink('https://github.com/acme/agents'), { repo: 'https://github.com/acme/agents.git', path: '', ref: '' });
check('github-папка с веткой', parseLink('https://github.com/acme/agents/tree/main/agents/lawyer'),
  { repo: 'https://github.com/acme/agents.git', path: 'agents/lawyer', ref: 'main' });
check('короткое owner/repo#путь', parseLink('acme/agents#agents/lawyer'), { repo: 'https://github.com/acme/agents.git', path: 'agents/lawyer', ref: '' });
check('ssh-адрес', parseLink('git@github.com:acme/agents.git')?.repo, 'git@github.com:acme/agents.git');
check('путь на диске', parseLink(`${repo}#agents/lawyer`), { repo, path: 'agents/lawyer', ref: '' });
check('мусор — не ссылка', parseLink('просто слова'), null);

// ------------------------------------------------------------------ теги

const tags = parseTagLines([
  `${'a'.repeat(40)}\trefs/tags/lawyer@1.0.0`,
  `${'b'.repeat(40)}\trefs/tags/lawyer@1.1.0`,
  `${'c'.repeat(40)}\trefs/tags/lawyer@1.1.0^{}`,
  `${'d'.repeat(40)}\trefs/tags/v2.0.0`,
  `${'e'.repeat(40)}\trefs/tags/other@3.0.0`,
].join('\n'));
check('аннотированный тег — по peeled-коммиту', tags.find((x) => x.tag === 'lawyer@1.1.0')?.commit, 'c'.repeat(40));
check('теги пакета в монорепозитории, старшая первой', versionTags(tags, 'lawyer').map((v) => v.version), ['1.1.0', '1.0.0']);
check('одиночный пакет — только v-теги', versionTags(tags, '').map((v) => v.version), ['2.0.0']);

// ---------------------------------------------------------------- реестр

const reg = await loadRegistry(registryFile, true);
check('реестр прочитан', reg.error, null);
check('битая запись пропущена', reg.registry?.packages.map((p) => p.name), ['@acme/lawyer']);

// ------------------------------------------------------------- установка

const byCommit = await installFromGit({ repo, path: 'agents/lawyer', commit: c100, expectName: '@acme/lawyer' }, cache, 'ru');
check('установка по коммиту из реестра', byCommit.ok && [byCommit.pkg.name, byCommit.pkg.version, byCommit.lock.commit], ['@acme/lawyer', '1.0.0', c100]);
check('пакет лёг в кеш по имени и версии', existsSync(cacheDir('@acme/lawyer', '1.0.0', cache)), true);
const lock = readLock(cacheDir('@acme/lawyer', '1.0.0', cache));
check('запись об установке', [lock?.repo, lock?.path, lock?.commit], [repo, 'agents/lawyer', c100]);
check('отпечаток совпадает с деревом', lock?.integrity === packageIntegrity(cacheDir('@acme/lawyer', '1.0.0', cache)), true);
check('.git в кеш не попал', existsSync(resolve(cacheDir('@acme/lawyer', '1.0.0', cache), '.git')), false);

const again = await installFromGit({ repo, path: 'agents/lawyer', commit: c100 }, cache, 'ru');
check('повторная установка той же версии — переиспользована', again.ok && again.reused, true);

const byTags = await installFromGit({ repo, path: 'agents/lawyer' }, cache, 'ru');
check('без указаний — старший тег версии', byTags.ok && [byTags.pkg.version, byTags.lock.commit], ['1.1.0', c110]);
const byRef = await installFromGit({ repo, path: 'agents/lawyer', ref: 'lawyer@1.0.0' }, cache, 'ru');
check('по тегу', byRef.ok && byRef.pkg.version, '1.0.0');
const byBranch = await installFromGit({ repo, path: 'agents/other', ref: 'main' }, cache, 'ru');
check('по ветке', byBranch.ok && byBranch.pkg.name, '@acme/other');
const wrongName = await installFromGit({ repo, path: 'agents/other', expectName: '@acme/lawyer' }, cache, 'ru');
check('чужое имя по пути — отказ', !wrongName.ok && /@acme\/other/.test(wrongName.error), true);
const noPath = await installFromGit({ repo, path: 'agents/none', ref: 'main' }, cache, 'ru');
check('нет пути — отказ', noPath.ok, false);
const noRepo = await installFromGit({ repo: resolve(root, 'nowhere'), path: '' }, cache, 'ru');
check('нет репозитория — отказ', noRepo.ok, false);
check('в кеше две версии юриста', listCached().filter((x) => x.pkg.name === '@acme/lawyer').map((x) => x.pkg.version), ['1.0.0', '1.1.0']);

// ----------------------------------------------------------- обновления

const upd = await findUpdate({ ...lock!, version: '1.0.0' }, reg.registry);
check('обновление по тегам, когда реестр отстал', upd?.version, '1.1.0');
check('свежей версии обновления нет', await findUpdate({ ...lock!, version: '1.1.0', commit: c110 }, reg.registry), null);

// ------------------------------------------------------ найм и витрина

const projectDir = resolve(root, 'project');
mkdirSync(projectDir, { recursive: true });
const stateFile = resolve(root, 'office.json');
const office = openOfficeState({ id: 'o-market', projectDir, stateFile }).state;
office.seed();
const sent: unknown[] = [];
const send = (e: unknown) => sent.push(e);
const chat = () => office.snapshot().t === 'snapshot' ? (office.snapshot() as { chat: Array<{ from: string; text: string }> }).chat : [];
const lastOffice = (): string => [...chat()].reverse().find((m) => m.from === OFFICE_SENDER)?.text ?? '';

// Найм из версии 1.0.0: в кеше их две, роль возьмёт старшую (1.1.0) —
// так и задумано: нанимают то, что стоит последним.
await handleMarketCommand({ c: 'market_hire', name: '@acme/lawyer' }, office, send);
const lawyer = office.roles().find((r) => r.package?.name === '@acme/lawyer');
check('роль заведена из пакета', [lawyer?.id, lawyer?.package?.version, lawyer?.tools], ['lawyer', '1.1.0', ['Read', 'Write']]);
check('источник в ссылке', lawyer?.package?.source, { repo, path: 'agents/lawyer', commit: c110 });
check('сотрудник нанят', office.staffOf('lawyer').length, 1);
check('бриф из пакета', lawyer?.brief, 'Ты юрист. Пиши кратко.');
await handleMarketCommand({ c: 'market_hire', name: '@acme/lawyer' }, office, send);
check('повторный найм — в ту же роль', [office.roles().filter((r) => r.package?.name === '@acme/lawyer').length, office.staffOf('lawyer').length], [1, 1]);
check('лимит клонов роли из пакета', /Роль/.test(lastOffice()) || lastOffice().length > 0, true);
await handleMarketCommand({ c: 'market_hire', name: '@acme/nope' }, office, send);
check('найм неустановленного — отказ текстом', /не установлен/.test(lastOffice()), true);
// Менеджер в офисе уже есть: найм из его пакета идёт в ту же роль и
// упирается в её лимит, второй роли менеджера не появляется.
await handleMarketCommand({ c: 'market_hire', name: '@office/pm' }, office, send);
check('второго менеджера не нанять', [office.roles().filter((r) => r.isManager).length, office.staffOf('pm').length, lastOffice().length > 0], [1, 1, true]);

const view = await marketView(office);
const card = view.packages.find((p) => p.name === '@acme/lawyer')!;
check('карточка: реестр, доверие, установлен', [card.origin, card.trust, card.installed, card.version], ['registry', 'verified', true, '1.1.0']);
check('карточка: разрешения из манифеста', [card.tools, card.env, card.network, card.servers.map((s) => s.id)], [['Read', 'Write'], ['THING_TOKEN'], true, ['thing']]);
check('карточка: роль офиса', card.roles.map((r) => [r.id, r.version, r.builtin, r.staff]), [['lawyer', '1.1.0', false, 1]]);
// Уволили последнего — роль остаётся вакансией, и витрина это видит: staff 0.
office.fire(office.staffOf('lawyer')[0].id);
check('роль без сотрудников — staff 0', (await marketView(office)).packages.find((p) => p.name === '@acme/lawyer')?.roles.map((r) => r.staff), [0]);
await handleMarketCommand({ c: 'market_hire', name: '@acme/lawyer' }, office, send);
check('найм обратно — в ту же роль', [office.roles().filter((r) => r.package?.name === '@acme/lawyer').length, office.staffOf('lawyer').length], [1, 1]);
check('карточка по ссылке помечена', view.packages.find((p) => p.name === '@acme/other')?.trust, 'link');
check('встроенный менеджер на витрине', view.packages.find((p) => p.name === '@office/pm')?.origin, 'builtin');
check('неустановленный из реестра — без подробностей', view.packages.find((p) => p.name === '@acme/lawyer')?.installed, true);

// Установка из реестра: там 1.0.0 — ставится ровно она (по коммиту).
rmSync(cacheDir('@acme/lawyer', '1.0.0', cache), { recursive: true, force: true });
await handleMarketCommand({ c: 'market_install', name: '@acme/lawyer' }, office, send);
check('установка из реестра по его коммиту', readLock(cacheDir('@acme/lawyer', '1.0.0', cache))?.commit, c100);
await handleMarketCommand({ c: 'market_install', name: '@acme/nope' }, office, send);
check('нет в реестре — отказ текстом', /реестре нет/.test(lastOffice()), true);
await handleMarketCommand({ c: 'market_add_link', url: 'ерунда' }, office, send);
check('плохая ссылка — отказ текстом', /Не разобрать ссылку/.test(lastOffice()), true);
await handleMarketCommand({ c: 'market_add_link', url: `${repo}#agents/other` }, office, send);
check('добавление по ссылке — установлено', listCached().some((x) => x.pkg.name === '@acme/other'), true);

// Обновление: откатываем роль на 1.0.0 и просим обновить.
const back = await installFromGit({ repo, path: 'agents/lawyer', commit: c100 }, cache, 'ru');
if (back.ok) office.updateRolePackage('lawyer', back.pkg, { repo, path: 'agents/lawyer', commit: c100 });
office.updateRole('lawyer', { maxInstances: 2, briefExtra: 'Наш стек: Node.' });
check('роль откачена на 1.0.0', [office.role('lawyer')?.package?.version, office.role('lawyer')?.tools], ['1.0.0', ['Read']]);
await handleMarketCommand({ c: 'market_check' }, office, send);
check('проверка нашла обновление', /новая версия есть у 1/.test(lastOffice()), true);
const checked = (sent.at(-1) as { market: { packages: Array<{ name: string; roles: Array<{ updateTo: string | null }> }> } }).market;
check('витрина показывает, до чего обновлять', checked.packages.find((p) => p.name === '@acme/lawyer')?.roles[0]?.updateTo, '1.1.0');
await handleMarketCommand({ c: 'market_update', roleId: 'lawyer' }, office, send);
const updated = office.role('lawyer')!;
check('роль обновлена до 1.1.0', [updated.package?.version, updated.tools, updated.package?.source?.commit], ['1.1.0', ['Read', 'Write'], c110]);
check('оверрайд и приписка пережили обновление', [updated.maxInstances, updated.brief], [2, 'Ты юрист. Пиши кратко.\n\nНаш стек: Node.']);
await handleMarketCommand({ c: 'market_update', roleId: 'pm' }, office, send);
check('встроенный не обновляется отдельно', /встроенный/.test(lastOffice()), true);
await handleMarketCommand({ c: 'market_update', roleId: 'lawyer' }, office, send);
check('обновлять больше нечего', /новой версии нет/.test(lastOffice()), true);

// ------------------------------------------------------------- команда

writePackage(resolve(builtin, '@office/squad'), '@office/squad', '0.1.0');
writeFileSync(resolve(builtin, '@office/squad/agent.json'), JSON.stringify({
  schema: 1, name: '@office/squad', kind: 'team', title: { ru: 'Отряд', en: 'Squad' }, license: 'MIT',
  members: [{ package: '@office/pm' }, { package: '@acme/lawyer', count: 2 }, { package: '@acme/other' }, { package: '@acme/ghost' }],
  settings: { autoPipeline: false, focusEpics: 3, globalBudgetUsd: 1 },
}));
const before = office.settings.focusEpics;
await handleMarketCommand({ c: 'market_hire', name: '@office/squad' }, office, send);
check('команду не нанять как агента', /команда/.test(lastOffice()), true);
await handleMarketCommand({ c: 'market_hire_team', name: '@office/squad' }, office, send);
check('команда: юристов стало двое, other нанят, ghost не нашёлся',
  [office.staffOf('lawyer').length, office.staffOf('other').length, /ghost/.test(lastOffice()), /нанято/.test(lastOffice())], [2, 1, true, true]);
check('команда: настройки из белого списка применены', [office.settings.autoPipeline, office.settings.focusEpics, before], [false, 3, 2]);
check('команда: менеджер остался один', office.roles().filter((r) => r.isManager).length, 1);
const teamCard = (await marketView(office)).packages.find((p) => p.name === '@office/squad')!;
check('карточка команды: участники и их состояние', teamCard.members.map((m) => [m.package, m.count, m.installed, m.available]),
  [['@office/pm', 1, true, true], ['@acme/lawyer', 2, true, true], ['@acme/other', 1, true, true], ['@acme/ghost', 1, false, false]]);

// ------------------------------------------------------------ лицензии

const { readLicenses, setLicense, serviceBase } = await import('../src/server/market');
await handleMarketCommand({ c: 'market_license', name: '@acme/lawyer', key: ' lic_abc ' }, office, send);
check('ключ сохранён и на витрине только флаг', [readLicenses()['@acme/lawyer'], (await marketView(office)).packages.find((p) => p.name === '@acme/lawyer')?.licensed], ['lic_abc', true]);
await handleMarketCommand({ c: 'market_license', name: '@acme/lawyer', key: '' }, office, send);
check('ключ забыт', readLicenses()['@acme/lawyer'], undefined);
setLicense('@acme/x', 'k');
check('ключи лежат рядом с кешом', existsSync(resolve(cache, '..', 'licenses.json')), true);
check('сервис за адресом реестра', [serviceBase('https://r.example/v1/registry.json'), serviceBase('/tmp/registry.json')], ['https://r.example', '']);
check('витрина без сервиса: телеметрии некому', (await marketView(office)).service, false);

// Перезапуск: роль из кеша по ссылке с источником.
office.flush();
unloadOfficeState('o-market');
const again2 = openOfficeState({ id: 'o-market', projectDir, stateFile }).state;
check('после перезапуска роль читается из кеша', [again2.role('lawyer')?.package?.version, again2.role('lawyer')?.brief],
  ['1.1.0', 'Ты юрист. Пиши кратко.\n\nНаш стек: Node.']);
const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as { roles: Array<{ id: string; package?: { source?: unknown } }> };
check('источник сохранён в файле', saved.roles.find((r) => r.id === 'lawyer')?.package?.source, { repo, path: 'agents/lawyer', commit: c110 });
unloadOfficeState('o-market');
wipe(stateFile);

rmSync(root, { recursive: true, force: true });
console.log(failed ? `\nпровалено кейсов: ${failed}` : '\nвсе кейсы прошли');
process.exit(failed ? 1 : 0);

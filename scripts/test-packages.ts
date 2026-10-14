// Проверка пакетов агентов: разбор манифеста, валидатор, роль из пакета и
// привязка сохранённых ролей к пакетам. npm run test:packages
//
// Токенов не нужно: всё это чистая логика над файлами на диске. Пакеты для
// проверки собираются во времянке, а наши, из packages/, гоняются через
// валидатор как есть — битый базовый пакет должен ронять именно этот прогон,
// а не первый запуск офиса у пользователя.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = mkdtempSync(resolve(tmpdir(), 'office-packages-'));
process.env.OFFICE_PACKAGES_DIR = root;
process.env.OFFICE_LANG = 'ru';

// Импорт после подмены пути: каталог пакетов читается на загрузке модуля.
const {
  defaultTeam, listPackages, loadPackage, parseManifest, readPackage, validatePackage,
} = await import('../src/server/packages');
const {
  defaultRoles, defaultRole, roleFromPackage, withManagerRole, newRoleId,
} = await import('../src/server/roles');
const { employeeSkills, employeeServers, sessionTools } = await import('../src/server/skills');
const { mcpNamesFor } = await import('../src/server/mcp');

let failed = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(52)} → ${JSON.stringify(got)}`
    + (ok ? '' : ` (ждали ${JSON.stringify(want)})`));
};

/** Пакет во времянке: манифест, plugin.json, брифы и, если надо, скил. */
function makePackage(name: string, manifest: Record<string, unknown>, opts: {
  briefs?: Record<string, string>; skill?: string; plugin?: Record<string, unknown> | null; extra?: string[];
} = {}): string {
  const dir = resolve(root, ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  if (opts.plugin !== null) {
    mkdirSync(resolve(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(resolve(dir, '.claude-plugin/plugin.json'),
      JSON.stringify(opts.plugin ?? { name: name.split('/').pop(), version: '1.2.0', description: 'test' }));
  }
  writeFileSync(resolve(dir, 'agent.json'), JSON.stringify({ schema: 1, name, title: { en: 'Test' }, ...manifest }));
  for (const [lang, text] of Object.entries(opts.briefs ?? {})) {
    mkdirSync(resolve(dir, 'brief'), { recursive: true });
    writeFileSync(resolve(dir, `brief/${lang}.md`), `${text}\n`);
  }
  if (opts.skill) {
    mkdirSync(resolve(dir, 'skills', opts.skill), { recursive: true });
    writeFileSync(resolve(dir, 'skills', opts.skill, 'SKILL.md'),
      `---\nname: ${opts.skill}\ndescription: Проверочный навык.\n---\n\nСкажи слово «пакет».\n`);
  }
  for (const part of opts.extra ?? []) mkdirSync(resolve(dir, part), { recursive: true });
  return dir;
}

// ------------------------------------------------------------ манифест

const good = parseManifest({
  schema: 1, name: '@acme/writer', title: { ru: 'Писатель', en: 'Writer' }, color: '#123456',
  docsDir: '/docs/text/', license: 'MIT',
  runtime: { model: 'haiku', tools: ['Read', 'Write'], permissionMode: 'readonly', isolate: false, maxTurns: 40, mcp: ['figma-bridge'] },
  builtin: ['design'], servers: [{ id: 'thing', transport: 'stdio', command: 'npx', args: ['thing-mcp'] }],
}, 'x');
check('годный манифест без ошибок', good.problems.filter((p) => p.level === 'error'), []);
check('умолчания: kind, engine', [good.manifest.kind, good.manifest.runtime.engine], ['agent', 'claude-code']);
check('docsDir без краевых слэшей', good.manifest.docsDir, 'docs/text');
check('сервер из манифеста прошёл проверку', good.manifest.servers.map((s) => s.id), ['thing']);

const bad = parseManifest({
  schema: 2, name: 'writer', title: {}, color: 'red', maxInstances: 3,
  runtime: { engine: 'gpt', model: '', permissionMode: 'yolo', maxTurns: 0, tools: 'Read' },
  servers: [{ id: 'leaky', transport: 'stdio', command: 'npx', env: { TOKEN: 'secret-123' } }],
  hooks: true,
}, 'x');
const badPaths = bad.problems.filter((p) => p.level === 'error').map((p) => p.path).sort();
check('ошибки по каждому негодному полю', badPaths, [
  'color', 'name', 'runtime.engine', 'runtime.maxTurns', 'runtime.permissionMode',
  'runtime.tools', 'schema', 'servers.leaky', 'title',
].sort());
// Клонов больше нет: старое поле в опубликованном манифесте не ошибка, но и
// не работает — офис говорит об этом автору пакета.
check('лимит клонов из старого манифеста — предупреждение',
  bad.problems.some((p) => p.level === 'warn' && p.path === 'maxInstances'), true);
check('сервер с токеном отброшен', bad.manifest.servers, []);
check('неизвестное поле — предупреждение', bad.problems.some((p) => p.level === 'warn' && p.path === 'hooks'), true);
check('пустая модель — ошибка, умолчания нет',
  bad.problems.some((p) => p.path === 'runtime.model'), false);

// ---------------------------------------------------------------- команда

const team = parseManifest({
  schema: 1, name: '@acme/squad', kind: 'team', title: { en: 'Squad' }, license: 'MIT',
  members: [{ package: '@office/pm' }, { package: '@office/backend', count: 2 }, { package: '@office/backend' }, { package: 'nope' }, { package: '@acme/x', count: 99 }],
  settings: { autoPipeline: true, globalBudgetUsd: 5, officePermissionMode: 'readonly' },
  runtime: { model: 'opus' },
}, 'x');
check('команда: участники разобраны, дубли и мусор — ошибки',
  [team.manifest.kind, team.manifest.members.map((m) => [m.package, m.count]), team.problems.filter((p) => p.level === 'error').map((p) => p.path)],
  ['team', [['@office/pm', 1], ['@office/backend', 2]], ['members[2]', 'members[3]', 'members[4].count']]);
check('команда: настройки только из белого списка', [team.manifest.settings, team.problems.some((p) => p.path === 'settings.globalBudgetUsd')],
  [{ autoPipeline: true, officePermissionMode: 'readonly' }, true]);
check('команда: своей роли нет — runtime предупреждение', team.problems.some((p) => p.level === 'warn' && p.path === 'runtime'), true);
check('команда без участников — ошибка', parseManifest({ schema: 1, name: '@acme/e', kind: 'team', title: { en: 'E' } }, 'x').problems.some((p) => p.path === 'members' && p.level === 'error'), true);
check('агент с members — предупреждение', parseManifest({ schema: 1, name: '@acme/a', title: { en: 'A' }, members: [] }, 'x').problems.some((p) => p.path === 'members' && p.level === 'warn'), true);

// --------------------------------------------------------------- чтение

makePackage('@office/pm', { manager: true, title: { ru: 'Менеджер', en: 'Manager' }, runtime: { model: 'opus', isolate: false } });
makePackage('@office/backend', {
  title: { ru: 'Бэкенд', en: 'Backend' }, color: '#3b82f6', emoji: '⚙️',
  runtime: { model: 'opus', permissionMode: 'ask-risky', mcp: ['figma-bridge'] }, license: 'MIT',
}, { briefs: { ru: 'Ты бэкенд.\nПиши код.', en: 'You are backend.\nWrite code.' } });
makePackage('@office/design', {
  title: { en: 'Designer' }, runtime: { tools: ['Read', 'Edit'] }, builtin: ['design'],
  servers: [{ id: 'thing', title: 'Штука', transport: 'stdio', command: 'npx', args: ['thing-mcp'] }],
}, { briefs: { en: 'You design.' }, skill: 'figma-screen', extra: ['hooks', 'commands'] });
makePackage('@acme/lawyer', { title: { en: 'Lawyer' } }, { briefs: { en: 'Law.' } });
makePackage('@office/squad', { kind: 'team', title: { en: 'Squad' }, members: [{ package: '@office/backend', count: 2 }] });
makePackage('@acme/noplugin', { title: { en: 'X' } }, { plugin: null });
makePackage('@acme/badversion', { title: { en: 'X' } }, { plugin: { name: 'x', version: 'latest' } });
makePackage('@acme/renamed', { name: '@acme/other', title: { en: 'X' } });
writeFileSync(resolve(root, 'default-office.json'), JSON.stringify({ roles: ['@office/pm', '@office/backend', '@office/design'] }));

check('пакет читается', loadPackage('@office/backend')?.version, '1.2.0');
check('бриф по языкам', Object.keys(loadPackage('@office/backend')!.briefs), ['en', 'ru']);
check('без plugin.json пакета нет', loadPackage('@acme/noplugin'), null);
check('версия не semver — пакета нет', loadPackage('@acme/badversion'), null);
check('имя в манифесте обязано совпасть с папкой', loadPackage('@acme/renamed'), null);
check('имя без области не грузится', loadPackage('backend'), null);
check('список пакетов по имени', listPackages().map((p) => p.name),
  ['@acme/lawyer', '@office/backend', '@office/design', '@office/pm', '@office/squad']);
check('команда читается без брифа и без предупреждения о нём', readPackage(resolve(root, '@office/squad')).problems.some((p) => p.path === 'brief/'), false);
check('команда — не роль', defaultRole('squad', 'ru'), undefined);
check('каталог по умолчанию из файла', defaultTeam(), ['@office/pm', '@office/backend', '@office/design']);

const designProblems = validatePackage(resolve(root, '@office/design'));
check('валидатор предупреждает про части плагина, которые офис не берёт',
  designProblems.filter((p) => p.level === 'warn').map((p) => p.path).sort(), ['commands', 'hooks', 'license']);
check('валидатор: пакет без agent.json', readPackage(resolve(root, 'нет')).problems[0]?.message, 'no such directory');

// ---------------------------------------------------------- роль из пакета

const backend = defaultRole('backend', 'ru')!;
// Алиас уровня у Claude (`opus`) — не своя модель роли, а уровень: роль идёт
// за провайдером офиса и берёт у него модель этого уровня (см. packageRuntime).
check('алиас уровня стал уровнем, а не своей моделью',
  [backend.tier, backend.provider ?? null, backend.model ?? null], ['top', null, null]);
check('название на языке офиса', backend.title, 'Бэкенд');
check('бриф на языке офиса', backend.brief, 'Ты бэкенд.\nПиши код.');
check('нет языка — английский', defaultRole('backend', 'en')!.title, 'Backend');
check('подписка на серверы из манифеста', mcpNamesFor(backend), ['figma-bridge']);
check('ссылка на пакет в роли', [backend.package?.name, backend.package?.version], ['@office/backend', '1.2.0']);
check('менеджер из пакета', defaultRole('pm', 'ru')?.isManager, true);
check('без файла брифа — пустой бриф', defaultRole('pm', 'ru')?.brief, '');
check('роли по умолчанию в порядке каталога', defaultRoles('ru').map((r) => r.id), ['pm', 'backend', 'design']);
check('чужой пакет в набор по умолчанию не входит', defaultRoles('ru').some((r) => r.id === 'lawyer'), false);
check('id базовых ролей заняты', newRoleId('Backend', []), 'backend-2');
check('менеджер гарантирован и первый', withManagerRole([backend], 'ru').map((r) => r.id), ['pm', 'backend']);

// Оверрайды и приписка.
const pkg = loadPackage('@office/backend')!;
const tuned = roleFromPackage(pkg, 'ru', 'backend', {
  name: pkg.name, version: '0.0.1',
  overrides: { model: 'claude-haiku-5-5', title: 'Бэкенд', repoDir: '' },
  briefExtra: 'Проект на Fastify.',
});
check('оверрайд применяется', tuned.model, 'claude-haiku-5-5');
check('оверрайд, равный умолчанию, вычищен', Object.keys(tuned.package!.overrides), ['model']);
check('версия в ссылке — с диска', tuned.package!.version, '1.2.0');
check('приписка снизу к брифу', tuned.brief, 'Ты бэкенд.\nПиши код.\n\nПроект на Fastify.');
check('приписка без брифа — сама по себе',
  roleFromPackage(loadPackage('@office/pm')!, 'ru', 'pm', { name: '@office/pm', version: '', overrides: {}, briefExtra: 'Кратко.' }).brief,
  'Кратко.');
check('менеджера не переименовать оверрайдом',
  roleFromPackage(loadPackage('@office/pm')!, 'ru', 'pm', { name: '@office/pm', version: '', overrides: { title: 'Босс' }, briefExtra: '' }).title,
  'Менеджер');

// Что из пакета уезжает в сессию.
const design = defaultRole('design', 'ru')!;
check('скилы пакета — свои и встроенные', employeeSkills(design), ['design:figma-screen', 'design']);
check('Skill дописан урезанному набору', sessionTools(design), ['Read', 'Edit', 'Skill']);
check('просьба пакета о сервере', employeeServers(design).map((s) => s.id), ['thing']);
check('роль без скилов — без пакета для сессии', employeeSkills(backend), undefined);

// ----------------------------------------------- привязка из сохранения

// Сохранение старше пакетов: роль лежит целиком. Совпала с пакетом —
// привязалась без оверрайдов; отличается — разница стала оверрайдом; бриф
// переписан — форк, роль осталась без пакета.
const { getOffice, openOfficeState, unloadOfficeState } = await import('../src/server/state');
const { save, flushAll, wipe, load } = await import('../src/server/store');
const { DEFAULT_SETTINGS } = await import('../src/server/state');

const stateFile = resolve(root, 'office.json');
const projectDir = resolve(root, 'project');
mkdirSync(projectDir, { recursive: true });
const savedBackend = { ...defaultRole('backend', 'ru')!, model: 'claude-haiku-5-5', brief: 'Ты бэкенд.\nПиши код.\nПроект на Fastify.' };
delete (savedBackend as { package?: unknown }).package;
const savedDesign = { ...defaultRole('design', 'ru')!, title: 'Designer', brief: 'Совсем другой бриф.' };
delete (savedDesign as { package?: unknown }).package;
const savedPm = { ...defaultRole('pm', 'ru')! };
delete (savedPm as { package?: unknown }).package;
save(stateFile, () => ({
  version: 1, projectDir, taskSeq: 0, tasks: [], chat: [], log: [], instances: [],
  // Офис здесь русский: роли в сохранении русские. Поднимаются они на языке
  // ОБЩЕНИЯ, поэтому задаём его, а не только старое зеркало `language`.
  settings: { ...DEFAULT_SETTINGS, language: 'ru', chatLanguage: 'ru', codeLanguage: 'ru' },
  savedAt: Date.now(),
  roles: [savedPm, savedBackend, savedDesign, {
    ...defaultRole('backend', 'ru')!, id: 'gone', title: 'Пропавший',
    package: { name: '@acme/gone', version: '0.1.0', overrides: {}, briefExtra: '' },
  }],
}));
flushAll();
const office = openOfficeState({ id: 'o-pkg', projectDir, stateFile }).state;
const b = office.role('backend')!;
check('старое сохранение привязалось к пакету', b.package?.name, '@office/backend');
check('разница с пакетом стала оверрайдом', b.package?.overrides, { model: 'claude-haiku-5-5' });
check('хвост брифа стал припиской', b.package?.briefExtra, 'Проект на Fastify.');
check('бриф собран заново из пакета и приписки', b.brief, 'Ты бэкенд.\nПиши код.\n\nПроект на Fastify.');
check('переписанный бриф — форк без пакета', office.role('design')?.package, undefined);
check('форк держит свой бриф', office.role('design')?.brief, 'Совсем другой бриф.');
check('форк нашего пакета берёт его инструменты', office.role('design')?.tools, ['Read', 'Edit']);
check('менеджер привязан', office.role('pm')?.package?.name, '@office/pm');
check('пропавший пакет: роль из сохранения, ссылка на месте',
  [office.role('gone')?.title, office.role('gone')?.package?.name], ['Пропавший', '@acme/gone']);

// Правка привязанной роли ложится в разницу, бриф пакета не трогается.
// Умолчание пакета по модели — уровень, а не id, поэтому к нему возвращает
// сброс своей модели (`ownModel: false`), а не явная модель.
office.updateRole('backend', { ownModel: false, briefExtra: 'Только Fastify.', brief: 'взлом' });
const b2 = office.role('backend')!;
check('поле, вернувшееся к умолчанию, ушло из разницы', b2.package?.overrides, {});
check('приписка обновилась', b2.brief, 'Ты бэкенд.\nПиши код.\n\nТолько Fastify.');
office.updateRole('backend', { maxTurns: 40 });
check('новая правка легла в разницу', office.role('backend')?.package?.overrides, { maxTurns: 40 });
const view = office.roleViews().find((r) => r.id === 'backend')!;
check('форма видит пакет и приписку', [view.package?.name, view.package?.brief, view.briefExtra],
  ['@office/backend', 'Ты бэкенд.\nПиши код.', 'Только Fastify.']);
check('форма роли без пакета: пакета нет', office.roleViews().find((r) => r.id === 'design')?.package, null);

// Смена языка пересчитывает роль из пакета, оверрайды остаются.
office.updateSettings({ language: 'en' });
check('после смены языка бриф пакета на английском', office.role('backend')?.brief, 'You are backend.\nWrite code.\n\nТолько Fastify.');
check('оверрайд пережил смену языка', office.role('backend')?.maxTurns, 40);
check('название пакета переведено', office.role('backend')?.title, 'Backend');
office.updateSettings({ language: 'ru' });

// Сохранение и повторный подъём: ссылка в файле, роль считается заново.
save(stateFile, () => office.toPersisted());
flushAll();
const persisted = load(stateFile)!;
check('ссылка сохранена', persisted.roles?.find((r) => r.id === 'backend')?.package?.overrides, { maxTurns: 40 });
unloadOfficeState('o-pkg');
const again = openOfficeState({ id: 'o-pkg', projectDir, stateFile }).state;
check('после перезапуска роль та же', [again.role('backend')?.maxTurns, again.role('backend')?.package?.briefExtra],
  [40, 'Только Fastify.']);

// Отвязка — форк: бриф остаётся, пакет уходит.
check('отвязка чужой роли — отказ', again.detachRole('design').length, 1);
check('отвязка', again.detachRole('backend'), []);
check('после отвязки пакета нет, бриф на месте',
  [again.role('backend')?.package, again.role('backend')?.brief], [undefined, 'Ты бэкенд.\nПиши код.\n\nТолько Fastify.']);
again.updateRole('backend', { brief: 'Свой бриф.' });
check('отвязанная роль правит бриф напрямую', again.role('backend')?.brief, 'Свой бриф.');
unloadOfficeState('o-pkg');
wipe(stateFile);
void getOffice;

// ------------------------------------------------ наши пакеты в packages/

const ours = resolve(process.cwd(), 'packages');
process.env.OFFICE_PACKAGES_DIR = ours;
const ourTeam = defaultTeam(ours);
check('наш каталог по умолчанию непуст', ourTeam.length > 0, true);
for (const name of ourTeam) {
  const problems = validatePackage(resolve(ours, ...name.split('/')));
  check(`${name} проходит валидатор`, problems.filter((p) => p.level === 'error'), []);
}
check('менеджер в нашем каталоге первый', ourTeam[0], '@office/pm');

// ------------------------------------------------ локальные порты (T-439)

{
  const { sandboxFor, SANDBOX, unityUnsandboxed } = await import('../src/server/sandbox');
  const qa = roleFromPackage(loadPackage('@office/qa', ours)!, 'ru', 'qa');
  const backend = roleFromPackage(loadPackage('@office/backend', ours)!, 'ru', 'backend');
  check('qa: локальные порты включены по умолчанию', qa.allowLocalBinding, true);
  check('backend: локальные порты выключены', backend.allowLocalBinding, false);
  check('порты по умолчанию включены только у qa',
    listPackages(ours).filter((p) => p.manifest.runtime?.allowLocalBinding === true).map((p) => p.name), ['@office/qa']);
  check('манифест: не булево — ошибка',
    parseManifest({ schema: 1, name: '@acme/a', title: { en: 'A' }, runtime: { model: 'sonnet', allowLocalBinding: 'yes' } }, 'x')
      .problems.some((p) => p.path === 'runtime.allowLocalBinding' && p.level === 'error'), true);

  const cwd = mkdtempSync(resolve(tmpdir(), 'office-sandbox-'));
  mkdirSync(resolve(cwd, 'node_modules'));
  const box = sandboxFor(qa, cwd) as Record<string, any>;
  check('qa: allowLocalBinding доезжает до песочницы', box.network?.allowLocalBinding, true);
  check('qa: unix-сокеты только во временной папке песочницы',
    box.network?.allowUnixSockets?.length === 1 && /\/claude-\d+$/.test(box.network.allowUnixSockets[0]), true);
  check('qa: запись только в кеш vite',
    (box.filesystem?.allowWrite as string[]).map((p) => p.split('/').slice(-2).join('/')),
    ['node_modules/.vite', 'node_modules/.vite-temp']);
  check('qa: остальная песочница прежняя',
    [box.enabled, box.failIfUnavailable, box.allowUnsandboxedCommands, box.autoAllowBashIfSandboxed], [true, true, false, false]);
  check('backend: песочница без сети и записи', sandboxFor(backend, cwd), SANDBOX);

  // Правка из окна роли — оверрайд ссылки на пакет.
  const off = roleFromPackage(loadPackage('@office/qa', ours)!, 'ru', 'qa',
    { ...qa.package!, overrides: { allowLocalBinding: false } });
  check('qa: выключили в окне роли — песочница без портов', (sandboxFor(off, cwd) as Record<string, any>).network, undefined);
  const on = roleFromPackage(loadPackage('@office/backend', ours)!, 'ru', 'backend',
    { ...backend.package!, overrides: { allowLocalBinding: true } });
  check('backend: включили в окне роли — оверрайд держится', [on.allowLocalBinding, on.package?.overrides.allowLocalBinding], [true, true]);
  check('3D-роль с портами: оба исключения разом',
    Object.keys(sandboxFor({ ...on, capabilities: ['design.3d'] }, cwd)).filter((k) => k === 'excludedCommands' || k === 'network'),
    ['excludedCommands', 'network']);

  // Unity вне песочницы — только роли со способностью game.unity (T-571).
  const unity = roleFromPackage(loadPackage('@office/unity', ours)!, 'ru', 'unity');
  check('unity: пакет объявляет game.unity', unity.capabilities?.includes('game.unity'), true);
  const unityBox = sandboxFor(unity, cwd) as Record<string, any>;
  const excluded = (unityBox.excludedCommands ?? []) as string[];
  check('unity: CLI и редактор вне песочницы', [
    excluded.includes('unity test:*'),
    excluded.includes('unity recompile:*'),
    excluded.some((c) => c.endsWith('/.unity/bin/unity test:*')),
    excluded.includes('/Applications/Unity/Hub/Editor/*/Unity.app/Contents/MacOS/Unity *'),
  ], [true, true, true, true]);
  check('unity: Blender не достаётся', excluded.some((c) => c.includes('blender')), false);
  check('unity: сеть и запись не расширены', [unityBox.network, unityBox.filesystem], [undefined, undefined]);
  check('unity: UNITY_PATH попадает в исключения',
    unityUnsandboxed({ UNITY_PATH: '/opt/Unity/Unity' }).includes('/opt/Unity/Unity:*'), true);
  check('backend без game.unity: Unity в песочнице', sandboxFor({ ...backend, capabilities: ['code.write'] }, cwd), SANDBOX);
  check('3D-роль: Unity не достаётся',
    ((sandboxFor({ ...backend, capabilities: ['design.3d'] }, cwd) as Record<string, any>).excludedCommands as string[])
      .some((c) => /unity/i.test(c)), false);
  rmSync(cwd, { recursive: true, force: true });
}

rmSync(root, { recursive: true, force: true });
console.log(failed ? `\nпровалено кейсов: ${failed}` : '\nвсе кейсы прошли');
process.exit(failed ? 1 : 0);

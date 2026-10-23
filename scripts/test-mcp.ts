// Проверка каталога внешних MCP-серверов: кому что подключается, что сказано
// об этом в промпте и что каталог не пропускает мусор из формы. npm run test:mcp
//
// Подписку и промпт стоит проверять именно парой: сервер без строки в промпте
// роль не заметит, а строка не от той роли хуже отсутствия строки — фронтенд,
// которому сказано «делай макет в Figma», займётся не своим делом.
import {
  checkMcpServers, DEFAULT_MCP_SERVERS, externalMcp, MCP_NOT_IN_SESSION, mcpBrief, mcpCatalog, mcpCatalogView, pollMcpStatus, serversFor,
  chooseUnityProject, rememberUnityProject, toolCommand, unityProjectArgs, unityProjectForRole, unityProjectForSession,
} from '../src/server/mcp';
import { sanitizeProjectPath } from '../src/server/state';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRole, defaultRoles } from '../src/server/roles';
import type { Role } from '../src/server/roles';
import type { McpServerDef, Settings } from '../src/shared/types';

/** Каталог по умолчанию: остальные настройки внешним серверам не нужны. */
const catalog = (servers: McpServerDef[] = DEFAULT_MCP_SERVERS): Settings =>
  ({ mcpServers: servers } as Settings);

const role = (id: string): Role => defaultRole(id, 'ru')!;

let failed = 0;
const check = (what: string, ok: boolean, got: string): void => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(48)} → ${got}`);
};

const servers = (r: Role, s: Settings = catalog()): string[] => Object.keys(externalMcp(s, r));
const list = (r: Role, s?: Settings): string => servers(r, s).join(', ') || '(нет)';

// ------------------------------------------------------------- подписки

check('дизайнеру figma-bridge', servers(role('design')).includes('figma-bridge'), list(role('design')));
check('дизайнеру penpot', servers(role('design')).includes('penpot'), list(role('design')));
check('фронтенду penpot не нужен', !servers(role('frontend')).includes('penpot'), list(role('frontend')));
// Локальный @penpot/mcp — HTTP-сервер на своих портах: stdio на каждую сессию
// упёрся бы во второй сессии в занятый порт.
const penpot = externalMcp(catalog(), role('design')).penpot;
check('penpot ходит по http на localhost:4401',
  penpot?.type === 'http' && 'url' in penpot && penpot.url === 'http://localhost:4401/mcp',
  JSON.stringify(penpot));
check('у penpot есть строка в промпте дизайнера', mcpBrief(catalog(), role('design'), 'ru').includes('mcp__penpot__'),
  mcpBrief(catalog(), role('design'), 'ru').includes('mcp__penpot__') ? 'есть' : 'нет');
// Офис старше T-378 (T-389): в сохранённом каталоге penpot нет, а роль на
// него подписана — каталог доливает умолчание, и сервер доезжает до сессии.
const oldCatalog = catalog(DEFAULT_MCP_SERVERS.filter((d) => d.id === 'figma-bridge' || d.id === 'blender'));
const hiredDesign = { ...role('design'), mcp: ['figma-bridge', 'figma-console', 'penpot'] };
check('старый каталог: дизайнер получает penpot и figma-console',
  ['penpot', 'figma-console'].every((id) => servers(hiredDesign, oldCatalog).includes(id)),
  list(hiredDesign, oldCatalog));
// figcraft (T-569) — пилот: в каталоге есть, но по умолчанию никому не
// подключён; дизайнер получает его галочкой, и тогда это stdio-процесс CLI.
const figcraftDef = DEFAULT_MCP_SERVERS.find((s) => s.id === 'figcraft');
check('figcraft в каталоге: stdio, figcraft-cli mcp --no-system-fonts',
  figcraftDef?.transport === 'stdio' && figcraftDef.command === 'figcraft-cli'
    && figcraftDef.args.join(' ') === 'mcp --no-system-fonts' && figcraftDef.alwaysLoad,
  JSON.stringify(figcraftDef));
const figcraftSubscribers = [...defaultRoles('ru'), role('design')].filter((r) => servers(r).includes('figcraft'));
check('figcraft никому не подключён по умолчанию', figcraftSubscribers.length === 0,
  figcraftSubscribers.map((r) => r.id).join(', ') || '(нет)');
const pilotDesign = { ...role('design'), mcp: [...(role('design').mcp ?? []), 'figcraft'] };
const figcraft = externalMcp(catalog(), pilotDesign).figcraft;
check('дизайнер с галочкой получает figcraft',
  !!figcraft && 'command' in figcraft && figcraft.command === toolCommand('figcraft-cli'), JSON.stringify(figcraft));
// Где искать бинарник (T-595): переменная → ~/.office/tools/bin → PATH. Дом и
// окружение подставные, чтобы ответ не зависел от машины, где идёт проверка.
const fakeHome = mkdtempSync(join(tmpdir(), 'office-mcp-home-'));
check('figcraft-cli без установки — голое имя для PATH', toolCommand('figcraft-cli', {}, fakeHome) === 'figcraft-cli',
  toolCommand('figcraft-cli', {}, fakeHome));
mkdirSync(join(fakeHome, '.office', 'tools', 'bin'), { recursive: true });
writeFileSync(join(fakeHome, '.office', 'tools', 'bin', 'figcraft-cli'), '');
check('figcraft-cli из ~/.office/tools/bin', toolCommand('figcraft-cli', {}, fakeHome)
  === join(fakeHome, '.office', 'tools', 'bin', 'figcraft-cli'), toolCommand('figcraft-cli', {}, fakeHome));
check('FIGCRAFT_CLI важнее места по умолчанию',
  toolCommand('figcraft-cli', { FIGCRAFT_CLI: '/opt/fc/figcraft-cli' }, fakeHome) === '/opt/fc/figcraft-cli',
  toolCommand('figcraft-cli', { FIGCRAFT_CLI: '/opt/fc/figcraft-cli' }, fakeHome));
check('полный путь из каталога не подменяется',
  toolCommand('/x/figcraft-cli', { FIGCRAFT_CLI: '/opt/fc/figcraft-cli' }, fakeHome) === '/x/figcraft-cli',
  toolCommand('/x/figcraft-cli', { FIGCRAFT_CLI: '/opt/fc/figcraft-cli' }, fakeHome));
check('чужие команды не трогаются', toolCommand('npx', { FIGCRAFT_CLI: '/opt/fc/figcraft-cli' }, fakeHome) === 'npx',
  toolCommand('npx', {}, fakeHome));
// Что видит клиент (T-602): каталог офиса, сохранённый до figcraft, всё равно
// отдаётся с ним — иначе в «Инструментах» роли его нечем включить. Бинарника
// нет — запись остаётся, но с подсказкой; есть — без неё.
const savedBefore = catalog(DEFAULT_MCP_SERVERS.filter((d) => d.id !== 'figcraft'));
const emptyHome = mkdtempSync(join(tmpdir(), 'office-mcp-empty-'));
const viewNoBin = mcpCatalogView(savedBefore, { PATH: '' }, emptyHome).find((s) => s.id === 'figcraft');
check('клиенту: figcraft в старом каталоге есть', !!viewNoBin, JSON.stringify(viewNoBin?.id));
check('клиенту: без бинарника — подсказка figcraft-cli', viewNoBin?.missingBinary === 'figcraft-cli',
  String(viewNoBin?.missingBinary));
const viewWithBin = mcpCatalogView(savedBefore, { PATH: '' }, fakeHome).find((s) => s.id === 'figcraft');
check('клиенту: бинарник в ~/.office/tools/bin — без подсказки', !!viewWithBin && !viewWithBin.missingBinary,
  String(viewWithBin?.missingBinary));
const viewEnvMissing = mcpCatalogView(savedBefore, { PATH: '', FIGCRAFT_CLI: join(emptyHome, 'нет') }, fakeHome)
  .find((s) => s.id === 'figcraft');
check('клиенту: FIGCRAFT_CLI на пустое место — подсказка', viewEnvMissing?.missingBinary === 'figcraft-cli',
  String(viewEnvMissing?.missingBinary));
mkdirSync(join(emptyHome, 'bin'));
writeFileSync(join(emptyHome, 'bin', 'figcraft-cli'), '');
const viewInPath = mcpCatalogView(savedBefore, { PATH: join(emptyHome, 'bin') }, join(emptyHome, 'дом'))
  .find((s) => s.id === 'figcraft');
check('клиенту: бинарник в PATH — без подсказки', !!viewInPath && !viewInPath.missingBinary,
  String(viewInPath?.missingBinary));
check('клиенту: у остальных серверов подсказки нет',
  mcpCatalogView(savedBefore, { PATH: '' }, emptyHome).every((s) => s.id === 'figcraft' || !s.missingBinary), '');
// Форма настроек сохраняет каталог, пришедший с сервера, — служебное поле в
// настройки офиса уехать не должно.
const resaved = checkMcpServers(mcpCatalogView(savedBefore, { PATH: '' }, emptyHome)).servers;
check('missingBinary не сохраняется формой', resaved.every((s) => !('missingBinary' in s)), '');
rmSync(emptyHome, { recursive: true, force: true });
rmSync(fakeHome, { recursive: true, force: true });
// И сам снимок, который уходит клиенту: офис со старым каталогом.
{
  const { OfficeState } = await import('../src/server/state');
  const office = new OfficeState('o-test-mcp');
  office.settings = { ...office.settings, mcpServers: savedBefore.mcpServers };
  const sent = office.settingsView().mcpServers ?? [];
  check('settingsView: figcraft в каталоге клиента', sent.some((s) => s.id === 'figcraft'),
    sent.map((s) => s.id).join(', '));
  check('settingsView: сохранённое поле не тронуто',
    !(office.settings.mcpServers ?? []).some((s) => s.id === 'figcraft'), '');
}
check('фронтенду тот же figma-bridge', servers(role('frontend')).includes('figma-bridge'), list(role('frontend')));
check('3D-художнику blender', servers(role('artist3d')).includes('blender'), list(role('artist3d')));
check('бэкенду ничего', servers(role('backend')).length === 0, list(role('backend')));
check('иллюстратору imagegen', servers(role('illustrator')).includes('imagegen'), list(role('illustrator')));

// Свой сервер лежит в репозитории офиса, а поднимается из чужой директории:
// относительный путь до него молча не нашёлся бы.
const imagegen = DEFAULT_MCP_SERVERS.find((s) => s.id === 'imagegen')!;
check('путь к своему серверу абсолютный', imagegen.args[0]?.startsWith('/') === true, String(imagegen.args[0]));
check('ключи в каталоге только ссылками',
  Object.values(imagegen.env).every((v) => /^\$\{[A-Z_]+\}$/.test(v)),
  Object.entries(imagegen.env).map(([k, v]) => `${k}=${v}`).join(' '));

// Своё поле роли сильнее умолчания по id — иначе отключить сервер было бы нечем.
check('mcp: [] отключает всё', servers({ ...role('design'), mcp: [] }).length === 0,
  list({ ...role('design'), mcp: [] }));
check('неизвестное имя отбрасывается',
  servers({ ...role('design'), mcp: ['figma-bridge', 'нет-такого'] }).join() === 'figma-bridge',
  list({ ...role('design'), mcp: ['figma-bridge', 'нет-такого'] }));

// Каталог офисный, но умолчания доливаются по id: убрать сервер насовсем можно
// только выключив его.
const empty = catalog([]);
check('пустой каталог получает умолчания', servers(role('design'), empty).includes('figma-bridge'),
  list(role('design'), empty));
const off = catalog(DEFAULT_MCP_SERVERS.map((s) => ({ ...s, disabled: true })));
check('выключенный сервер не поднимается', servers(role('design'), off).length === 0,
  list(role('design'), off));

// Офис старше `browser` в умолчаниях: в каталоге только мосты до Figma и Blender.
const legacy = catalog(DEFAULT_MCP_SERVERS
  .filter((s) => s.id === 'figma-bridge' || s.id === 'blender')
  .map((s) => (s.id === 'blender' ? { ...s, title: 'Свой Blender', disabled: true } : s)));
const qa: Role = { ...role('backend'), id: 'qa', mcp: ['browser'] };
check('старый каталог + подписка на browser', serversFor(legacy, qa).map((s) => s.id).join() === 'browser',
  serversFor(legacy, qa).map((s) => s.id).join() || '(нет)');
const legacyBlender = mcpCatalog(legacy).find((s) => s.id === 'blender');
check('сохранённая запись не тронута', legacyBlender?.title === 'Свой Blender' && legacyBlender.disabled === true,
  `${legacyBlender?.title}, disabled=${legacyBlender?.disabled}`);
check('доливка идемпотентна',
  mcpCatalog({ mcpServers: mcpCatalog(legacy) } as Settings).length === DEFAULT_MCP_SERVERS.length,
  `${mcpCatalog({ mcpServers: mcpCatalog(legacy) } as Settings).length} из ${DEFAULT_MCP_SERVERS.length}`);

// Подписка на сервер, которого нет и после доливки, — предупреждение в лог.
const warned: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warned.push(a.join(' ')); };
serversFor(legacy, { ...qa, mcp: ['нет-такого'] });
console.warn = realWarn;
check('неизвестный сервер — предупреждение', warned.some((w) => w.includes('qa') && w.includes('нет-такого')),
  warned.join(' | ') || '(тишина)');

// ------------------------------------------------------- строки в промпте

const designBrief = mcpBrief(catalog(), role('design'), 'ru');
const frontBrief = mcpBrief(catalog(), role('frontend'), 'ru');
const blenderBrief = mcpBrief(catalog(), role('artist3d'), 'ru');
check('дизайнеру сказано делать макет', designBrief.includes('макет ДЕЛАЙ'), `${designBrief.length} символов`);
check('фронтенду сказано не менять макет',
  frontBrief.includes('Менять макет не твоя работа'), `${frontBrief.length} символов`);
check('строки дизайнера и фронтенда разные', designBrief !== frontBrief && frontBrief.length > 0,
  designBrief === frontBrief ? 'совпали' : 'разные');
check('3D-художнику сказано про скрипт', blenderBrief.includes('tools/blender/'), `${blenderBrief.length} символов`);
check('роли без серверов — пустая строка', mcpBrief(catalog(), role('backend'), 'ru') === '', '(пусто)');
const drawBrief = mcpBrief(catalog(), role('illustrator'), 'ru');
check('иллюстратору сказано рисовать, а не описывать',
  drawBrief.includes('картинку ДЕЛАЙ'), `${drawBrief.length} символов`);

// ------------------------------------------- рабочая копия для своих серверов

// Внешний сервер поднимает процесс офиса, и про ветку задачи он не знает:
// без переменной сервер, пишущий файлы, складывал бы их мимо рабочей копии.
const wd = (cwd?: string): string | undefined => {
  const built = externalMcp(catalog(), role('illustrator'), cwd).imagegen;
  return (built as { env?: Record<string, string> }).env?.OFFICE_WORKDIR;
};
check('рабочая копия доезжает до сервера', wd('/tmp/work') === '/tmp/work', String(wd('/tmp/work')));
check('без рабочей копии переменной нет', wd() === undefined, String(wd()));

// --------------------------------------------- путь проекта для моста Unity

// Роль работает в копии задачи, а редактор владелец открывает на основной
// папке репозитория зоны (T-575). Мост с --project-path <копия> открытый
// редактор не найдёт, поэтому выбор пути проверяем на настоящих git-копиях.
// Порядок (T-687): настройка роли → копия с открытым редактором → основная папка.
{
  const unity = DEFAULT_MCP_SERVERS.find((s) => s.id === 'unity')!;
  const pathOf = (cwd?: string, project?: string | string[]): string =>
    unityProjectArgs(unity, cwd, project).join(' ') || '(нет)';
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'office-unity-')));
  const git = (dir: string, ...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  };
  /** Unity-проект в `dir`: файл версии, по которому его узнаёт офис. */
  const unityAt = (dir: string): void => {
    mkdirSync(join(dir, 'ProjectSettings'), { recursive: true });
    writeFileSync(join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.0f1\n');
  };
  const openEditor = (dir: string): void => {
    mkdirSync(join(dir, 'Temp'), { recursive: true });
    writeFileSync(join(dir, 'Temp', 'UnityLockfile'), '');
  };
  try {
    // Проект в корне репозитория, копия задачи — в другом месте, как .office/worktrees.
    const main = join(tmp, 'rewind-morpeh');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    unityAt(main);
    git(main, 'add', '.');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const copy = join(tmp, 'worktrees', 'T-1');
    git(main, 'worktree', 'add', '-q', '-b', 'task/T-1', copy);

    // Случай 3: lockfile нигде — основная папка, а не копия задачи.
    check('Unity: редактор нигде — основная папка', pathOf(copy, main) === `--project-path ${main}`, pathOf(copy, main));
    const places = { copy: [copy], main: [main] };
    const why = (p: Parameters<typeof chooseUnityProject>[0]): string => {
      const c = chooseUnityProject(p);
      return c ? `${c.reason} ${c.path}` : '(нет)';
    };
    check('Unity: причина без редактора — main', why(places) === `main ${main}`, why(places));

    // Случай 2: редактор открыт именно на копии задачи — берём копию.
    openEditor(copy);
    check('Unity: редактор на копии задачи — копия', why(places) === `editorInCopy ${copy}`, why(places));
    // Открыт и там, и там — копия всё равно сильнее: её редактор видит правки.
    openEditor(main);
    check('Unity: редактор и на копии, и в основной — копия', why(places) === `editorInCopy ${copy}`, why(places));
    rmSync(join(copy, 'Temp'), { recursive: true, force: true });

    // Случай 1: явная настройка перекрывает автовыбор, даже открытый редактор.
    const own = join(tmp, 'elsewhere', 'Game');
    check('Unity: явная настройка перекрывает автовыбор',
      why({ ...places, explicit: own }) === `setting ${own}`, why({ ...places, explicit: own }));
    check('Unity: пустая настройка — автовыбор', why({ ...places, explicit: '  ' }) === `main ${main}`, why({ ...places, explicit: '  ' }));

    // Настройка роли доезжает до аргументов моста, путь и причина — до сессии.
    const unityRole: Role = { ...role('backend'), mcp: ['unity'] };
    const argsOf = (r: Role): string =>
      ((externalMcp(catalog(), r, copy, places).unity as { args?: string[] }).args ?? []).join(' ');
    check('Unity: настройка роли в аргументах моста',
      argsOf({ ...unityRole, mcpProjectPath: own }) === `mcp --project-path ${own}`, argsOf({ ...unityRole, mcpProjectPath: own }));
    check('Unity: без настройки роли — основная папка', argsOf(unityRole) === `mcp --project-path ${main}`, argsOf(unityRole));
    const chosen = unityProjectForRole(catalog(), { ...unityRole, mcpProjectPath: own }, places);
    rememberUnityProject(['T-1', 'agent-1'], chosen);
    const seen = unityProjectForSession('T-1');
    check('Unity: путь сессии отдаётся наружу',
      seen?.path === own && seen.reason === 'setting' && unityProjectForSession('agent-1') === seen,
      seen ? `${seen.reason} ${seen.path}` : '(нет)');
    check('Unity: роли без моста пути нет', unityProjectForRole(catalog(), role('backend'), places) === null, 'null');
    rememberUnityProject(['T-1'], null);
    check('Unity: забытая сессия — null', unityProjectForSession('T-1') === null, 'null');
    check('Unity: настройка только абсолютная',
      sanitizeProjectPath('/a/b/') === '/a/b' && sanitizeProjectPath('a/b') === undefined && sanitizeProjectPath('') === undefined,
      String(sanitizeProjectPath('/a/b/')));

    check('Unity: редактор в основной папке, задача в копии',
      pathOf(copy, main) === `--project-path ${main}`, pathOf(copy, main));
    // project указывает не туда (например, на копию) — основную папку
    // находим через git worktree list.
    check('Unity: основная папка найдена через git',
      pathOf(copy, copy) === `--project-path ${main}`, pathOf(copy, copy));
    check('Unity: только копия задачи — тоже находим', pathOf(copy) === `--project-path ${main}`, pathOf(copy));

    // Проект в подпапке репозитория.
    const nested = join(tmp, 'game-repo');
    mkdirSync(join(nested, 'client'), { recursive: true });
    git(nested, 'init', '-q', '-b', 'main');
    unityAt(join(nested, 'client', 'Game'));
    writeFileSync(join(nested, 'README.md'), 'x\n');
    git(nested, 'add', '.');
    git(nested, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const nestedCopy = join(tmp, 'worktrees', 'T-2');
    git(nested, 'worktree', 'add', '-q', '-b', 'task/T-2', nestedCopy);
    check('Unity: проект на два уровня ниже, редактора нет',
      pathOf(nestedCopy, nested) === `--project-path ${join(nested, 'client', 'Game')}`, pathOf(nestedCopy, nested));
    // Unity-проект есть только в копии (основная папка — не Unity) — копия.
    const solo = join(tmp, 'solo');
    unityAt(join(solo, 'Game'));
    const soloPlaces = { copy: [solo], main: [join(tmp, 'plain-main')] };
    check('Unity: в основной папке проекта нет — копия',
      why(soloPlaces) === `copy ${join(solo, 'Game')}`, why(soloPlaces));
    openEditor(join(nested, 'client', 'Game'));
    check('Unity: проект в подпапке, редактор в основной папке',
      pathOf(nestedCopy, nested) === `--project-path ${join(nested, 'client', 'Game')}`, pathOf(nestedCopy, nested));

    // Глубже двух уровней не ищем.
    const deep = join(tmp, 'deep');
    unityAt(join(deep, 'a', 'b', 'c'));
    check('Unity: глубже двух уровней не ищем', pathOf(deep) === '(нет)', pathOf(deep));
    const plain = join(tmp, 'plain', 'src');
    mkdirSync(plain, { recursive: true });
    check('Unity: не Unity-проект — флага нет', pathOf(plain) === '(нет)', pathOf(plain));
    check('Unity: путь задан руками — не трогаем',
      unityProjectArgs({ ...unity, args: [...unity.args, '--project-path', '/x'] }, copy, main).length === 0, '(пусто)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------- нет файла stdio-сервера

// Скрипта на диске нет — сервер упадёт молча, поэтому serversFor пишет в лог,
// но сервер всё равно отдаёт: сессию из-за этого не роняем.
{
  const ghost: McpServerDef = {
    ...DEFAULT_MCP_SERVERS.find((s) => s.id === 'browser')!,
    args: ['/нет/такого/tools/browser/server.mjs'],
  };
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.join(' ')); };
  let got: string[];
  try {
    got = serversFor(catalog([ghost]), role('qa')).map((s) => s.id);
  } finally {
    console.warn = warn;
  }
  check('нет файла — предупреждение с id и путём',
    warned.some((w) => w.includes('browser') && w.includes('/нет/такого/tools/browser/server.mjs')), warned.join(' | ') || '(тишина)');
  check('нет файла — сервер всё равно в списке', got.includes('browser'), got.join(', ') || '(нет)');
}

// --------------------------------------------------------- каталог из формы

const one = (def: Partial<McpServerDef>): ReturnType<typeof checkMcpServers> =>
  checkMcpServers([{ id: 'srv', transport: 'stdio', command: 'npx', ...def }]);

const problem = (r: ReturnType<typeof checkMcpServers>): string => r.problems[0]?.key ?? '(нет)';

check('годный сервер проходит', one({}).problems.length === 0, problem(one({})));
check('пустое имя не проходит', problem(one({ id: '' })) === 'badId', problem(one({ id: '' })));
check('имя с решёткой не проходит', problem(one({ id: 'fig#ma' })) === 'badId', problem(one({ id: 'fig#ma' })));
check('stdio без команды не проходит', problem(one({ command: '' })) === 'noCommand', problem(one({ command: '' })));
check('http без адреса не проходит',
  problem(one({ transport: 'http', url: '' })) === 'noUrl', problem(one({ transport: 'http', url: '' })));
check('адрес не по http не проходит',
  problem(one({ transport: 'http', url: 'ftp://x' })) === 'badUrl',
  problem(one({ transport: 'http', url: 'ftp://x' })));

const dup = checkMcpServers([
  { id: 'srv', transport: 'stdio', command: 'a' }, { id: 'srv', transport: 'stdio', command: 'b' },
]);
check('одно имя дважды не проходит', problem(dup) === 'dupId', problem(dup));

// Токен в каталоге — это токен в файле состояния и в каждом снимке для фронта.
check('токен значением не проходит',
  problem(one({ env: { TOKEN: 'secret-123' } })) === 'badEnv',
  problem(one({ env: { TOKEN: 'secret-123' } })));
check('ссылка на окружение проходит',
  one({ env: { TOKEN: '${OFFICE_TEST_TOKEN}' } }).problems.length === 0,
  problem(one({ env: { TOKEN: '${OFFICE_TEST_TOKEN}' } })));

// ------------------------------------------------- раскрытие ссылок в сессии

process.env.OFFICE_TEST_TOKEN = 'из-окружения';
const withEnv = catalog([{
  ...DEFAULT_MCP_SERVERS[0], id: 'tokened', env: { TOKEN: '${OFFICE_TEST_TOKEN}' },
}]);
const built = externalMcp(withEnv, { ...role('design'), mcp: ['tokened'] }).tokened;
const env = (built as { env?: Record<string, string> }).env ?? {};
check('ссылка раскрыта из окружения', env.TOKEN === 'из-окружения', String(env.TOKEN));

delete process.env.OFFICE_TEST_TOKEN;
const missing = externalMcp(withEnv, { ...role('design'), mcp: ['tokened'] }).tokened;
const envMissing = (missing as { env?: Record<string, string> }).env ?? {};
// Переменной нет — пустая строка, а не сама ссылка: сервер с заголовком
// `${TOKEN}` ответил бы невнятной ошибкой авторизации.
check('переменной нет — пусто, а не ссылка', envMissing.TOKEN === '', `«${envMissing.TOKEN}»`);

// ------------------------------------------------- статус подключения

/** Сессия-заглушка: отдаёт заготовленные ответы по одному на опрос. */
const fakeSession = (answers: unknown[][]) => {
  let call = 0;
  return {
    calls: () => call,
    mcpServerStatus: async () => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      if (answer === null) throw new Error('сессия кончилась');
      return answer as Parameters<typeof Object.assign>[0][];
    },
  };
};
const noWait = async (): Promise<void> => {};
const wanted = new Set(['figma-bridge']);

// Свои серверы офиса в статусе не участвуют: их поднимает сам офис в своём
// процессе, и рассказывать человеку об их состоянии нечего.
const mixed = await pollMcpStatus(
  fakeSession([[
    { name: 'office', status: 'connected' },
    { name: 'figma-bridge', status: 'connected', serverInfo: { version: '1.2.3' } },
  ]]) as never, wanted, 'design#1', noWait,
);
check('в статусе только внешние серверы', mixed.map((m) => m.id).join() === 'figma-bridge',
  mixed.map((m) => m.id).join() || '(пусто)');
check('версия сервера сохраняется', mixed[0]?.version === '1.2.3', String(mixed[0]?.version));

// Первый ответ почти всегда pending: stdio поднимается, не блокируя сессию.
const late = fakeSession([
  [{ name: 'figma-bridge', status: 'pending' }],
  [{ name: 'figma-bridge', status: 'pending' }],
  [{ name: 'figma-bridge', status: 'failed', error: 'плагин не открыт' }],
]);
const settled = await pollMcpStatus(late as never, wanted, 'design#1', noWait);
check('опрос повторяется, пока сервер поднимается',
  settled[0]?.status === 'failed' && late.calls() === 3, `${settled[0]?.status}, опросов ${late.calls()}`);
check('причина отказа доезжает', settled[0]?.error === 'плагин не открыт', settled[0]?.error ?? '');

const quick = fakeSession([[{ name: 'figma-bridge', status: 'connected' }]]);
await pollMcpStatus(quick as never, wanted, 'design#1', noWait);
check('подключился — лишних опросов нет', quick.calls() === 1, `опросов ${quick.calls()}`);

const odd = await pollMcpStatus(
  fakeSession([[{ name: 'figma-bridge', status: 'что-то-новое' }]]) as never,
  wanted, 'design#1', noWait, 1,
);
check('незнакомый статус считаем «поднимается»', odd[0]?.status === 'pending', String(odd[0]?.status));

// Сервер, которого сессия не знает вовсе, — немой отказ: роль без
// инструментов, а в логе пусто (так выглядел penpot у дизайнера, T-389).
const silent = await pollMcpStatus(
  fakeSession([[{ name: 'figma-bridge', status: 'connected' }]]) as never,
  new Set(['figma-bridge', 'penpot']), 'design#1', noWait,
);
check('сервер не дошёл до сессии — это отказ',
  silent.find((m) => m.id === 'penpot')?.status === 'failed'
    && silent.find((m) => m.id === 'penpot')?.error === MCP_NOT_IN_SESSION,
  JSON.stringify(silent.map((m) => `${m.id}:${m.status}`)));

// Сессия оборвалась — это не событие про серверы, статус выдумывать нечего.
const dead = await pollMcpStatus(fakeSession([null as never]) as never, wanted, 'design#1', noWait);
check('оборванная сессия не даёт статуса', dead.length === 0, `${dead.length} записей`);

// --------------------------------------------------------- живая сессия

// Заглушки проверяют наш разбор, но не контракт SDK: что метод так называется,
// что имя сервера совпадает с ключом каталога и что отказ приходит с текстом.
// Это видно только на настоящей сессии, поэтому она за флагом:
//   MCP_LIVE=1 npm run test:mcp
if (process.env.MCP_LIVE === '1') {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const design = role('design');
  const wantedLive = new Set(Object.keys(externalMcp(catalog(), design)));
  console.log(`\n  живая сессия, серверы роли: ${[...wantedLive].join(', ') || '(нет)'}`);
  const session = query({
    prompt: 'ничего не делай',
    options: {
      cwd: process.cwd(),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      mcpServers: externalMcp(catalog(), design),
      settingSources: [],
      maxTurns: 1,
    },
  });
  try {
    const live = await pollMcpStatus(session, wantedLive, 'design#1');
    for (const s of live) {
      console.log(`  ${s.status === 'connected' ? 'ok  ' : '····'} ${s.id.padEnd(16)}`
        + ` → ${s.status}${s.error ? `: ${s.error}` : ''}${s.version ? ` (${s.version})` : ''}`);
    }
    // Отказ сервера — не провал проверки: плагин может быть не открыт. Провал
    // здесь один — если SDK перестал отвечать на вопрос о серверах вовсе.
    if (live.length !== wantedLive.size) {
      failed += 1;
      console.log(`  FAIL SDK не рассказал о серверах: ${live.length} из ${wantedLive.size}`);
    }
  } finally {
    await session.interrupt().catch(() => {});
  }
} else {
  console.log('\n  живой опрос пропущен (MCP_LIVE=1, чтобы спросить настоящую сессию)');
}

console.log(failed ? `\nпровалено кейсов: ${failed}` : '\nвсе кейсы прошли');
process.exit(failed ? 1 : 0);

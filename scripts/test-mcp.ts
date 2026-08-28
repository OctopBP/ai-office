// Проверка каталога внешних MCP-серверов: кому что подключается, что сказано
// об этом в промпте и что каталог не пропускает мусор из формы. npm run test:mcp
//
// Подписку и промпт стоит проверять именно парой: сервер без строки в промпте
// роль не заметит, а строка не от той роли хуже отсутствия строки — фронтенд,
// которому сказано «делай макет в Figma», займётся не своим делом.
import {
  checkMcpServers, DEFAULT_MCP_SERVERS, externalMcp, mcpBrief,
} from '../src/server/mcp';
import { defaultRole } from '../src/server/roles';
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
check('фронтенду тот же figma-bridge', servers(role('frontend')).includes('figma-bridge'), list(role('frontend')));
check('3D-художнику blender', servers(role('artist3d')).includes('blender'), list(role('artist3d')));
check('бэкенду ничего', servers(role('backend')).length === 0, list(role('backend')));

// Своё поле роли сильнее умолчания по id — иначе отключить сервер было бы нечем.
check('mcp: [] отключает всё', servers({ ...role('design'), mcp: [] }).length === 0,
  list({ ...role('design'), mcp: [] }));
check('неизвестное имя отбрасывается',
  servers({ ...role('design'), mcp: ['figma-bridge', 'нет-такого'] }).join() === 'figma-bridge',
  list({ ...role('design'), mcp: ['figma-bridge', 'нет-такого'] }));

// Каталог офисный: сервер из него убрали — подписка роли переживает это молча.
const empty = catalog([]);
check('пустой каталог — нечего подключать', servers(role('design'), empty).length === 0,
  list(role('design'), empty));
const off = catalog(DEFAULT_MCP_SERVERS.map((s) => ({ ...s, disabled: true })));
check('выключенный сервер не поднимается', servers(role('design'), off).length === 0,
  list(role('design'), off));

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

console.log(failed ? `\nпровалено кейсов: ${failed}` : '\nвсе кейсы прошли');
process.exit(failed ? 1 : 0);

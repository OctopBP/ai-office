// Проверка каталога внешних MCP-серверов: кому что подключается, что сказано
// об этом в промпте и что каталог не пропускает мусор из формы. npm run test:mcp
//
// Подписку и промпт стоит проверять именно парой: сервер без строки в промпте
// роль не заметит, а строка не от той роли хуже отсутствия строки — фронтенд,
// которому сказано «делай макет в Figma», займётся не своим делом.
import {
  checkMcpServers, DEFAULT_MCP_SERVERS, externalMcp, mcpBrief, pollMcpStatus,
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

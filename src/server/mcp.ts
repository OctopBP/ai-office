/**
 * Внешние MCP-серверы исполнителей: инструменты, которых нет в самом Claude
 * Code, но без которых роль не может делать свою работу.
 *
 * Сессии агентов поднимаются с `settingSources: []` — настройки Claude Code
 * пользователя им намеренно не достаются: что у роли под руками, решает офис,
 * а не файл в домашней директории, который правится по другому поводу. Плата
 * за это — MCP-серверы из `~/.claude.json` в сессию тоже не попадают, и
 * дизайнер, которому нужен Figma, видел вместо инструментов пустоту.
 *
 * Поэтому серверы, нужные ролям, офис держит у себя — в каталоге настроек
 * (`Settings.mcpServers`), а роли подписываются на них по id. В коде остаётся
 * только НАБОР ПО УМОЛЧАНИЮ: с ним заводится новый офис и с ним поднимаются
 * сохранения, сделанные до появления каталога. Дальше каталог правится из
 * интерфейса — добавить Blender или дать Figma ещё одной роли должно быть
 * работой, а не правкой исходников с перезапуском сервера.
 *
 * Секретов в каталоге нет и быть не может: значением переменной или заголовка
 * допускается только ссылка `${NAME}`, которая раскрывается из окружения
 * сервера в момент запуска сессии. Настройки офиса лежат в файле состояния и
 * целиком уезжают на фронт в каждом снимке — записанный здесь токен утёк бы
 * дважды.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Lang } from '../shared/i18n';
import type { McpServerDef, McpServerState, Settings } from '../shared/types';
import { hasKey, t } from './i18n';
import type { Role } from './roles';

/**
 * Корень репозитория офиса. Нужен одному серверу — своему: он лежит здесь же,
 * в `tools/`, а не ставится из сети, и запускать его надо по полному пути.
 * Текущая директория для этого не годится: офис поднимают и из другой папки,
 * а каталог с относительным путём молча перестал бы работать.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Заготовка сервера: остальное добивается умолчаниями. */
const server = (def: Partial<McpServerDef> & { id: string }): McpServerDef => ({
  title: '',
  transport: 'stdio',
  command: '',
  args: [],
  url: '',
  env: {},
  alwaysLoad: false,
  disabled: false,
  ...def,
});

/**
 * Каталог нового офиса. Меняется отсюда только он: у уже заведённого офиса
 * каталог свой и живёт в его настройках.
 */
export const DEFAULT_MCP_SERVERS: McpServerDef[] = [
  /**
   * Figma через локальный мост: MCP-сервер держит WebSocket на localhost, а
   * плагин Figma MCP Bridge, открытый в файле, отдаёт ему документ. Отсюда
   * два следствия. Первое: работает без токенов и без лимитов Figma API, но
   * только пока плагин открыт. Второе: серверов поднимается столько, сколько
   * идёт сессий, и порт занимает первый — остальные ходят через него сами
   * (в пакете для этого есть выбор лидера), так что двум дизайнерам сразу
   * ничего не мешает.
   */
  server({
    id: 'figma-bridge',
    title: 'Figma',
    command: 'npx',
    args: ['-y', '@gethopp/figma-mcp-bridge'],
    // Инструменты сервера должны лежать в промпте с первого хода. Иначе они
    // прячутся за поиском инструментов, а поиска у дизайнера нет: набор
    // встроенных инструментов у роли урезан. Ровно так и выглядел отказ
    // «никакого Figma мне не видно».
    alwaysLoad: true,
  }),
  /**
   * Blender через аддон Blender MCP: сервер поднимается `uvx blender-mcp`, а
   * на другом конце — аддон, который слушает сокет внутри ЗАПУЩЕННОГО Blender
   * с окнами. Отсюда две оговорки, обе жёсткие.
   *
   * Первая: без установленного аддона и без открытого Blender инструменты
   * отвечают отказом. Это не поломка офиса — роль обязана в таком случае
   * работать фоновым скриптом, как работала до моста (см. её бриф).
   *
   * Вторая: мост живёт в GUI, а результат роли — файлы в репозитории. Поэтому
   * мост здесь для разведки: посмотреть сцену, померить, проверить глазами.
   * Итог всё равно оформляется скриптом в tools/blender/ — иначе следующий
   * фоновый прогон сотрёт слепленное руками, ровно как у спрайтов.
   */
  server({
    id: 'blender',
    title: 'Blender',
    command: 'uvx',
    args: ['blender-mcp'],
    // Инструментов у сервера немного, и держать их в промпте с первого хода
    // дешевле, чем отдельный ход на поиск инструмента.
    alwaysLoad: true,
  }),
  /**
   * Свой сервер: генератор картинок. Лежит в `tools/imagegen/`, поднимается
   * обычным node без сборки и загрузчиков.
   *
   * Он здесь по той же причине, что и остальные, — рисовать Claude Code не
   * умеет, а иллюстратору без этого нечем работать. Отличие одно: сервер наш,
   * поэтому у него есть то, чего у чужих мостов нет, — периметр записи. Файлы
   * он кладёт только внутрь рабочей копии сотрудника, которую офис передаёт
   * ему через `OFFICE_WORKDIR` (см. `toSdkConfig`): сам сервер поднимается
   * процессом офиса и о ветке задачи ничего не знает.
   *
   * Провайдеров у него несколько (nanobananaapi.ai и Gemini напрямую), и
   * выбор — это ключ в окружении, а не правка кода. Ключи перечислены
   * ссылками: так человеку видно в интерфейсе, чего серверу не хватает, а
   * сам ключ в настройки офиса не попадает.
   */
  server({
    id: 'imagegen',
    title: 'Image API',
    command: 'node',
    args: [resolve(ROOT, 'tools/imagegen/server.mjs')],
    env: {
      NANOBANANA_API_KEY: '${NANOBANANA_API_KEY}',
      GEMINI_API_KEY: '${GEMINI_API_KEY}',
      IMAGEGEN_PROVIDER: '${IMAGEGEN_PROVIDER}',
    },
    // Инструментов три, и без них роль не начнёт работу вовсе — держать их
    // за поиском инструмента значило бы платить ходом на каждой задаче.
    alwaysLoad: true,
  }),
];

/** Каталог офиса. Поля нет — офис старше каталога, берём набор по умолчанию. */
export const mcpCatalog = (settings: Settings): McpServerDef[] =>
  settings.mcpServers ?? DEFAULT_MCP_SERVERS;

/**
 * Имена серверов роли. Умолчание роли из пакета лежит в её манифесте и при
 * заведении роли попадает в это поле; у роли без поля подключать нечего.
 * `mcp: []` — это «этой роли ничего не подключать», а не «взять как у всех».
 */
export const mcpNamesFor = (role: Role): string[] => role.mcp ?? [];

/**
 * Серверы роли из каталога офиса. Неизвестные и выключенные имена отбрасываем
 * молча: сервер могли убрать из каталога или выключить на время, а подписка
 * роли лежит в сохранении и переживёт это.
 */
const serversFor = (settings: Settings, role: Role): McpServerDef[] => {
  const catalog = mcpCatalog(settings);
  return mcpNamesFor(role)
    .map((id) => catalog.find((s) => s.id === id))
    .filter((s): s is McpServerDef => s !== undefined && !s.disabled);
};

/** Ссылка `${NAME}` целиком — единственное, что допускается значением. */
const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Раскрыть ссылки на окружение. Переменной нет — кладём пустую строку, а не
 * саму ссылку: сервер, получивший заголовок `${FIGMA_TOKEN}`, ответил бы
 * невнятной ошибкой авторизации, и разбираться пришлось бы в чужих логах.
 */
function resolveEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const ref = ENV_REF.exec(value);
    out[key] = ref ? process.env[ref[1]] ?? '' : value;
  }
  return out;
}

/**
 * Описание сервера в том виде, в каком его ждёт SDK.
 *
 * Рабочая копия сотрудника уезжает stdio-серверу переменной `OFFICE_WORKDIR`,
 * и это не удобство, а починка. Внешний сервер — отдельный процесс, который
 * поднимает офис, а не сессия: его текущая директория — та, откуда запущен
 * офис, и про ветку задачи он не знает ничего. Сервер, пишущий файлы, без
 * этой переменной складывал бы их в корень офиса мимо ветки — то есть в
 * никуда. Мостам до Figma и Blender переменная не мешает: они её не читают.
 */
function toSdkConfig(def: McpServerDef, cwd?: string): McpServerConfig {
  const env = resolveEnv(def.env);
  if (def.transport === 'stdio') {
    const withCwd = cwd ? { ...env, OFFICE_WORKDIR: cwd } : env;
    return {
      type: 'stdio',
      command: def.command,
      args: def.args,
      ...(Object.keys(withCwd).length ? { env: withCwd } : {}),
      alwaysLoad: def.alwaysLoad,
    };
  }
  return {
    type: def.transport,
    url: def.url,
    ...(Object.keys(env).length ? { headers: env } : {}),
    alwaysLoad: def.alwaysLoad,
  };
}

/**
 * Внешние MCP-серверы роли — в том виде, в каком их ждёт опция сессии.
 * `cwd` — рабочая копия сотрудника: она нужна серверам, которые пишут файлы
 * (§ `toSdkConfig`). Пусто — серверы поднимаются как раньше.
 */
export const externalMcp = (
  settings: Settings, role: Role, cwd?: string,
): Record<string, McpServerConfig> =>
  Object.fromEntries(serversFor(settings, role).map((s) => [s.id, toSdkConfig(s, cwd)]));

/**
 * Дополнение к системному промпту: чем роль умеет пользоваться и что делать,
 * когда инструмент отвечает, что подключения нет. Без этого куска бриф роли
 * («работаешь текстом и разметкой») продолжал бы отговаривать дизайнера от
 * Figma, даже когда Figma у него в руках.
 *
 * Ключ роли сильнее общего: один и тот же Figma дизайнеру и фронтенду нужен
 * для разного — первый макет делает, второй по нему верстает, и «делай макет
 * в Figma» фронтенду не инструкция, а приглашение заняться не своим.
 *
 * Текст необязателен: сервер, заведённый из интерфейса, своей строки в
 * словаре не имеет и подключается молча.
 */
export function mcpBrief(settings: Settings, role: Role, lang: Lang): string {
  const notes = serversFor(settings, role)
    .map((s) => [`mcp.${s.id}.brief.${role.id}`, `mcp.${s.id}.brief`].find(hasKey))
    .filter((key): key is Exclude<typeof key, undefined> => key !== undefined)
    .map((key) => t(lang, key));
  return notes.length ? `\n\n${notes.join('\n\n')}` : '';
}

// ------------------------------------------------- проверка каталога из UI

/** Что не так с каталогом. Пусто — каталог годный. */
export interface McpProblem {
  /** id сервера, с которым беда; пусто — беда с каталогом целиком. */
  id: string;
  key: 'badId' | 'dupId' | 'noCommand' | 'noUrl' | 'badUrl' | 'badEnv';
  /** Подробность для сообщения: имя переменной, значение поля. */
  detail: string;
}

/** id сервера: из него растут имена инструментов, поэтому без вольностей. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

/**
 * Каталог из формы: привести к порядку и найти ошибки. Возвращает и то, и
 * другое — с ошибками каталог не сохраняется целиком, как и любая настройка:
 * «половина приехала» человеку не объяснить.
 */
export function checkMcpServers(value: unknown): {
  servers: McpServerDef[];
  problems: McpProblem[];
} {
  const problems: McpProblem[] = [];
  const servers: McpServerDef[] = [];
  if (!Array.isArray(value)) return { servers, problems };

  const seen = new Set<string>();
  for (const raw of value) {
    const item = (raw ?? {}) as Partial<McpServerDef>;
    const id = String(item.id ?? '').trim();
    if (!ID_RE.test(id)) {
      problems.push({ id, key: 'badId', detail: id });
      continue;
    }
    if (seen.has(id)) {
      problems.push({ id, key: 'dupId', detail: id });
      continue;
    }
    seen.add(id);

    const transport = item.transport === 'http' || item.transport === 'sse' ? item.transport : 'stdio';
    const command = String(item.command ?? '').trim();
    const url = String(item.url ?? '').trim();
    if (transport === 'stdio' && !command) problems.push({ id, key: 'noCommand', detail: '' });
    if (transport !== 'stdio') {
      if (!url) problems.push({ id, key: 'noUrl', detail: '' });
      // http и https, и ничего больше: MCP-сервер по file:// или по чему-то
      // самодельному — это не «другой транспорт», а опечатка.
      else if (!/^https?:\/\//.test(url)) problems.push({ id, key: 'badUrl', detail: url });
    }

    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(item.env ?? {})) {
      const text = String(val ?? '');
      // Значение не ссылка — значит, в каталог кладут сам токен. Отказываем:
      // настройки уезжают на фронт и лежат в файле состояния.
      if (!ENV_REF.test(text)) problems.push({ id, key: 'badEnv', detail: key });
      else env[key] = text;
    }

    servers.push({
      id,
      title: String(item.title ?? '').trim(),
      transport,
      command,
      args: Array.isArray(item.args) ? item.args.map((a) => String(a)) : [],
      url,
      env,
      alwaysLoad: item.alwaysLoad !== false,
      disabled: item.disabled === true,
    });
  }
  return { servers, problems };
}

// ------------------------------------------------- статус подключения

/**
 * Живая сессия, у которой можно спросить статус серверов. Описана своим
 * типом, а не импортом из SDK: офису нужны три поля, и когда ответ SDK
 * поменяется, чинить придётся ровно их.
 */
export interface McpStatusSource {
  mcpServerStatus(): Promise<Array<{
    name: string;
    status: string;
    serverInfo?: { version?: string };
    error?: string;
  }>>;
}

const KNOWN_STATUS = new Set(['connected', 'failed', 'needs-auth', 'pending', 'disabled']);

/**
 * Спросить сессию о её серверах. Возвращаются только внешние серверы роли:
 * `office` и `team` поднимает сам офис в своём же процессе, и рассказывать
 * человеку об их состоянии нечего.
 *
 * Один опрос сразу после старта почти бесполезен: stdio-серверы поднимаются
 * не блокируя сессию, и первый ответ — сплошной `pending`. Поэтому спрашиваем
 * несколько раз, пока кто-то ещё поднимается, и отдаём последнюю картину.
 */
export async function pollMcpStatus(
  session: McpStatusSource,
  wanted: Set<string>,
  agentId: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts = 4,
  gapMs = 4000,
): Promise<McpServerState[]> {
  let last: McpServerState[] = [];
  for (let i = 0; i < attempts; i += 1) {
    await wait(i === 0 ? 1000 : gapMs);
    let raw: Awaited<ReturnType<McpStatusSource['mcpServerStatus']>>;
    try {
      raw = await session.mcpServerStatus();
    } catch {
      // Сессия успела закончиться или оборваться — это не событие про
      // серверы, и придумывать им статус по такому поводу не нужно.
      return last;
    }
    last = raw
      .filter((s) => wanted.has(s.name))
      .map((s) => ({
        id: s.name,
        status: (KNOWN_STATUS.has(s.status) ? s.status : 'pending') as McpServerState['status'],
        error: String(s.error ?? ''),
        version: String(s.serverInfo?.version ?? ''),
        at: Date.now(),
        agentId,
      }));
    if (!last.some((s) => s.status === 'pending')) return last;
  }
  return last;
}

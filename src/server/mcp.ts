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
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { McpServerConfig } from './engines/types';
import type { Lang } from '../shared/i18n';
import type { McpServerDef, McpServerState, Settings } from '../shared/types';
import { hasKey, t } from './i18n';
import type { Role } from './roles';
import { ROOT } from './root';

/**
 * Корень репозитория офиса. Нужен одному серверу — своему: он лежит здесь же,
 * в `tools/`, а не ставится из сети, и запускать его надо по полному пути.
 * Текущая директория для этого не годится: офис поднимают и из другой папки,
 * а каталог с относительным путём молча перестал бы работать.
 */

/** Заготовка сервера: остальное добивается умолчаниями. */
/**
 * Чем на самом деле запускается свой node-сервер каталога.
 *
 * В каталоге он записан как `node` — так его и надо читать человеку. Но у
 * приложения отдельного node рядом нет: оно запускает такие серверы собой,
 * и по переменной ELECTRON_RUN_AS_NODE Electron работает обычной нодой
 * (настоящий node её просто не замечает). Подмена делается здесь, на запуске,
 * а не в каталоге: каталог сохраняется в настройки офиса, и путь к текущей
 * сборке приложения застрял бы там навсегда.
 */
function nodeCommand(command: string): { command: string; env: Record<string, string> } {
  const bin = process.env.OFFICE_NODE_BIN || '';
  return bin && (command === 'node' || command === bin)
    ? { command: bin, env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { command, env: {} };
}

/** Имя CLI figcraft в каталоге: по нему `toolCommand` ищет настоящий бинарник. */
export const FIGCRAFT_CLI = 'figcraft-cli';

/**
 * Где лежит бинарник внешнего инструмента, который ставит владелец, а не npm.
 *
 * В каталоге он записан голым именем — так каталог одинаков у всех и не
 * хранит путь, который есть только на одной машине. Но запуск по одному
 * PATH ненадёжен: приложение для macOS берёт PATH у входного шелла, а не
 * ответил шелл — остаётся системный, без `~/.local/bin` и прочего из
 * `.zshrc`. Тогда сервер молча не поднимался бы. Поэтому порядок такой:
 *
 * 1. переменная окружения (`FIGCRAFT_CLI=/полный/путь`) — переопределение;
 * 2. `~/.office/tools/bin/<имя>` — место по умолчанию, обычно симлинк на
 *    бинарник конкретной версии (`~/.office/tools/figcraft-0.6.0/…`): новая
 *    версия ставится рядом, а переключается одним симлинком;
 * 3. голое имя — пусть ищет PATH, как раньше.
 *
 * Полный путь, вписанный владельцем в каталог вместо имени, сюда не попадает
 * и запускается как есть. Подмена делается на запуске, а не в каталоге, по
 * той же причине, что у `nodeCommand`.
 */
const TOOL_BINARIES: Record<string, string> = { [FIGCRAFT_CLI]: 'FIGCRAFT_CLI' };

export function toolCommand(command: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const envName = TOOL_BINARIES[command];
  if (!envName) return command;
  const fromEnv = env[envName]?.trim();
  if (fromEnv) return fromEnv;
  const local = join(home, '.office', 'tools', 'bin', command);
  return existsSync(local) ? local : command;
}

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
   * Figma с записью компонентов: figma-console-mcp (MIT), второй сервер рядом
   * с мостом, а не вместо него. Устроен так же — локальный сервер и плагин
   * Desktop Bridge в открытой Figma Desktop, — но умеет то, чего у моста нет:
   * компоненты, варианты, инстансы, переменные и `figma_execute` с
   * произвольным Plugin API (отсюда FILL у детей автолейаута). Разбор и
   * сравнение — docs/backend-2/T-328/figma-mcp-research.md.
   *
   * Версия зафиксирована: инструментов больше сотни, и все они лежат в
   * промпте, так что новая версия пакета молча меняла бы и набор, и цену
   * префикса. Токен Figma нужен только части инструментов (REST: комментарии,
   * версии, библиотеки); плагинный путь работает и без него.
   */
  server({
    id: 'figma-console',
    title: 'Figma Console',
    command: 'npx',
    args: ['-y', 'figma-console-mcp@1.40.9'],
    env: { FIGMA_ACCESS_TOKEN: '${FIGMA_ACCESS_TOKEN}' },
    // По той же причине, что у моста: поиска инструментов у дизайнера нет.
    alwaysLoad: true,
  }),
  /**
   * Penpot через официальный `@penpot/mcp` — замена Figma для макетов
   * (выбор владельца, docs/design/T-368/research.md). Устроен как мост Figma:
   * MCP-сервер на localhost, а документ ему отдаёт плагин в ОТКРЫТОЙ и
   * активной вкладке редактора Penpot. Без вкладки инструменты отвечают
   * отказом — роль пишет об этом в отчёте, это не поломка офиса.
   *
   * Режим локальный, а не удалённый: удалённому нужен ключ MCP из аккаунта и
   * он без `import_image` с локальных путей и с урезанным `export_shape`, а
   * дизайнеру как раз нужно класть снимки в рабочую копию. Сервер локального
   * режима — HTTP на 4401 и WebSocket к плагину на 4402, поэтому поднимать его
   * на каждую сессию через stdio нельзя: вторая сессия упёрлась бы в занятый
   * порт. Его держит запущенным владелец (`npx @penpot/mcp@stable`), а роль
   * ходит к нему по адресу — шаги в docs/design/penpot-mcp/setup.md.
   */
  server({
    id: 'penpot',
    title: 'Penpot',
    transport: 'http',
    url: 'http://localhost:4401/mcp',
    // Пять инструментов, и у дизайнера нет поиска инструментов — держим их в
    // промпте с первого хода, как у Figma.
    alwaysLoad: true,
  }),
  /**
   * figcraft — самостоятельный клон Figma на Rust (MIT/Apache, альфа),
   * пилот рядом с Penpot, а не замена Figma (разбор — документ офиса D-4).
   * В отличие от трёх мостов выше, его MCP-сервер встроен в CLI и работает
   * headless: движок в процессе `figcraft-cli mcp`, без окна, без плагина и без
   * ключей. Поэтому stdio на каждую сессию, порты не нужны, и два дизайнера
   * друг другу не мешают.
   *
   * Сверено вживую с 0.6.0 (T-595, по figcraft.run/mcp): запуск тот же, MCP
   * `2025-06-18`, 18 инструментов, `tools/list` — около 16,7 КБ. Режим с окном
   * (`mcp --attach <порт>` к `figcraft --control <порт>`) сюда не входит: порт
   * один на машину, такую запись владелец заводит сам на время просмотра.
   *
   * `--no-system-fonts` — одинаковый рендер на любой машине: только встроенные
   * шрифты, без того, что стоит у владельца. Версию фиксирует установленный
   * бинарник (npm-пакета нет), ставит его владелец — docs/design/figcraft/setup.md.
   * Где офис ищет бинарник, решает `toolCommand` ниже: `figcraft-cli` здесь —
   * имя, а не путь.
   *
   * Ни одна роль по умолчанию на него не подписана: на время пилота дизайнер
   * получает сервер галочкой. Периметра записи у сервера нет — `save_file` и
   * `export` с `path` пишут куда угодно, поэтому в permissions.ts они пишущие.
   */
  server({
    id: 'figcraft',
    title: 'FigCraft',
    command: FIGCRAFT_CLI,
    args: ['mcp', '--no-system-fonts'],
    // 18 инструментов, а поиска инструментов у дизайнера нет — держим их в
    // промпте с первого хода, как у Figma.
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
   * Unity через официальный мост: `unity mcp` из Unity CLI, а на другом конце
   * — пакет `com.unity.pipeline` внутри ЗАПУЩЕННОГО редактора (Unity 6.0+),
   * который слушает HTTP только на localhost. Выбор из четырёх мостов —
   * docs/research/unity-role/research.md §4–5.5: официальный, бесплатный,
   * заменяет устаревший MCP из `com.unity.ai.assistant` и ставится тем же
   * CLI, через который роль и так проверяет работу (`unity test`).
   *
   * Оговорки те же, что у Blender. Без открытого редактора с пакетом моста
   * инструменты отвечают отказом — роль обязана перейти на CLI и batchmode,
   * а не ждать (см. её бриф). И мост — для разведки и проверки глазами:
   * результат роли — C# и YAML в ветке задачи, а правка сцены в открытом
   * окне не существует, пока не сохранена и не закоммичена.
   *
   * Подписана на него только роль Unity из своего пакета; остальным он ни к
   * чему.
   */
  server({
    id: 'unity',
    title: 'Unity Editor',
    command: 'unity',
    args: ['mcp'],
    // Инструментов несколько (eval, eval_file и команды редактора), а поиска
    // инструментов у роли нет — без этого она их просто не увидит.
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
  /**
   * Свой сервер: браузер для роли QA (`tools/browser/`, контракт —
   * docs/design/qa/spec.md). Ни одной роли по умолчанию не подключён: роль
   * QA подписывается на него в своём пакете.
   *
   * id `browser` не случаен — по нему permissions.ts пропускает инструменты
   * сервера без вопроса владельцу. Это честно только пока адреса держит фильтр
   * самого сервера, поэтому внешний origin задаётся ссылкой на окружение, а не
   * агентом: пусто — браузер ходит только на localhost и 127.0.0.1.
   */
  server({
    id: 'browser',
    title: 'Browser (QA)',
    command: 'node',
    args: [resolve(ROOT, 'tools/browser/server.mjs')],
    env: {
      QA_ALLOWED_ORIGIN: '${QA_ALLOWED_ORIGIN}',
    },
    // Без open и screenshot QA не начнёт ни одной проверки — держать их за
    // поиском инструмента значило бы платить ходом на каждой задаче.
    alwaysLoad: true,
  }),
];

/**
 * Каталог офиса. Поля нет — офис старше каталога, берём набор по умолчанию.
 *
 * Сохранённый каталог дополняем умолчаниями, которых в нём нет по id: офис,
 * заведённый до появления сервера в умолчаниях (так было с `browser`), иначе
 * не увидел бы его никогда, и подписка роли из пакета молча пропадала бы.
 * Сохранённые записи не трогаем — правки и отключения владельца в силе;
 * убрать сервер насовсем значит выключить его, а не удалить из каталога.
 */
export const mcpCatalog = (settings: Settings): McpServerDef[] => {
  const saved = settings.mcpServers;
  if (!saved) return DEFAULT_MCP_SERVERS;
  const missing = DEFAULT_MCP_SERVERS.filter((d) => !saved.some((s) => s.id === d.id));
  return missing.length ? [...saved, ...missing] : saved;
};

/**
 * Имена серверов роли. Умолчание роли из пакета лежит в её манифесте и при
 * заведении роли попадает в это поле; у роли без поля подключать нечего.
 * `mcp: []` — это «этой роли ничего не подключать», а не «взять как у всех».
 */
export const mcpNamesFor = (role: Role): string[] => role.mcp ?? [];

/**
 * У stdio-сервера абсолютный путь в args — это скрипт, который запустит
 * command. Нет файла — сервер упадёт с «Cannot find module», а SDK проглотит
 * это, и роль молча останется без инструментов (так было с браузером QA в
 * собранном приложении). Сессию не роняем: только громко пишем в лог.
 */
function warnMissingScript(server: McpServerDef): void {
  if (server.transport !== 'stdio') return;
  for (const arg of server.args) {
    if (isAbsolute(arg) && !existsSync(arg)) {
      console.warn(`[mcp] у сервера ${server.id} нет файла на диске: ${arg}`);
    }
  }
}

/**
 * Серверы роли из каталога офиса. Выключенные отбрасываем молча: это решение
 * владельца, подписка роли лежит в сохранении и переживёт его. Неизвестное
 * имя тоже отбрасываем, но с предупреждением в лог: молчание здесь однажды
 * оставило QA без браузера, и искать пришлось по всей цепочке сессии.
 */
export const serversFor = (settings: Settings, role: Role): McpServerDef[] => {
  const catalog = mcpCatalog(settings);
  return mcpNamesFor(role)
    .map((id) => {
      const found = catalog.find((s) => s.id === id);
      if (!found) console.warn(`[mcp] роль ${role.id} подписана на сервер ${id}, которого нет в каталоге офиса`);
      else if (!found.disabled) warnMissingScript(found);
      return found;
    })
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
function toSdkConfig(def: McpServerDef, cwd?: string, project?: string | readonly string[]): McpServerConfig {
  const env = resolveEnv(def.env);
  if (def.transport === 'stdio') {
    const node = nodeCommand(toolCommand(def.command));
    const withCwd = { ...env, ...node.env, ...(cwd ? { OFFICE_WORKDIR: cwd } : {}) };
    return {
      type: 'stdio',
      command: node.command,
      args: [...def.args, ...unityProjectArgs(def, cwd, project)],
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

/** Unity-проект — папка, в которой есть `ProjectSettings/ProjectVersion.txt`. */
const isUnityProject = (dir: string): boolean =>
  existsSync(join(dir, 'ProjectSettings', 'ProjectVersion.txt'));

/**
 * Редактор открыт на проекте, пока в нём лежит `Temp/UnityLockfile`: Unity
 * заводит его при открытии и убирает вместе с `Temp/` при закрытии.
 */
const editorOpenOn = (dir: string): boolean => existsSync(join(dir, 'Temp', 'UnityLockfile'));

/**
 * Папки, которые при поиске Unity-проекта вниз смотреть незачем: служебные
 * Unity, зависимости и скрытые. Без этого обход второго уровня заходил бы в
 * Library с тысячами папок кеша.
 */
const UNITY_SKIP = new Set(['Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', 'node_modules']);

/** Подпапки, куда стоит заглянуть при поиске проекта; ошибка чтения — пусто. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !UNITY_SKIP.has(e.name))
      .map((e) => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Unity-проекты в папке: она сама, иначе её подпапки на один, потом на два
 * уровня вниз (проект часто лежит не в корне репозитория, а в `Game/` или
 * `client/Unity/`). Глубже не идём: обход дерева на каждом старте сессии
 * дороже, чем польза, а проект на пятом уровне задаётся руками в аргументах.
 */
function unityProjectsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (isUnityProject(dir)) return [dir];
  const first = subdirs(dir);
  const level1 = first.filter(isUnityProject);
  if (level1.length) return level1;
  return first.filter((d) => !isUnityProject(d)).flatMap(subdirs).filter(isUnityProject);
}

/**
 * Рабочие копии git-репозитория, в котором лежит `dir`, основная — первой
 * (так их отдаёт `git worktree list`). Не репозиторий, нет git — пусто.
 */
function gitWorktrees(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const out = execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
  } catch {
    return [];
  }
}

/**
 * Путь проекта для моста к Unity (`unity mcp --project-path <путь>`, T-572).
 * Без него мост цепляется к первому найденному редактору, а открытых может
 * быть несколько — и роль смотрела бы в чужой проект.
 *
 * Роль работает в копии задачи (.office/worktrees/…), а владелец открывает
 * редактор на своей папке проекта — основной рабочей копии репозитория зоны
 * (T-575). Поэтому кандидаты — не только `cwd` и `project`, но и все рабочие
 * копии того же git-репозитория, а в каждой — Unity-проект в ней самой или
 * на один-два уровня ниже. Порядок выбора:
 *  1. проект, на котором редактор открыт сейчас (`Temp/UnityLockfile`), где бы
 *     он ни лежал — в копии задачи, в основной папке или в соседней копии;
 *  2. проект в копии задачи (`cwd` и первые папки `project`);
 *  3. проект в репозитории зоны и её корне, затем в основной рабочей копии
 *     репозитория и прочих копиях — в порядке `git worktree list`.
 * Мост поднимается вместе с сессией, так что редактор, открытый позже, он
 * найдёт по выбранному пути.
 *
 * Дописываем только своему серверу из умолчаний (id и команда `unity`),
 * только если путь в аргументах не задан руками и только Unity-проекту:
 * иначе мост искал бы редактор, которого нет, и роль осталась бы без
 * инструментов там, где раньше их получала.
 */
export function unityProjectArgs(def: McpServerDef, cwd?: string, project?: string | readonly string[]): string[] {
  if (def.id !== 'unity' || basename(def.command) !== 'unity') return [];
  if (def.args.includes('--project-path')) return [];
  const given = [cwd, ...(typeof project === 'string' ? [project] : project ?? [])]
    .filter((d): d is string => !!d);
  if (!given.length) return [];
  const worktrees = given.map(gitWorktrees).find((list) => list.length) ?? [];
  // Переданные папки идут первыми: копия задачи, затем репозиторий зоны и её
  // корень. Основная рабочая копия из git нужна, когда `project` — не она.
  const roots = [...new Set([...given, ...worktrees].map((d) => resolve(d)))];
  const found = [...new Set(roots.flatMap(unityProjectsIn))];
  const dir = found.find(editorOpenOn) ?? found[0];
  return dir ? ['--project-path', dir] : [];
}

/**
 * Внешние MCP-серверы роли — в том виде, в каком их ждёт опция сессии.
 * `cwd` — рабочая копия сотрудника: она нужна серверам, которые пишут файлы
 * (§ `toSdkConfig`). `project` — корень репозитория задачи или список папок
 * (копия задачи, репозиторий, корень зоны): по ним и по `cwd` мост Unity
 * находит свой редактор (§ `unityProjectArgs`). Пусто — серверы поднимаются
 * как раньше.
 */
export const externalMcp = (
  settings: Settings, role: Role, cwd?: string, project?: string | readonly string[],
): Record<string, McpServerConfig> =>
  Object.fromEntries(serversFor(settings, role).map((s) => [s.id, toSdkConfig(s, cwd, project)]));

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

/** Причина отказа «сессия о сервере не знает»: текст для лога даёт словарь. */
export const MCP_NOT_IN_SESSION = 'not-in-session';

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
    // Сервер, о котором сессия не знает вовсе, — тот же отказ, только немой:
    // SDK его не поднял, и роль осталась без инструментов без единой строки
    // в логе. Называем это отказом, чтобы человек увидел причину.
    for (const id of wanted) {
      if (last.some((s) => s.id === id)) continue;
      last.push({ id, status: 'failed', error: MCP_NOT_IN_SESSION, version: '', at: Date.now(), agentId });
    }
    if (!last.some((s) => s.status === 'pending')) return last;
  }
  return last;
}

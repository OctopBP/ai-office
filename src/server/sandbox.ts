import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { cleanAllowedHosts, cleanWritePaths } from '../shared/sandbox';
import { capabilitiesOf, type Role } from './roles';

/**
 * Песочница ОС для исполнителей (на macOS — встроенный Seatbelt, ставить нечего).
 * Второй слой защиты, а не замена модалки разрешений: песочница держит границу
 * по файлам и сети, но не мешает послать сигнал процессу (kill) или сделать
 * git push. Эти действия по-прежнему ловит классификатор рисков.
 *
 * По умолчанию запись разрешена только в рабочую директорию сессии (cwd) и
 * временную папку — то есть в workspace/, и никуда больше.
 */
export const SANDBOX = {
  enabled: true,
  // Не притворяться защищёнными: если песочница недоступна, лучше упасть,
  // чем молча выполнять команды без изоляции.
  failIfUnavailable: true,
  // Убрать аварийный люк dangerouslyDisableSandbox.
  allowUnsandboxedCommands: false,
  // По умолчанию true — тогда песочница отключает подтверждения для Bash
  // и модалка перестаёт срабатывать. Нам нужны оба слоя.
  autoAllowBashIfSandboxed: false,
} as const;

/**
 * Команды, которые 3D-роли запускают вне песочницы. Blender 4.3 при старте,
 * ещё до скрипта и даже с --background, спрашивает у системы Metal-устройство,
 * а Seatbelt к GPU не пускает — и Blender падает SIGSEGV (T-116). Лечится
 * только запуском вне песочницы; владелец это разрешил (T-117).
 *
 * Исключаем обёртку, а не сам Blender: так вне песочницы уходит ровно одна
 * точка входа — фон, заводские настройки, проверка Metal как предохранитель,
 * а путь к Blender она берёт из $BLENDER, то есть к машине не привязана.
 * Шаблон `:*` — совпадение по префиксу, с любыми аргументами; путь
 * относительный, потому что Bash исполнителя стоит в корне своей рабочей копии.
 * Модалку разрешений исключение не снимает: вызов по-прежнему идёт через
 * классификатор рисков.
 */
const BLENDER_UNSANDBOXED = ['tools/blender/run.sh:*', './tools/blender/run.sh:*'];

/**
 * Подкоманды Unity CLI, которые поднимают редактор или говорят с открытым
 * редактором (T-567, T-571). В песочнице редактор не получает лицензию: клиент
 * лицензий — .NET-процесс, его именованный мьютекс `Global\Unity.Licensing.
 * Client.Pipe…` и журнал в ~/Library/Logs/Unity Seatbelt не пускает, клиент
 * падает, а редактор ждёт его канал 75 с и виснет без кода выхода. Вслед за
 * лицензией не пишутся ~/Library/Application Support/Unity(Hub) и
 * ~/Library/Unity, а редактор в batchmode пишет туда же, куда GUI. Узкое
 * расширение песочницы этого не лечит: пути мьютексов .NET, mach-сервисы
 * лицензий и Hub зависят от версии, поэтому — вне песочницы, как Blender.
 *
 * Список закрытый: установка редакторов, self-update, вход в аккаунт и прочее
 * остаются в песочнице. Шаблон `:*` — префикс с любыми аргументами; команду
 * вне песочницы Claude Code узнаёт, только если ВСЯ строка из таких частей:
 * `cd … && unity test` или `unity test | tail` уйдут в песочницу (бриф роли).
 */
const UNITY_SUBCOMMANDS = ['test', 'run', 'build', 'recompile', 'license', 'status', 'list'];

/** Каталог редакторов Unity Hub на macOS: `<версия>/Unity.app/Contents/MacOS/Unity`. */
const UNITY_HUB_EDITORS = '/Applications/Unity/Hub/Editor';

/**
 * Исключения для роли Unity: подкоманды CLI (по имени в PATH и по полному
 * пути `~/.unity/bin/unity`, куда его ставит установщик) и сам редактор для
 * прямого batchmode — из Hub и из `UNITY_PATH`, если сервер видит её. Путь
 * в переменной (`"$UNITY_PATH" -batchmode`) Claude Code не раскрывает и вне
 * песочницы не выпускает — поэтому бриф велит писать путь редактора целиком.
 */
export function unityUnsandboxed(env: NodeJS.ProcessEnv = process.env): string[] {
  const clis = ['unity', 'UNITY_NON_INTERACTIVE=1 unity'];
  if (env.HOME) clis.push(join(env.HOME, '.unity/bin/unity'), `UNITY_NON_INTERACTIVE=1 ${join(env.HOME, '.unity/bin/unity')}`);
  const editors = [`${UNITY_HUB_EDITORS}/*/Unity.app/Contents/MacOS/Unity *`];
  if (env.UNITY_PATH?.trim()) editors.push(`${env.UNITY_PATH.trim()}:*`);
  return [...clis.flatMap((cli) => UNITY_SUBCOMMANDS.map((sub) => `${cli} ${sub}:*`)), ...editors];
}

/**
 * Путь без симлинков: Seatbelt сверяет настоящие пути (`/tmp` на macOS —
 * это `/private/tmp`). Самого каталога может ещё не быть — тогда
 * разворачиваем родителя.
 */
function real(path: string): string {
  try { return realpathSync(path); } catch { /* каталога ещё нет */ }
  try { return join(realpathSync(dirname(path)), basename(path)); } catch { return path; }
}

/**
 * Временная папка, которую Claude Code отдаёт командам в песочнице как
 * $TMPDIR: `${CLAUDE_CODE_TMPDIR ?? '/tmp'}/claude-<uid>`. В ней tsx заводит
 * свой IPC-сокет (`tsx-<uid>/<pid>.pipe`), там же удобно держать кеш vite.
 * Писать в неё песочница и так разрешает; сокеты — только с этой настройкой.
 */
export function sandboxTmpDir(env: NodeJS.ProcessEnv = process.env): string {
  const uid = process.getuid?.() ?? 0;
  return join(env.CLAUDE_CODE_TMPDIR || '/tmp', `claude-${uid}`);
}

/**
 * Каталоги кеша vite в node_modules рабочей копии. У копии исполнителя
 * node_modules — симлинк на общий, вне рабочей копии, и без этого vite не
 * может ни положить собранный конфиг в `.vite-temp`, ни кеш зависимостей в
 * `.vite`. Разрешаем ровно эти два каталога, а не node_modules целиком:
 * пакеты остаются только на чтение.
 */
function viteCacheDirs(cwd: string | undefined): string[] {
  if (!cwd) return [];
  const modules = real(join(cwd, 'node_modules'));
  return [join(modules, '.vite'), join(modules, '.vite-temp')];
}

/**
 * Пути на запись для роли Unity (T-684). Скрипты проекта вроде
 * Tools/unity-compile.sh поднимают редактор в batchmode прямо из песочницы —
 * исключение `unityUnsandboxed` их не покрывает, а без этих каталогов редактор
 * не стартует:
 *  - ~/Library/Unity — кеши и лицензия редактора;
 *  - ~/Library/Logs/Unity — журнал редактора и клиента лицензий;
 *  - ~/Library/Application Support/Unity — данные клиента лицензий;
 *  - ~/Library/Preferences — plist-настройки редактора (com.unity3d.*);
 *  - /private/tmp/.dotnet — именованные мьютексы .NET: без них клиент
 *    лицензий падает в GlobalMutex.AcquireMutex.
 */
const UNITY_WRITE_PATHS = [
  '~/Library/Unity',
  '~/Library/Logs/Unity',
  '~/Library/Application Support/Unity',
  '~/Library/Preferences',
  '/private/tmp/.dotnet',
];

/** Сеть роли Unity: лицензия, вход в аккаунт и пакеты — всё на этих доменах. */
const UNITY_HOSTS = ['*.unity.com', '*.unity3d.com'];

/**
 * Каталоги, которые Unity заводит в корне проекта. Рабочая копия задачи и так
 * открыта на запись как cwd сессии, но Seatbelt сверяет настоящие пути, а
 * копия лежит под ~/Library/Application Support — путь с пробелом и, бывает,
 * через симлинк. Поэтому корень копии и эти каталоги перечисляем явно, уже
 * развёрнутыми: «Project folder or disk is read only» редактор пишет, когда
 * не может создать Temp/UnityLockfile или Library/.
 */
const UNITY_PROJECT_DIRS = ['Library', 'Temp', 'Logs', 'UserSettings'];

/** `~/…` — от домашнего каталога машины офиса; затем — без симлинков. */
function expandPath(path: string, home: string | undefined): string | null {
  if (path.startsWith('~/')) return home ? real(join(home, path.slice(2))) : null;
  return real(path);
}

const uniq = (list: string[]): string[] => [...new Set(list)];

/**
 * Песочница под роль.
 *
 * Исключение для Blender получают только роли со способностью `design.3d`
 * (3D-художник и его копии): остальным незачем выходить из песочницы, и
 * лишняя дыра им не нужна. Так же исключение для Unity — только роли со
 * способностью `game.unity` (пакет @office/unity), а не всем, кто пишет код.
 * Ей же — каталоги Unity на запись и домены Unity в сети (`UNITY_*`).
 *
 * Настройка роли `allowLocalBinding` открывает то, без чего не поднять свой
 * сервер для проверки в браузере (тестировщику — свой офис на 3003 и vite):
 *  - слушать локальные порты — `network.allowLocalBinding`; исходящие
 *    соединения песочница при этом пускает только на localhost;
 *  - unix-сокеты внутри временной папки песочницы — `network.allowUnixSockets`
 *    (IPC tsx); сокеты вне неё, вроде ssh-agent или docker, закрыты;
 *  - запись в кеш vite в node_modules — `filesystem.allowWrite`.
 *
 * Свои пути `writePaths` и хосты `allowedHosts` роли (правятся в окне роли)
 * ложатся поверх умолчаний: добавляются, ничего не убирая. Песочница
 * собирается заново при старте каждой сессии, поэтому правка доезжает до
 * следующей сессии без перезапуска офиса.
 */
export function sandboxFor(
  role: Pick<Role, 'capabilities' | 'isolate' | 'tools' | 'docsDir' | 'isManager' | 'allowLocalBinding'
    | 'writePaths' | 'allowedHosts'>,
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const caps = capabilitiesOf(role);
  const unity = caps.includes('game.unity');
  const excluded = [
    ...(caps.includes('design.3d') ? BLENDER_UNSANDBOXED : []),
    ...(unity ? unityUnsandboxed(env) : []),
  ];
  const writes = uniq([
    ...(role.allowLocalBinding ? viteCacheDirs(cwd) : []),
    ...(unity && cwd ? [real(cwd), ...UNITY_PROJECT_DIRS.map((dir) => real(join(cwd, dir)))] : []),
    ...(unity ? UNITY_WRITE_PATHS : []),
    ...cleanWritePaths(role.writePaths),
  ].map((path) => expandPath(path, env.HOME)).filter((path): path is string => Boolean(path)));
  const hosts = uniq([...(unity ? UNITY_HOSTS : []), ...cleanAllowedHosts(role.allowedHosts)]);
  if (!excluded.length && !role.allowLocalBinding && !writes.length && !hosts.length) return SANDBOX;
  const network = {
    ...(role.allowLocalBinding ? {
      allowLocalBinding: true,
      allowUnixSockets: [real(sandboxTmpDir(env))],
    } : {}),
    ...(hosts.length ? { allowedDomains: hosts } : {}),
  };
  return {
    ...SANDBOX,
    ...(excluded.length ? { excludedCommands: excluded } : {}),
    ...(Object.keys(network).length ? { network } : {}),
    ...(writes.length ? { filesystem: { allowWrite: writes } } : {}),
  };
}

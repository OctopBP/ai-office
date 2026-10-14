import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
 * Песочница под роль.
 *
 * Исключение для Blender получают только роли со способностью `design.3d`
 * (3D-художник и его копии): остальным незачем выходить из песочницы, и
 * лишняя дыра им не нужна. Так же исключение для Unity — только роли со
 * способностью `game.unity` (пакет @office/unity), а не всем, кто пишет код.
 *
 * Настройка роли `allowLocalBinding` открывает то, без чего не поднять свой
 * сервер для проверки в браузере (тестировщику — свой офис на 3003 и vite):
 *  - слушать локальные порты — `network.allowLocalBinding`; исходящие
 *    соединения песочница при этом пускает только на localhost;
 *  - unix-сокеты внутри временной папки песочницы — `network.allowUnixSockets`
 *    (IPC tsx); сокеты вне неё, вроде ssh-agent или docker, закрыты;
 *  - запись в кеш vite в node_modules — `filesystem.allowWrite`.
 */
export function sandboxFor(
  role: Pick<Role, 'capabilities' | 'isolate' | 'tools' | 'docsDir' | 'isManager' | 'allowLocalBinding'>,
  cwd?: string,
) {
  const caps = capabilitiesOf(role);
  const excluded = [
    ...(caps.includes('design.3d') ? BLENDER_UNSANDBOXED : []),
    ...(caps.includes('game.unity') ? unityUnsandboxed() : []),
  ];
  if (!excluded.length && !role.allowLocalBinding) return SANDBOX;
  return {
    ...SANDBOX,
    ...(excluded.length ? { excludedCommands: excluded } : {}),
    ...(role.allowLocalBinding ? {
      network: {
        allowLocalBinding: true,
        allowUnixSockets: [real(sandboxTmpDir())],
      },
      filesystem: { allowWrite: viteCacheDirs(cwd) },
    } : {}),
  };
}

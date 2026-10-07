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
 * лишняя дыра им не нужна.
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
  const blender = capabilitiesOf(role).includes('design.3d');
  if (!blender && !role.allowLocalBinding) return SANDBOX;
  return {
    ...SANDBOX,
    ...(blender ? { excludedCommands: BLENDER_UNSANDBOXED } : {}),
    ...(role.allowLocalBinding ? {
      network: {
        allowLocalBinding: true,
        allowUnixSockets: [real(sandboxTmpDir())],
      },
      filesystem: { allowWrite: viteCacheDirs(cwd) },
    } : {}),
  };
}

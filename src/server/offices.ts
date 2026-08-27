/**
 * Реестр офисов. Офис — это проект: своя рабочая директория, своя доска,
 * свои расходы и свой файл состояния. Раньше проект задавался переменной
 * окружения и менялся только перезапуском сервера.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { c } from './i18n';

export interface OfficeEntry {
  id: string;
  name: string;
  /** Рабочая директория команды. */
  projectDir: string;
  /** Где лежит состояние этого офиса. */
  stateFile: string;
  createdAt: number;
  lastOpenedAt: number;
  /**
   * Директорию завёл сам офис — значит, при первом открытии её можно
   * инициализировать как git-репозиторий. Чужую папку мы не трогаем.
   */
  initGit?: boolean;
  /**
   * Убран из списка. Запись остаётся в реестре намеренно: за ней закреплён
   * файл состояния, и если тот же проект заведут снова, доска и расходы
   * вернутся, а не начнутся с нуля. Ни папку проекта, ни файл состояния
   * скрытие не трогает.
   */
  hidden?: boolean;
}

interface Registry {
  version: 1;
  currentId: string;
  seq: number;
  offices: OfficeEntry[];
}

/**
 * Состояние офиса можно увести в другое место переменной окружения — этим
 * пользуются тесты. Реестр живёт рядом с ним, иначе тестовый прогон
 * переписывал бы список рабочих офисов.
 */
const DEFAULT_STATE_FILE = resolve(process.env.OFFICE_STATE_FILE ?? '.office/state.json');

let registry: Registry | null = null;
/** Куда пишется реестр. Задаётся при загрузке — см. loadRegistry. */
let FILE = resolve(dirname(DEFAULT_STATE_FILE), 'offices.json');

function write(): void {
  if (!registry) return;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (err) {
    console.log(c('offices.saveFailed', { error: (err as Error).message }));
  }
}

/**
 * Загрузить реестр. Если его нет — заводим первый офис на переданной
 * директории и отдаём ему уже существующий файл состояния: у тех, кто
 * работал до появления списка офисов, доска и расходы остаются на месте.
 */
export function loadRegistry(defaultProjectDir: string, stateFile = DEFAULT_STATE_FILE): Registry {
  if (registry) return registry;
  // Реестр ложится рядом с файлом состояния, а путь приходит аргументом,
  // а не читается из окружения на весь процесс: так проверки не переписывают
  // список рабочих офисов, и правило то же, что у store.ts.
  const stateAt = resolve(stateFile);
  FILE = resolve(dirname(stateAt), 'offices.json');
  if (existsSync(FILE)) {
    try {
      const data = JSON.parse(readFileSync(FILE, 'utf8')) as Registry;
      if (data.version === 1 && data.offices?.length) {
        registry = data;
        return registry;
      }
    } catch (err) {
      console.log(c('offices.listBroken', { error: (err as Error).message }));
    }
  }
  const first: OfficeEntry = {
    id: 'o-1',
    name: defaultProjectDir.split('/').filter(Boolean).pop() ?? c('offices.defaultName'),
    projectDir: defaultProjectDir,
    stateFile: stateAt,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
  registry = { version: 1, currentId: first.id, seq: 1, offices: [first] };
  write();
  return registry;
}

/** Список для клиента: скрытые офисы в него не попадают. */
export function offices(): OfficeEntry[] {
  return registry?.offices.filter((o) => !o.hidden) ?? [];
}

/** Текущий офис. null — реестр ещё не загружен (так живут юнит-проверки). */
export function currentOffice(): OfficeEntry | null {
  if (!registry) return null;
  return registry.offices.find((o) => o.id === registry!.currentId)
    ?? offices()[0] ?? registry.offices[0] ?? null;
}

/** Поиск по всему реестру, включая скрытые: id мог прийти из устаревшего списка. */
export function officeById(id: string): OfficeEntry | null {
  return registry?.offices.find((o) => o.id === id) ?? null;
}

export function setCurrent(id: string): OfficeEntry | null {
  const office = officeById(id);
  if (!office || !registry) return null;
  registry.currentId = id;
  office.lastOpenedAt = Date.now();
  write();
  return office;
}

/** Путь пользователь пишет руками, и «~/Projects/x» — обычная форма записи. */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * Завести новый офис.
 *
 * `mustExist` — путь пришёл от человека: тогда опечатка не должна молча
 * создавать пустую папку, о ней надо сказать. Со старта сервера офис
 * заводится без этого флага, и директорию мы создаём сами.
 */
export function createOffice(input: { name: string; projectDir: string; mustExist?: boolean }):
  { office: OfficeEntry; restored?: boolean } | { error: string } {
  if (!registry) return { error: c('offices.noRegistry') };
  if (!input.projectDir.trim()) return { error: c('offices.needDir') };
  const projectDir = resolve(expandHome(input.projectDir.trim()));
  const name = input.name.trim()
    || projectDir.split('/').filter(Boolean).pop()
    || c('offices.defaultName');

  const taken = registry.offices.find((o) => o.projectDir === projectDir);
  // Скрытый офис на том же пути — это тот же самый проект: возвращаем его
  // в список вместе с доской, а не заводим рядом пустой дубль.
  if (taken?.hidden) {
    taken.hidden = false;
    taken.name = name;
    write();
    return { office: taken, restored: true };
  }
  if (taken) return { error: c('offices.dirTaken', { name: taken.name }) };

  let ours = false;
  if (input.mustExist) {
    let dir: boolean;
    try {
      dir = statSync(projectDir).isDirectory();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        error: code === 'ENOENT'
          ? c('offices.dirMissing', { dir: projectDir })
          : c('offices.dirUnreadable', { dir: projectDir, error: (err as Error).message }),
      };
    }
    if (!dir) return { error: c('offices.notADir', { dir: projectDir }) };
  } else if (!existsSync(projectDir)) {
    try {
      mkdirSync(projectDir, { recursive: true });
      ours = true;
    } catch (err) {
      return { error: c('offices.createFailed', { dir: projectDir, error: (err as Error).message }) };
    }
  }

  // Файл состояния — ключ, по которому идёт запись на диск: два офиса с одним
  // путём затирали бы друг друга. Реестр правят и руками, поэтому занятый
  // номер пропускаем, а не полагаемся на то, что счётчик всегда свободен.
  const usedFiles = new Set(registry.offices.map((o) => resolve(o.stateFile)));
  const usedIds = new Set(registry.offices.map((o) => o.id));
  let stateFile: string;
  do {
    registry.seq += 1;
    stateFile = resolve(dirname(FILE), 'offices', `o-${registry.seq}.json`);
  } while (usedFiles.has(stateFile) || usedIds.has(`o-${registry.seq}`));

  const office: OfficeEntry = {
    id: `o-${registry.seq}`,
    name,
    projectDir,
    stateFile,
    createdAt: Date.now(),
    lastOpenedAt: 0,
    initGit: ours,
  };
  registry.offices.push(office);
  write();
  return { office };
}

/**
 * Найти офис по директории или завести его. Нужно на старте: переменная
 * окружения по-прежнему задаёт, с каким проектом открывается офис.
 */
export function ensureOffice(input: { name: string; projectDir: string }): OfficeEntry {
  const projectDir = resolve(input.projectDir);
  const found = registry?.offices.find((o) => o.projectDir === projectDir);
  if (found) {
    // Открываемый офис не может оставаться скрытым: иначе его не видно
    // в списке, из которого в него же предлагается вернуться.
    if (found.hidden) {
      found.hidden = false;
      write();
    }
    return found;
  }
  const made = createOffice({ ...input, projectDir });
  if ('office' in made) return made.office;
  // Директорию уже занял другой офис — открываем его, а не плодим дубль.
  const taken = registry?.offices.find((o) => o.projectDir === projectDir);
  return taken ?? currentOffice()!;
}

/** Инициализацию гита делают один раз — при первом открытии офиса. */
export function clearInitFlag(id: string): void {
  const office = officeById(id);
  if (!office?.initGit) return;
  office.initGit = false;
  write();
}

/** Переименовать офис. Возвращает причину отказа по-русски или null. */
export function renameOffice(id: string, name: string): string | null {
  const office = officeById(id);
  if (!office) return c('offices.notFound', { id });
  if (!name.trim()) return c('offices.needName');
  office.name = name.trim();
  write();
  return null;
}

/**
 * Убрать офис из списка. Файлы не трогаем: ни папку проекта, ни сохранение
 * доски — «убрать из списка» и «стереть работу» это разные действия, и
 * второго в офисе сознательно нет. Возвращает причину отказа или null.
 */
export function removeOffice(id: string): string | null {
  if (!registry) return c('offices.noRegistry');
  const office = officeById(id);
  if (!office || office.hidden) return c('offices.notFound', { id });
  if (office.id === registry.currentId) {
    return c('offices.openNow', { name: office.name });
  }
  if (offices().length <= 1) return c('offices.lastOne');
  office.hidden = true;
  write();
  return null;
}

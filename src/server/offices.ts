/**
 * Реестр офисов. Офис — это проект: своя рабочая директория, своя доска,
 * свои расходы и свой файл состояния. Раньше проект задавался переменной
 * окружения и менялся только перезапуском сервера.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

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
const STATE_FILE = resolve(process.env.OFFICE_STATE_FILE ?? '.office/state.json');
const FILE = resolve(dirname(STATE_FILE), 'offices.json');

let registry: Registry | null = null;

function write(): void {
  if (!registry) return;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
    renameSync(tmp, FILE);
  } catch (err) {
    console.log(`⚠️  Не удалось сохранить список офисов: ${(err as Error).message}`);
  }
}

/**
 * Загрузить реестр. Если его нет — заводим первый офис на переданной
 * директории и отдаём ему уже существующий файл состояния: у тех, кто
 * работал до появления списка офисов, доска и расходы остаются на месте.
 */
export function loadRegistry(defaultProjectDir: string): Registry {
  if (registry) return registry;
  if (existsSync(FILE)) {
    try {
      const data = JSON.parse(readFileSync(FILE, 'utf8')) as Registry;
      if (data.version === 1 && data.offices?.length) {
        registry = data;
        return registry;
      }
    } catch (err) {
      console.log(`⚠️  Список офисов не читается (${(err as Error).message}), начинаю заново`);
    }
  }
  const first: OfficeEntry = {
    id: 'o-1',
    name: defaultProjectDir.split('/').filter(Boolean).pop() ?? 'Офис',
    projectDir: defaultProjectDir,
    stateFile: STATE_FILE,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
  registry = { version: 1, currentId: first.id, seq: 1, offices: [first] };
  write();
  return registry;
}

export function offices(): OfficeEntry[] {
  return registry?.offices ?? [];
}

/** Текущий офис. null — реестр ещё не загружен (так живут юнит-проверки). */
export function currentOffice(): OfficeEntry | null {
  if (!registry) return null;
  return registry.offices.find((o) => o.id === registry!.currentId) ?? registry.offices[0] ?? null;
}

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
  { office: OfficeEntry } | { error: string } {
  if (!registry) return { error: 'Реестр офисов не загружен.' };
  if (!input.projectDir.trim()) return { error: 'Укажите путь к директории проекта.' };
  const projectDir = resolve(expandHome(input.projectDir.trim()));
  const name = input.name.trim() || projectDir.split('/').filter(Boolean).pop() || 'Офис';

  const taken = registry.offices.find((o) => o.projectDir === projectDir);
  if (taken) return { error: `Офис «${taken.name}» уже работает в этой директории.` };

  let ours = false;
  if (input.mustExist) {
    let dir: boolean;
    try {
      dir = statSync(projectDir).isDirectory();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        error: code === 'ENOENT'
          ? `Директория ${projectDir} не найдена. Создайте её или укажите другой путь.`
          : `Не удалось прочитать ${projectDir}: ${(err as Error).message}`,
      };
    }
    if (!dir) return { error: `${projectDir} — это файл, а не директория.` };
  } else if (!existsSync(projectDir)) {
    try {
      mkdirSync(projectDir, { recursive: true });
      ours = true;
    } catch (err) {
      return { error: `Не удалось создать ${projectDir}: ${(err as Error).message}` };
    }
  }

  registry.seq += 1;
  const office: OfficeEntry = {
    id: `o-${registry.seq}`,
    name,
    projectDir,
    stateFile: resolve(dirname(FILE), 'offices', `o-${registry.seq}.json`),
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
  if (found) return found;
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

/** Переименовать офис. */
export function renameOffice(id: string, name: string): boolean {
  const office = officeById(id);
  if (!office || !name.trim()) return false;
  office.name = name.trim();
  write();
  return true;
}

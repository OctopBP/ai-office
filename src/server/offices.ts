/**
 * Реестр офисов. Офис — это проект: своя рабочая директория, своя доска,
 * свои расходы и свой файл состояния. Раньше проект задавался переменной
 * окружения и менялся только перезапуском сервера.
 */
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { compareOffices, type OfficeIcon } from '../shared/types';
import { asLang, isLang, type Lang } from '../shared/i18n';
import { c } from './i18n';

/**
 * Как аватарка лежит в реестре — это не то же, что уезжает в веб. Браузеру мы
 * отдаём адрес (`OfficeIcon`), а здесь хранится, где взять файл:
 *
 * `emoji`  — сама строка;
 * `image`  — путь к файлу ВНУТРИ директории офиса, относительно `projectDir`;
 *            так иконку задают руками, указав картинку прямо в проекте;
 * `upload` — файл, который загрузили через настройки офиса: он лежит в
 *            служебной папке рядом с реестром (`iconsDir`), а не в проекте.
 *            Загруженная картинка — не часть проекта, и класть её в чужой
 *            репозиторий, где она попадёт в диффы и коммиты, неправильно.
 *
 * `version` у загрузки — отметка времени последней замены. Она уходит в адрес
 * картинки: без неё браузер показывал бы прежнюю аватарку после замены.
 */
export type StoredIcon =
  | { kind: 'emoji'; value: string }
  | { kind: 'image'; value: string }
  | { kind: 'upload'; file: string; version: number };

export interface OfficeEntry {
  id: string;
  name: string;
  /** Рабочая директория команды. */
  projectDir: string;
  /**
   * Аватарка офиса: эмодзи, картинка в его директории или загруженный файл
   * (см. `StoredIcon`). Поля нет — офис рисуется умолчанием.
   */
  icon?: StoredIcon;
  /** Где лежит состояние этого офиса. */
  stateFile: string;
  /**
   * Когда офис завели. Порядок списка считается по нему у всех офисов, кроме
   * расставленных руками (`compareOffices`), поэтому поле обязательное:
   * реестрам, заведённым до его появления, время проставляет миграция при
   * загрузке — см. `normalize`.
   */
  createdAt: number;
  /**
   * Место офиса в списке, расставленное человеком перетаскиванием
   * (`reorderOffice`). Поля нет — офис стоит по времени создания и уходит ниже
   * всех расставленных; так живёт и реестр, в котором офисы не двигали, и
   * только что заведённый офис. Миграции поле не требует по той же причине.
   *
   * Значения нормализуются на каждой перестановке (шаг `ORDER_STEP`), а не
   * дописываются по краям: в реестр смотрят руками, и список 10, 20, 30
   * читается, а 1, 0.5, 0.25 — нет.
   */
  order?: number;
  lastOpenedAt: number;
  /**
   * Директорию завёл сам офис — значит, при первом открытии её можно
   * инициализировать как git-репозиторий. Чужую папку мы не трогаем.
   */
  initGit?: boolean;
  /**
   * С кем офис откроется в первый раз: только с менеджером, а не с набором по
   * умолчанию. Ставит мастер нового офиса — кого нанимать, сказал план.
   * Снимается вместе с initGit после первого открытия.
   */
  initTeam?: 'manager-only';
  /**
   * Офис без проекта: корень заведён офисом в служебном месте (`defaultRoot`).
   * Меню подписывает такой офис «без проекта», а не путём.
   */
  noProject?: boolean;
  /**
   * Офис стоит на паузе: новая работа не начинается, пока человек не нажмёт ▶.
   *
   * Метка живёт здесь, а не в файле состояния офиса, по двум причинам. Реестр
   * пишется целиком на каждое изменение — значит переключение паузы доезжает
   * до диска сразу, а не через дебаунс отложенной записи состояния. И список
   * офисов показывает паузу у офисов, не поднятых в память: их файл состояния
   * ради одной метки читать не пришлось бы, а реестр и так уже в руках.
   *
   * Поля нет — офис не на паузе. Старые записи читаются так же, миграции им
   * не нужно.
   */
  paused?: boolean;
  /**
   * Офис убран в архив: проект больше не ведут. По архивному офису не идёт
   * никакая работа — он не поднимается в память ни на старте, ни фоном, не
   * берёт задач и не проводит ритуалов.
   *
   * Метка живёт в реестре по тем же причинам, что и пауза: пишется целиком и
   * сразу, и видна до того, как офис подняли, — а поднимать его как раз и не
   * надо. Поля нет — офис обычный; возврат из архива поле удаляет, поэтому
   * старым записям миграция не нужна.
   *
   * Архив — не пауза: признаки независимы, и снятие одного не трогает другой.
   * Пауза говорит «остановились и сейчас продолжим», архив — «этим проектом
   * больше не занимаемся».
   */
  archived?: boolean;
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
  /**
   * Язык интерфейса — один на всё приложение. Лежит здесь, а не в настройках
   * офиса, именно поэтому: переключение проекта не должно менять язык подписей
   * под руками у человека. Реестр для этого и подходит — он один на процесс,
   * читается раньше любого офиса и пишется целиком на каждое изменение.
   *
   * Поля нет — реестр заведён до разделения языков: значение ему проставляет
   * миграция при загрузке, забирая нынешнюю локаль открытого офиса
   * (см. `adoptUiLanguage`).
   */
  uiLanguage?: Lang;
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
 * Привести список реестра к постоянному порядку: сначала расставленные руками,
 * потом остальные от старого офиса к новому (`compareOffices`). Возвращает
 * true, если что-то поправили и файл надо переписать.
 *
 * Здесь же миграция записей без `createdAt`: реестр — обычный JSON, его
 * писали до появления поля и правят руками. Время такой записи берём из её
 * МЕСТА В ФАЙЛЕ — на миллисекунду позже предыдущей, — чтобы порядок, который
 * человек видел вчера, остался тем же, а не перескочил на случайный. Даты в
 * прошлом (1970-е) тут не страшны: они не показываются, по ним только
 * сортируют, а новые офисы всегда получают Date.now() и встают ниже.
 */
function normalize(data: Registry): boolean {
  let changed = false;
  let prev = 0;
  for (const office of data.offices) {
    const own = typeof office.createdAt === 'number' && Number.isFinite(office.createdAt)
      ? office.createdAt
      : null;
    if (own === null) {
      office.createdAt = prev + 1;
      changed = true;
    }
    prev = Math.max(prev, office.createdAt);
    // Ручной порядок из файла может оказаться не числом: реестр правят руками.
    // Мусор убираем, а не терпим, — `compareOffices` всё равно считает такой
    // офис нерасставленным, и поле в файле врало бы про порядок.
    if ('order' in office && !(typeof office.order === 'number' && Number.isFinite(office.order))) {
      delete office.order;
      changed = true;
    }
  }
  const before = data.offices.map((o) => o.id).join(',');
  data.offices.sort(compareOffices);
  // Файл держим в том же порядке, в каком список показывают: тогда «порядок
  // переживает перезапуск» видно прямо в реестре, а не только в коде.
  return changed || data.offices.map((o) => o.id).join(',') !== before;
}

/**
 * Язык интерфейса для реестра, у которого его ещё нет. Возвращает true, если
 * поле проставили и файл надо переписать.
 *
 * Миграция без сюрпризов: язык интерфейса берёт нынешнюю локаль офиса, с
 * которым работали, — того, что записан текущим. Читаем его файл состояния
 * напрямую, а не через состояние офиса: реестр загружается раньше, чем хоть
 * один офис поднят, и поднимать офис ради одной строки было бы дороже самой
 * миграции. Файла нет, он битый или языка в нём нет — берём язык запуска
 * (`OFFICE_LANG`), как это делает новый офис.
 *
 * Идемпотентность: годное значение в реестре мы не трогаем, поэтому второй
 * и десятый запуск ничего не меняют и файл не переписывают.
 */
function adoptUiLanguage(data: Registry): boolean {
  if (isLang(data.uiLanguage)) return false;
  const current = data.offices.find((o) => o.id === data.currentId) ?? data.offices[0];
  let fromOffice: unknown;
  if (current) {
    try {
      const saved = JSON.parse(readFileSync(resolve(current.stateFile), 'utf8')) as
        { settings?: { language?: unknown; chatLanguage?: unknown } };
      // Язык общения уже разделён — значит, сохранение новее миграции, и
      // интерфейсу правильнее взять его, а не осиротевшее старое поле.
      fromOffice = saved.settings?.chatLanguage ?? saved.settings?.language;
    } catch {
      fromOffice = undefined;
    }
  }
  data.uiLanguage = isLang(fromOffice) ? fromOffice : asLang(process.env.OFFICE_LANG);
  return true;
}

/**
 * Язык интерфейса: один на всё приложение, для всех офисов один и тот же.
 * Реестр ещё не загружен (так живут юнит-проверки) — отвечаем языком запуска.
 */
export function uiLanguage(): Lang {
  return asLang(registry?.uiLanguage ?? process.env.OFFICE_LANG);
}

/**
 * Сменить язык интерфейса. Возвращает true, если он правда стал другим, —
 * вызывающему это нужно, чтобы не рассылать событие на каждое повторное
 * нажатие той же кнопки. Чужое значение молча игнорируем: команда приходит
 * из браузера, и языка без словаря в реестре быть не должно.
 *
 * Пишем на диск сразу, тем же вызовом: это решение человека, и оно обязано
 * пережить перезапуск, даже если сервер погасят через секунду после нажатия.
 */
export function setUiLanguage(lang: unknown): boolean {
  if (!registry || !isLang(lang) || registry.uiLanguage === lang) return false;
  registry.uiLanguage = lang;
  write();
  return true;
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
        // Порядок чиним один раз, на входе: дальше он один и тот же и в
        // памяти, и в файле, и в списке, который уезжает в веб. Тем же заходом
        // достаётся язык интерфейса реестрам, заведённым до его появления.
        const fixed = normalize(registry);
        const adopted = adoptUiLanguage(registry);
        if (fixed || adopted) write();
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
  // Реестра не было, а файл состояния вполне мог остаться от запусков до
  // появления списка офисов: язык интерфейса берём из него, а не из умолчания.
  adoptUiLanguage(registry);
  write();
  return registry;
}

/**
 * Список для клиента: скрытые офисы в него не попадают.
 *
 * Порядок — тот же `compareOffices`, что и в вебе: ручная расстановка, потом
 * время создания. Не тот, в каком записи лежат в файле: сортируем на каждой
 * выдаче, хотя файл и так канонический, — порядок списка не должен зависеть
 * от того, куда лёг `push` нового офиса и не правил ли реестр человек. Скрытый
 * офис из списка выпадает, а вернувшись, встаёт на своё прежнее место сам
 * собой: ни `createdAt`, ни `order` скрытие не трогает.
 */
export function offices(): OfficeEntry[] {
  return [...(registry?.offices ?? [])].filter((o) => !o.hidden).sort(compareOffices);
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
/**
 * Корень офисов без проекта. Своя папка нужна и такому офису — журнал,
 * артефакты и OFFICE.md должны где-то лежать, — просто выбирает её не человек.
 */
export const defaultRoot = (): string => resolve(homedir(), 'Office');

export function expandHome(path: string): string {
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
export function createOffice(input: {
  name: string; projectDir: string; mustExist?: boolean; noProject?: boolean; initTeam?: 'manager-only';
}):
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
    ...(input.noProject ? { noProject: true } : {}),
    ...(input.initTeam ? { initTeam: input.initTeam } : {}),
  };
  registry.offices.push(office);
  // Новый офис встаёт последним, и ручного порядка ему не выдаём: офис без
  // `order` стоит ниже всех расставленных руками (`compareOffices`), то есть в
  // конце — и не влезает в середину списка, который человек только что
  // разложил. Сортируем всё равно: время создания можно поправить и руками,
  // а файл должен лежать в том же порядке, в каком список показывают.
  registry.offices.sort(compareOffices);
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
    // в списке, из которого в него же предлагается вернуться. С архивом то же
    // самое: сюда приходят по прямому указанию человека («открой офис вот
    // этого проекта»), а это и есть возвращение проекта в работу.
    if (found.hidden || found.archived) {
      found.hidden = false;
      delete found.archived;
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

/** Стоит ли офис на паузе по реестру. Записи нет или поля нет — не стоит. */
export function officePaused(id: string): boolean {
  return officeById(id)?.paused === true;
}

/**
 * Запомнить паузу офиса. Пишем на диск сразу, тем же вызовом: пауза — это
 * решение человека, и оно не должно потеряться, если сервер погасят через
 * секунду после нажатия.
 *
 * Снятая пауза стирает поле, а не кладёт `false`: «не на паузе» в реестре
 * выглядит одинаково у нового офиса и у старой записи, которая про паузу
 * ничего не знала.
 */
export function setOfficePaused(id: string, paused: boolean): void {
  const office = officeById(id);
  // Офиса в реестре нет — значит и запоминать некуда: так живут проверки,
  // которые поднимают состояние офиса без реестра вообще.
  if (!office || (office.paused === true) === paused) return;
  if (paused) office.paused = true;
  else delete office.paused;
  write();
}

/** Лежит ли офис в архиве по реестру. Записи нет или поля нет — не лежит. */
export function officeArchived(id: string): boolean {
  return officeById(id)?.archived === true;
}

/**
 * Убрать офис в архив или вернуть оттуда. Пишем на диск сразу, тем же вызовом
 * и по той же причине, что и паузу: это решение человека, и оно не должно
 * потеряться, если сервер погасят следом.
 *
 * Возврат стирает поле, а не кладёт `false`: «не в архиве» у нового офиса и у
 * записи, которая про архив ничего не знала, обязано выглядеть одинаково.
 *
 * Паузу не трогаем ни в ту, ни в другую сторону: признаки независимы, и офис,
 * убранный в архив с паузы, вернётся из него на паузе — таким, каким его
 * оставили.
 */
export function setOfficeArchived(id: string, archived: boolean): void {
  const office = officeById(id);
  // Офиса в реестре нет — запоминать некуда: так живут проверки, поднимающие
  // состояние офиса без реестра вообще.
  if (!office || (office.archived === true) === archived) return;
  if (archived) office.archived = true;
  else delete office.archived;
  write();
}

/** Инициализацию гита делают один раз — при первом открытии офиса. */
export function clearInitFlag(id: string): void {
  const office = officeById(id);
  if (!office?.initGit && !office?.initTeam) return;
  office.initGit = false;
  delete office.initTeam;
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
 * Шаг между значениями ручного порядка. Не единица — чтобы в реестр, который
 * читают и правят руками, можно было вписать офис между двумя соседями, не
 * перенумеровывая весь список.
 */
const ORDER_STEP = 10;

/**
 * Переставить офис в списке: `index` — место, считая от нуля и по ВИДИМОМУ
 * списку (тому, что человек перетаскивает мышью). Возвращает причину отказа на
 * языке офиса или null.
 *
 * Принимаем один офис и одно место, а не весь порядок списком: пока человек
 * тащит строку, офис может завестись сам — мастером в другой вкладке или самим
 * офисом, — и присланный целиком порядок его бы не знал. Одно перемещение
 * применяется к текущему списку сервера, поэтому незнакомый клиенту офис
 * просто остаётся на своём месте, а не теряется и не всплывает наверх.
 *
 * После перестановки порядок нормализуется У ВСЕХ записей, включая скрытые:
 * половина списка с ручным порядком, а половина без него означала бы, что
 * «поднять офис на одну строку» иногда перебрасывает его через весь список
 * (офис без `order` стоит ниже любого расставленного). Скрытому офису значение
 * тоже достаётся — тогда, вернувшись в список, он встанет между теми же
 * соседями, между которыми стоял, а не в конец.
 *
 * Идемпотентность здесь не случайность: место считается от списка БЕЗ самого
 * переставляемого офиса, поэтому «поставить туда, где он и стоит» даёт тот же
 * список и те же значения порядка.
 */
export function reorderOffice(id: string, index: number): string | null {
  if (!registry) return c('offices.noRegistry');
  const office = officeById(id);
  // Скрытый офис двигать нечем: в видимом списке его нет, и «место» для него
  // ничего не значит.
  if (!office || office.hidden) return c('offices.notFound', { id });
  if (typeof index !== 'number' || !Number.isFinite(index)) {
    return c('offices.orderBadIndex', { index: String(index) });
  }

  const rest = [...registry.offices].sort(compareOffices).filter((o) => o !== office);
  const visible = rest.filter((o) => !o.hidden);
  // Выход за края прижимаем к ближнему краю: перетащить строку ниже последней —
  // обычное движение мышью, а не ошибка, о которой стоит говорить человеку.
  const place = Math.max(0, Math.min(Math.trunc(index), visible.length));
  // Место в полном списке ищем по видимому соседу: скрытые офисы в счёте
  // позиций не участвуют, иначе убранный из списка проект сдвигал бы всё под
  // собой, оставаясь невидимым.
  const at = place < visible.length ? rest.indexOf(visible[place]) : rest.length;
  rest.splice(at, 0, office);
  rest.forEach((o, i) => { o.order = (i + 1) * ORDER_STEP; });
  // Файл держим в том же порядке, в каком список показывают.
  registry.offices.splice(0, registry.offices.length, ...rest);
  write();
  return null;
}

/**
 * Сколько символов помещается в аватарку. Считаем в кодовых точках, а не в
 * длине строки: семья из четырёх человечков — это один видимый символ и
 * одиннадцать единиц UTF-16, и отказывать в нём было бы странно. Запас в
 * восемь точек берёт флаги, тона кожи и составные эмодзи и при этом не даёт
 * положить в поле предложение.
 */
const ICON_EMOJI_MAX = 8;

/** Путь к картинке внутри проекта. Больше — это уже не путь, а мусор. */
const ICON_PATH_MAX = 256;

/** Что умеет показать браузер. Иконка — картинка, а не произвольный файл. */
const ICON_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

/**
 * Что принимаем загрузкой и с каким расширением кладём на диск. Набор уже,
 * чем ICON_EXT: там путь указывает человек и файл уже лежит на машине, а тут
 * байты приходят из сети — принимать имеет смысл только то, что мы умеем
 * узнать по содержимому (см. `looksLike`).
 */
const UPLOAD_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/** Список для сообщений об ошибке: чем ручка отвечает на «а что можно?». */
export const ICON_UPLOAD_TYPES = Object.keys(UPLOAD_TYPES);

/**
 * Потолок загружаемой картинки. Мегабайта хватает на аватарку с запасом:
 * рисуется она размером в пару десятков пикселей. Ограничение не про диск,
 * а про то, что ручка не должна становиться способом залить в офис что угодно.
 */
export const ICON_MAX_BYTES = 1024 * 1024;

/** Имя офиса попадает в имя файла, поэтому id проверяем, а не доверяем ему. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Куда складываются загруженные картинки: рядом с реестром и состояниями. */
export const iconsDir = (): string => resolve(dirname(FILE), 'icons');

/**
 * Похоже ли содержимое на заявленный тип. Заголовок запроса — слова клиента,
 * и верить им на слово значит положить в папку офиса что угодно под именем
 * `o-2.png`. Проверка грубая, по сигнатуре формата: отличить картинку от
 * архива и исполняемого файла её достаточно.
 */
function looksLike(ext: string, bytes: Buffer): boolean {
  if (ext === 'png') {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (ext === 'jpg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ext === 'webp') {
    return bytes.subarray(0, 4).toString('latin1') === 'RIFF'
      && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  }
  // SVG — текст: ищем корневой тег в начале файла, пропустив BOM, пролог XML
  // и комментарии. Дальше первого килобайта корневого тега не бывает.
  if (ext === 'svg') return /<svg[\s>]/i.test(bytes.subarray(0, 1024).toString('utf8'));
  return false;
}

/** Время последней правки файла — версия для адреса картинки. */
function mtimeOf(file: string): number {
  try {
    return Math.round(statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

/** Управляющие символы и переводы строк в аватарке не нужны никому. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Лежит ли путь внутри корня. Сам корень — не «внутри»: это папка, не файл. */
const inside = (root: string, path: string): boolean =>
  path !== root && `${path}${sep}`.startsWith(`${root}${sep}`);

/**
 * Куда смотрит иконка-картинка: абсолютный путь на диске. null — иконки нет,
 * она не картинка или путь ведёт за пределы офиса. Нужно HTTP-ручке, которая
 * отдаёт файл браузеру: правило «путь считается от директории офиса» должно
 * жить в одном месте, а не повторяться на каждой стороне.
 *
 * Проверка повторяется здесь намеренно, хотя сохранить дурной путь нельзя:
 * реестр — обычный JSON-файл, его правят руками, и отдавать по нему любой
 * файл с машины ручка не должна.
 */
export function officeIconFile(office: OfficeEntry): string | null {
  // Загруженную картинку искать негде, кроме служебной папки: имя файла в
  // реестре — только имя, любой путь в нём был бы дырой ровно такого же
  // размера, как «../» в пути к картинке проекта.
  if (office.icon?.kind === 'upload') {
    const name = office.icon.file;
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(name)) return null;
    const full = resolve(iconsDir(), name);
    try {
      return statSync(full).isFile() ? full : null;
    } catch {
      return null;
    }
  }
  if (office.icon?.kind !== 'image') return null;
  const root = resolve(office.projectDir);
  const full = resolve(root, office.icon.value);
  if (!inside(root, full)) return null;
  try {
    if (!statSync(full).isFile()) return null;
    return inside(realpathSync(root), realpathSync(full)) ? full : null;
  } catch {
    return null;
  }
}

/**
 * Адрес, по которому веб заберёт картинку офиса, — то самое значение, которое
 * уезжает в снимок как `icon.value`. null — иконки-картинки нет.
 *
 * Адрес относительный намеренно. В собранном офисе (`npm run office`) страница
 * и сервер — это один адрес на :3001, а в деве страницу отдаёт vite на :5173 и
 * проксирует `/api` на сервер (vite.config.ts). Абсолютный адрес пришлось бы
 * собирать из имени хоста, и он врал бы всем, кто зашёл не с localhost.
 *
 * `v` — версия файла. Браузер держит кеш картинок крепче, чем хотелось бы, и
 * без версии после замены аватарки в рейле висела бы прежняя.
 */
export function officeIconUrl(office: OfficeEntry): string | null {
  const file = officeIconFile(office);
  if (!file) return null;
  const version = office.icon?.kind === 'upload' ? office.icon.version : mtimeOf(file);
  return `/api/office-icon?office=${encodeURIComponent(office.id)}&v=${version}`;
}

/**
 * Иконка офиса для веба: эмодзи как есть, картинка — адресом. Одно место, где
 * хранимый вид превращается в контрактный, — иначе список офисов и снимок
 * состояния разошлись бы в форме значения.
 */
export function officeIconView(office: OfficeEntry): OfficeIcon | null {
  if (office.icon?.kind === 'emoji') return { kind: 'emoji', value: office.icon.value };
  const url = officeIconUrl(office);
  return url ? { kind: 'image', value: url } : null;
}

/**
 * Убрать загруженный файл иконки. Вызывается при любой смене аватарки: файл
 * нужен ровно до тех пор, пока на него смотрит реестр, а дальше это мусор в
 * служебной папке, который никто никогда не найдёт и не сотрёт.
 */
function dropUpload(office: OfficeEntry, keep?: string): void {
  if (office.icon?.kind !== 'upload' || office.icon.file === keep) return;
  const file = officeIconFile(office);
  if (file) rmSync(file, { force: true });
}

/**
 * Положить загруженную картинку в офис. Возвращает готовую для веба иконку
 * или отказ с причиной на языке офиса: `reason` нужен ручке, чтобы выбрать
 * код ответа, а текст — человеку.
 */
export function saveOfficeIcon(id: string, bytes: Buffer, contentType: string):
  { icon: OfficeIcon } | { error: string; reason: 'office' | 'type' | 'size' | 'content' | 'io' } {
  const office = officeById(id);
  if (!office) return { error: c('offices.notFound', { id }), reason: 'office' };
  if (!SAFE_ID.test(office.id)) {
    return { error: c('offices.iconBadOffice', { id: office.id }), reason: 'office' };
  }

  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  const ext = UPLOAD_TYPES[type];
  const allowed = Object.keys(UPLOAD_TYPES).join(', ');
  if (!ext) return { error: c('offices.iconBadType', { type: type || '—', list: allowed }), reason: 'type' };
  if (!bytes.length) return { error: c('offices.iconEmpty'), reason: 'content' };
  if (bytes.length > ICON_MAX_BYTES) {
    return {
      error: c('offices.iconTooBig', { max: Math.round(ICON_MAX_BYTES / 1024), got: Math.ceil(bytes.length / 1024) }),
      reason: 'size',
    };
  }
  if (!looksLike(ext, bytes)) return { error: c('offices.iconNotReally', { type }), reason: 'content' };

  const name = `${office.id}.${ext}`;
  const file = resolve(iconsDir(), name);
  try {
    mkdirSync(iconsDir(), { recursive: true });
    // Через временный файл: замену аватарки может застать запрос за ней, и
    // отдавать половину картинки не стоит.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
  } catch (err) {
    return { error: c('offices.iconWriteFailed', { path: file, error: (err as Error).message }), reason: 'io' };
  }

  // Прежний файл убираем после записи нового и только если он другой: png
  // поверх png — это то же имя, и удаление стёрло бы свежую картинку.
  dropUpload(office, name);
  office.icon = { kind: 'upload', file: name, version: Date.now() };
  write();
  return { icon: { kind: 'image', value: officeIconUrl(office)! } };
}

/**
 * Снять аватарку: офис возвращается к умолчанию (инициалы на подложке), а
 * загруженный файл стирается — хранить картинку, на которую никто не смотрит,
 * незачем. Возвращает причину отказа или null.
 */
export function clearOfficeIcon(id: string): string | null {
  return setOfficeIcon(id, null);
}

/**
 * Сменить аватарку офиса. `null` (и пустое значение внутри размеченного
 * объекта) — сброс к умолчанию. Возвращает причину отказа на языке офиса
 * или null, если всё сохранено.
 *
 * Путь к картинке кладём в реестр относительным: папку проекта переносят и
 * переименовывают, а иконка должна ехать вместе с ней.
 */
export function setOfficeIcon(id: string, icon: OfficeIcon | null): string | null {
  const office = officeById(id);
  if (!office) return c('offices.notFound', { id });

  const raw = typeof icon?.value === 'string' ? icon.value.trim() : '';
  if (!icon || !raw) {
    if (office.icon) {
      dropUpload(office);
      delete office.icon;
      write();
    }
    return null;
  }

  if (icon.kind === 'emoji') {
    if (CONTROL.test(raw)) return c('offices.iconBadChars');
    const points = [...raw].length;
    if (points > ICON_EMOJI_MAX) {
      return c('offices.iconTooLong', { max: ICON_EMOJI_MAX, got: points });
    }
    dropUpload(office);
    office.icon = { kind: 'emoji', value: raw };
    write();
    return null;
  }

  if (icon.kind === 'image') {
    if (CONTROL.test(raw)) return c('offices.iconBadChars');
    // В снимок картинка уходит адресом, а этой командой ждут путь к файлу.
    // Вернуть адрес обратно — частая и понятная путаница: говорим прямо, куда
    // идти, вместо «картинка должна лежать внутри директории офиса».
    if (raw.startsWith('/api/office-icon')) return c('offices.iconIsUrl');
    if (raw.length > ICON_PATH_MAX) {
      return c('offices.iconPathTooLong', { max: ICON_PATH_MAX });
    }
    // Путь пришёл из сети: «../» в нём — обычное дело, и разрешить его значит
    // отдать наружу любой файл на машине. Считаем от директории офиса и
    // проверяем, что не выбрались за неё.
    const root = resolve(office.projectDir);
    const full = resolve(root, raw);
    if (!inside(root, full)) return c('offices.iconOutside', { dir: root });
    if (!ICON_EXT.has(extname(full).toLowerCase())) {
      return c('offices.iconNotImage', { list: [...ICON_EXT].join(', ') });
    }
    let file: boolean;
    let real: string;
    try {
      file = statSync(full).isFile();
      // Проверка выше — строковая, а симлинк её проходит и ведёт куда угодно.
      // Разворачиваем настоящий путь и повторяем проверку уже по нему. Корень
      // тоже разворачиваем: сам проект вполне может лежать по ссылке.
      real = realpathSync(full);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT'
        ? c('offices.iconMissing', { path: full })
        : c('offices.iconUnreadable', { path: full, error: (err as Error).message });
    }
    if (!file) return c('offices.iconNotFile', { path: full });
    let realRoot = root;
    try {
      realRoot = realpathSync(root);
    } catch {
      // Корня нет или он не читается — значит, и картинки внутри него нет.
      return c('offices.iconOutside', { dir: root });
    }
    if (!inside(realRoot, real)) return c('offices.iconOutside', { dir: root });

    dropUpload(office);
    office.icon = { kind: 'image', value: relative(root, full).split(sep).join('/') };
    write();
    return null;
  }

  return c('offices.iconKind');
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

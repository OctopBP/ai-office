// Режим доступа живёт в общем контракте: его правит UI и наследует офис.
export type { PermissionMode } from '../shared/types';
import type { PermissionMode } from '../shared/types';
import { DEFAULT_LANG, type Lang } from '../shared/i18n';
import { t } from './i18n';

export interface Role {
  id: string;
  title: string;
  color: string;
  emoji: string;
  model: string;
  isManager: boolean;
  maxInstances: number;
  /** null — своего режима у роли нет, берётся режим офиса. */
  permissionMode: PermissionMode | null;
  /** Работать в отдельном git worktree на задачу (для ролей, меняющих код). */
  isolate: boolean;
  /**
   * Свой потолок ходов сессии. Пусто или null — берётся лимит офиса
   * (Settings.taskMaxTurns). Поле необязательное: у базовых ролей своего
   * лимита нет, он появляется только правкой из UI.
   */
  maxTurns?: number | null;
  /**
   * Ограничение набора встроенных инструментов. undefined — все.
   * Юристу и SMM оболочка не нужна: чем уже поверхность, тем меньше поводов
   * для подтверждений и меньше шансов сделать что-то необратимое.
   */
  tools?: string[];
  /** Папка для артефактов у ролей без изоляции веткой. */
  docsDir?: string;
  /**
   * Свой репозиторий роли. Пусто — общий репозиторий офиса.
   * Путь абсолютный либо относительный от директории офиса.
   *
   * Команда не обязана жить в одном репозитории: бэкенд может работать в
   * одном, фронтенд в другом, дизайнер — в третьем. Ветка задачи, её diff и
   * слияние идут в тот репозиторий, где роль работает.
   */
  repoDir?: string;
  /**
   * Пресет внешности из каталога спрайтов (`agent_p1`…`agent_p10`).
   * Пусто или нет поля — веб подбирает спрайт по id роли: у базовых ролей
   * своя нарисованная внешность, и подставлять им пресет незачем.
   */
  sprite?: string;
  /**
   * Роль убрана в архив. Архивная роль не показывается в найме и не
   * предлагается менеджеру, но остаётся в наборе офиса и находится по id:
   * roleId лежит в задачах, логах и сохранённых сотрудниках, и исчезни роль
   * совсем — история перестала бы читаться.
   */
  archived?: boolean;
  /** Дополнение к системному промпту исполнителя (специфика роли). */
  brief: string;
}

/**
 * Базовые роли без слов: цвет, модель, лимиты, инструменты и папка артефактов.
 *
 * Название и бриф сюда не входят — они лежат в словаре (`i18n/roles-*.ts`) и
 * подставляются по языку офиса. Иначе набор ролей был бы записан на одном
 * языке навсегда: бриф уезжает в системный промпт исполнителя, и русский
 * бриф в английском офисе означал бы агента, который отвечает не на том
 * языке, на котором с ним говорят.
 */
type RoleShape = Omit<Role, 'title' | 'brief'>;

const BASE_SHAPES: RoleShape[] = [
  {
    id: 'pm',
    color: '#f0b429',
    emoji: '📋',
    model: 'claude-opus-5',
    isManager: true,
    maxInstances: 1,
    permissionMode: 'auto',
    isolate: false,
  },
  {
    id: 'backend',
    color: '#3b82f6',
    emoji: '⚙️',
    model: 'claude-opus-5',
    isManager: false,
    maxInstances: 3,
    permissionMode: 'ask-risky',
    isolate: true,
  },
  {
    id: 'frontend',
    color: '#ec4899',
    emoji: '🎨',
    model: 'claude-sonnet-5',
    isManager: false,
    maxInstances: 3,
    permissionMode: 'ask-risky',
    isolate: true,
  },
  {
    id: 'design',
    color: '#a855f7',
    emoji: '🎨',
    model: 'claude-sonnet-5',
    isManager: false,
    maxInstances: 2,
    permissionMode: 'ask-risky',
    isolate: true,
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'],
    docsDir: 'docs/design',
  },
  {
    id: 'smm',
    color: '#14b8a6',
    emoji: '📣',
    model: 'claude-haiku-4-5',
    isManager: false,
    maxInstances: 2,
    permissionMode: 'ask-risky',
    isolate: true,
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'],
    docsDir: 'docs/smm',
  },
  {
    id: 'reviewer',
    color: '#f97316',
    emoji: '🔍',
    model: 'claude-sonnet-5',
    isManager: false,
    maxInstances: 1,
    permissionMode: 'ask-risky',
    isolate: true,
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite'],
    docsDir: 'docs/review',
  },
  {
    id: 'artist',
    color: '#eab308',
    emoji: '🖌',
    model: 'claude-sonnet-5',
    isManager: false,
    maxInstances: 1,
    permissionMode: 'ask-risky',
    isolate: true,
  },
  {
    id: 'artist3d',
    color: '#6366f1',
    emoji: '🧊',
    model: 'claude-sonnet-5',
    isManager: false,
    maxInstances: 1,
    permissionMode: 'ask-risky',
    isolate: true,
  },
  {
    id: 'legal',
    color: '#94a3b8',
    emoji: '⚖️',
    model: 'claude-sonnet-5',
    isManager: false,
    maxInstances: 1,
    permissionMode: 'ask-risky',
    isolate: true,
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'],
    docsDir: 'docs/legal',
  },
];

/** Базовая роль целиком: форма из кода плюс слова из словаря. */
const withWords = (shape: RoleShape, lang: Lang): Role => ({
  ...shape,
  ...(shape.tools ? { tools: [...shape.tools] } : {}),
  title: t(lang, `role.${shape.id}.title` as never),
  brief: t(lang, `role.${shape.id}.brief` as never),
});

/**
 * id роли менеджера. Менеджер есть в каждом офисе и ровно один: на нём
 * держится раздача задач, и второй такой же роли в наборе быть не может.
 */
export const MANAGER_ROLE_ID = 'pm';

/** id базовых ролей: занятые имена, даже если такой роли в офисе сейчас нет. */
export const BASE_ROLE_IDS: readonly string[] = BASE_SHAPES.map((r) => r.id);

/**
 * Кириллица в латиницу для id роли. Названия ролей пишут по-русски, а id
 * уезжает в имя ветки (`task/T-1`), в id сотрудника (`backend#1`) и в пути
 * worktree — там нужна латиница, и «Технический писатель» обязан превратиться
 * в `tehnicheskiy-pisatel`, а не в набор дефисов.
 */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Потолок длины id: он попадает в имена веток и директорий worktree. */
const ID_LIMIT = 24;

/** id, который не станет ничьим: сюда падают названия из одних символов. */
const FALLBACK_ID = 'role';

/**
 * id роли из её названия: строчная латиница, цифры и дефис — и ничего больше.
 * Символ «#» отсеивается вместе с остальными: он разделяет id роли и номер
 * сотрудника (`backend#1`), и роль с решёткой в id разорвала бы каждый такой
 * разбор.
 */
export function slugifyRoleId(title: string): string {
  let out = '';
  for (const ch of title.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (ch in TRANSLIT) out += TRANSLIT[ch];
    else out += '-';
  }
  const clean = out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, ID_LIMIT)
    // Обрезка по длине могла оставить дефис на конце — он там не нужен.
    .replace(/-+$/, '');
  return clean || FALLBACK_ID;
}

/**
 * Свободный id для новой роли. Занятыми считаются и роли этого офиса (включая
 * архивные: их id живёт в истории задач), и все базовые — иначе заведённая
 * руками роль «Ревьюер» перебила бы `reviewer`, который офис поднимает сам.
 */
export function newRoleId(title: string, taken: Iterable<string>): string {
  const busy = new Set<string>([...BASE_ROLE_IDS, ...taken]);
  const base = slugifyRoleId(title);
  if (!busy.has(base)) return base;
  for (let n = 2; ; n += 1) {
    // Суффикс приписываем к обрезанной основе, чтобы id не перерос потолок.
    const candidate = `${base.slice(0, ID_LIMIT - String(n).length - 1)}-${n}`;
    if (!busy.has(candidate)) return candidate;
  }
}

/**
 * Набор ролей по умолчанию на заданном языке — с него начинается новый офис.
 * Каждый вызов отдаёт свежие объекты: набор принадлежит офису и правится в
 * нём, а общий на процесс массив разъехался бы правками по чужим офисам.
 */
export const defaultRoles = (lang: Lang = DEFAULT_LANG): Role[] =>
  BASE_SHAPES.map((shape) => withWords(shape, lang));

/** Базовая роль по id на заданном языке. undefined — такой роли среди базовых нет. */
export const defaultRole = (id: string, lang: Lang = DEFAULT_LANG): Role | undefined => {
  const found = BASE_SHAPES.find((r) => r.id === id);
  return found ? withWords(found, lang) : undefined;
};

/**
 * Заготовка роли, которой нет среди базовых. Нужна восстановлению: набор
 * ролей лежит в файле состояния, и роль оттуда обязана подняться целиком,
 * даже если базовой пары у неё нет.
 */
export const blankRole = (id: string): Role => ({
  id,
  title: id,
  color: '#94a3b8',
  emoji: '🙂',
  model: 'claude-sonnet-5',
  isManager: false,
  maxInstances: 1,
  permissionMode: null,
  isolate: true,
  brief: '',
});

/**
 * Гарантировать менеджера в наборе ролей офиса. PM есть во всех офисах:
 * потерять его нельзя (без менеджера офис не с кем разговаривать), и
 * задвоить тоже — второй менеджер сломал бы и раздачу задач, и запрет на
 * увольнение. Свои настройки PM у офиса при этом остаются: общая только роль.
 */
export function withManagerRole(list: Role[], lang: Lang = DEFAULT_LANG): Role[] {
  const base = defaultRole(MANAGER_ROLE_ID, lang)!;
  const saved = list.find((r) => r.id === MANAGER_ROLE_ID);
  // Архивным PM быть не может: без менеджера офису не с кем разговаривать,
  // а признак архива мог приехать из правленого руками файла состояния.
  const manager: Role = {
    ...base, ...saved, id: MANAGER_ROLE_ID, isManager: true, archived: false,
  };
  // Менеджер идёт первым — в этом порядке роли показываются в UI и обходятся
  // при наборе штата, и офис без сохранения выглядит так же, как с ним.
  const rest = list
    .filter((r) => r.id !== MANAGER_ROLE_ID)
    .map((r) => (r.isManager ? { ...r, isManager: false } : r));
  return [manager, ...rest];
}

/**
 * Пользовательские правки ролей поверх базовых — формат сохранений до того,
 * как набор ролей переехал в состояние офиса. Читается только при
 * восстановлении такого файла: дальше офис хранит роли целиком.
 */
export type RoleOverrides = Record<string, Partial<Role>>;

/** Базовый набор с наложенными правками — миграция старых сохранений. */
export const rolesFromOverrides = (overrides: RoleOverrides = {}, lang: Lang = DEFAULT_LANG): Role[] =>
  defaultRoles(lang).map((r) => ({ ...r, ...(overrides[r.id] ?? {}) }));

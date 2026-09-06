// Режим доступа живёт в общем контракте: его правит UI и наследует офис.
export type { PermissionMode } from '../shared/types';
import type { PermissionMode, RoleEditable } from '../shared/types';
import { DEFAULT_LANG, type Lang } from '../shared/i18n';
import {
  defaultTeam, loadPackage, OFFICIAL_SCOPE, packageBrief, packageModel, packageTitle,
  type AgentPackage,
} from './packages';

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
   * для подтверждений и меньше шансов сделать что-то необратимое. Дизайнеру
   * она, наоборот, нужна — ею собирается канвас макетов (см. пакет роли).
   */
  tools?: string[];
  /**
   * Внешние MCP-серверы роли — id из каталога офиса (`server/mcp.ts`).
   * Роль из пакета получает список из его манифеста; у роли, заведённой
   * руками, поля может не быть — это «ничего не подключать».
   * Пустой массив значит то же самое, но как решение, а не как пробел.
   */
  mcp?: string[];
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
   * Внешность агента — идентификатор из `shared/looks.ts`. Пусто или нет
   * поля — веб подбирает внешность по id роли: у базовых ролей своя
   * нарисованная внешность, и подставлять им пресет незачем.
   */
  sprite?: string;
  /**
   * Роль убрана в архив. Архивная роль не показывается в найме и не
   * предлагается менеджеру, но остаётся в наборе офиса и находится по id:
   * roleId лежит в задачах, логах и сохранённых сотрудниках, и исчезни роль
   * совсем — история перестала бы читаться.
   */
  archived?: boolean;
  /**
   * Дополнение к системному промпту исполнителя (специфика роли). У роли из
   * пакета — вычисленный текст: бриф пакета плюс приписка из ссылки.
   */
  brief: string;
  /**
   * Пакет, из которого роль заведена, и разница с ним. Нет поля — роль
   * заведена руками или отвязана: она целиком лежит в сохранении и
   * обновлений пакета не получает.
   *
   * Роль с этим полем ВЫЧИСЛЯЕТСЯ: умолчания пакета + оверрайды + приписка.
   * Остальные поля в сохранении при этом тоже лежат — на случай, если
   * пакет с диска пропал: тогда роль поднимается из них, как обычная, а
   * ссылка ждёт, пока пакет вернётся.
   */
  package?: RoleLink;
}

/**
 * Поля роли, которые оверрайд может переопределить. Брифа здесь нет
 * намеренно: бриф пакета неприкосновенен, а своё дописывается в `briefExtra`.
 * Иначе первое же обновление пакета с новым брифом ставило бы человека перед
 * выбором «новый бриф или мои три абзаца» — и он остался бы на старом.
 */
export type LinkOverrides = Partial<Omit<RoleEditable, 'brief' | 'briefExtra'>>;

/**
 * Откуда пакет установлен: репозиторий, путь внутри него и коммит. Именно
 * коммит, а не тег: тег можно передвинуть, коммит — нет, и что проверялось,
 * то и стоит. Нет источника — пакет встроенный, лежит в репозитории офиса.
 */
export interface PackageSource {
  repo: string;
  path: string;
  commit: string;
}

export interface RoleLink {
  /** Имя пакета: `@office/backend`. */
  name: string;
  /** Версия пакета, по которой роль считалась в последний раз. */
  version: string;
  /** Откуда взят. Нет поля — встроенный пакет из `packages/`. */
  source?: PackageSource;
  /** Правки человека поверх умолчаний пакета — только то, что отличается. */
  overrides: LinkOverrides;
  /** Приписка к брифу пакета снизу. */
  briefExtra: string;
}

/** Поля, по которым считается разница роли с пакетом. */
export const OVERRIDABLE_KEYS: readonly (keyof LinkOverrides)[] = [
  'title', 'emoji', 'color', 'model', 'permissionMode', 'maxInstances', 'isolate',
  'maxTurns', 'repoDir', 'sprite', 'mcp',
];

/**
 * Значение поля в сравнимом виде: пустая строка, undefined и null — одно и
 * то же «не задано». Иначе `repoDir: ''` из формы считался бы оверрайдом
 * поверх `repoDir: undefined` из пакета, хотя оба значат «общий репозиторий».
 */
const comparable = (v: unknown): string =>
  JSON.stringify(v === undefined || v === '' ? null : v);

export const sameValue = (a: unknown, b: unknown): boolean => comparable(a) === comparable(b);

/**
 * Роль из пакета: умолчания манифеста, поверх — оверрайды ссылки, снизу к
 * брифу — приписка. Одна функция на заведение роли, восстановление из
 * сохранения и пересчёт после правки: роль с пакетом нигде не хранится как
 * итог, она всегда считается заново.
 */
export function roleFromPackage(pkg: AgentPackage, lang: Lang, id: string, link?: RoleLink): Role {
  const m = pkg.manifest;
  const ref: RoleLink = {
    name: pkg.name,
    version: pkg.version,
    ...(link?.source ? { source: { ...link.source } } : {}),
    overrides: { ...(link?.overrides ?? {}) },
    briefExtra: link?.briefExtra ?? '',
  };
  const base: Role = {
    id,
    title: packageTitle(pkg, lang),
    color: m.color,
    emoji: m.emoji,
    model: packageModel(pkg),
    isManager: m.manager,
    maxInstances: m.maxInstances,
    permissionMode: m.runtime.permissionMode,
    isolate: m.runtime.isolate,
    maxTurns: m.runtime.maxTurns,
    ...(m.runtime.tools ? { tools: [...m.runtime.tools] } : {}),
    mcp: [...m.runtime.mcp],
    ...(m.docsDir ? { docsDir: m.docsDir } : {}),
    ...(m.look ? { sprite: m.look } : {}),
    archived: false,
    brief: '',
    package: ref,
  };
  // Оверрайды кладём только по разрешённым полям: ссылка приезжает из
  // сохранения, которое правят руками, и `isManager: true` в ней сделал бы
  // второго менеджера мимо всех проверок.
  for (const key of OVERRIDABLE_KEYS) {
    const value = ref.overrides[key];
    if (value === undefined) continue;
    // Оверрайд, равный умолчанию, — не оверрайд: чистим, чтобы обновление
    // пакета доезжало туда, где человек ничего не менял.
    if (sameValue(value, base[key as keyof Role])) { delete ref.overrides[key]; continue; }
    (base as unknown as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
  }
  // Менеджера не переименовать: на этой роли держится раздача задач.
  if (base.isManager) { base.title = packageTitle(pkg, lang); delete ref.overrides.title; }
  const brief = packageBrief(pkg, lang);
  const extra = ref.briefExtra.trim();
  base.brief = extra ? (brief ? `${brief}\n\n${extra}` : extra) : brief;
  return base;
}

/**
 * id роли менеджера. Менеджер есть в каждом офисе и ровно один: на нём
 * держится раздача задач, и второй такой же роли в наборе быть не может.
 */
export const MANAGER_ROLE_ID = 'pm';

/** Имя нашего пакета по id базовой роли: `backend` → `@office/backend`. */
export const basePackageName = (id: string): string => `${OFFICIAL_SCOPE}/${id}`;

/** id роли по имени пакета: последний сегмент. `@alice/lawyer` → `lawyer`. */
export const roleIdFor = (name: string): string => slugifyRoleId(name.split('/').pop() ?? name);

/**
 * id базовых ролей: занятые имена, даже если такой роли в офисе сейчас нет.
 * Считаются по каталогу по умолчанию, а не по константе: набор — это
 * пакеты на диске.
 */
export const baseRoleIds = (): string[] => defaultTeam().map(roleIdFor);

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
  const busy = new Set<string>([...baseRoleIds(), ...taken]);
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
 * Это наши пакеты из каталога по умолчанию (`packages/default-office.json`),
 * каждый — роль без оверрайдов. Каждый вызов читает диск и отдаёт свежие
 * объекты: набор принадлежит офису и правится в нём, а общий на процесс
 * массив разъехался бы правками по чужим офисам.
 */
export function defaultRoles(lang: Lang = DEFAULT_LANG): Role[] {
  const out: Role[] = [];
  const seen = new Set<string>();
  for (const name of defaultTeam()) {
    const pkg = loadPackage(name);
    if (!pkg) continue;
    const id = roleIdFor(name);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(roleFromPackage(pkg, lang, id));
  }
  return out;
}

/**
 * Базовая роль по id на заданном языке: роль из нашего пакета `@office/<id>`
 * без оверрайдов. undefined — такого пакета нет.
 */
export const defaultRole = (id: string, lang: Lang = DEFAULT_LANG): Role | undefined => {
  const pkg = loadPackage(basePackageName(id));
  return pkg ? roleFromPackage(pkg, lang, id) : undefined;
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
  // Пакета менеджера может не оказаться (каталог пакетов увели переменной
  // окружения в пустую папку) — офис всё равно обязан подняться с менеджером.
  const base = defaultRole(MANAGER_ROLE_ID, lang)
    ?? { ...blankRole(MANAGER_ROLE_ID), title: 'PM', emoji: '📋', isManager: true, isolate: false };
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
  // Ссылку на пакет снимаем: такая роль пойдёт через привязку из сохранения
  // (state.ts, linkFromSave), и правки человека станут разницей с пакетом.
  // Оставь ссылку — офис поверил бы её пустым оверрайдам и правки потерял.
  defaultRoles(lang).map(({ package: _link, ...r }) => ({ ...r, ...(overrides[r.id] ?? {}) }));

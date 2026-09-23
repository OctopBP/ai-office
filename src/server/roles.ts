import type { ProviderId } from '../shared/providers';
// Режим доступа живёт в общем контракте: его правит UI и наследует офис.
export type { PermissionMode } from '../shared/types';
import type { PermissionMode, RoleEditable } from '../shared/types';
import { DEFAULT_LANG, type Lang } from '../shared/i18n';
import { ROLE_TITLE_LIMIT } from '../shared/types';
import type { Capability } from '../shared/workflow';
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
  provider?: ProviderId;
  isManager: boolean;
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
  /**
   * Папка для артефактов документной роли — и одновременно её клетка: сессия
   * поднимается прямо в ней, и песочница не пускает запись никуда больше
   * (`agents.ts`, сборка сессии задачи и шага процесса). Рабочая копия при
   * этом видна на чтение.
   *
   * Поэтому у роли, которая правит КОД, этого поля быть не должно: писать в
   * свою копию, коммитить в свою ветку и разводить конфликт из такой клетки
   * нельзя — именно это и делало ревьюера read-only (T-84).
   */
  docsDir?: string;
  /**
   * Что роль умеет — словарь `CAPABILITIES` (spec процессов §5). У роли из
   * пакета — из манифеста; у заведённой руками поля нет, и способности
   * выводятся из инструментов (`capabilitiesOf`).
   */
  capabilities?: Capability[];
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
  /**
   * Какая это по счёту роль из этого пакета в офисе. 1 или нет поля —
   * первая. Номер уезжает в название («Бэкенд 2»), чтобы двух одинаковых
   * сотрудников можно было различить в списке, и живёт в ссылке, а не в
   * названии: название пакета переводится вместе с языком офиса, а номер —
   * нет. Человек, переименовавший сотрудника, кладёт своё название в
   * оверрайды, и оно сильнее.
   */
  copy?: number;
}

/** Название роли с номером копии: вторая и следующие подписаны номером. */
export const copyTitle = (title: string, copy: number | undefined): string =>
  (copy && copy > 1 ? `${title} ${copy}` : title);

/** Поля, по которым считается разница роли с пакетом. */
export const OVERRIDABLE_KEYS: readonly (keyof LinkOverrides)[] = [
  'title', 'emoji', 'color', 'model', 'provider', 'permissionMode', 'isolate',
  'maxTurns', 'repoDir', 'sprite', 'mcp', 'capabilities',
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
  // Команда — не роль: из неё нанимают участников, а не её саму.
  if (m.kind !== 'agent') throw new Error(`${pkg.name} is a team, not an agent`);
  const ref: RoleLink = {
    name: pkg.name,
    version: pkg.version,
    ...(link?.source ? { source: { ...link.source } } : {}),
    overrides: { ...(link?.overrides ?? {}) },
    briefExtra: link?.briefExtra ?? '',
    ...(link?.copy && link.copy > 1 ? { copy: link.copy } : {}),
  };
  const base: Role = {
    id,
    title: copyTitle(packageTitle(pkg, lang), ref.copy),
    color: m.color,
    emoji: m.emoji,
    model: packageModel(pkg),
    provider: m.runtime.engine,
    isManager: m.manager,
    permissionMode: m.runtime.permissionMode,
    isolate: m.runtime.isolate,
    maxTurns: m.runtime.maxTurns,
    ...(m.runtime.tools ? { tools: [...m.runtime.tools] } : {}),
    mcp: [...m.runtime.mcp],
    ...(m.docsDir ? { docsDir: m.docsDir } : {}),
    ...(m.capabilities.length ? { capabilities: [...m.capabilities] } : {}),
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

/**
 * Способности роли. Явные — из пакета; иначе по тому, чем роль работает:
 * своя ветка и оболочка — пишет код; папка документов — пишет документы;
 * веб-поиск — ищет; менеджер — планирует и подводит итоги.
 */
export function capabilitiesOf(role: Pick<Role, 'capabilities' | 'isolate' | 'tools' | 'docsDir' | 'isManager'>): Capability[] {
  if (role.capabilities?.length) return [...role.capabilities];
  if (role.isManager) return ['plan', 'summarize'];
  const caps: Capability[] = [];
  const has = (tool: string) => !role.tools || role.tools.includes(tool);
  if (role.isolate && !role.docsDir && has('Bash') && has('Edit')) caps.push('code.write');
  if (role.docsDir) caps.push('docs.write');
  if (has('WebSearch')) caps.push('research.web');
  return caps;
}

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
 * Свободное название для ещё одного такого же сотрудника: «Аналитик 2».
 * Названия в офисе не повторяются — по ним человек различает людей в списке,
 * а менеджер выбирает исполнителя. Хвостовой номер у исходного названия
 * снимается, чтобы копия копии не звалась «Аналитик 2 2».
 */
export function newRoleTitle(title: string, taken: Iterable<string>): string {
  const busy = new Set([...taken].map((x) => x.trim().toLowerCase()));
  const base = (title.replace(/\s+\d+$/, '').trim() || title.trim()).slice(0, ROLE_TITLE_LIMIT - 4);
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!busy.has(candidate.toLowerCase())) return candidate;
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
    if (!pkg || pkg.manifest.kind !== 'agent') continue;
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
  return pkg && pkg.manifest.kind === 'agent' ? roleFromPackage(pkg, lang, id) : undefined;
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
  permissionMode: null,
  isolate: true,
  brief: '',
});

/**
 * Прежние умолчания цвета по пакетам: слева пакет, справа цвет, которым роль
 * из него красилась до переезда на единую палитру (`--accent-1..8` в
 * tokens.css). Манифест влияет только на новый найм — у роли, нанятой раньше,
 * старый цвет лежит в состоянии офиса и сам собой не обновится.
 *
 * Сверяем именно умолчание СВОЕГО пакета, а не «любой старый цвет»: по одному
 * значению не отличить застрявшее умолчание бэкенда от бэкенда, которого
 * владелец руками покрасил в оранжевый ревьюера, — а перекрашивать заданное
 * руками нельзя.
 */
const LEGACY_PACKAGE_COLOR: Readonly<Record<string, string>> = {
  [`${OFFICIAL_SCOPE}/backend`]: '#3b82f6',
  [`${OFFICIAL_SCOPE}/dev-team`]: '#3b82f6',
  [`${OFFICIAL_SCOPE}/reviewer`]: '#f97316',
  [`${OFFICIAL_SCOPE}/artist`]: '#eab308',
  [`${OFFICIAL_SCOPE}/smm`]: '#14b8a6',
};

/**
 * Прежний набор цветов целиком: старое значение → цвет палитры. Нужен роли
 * без пакета — своей роли офиса и форку базовой с переписанным брифом: пакета,
 * с чьим умолчанием можно сверить, у неё нет, и единственный признак «цвет не
 * выбран руками, а достался от старого набора» — точное совпадение значения.
 */
const LEGACY_ROLE_COLORS: Readonly<Record<string, string>> = {
  '#3b82f6': '#2f7bf6',
  '#f97316': '#ea580c',
  '#eab308': '#f0b429',
  '#14b8a6': '#0d9488',
};

/**
 * Цвет роли, переведённый на единую палитру. `packageName` — пакет, из
 * которого роль заведена: у него сверяется только его собственное прежнее
 * умолчание. Цвет, которого в таблицах нет, возвращается как есть — в том
 * числе уже переведённый, поэтому повторный запуск ничего не меняет.
 */
export function paletteColor(color: string, packageName?: string): string {
  const key = color.trim().toLowerCase();
  if (packageName && LEGACY_PACKAGE_COLOR[packageName] !== key) return color;
  return LEGACY_ROLE_COLORS[key] ?? color;
}

/**
 * Смена поколения модели: слева id, застрявший в состоянии офиса, справа тот,
 * на который офис переводит. Роль из пакета модель называет алиасом (`opus`), и
 * ей хватило бы смены алиаса в `shared/models.ts` — но у роли, нанятой раньше,
 * в сохранении лежит уже разрешённый полный id, и сам собой он не обновится.
 *
 * Таблица только для смены поколения: модель, которую человек вписал руками и
 * которой в таблице нет, остаётся как есть.
 */
const LEGACY_MODELS: Readonly<Record<string, string>> = {
  'claude-fable-5': 'claude-fable-5-1',
  'claude-opus-5': 'claude-opus-5-5',
  'claude-opus-4-8': 'claude-opus-5-5',
  'claude-opus-4-7': 'claude-opus-5-5',
  'claude-opus-4-6': 'claude-opus-5-5',
  'claude-opus-4-5': 'claude-opus-5-5',
  'claude-opus-4-1': 'claude-opus-5-5',
  'claude-opus-4-0': 'claude-opus-5-5',
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'claude-sonnet-4-5': 'claude-sonnet-5',
  'claude-sonnet-4-0': 'claude-sonnet-5',
  'claude-3-7-sonnet-latest': 'claude-sonnet-5',
  'claude-3-5-haiku-latest': 'claude-haiku-4-5',
};

/**
 * Модель роли, переведённая на нынешнее поколение. Id, которого в таблице нет,
 * возвращается как есть — в том числе уже переведённый, поэтому повторный
 * запуск ничего не меняет.
 */
export function currentModel(model: string): string {
  return LEGACY_MODELS[model.trim()] ?? model;
}

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

import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { Lang } from '../shared/i18n';
import { OFFICE_COLORS, type Subproject, type SubprojectKind, type SubprojectView, type TaskStatus } from '../shared/types';
import { capabilitiesOf, type Role } from './roles';
import { t } from './i18n';

/**
 * Подпроекты — зоны ответственности офиса (docs/design/subprojects/spec.md).
 * Здесь модель без состояния: пути зон, чтение из сохранения, вид для веба и
 * миграция с «репозитория роли». Хранит подпроекты `OfficeState`.
 */

/**
 * Разовая миграция «репозиторий роли → repo-зона» (§7). Отметка лежит в
 * `roleMigrations`, но сама миграция идемпотентна по содержимому и идёт на
 * каждой загрузке: вернул кто-то `repoDir` руками — разберётся тем же правилом.
 */
export const SUBPROJECTS_MIGRATION = 'subprojects-from-repoDir';

/** id зоны в сохранении: латиница, цифры и дефис. */
const SUBPROJECT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Статусы, после которых задача закрыта: зону такой задачи не пересчитываем. */
const CLOSED: readonly TaskStatus[] = ['done', 'failed', 'cancelled'];

/** Статусы задачи, которая ещё не стартовала: её репозиторий не зафиксирован. */
const UNSTARTED: readonly TaskStatus[] = ['planned', 'backlog'];

/**
 * Слаг зоны из пути — тот же, что у круга правил `repo:<слаг>` (rules.ts).
 * Миграция обязана выдать ровно этот id: тогда круг правил репозитория и
 * зона, заведённая на нём, называются одинаково, и `RULES.md` не переезжает.
 */
export const zoneSlug = (dir: string): string =>
  basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'repo';

/**
 * Абсолютный путь из строки корня. Пусто — директория офиса; относительный
 * считается от неё. Ровно то же правило, что у прежнего `resolveRepoDir`.
 */
export function resolveRoot(projectDir: string, dir: string | null | undefined): string {
  const clean = dir?.trim();
  if (!clean) return projectDir;
  return isAbsolute(clean) ? resolve(clean) : resolve(projectDir, clean);
}

/** Репозиторий, где живут ветки задач зоны: у папки — репозиторий офиса. */
export const zoneRepo = (sub: Subproject, projectDir: string): string =>
  (sub.kind === 'repo' ? resolveRoot(projectDir, sub.root) : projectDir);

/** Абсолютный корень зоны: у repo совпадает с репозиторием. */
export const zonePath = (sub: Subproject, projectDir: string): string =>
  (sub.kind === 'repo' ? resolveRoot(projectDir, sub.root) : resolve(projectDir, sub.root));

/**
 * Единственная существующая зона роли — или null: роль не закреплена, закреплена
 * за несколькими зонами или её единственная зона пропала из сохранения.
 */
export function soleZone(role: Pick<Role, 'subprojects' | 'isManager'>, subs: readonly Subproject[]): Subproject | null {
  if (role.isManager) return null;
  const ids = role.subprojects ?? [];
  if (ids.length !== 1) return null;
  return subs.find((s) => s.id === ids[0]) ?? null;
}

/**
 * Рабочая папка роли вне задачи (§2.3): совещание, разговор, консультация,
 * описание состава. Одна зона — её корень; несколько, ни одной или зона
 * пропала — корень офиса.
 */
export function roleWorkdir(
  role: Pick<Role, 'subprojects' | 'isManager'> | null | undefined,
  subs: readonly Subproject[],
  projectDir: string,
): string {
  const zone = role ? soleZone(role, subs) : null;
  return zone ? zonePath(zone, projectDir) : projectDir;
}

/**
 * Репозиторий задачи (§2.3): null — офис, folder — тоже офис, repo — свой.
 * Зоны с таким id нет (битое сохранение) — офис: дальше его остановит допуск.
 */
export function taskRepoDir(
  subprojectId: string | null | undefined,
  subs: readonly Subproject[],
  projectDir: string,
): string {
  const zone = subprojectId ? subs.find((s) => s.id === subprojectId) : undefined;
  return zone ? zoneRepo(zone, projectDir) : projectDir;
}

// ---------- допуск (§3) ----------

/** То, что допуску нужно от офиса: зоны, рабочие роли, язык. OfficeState подходит как есть. */
export interface AdmitScope {
  subprojects(): Subproject[];
  workerRoles(): Role[];
  lang(): Lang;
}

/**
 * Может ли роль взять задачу этой зоны (§3.1). Роль без закрепления — любую.
 * Закреплённая — только задачу своих зон; задачу «весь проект» (null) —
 * никогда: сквозная работа меняет чужой код по определению. В офисе без
 * подпроектов закреплений нет, и допуск всегда истина.
 */
export function admits(role: Pick<Role, 'subprojects' | 'isManager'>, subprojectId: string | null | undefined): boolean {
  if (role.isManager) return false;
  const own = role.subprojects ?? [];
  if (!own.length) return true;
  return !!subprojectId && own.includes(subprojectId);
}

/** Имя зоны для текста: имя из списка, а пропавшая — её id. */
const zoneName = (subs: readonly Subproject[], id: string): string =>
  subs.find((s) => s.id === id)?.name ?? id;

/** Роль словами: «frontend (Фронтенд)». */
const roleLabel = (role: Pick<Role, 'id' | 'title'>): string =>
  (role.title && role.title !== role.id ? `${role.id} (${role.title})` : role.id);

/** Рабочие роли офиса, которым по силам задача этой зоны. */
export function admittedRoles(scope: AdmitScope, subprojectId: string | null | undefined): Role[] {
  return scope.workerRoles().filter((r) => admits(r, subprojectId));
}

/**
 * Почему роль не может взять задачу — словами для менеджера, ленты и
 * карточки. null — может. Отказ всегда называет, кому зона по силам: так
 * менеджер переназначит задачу, а не попросит нанять ещё одного.
 */
export function admitProblem(
  scope: AdmitScope,
  role: Pick<Role, 'id' | 'title' | 'subprojects' | 'isManager'>,
  task: { subprojectId?: string | null },
): string | null {
  const lang = scope.lang();
  const subs = scope.subprojects();
  const zone = task.subprojectId ?? null;
  if (role.isManager) return t(lang, 'subprojects.admit.manager');
  // Зоны нет (правили сохранение руками) — задачу не берёт никто: репозиторий
  // и граница правок у неё не определены.
  if (zone && !subs.some((s) => s.id === zone)) return t(lang, 'subprojects.admit.unknownZone', { zone });
  if (admits(role, zone)) return null;
  const others = admittedRoles(scope, zone).map(roleLabel);
  const who = others.length ? others.join(', ') : t(lang, 'subprojects.admit.nobody');
  if (zone === null) {
    return t(lang, 'subprojects.admit.wholeProject', {
      role: roleLabel(role),
      zones: (role.subprojects ?? []).map((id) => zoneName(subs, id)).join(', '),
      who,
    });
  }
  return t(lang, 'subprojects.admit.otherZone', { role: roleLabel(role), zone: zoneName(subs, zone), who });
}

/**
 * Зона задачи из слов менеджера (§6.1). `wanted`: undefined или '' — вывести
 * из роли; `none` — явно «весь проект»; иначе id зоны. Пусто: одна зона роли —
 * она, несколько — отказ «укажи зону», ни одной — «весь проект». Названная
 * зона проверяется на существование (отказ со списком зон) и допуск роли
 * (отказ из admitProblem — с перечнем ролей, которым зона по силам).
 */
export function zoneForRole(
  scope: AdmitScope,
  role: Pick<Role, 'id' | 'title' | 'subprojects' | 'isManager'>,
  wanted: string | null | undefined,
): { zone: string | null } | { error: string } {
  const lang = scope.lang();
  const subs = scope.subprojects();
  const raw = wanted?.trim() ?? '';
  let zone: string | null;
  if (raw === 'none') zone = null;
  else if (raw) {
    if (!subs.some((s) => s.id === raw)) {
      const zones = subs.length ? subs.map((s) => s.id).join(', ') : '—';
      return { error: t(lang, 'subprojects.zone.unknown', { zone: raw, zones }) };
    }
    zone = raw;
  } else {
    const own = role.isManager ? [] : role.subprojects ?? [];
    if (own.length > 1) {
      return { error: t(lang, 'subprojects.zone.ambiguous', { role: roleLabel(role), zones: own.join(', ') }) };
    }
    zone = own[0] ?? null;
  }
  const problem = admitProblem(scope, role, { subprojectId: zone });
  return problem ? { error: problem } : { zone };
}

/** Допуску ревьюера нужен ещё поиск роли по id. OfficeState подходит как есть. */
export interface ReviewerScope extends AdmitScope {
  role(id: string): Role | undefined;
}

/**
 * Ревьюер задачи (§3.2, строка «Ревью»). Допуск проверяется в обеих ветках:
 * базовая `reviewer` берётся, только если она жива и допущена к зоне задачи;
 * иначе — первая рабочая роль с `code.review`, допущенная к зоне. Ревьюеров
 * нет вовсе — `problem: null` (прежний отказ «роли ревьюера нет»); есть, но
 * ни один не допущен — причина словами, чтобы конвейер встал не молча.
 */
export function reviewerFor(
  scope: ReviewerScope, task: { subprojectId?: string | null },
): { role: Role; problem: null } | { role: null; problem: string | null } {
  const zone = task.subprojectId ?? null;
  const base = scope.role('reviewer');
  const live = base && !base.archived && !base.isManager ? base : undefined;
  if (live && admits(live, zone)) return { role: live, problem: null };
  const spare = scope.workerRoles().filter((r) => capabilitiesOf(r).includes('code.review'));
  const fit = spare.find((r) => admits(r, zone));
  if (fit) return { role: fit, problem: null };
  const first = live ?? spare[0];
  if (!first) return { role: null, problem: null };
  const why = admitProblem(scope, first, task) ?? '';
  return { role: null, problem: t(scope.lang(), 'subprojects.admit.noReviewer', { problem: why }) };
}

/** Строковый список из сохранения без мусора и повторов. */
const stringList = (value: unknown): string[] | undefined =>
  (Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean))]
    : undefined);

/**
 * Подпроекты из сохранения. Файл правят руками: запись без id, вида или корня
 * поднимать не из чего, а вторую с тем же id — нельзя, иначе задачи зоны
 * разъехались бы по двум корням.
 */
export function sanitizeSubprojects(raw: unknown): Subproject[] {
  const clean: Subproject[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Partial<Subproject>;
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    const root = typeof s.root === 'string' ? s.root.trim() : '';
    if (!SUBPROJECT_ID_RE.test(id) || seen.has(id)) continue;
    if (s.kind !== 'folder' && s.kind !== 'repo') continue;
    if (!root) continue;
    seen.add(id);
    const checks = stringList(s.mergeChecks);
    const shared = stringList(s.sharedPaths);
    clean.push({
      id,
      name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : id,
      kind: s.kind,
      root: s.kind === 'folder' ? root.replace(/^\/+|\/+$/g, '') : root,
      summary: typeof s.summary === 'string' ? s.summary : '',
      color: typeof s.color === 'string' && (OFFICE_COLORS as readonly string[]).includes(s.color)
        ? s.color : OFFICE_COLORS[clean.length % OFFICE_COLORS.length],
      ...(checks ? { mergeChecks: checks } : {}),
      ...(s.kind === 'folder' && shared ? { sharedPaths: shared } : {}),
      createdAt: typeof s.createdAt === 'number' && Number.isFinite(s.createdAt) ? s.createdAt : 0,
    });
  }
  return clean;
}

/** Закрепление роли из сохранения: строки без повторов; пусто — нет поля. */
export function sanitizeRoleZones(value: unknown): string[] | undefined {
  const list = stringList(value);
  return list && list.length ? list : undefined;
}

/**
 * Что с зоной не так — или null. Считается синхронно и дёшево, на каждый
 * снимок: папки нет, путь не корень git (нет `.git`), корни пересеклись.
 */
export function zoneProblem(sub: Subproject, subs: readonly Subproject[], projectDir: string, lang: Lang): string | null {
  const path = zonePath(sub, projectDir);
  if (sub.kind === 'folder' && (sub.root.split('/').includes('..') || isAbsolute(sub.root))) {
    return t(lang, 'subprojects.problem.badRoot', { root: sub.root });
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return t(lang, 'subprojects.problem.missing', { path });
  }
  if (sub.kind === 'repo') {
    if (path === projectDir) return t(lang, 'subprojects.problem.officeRepo');
    if (!existsSync(resolve(path, '.git'))) return t(lang, 'subprojects.problem.notGit', { path });
  }
  const within = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`);
  const clash = subs.find((o) => {
    if (o.id === sub.id) return false;
    const other = zonePath(o, projectDir);
    return within(path, other) || within(other, path);
  });
  return clash ? t(lang, 'subprojects.problem.overlap', { other: clash.name }) : null;
}

/** Задача — ровно столько, сколько нужно виду зоны и миграции. */
export interface ZoneTask {
  id: string;
  status: TaskStatus;
  roleId: string | null;
  repoDir: string | null;
  /** Нет поля — сохранение старше подпроектов. */
  subprojectId?: string | null;
}

/** Вид зоны для веба: пути, закреплённые, открытые задачи, проблема. */
export function subprojectView(
  sub: Subproject, subs: readonly Subproject[], roles: readonly Role[], tasks: Iterable<ZoneTask>,
  projectDir: string, lang: Lang,
): SubprojectView {
  let open = 0;
  for (const task of tasks) {
    if (task.subprojectId === sub.id && !CLOSED.includes(task.status)) open += 1;
  }
  return {
    ...sub,
    repoDir: zoneRepo(sub, projectDir),
    path: zonePath(sub, projectDir),
    members: roles
      .filter((r) => !r.archived && !r.isManager && (r.subprojects ?? []).includes(sub.id))
      .map((r) => ({ id: r.id, title: r.title })),
    openTasks: open,
    problem: zoneProblem(sub, subs, projectDir, lang),
  };
}

/** Следующий свободный цвет палитры; занято всё — по кругу. */
function nextColor(subs: readonly Subproject[]): string {
  const used = new Set(subs.map((s) => s.color));
  return OFFICE_COLORS.find((c) => !used.has(c)) ?? OFFICE_COLORS[subs.length % OFFICE_COLORS.length];
}

export interface EnsuredZone {
  /** Найденная или заведённая зона; null — корень совпал с офисом. */
  zone: Subproject | null;
  /** Зоны после вызова: заведена новая — она в конце списка. */
  subprojects: Subproject[];
  created: boolean;
}

/**
 * Найти зону с этим корнем или завести новую. Одна на всех: миграция, мастер,
 * форма роли и найм с рабочим местом — повторный вызов с тем же корнем (в том
 * числе записанным иначе: относительный против абсолютного) вторую зону не
 * заводит. id — слаг basename с суффиксом `-2`, `-3`; `root` — исходная строка.
 * Repo-зона на корне офиса не заводится: это «весь проект».
 */
export function ensureZone(input: {
  projectDir: string;
  subprojects: readonly Subproject[];
  root: string;
  kind?: SubprojectKind;
  now?: number;
}): EnsuredZone {
  const { projectDir } = input;
  const kind = input.kind ?? 'repo';
  const subs = [...input.subprojects];
  const raw = input.root.trim();
  const draft: Subproject = {
    id: '', name: '', kind, root: kind === 'folder' ? raw.replace(/^\/+|\/+$/g, '') : raw,
    summary: '', color: '', createdAt: 0,
  };
  const abs = zonePath(draft, projectDir);
  if (!raw || abs === projectDir) return { zone: null, subprojects: subs, created: false };
  const found = subs.find((s) => s.kind === kind && zonePath(s, projectDir) === abs);
  if (found) return { zone: found, subprojects: subs, created: false };
  const taken = new Set(subs.map((s) => s.id));
  const base = zoneSlug(abs);
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  const zone: Subproject = {
    ...draft, id, name: basename(abs), color: nextColor(subs), createdAt: input.now ?? Date.now(),
  };
  subs.push(zone);
  return { zone, subprojects: subs, created: true };
}

/**
 * Закрепление роли по прежнему «репозиторию роли»: repo-зоны роли заменяются
 * зоной `zoneId`, папки остаются. null — снять закрепление за repo-зонами.
 */
export function repoZonesReplaced(role: Role, subs: readonly Subproject[], zoneId: string | null): string[] {
  const repoIds = new Set(subs.filter((s) => s.kind === 'repo').map((s) => s.id));
  const kept = (role.subprojects ?? []).filter((id) => !repoIds.has(id));
  return zoneId ? [...kept, zoneId] : kept;
}

/** Строка «репозитория роли» — с самой роли или из разницы с пакетом. */
const repoDirOf = (role: Role): string =>
  (role.repoDir ?? '').trim() || String(role.package?.overrides.repoDir ?? '').trim();

/** Роль без поля `repoDir` — ни на самой роли, ни в разнице с пакетом. */
function withoutRepoDir(role: Role): Role {
  const { repoDir: _drop, ...rest } = role;
  if (!rest.package || !('repoDir' in rest.package.overrides)) return rest;
  const { repoDir: _dropOverride, ...overrides } = rest.package.overrides;
  return { ...rest, package: { ...rest.package, overrides } };
}

/**
 * Закрепить роль за зонами. У роли из пакета закрепление живёт оверрайдом
 * ссылки — так же, как прежний `repoDir`: у пакета умолчания нет.
 */
export function withZones(role: Role, zones: string[]): Role {
  const list = [...new Set(zones)];
  const { subprojects: _drop, ...rest } = role;
  const next: Role = list.length ? { ...rest, subprojects: list } : rest;
  if (!next.package) return next;
  const { subprojects: _dropOverride, ...overrides } = next.package.overrides;
  return { ...next, package: { ...next.package, overrides: list.length ? { ...overrides, subprojects: list } : overrides } };
}

export interface ZoneMigration {
  roles: Role[];
  subprojects: Subproject[];
  /** Задачи, которым надо выставить зону: id задачи → зона. */
  taskZones: Map<string, string | null>;
  /** Изменилось ли хоть что-то — тогда офис помечает состояние грязным. */
  changed: boolean;
}

/**
 * Миграция с «репозитория роли» (§7). Чистая функция: на входе роли, зоны и
 * задачи из сохранения, на выходе — новые роли и зоны и зоны задач.
 *
 * Идемпотентна по содержимому: после неё ни у одной роли нет `repoDir`, а у
 * каждой задачи есть `subprojectId`, — повторный прогон ничего не находит.
 */
export function migrateRepoDirs(input: {
  projectDir: string;
  roles: readonly Role[];
  subprojects: readonly Subproject[];
  tasks: Iterable<ZoneTask>;
  now?: number;
}): ZoneMigration {
  const { projectDir } = input;
  const now = input.now ?? Date.now();
  let subs = [...input.subprojects];
  let changed = false;

  // Зоны заводим по отсортированным путям — в том же порядке, в каком
  // `ruleScopes` раздавал суффиксы кругам `repo:`, чтобы id совпали с ними.
  const wanted = new Map<string, string>();
  for (const role of input.roles) {
    const raw = repoDirOf(role);
    if (!raw) continue;
    const abs = resolveRoot(projectDir, raw);
    if (abs !== projectDir && !wanted.has(abs)) wanted.set(abs, raw);
  }
  const repoZone = (abs: string): Subproject | undefined =>
    subs.find((s) => s.kind === 'repo' && resolveRoot(projectDir, s.root) === abs);
  for (const abs of [...wanted.keys()].sort()) {
    const got = ensureZone({ projectDir, subprojects: subs, root: wanted.get(abs)!, now });
    subs = got.subprojects;
    if (got.created) changed = true;
  }

  // Роли: репозиторий → закрепление за его зоной, поле снимается.
  const migrated = new Map<string, string>();
  const roles = input.roles.map((role) => {
    const raw = repoDirOf(role);
    if (!raw && role.repoDir === undefined && !(role.package && 'repoDir' in role.package.overrides)) return role;
    changed = true;
    const bare = withoutRepoDir(role);
    if (!raw) return bare;
    const abs = resolveRoot(projectDir, raw);
    // Совпал с офисом — «общий репозиторий»: зоны нет, поле просто снимается.
    // Менеджер не закрепляется никогда (§2.2): он видит весь офис.
    if (abs === projectDir || role.isManager) return bare;
    const zone = repoZone(abs)!;
    migrated.set(role.id, zone.id);
    return withZones(bare, [...(bare.subprojects ?? []), zone.id]);
  });

  // Задачи. Не стартовавшие задачи мигрированной роли идут в её зону, иначе
  // ушли бы в репозиторий офиса. Остальные без зоны получают её по своему
  // `repoDir`: он записан на старте и остаётся правдой.
  const taskZones = new Map<string, string | null>();
  for (const task of input.tasks) {
    const own = task.roleId ? migrated.get(task.roleId) : undefined;
    if (own && !task.repoDir && UNSTARTED.includes(task.status) && !task.subprojectId) {
      taskZones.set(task.id, own);
      continue;
    }
    if (task.subprojectId !== undefined) continue;
    const zone = task.repoDir ? repoZone(resolveRoot(projectDir, task.repoDir)) : undefined;
    taskZones.set(task.id, zone?.id ?? null);
  }
  if (taskZones.size) changed = true;

  return { roles, subprojects: subs, taskZones, changed };
}

// ---------- «читать можно, менять нельзя» (§5) ----------

/**
 * Что задаче папки-зоны разрешено менять: корень зоны и общие пути вне его.
 * Пути — от корня репозитория офиса, через `/`. `label` — имя зоны словами,
 * им причина отказа и говорит.
 */
export interface WriteZone {
  roots: string[];
  sharedPaths: string[];
  label: string;
}

/**
 * Общие пути зоны по умолчанию — корневые lock-файлы. Монорепо с одним
 * lock-файлом на всех — частый случай, и зона, которая добавила зависимость,
 * не должна упираться в гейт из-за `package-lock.json`. Явный `sharedPaths`
 * (в том числе пустой) перебивает умолчание.
 */
export const DEFAULT_SHARED_PATHS: readonly string[] = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
];

/**
 * Зона записи задачи — или null, если ограничивать нечем: «весь проект»
 * (subprojectId null, в том числе офис без подпроектов), зона пропала из
 * сохранения, repo-зона (её граница — рабочая копия и песочница ОС, §5.1).
 */
export function writeZone(sub: Subproject | null | undefined): WriteZone | null {
  if (!sub || sub.kind !== 'folder') return null;
  const root = sub.root.replace(/^\/+|\/+$/g, '');
  if (!root) return null;
  return {
    roots: [root],
    sharedPaths: [...(sub.sharedPaths ?? DEFAULT_SHARED_PATHS)],
    label: sub.name || sub.id,
  };
}

/** Шаблон git pathspec в регулярку: `*` — внутри сегмента, `**` — через сегменты. */
function pathspecRe(spec: string): RegExp {
  let re = '';
  for (let i = 0; i < spec.length; i += 1) {
    const ch = spec[i];
    if (ch === '*' && spec[i + 1] === '*') {
      const slash = spec[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

/** Путь лежит в каталоге `root` — по сегментам: `web` не пускает в `webhooks/`. */
const underRoot = (file: string, root: string): boolean => file === root || file.startsWith(`${root}/`);

/** Файл (путь от корня репозитория) разрешено менять задаче этой зоны. */
export function inWriteZone(file: string, zone: WriteZone): boolean {
  const path = file.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (zone.roots.some((root) => underRoot(path, root))) return true;
  return zone.sharedPaths.some((spec) => {
    const clean = spec.trim().replace(/^\/+/, '');
    if (!clean) return false;
    return /[*?]/.test(clean) ? pathspecRe(clean).test(path) : underRoot(path, clean.replace(/\/+$/, ''));
  });
}

/**
 * Изменённые пути вне зоны задачи (§5.2), отсортированные и без повторов.
 * Чистая функция: список путей приносит вызывающий (гейт — из `git diff`).
 * Зоны нет (задача «весь проект», офис без подпроектов) или она repo — пусто.
 */
export function outsideZone(zone: WriteZone | Subproject | null | undefined, files: readonly string[]): string[] {
  const write = zone && 'roots' in zone ? zone : writeZone(zone);
  if (!write) return [];
  return [...new Set(files.map((f) => f.trim()).filter(Boolean))]
    .filter((f) => !inWriteZone(f, write))
    .sort();
}

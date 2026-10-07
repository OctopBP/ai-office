import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { Lang } from '../shared/i18n';
import { OFFICE_COLORS, type Subproject, type SubprojectView, type TaskStatus } from '../shared/types';
import type { Role } from './roles';
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
  const subs = [...input.subprojects];
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
    if (repoZone(abs)) continue;
    const taken = new Set(subs.map((s) => s.id));
    const base = zoneSlug(abs);
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    subs.push({
      id, name: basename(abs), kind: 'repo', root: wanted.get(abs)!,
      summary: '', color: nextColor(subs), createdAt: now,
    });
    changed = true;
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

/**
 * Модель подпроектов без единого токена (docs/design/subprojects/spec.md §2, §7):
 * рабочая папка роли и репозиторий задачи по зоне, прежний «репозиторий
 * роли» поверх зон и миграция repoDir → repo-зона с повторным прогоном.
 *
 * Запуск: npm run test:subprojects
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openOfficeState, unloadOfficeState } from '../src/server/state';
import { flushAll, save, type Persisted } from '../src/server/store';
import { defaultRoles, type Role } from '../src/server/roles';
import { loadPackage } from '../src/server/packages';
import {
  ensureZone, migrateRepoDirs, roleWorkdir, sanitizeSubprojects, taskRepoDir, type ZoneTask,
} from '../src/server/subprojects';
import type { Subproject } from '../src/shared/types';

const results: string[] = [];
const check = (what: string, ok: boolean) => {
  results.push(`  ${ok ? '✅' : '❌'} ${what}: ${ok}`);
};

const base = resolve(tmpdir(), `office-test-subprojects-${process.pid}`);
const projectDir = resolve(base, 'office');
mkdirSync(projectDir, { recursive: true });

const zone = (id: string, kind: Subproject['kind'], root: string): Subproject => ({
  id, name: id, kind, root, summary: '', color: 'accent-1', createdAt: 0,
});
const role = (id: string, extra: Partial<Role> = {}): Role =>
  ({ ...defaultRoles('ru').find((r) => r.id === 'backend')!, id, ...extra });

function pureRules(): void {
  results.push('repoForRole / repoForTask (§2.3):');
  const subs = [zone('web', 'folder', 'apps/web'), zone('api', 'repo', '../api')];
  const api = resolve(base, 'api');
  check('роль без закрепления — корень офиса', roleWorkdir(role('a'), subs, projectDir) === projectDir);
  check('одна folder-зона — её папка',
    roleWorkdir(role('a', { subprojects: ['web'] }), subs, projectDir) === resolve(projectDir, 'apps/web'));
  check('одна repo-зона — её репозиторий',
    roleWorkdir(role('a', { subprojects: ['api'] }), subs, projectDir) === api);
  check('несколько зон — корень офиса',
    roleWorkdir(role('a', { subprojects: ['web', 'api'] }), subs, projectDir) === projectDir);
  check('пропавшая зона — корень офиса',
    roleWorkdir(role('a', { subprojects: ['gone'] }), subs, projectDir) === projectDir);
  check('менеджер не закрепляется — корень офиса',
    roleWorkdir(role('a', { subprojects: ['api'], isManager: true }), subs, projectDir) === projectDir);
  check('нет роли — корень офиса', roleWorkdir(null, subs, projectDir) === projectDir);
  check('задача «весь проект» — репозиторий офиса', taskRepoDir(null, subs, projectDir) === projectDir);
  check('задача folder-зоны — репозиторий офиса', taskRepoDir('web', subs, projectDir) === projectDir);
  check('задача repo-зоны — её репозиторий', taskRepoDir('api', subs, projectDir) === api);
  check('задача пропавшей зоны — репозиторий офиса', taskRepoDir('gone', subs, projectDir) === projectDir);
  const clean = sanitizeSubprojects([
    zone('web', 'folder', '/apps/web/'), zone('web', 'repo', 'x'), { id: 'Плохой', kind: 'repo', root: 'x' },
    { id: 'nokind', root: 'x' }, { ...zone('w2', 'folder', 'w'), sharedPaths: ['package.json', ''], mergeChecks: [] },
  ]);
  check('из сохранения: мусор и повтор id выкинуты', clean.map((s) => s.id).join(',') === 'web,w2');
  check('из сохранения: слеши корня папки сняты', clean[0].root === 'apps/web');
  check('из сохранения: sharedPaths и пустой mergeChecks уцелели',
    clean[1].sharedPaths?.join() === 'package.json' && clean[1].mergeChecks?.length === 0);
}

function pureMigration(): void {
  results.push('миграция repoDir → repo-зона (§7), чистая функция:');
  const roles = [
    role('backend', { repoDir: '../api' }),
    role('backend-2', { repoDir: resolve(base, 'api') }),
    role('design', { repoDir: '../api', docsDir: 'docs/design' }),
    role('frontend', { repoDir: '' }),
    role('local', { repoDir: '.' }),
    role('pm', { repoDir: '../api', isManager: true }),
  ];
  const tasks: ZoneTask[] = [
    { id: 'T-1', status: 'planned', roleId: 'backend', repoDir: null },
    { id: 'T-2', status: 'done', roleId: 'frontend', repoDir: resolve(base, 'api') },
    { id: 'T-3', status: 'done', roleId: 'frontend', repoDir: projectDir },
    { id: 'T-4', status: 'backlog', roleId: 'frontend', repoDir: null },
  ];
  const first = migrateRepoDirs({ projectDir, roles, subprojects: [], tasks, now: 1 });
  const by = (id: string) => first.roles.find((r) => r.id === id)!;
  check('две роли в одном репозитории — одна зона', first.subprojects.length === 1);
  const sub = first.subprojects[0];
  check('зона repo, id и имя по папке, корень — исходная строка',
    sub?.kind === 'repo' && sub.id === 'api' && sub.name === 'api' && sub.root === '../api');
  check('обе роли закреплены за зоной',
    by('backend').subprojects?.join() === 'api' && by('backend-2').subprojects?.join() === 'api');
  check('роль с docsDir переносится так же и docsDir сохраняет',
    by('design').subprojects?.join() === 'api' && by('design').docsDir === 'docs/design');
  check('repoDir снят со всех ролей', first.roles.every((r) => r.repoDir === undefined));
  check('repoDir = корень офиса — зоны и закрепления нет', by('local').subprojects === undefined);
  check('менеджер не закрепляется', by('pm').subprojects === undefined);
  check('не стартовавшая задача мигрированной роли — в её зону', first.taskZones.get('T-1') === 'api');
  check('закрытая задача — по своему repoDir', first.taskZones.get('T-2') === 'api');
  check('задача в репозитории офиса — «весь проект»', first.taskZones.get('T-3') === null);
  check('задача без зоны в сохранении — null', first.taskZones.get('T-4') === null);

  const migratedTasks = tasks.map((t) => ({ ...t, subprojectId: first.taskZones.get(t.id) ?? null }));
  const second = migrateRepoDirs({
    projectDir, roles: first.roles, subprojects: first.subprojects, tasks: migratedTasks, now: 2,
  });
  check('повторный прогон ничего не меняет', !second.changed && second.taskZones.size === 0);
  check('повторный прогон не завёл вторую зону', second.subprojects.length === 1);
  check('повторный прогон не задвоил закрепление', second.roles.find((r) => r.id === 'backend')?.subprojects?.join() === 'api');

  // repoDir вернули руками в уже мигрированный офис — разбирается тем же правилом.
  const back = migrateRepoDirs({
    projectDir, roles: first.roles.map((r) => (r.id === 'frontend' ? { ...r, repoDir: '../api' } : r)),
    subprojects: first.subprojects, tasks: migratedTasks,
  });
  check('вернувшийся repoDir разобран в ту же зону',
    back.changed && back.subprojects.length === 1
    && back.roles.find((r) => r.id === 'frontend')?.subprojects?.join() === 'api');
}

function pureEnsureZone(): void {
  results.push('ensureZone — найти или завести зону по корню:');
  const first = ensureZone({ projectDir, subprojects: [], root: '../api', now: 5 });
  check('заведена repo-зона с исходной строкой корня',
    first.created && first.zone?.id === 'api' && first.zone.kind === 'repo' && first.zone.root === '../api'
    && first.zone.createdAt === 5 && first.subprojects.length === 1);
  const same = ensureZone({ projectDir, subprojects: first.subprojects, root: resolve(base, 'api') });
  check('тот же корень абсолютным путём — та же зона, вторая не заводится',
    !same.created && same.zone?.id === 'api' && same.subprojects.length === 1);
  const clash = ensureZone({ projectDir, subprojects: first.subprojects, root: resolve(base, 'other', 'api') });
  check('другой корень с тем же слагом — суффикс -2 и другой цвет',
    clash.created && clash.zone?.id === 'api-2' && clash.zone.color !== first.zone!.color);
  const office = ensureZone({ projectDir, subprojects: first.subprojects, root: projectDir });
  check('корень офиса — зоны нет', office.zone === null && !office.created && office.subprojects.length === 1);
  check('пусто — зоны нет', ensureZone({ projectDir, subprojects: [], root: '  ' }).zone === null);
  const folder = ensureZone({ projectDir, subprojects: first.subprojects, root: '/apps/web/', kind: 'folder' });
  check('папка: корень без крайних слешей, ищется по своему виду',
    folder.created && folder.zone?.kind === 'folder' && folder.zone.root === 'apps/web'
    && !ensureZone({ projectDir, subprojects: folder.subprojects, root: 'apps/web', kind: 'folder' }).created);
  check('вход не мутируется', first.subprojects.length === 1);
}

/** Репозиторий с одним коммитом — форма роли проверяет корень через repoProblem. */
function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  run('init', '-q');
  run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
}

async function officeZones(): Promise<void> {
  results.push('форма роли и найм заводят зону вместо repoDir:');
  const svc = resolve(base, 'svc');
  const lib = resolve(base, 'lib');
  gitRepo(svc);
  gitRepo(lib);
  const office = openOfficeState({ id: 'o-sub-zones', projectDir, stateFile: resolve(base, 'zones.json') }).state;
  const errors = await office.editRole('frontend', { repoDir: '../svc' });
  const front = () => office.role('frontend')!;
  check('PATCH с repoDir: ошибок нет, зона заведена',
    errors.length === 0 && office.subprojects().map((s) => `${s.id}:${s.kind}:${s.root}`).join() === 'svc:repo:../svc');
  check('PATCH с repoDir: роль закреплена, поля repoDir нет',
    front().subprojects?.join() === 'svc' && front().repoDir === undefined
    && front().package?.overrides.repoDir === undefined);
  await office.editRole('frontend', { repoDir: svc });
  check('повторный PATCH с тем же корнем — вторая зона не заводится',
    office.subprojects().length === 1 && front().subprojects?.join() === 'svc');
  await office.editRole('backend', { repoDir: '../svc' });
  check('вторая роль на том же корне — та же зона', office.role('backend')?.subprojects?.join() === 'svc'
    && office.subprojects().length === 1);
  await office.editRole('frontend', { repoDir: '../lib' });
  check('PATCH на другой корень — новая зона, прежняя repo-зона снята',
    office.subprojects().length === 2 && front().subprojects?.join() === 'lib');
  await office.editRole('frontend', { repoDir: '' });
  check('пустой repoDir снимает закрепление, зоны остаются',
    front().subprojects === undefined && office.subprojects().length === 2);
  const bad = await office.editRole('frontend', { repoDir: '../nope' });
  check('корень не репозиторий — ошибка поля, зоны не заводится',
    bad.some((e) => e.field === 'repoDir') && office.subprojects().length === 2);

  const created = await office.createRole({ title: 'Сервис', repoDir: '../lib' });
  check('новая роль из формы — закреплена за зоной, без repoDir',
    'role' in created && office.role(created.role.id)?.subprojects?.join() === 'lib'
    && office.role(created.role.id)?.repoDir === undefined && office.subprojects().length === 2);

  const pkg = loadPackage('@office/backend');
  if (!pkg) { check('пакет @office/backend найден', false); return; }
  const before = new Set(office.roles().map((r) => r.id));
  const problem = office.hireFromPackage(pkg, null, {}, { zoneRoot: '../svc' });
  const hired = office.roles().find((r) => !before.has(r.id));
  check('найм с рабочим местом — роль закреплена за той же зоной, оверрайда repoDir нет',
    problem === null && hired?.subprojects?.join() === 'svc' && hired.repoDir === undefined
    && hired.package?.overrides.repoDir === undefined && office.subprojects().length === 2);
  const before2 = new Set(office.roles().map((r) => r.id));
  office.hireFromPackage(pkg, null, { repoDir: resolve(base, 'svc') });
  const legacy = office.roles().find((r) => !before2.has(r.id));
  check('прежний вызов с extra.repoDir — тоже зона', legacy?.subprojects?.join() === 'svc'
    && legacy.package?.overrides.repoDir === undefined && office.subprojects().length === 2);
  const before3 = new Set(office.roles().map((r) => r.id));
  office.hireFromPackage(pkg, null, {}, { zoneRoot: '../nope' });
  const lost = office.roles().find((r) => !before3.has(r.id));
  check('найм с несуществующей папкой — нанят без зоны, пустышка не заведена',
    !!lost && !lost.subprojects?.length && lost.repoDir === undefined && office.subprojects().length === 2);
  unloadOfficeState('o-sub-zones');
}

function officeMigration(): void {
  results.push('миграция на загрузке офиса и повторная загрузка:');
  const open = (id: string, file: string) => openOfficeState({ id, projectDir, stateFile: file }).state;
  const seedFile = resolve(base, 'seed.json');
  const seed = open('o-sub-seed', seedFile);
  const planned = seed.createTask({ title: 'план', description: '', criteria: [], roleId: 'backend', status: 'planned' });
  const done = seed.createTask({ title: 'сделано', description: '', criteria: [], roleId: 'frontend' });
  seed.updateTask(done.id, { status: 'done', repoDir: resolve(base, 'api') });
  const plain = seed.createTask({ title: 'общая', description: '', criteria: [], roleId: 'frontend' });
  check('офис без подпроектов: зона новой задачи — «весь проект»', planned.subprojectId === null);
  check('офис без подпроектов: repoForRole — корень офиса', seed.repoForRole(seed.role('backend')) === projectDir);

  // Сохранение «до подпроектов»: repoDir у ролей, у задач нет subprojectId.
  const old = seed.toPersisted() as Persisted & { subprojects?: unknown };
  delete old.subprojects;
  // У роли из пакета «репозиторий роли» жил оверрайдом ссылки, у роли без
  // пакета — полем самой роли: проверяются оба пути.
  old.roles = old.roles!.map((r) => {
    if (r.id !== 'backend' && r.id !== 'design') return r;
    return r.package
      ? { ...r, package: { ...r.package, overrides: { ...r.package.overrides, repoDir: '../api' } } }
      : { ...r, repoDir: '../api' };
  });
  old.tasks = old.tasks.map((t) => {
    const { subprojectId: _drop, ...rest } = t;
    return rest as typeof t;
  });
  const oldFile = resolve(base, 'old.json');
  save(oldFile, () => old);
  flushAll();
  const office = open('o-sub-old', oldFile);
  const api = resolve(base, 'api');
  check('на загрузке заведена одна repo-зона', office.subprojects().map((s) => `${s.id}:${s.kind}`).join() === 'api:repo');
  check('роли закреплены, repoDir снят',
    office.role('backend')?.subprojects?.join() === 'api' && office.role('backend')?.repoDir === undefined
    && office.role('design')?.subprojects?.join() === 'api' && office.role('design')?.docsDir === 'docs/design');
  check('repoForRole мигрированной роли — её репозиторий', office.repoForRole(office.role('backend')) === api);
  check('repoForRole незакреплённой роли — корень офиса', office.repoForRole(office.role('frontend')) === projectDir);
  const task = (id: string) => office.tasks.get(id)!;
  check('задачи получили зоны',
    task(planned.id).subprojectId === 'api' && task(done.id).subprojectId === 'api' && task(plain.id).subprojectId === null);
  check('repoForTask по зоне', office.repoForTask(task(planned.id)) === api
    && office.repoForTask(task(plain.id)) === projectDir);
  const fresh = office.createTask({ title: 'новая', description: '', criteria: [], roleId: 'backend' });
  check('новая задача закреплённой роли — в её зону', fresh.subprojectId === 'api');

  // Повторная загрузка уже мигрированного сохранения.
  const againFile = resolve(base, 'again.json');
  const persisted = office.toPersisted();
  save(againFile, () => persisted);
  flushAll();
  const again = open('o-sub-again', againFile);
  check('повторная загрузка: зоны те же',
    JSON.stringify(again.subprojects()) === JSON.stringify(office.subprojects()));
  check('повторная загрузка: роли те же',
    JSON.stringify(again.roles()) === JSON.stringify(office.roles()));
  check('повторная загрузка: зоны задач те же',
    [...again.tasks.values()].every((t) => t.subprojectId === office.tasks.get(t.id)?.subprojectId));
  check('снимок отдаёт подпроекты', (again.toPersisted() as Persisted).subprojects !== undefined);

  unloadOfficeState('o-sub-seed');
  unloadOfficeState('o-sub-old');
  unloadOfficeState('o-sub-again');
}

try {
  pureRules();
  pureMigration();
  pureEnsureZone();
  officeMigration();
  await officeZones();
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log(results.join('\n'));
const failed = results.filter((r) => r.includes('❌'));
console.log(failed.length ? `ПРОВАЛОВ: ${failed.length}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(failed.length ? 1 : 0);

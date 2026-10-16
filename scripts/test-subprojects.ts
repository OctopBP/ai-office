/**
 * Модель подпроектов без единого токена (docs/design/subprojects/spec.md §2, §7):
 * рабочая папка роли и репозиторий задачи по зоне, прежний «репозиторий
 * роли» поверх зон, миграция repoDir → repo-зона с повторным прогоном и
 * граница зоны «читать можно, менять нельзя» (§5).
 *
 * Запуск: npm run test:subprojects
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openOfficeState, unloadOfficeState } from '../src/server/state';
import {
  assignDirect, officeAssign, pmPrompt, retryTask, subprojectsSummary, teamSummary, workerSystemPrompt,
} from '../src/server/agents';
import { createDoc, docIndexForPrompt, PROMPT_INDEX_CHARS } from '../src/server/docs';
import { addRule } from '../src/server/rules';
import { editTask } from '../src/server/tasks';
import { setRoleBase } from '../src/server/rolebase';
import { t } from '../src/server/i18n';
import { createPlan } from '../src/server/plan';
import { flushAll, save, type Persisted } from '../src/server/store';
import { dispatch } from '../src/server/plan';
import { formatBoard } from '../src/server/board-view';
import { defaultRoles, type Role } from '../src/server/roles';
import { loadPackage } from '../src/server/packages';
import {
  admitProblem, admits, consultWorkdir, ensureZone, repoDirHint, migrateRepoDirs, outsideZone, roleRepoDir, roleWorkdir, sanitizeSubprojects, taskRepoDir, writeZone, zoneForRole,
  seatZone, zoneSeating,
  type ZoneTask,
} from '../src/server/subprojects';
import type { Subproject, SubprojectDraft } from '../src/shared/types';

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
  results.push('RoleView.repoDir (§7):');
  const subs2 = [...subs, zone('lib', 'repo', '/abs/lib')];
  check('одна repo-зона — её корень', roleRepoDir(role('a', { subprojects: ['api'] }), subs2) === '../api');
  check('repo-зона и папка — корень repo-зоны', roleRepoDir(role('a', { subprojects: ['web', 'api'] }), subs2) === '../api');
  check('только папочная зона — прежнее поле', roleRepoDir(role('a', { subprojects: ['web'], repoDir: 'old' }), subs2) === 'old');
  check('без закрепления — прежнее поле, пусто', roleRepoDir(role('a'), subs2) === '');
  check('несколько repo-зон — прежнее поле',
    roleRepoDir(role('a', { subprojects: ['api', 'lib'], repoDir: 'old' }), subs2) === 'old');
  check('пропавшая зона — прежнее поле', roleRepoDir(role('a', { subprojects: ['gone'] }), subs2) === '');
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
  const view = (id: string) => office.roleViews().find((r) => r.id === id)!;
  check('RoleView.repoDir — корень единственной repo-зоны роли', view('frontend').repoDir === '../svc');
  check('RoleView.repoDir роли без закрепления — прежнее пустое', view('reviewer').repoDir === '');
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
  check('RoleView.repoDir после снятия закрепления — пусто', view('frontend').repoDir === '');
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

function zoneBoundary(): void {
  results.push('пути вне зоны (§5.2):');
  const web = zone('web', 'folder', 'apps/web');
  const files = ['apps/web/src/a.ts', 'apps/webhooks/x.ts', 'src/server/b.ts', 'package-lock.json', 'apps/web/src/a.ts'];
  check('без зоны — без ограничения', outsideZone(null, files).length === 0);
  check('repo-зона — без ограничения', outsideZone(zone('api', 'repo', '../api'), files).length === 0);
  const out = outsideZone(web, files);
  check('вне зоны — чужая папка и соседний префикс, по одному разу и по порядку',
    out.join(',') === 'apps/webhooks/x.ts,src/server/b.ts');
  check('корневой lock-файл — общий путь по умолчанию', !out.includes('package-lock.json'));
  check('пустой sharedPaths — lock-файл тоже чужой',
    outsideZone({ ...web, sharedPaths: [] }, files).includes('package-lock.json'));
  check('sharedPaths с маской и каталогом', outsideZone({ ...web, sharedPaths: ['docs/**/*.md', 'src/shared'] },
    ['docs/a/b.md', 'docs/a.txt', 'src/shared/types.ts', 'src/sharedx.ts']).join(',') === 'docs/a.txt,src/sharedx.ts');
  const wz = writeZone(web);
  check('зона записи с именем зоны', wz?.label === 'web' && wz.roots.join() === 'apps/web');
  check('функция принимает и готовую зону записи', outsideZone(wz, files).length === 2);
}

function admission(): void {
  results.push('допуск admits / admitProblem (§3.1):');
  const subs = [zone('web', 'folder', 'apps/web'), zone('api', 'folder', 'apps/api')];
  const pinned = role('frontend', { title: 'Фронтенд', subprojects: ['web'] });
  const free = role('backend', { title: 'Бэкенд' });
  const pm = role('pm', { isManager: true });
  const scope = { subprojects: () => subs, workerRoles: () => [pinned, free], lang: () => 'ru' as const };
  check('закреплён за зоной — допущен', admits(pinned, 'web') && admitProblem(scope, pinned, { subprojectId: 'web' }) === null);
  const other = admitProblem(scope, pinned, { subprojectId: 'api' });
  check('не закреплён за зоной — отказ', !admits(pinned, 'api') && !!other);
  check('причина называет зону и кому по силам', !!other?.includes('«api»') && !!other?.includes('backend'));
  check('без закрепления — любая зона', admits(free, 'api') && admitProblem(scope, free, { subprojectId: 'web' }) === null);
  check('задача без зоны — роль без закрепления допущена',
    admits(free, null) && admitProblem(scope, free, {}) === null && admitProblem(scope, free, { subprojectId: null }) === null);
  const whole = admitProblem(scope, pinned, { subprojectId: null });
  check('задача без зоны — закреплённая роль нет (§3.1)', !admits(pinned, null) && !!whole?.includes('весь проект'));
  check('менеджер — никогда', !admits(pm, null) && !!admitProblem(scope, pm, {}));
  check('пропавшая зона — отказ всем', !!admitProblem(scope, free, { subprojectId: 'gone' }));
  const empty = { subprojects: () => [], workerRoles: () => [free], lang: () => 'en' as const };
  check('офис без подпроектов — допуск всегда', admitProblem(empty, free, { subprojectId: null }) === null);
}

function pickZone(): void {
  results.push('зона из слов менеджера zoneForRole (§6.1):');
  const subs = [zone('web', 'folder', 'apps/web'), zone('api', 'folder', 'apps/api')];
  const pinned = role('frontend', { subprojects: ['web'] });
  const both = role('fullstack', { subprojects: ['web', 'api'] });
  const free = role('backend');
  const scope = { subprojects: () => subs, workerRoles: () => [pinned, both, free], lang: () => 'ru' as const };
  const zoneOf = (r: ReturnType<typeof zoneForRole>) => ('zone' in r ? r.zone : `!${r.error}`);
  check('пусто, одна зона роли — она', zoneOf(zoneForRole(scope, pinned, '')) === 'web');
  check('пусто, роль без закрепления — весь проект', zoneOf(zoneForRole(scope, free, '')) === null);
  const amb = zoneForRole(scope, both, '');
  check('пусто, несколько зон — отказ «укажи зону»', 'error' in amb && amb.error.includes('web, api'));
  const unknown = zoneForRole(scope, free, 'nope');
  check('неизвестный id — отказ с перечнем зон', 'error' in unknown && unknown.error.includes('«nope»') && unknown.error.includes('web, api'));
  const denied = zoneForRole(scope, pinned, 'api');
  check('недопущенная роль — причина из admitProblem',
    'error' in denied && denied.error === admitProblem(scope, pinned, { subprojectId: 'api' }));
  check('none — явно весь проект', zoneOf(zoneForRole(scope, free, 'none')) === null
    && 'error' in zoneForRole(scope, pinned, 'none'));
  check('названная своя зона — она', zoneOf(zoneForRole(scope, both, ' api ')) === 'api');
}

/** Рабочая папка ask_colleague (§6.2): корень зоны у допущенной роли, без зоны — как раньше. */
function consultPlace(): void {
  results.push('папка консультации consultWorkdir (§6.2):');
  const subs = [zone('web', 'folder', 'apps/web'), zone('lib', 'repo', '../lib')];
  const pinned = role('frontend', { title: 'Фронтенд', subprojects: ['web'] });
  const free = role('backend', { title: 'Бэкенд' });
  const scope = { subprojects: () => subs, workerRoles: () => [pinned, free], lang: () => 'ru' as const };
  const cwdOf = (r: ReturnType<typeof consultWorkdir>) => ('cwd' in r ? r.cwd : `!${r.error}`);
  check('без subprojectId — прежнее правило repoForRole',
    cwdOf(consultWorkdir(scope, pinned, undefined, projectDir)) === roleWorkdir(pinned, subs, projectDir)
    && cwdOf(consultWorkdir(scope, free, '', projectDir)) === projectDir);
  check('закреплённая роль, folder-зона — projectDir/root',
    cwdOf(consultWorkdir(scope, pinned, 'web', projectDir)) === resolve(projectDir, 'apps/web'));
  check('универсал, repo-зона — resolve(root)',
    cwdOf(consultWorkdir(scope, free, 'lib', projectDir)) === resolve(projectDir, '../lib'));
  const denied = consultWorkdir(scope, pinned, 'lib', projectDir);
  check('недопущенная роль — отказ из admitProblem',
    'error' in denied && denied.error === admitProblem(scope, pinned, { subprojectId: 'lib' }));
  check('неизвестная зона — отказ', 'error' in consultWorkdir(scope, free, 'gone', projectDir));
}

/** Подсказка на правку роли с repoDir (§7): называет зону на обоих языках. */
function repoDirReply(): void {
  results.push('подсказка repoDirHint на PATCH роли (§7):');
  const lib = zone('lib', 'repo', '../lib');
  const pinned = role('backend', { subprojects: ['lib'] });
  const base = { role: pinned, after: [lib], projectDir };
  const made = repoDirHint({ ...base, lang: 'ru', raw: '../lib', before: [] });
  check('новая зона — «Заведена» с именем и корнем', !!made?.includes('Заведена') && !!made?.includes('«lib»') && !!made?.includes('../lib'));
  const had = repoDirHint({ ...base, lang: 'ru', raw: resolve(projectDir, '../lib'), before: [lib] });
  check('уже бывшая зона — «уже заведённой»', !!had?.includes('уже заведённой') && !!had?.includes('«lib»'));
  const en = repoDirHint({ ...base, lang: 'en', raw: '../lib', before: [] });
  check('по-английски — тоже с зоной', !!en?.includes('subproject') && !!en?.includes('“lib”'));
  check('пустой путь — закрепление снято', !!repoDirHint({ ...base, lang: 'ru', raw: '', before: [lib] })?.includes('снято'));
  check('менеджер — без подсказки',
    repoDirHint({ ...base, role: role('pm', { isManager: true }), lang: 'ru', raw: '../lib', before: [] }) === null);
}

/** create_task, plan_features, edit_task и list_team в живом офисе (§6.1). */
async function managerTools(): Promise<void> {
  results.push('инструменты менеджера: зона задачи и закрепления (§6.1):');
  const office = openOfficeState({ id: 'o-sub-tools', projectDir, stateFile: resolve(base, 'tools.json') }).state;
  office.dryRun = true;
  const zonesWord = () => office.say('prompt.team.zones');
  check('list_team без зон — строки «зоны» нет', !teamSummary(office).includes(`${zonesWord()}:`));
  const svc = resolve(base, 'tools-svc');
  gitRepo(svc);
  await office.editRole('frontend', { repoDir: svc });
  const zid = office.subprojects()[0]!.id;
  const team = teamSummary(office);
  const lineOf = (id: string) => team.split('\n- ').find((l) => l.replace(/^- /, '').startsWith(`${id} (`)) ?? '';
  check('list_team: закреплённая роль — её зона', lineOf('frontend').includes(`${zonesWord()}: ${zid}`));
  check('list_team: роль без закрепления — весь проект', lineOf('backend').includes(`${zonesWord()}: ${office.say('prompt.team.wholeProject')}`));

  const task = office.createTask({ title: 'правка', description: 'x', criteria: ['a'], roleId: 'backend' });
  const unknown = editTask(office, task.id, { subprojectId: 'nope' });
  check('edit_task: неизвестная зона — отказ', !unknown.ok && unknown.message.includes('nope'));
  const moved = editTask(office, task.id, { subprojectId: zid });
  check('edit_task: зона сменилась', moved.ok && office.tasks.get(task.id)?.subprojectId === zid);
  const toFront = editTask(office, task.id, { roleId: 'frontend', subprojectId: 'none' });
  check('edit_task: недопущенная пара — причина и ничего не тронуто',
    !toFront.ok && toFront.message === admitProblem(office, office.role('frontend')!, { subprojectId: null })
    && office.tasks.get(task.id)?.roleId === 'backend' && office.tasks.get(task.id)?.subprojectId === zid);

  const before = office.tasks.size;
  const plan = (front: string) => [{
    title: 'фича', goal: 'цель', tasks: [
      { key: 'ui', title: 'экран', description: 'x', acceptanceCriteria: ['a'], roleId: 'frontend', subprojectId: front },
      { key: 'api', title: 'ручка', description: 'x', acceptanceCriteria: ['a'], roleId: 'backend', subprojectId: 'nope' },
    ],
  }];
  const bad = createPlan(office, plan('none'));
  check('plan_features: отказ целиком с перечнем задач',
    !bad.ok && bad.message.includes('ui «экран»') && bad.message.includes('api «ручка»') && office.tasks.size === before);
  const good = createPlan(office, [{ ...plan('')[0]!, tasks: [{ ...plan('')[0]!.tasks[0]!, subprojectId: '' }] }]);
  const made = [...office.tasks.values()].find((t) => t.title === 'экран');
  check('plan_features: пустая зона выведена из роли', good.ok && made?.subprojectId === zid);
  unloadOfficeState('o-sub-tools');
}

/**
 * Перенос задачи между зонами через edit_task (T-517): нестартовавшая — между
 * любыми зонами и на «весь проект», в том числе из плана фич; стартовавшая,
 * но стоящая — со сбросом привязки к прежнему репозиторию; идущая, сданная и
 * влитая — отказ с подсказкой.
 */
async function moveTaskZone(): Promise<void> {
  results.push('перенос задачи между зонами (T-517):');
  const one = resolve(base, 'move-one');
  const two = resolve(base, 'move-two');
  gitRepo(one);
  gitRepo(two);
  const office = openOfficeState({ id: 'o-sub-move', projectDir, stateFile: resolve(base, 'move.json') }).state;
  office.dryRun = true;
  // frontend закреплён за первой зоной, вторая — ничья, backend — универсал.
  await office.editRole('frontend', { repoDir: one });
  const a = office.subprojects()[0]!.id;
  const made = office.saveSubproject(undefined, { name: 'Вторая', root: two, kind: 'repo', summary: '', color: 'accent-2', sharedPaths: [] });
  const b = 'id' in made ? made.id : '';
  check('две зоны заведены', !!a && !!b && a !== b);
  const nameOf = (id: string) => office.subproject(id)!.name;
  const logged = (text: string) => office.log.some((l) => l.text.includes(text));
  const zoneOf = (id: string) => office.tasks.get(id)?.subprojectId ?? null;
  const add = (roleId: string, zoneId?: string) => office.createTask({
    title: 'перенос', description: 'x', criteria: ['a'], roleId, ...(zoneId ? { subprojectId: zoneId } : {}),
  });

  // Нестартовавшая: зона → зона → весь проект.
  const fresh = add('backend', a);
  const toB = editTask(office, fresh.id, { subprojectId: b });
  check('в очереди: зона → другая зона', toB.ok && zoneOf(fresh.id) === b && !toB.settled);
  check('перенос в ленте: откуда и куда', logged(office.say('subprojects.zone.moved', { task: fresh.id, from: nameOf(a), to: nameOf(b) })));
  const toNone = editTask(office, fresh.id, { subprojectId: 'none' });
  check('в очереди: зона → весь проект', toNone.ok && zoneOf(fresh.id) === null);
  check('перенос на весь проект в ленте',
    logged(office.say('subprojects.zone.moved', { task: fresh.id, from: nameOf(b), to: office.say('subprojects.zone.whole') })));
  check('весь проект → зона', editTask(office, fresh.id, { subprojectId: a }).ok && zoneOf(fresh.id) === a);

  // Задача плана фич.
  const plan = createPlan(office, [{
    title: 'фича', goal: 'цель', tasks: [
      { key: 'k', title: 'плановая', description: 'x', acceptanceCriteria: ['a'], roleId: 'backend', subprojectId: a },
    ],
  }]);
  const planned = [...office.tasks.values()].find((t) => t.title === 'плановая')!;
  check('задача плана заведена в фиче', plan.ok && !!planned.epicId);
  // Раздача dry-run могла её уже забрать — возвращаем в план: проверяется перенос, а не раздача.
  [...office.instances.values()].forEach((i) => { if (i.currentTaskId === planned.id) i.abort?.abort(); });
  office.updateTask(planned.id, { status: 'planned', assigneeId: null });
  check('задача плана: зона → другая зона', editTask(office, planned.id, { subprojectId: b }).ok && zoneOf(planned.id) === b);
  check('задача плана: зона → весь проект', editTask(office, planned.id, { subprojectId: 'none' }).ok && zoneOf(planned.id) === null);
  office.updateTask(planned.id, { status: 'cancelled' });

  // Роль не допущена к новой зоне.
  const pinned = add('frontend');
  check('задача закреплённой роли — в её зоне', zoneOf(pinned.id) === a);
  const denied = editTask(office, pinned.id, { subprojectId: b });
  check('роль не допущена: отказ называет допущенные роли и ничего не трогает',
    !denied.ok && denied.message.includes('backend') && denied.message.includes(nameOf(b)) && zoneOf(pinned.id) === a);
  const both = editTask(office, pinned.id, { roleId: 'backend', subprojectId: b });
  check('роль и зона одним вызовом — проходит',
    both.ok && zoneOf(pinned.id) === b && office.tasks.get(pinned.id)?.roleId === 'backend');

  // Ждавшая допуска задача после переноса больше не ждёт.
  const waiting = add('frontend');
  office.updateTask(waiting.id, { subprojectId: null, admitWait: 'некому' });
  check('перенос снимает «некому взять»',
    editTask(office, waiting.id, { subprojectId: a }).ok && office.tasks.get(waiting.id)?.admitWait === null);
  [...office.instances.values()].forEach((i) => { if (i.currentTaskId === waiting.id) i.abort?.abort(); });
  office.updateTask(waiting.id, { status: 'cancelled' });

  // assigned без сессии — как нестартовавшая.
  const assigned = add('backend', a);
  office.updateTask(assigned.id, { status: 'assigned', assigneeId: 'backend#9' });
  check('assigned без сессии: зона меняется', editTask(office, assigned.id, { subprojectId: b }).ok && zoneOf(assigned.id) === b);
  office.updateTask(assigned.id, { status: 'cancelled' });

  // Провалена после старта: ветка и рабочая копия в репозитории первой зоны.
  const failed = add('backend', a);
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  const baseBranch = git(one, 'rev-parse', '--abbrev-ref', 'HEAD');
  const branch = `task/${failed.id}`;
  const copy = resolve(base, 'move-wt', failed.id);
  git(one, 'worktree', 'add', '-q', '-b', branch, copy, baseBranch);
  git(copy, 'commit', '-q', '--allow-empty', '-m', 'наработки');
  office.updateTask(failed.id, {
    status: 'failed', repoDir: one, branch, baseBranch, worktreePath: copy,
    workerSessionId: 's-1', startedAt: 1, limitedAt: 5,
  });
  const movedFailed = editTask(office, failed.id, { subprojectId: b });
  await movedFailed.settled;
  const after = office.tasks.get(failed.id)!;
  check('failed: зона сменилась, привязка сброшена',
    movedFailed.ok && after.subprojectId === b && after.repoDir === null && after.branch === null
    && after.baseBranch === null && after.worktreePath === null && after.workerSessionId === null && after.limitedAt === null);
  check('failed: статус прежний, в ответе — restart_task',
    after.status === 'failed' && movedFailed.message.includes('restart_task') && movedFailed.message.includes(nameOf(b)));
  check('failed: репозиторий задачи — новой зоны', office.repoForTask(after) === two);
  check('failed: рабочая копия прошлой попытки снята', !existsSync(copy));
  const branches = git(one, 'branch', '--list', `${branch}*`);
  check('failed: ветка прошлой попытки в старом репозитории цела', branches.includes(`${branch}.stopped-1`));
  check('failed: в новом репозитории чужих веток нет', git(two, 'branch', '--list', `${branch}*`) === '');
  const again = await retryTask(office, failed.id, { quiet: true });
  const restarted = office.tasks.get(failed.id)!;
  check('failed: restart_task запускает в новой зоне',
    again.ok && restarted.status === 'in_progress' && restarted.subprojectId === b
    && restarted.repoDir !== one && office.repoForTask(restarted) === two);
  check('failed: ветка в старом репозитории пережила перезапуск',
    git(one, 'branch', '--list', `${branch}*`).includes(`${branch}.stopped-1`));

  // Идёт прямо сейчас — отказ с подсказкой (задача только что перезапущена).
  const live = editTask(office, failed.id, { subprojectId: a });
  check('в работе: отказ с drop_task и новой задачей',
    !live.ok && live.message.includes('drop_task') && live.message.includes('create_task') && zoneOf(failed.id) === b);
  [...office.instances.values()].forEach((i) => { if (i.currentTaskId === failed.id) i.abort?.abort(); });

  // Остановлена (blocked) без рабочей копии: хватает репозитория на задаче.
  const blocked = add('backend', a);
  office.updateTask(blocked.id, { status: 'blocked', repoDir: one, startedAt: 1 });
  const movedBlocked = editTask(office, blocked.id, { subprojectId: 'none' });
  await movedBlocked.settled;
  const freed = office.tasks.get(blocked.id)!;
  check('blocked: зона → весь проект, репозиторий отвязан',
    movedBlocked.ok && freed.subprojectId === null && freed.repoDir === null && office.repoForTask(freed) === projectDir);
  office.updateTask(blocked.id, { status: 'cancelled' });

  // На ревью и влитая.
  const inReview = add('backend', a);
  office.updateTask(inReview.id, { status: 'review', repoDir: one });
  const reviewNo = editTask(office, inReview.id, { subprojectId: b });
  check('на ревью: отказ с подсказкой',
    !reviewNo.ok && reviewNo.message.includes('drop_task') && reviewNo.message.includes('create_task') && zoneOf(inReview.id) === a);
  const merged = add('backend', a);
  office.updateTask(merged.id, { status: 'done', merged: true, repoDir: one });
  const mergedNo = editTask(office, merged.id, { subprojectId: b });
  check('влитая: отказ с подсказкой завести новую',
    !mergedNo.ok && mergedNo.message.includes('create_task') && mergedNo.message !== reviewNo.message && zoneOf(merged.id) === a);
  check('отказы есть в обоих словарях и оба называют, что делать',
    (['subprojects.zone.running', 'subprojects.zone.review'] as const).every((key) =>
      (['ru', 'en'] as const).every((lang) => t(lang, key, { task: 'T-1' }).includes('drop_task'))));
  unloadOfficeState('o-sub-move');
}

/** Менеджер меняет базу роли сам: зона, путь, сброс, отказы, идущие задачи (T-518). */
async function roleBase(): Promise<void> {
  results.push('set_role_base: менеджер меняет базу роли (T-518):');
  const one = resolve(base, 'rb-one');
  const two = resolve(base, 'rb-two');
  const plain = resolve(base, 'rb-plain');
  gitRepo(one);
  gitRepo(two);
  mkdirSync(plain, { recursive: true });
  writeFileSync(resolve(base, 'rb-file'), 'x');
  const office = openOfficeState({ id: 'o-sub-rolebase', projectDir, stateFile: resolve(base, 'rolebase.json') }).state;
  office.dryRun = true;
  const made = office.saveSubproject(undefined, { name: 'Первая', root: one, kind: 'repo', summary: '', color: 'accent-1', sharedPaths: [] });
  const a = 'id' in made ? made.id : '';
  const front = () => office.role('frontend')!;
  const lineOf = (id: string) => teamSummary(office).split('\n- ').find((l) => l.replace(/^- /, '').startsWith(`${id} (`)) ?? '';
  const events: string[] = [];
  const off = office.subscribe((e) => { events.push(e.t); });

  // Задача в работе и задача в плане — обе заведены до смены, «на весь проект».
  const running = office.createTask({ title: 'идёт', description: '', criteria: [], roleId: 'frontend' });
  office.updateTask(running.id, { status: 'in_progress', repoDir: projectDir });
  const review = office.createTask({ title: 'на ревью', description: '', criteria: [], roleId: 'frontend' });
  office.updateTask(review.id, { status: 'review', repoDir: projectDir });
  const waiting = office.createTask({ title: 'ждёт', description: '', criteria: [], roleId: 'frontend' });
  const foreign = office.createTask({ title: 'чужая', description: '', criteria: [], roleId: 'backend' });
  office.updateTask(foreign.id, { status: 'in_progress', repoDir: projectDir });

  // Начало строки ленты: «…роли frontend (…) сменил менеджер».
  const logHead = office.say('roleBase.log', { role: `frontend (${front().title})`, was: '', now: '' }).split(':')[0]!;
  const logBefore = office.log.length;
  const toZone = await setRoleBase(office, { roleId: 'frontend', subprojectId: a });
  check('на зону: роль закреплена', toZone.ok && front().subprojects?.join() === a);
  check('на зону: repoForRole — репозиторий зоны', office.repoForRole(front()) === one);
  const logged = office.log.slice(logBefore).map((l) => l.text);
  check('в ленте — кто сменил и было → стало',
    logged.some((l) => l.startsWith(logHead) && l.includes(projectDir) && l.includes(one)));
  check('клиентам ушли роли и снимок', events.includes('roles') && events.includes('snapshot'));
  check('list_team: новая зона и путь', lineOf('frontend').includes(`${office.say('prompt.team.zones')}: ${a}`) && lineOf('frontend').includes(one));
  check('list_subprojects: роль в закреплённых',
    subprojectsSummary(office).includes(office.say('subprojects.text.members', { roles: `frontend (${front().title})` })));
  check('снимок: роль среди закреплённых зоны',
    office.subprojectViews().find((v) => v.id === a)?.members.some((m) => m.id === 'frontend') === true);
  check('ответ перечисляет идущую и ревью с прежним репозиторием',
    toZone.message.includes(office.say('roleBase.running'))
    && [running, review].every((task) => toZone.message.includes(office.say('roleBase.taskRow', {
      task: task.id, title: task.title, status: task.status, dir: projectDir,
    }))));
  check('ответ не тащит чужую задачу', !toZone.message.includes(foreign.id));
  check('идущие задачи не тронуты', office.tasks.get(running.id)?.repoDir === projectDir
    && office.tasks.get(running.id)?.status === 'in_progress' && office.tasks.get(running.id)?.subprojectId === null
    && office.tasks.get(review.id)?.repoDir === projectDir);
  check('не стартовавшая в чужой зоне названа отдельно',
    toZone.message.includes(office.say('roleBase.stuck')) && toZone.message.includes(waiting.id)
    && toZone.message.split(office.say('roleBase.stuck'))[0]!.includes(waiting.id) === false);
  const fresh = office.createTask({ title: 'новая', description: '', criteria: [], roleId: 'frontend' });
  check('новая задача роли стартует в новом репозитории',
    fresh.subprojectId === a && office.repoForTask(fresh) === one);

  const baseLogs = () => office.log.filter((l) => l.text.startsWith(logHead)).length;
  const logCount = baseLogs();
  const again = await setRoleBase(office, { roleId: 'frontend', subprojectId: a });
  check('то же закрепление — «уже так», в ленту не пишем',
    again.ok && again.message.includes(one) && !again.message.includes(office.say('roleBase.running'))
    && baseLogs() === logCount);

  // Путь: зона по нему находится или заводится — как из формы роли.
  const toPath = await setRoleBase(office, { roleId: 'frontend', path: two });
  const b = office.subprojects().find((s) => s.id !== a)?.id ?? '';
  check('на путь: заведена repo-зона, роль в ней вместо прежней',
    toPath.ok && !!b && front().subprojects?.join() === b && office.repoForRole(front()) === two);
  check('на путь: ответ называет заведённую зону', toPath.message.includes(office.say('roleBase.zoneCreated', { zone: b, root: two })));
  const known = await setRoleBase(office, { roleId: 'backend', path: one });
  check('путь уже заведённой зоны — вторая не заводится',
    known.ok && office.subprojects().length === 2 && office.role('backend')?.subprojects?.join() === a
    && !known.message.includes(a + ' с корнем'));
  const both = await setRoleBase(office, { roleId: 'frontend', subprojectId: `${a}, ${b}` });
  check('список зон через запятую', both.ok && front().subprojects?.join() === `${a},${b}`
    && office.repoForRole(front()) === projectDir);

  // Сброс: `none` снимает закрепление, пустой путь возвращает в общий репозиторий.
  const none = await setRoleBase(office, { roleId: 'frontend', subprojectId: 'none' });
  check('none: закрепление снято, роль в репозитории офиса',
    none.ok && front().subprojects === undefined && office.repoForRole(front()) === projectDir
    && lineOf('frontend').includes(office.say('prompt.team.wholeProject')));
  check('после сброса застрявших задач нет', !none.message.includes(office.say('roleBase.stuck')));
  await setRoleBase(office, { roleId: 'frontend', path: two });
  const cleared = await setRoleBase(office, { roleId: 'frontend', path: '' });
  check('пустой путь: роль в общем репозитории, зоны остались',
    cleared.ok && front().subprojects === undefined && office.subprojects().length === 2);

  // Отказы: ничего не меняют и в ленту не пишут.
  await setRoleBase(office, { roleId: 'frontend', subprojectId: a });
  const zonesNow = office.subprojects().length;
  const logNow = baseLogs();
  const intact = () => front().subprojects?.join() === a && office.subprojects().length === zonesNow && baseLogs() === logNow;
  const noRole = await setRoleBase(office, { roleId: 'ghost', subprojectId: a });
  check('нет роли — отказ с её id', !noRole.ok && noRole.message === office.say('state.role.missing', { role: 'ghost' }));
  const pm = office.roles().find((r) => r.isManager)!;
  const noPm = await setRoleBase(office, { roleId: pm.id, subprojectId: a });
  check('менеджер не закрепляется', !noPm.ok && noPm.message === office.say('subprojects.err.pinManager') && pm.subprojects === undefined);
  const noZone = await setRoleBase(office, { roleId: 'frontend', subprojectId: `${a}, nope` });
  check('нет зоны — отказ с её id и списком зон', !noZone.ok && noZone.message.includes('nope') && noZone.message.includes(a) && intact());
  const missing = resolve(base, 'rb-missing');
  const noDir = await setRoleBase(office, { roleId: 'frontend', path: missing });
  check('нет папки — отказ', !noDir.ok && noDir.message === t(office.lang(), 'git.noDir', { dir: missing }) && intact());
  const file = resolve(base, 'rb-file');
  const notDir = await setRoleBase(office, { roleId: 'frontend', path: file });
  check('путь — файл, а не папка — отказ', !notDir.ok && notDir.message === t(office.lang(), 'git.notDir', { dir: file }) && intact());
  const notGit = await setRoleBase(office, { roleId: 'frontend', path: plain });
  check('папка без git — отказ', !notGit.ok && notGit.message === t(office.lang(), 'git.notRepo', { dir: plain }) && intact());
  const formSays = await office.editRole('frontend', { repoDir: plain });
  check('отказ тот же, что у формы роли', formSays.map((e) => e.message).join(' ') === notGit.message && intact());
  const twice = await setRoleBase(office, { roleId: 'frontend', subprojectId: a, path: two });
  check('зона и путь разом — отказ', !twice.ok && twice.message === office.say('roleBase.err.both') && intact());
  const nothing = await setRoleBase(office, { roleId: 'frontend' });
  const blank = await setRoleBase(office, { roleId: 'frontend', subprojectId: '', path: '' });
  check('ничего не названо — отказ, а не сброс',
    !nothing.ok && !blank.ok && blank.message === office.say('roleBase.err.neither') && intact());
  const lenient = await setRoleBase(office, { roleId: 'frontend', subprojectId: '', path: two });
  check('пустая зона рядом с путём — это путь', lenient.ok && front().subprojects?.join() === b);

  check('тексты менеджера: перезакрепить можно самому, зоны заводит владелец',
    (['ru', 'en'] as const).every((lang) =>
      t(lang, 'tool.listSubprojects.desc').includes('set_role_base')
      && t(lang, 'prompt.pm.subprojects', { zones: '' }).includes('set_role_base')
      && t(lang, 'tool.setRoleBase.desc').length > 0));
  check('в промпте менеджера с зонами — set_role_base', pmPrompt(office, true).includes('set_role_base'));
  off();
  unloadOfficeState('o-sub-rolebase');
}

/** Менеджер видит зоны: блок «Подпроекты» в промпте (§6.1). */
async function managerSeesZones(): Promise<void> {
  results.push('менеджер видит зоны: промпт, list_subprojects, сводка доски (§6.1):');
  const office = openOfficeState({ id: 'o-sub-pm', projectDir, stateFile: resolve(base, 'pm.json') }).state;
  office.dryRun = true;
  const header = office.say('subprojects.text.header');
  const plain = pmPrompt(office, true);
  check('без зон блока «Подпроекты» нет', !plain.includes(header) && !plain.includes('subprojectId'));
  check('list_subprojects без зон — «подпроектов нет»', subprojectsSummary(office) === office.say('subprojects.text.none'));
  const svc = resolve(base, 'pm-svc');
  gitRepo(svc);
  await office.editRole('frontend', { repoDir: svc });
  const zid = office.subprojects()[0]!.id;
  const prompt = pmPrompt(office, true);
  const block = prompt.slice(prompt.indexOf(header));
  check('с зоной блок есть', prompt.includes(header));
  check('в блоке id, вид и корень зоны',
    block.includes(`- ${zid}`) && block.includes(office.say('subprojects.text.kind.repo')) && block.includes(svc));
  check('в блоке закреплённая роль', block.includes(office.say('subprojects.text.members', { roles: `frontend (${office.role('frontend')!.title})` })));
  check('в блоке универсалы', block.includes(`backend (${office.role('backend')!.title})`));
  check('строка про subprojectId', block.includes('subprojectId'));
  check('в промпте нет счётчика открытых задач', !block.includes(office.say('subprojects.text.open', { n: 0 })));

  // list_subprojects: тот же список плюс открытые задачи по зоне.
  office.createTask({ title: 'открытая', description: '', criteria: [], roleId: 'frontend' });
  const closed = office.createTask({ title: 'закрытая', description: '', criteria: [], roleId: 'frontend' });
  office.updateTask(closed.id, { status: 'cancelled' });
  office.createTask({ title: 'вне зоны', description: '', criteria: [], roleId: 'backend' });
  const list = subprojectsSummary(office);
  check('list_subprojects: зона, вид и корень', list.includes(`- ${zid}`) && list.includes(svc));
  check('list_subprojects: закреплённые роли',
    list.includes(office.say('subprojects.text.members', { roles: `frontend (${office.role('frontend')!.title})` })));
  check('list_subprojects: открытых задач зоны — одна', list.includes(office.say('subprojects.text.open', { n: 1 })));

  // Сводка get_board: живые задачи по зонам; без зон — прежний вывод.
  const say = (key: Parameters<typeof office.say>[0], vars?: Parameters<typeof office.say>[1]) => office.say(key, vars);
  const input = { tasks: [...office.tasks.values()], epics: [], questions: [], autoPipeline: true };
  const plainBoard = formatBoard(input, say);
  check('сводка без зон — без групп', formatBoard({ ...input, zones: [] }, say) === plainBoard
    && !plainBoard.includes(office.say('subprojects.text.wholeProject')));
  const zoned = formatBoard({ ...input, zones: office.subprojects() }, say).split('\n');
  const at = (text: string) => zoned.findIndex((l) => l.includes(text));
  const zoneHead = at(office.say('board.zone', { zone: zid, n: 1 }));
  const wholeHead = at(office.say('board.zone', { zone: office.say('subprojects.text.wholeProject'), n: 1 }));
  check('сводка с зонами: группа зоны и группа «весь проект»', zoneHead >= 0 && wholeHead > zoneHead);
  check('задача зоны — в группе зоны', at('открытая') === zoneHead + 1);
  check('задача без зоны — в группе «весь проект»', at('вне зоны') === wholeHead + 1);
  check('закрытая задача в группы не попала', at('закрытая') < 0);
  unloadOfficeState('o-sub-pm');
}

/**
 * Последний рубеж (§3.2): startWorker не поднимает недопущенного. Места, где
 * исполнителя выбирает офис, отказывают раньше, поэтому доходим кнопкой
 * «отдать этому» — она допуск сама не сверяет.
 */
async function startWorkerGate(): Promise<void> {
  results.push('последний рубеж допуска в startWorker (§3.2):');
  const svc = resolve(base, 'gate-svc');
  gitRepo(svc);
  const office = openOfficeState({ id: 'o-sub-gate', projectDir, stateFile: resolve(base, 'gate.json') }).state;
  office.dryRun = true;
  await office.editRole('frontend', { repoDir: svc });
  const task = office.createTask({ title: 'сквозная', description: '', criteria: [], roleId: 'frontend' });
  // Как будто state.json правили руками: зона задачи — «весь проект».
  office.updateTask(task.id, { subprojectId: null });
  const inst = office.findFree('frontend') ?? office.spawn('frontend')!;
  assignDirect(office, task.id, inst.id);
  const after = office.tasks.get(task.id)!;
  const busy = [...office.instances.values()].some((i) => i.currentTaskId === task.id);
  check('недопущенный не начал: задача blocked, сотрудник свободен', after.status === 'blocked' && !busy && !after.assigneeId);
  const why = admitProblem(office, office.role('frontend')!, after);
  check('причина в карточке', !!why && !!after.result?.includes(why));
  check('причина в ленте', !!why && office.chat.some((e) => e.text.includes(why)));
  unloadOfficeState('o-sub-gate');
}

/**
 * Раздача офисом (§3.2–3.3): officeAssign, перезапуск и надзор сверяют допуск
 * роли к зоне задачи. Незакреплённому за зоной задача не уходит и остаётся в
 * очереди с причиной; повторная раздача ленту не засоряет; закреплённому —
 * уходит.
 */
async function officeAssignGate(): Promise<void> {
  results.push('раздача офисом по зоне (§3.2–3.3):');
  const svc = resolve(base, 'assign-svc');
  gitRepo(svc);
  const office = openOfficeState({ id: 'o-sub-assign', projectDir, stateFile: resolve(base, 'assign.json') }).state;
  office.dryRun = true;
  await office.editRole('frontend', { repoDir: svc });
  const zoneId = office.role('frontend')!.subprojects?.[0];
  check('frontend закреплён за зоной', !!zoneId);

  // Задача «на весь проект» для закреплённой роли — взять некому.
  const whole = office.createTask({ title: 'на весь проект', description: '', criteria: [], roleId: 'frontend' });
  office.updateTask(whole.id, { subprojectId: null });
  const first = officeAssign(office, whole.id);
  const again = officeAssign(office, whole.id);
  await retryTask(office, whole.id);
  const stuck = office.tasks.get(whole.id)!;
  check('незакреплённому не ушла: отказ, задача в backlog без исполнителя',
    !first.ok && !again.ok && stuck.status === 'backlog' && !stuck.assigneeId);
  check('очередь за слотом её не держит', !office.waitingForSlot.has(whole.id));
  check('причина записана в задаче', !!stuck.admitWait && stuck.admitWait === first.message);
  const lines = office.chat.filter((e) => e.text === stuck.admitWait).length;
  check('в ленте причина ровно один раз на три попытки', lines === 1);

  // Задача зоны для закреплённой роли — уходит, причина снимается.
  office.updateTask(whole.id, { subprojectId: zoneId ?? null });
  const ok = officeAssign(office, whole.id);
  const started = office.tasks.get(whole.id)!;
  check('закреплённому ушла', ok.ok && started.status === 'in_progress' && !!started.assigneeId);
  check('причина ожидания снята', started.admitWait === null);
  unloadOfficeState('o-sub-assign');
}

/**
 * Фича, которую некому делать (§3.3): план выпустил задачу, а допуска к зоне
 * у роли нет — фича получает hold `unstaffed`, и сводка get_board называет
 * причину в строке фичи. Допуск прошёл — причина снимается.
 */
async function unstaffedEpic(): Promise<void> {
  results.push('фича «некому делать» (§3.3):');
  const svc = resolve(base, 'unstaffed-svc');
  gitRepo(svc);
  const office = openOfficeState({ id: 'o-sub-unstaffed', projectDir, stateFile: resolve(base, 'unstaffed.json') }).state;
  office.dryRun = true;
  await office.editRole('frontend', { repoDir: svc });
  const zoneId = office.role('frontend')!.subprojects?.[0] ?? null;
  const board = () => formatBoard({
    tasks: [...office.tasks.values()], epics: [...office.epics.values()], questions: [],
    autoPipeline: office.settings.autoPipeline,
  }, (key, vars) => office.say(key, vars));

  const epic = office.createEpic({ title: 'витрина', goal: '', approved: true });
  const task = office.createTask({
    title: 'на весь проект', description: '', criteria: [], roleId: 'frontend', epicId: epic.id, status: 'planned',
  });
  office.updateTask(task.id, { subprojectId: null });
  dispatch(office);
  const held = office.epics.get(epic.id)!;
  check('задача выпущена и ждёт допуска', office.tasks.get(task.id)!.status === 'backlog' && !!office.tasks.get(task.id)!.admitWait);
  check('фича получила hold unstaffed',
    held.hold?.kind === 'unstaffed' && held.hold.tasks.join() === task.id);
  const why = office.say('plan.hold.unstaffed', { tasks: task.id });
  check('причина в строке фичи get_board', board().split('\n').some((l) => l.includes(epic.id) && l.includes(why)));

  // Допуск прошёл: задача в зоне закреплённой роли, admitGate снимает admitWait.
  office.updateTask(task.id, { subprojectId: zoneId });
  const ok = officeAssign(office, task.id);
  dispatch(office);
  check('допуск прошёл — admitWait снят', ok.ok && office.tasks.get(task.id)!.admitWait === null);
  check('hold unstaffed снят', office.epics.get(epic.id)!.hold?.kind !== 'unstaffed');
  check('в get_board причины больше нет', !board().includes(why));
  unloadOfficeState('o-sub-unstaffed');
}

/**
 * Зона в промпте одна на все блоки (T-488): правила зоны (rules.ts) и
 * оглавление её документов (docs) едут по одной и той же зоне сессии. На
 * задаче — зона задачи; вне задачи у роли двух зон зоны нет вовсе: ни брифа,
 * ни правил, ни документов какой-либо из них.
 */
function zoneSeats(): void {
  results.push('рассадка по зонам (T-499):');
  // Сетка 3×2: верхний ряд 0 1 2, нижний 3 4 5.
  const grid = [0, 1, 2, 3, 4, 5].map((index) => ({ index, x: index % 3, y: Math.floor(index / 3) }));
  check('без зон — null, рассадку не трогаем',
    zoneSeating(grid, [{ id: 'a', zone: null, desk: 0 }, { id: 'b', zone: null, desk: 5 }], ['web']) === null);
  const seats = [
    { id: 'a', zone: 'web', desk: 0 }, { id: 'b', zone: 'web', desk: 5 },
    { id: 'c', zone: 'api', desk: 2 }, { id: 'd', zone: null, desk: 1 }, { id: 'e', zone: null, desk: 4 },
  ];
  const got = zoneSeating(grid, seats, ['web', 'api'])!;
  const at = (id: string) => grid.find((d) => d.index === got.get(id))!;
  const dist = (p: string, q: string) => Math.abs(at(p).x - at(q).x) + Math.abs(at(p).y - at(q).y);
  check('закреплённые за одной зоной — на соседних столах', dist('a', 'b') === 1);
  check('кто уже в блоке своей зоны, остаётся', got.get('a') === 0 && got.get('c') === 2);
  check('незакреплённый держит свой стол, если тот не ушёл под зону', got.get('e') === 4);
  check('вытесненный незакреплённый — на свободный', got.get('d') === 3);
  check('столы не повторяются', new Set(got.values()).size === seats.length);
  const again = zoneSeating(grid, seats.map((s) => ({ ...s, desk: got.get(s.id)! })), ['web', 'api'])!;
  check('повторный расчёт никого не двигает', seats.every((s) => again.get(s.id) === got.get(s.id)));
  check('столов не хватило — лишнего нет в ответе',
    zoneSeating(grid.slice(0, 1), seats.slice(0, 2), ['web'])!.size === 1);
  check('сидит в первой существующей зоне роли',
    seatZone({ subprojects: ['gone', 'api', 'web'], isManager: false }, [zone('web', 'folder', 'w'), zone('api', 'repo', '../api')]) === 'api'
    && seatZone({ subprojects: ['api'], isManager: true }, [zone('api', 'repo', '../api')]) === null);

  // Офис целиком: без зон рассадка не меняется, с зонами — соседи, перезапуск не перемешивает.
  const open = (id: string, file: string) => openOfficeState({ id, projectDir, stateFile: file }).state;
  const desksOf = (o: ReturnType<typeof open>) =>
    JSON.stringify([...o.instances.values()].map((i) => [i.id, i.desk.index]).sort());
  const plain = open('o-seat-plain', resolve(base, 'seat-plain.json'));
  const before = desksOf(plain);
  plain.updateRole('backend', { title: 'Бэкенд' });
  check('офис без зон: правка роли не двигает ни одного стола', desksOf(plain) === before);
  const plainFile = resolve(base, 'seat-plain-2.json');
  const plainSnap = plain.toPersisted();
  save(plainFile, () => plainSnap);
  flushAll();
  const plainAgain = open('o-seat-plain-2', plainFile);
  check('офис без зон: перезапуск не перемешивает столы', desksOf(plainAgain) === before);

  const withZones = plain.toPersisted() as Persisted & { subprojects?: unknown };
  withZones.subprojects = [zone('web', 'folder', 'apps/web'), zone('api', 'folder', 'apps/api')];
  const zonedFile = resolve(base, 'seat-zoned.json');
  save(zonedFile, () => withZones);
  flushAll();
  const zoned = open('o-seat-zoned', zonedFile);
  check('зоны появились, но закреплений нет — столы прежние', desksOf(zoned) === before);
  const staff = [...zoned.instances.values()].filter((i) => !zoned.role(i.roleId)?.isManager);
  // Трое из разных концов комнаты: им есть куда съезжаться.
  const pinned = [staff[0], staff[3], staff[staff.length - 1]].map((i) => i.roleId);
  const scattered = JSON.stringify(pinned.map((r) => zoned.staffOf(r)[0].desk.index));
  const pm = [...zoned.instances.values()].find((i) => zoned.role(i.roleId)?.isManager)!;
  const pmDesk = pm.desk.index;
  for (const r of pinned) zoned.updateRole(r, { subprojects: ['web', 'api'] } as never);
  check('закрепления легли в роли', pinned.every((r) => seatZone(zoned.role(r), zoned.subprojects()) === 'web'));
  const seatsOf = (ids: string[]) => ids.map((r) => zoned.staffOf(r)[0].desk);
  const block = seatsOf(pinned);
  check('закреплённых пересадили', JSON.stringify(block.map((d) => d.index)) !== scattered);
  const deskSet = new Set([...zoned.instances.values()].map((i) => i.desk.index));
  // Соседство: каждый закреплённый в шаге от кого-то из своих — на сетке
  // раскладки ближе стола, чем у ближайшего соседа вообще, не бывает.
  const all = [...zoned.instances.values()].map((i) => i.desk);
  const step = Math.min(...all.flatMap((p) => all.filter((q) => q !== p)
    .map((q) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y))));
  const near = block.every((p) => block.some((q) => q !== p && Math.abs(p.x - q.x) + Math.abs(p.y - q.y) <= step));
  check('закреплённые за зоной (первой из списка) — на соседних столах', near);
  check('после пересадки столы не повторяются', deskSet.size === zoned.instances.size);
  check('менеджер остался за своим столом', pm.desk.index === pmDesk);
  const arranged = desksOf(zoned);
  zoned.updateRole(staff[0].roleId, { title: 'Переименован' });
  check('правка без смены закреплений никого не двигает', desksOf(zoned) === arranged);
  const zonedFile2 = resolve(base, 'seat-zoned-2.json');
  const zonedSnap = zoned.toPersisted();
  save(zonedFile2, () => zonedSnap);
  flushAll();
  const zonedAgain = open('o-seat-zoned-2', zonedFile2);
  check('офис с зонами: перезапуск не перемешивает столы', desksOf(zonedAgain) === arranged);

  for (const id of ['o-seat-plain', 'o-seat-plain-2', 'o-seat-zoned', 'o-seat-zoned-2']) unloadOfficeState(id);
}

function zoneInWorkerPrompt(): void {
  results.push('зона в промпте исполнителя: правила и документы вместе (T-488):');
  const dir = resolve(base, 'prompt-zone');
  mkdirSync(resolve(dir, 'srv'), { recursive: true });
  mkdirSync(resolve(dir, 'web'), { recursive: true });
  const office = openOfficeState({ id: 'o-sub-prompt', projectDir: dir, stateFile: resolve(base, 'prompt.json') }).state;
  office.dryRun = true;
  office.subprojects().push(zone('srv', 'folder', 'srv'), zone('web', 'folder', 'web'));
  writeFileSync(resolve(dir, 'srv/OFFICE.md'), 'Бриф зоны srv.\n');
  writeFileSync(resolve(dir, 'web/OFFICE.md'), 'Бриф зоны web.\n');
  addRule(office, 'sub:srv', 'Правило зоны srv');
  addRule(office, 'sub:web', 'Правило зоны web');
  createDoc(office, { title: 'Документ зоны srv', kind: 'working', subprojectId: 'srv', author: 'backend' });
  createDoc(office, { title: 'Документ зоны web', kind: 'working', subprojectId: 'web', author: 'frontend' });
  const be = office.role('backend')!;

  const onTask = workerSystemPrompt(be, office, 'srv');
  check('на задаче зоны: правила зоны в промпте', onTask.includes('Правило зоны srv'));
  check('на задаче зоны: документы зоны в промпте', onTask.includes('Документ зоны srv'));
  check('на задаче зоны: бриф зоны в промпте', onTask.includes('Бриф зоны srv.'));
  check('на задаче зоны: чужой зоны нет',
    !onTask.includes('Правило зоны web') && !onTask.includes('Документ зоны web') && !onTask.includes('Бриф зоны web.'));

  be.subprojects = ['srv'];
  const sole = workerSystemPrompt(be, office);
  check('вне задачи, одна зона: её правила, документы и бриф',
    sole.includes('Правило зоны srv') && sole.includes('Документ зоны srv') && sole.includes('Бриф зоны srv.')
    && !sole.includes('Документ зоны web'));

  be.subprojects = ['srv', 'web'];
  const two = workerSystemPrompt(be, office);
  for (const id of ['srv', 'web']) {
    check(`вне задачи, две зоны: нет брифа зоны ${id}`, !two.includes(`Бриф зоны ${id}.`));
    check(`вне задачи, две зоны: нет правил зоны ${id}`, !two.includes(`Правило зоны ${id}`));
  }
  // Без зоны оглавление — как у задачи «весь проект» (spec подпроектов §4.2):
  // целиком, с подписью зоны в строке, а не оглавление какой-то из зон.
  const whole = docIndexForPrompt(office, PROMPT_INDEX_CHARS, null);
  check('вне задачи, две зоны: оглавление документов не сужено ни до одной зоны',
    two.includes(whole) && !two.includes(docIndexForPrompt(office, PROMPT_INDEX_CHARS, 'srv'))
    && !two.includes(docIndexForPrompt(office, PROMPT_INDEX_CHARS, 'web')));
  be.subprojects = [];
  unloadOfficeState('o-sub-prompt');
}

/**
 * Команда save_subproject (T-480): обработчик в index.ts зовёт ровно
 * state.saveSubproject, поэтому проверяем его на временном офисе. Зоны обоих
 * видов, переживание перезагрузки из файла, ошибки полей.
 */
function saveSubprojectCommand(): void {
  results.push('команда save_subproject (T-480):');
  const dir = resolve(base, 'cmd-office');
  mkdirSync(resolve(dir, 'apps/web/src'), { recursive: true });
  mkdirSync(resolve(dir, 'apps/admin'), { recursive: true });
  gitRepo(resolve(base, 'cmd-api'));
  const file = resolve(base, 'cmd.json');
  const open = () => openOfficeState({ id: 'o-sub-cmd', projectDir: dir, stateFile: file }).state;
  const office = open();
  const draft = (name: string, root: string, extra: Partial<SubprojectDraft> = {}): SubprojectDraft =>
    ({ name, root, summary: '', color: 'accent-2', sharedPaths: [], ...extra });

  const web = office.saveSubproject(undefined, draft('Веб', 'apps/web', { summary: ' витрина ', sharedPaths: ['package.json', ' ', 'package.json'] }));
  const webId = 'id' in web ? web.id : '';
  const webZone = () => office.subproject(webId);
  check('зона-папка заведена', !!webId && webZone()?.kind === 'folder' && webZone()?.root === 'apps/web'
    && webZone()?.name === 'Веб' && webZone()?.summary === 'витрина' && webZone()?.color === 'accent-2');
  check('зона-папка: общие пути без пустых и повторов', webZone()?.sharedPaths?.join() === 'package.json');
  const api = office.saveSubproject(undefined, draft('API', '../cmd-api'));
  const apiId = 'id' in api ? api.id : '';
  check('зона-репозиторий заведена по пути вне офиса',
    !!apiId && office.subproject(apiId)?.kind === 'repo' && office.subproject(apiId)?.root === '../cmd-api'
    && office.subproject(apiId)?.sharedPaths === undefined);
  check('обе зоны в state.subprojects', office.subprojects().map((s) => s.id).join() === `${webId},${apiId}`);

  // Правка имени: id не меняется, остальные поля из черновика.
  const renamed = office.saveSubproject(webId, draft('Витрина', 'apps/web'));
  check('правка имени: тот же id, новое имя', 'id' in renamed && renamed.id === webId && webZone()?.name === 'Витрина'
    && office.subprojects().length === 2);
  const same = office.saveSubproject(webId, draft('витрина', 'apps/web'));
  check('своё же имя в другом регистре — не повтор', 'id' in same);

  const fieldOf = (got: ReturnType<typeof office.saveSubproject>) => ('field' in got ? got.field : 'ok');
  const dupNew = office.saveSubproject(undefined, draft(' api ', 'apps/admin'));
  check('новая зона с занятым именем — ошибка поля name', fieldOf(dupNew) === 'name'
    && 'message' in dupNew && dupNew.message === office.say('subprojects.err.nameTaken'));
  check('правка в занятое имя — ошибка поля name', fieldOf(office.saveSubproject(webId, draft('API', 'apps/web'))) === 'name'
    && webZone()?.name === 'витрина');
  check('пустое имя — ошибка поля name', fieldOf(office.saveSubproject(undefined, draft('  ', 'apps/admin'))) === 'name');
  check('пустой корень — ошибка поля root', fieldOf(office.saveSubproject(undefined, draft('Пусто', ' '))) === 'root');
  check('тот же корень второй зоной — ошибка поля root',
    fieldOf(office.saveSubproject(undefined, draft('Дубль', 'apps/web/'))) === 'root');
  const outer = office.saveSubproject(undefined, draft('Приложения', 'apps'));
  check('корень поверх чужой зоны — ошибка поля root', fieldOf(outer) === 'root' && !!('message' in outer && outer.message));
  check('корень внутри чужой зоны — ошибка поля root',
    fieldOf(office.saveSubproject(undefined, draft('Исходники', 'apps/web/src'))) === 'root');
  check('папка вне офиса явным видом folder — ошибка поля root',
    fieldOf(office.saveSubproject(undefined, draft('Чужая', '../cmd-api', { kind: 'folder' }))) === 'root');
  check('корень самого офиса — ошибка поля root',
    fieldOf(office.saveSubproject(undefined, draft('Всё', dir, { kind: 'repo' }))) === 'root');
  check('общий путь за пределы репозитория — ошибка поля sharedPaths',
    fieldOf(office.saveSubproject(undefined, draft('Админка', 'apps/admin', { sharedPaths: ['../x'] }))) === 'sharedPaths');
  check('неизвестный id — ошибка без поля', fieldOf(office.saveSubproject('nope', draft('Нет', 'apps/admin'))) === null);
  check('отказы зон не завели', office.subprojects().length === 2);
  const admin = office.saveSubproject(undefined, draft('Админка', 'apps/admin'));
  check('правка зоны на корень поверх соседней — ошибка поля root, корень прежний',
    'id' in admin && fieldOf(office.saveSubproject(webId, draft('витрина', 'apps'))) === 'root' && webZone()?.root === 'apps/web');

  // Переживает перезагрузку из файла.
  // Порядок ключей после разбора сохранения другой — сравниваем по значению.
  const norm = (subs: Subproject[]) => JSON.stringify(subs.map((z) => Object.fromEntries(Object.entries(z).sort())));
  const before = norm(office.subprojects());
  flushAll();
  unloadOfficeState('o-sub-cmd');
  const again = open();
  check('после перезагрузки зоны те же', again.subprojects().length === 3 && norm(again.subprojects()) === before);
  unloadOfficeState('o-sub-cmd');
}

/**
 * Команда delete_subproject (T-498): с открытыми задачами — отказ с их
 * числом; без них — зона уходит, закрепления ролей снимаются.
 */
async function deleteSubprojectCommand(): Promise<void> {
  results.push('команда delete_subproject (T-498):');
  const dir = resolve(base, 'del-office');
  mkdirSync(resolve(dir, 'web'), { recursive: true });
  mkdirSync(resolve(dir, 'srv'), { recursive: true });
  const file = resolve(base, 'del.json');
  const office = openOfficeState({ id: 'o-sub-del', projectDir: dir, stateFile: file }).state;
  office.dryRun = true;
  const make = (name: string, root: string) => {
    const got = office.saveSubproject(undefined, { name, root, summary: '', color: 'accent-1', sharedPaths: [] });
    return 'id' in got ? got.id : '';
  };
  const web = make('web', 'web');
  const srv = make('srv', 'srv');
  await office.editRole('frontend', { subprojects: [web, srv] });
  await office.editRole('backend', { subprojects: [web] });
  const t1 = office.createTask({ title: 'раз', description: '', criteria: [], roleId: 'frontend', subprojectId: web });
  office.createTask({ title: 'два', description: '', criteria: [], roleId: 'backend', subprojectId: web });
  const closed = office.createTask({ title: 'закрыта', description: '', criteria: [], roleId: 'backend', subprojectId: web });
  office.updateTask(closed.id, { status: 'done' });

  const refused = office.deleteSubproject(web);
  check('с открытыми задачами — отказ, число задач в причине',
    'message' in refused && refused.message === office.say('subprojects.err.hasOpen', { name: 'web', n: 2 }));
  check('после отказа зона и закрепления на месте',
    !!office.subproject(web) && office.role('frontend')?.subprojects?.join() === `${web},${srv}`);
  office.updateTask(t1.id, { status: 'cancelled' });
  const one = office.deleteSubproject(web);
  check('одна открытая — в причине одна',
    'message' in one && one.message === office.say('subprojects.err.hasOpen', { name: 'web', n: 1 }));
  for (const task of office.tasks.values()) {
    if (task.subprojectId === web && task.status !== 'done' && task.status !== 'cancelled') {
      office.updateTask(task.id, { status: 'done' });
    }
  }
  const ok = office.deleteSubproject(web);
  check('без открытых задач — удалена', 'id' in ok && ok.id === web && !office.subproject(web)
    && office.subprojects().map((s) => s.id).join() === srv);
  check('закрепление снято, чужая зона роли осталась', office.role('frontend')?.subprojects?.join() === srv);
  check('роль без других зон — поля subprojects нет', office.role('backend')?.subprojects === undefined);
  check('неизвестная зона — отказ', 'message' in office.deleteSubproject(web));
  flushAll();
  unloadOfficeState('o-sub-del');
  const again = openOfficeState({ id: 'o-sub-del', projectDir: dir, stateFile: file }).state;
  check('после перезагрузки удаление и снятые закрепления сохранились',
    again.subprojects().map((s) => s.id).join() === srv && again.role('frontend')?.subprojects?.join() === srv
    && again.role('backend')?.subprojects === undefined);
  unloadOfficeState('o-sub-del');
}

/** update_role с patch.subprojects (T-494): закрепить, снять; менеджера — нельзя. */
async function pinRoleCommand(): Promise<void> {
  results.push('update_role с patch.subprojects (T-494):');
  const dir = resolve(base, 'pin-office');
  mkdirSync(resolve(dir, 'web'), { recursive: true });
  mkdirSync(resolve(dir, 'srv'), { recursive: true });
  const file = resolve(base, 'pin.json');
  const office = openOfficeState({ id: 'o-sub-pin', projectDir: dir, stateFile: file }).state;
  const make = (name: string) => {
    const got = office.saveSubproject(undefined, { name, root: name, summary: '', color: 'accent-1', sharedPaths: [] });
    return 'id' in got ? got.id : '';
  };
  const web = make('web');
  const srv = make('srv');
  const pins = (id: string) => office.role(id)?.subprojects;

  const set = await office.editRole('frontend', { subprojects: [web, srv] });
  check('закрепление за двумя зонами', set.length === 0 && pins('frontend')?.join() === `${web},${srv}`);
  check('правка не завела и не тронула зон', office.subprojects().length === 2);
  await office.editRole('frontend', { subprojects: [web, web] });
  check('повтор id в списке схлопнут', pins('frontend')?.join() === web);
  const off = await office.editRole('frontend', { subprojects: [] });
  check('пустой список снимает закрепление — поля нет', off.length === 0 && pins('frontend') === undefined);

  // Веб видит закрепление только через RoleView (T-584): без поля карточка
  // считает роль «весь проект», и следующий клик заменял бы прежнюю зону.
  const view = (id: string) => office.roleViews().find((r) => r.id === id);
  const sent: string[][] = [];
  const unsub = office.subscribe((e) => {
    if (e.t === 'roles') sent.push(e.roles.find((r) => r.id === 'frontend')?.subprojects ?? []);
  });
  await office.editRole('frontend', { subprojects: [web] });
  check('roleViews отдаёт закрепление роли', view('frontend')?.subprojects?.join() === web);
  check('после update_role разослано событие roles с закреплением', sent.at(-1)?.join() === web);
  await office.editRole('frontend', { subprojects: [...(view('frontend')?.subprojects ?? []), srv] });
  check('второй клик по виду добавляет зону, а не заменяет',
    view('frontend')?.subprojects?.join() === `${web},${srv}` && sent.at(-1)?.join() === `${web},${srv}`);
  await office.editRole('frontend', { subprojects: [] });
  check('снятое закрепление — в виде поля нет', view('frontend')?.subprojects === undefined && sent.at(-1)?.length === 0);
  check('у незакреплённой роли в виде поля нет', view('backend')?.subprojects === undefined);
  unsub();

  const unknown = await office.editRole('frontend', { subprojects: ['nope'] });
  check('неизвестная зона — ошибка поля subprojects, роль не тронута',
    unknown.some((e) => e.field === 'subprojects') && pins('frontend') === undefined);
  const junk = await office.editRole('frontend', { subprojects: 'web' as unknown as string[] });
  check('не список — ошибка поля subprojects', junk.some((e) => e.field === 'subprojects') && pins('frontend') === undefined);

  // Роль из пакета: закрепление живёт оверрайдом ссылки и тоже снимается.
  const pkg = loadPackage('@office/backend');
  const before = new Set(office.roles().map((r) => r.id));
  if (pkg) office.hireFromPackage(pkg, null);
  const hired = office.roles().find((r) => !before.has(r.id) && r.package);
  if (hired) {
    await office.editRole(hired.id, { subprojects: [srv] });
    check('роль из пакета закреплена', pins(hired.id)?.join() === srv);
    await office.editRole(hired.id, { subprojects: [] });
    check('роль из пакета: закрепление снято', !pins(hired.id)?.length
      && office.role(hired.id)?.package?.overrides.subprojects === undefined);
  } else check('нанята роль из пакета @office/backend', false);

  const pm = office.roles().find((r) => r.isManager)!;
  const pmErr = await office.editRole(pm.id, { subprojects: [web] });
  check('менеджера закрепить нельзя — ошибка поля subprojects',
    pmErr.some((e) => e.field === 'subprojects') && !pins(pm.id)?.length);
  check('менеджеру можно прислать пустой список', (await office.editRole(pm.id, { subprojects: [] })).length === 0);

  await office.editRole('backend', { subprojects: [srv] });
  flushAll();
  unloadOfficeState('o-sub-pin');
  const again = openOfficeState({ id: 'o-sub-pin', projectDir: dir, stateFile: file }).state;
  check('после перезагрузки закрепление то же', again.role('backend')?.subprojects?.join() === srv
    && again.role('frontend')?.subprojects === undefined);
  check('после перезагрузки закрепление видно и в roleViews',
    again.roleViews().find((r) => r.id === 'backend')?.subprojects?.join() === srv);
  unloadOfficeState('o-sub-pin');
}

try {
  saveSubprojectCommand();
  await deleteSubprojectCommand();
  await pinRoleCommand();
  zoneInWorkerPrompt();
  zoneSeats();
  pureRules();
  admission();
  pickZone();
  consultPlace();
  repoDirReply();
  zoneBoundary();
  pureMigration();
  pureEnsureZone();
  officeMigration();
  await officeZones();
  await startWorkerGate();
  await managerTools();
  await moveTaskZone();
  await managerSeesZones();
  await roleBase();
  await officeAssignGate();
  await unstaffedEpic();
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log(results.join('\n'));
const failed = results.filter((r) => r.includes('❌'));
console.log(failed.length ? `ПРОВАЛОВ: ${failed.length}` : 'ВСЕ ПРОВЕРКИ ПРОШЛИ');
process.exit(failed.length ? 1 : 0);

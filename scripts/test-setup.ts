/**
 * Проверки мастера нового офиса (docs/design/office-setup/spec.md) без сети
 * и без токенов: разбор плана, сборка офиса по шагам — корень, папки ролей
 * с git, запись в реестре, найм с рабочими местами, настройки команды,
 * направление владельца — и то, что упавший шаг не роняет остальное.
 *
 * Офис здесь открывается тем же `openOfficeState`, что и на сервере, но без
 * git-инициализации корня и надзора: они к мастеру отношения не имеют и
 * проверяются в test:offices.
 *
 * Запуск: npm run test:setup
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { OfficeSetupPlan, SetupStep } from '../src/shared/types';
import { slugify } from '../src/shared/slug';
import { getOffice, openOfficeState } from '../src/server/state';
import { loadRegistry, offices } from '../src/server/offices';
import { buildOffice, planProblem, setupCatalog } from '../src/server/setup';
import { loadPackage } from '../src/server/packages';

process.env.OFFICE_LANG = 'ru';

const ROOT = resolve(tmpdir(), `office-setup-test-${process.pid}`);
const STATE_FILE = resolve(ROOT, 'state.json');
const PARENT = resolve(ROOT, 'projects');
const EXISTING = resolve(ROOT, 'existing-repo');

const results: string[] = [];
const check = (text: string, ok: boolean): void => { results.push(`${text}: ${ok}`); };

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const isRepoWithCommits = (dir: string): boolean => {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true' && Boolean(git(dir, ['rev-parse', 'HEAD']));
  } catch {
    return false;
  }
};

/** Открытие как на сервере, но без git корня и надзора. */
const hooks = (steps: SetupStep[][]) => ({
  open: async (entry: Parameters<typeof openOfficeState>[0]) => { openOfficeState(entry); },
  state: getOffice,
  progress: (s: SetupStep[]) => { steps.push(s); },
});

const plan = (patch: Partial<OfficeSetupPlan>): OfficeSetupPlan => ({
  name: 'Витрина', description: '', where: { mode: 'none' }, team: [], teamPackage: null, ...patch,
});

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(PARENT, { recursive: true });
  mkdirSync(EXISTING, { recursive: true });
  writeFileSync(resolve(EXISTING, 'README.md'), 'x');
  git(EXISTING, ['init', '-q', '-b', 'main']);
  git(EXISTING, ['add', '-A']);
  git(EXISTING, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);

  // Реестр — в песочнице: рабочие офисы трогать нельзя. Корень офисов без
  // проекта тоже уводим сюда: иначе проверка писала бы в ~/Office.
  process.env.HOME = ROOT;
  loadRegistry(PARENT, STATE_FILE);

  // 1. Slug: кириллица транслитерируется, мусор — дефисами, пусто — запас.
  check('slug: кириллица и пробелы', slugify('Мой Новый Проект') === 'moy-novyy-proekt');
  check('slug: пусто — запас', slugify('!!!') === 'project');
  check('slug: латиница с точками', slugify('My.App v2') === 'my-app-v2');

  // 2. Разбор плана: что должно отказать до диска.
  check('план: без имени — отказ', planProblem(plan({ name: ' ' }), 'ru') !== null);
  check('план: новая папка с плохим именем — отказ',
    planProblem(plan({ where: { mode: 'new', parent: PARENT, folder: '../x' } }), 'ru') !== null);
  check('план: участник с нулём сотрудников — отказ',
    planProblem(plan({ team: [{ package: '@office/backend', count: 0, workspace: { kind: 'root' } }] }), 'ru') !== null);
  check('план: своя папка без имени — отказ',
    planProblem(plan({ team: [{ package: '@office/backend', count: 1, workspace: { kind: 'folder', name: '' } }] }), 'ru') !== null);
  check('план: годный — без замечаний',
    planProblem(plan({ where: { mode: 'new', parent: PARENT, folder: 'shop' }, team: [{ package: '@office/backend', count: 2, workspace: { kind: 'folder', name: 'backend' } }] }), 'ru') === null);

  // 3. Манифест команды: рабочее место участника читается и проверяется.
  const devTeam = loadPackage('@office/dev-team');
  check('dev-team: у бэкенда рабочее место backend',
    devTeam?.manifest.members.find((m) => m.package === '@office/backend')?.workspace === 'backend');
  check('dev-team: у дизайнера — общий корень',
    devTeam?.manifest.members.find((m) => m.package === '@office/design')?.workspace === '');

  // 4. Витрина: агенты и команды, менеджер помечен, корень по умолчанию свой.
  const catalog = await setupCatalog('ru');
  check('витрина: есть агенты и команда',
    catalog.packages.some((p) => p.kind === 'agent' && !p.manager) && catalog.packages.some((p) => p.kind === 'team'));
  check('витрина: у участника команды есть рабочее место',
    catalog.packages.find((p) => p.name === '@office/dev-team')?.members.some((m) => m.workspace === 'frontend') === true);
  check('витрина: корень без проекта — под HOME', catalog.defaultRoot.startsWith(ROOT));

  // 5. Новый проект с несколькими репозиториями: сценарий из спеки §4.
  const steps1: SetupStep[][] = [];
  const made1 = await buildOffice(plan({
    name: 'Магазин',
    description: 'Интернет-магазин с каталогом и корзиной',
    where: { mode: 'new', parent: PARENT, folder: 'shop' },
    team: [
      { package: '@office/backend', count: 2, workspace: { kind: 'folder', name: 'backend' } },
      { package: '@office/frontend', count: 1, workspace: { kind: 'folder', name: 'frontend' } },
      { package: '@office/design', count: 1, workspace: { kind: 'root' } },
      { package: '@office/pm', count: 1, workspace: { kind: 'root' } },
    ],
    teamPackage: '@office/dev-team',
  }), 'ru', hooks(steps1));
  check('сборка: офис создан', 'officeId' in made1);
  if ('officeId' in made1) {
    const root = resolve(PARENT, 'shop');
    const entry = offices().find((o) => o.id === made1.officeId)!;
    check('сборка: корень — новая папка внутри родителя', entry.projectDir === root && existsSync(root));
    check('сборка: корень помечен своим (git init при открытии)', entry.initGit === true);
    check('сборка: папки ролей — репозитории с коммитом',
      isRepoWithCommits(resolve(root, 'backend')) && isRepoWithCommits(resolve(root, 'frontend')));
    const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
    check('сборка: вложенные репозитории в .gitignore корня', ignore.includes('/backend/') && ignore.includes('/frontend/'));

    const state = getOffice(made1.officeId);
    const roles = state.roles().filter((r) => !r.archived);
    const backends = roles.filter((r) => r.package?.name === '@office/backend');
    check('команда: два бэкендера, у обоих repoDir backend',
      backends.length === 2 && backends.every((r) => r.repoDir === 'backend'));
    check('команда: у фронтенда repoDir frontend',
      roles.find((r) => r.package?.name === '@office/frontend')?.repoDir === 'frontend');
    check('команда: дизайнер в общем корне', !roles.find((r) => r.package?.name === '@office/design')?.repoDir);
    check('команда: менеджер один', roles.filter((r) => r.isManager).length === 1);
    check('команда: набор по умолчанию не нанят (нет юриста и SMM)',
      !roles.some((r) => r.package?.name === '@office/legal' || r.package?.name === '@office/smm'));
    check('команда: все нанятые сидят за столами',
      roles.every((r) => r.isManager || state.staffOf(r.id).length === 1));
    check('команда: repoFor бэкендера — внутри корня', state.repoFor(backends[0]) === resolve(root, 'backend'));
    check('настройки команды применены: конвейер ревью включён', state.settings.autoPipeline === true);
    check('направление: описание стало направлением владельца',
      state.directionList().some((d) => d.text.startsWith('Интернет-магазин')));
    const last = steps1[steps1.length - 1];
    check('прогресс: все шаги done', last.length > 0 && last.every((s) => s.status === 'done'));
    check('прогресс: шаг менеджера — «уже есть», а не найм',
      last.find((s) => s.id === 'hire:@office/pm')?.status === 'done');
    check('лента: запись о сборке', state.log.some((l) => l.text.includes('собран мастером')));
  }

  // 6. Занятая папка — отказ без офиса: это существующий проект, а не новый.
  const steps2: SetupStep[][] = [];
  const before = offices().length;
  const made2 = await buildOffice(plan({ name: 'Дубль', where: { mode: 'new', parent: PARENT, folder: 'shop' } }), 'ru', hooks(steps2));
  check('занятая папка: отказ', 'error' in made2 && made2.error.includes('уже есть'));
  check('занятая папка: офиса в реестре не появилось', offices().length === before);
  check('занятая папка: шаг корня — failed', steps2[steps2.length - 1]?.[0]?.status === 'failed');

  // 7. Без проекта: корень под HOME/Office со slug; повтор имени — суффикс.
  const made3 = await buildOffice(plan({ name: 'Витрина' }), 'ru', hooks([]));
  const made4 = await buildOffice(plan({ name: 'Витрина' }), 'ru', hooks([]));
  check('без проекта: корень ~/Office/<slug>',
    'officeId' in made3 && offices().find((o) => o.id === made3.officeId)?.projectDir === resolve(ROOT, 'Office', 'vitrina'));
  check('без проекта: помечен noProject',
    'officeId' in made3 && offices().find((o) => o.id === made3.officeId)?.noProject === true);
  check('без проекта: второй с тем же именем — другой корень',
    'officeId' in made4 && offices().find((o) => o.id === made4.officeId)?.projectDir === resolve(ROOT, 'Office', 'vitrina-2'));
  if ('officeId' in made3) {
    const roles = getOffice(made3.officeId).roles().filter((r) => !r.archived);
    check('без проекта и без команды: только менеджер', roles.length === 1 && roles[0].isManager);
  }

  // 8. Существующая папка: не трогаем; роль с готовым путём проверяется, а
  //    роль с несуществующим — нанимается, но шаг помечен упавшим.
  const steps5: SetupStep[][] = [];
  const made5 = await buildOffice(plan({
    name: 'Готовый',
    where: { mode: 'existing', dir: EXISTING },
    team: [
      { package: '@office/backend', count: 1, workspace: { kind: 'path', dir: EXISTING } },
      { package: '@office/frontend', count: 1, workspace: { kind: 'path', dir: resolve(ROOT, 'nowhere') } },
      { package: '@nope/missing', count: 1, workspace: { kind: 'root' } },
    ],
  }), 'ru', hooks(steps5));
  check('существующая: офис создан', 'officeId' in made5);
  if ('officeId' in made5) {
    const entry = offices().find((o) => o.id === made5.officeId)!;
    check('существующая: корень чужой, git init не планируется', entry.initGit !== true);
    check('существующая: .gitignore не дописан', !existsSync(resolve(EXISTING, '.gitignore')));
    const state = getOffice(made5.officeId);
    const last = steps5[steps5.length - 1];
    check('готовый путь: бэкенд нанят с абсолютным repoDir',
      state.roles().find((r) => r.package?.name === '@office/backend')?.repoDir === EXISTING
      && last.find((s) => s.id === 'hire:@office/backend')?.status === 'done');
    check('плохой путь: фронтенд нанят, но шаг failed',
      state.roles().some((r) => r.package?.name === '@office/frontend')
      && last.find((s) => s.id === 'hire:@office/frontend')?.status === 'failed');
    check('нет пакета: шаг failed, остальные не пострадали',
      last.find((s) => s.id === 'hire:@nope/missing')?.status === 'failed');
    check('лента: упавшие шаги записаны', state.log.filter((l) => l.text.includes('не удался')).length === 2);
  }

  const failed = results.filter((r) => r.endsWith('false'));
  console.log(results.join('\n'));
  console.log(failed.length ? `\n❌ ${failed.length} проверок упало` : '\n✅ все проверки прошли');
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});

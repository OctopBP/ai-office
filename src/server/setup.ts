/**
 * Мастер нового офиса: витрина для шагов «Где» и «Кто» и сборка офиса по
 * плану — корень, папки ролей, запись в реестре, открытие, найм, направление.
 * Спека docs/design/office-setup/spec.md.
 *
 * Сборка идёт шагами с прогрессом просившему. Шаг может упасть, и офис при
 * этом не теряется: не поставился пакет — остальные нанимаются, не завёлся
 * репозиторий роли — роль нанята, а в ленте офиса лежит, что не вышло. Без
 * офиса остаются только два случая: не удалось завести корень и не удалось
 * открыть офис.
 *
 * Мастер создаёт контейнеры, а не код: папки, git, README, `.gitignore`.
 * Scaffold фреймворка — первая задача команды.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Lang } from '../shared/i18n';
import { slugify } from '../shared/slug';
import {
  MAX_HIRE_COUNT, type OfficeSetupPlan, type SetupCatalog, type SetupStep, type SetupWorkspace,
} from '../shared/types';
import { initRepo, isRepo, repoProblem } from './git';
import { t } from './i18n';
import { catalogPackages, ensureInstalled, installedPackage } from './market';
import { createOffice, defaultRoot, expandHome, offices, type OfficeEntry } from './offices';
import { FOLDER_NAME_RE, PACKAGE_NAME_RE, type TeamSettings } from './packages';
import { folderPickerAvailable } from './pickfolder';
import type { OfficeState } from './state';

/** Что сборке нужно снаружи: поднять офис и доставить прогресс. */
export interface SetupHooks {
  /** Открыть офис по записи реестра — тем же путём, что и вход из меню. */
  open: (entry: OfficeEntry) => Promise<void>;
  state: (officeId: string) => OfficeState;
  progress: (steps: SetupStep[]) => void;
}

export type SetupResult = { officeId: string } | { error: string };

// -------------------------------------------------------------- витрина

/**
 * Витрина мастера: те же карточки, что в маркете, без ролей офиса — офиса ещё
 * нет. Родители папок недавних офисов — подсказка, куда класть новый проект.
 */
export async function setupCatalog(lang: Lang): Promise<SetupCatalog> {
  const { packages } = await catalogPackages(lang);
  const parents: string[] = [];
  const list = [...offices()].filter((o) => !o.hidden && !o.noProject)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  for (const o of list) {
    const parent = dirname(o.projectDir);
    if (!parents.includes(parent)) parents.push(parent);
  }
  return { packages, recentParents: parents.slice(0, 5), defaultRoot: defaultRoot(), folderPicker: folderPickerAvailable() };
}

// --------------------------------------------------------------- проверка

/**
 * Проверить план до того, как что-то трогать на диске. Возвращает текст
 * отказа или null. Проверяется форма плана, а не состояние диска: занята ли
 * папка, есть ли родитель — это выясняется шагом сборки, и там же говорится.
 */
export function planProblem(plan: OfficeSetupPlan, lang: Lang): string | null {
  if (!plan || typeof plan !== 'object') return t(lang, 'setup.error.plan');
  if (!String(plan.name ?? '').trim()) return t(lang, 'setup.error.name');
  const where = plan.where;
  if (!where || typeof where !== 'object') return t(lang, 'setup.error.plan');
  if (where.mode === 'existing') {
    if (!String(where.dir ?? '').trim()) return t(lang, 'offices.needDir');
  } else if (where.mode === 'new') {
    if (!String(where.parent ?? '').trim()) return t(lang, 'setup.error.parent');
    if (!FOLDER_NAME_RE.test(String(where.folder ?? ''))) return t(lang, 'setup.error.folder');
  } else if (where.mode !== 'none') {
    return t(lang, 'setup.error.plan');
  }
  if (!Array.isArray(plan.team)) return t(lang, 'setup.error.plan');
  for (const member of plan.team) {
    const name = String(member?.package ?? '');
    if (!PACKAGE_NAME_RE.test(name)) return t(lang, 'setup.error.member', { name, problem: t(lang, 'setup.error.package') });
    const count = Number(member.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_HIRE_COUNT) {
      return t(lang, 'setup.error.member', { name, problem: t(lang, 'setup.error.count', { max: MAX_HIRE_COUNT }) });
    }
    const problem = workspaceProblem(member.workspace, lang);
    if (problem) return t(lang, 'setup.error.member', { name, problem });
  }
  if (plan.teamPackage !== null && plan.teamPackage !== undefined && !PACKAGE_NAME_RE.test(String(plan.teamPackage))) {
    return t(lang, 'setup.error.plan');
  }
  return null;
}

function workspaceProblem(ws: SetupWorkspace, lang: Lang): string | null {
  if (!ws || typeof ws !== 'object') return t(lang, 'setup.error.plan');
  if (ws.kind === 'root') return null;
  if (ws.kind === 'folder') return FOLDER_NAME_RE.test(String(ws.name ?? '')) ? null : t(lang, 'setup.error.folder');
  if (ws.kind === 'path') return String(ws.dir ?? '').trim() ? null : t(lang, 'setup.error.workspacePath');
  return t(lang, 'setup.error.plan');
}

// ----------------------------------------------------------------- сборка

class Progress {
  readonly steps: SetupStep[] = [];
  constructor(private readonly report: (steps: SetupStep[]) => void) {}

  add(id: string, label: string): SetupStep {
    const step: SetupStep = { id, label, status: 'pending', detail: '' };
    this.steps.push(step);
    return step;
  }

  start(step: SetupStep): void { this.set(step, 'running', ''); }
  done(step: SetupStep, detail = ''): void { this.set(step, 'done', detail); }
  fail(step: SetupStep, detail: string): void { this.set(step, 'failed', detail); }

  private set(step: SetupStep, status: SetupStep['status'], detail: string): void {
    step.status = status;
    step.detail = detail;
    this.report(this.steps.map((s) => ({ ...s })));
  }
}

/** Свободный корень для офиса без проекта: ни на диске, ни в реестре. */
function freeRoot(name: string): string {
  const base = slugify(name, 'office');
  const taken = new Set(offices().map((o) => o.projectDir));
  for (let i = 1; ; i += 1) {
    const dir = resolve(defaultRoot(), i === 1 ? base : `${base}-${i}`);
    if (!existsSync(dir) && !taken.has(dir)) return dir;
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Папка роли: завести, положить README и сделать репозиторий. Готовую не трогаем. */
async function ensureRoleRepo(dir: string, lang: Lang): Promise<string | null> {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    else if (!isDir(dir)) return t(lang, 'offices.notADir', { dir });
  } catch (err) {
    return t(lang, 'offices.createFailed', { dir, error: (err as Error).message });
  }
  if (await isRepo(dir)) return null;
  // Пустому репозиторию нечего коммитить, а без первого коммита нет ветки,
  // от которой ветвятся задачи, — README и есть этот первый коммит.
  if (!readdirSync(dir).length) writeFileSync(resolve(dir, 'README.md'), t(lang, 'setup.readme', { name: dir.split('/').pop() ?? dir }));
  return (await initRepo(dir, lang)) ? null : t(lang, 'setup.gitInitFailed', { dir });
}

/**
 * Вложенные репозитории корень не отслеживает. Дописываем в `.gitignore`
 * корня, пока первого коммита ещё нет — иначе `git add -A` записал бы их
 * gitlink-ами с предупреждением о встроенном репозитории.
 */
function ignoreFolders(root: string, names: string[]): void {
  if (!names.length) return;
  const file = resolve(root, '.gitignore');
  const have = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(have.split('\n').map((l) => l.trim()));
  const add = names.map((n) => `/${n}/`).filter((l) => !lines.has(l));
  if (!add.length) return;
  writeFileSync(file, `${have}${have && !have.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
}

const repoDirOf = (ws: SetupWorkspace): string => {
  if (ws.kind === 'folder') return ws.name;
  if (ws.kind === 'path') return resolve(expandHome(ws.dir.trim()));
  return '';
};

/**
 * Собрать офис по плану. План уже проверен `planProblem`. Порядок шагов:
 * корень и запись в реестре → папки ролей → открытие → найм по участнику →
 * настройки команды → направление. Корень заводится записью в реестре, а не
 * до неё: так реестр знает, что папку завёл офис, и при открытии сделает в
 * ней `git init` — чужую папку он не трогает.
 */
export async function buildOffice(plan: OfficeSetupPlan, lang: Lang, hooks: SetupHooks): Promise<SetupResult> {
  const progress = new Progress(hooks.progress);
  const name = plan.name.trim();
  const stepOffice = progress.add('office', t(lang, 'setup.step.office'));
  const folders = [...new Set(plan.team.filter((m) => m.workspace.kind === 'folder').map((m) => (m.workspace as { name: string }).name))];
  const stepDirs = folders.length ? progress.add('dirs', t(lang, 'setup.step.dirs')) : null;
  const stepOpen = progress.add('open', t(lang, 'setup.step.open'));
  const hires = plan.team.map((member) => ({
    member, step: progress.add(`hire:${member.package}`, t(lang, 'setup.step.hire', { name: memberTitle(member.package, lang) })),
  }));
  const stepSettings = plan.teamPackage ? progress.add('settings', t(lang, 'setup.step.settings')) : null;
  const stepDirection = plan.description.trim() ? progress.add('direction', t(lang, 'setup.step.direction')) : null;

  // --- корень и запись в реестре
  progress.start(stepOffice);
  let made: ReturnType<typeof createOffice>;
  const where = plan.where;
  if (where.mode === 'existing') {
    made = createOffice({ name, projectDir: where.dir, mustExist: true, initTeam: 'manager-only' });
  } else if (where.mode === 'new') {
    const parent = resolve(expandHome(where.parent.trim()));
    if (!isDir(parent)) made = { error: t(lang, 'setup.error.parentMissing', { dir: parent }) };
    else {
      const dir = resolve(parent, where.folder);
      made = existsSync(dir)
        ? { error: t(lang, 'setup.error.folderExists', { dir }) }
        : createOffice({ name, projectDir: dir, initTeam: 'manager-only' });
    }
  } else {
    made = createOffice({ name, projectDir: freeRoot(name), noProject: true, initTeam: 'manager-only' });
  }
  if ('error' in made) {
    progress.fail(stepOffice, made.error);
    return { error: made.error };
  }
  const entry = made.office;
  progress.done(stepOffice, entry.projectDir);
  const failures: string[] = [];
  const noteFailure = (step: SetupStep, detail: string) => {
    progress.fail(step, detail);
    failures.push(t(lang, 'setup.log.stepFailed', { step: step.label, detail }));
  };

  // --- папки ролей
  if (stepDirs) {
    progress.start(stepDirs);
    const problems: string[] = [];
    const ready: string[] = [];
    for (const folder of folders) {
      const problem = await ensureRoleRepo(resolve(entry.projectDir, folder), lang);
      if (problem) problems.push(problem);
      else ready.push(folder);
    }
    // Чужой корень не правим: .gitignore — файл проекта, и дописывать его без
    // спроса нельзя. Свой корень ещё без коммита — дописываем до открытия.
    if (entry.initGit) ignoreFolders(entry.projectDir, ready);
    if (problems.length) noteFailure(stepDirs, problems.join('; '));
    else progress.done(stepDirs, ready.join(', '));
  }

  // --- открытие
  progress.start(stepOpen);
  try {
    await hooks.open(entry);
  } catch (err) {
    const error = t(lang, 'office.openFailed', { name: entry.name, error: (err as Error).message });
    progress.fail(stepOpen, error);
    return { error };
  }
  const state = hooks.state(entry.id);
  progress.done(stepOpen);

  // --- найм
  let hired = 0;
  for (const { member, step } of hires) {
    progress.start(step);
    const got = await ensureInstalled(state, member.package);
    if ('error' in got) { noteFailure(step, got.error); continue; }
    if (got.pkg.manifest.kind !== 'agent') { noteFailure(step, t(lang, 'market.isTeam', { name: member.package })); continue; }
    if (got.pkg.manifest.manager) { progress.done(step, t(lang, 'setup.detail.managerAlready')); continue; }
    const repoDir = repoDirOf(member.workspace);
    const notes: string[] = [];
    if (member.workspace.kind === 'path') {
      const problem = await repoProblem(repoDir, lang);
      if (problem) notes.push(problem);
    }
    let n = 0;
    for (let i = 0; i < member.count; i += 1) {
      const problem = state.hireFromPackage(got.pkg, got.source, repoDir ? { repoDir } : {});
      if (problem) { notes.push(problem); break; }
      n += 1;
    }
    hired += n;
    const detail = [t(lang, 'setup.detail.hired', { n, total: member.count }), ...notes].join('; ');
    if (n < member.count || (notes.length && member.workspace.kind === 'path')) noteFailure(step, detail);
    else progress.done(step, detail);
  }

  // --- настройки команды
  if (stepSettings && plan.teamPackage) {
    progress.start(stepSettings);
    const team = installedPackage(plan.teamPackage);
    if (!team || team.pkg.manifest.kind !== 'team') noteFailure(stepSettings, t(lang, 'market.notTeam', { name: plan.teamPackage }));
    else {
      const settings = Object.fromEntries(Object.entries(team.pkg.manifest.settings as TeamSettings).filter(([, v]) => v !== undefined));
      const problem = Object.keys(settings).length
        ? state.updateSettings(settings as Parameters<OfficeState['updateSettings']>[0])
        : null;
      if (problem) noteFailure(stepSettings, problem);
      else progress.done(stepSettings, Object.keys(settings).join(', ') || t(lang, 'setup.detail.nothing'));
    }
  }

  // --- направление владельца
  if (stepDirection) {
    progress.start(stepDirection);
    const problem = state.createDirection(plan.description.trim());
    if (problem) noteFailure(stepDirection, problem);
    else progress.done(stepDirection);
  }

  state.addLog(null, 'system', t(lang, 'setup.log.built', {
    name: entry.name, dir: entry.projectDir, hired, folders: folders.join(', ') || '—',
  }));
  for (const line of failures) state.addLog(null, 'system', line);
  return { officeId: entry.id };
}

/** Название пакета для подписи шага: из установленного, иначе имя. */
function memberTitle(name: string, lang: Lang): string {
  const found = installedPackage(name);
  if (!found) return name;
  const title = found.pkg.manifest.title;
  return title[lang] ?? title.en ?? Object.values(title)[0] ?? name;
}

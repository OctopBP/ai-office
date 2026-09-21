import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Lang } from '../shared/i18n';
import { t } from './i18n';


export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Код выхода: у merge-tree единица означает конфликт, а не поломку. */
  code: number;
}

/**
 * Все вызовы git идут через execFile с массивом аргументов — без оболочки.
 *
 * Обещание собираем колбэком, а не promisify: у execFile нестандартный колбэк
 * с двумя значениями, и его свёртка в объект `{stdout, stderr}` — соглашение
 * ноды, а не часть API. Под bun из promisify приезжает одна строка stdout,
 * и весь git молча начинал отвечать «не репозиторий» — в том числе проверкам
 * слияния и ревью. Колбэк одинаков в любой среде запуска.
 */
export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((done) => {
    const options = {
      cwd, maxBuffer: 10 * 1024 * 1024,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    };
    execFile('git', args, options, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number }) | null;
      done({
        ok: !e,
        stdout: (stdout ?? '').trim(),
        // Пустой stderr при ошибке ничего не объясняет — берём текст ошибки.
        stderr: ((stderr || e?.message) ?? '').trim(),
        code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
      });
    });
  });
}

/** Кто подписывает коммит: имя и почта, как их видит git. */
export interface GitPerson {
  name: string;
  email: string;
}

/**
 * Подпись коммита. Автор — тот, чьи это правки; коммитер — тот, кто внёс их
 * в ветку. Обычно это один и тот же сотрудник, и коммитера можно не задавать.
 * Расходятся они на слиянии: работа — исполнителя, а влил её ревьюер.
 */
export interface Signature {
  author: GitPerson;
  committer?: GitPerson;
}

/**
 * Сам офис — подпись технических коммитов: первый коммит нового репозитория,
 * stash, слияние по команде человека. Всё, что сделал сотрудник, подписывается
 * им самим (`OfficeState.gitPerson`).
 */
export const OFFICE_PERSON: GitPerson = { name: 'AI Office', email: 'office@local' };

/**
 * Подпись передаём окружением, а не `-c user.name`: так автор и коммитер
 * задаются раздельно, а stash и merge подписываются тем же путём, что и
 * commit. Заодно это спасает в чужом репозитории, где git не настроен и без
 * подписи просто отказал бы.
 */
function signed(sign: Signature = { author: OFFICE_PERSON }): NodeJS.ProcessEnv {
  const committer = sign.committer ?? sign.author;
  return {
    GIT_AUTHOR_NAME: sign.author.name,
    GIT_AUTHOR_EMAIL: sign.author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  };
}

export async function isRepo(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout === 'true';
}

/**
 * Корень репозитория, которому принадлежит папка, или null, если git её не
 * знает. Отличает «папка — сама репозиторий» от «папка лежит внутри чужого»:
 * `--is-inside-work-tree` для обоих отвечает «да».
 */
export async function repoTop(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--show-toplevel']);
  return r.ok && r.stdout ? r.stdout : null;
}

export async function hasCommits(dir: string): Promise<boolean> {
  return (await git(dir, ['rev-parse', 'HEAD'])).ok;
}

/**
 * Что не так с директорией как с рабочим репозиторием роли. null — всё в
 * порядке. Одна проверка на всех: её показывает старт офиса в отчёте о
 * репозиториях ролей и она же не даёт сохранить роль с негодным путём.
 * Разойдись эти два места — человек заводил бы роль без единого возражения,
 * а узнавал о неверном пути из строчки в консоли или из проваленной задачи.
 *
 * Текст готов к показу человеку: и в консоли, и под полем формы.
 */
export async function repoProblem(dir: string, lang: Lang): Promise<string | null> {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return t(lang, 'git.noDir', { dir });
  }
  if (!stat.isDirectory()) return t(lang, 'git.notDir', { dir });
  if (!(await isRepo(dir))) {
    return t(lang, 'git.notRepo', { dir });
  }
  if (!(await hasCommits(dir))) {
    return t(lang, 'git.noCommits', { dir });
  }
  return null;
}

export async function currentBranch(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.stdout : null;
}

/**
 * От какой ветки ответвлять задачи. Обычно это та, что сейчас в рабочей копии,
 * но копия может быть и отцеплена (например, офис увёл её, чтобы сдвинуть базу
 * мимо незакоммиченных правок) — тогда «HEAD» веткой не является, и брать её
 * за базу нельзя: задача ответвилась бы от вчерашнего коммита.
 */
export async function baseBranch(dir: string): Promise<string | null> {
  const current = await currentBranch(dir);
  if (current && current !== 'HEAD') return current;
  for (const name of ['main', 'master']) {
    if (await revision(dir, name)) return name;
  }
  return null;
}

/**
 * Живое имя базовой ветки задачи. Имя фиксируется на задаче в момент заводки
 * worktree — и к слиянию может протухнуть. Так и вышло с T-18: копию офиса
 * отцепило (advanceBase уводит её с ветки, чтобы сдвинуть базу мимо чужих
 * незакоммиченных правок), её вернули на временную ветку вида
 * `local/2026-09-17`, задача ответвилась от неё, а потом временную ветку
 * влили в main и удалили. Ветки больше нет — `git merge local/2026-09-17`
 * падает с «not something we can merge», и задача стоит перед слиянием
 * навсегда: сама по себе ссылка не воскреснет.
 *
 * Поэтому: записанную ветку берём, пока она есть; если её не стало — ту,
 * которую репозиторий считает основной сейчас. Возвращаем записанное имя и
 * когда замены не нашлось: пусть вызов упадёт с понятной ошибкой git, а не
 * молча сольёт работу не туда.
 */
export async function liveBase(repoDir: string, recorded: string): Promise<string> {
  if (await revision(repoDir, recorded)) return recorded;
  return (await baseBranch(repoDir)) ?? recorded;
}

/** Инициализировать репозиторий с первым коммитом — только для директории, которую создали мы сами. */
export async function initRepo(dir: string, lang: Lang): Promise<boolean> {
  if (!(await git(dir, ['init', '-b', 'main'])).ok) return false;
  await git(dir, ['add', '-A']);
  const commit = await git(dir, ['commit', '-m', t(lang, 'git.initCommit')], signed());
  return commit.ok;
}

/**
 * Отдельный worktree на задачу: исполнители работают в разных директориях
 * на разных ветках и физически не могут затереть друг друга.
 */
export async function createWorktree(
  repoDir: string, worktreesRoot: string, taskId: string,
): Promise<{ path: string; branch: string; base: string } | null> {
  const base = await baseBranch(repoDir);
  if (!base) return null;

  const branch = `task/${taskId}`;
  const path = resolve(worktreesRoot, taskId);

  // Подчищаем хвосты от прошлых прогонов с тем же id.
  await rm(path, { recursive: true, force: true });
  await git(repoDir, ['worktree', 'prune']);
  await git(repoDir, ['branch', '-D', branch]);

  const r = await git(repoDir, ['worktree', 'add', '-b', branch, path, base]);
  if (!r.ok) return null;
  await linkNodeModules(repoDir, path);
  return { path, branch, base };
}

/**
 * Зависимости в worktree — симлинком на основной node_modules. Свежий worktree
 * пуст, и без этого исполнитель не может ни собрать проект, ни прогнать
 * проверки: он видит исходники, но не то, чем они запускаются.
 *
 * Проверяем игнор УЖЕ ПОСЛЕ создания симлинка и в самом worktree: правило
 * вида `node_modules/` со слэшем матчит каталог, но не симлинк на него, —
 * такой симлинк ушёл бы в коммит задачи и уехал в основную ветку при слиянии.
 * Не игнорируется — убираем: остаться без зависимостей лучше, чем насорить
 * в чужом репозитории.
 */
async function linkNodeModules(repoDir: string, worktreePath: string): Promise<void> {
  const src = resolve(repoDir, 'node_modules');
  const dest = resolve(worktreePath, 'node_modules');
  if (!existsSync(src) || existsSync(dest)) return;
  try {
    symlinkSync(src, dest, 'dir');
  } catch {
    return;   // не вышло — исполнитель просто останется без зависимостей
  }
  if (!(await git(worktreePath, ['check-ignore', '-q', 'node_modules'])).ok) {
    await rm(dest, { force: true });
  }
}

/**
 * Коммитим за исполнителя сами: так надёжнее, чем надеяться, что он не забудет.
 * Подпись — его: в истории видно, чья это работа, а не «офис».
 */
export async function commitAll(
  worktreePath: string, message: string, sign?: Signature,
): Promise<'committed' | 'empty' | 'failed'> {
  if (!(await git(worktreePath, ['add', '-A'])).ok) return 'failed';
  const status = await git(worktreePath, ['status', '--porcelain']);
  if (status.ok && status.stdout === '') return 'empty';
  const commit = await git(worktreePath, ['commit', '-m', message], signed(sign));
  return commit.ok ? 'committed' : 'failed';
}

export interface MergeOutcome {
  ok: boolean;
  /**
   * 'nothing' — в ветке нет коммитов сверх базовой; 'verify-failed' — проверка
   * после слияния; 'no-copy' — не поднялась рабочая копия офиса для слияния.
   */
  kind: 'merged' | 'conflict' | 'nothing' | 'verify-failed' | 'no-copy' | 'failed';
  message: string;
  /** Файлы, на которых встало слияние. Пусто, если конфликта не было. */
  conflicts: string[];
  /** Обходы по дороге: занятый каталог интеграции, снятые хвосты worktree. */
  warnings: string[];
  /** Рабочая копия офиса, в которой собрано слияние: там же гоняются проверки. */
  worktree: string | null;
  /** Что стало с рабочей копией человека после того, как базовая ветка сдвинулась. */
  checkout: CheckoutSync;
}

export interface CheckoutSync {
  /**
   * 'updated'  — копия человека подтянута до новой базы, его правки на месте;
   * 'not-here' — она на другой ветке, обновлять нечего;
   * 'lagging'  — не подтянули: его незакоммиченные правки в тех же файлах.
   */
  state: 'updated' | 'not-here' | 'lagging';
  /** Файлы, из-за которых копию не удалось подтянуть. */
  files: string[];
  message: string;
}

/** Рабочая копия офиса, поднятая под слияние, и всё, что пришлось сделать по дороге. */
export interface IntegrationCopy {
  /** Каталог, в котором собирается слияние. null — поднять копию не удалось вовсе. */
  path: string | null;
  /**
   * Каталог запасной: основной был занят, и после сборки этот надо убрать —
   * иначе рядом с копией офиса копился бы мусор от каждого слияния.
   */
  temporary: boolean;
  /** Текст git, из-за которого копию поднять не вышло. */
  error: string;
  /** Что случилось по дороге: убрали застрявший worktree, ушли в запасной каталог. */
  warnings: string[];
}

/** Ветка задачи: в её рабочей копии лежит несданная работа исполнителя — трогать нельзя. */
const TASK_REF = 'refs/heads/task/';

/** Одна строка `git worktree list --porcelain`: где лежит копия и на какой она ветке. */
interface WorktreeEntry {
  path: string;
  /** Полная ссылка вида `refs/heads/task/T-58`; null — копия отцеплена. */
  branch: string | null;
}

/**
 * Путь так, как его видит файловая система: git печатает пути уже разрешёнными,
 * и на macOS `/var/...` из tmpdir не совпал бы с `/private/var/...` из git.
 */
function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Копии, о которых знает сам репозиторий. Чужих worktree здесь не бывает по определению. */
async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
  const listed = await git(repoDir, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return [];
  const entries: WorktreeEntry[] = [];
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      entries.push({ path: line.slice('worktree '.length).trim(), branch: null });
    } else if (line.startsWith('branch ') && entries.length) {
      entries[entries.length - 1].branch = line.slice('branch '.length).trim();
    }
  }
  return entries;
}

/** Запись репозитория о копии в этом каталоге — или null, если каталог ему не принадлежит. */
async function registeredWorktree(repoDir: string, dir: string): Promise<WorktreeEntry | null> {
  const want = realOf(dir);
  return (await listWorktrees(repoDir)).find((w) => realOf(w.path) === want) ?? null;
}

/**
 * Наши копии, лежащие ВНУТРИ каталога, а не в нём самом.
 *
 * Ровно на этом в сентябре встали все слияния офиса: в каталоге `_base`
 * оказалась копия от постороннего прогона гейта (`_base/office-b0cc4212`), а
 * сам `_base` репозиторию не принадлежал — ни `prune`, ни `remove` по самому
 * каталогу такой завал не берут, и разобрать его мог только человек:
 * исполнителю песочница не даёт писать за пределами своей рабочей копии.
 */
async function nestedCopies(repoDir: string, dir: string): Promise<WorktreeEntry[]> {
  const inside = `${realOf(dir)}${sep}`;
  return (await listWorktrees(repoDir)).filter((w) => realOf(w.path).startsWith(inside));
}

/**
 * Снять наши копии, застрявшие внутри каталога. Рабочую копию живой задачи не
 * трогаем ни при каких обстоятельствах — там несданная работа исполнителя, —
 * и возвращаем её ветку отдельно: выше по ней решают, обходить каталог или нет.
 *
 * `git clean` на такой завал не годится: каталог с собственным `.git` он без
 * `-ff` не удаляет, а с `-ff` снёс бы и чужой репозиторий, случайно
 * оказавшийся внутри. Снимаем ровно то, что репозиторий признаёт своим.
 */
async function dropNestedCopies(
  repoDir: string, dir: string,
): Promise<{ dropped: string[]; busy: string[] }> {
  const nested = await nestedCopies(repoDir, dir);
  const busy = nested
    .map((w) => w.branch ?? '')
    .filter((ref) => ref.startsWith(TASK_REF))
    .map((ref) => ref.slice('refs/heads/'.length));
  if (busy.length) return { dropped: [], busy };

  for (const copy of nested) {
    await git(repoDir, ['worktree', 'remove', '--force', copy.path]);
    await rm(copy.path, { recursive: true, force: true });
  }
  if (nested.length) await git(repoDir, ['worktree', 'prune']);
  return { dropped: nested.map((w) => w.path), busy: [] };
}

/**
 * Брошенная копия этого же репозитория: каталог есть, а записи о нём уже нет
 * (её сняли `worktree prune` или удалённый .git/worktrees). Файл `.git` внутри
 * такой копии указывает на служебный каталог репозитория — по нему и отличаем
 * свой хвост от чужого содержимого, которое трогать нельзя.
 */
async function abandonedCopy(repoDir: string, dir: string): Promise<boolean> {
  const marker = resolve(dir, '.git');
  if (!existsSync(marker)) return false;
  try {
    if (statSync(marker).isDirectory()) return false;   // это самостоятельный репозиторий
    const pointer = readFileSync(marker, 'utf8').trim();
    if (!pointer.startsWith('gitdir:')) return false;
    const common = await git(repoDir, ['rev-parse', '--git-common-dir']);
    if (!common.ok) return false;
    const ours = realOf(resolve(repoDir, common.stdout));
    return realOf(pointer.slice('gitdir:'.length).trim()).startsWith(ours);
  } catch {
    return false;
  }
}

/**
 * Поднять копию офиса в конкретном каталоге, разбирая по дороге завалы.
 *
 * `git worktree add` отказывает на занятом каталоге одинаково — «already
 * exists», — а причин у этого четыре: протухшая запись (лечится `prune`), наш
 * же застрявший worktree (снимаем `remove --force`), наша копия, лежащая
 * ВНУТРИ каталога (снимаем её — каталог освобождается сам), и чужое
 * содержимое (не наше дело). Разбираем их по очереди, потому что первые три
 * офис обязан чинить сам: иначе одно постороннее слияние останавливает весь
 * конвейер до прихода человека.
 */
async function raiseCopy(
  repoDir: string, dir: string, base: string, lang: Lang,
): Promise<{ ok: boolean; error: string; warnings: string[] }> {
  const warnings: string[] = [];
  // Копия офиса может лежать где угодно, в том числе во временном каталоге:
  // родительской директории может просто не быть, а git её не создаёт.
  try {
    mkdirSync(dirname(dir), { recursive: true });
  } catch (err) {
    return { ok: false, error: (err as Error).message, warnings };
  }

  const add = async (): Promise<GitResult> => {
    const added = await git(repoDir, ['worktree', 'add', '--detach', dir, base]);
    if (added.ok) await linkNodeModules(repoDir, dir);
    return added;
  };

  let last = await add();
  if (last.ok) return { ok: true, error: '', warnings };

  // 1. Протухшая запись о копии, которой на диске уже нет.
  await git(repoDir, ['worktree', 'prune']);
  if (!existsSync(dir)) {
    last = await add();
    if (last.ok) {
      warnings.push(t(lang, 'git.integration.pruned', { dir }));
      return { ok: true, error: '', warnings };
    }
  }

  // 2. Наш же worktree, застрявший в каталоге. Рабочую копию живой задачи
  //    не трогаем ни при каких обстоятельствах: там чужая несданная работа.
  const mine = await registeredWorktree(repoDir, dir);
  if (mine) {
    if (mine.branch?.startsWith(TASK_REF)) {
      const branch = mine.branch.slice('refs/heads/'.length);
      warnings.push(t(lang, 'git.integration.busyTask', { dir, branch }));
      return { ok: false, error: last.stderr || last.stdout, warnings };
    }
    await git(repoDir, ['worktree', 'remove', '--force', dir]);
    await rm(dir, { recursive: true, force: true });
    await git(repoDir, ['worktree', 'prune']);
    last = await add();
    if (last.ok) {
      warnings.push(t(lang, 'git.integration.removed', { dir }));
      return { ok: true, error: '', warnings };
    }
  } else if (await abandonedCopy(repoDir, dir)) {
    // 3. Брошенный хвост нашего же репозитория: записи нет, каталог остался.
    await rm(dir, { recursive: true, force: true });
    await git(repoDir, ['worktree', 'prune']);
    last = await add();
    if (last.ok) {
      warnings.push(t(lang, 'git.integration.cleaned', { dir }));
      return { ok: true, error: '', warnings };
    }
  }

  // 4. Наши копии ВНУТРИ каталога. Сам каталог репозиторию не принадлежит, и
  //    шаги 1–3 его не видят вовсе: убираем то, что лежит внутри, и каталог
  //    освобождается. Копию живой задачи по-прежнему не трогаем.
  const nested = await dropNestedCopies(repoDir, dir);
  if (nested.busy.length) {
    warnings.push(t(lang, 'git.integration.busyTask', { dir, branch: nested.busy.join(', ') }));
    return { ok: false, error: last.stderr || last.stdout, warnings };
  }
  if (nested.dropped.length) {
    last = await add();
    if (last.ok) {
      warnings.push(t(lang, 'git.integration.unnested', {
        dir, copies: nested.dropped.join(', '),
      }));
      return { ok: true, error: '', warnings };
    }
  }

  return { ok: false, error: last.stderr || last.stdout, warnings };
}

/**
 * Рабочая копия офиса для слияний — отдельная от той, в которой сидит человек.
 *
 * Раньше офис сливал прямо в директорию проекта, и любая незакоммиченная правка
 * человека («git не даёт слить поверх ваших изменений») останавливала весь
 * конвейер. Это неверная зависимость: слияние двух веток — операция над
 * историей, к тому, что человек в этот момент правит у себя, отношения не имеет.
 *
 * Каталог у копии фиксированный, и занять его может кто угодно — например
 * посторонний ручной прогон офиса из той же папки. Тогда слияние идёт в
 * запасной каталог рядом (`_base-<id>`), а не встаёт: в основную ветку не
 * вливалось НИЧЕГО, пока человек не приходил разбирать это руками (T-56, T-58).
 */
async function integrationWorktree(
  repoDir: string, dir: string, base: string, lang: Lang,
): Promise<IntegrationCopy> {
  const warnings: string[] = [];

  // Каталог уже наш — переиспользуем: чужого в нашей копии не бывает, поэтому
  // приводим её к базовой ветке жёстко. Проверяем принадлежность по списку
  // git, а не по наличию `.git`: жёсткий reset в чужой копии стёр бы чужую работу.
  if (await registeredWorktree(repoDir, dir)) {
    // Посторонняя копия может завестись и ВНУТРИ нашей: `git clean` её не
    // берёт, и она осталась бы лежать под ногами у проверок слитого дерева.
    const nested = await dropNestedCopies(repoDir, dir);
    if (nested.dropped.length) {
      warnings.push(t(lang, 'git.integration.unnested', {
        dir, copies: nested.dropped.join(', '),
      }));
    }
    await git(dir, ['reset', '--hard']);
    await git(dir, ['clean', '-fdq']);
    const moved = await git(dir, ['checkout', '--detach', base]);
    if (moved.ok) return { path: dir, temporary: false, error: '', warnings };
    // Копия наша, но негодная: сносим и заводим заново.
    warnings.push(t(lang, 'git.integration.rebuilt', { dir, error: moved.stderr }));
    await git(repoDir, ['worktree', 'remove', '--force', dir]);
    await rm(dir, { recursive: true, force: true });
    await git(repoDir, ['worktree', 'prune']);
  }

  const here = await raiseCopy(repoDir, dir, base, lang);
  warnings.push(...here.warnings);
  if (here.ok) return { path: dir, temporary: false, error: '', warnings };

  // Основной каталог занят и не освобождается — собираем рядом, в своём.
  const spare = `${dir}-${randomUUID().slice(0, 8)}`;
  const alt = await raiseCopy(repoDir, spare, base, lang);
  warnings.push(...alt.warnings);
  if (!alt.ok) {
    return { path: null, temporary: false, error: alt.error || here.error, warnings };
  }
  warnings.push(t(lang, 'git.integration.fallback', { dir, alt: spare, error: here.error }));
  return { path: spare, temporary: true, error: '', warnings };
}

/**
 * Отпустить копию офиса после сборки. Постоянная остаётся жить — её
 * переиспользует следующее слияние; запасную убираем целиком, вместе с записью
 * о ней: иначе каждое слияние на занятом каталоге оставляло бы по worktree.
 */
export async function releaseIntegration(
  repoDir: string, dir: string | null, temporary: boolean, lang: Lang,
): Promise<string[]> {
  if (!temporary || !dir) return [];
  await git(repoDir, ['worktree', 'remove', '--force', dir]);
  await rm(dir, { recursive: true, force: true });
  await git(repoDir, ['worktree', 'prune']);
  return [t(lang, existsSync(dir) ? 'git.integration.releaseFailed' : 'git.integration.released',
    { dir })];
}

/**
 * Сдвинуть базовую ветку на собранное слияние — так, чтобы рабочая копия
 * человека осталась связной, а его незакоммиченные правки не пострадали.
 *
 * Три случая:
 * - копия на другой ветке → просто двигаем ссылку, копии это не касается;
 * - копия на базовой и правки не мешают → `merge --ff-only`: git сам двигает
 *   ветку и обновляет файлы, не трогая посторонние правки человека;
 * - копия на базовой, но правки в тех же файлах → отцепляем её на прежнем
 *   коммите и двигаем ветку мимо. Правки остаются как были, влитое с ними
 *   не смешивается, а история едет дальше. Раньше на этом месте офис просто
 *   вставал и требовал от человека закоммитить.
 */
async function advanceBase(
  repoDir: string, base: string, oldSha: string, newSha: string, overlap: string[], lang: Lang,
): Promise<{ ok: boolean; message: string; checkout: CheckoutSync }> {
  const onBase = (await currentBranch(repoDir)) === base;

  if (onBase) {
    const ff = await git(repoDir, ['merge', '--ff-only', newSha]);
    if (ff.ok) {
      return {
        ok: true, message: '',
        checkout: {
          state: 'updated', files: [],
          message: t(lang, 'git.checkout.updated', { base }),
        },
      };
    }
    const detached = await git(repoDir, ['checkout', '--detach', oldSha]);
    if (!detached.ok) {
      return {
        ok: false,
        message: t(lang, 'git.moveFailed', { base, error: detached.stderr || ff.stderr }),
        checkout: { state: 'lagging', files: overlap, message: '' },
      };
    }
  }

  // Старое значение — защита от гонки: если ветку кто-то двинул, пока шло
  // слияние, update-ref откажет и чужой коммит не потеряется.
  const moved = await git(repoDir, ['update-ref', `refs/heads/${base}`, newSha, oldSha]);
  if (!moved.ok) {
    return {
      ok: false,
      message: t(lang, 'git.baseMoved', { base }),
      checkout: { state: 'not-here', files: [], message: '' },
    };
  }

  return {
    ok: true, message: '',
    checkout: onBase
      ? {
        state: 'lagging', files: overlap,
        message: t(lang, 'git.checkout.lagging', {
          base,
          files: overlap.length
            ? t(lang, 'git.checkout.laggingFiles', { files: overlap.join(', ') })
            : '',
        }),
      }
      : { state: 'not-here', files: [], message: t(lang, 'git.checkout.notHere', { base }) },
  };
}

export interface AssembledMerge {
  /**
   * 'nothing' — в ветке нет коммитов сверх базовой; 'no-copy' — не удалось
   * поднять рабочую копию офиса; 'failed' — слить не вышло вовсе.
   */
  kind: 'merged' | 'conflict' | 'nothing' | 'no-copy' | 'failed';
  message: string;
  conflicts: string[];
  /** Рабочая копия офиса с собранным слиянием: там гоняются проверки. */
  worktree: string | null;
  /** Копия запасная — после того, как она отработала, её надо отпустить. */
  temporary: boolean;
  /** Коммит собранного слияния и коммит базы, от которого его собирали. */
  sha: string | null;
  baseSha: string | null;
  /** Обходы, которые понадобились по дороге: занятый каталог, снятые хвосты. */
  warnings: string[];
}

/**
 * Собрать слияние ветки с базой в рабочей копии офиса — и остановиться на этом.
 * Базовая ветка не двигается: результат живёт только в копии офиса, и по нему
 * можно гонять проверки. Это «пробное слияние» пред-merge гейта и первая
 * половина настоящего слияния (`mergeBranch`).
 */
export async function assembleMerge(
  repoDir: string, branch: string, base: string, integrationDir: string, lang: Lang,
  sign?: Signature,
): Promise<AssembledMerge> {
  const warnings: string[] = [];
  const stop = (message: string, kind: AssembledMerge['kind']): AssembledMerge => ({
    kind, message, conflicts: [], worktree: null, temporary: false,
    sha: null, baseSha: null, warnings,
  });

  const baseSha = await revision(repoDir, base);
  if (!baseSha) return stop(t(lang, 'git.noBase', { base }), 'failed');
  if (!(await revision(repoDir, branch))) {
    return stop(t(lang, 'git.noBranch', { branch }), 'failed');
  }

  const ahead = await git(repoDir, ['rev-list', '--count', `${base}..${branch}`]);
  if (ahead.ok && ahead.stdout === '0') {
    return stop(t(lang, 'git.nothingToMerge'), 'nothing');
  }

  const copy = await integrationWorktree(repoDir, integrationDir, base, lang);
  warnings.push(...copy.warnings);
  const worktree = copy.path;
  // Каталог интеграции занят и обойти его не вышло — это своя беда, со своим
  // текстом git. Раньше она приезжала как 'failed' и выше читалась как
  // расхождение с базой: человек видел «база уезжает», а дело было в каталоге.
  if (!worktree) {
    return stop(t(lang, 'git.noIntegrationCopy', {
      dir: integrationDir, error: copy.error,
    }), 'no-copy');
  }
  const assembled = (rest: Partial<AssembledMerge> & Pick<AssembledMerge, 'kind' | 'message'>)
  : AssembledMerge => ({
    conflicts: [], worktree, temporary: copy.temporary, sha: null, baseSha, warnings, ...rest,
  });

  const merge = await git(worktree, ['merge', '--no-ff', '--no-edit', branch], signed(sign));
  if (!merge.ok) {
    const conflicted = await git(worktree, ['diff', '--name-only', '--diff-filter=U']);
    const files = splitLines(conflicted.stdout);
    await git(worktree, ['merge', '--abort']);
    return assembled({
      kind: 'conflict', conflicts: files,
      message: files.length
        ? t(lang, 'git.mergeConflict', { files: files.join(', ') })
        : t(lang, 'git.mergeFailed', { error: merge.stderr || merge.stdout }),
    });
  }

  const sha = await revision(worktree, 'HEAD');
  if (!sha) return assembled({ kind: 'failed', message: t(lang, 'git.noMergeCommit') });
  return assembled({
    kind: 'merged', sha, message: t(lang, 'git.mergeAssembled', { branch, base }),
  });
}

/** Убрать собранное слияние из копии офиса: она возвращается к базовой ветке. */
export async function dropAssembled(worktree: string, base: string): Promise<void> {
  await git(worktree, ['reset', '--hard', base]);
}

/**
 * Влить ветку задачи в базовую. Слияние собирается в рабочей копии офиса, а
 * базовая ветка сдвигается атомарно: `update-ref` со старым значением не даст
 * затереть чужой коммит, если ветка уехала, пока мы сливали.
 *
 * verify — проверка собранного слияния ДО того, как базовая ветка сдвинется.
 * Не прошла — базовая ветка остаётся нетронутой: сломанная сборка в неё
 * не попадает вовсе, а не «попадает, зато мы про это скажем».
 */
export async function mergeBranch(
  repoDir: string, branch: string, base: string, integrationDir: string, lang: Lang,
  verify?: (worktree: string) => Promise<{ ok: boolean; message: string }>,
  sign?: Signature,
): Promise<MergeOutcome> {
  const warnings: string[] = [];
  const nothingToDo = (message: string, kind: MergeOutcome['kind'] = 'nothing'): MergeOutcome => ({
    ok: kind === 'nothing', kind, message, conflicts: [], worktree: null, warnings,
    checkout: { state: 'not-here', files: [], message: '' },
  });

  const built = await assembleMerge(repoDir, branch, base, integrationDir, lang, sign);
  warnings.push(...built.warnings);
  // Запасную копию отпускаем на любом исходе: она нужна ровно на время сборки,
  // а остаться должна только постоянная копия офиса.
  const release = async (): Promise<void> => {
    warnings.push(...await releaseIntegration(repoDir, built.worktree, built.temporary, lang));
  };
  if (built.kind === 'conflict') {
    await release();
    return {
      ok: false, kind: 'conflict',
      // Запасной копии уже нет на диске — возвращать её путь было бы враньём.
      worktree: built.temporary ? null : built.worktree,
      message: built.message, conflicts: built.conflicts, warnings,
      checkout: { state: 'not-here', files: [], message: '' },
    };
  }
  if (built.kind !== 'merged') {
    await release();
    return nothingToDo(built.message, built.kind);
  }
  const worktree = built.worktree as string;
  const baseSha = built.baseSha as string;
  const newSha = built.sha as string;

  if (verify) {
    const checked = await verify(worktree);
    if (!checked.ok) {
      // Базовую ветку не двигаем вовсе: она остаётся ровно такой, какой была.
      await dropAssembled(worktree, base);
      await release();
      return {
        ok: false, kind: 'verify-failed', warnings,
        worktree: built.temporary ? null : worktree, conflicts: [],
        message: checked.message,
        checkout: { state: 'not-here', files: [], message: '' },
      };
    }
  }

  // Пересечение «что меняет слияние» и «что человек правит прямо сейчас»
  // считаем ДО сдвига ветки: после него HEAD уже новый и сравнивать не с чем.
  const localMods = splitLines((await git(repoDir, ['diff', '--name-only', 'HEAD'])).stdout);
  const mergedFiles = splitLines((await git(repoDir, ['diff', '--name-only', baseSha, newSha])).stdout);
  const overlap = mergedFiles.filter((f) => localMods.includes(f));

  const moved = await advanceBase(repoDir, base, baseSha, newSha, overlap, lang);
  // Копию отпускаем после сдвига базы: до него её дерево — единственное место,
  // где живёт собранное слияние.
  await release();
  if (!moved.ok) return nothingToDo(moved.message, 'failed');

  return {
    ok: true, kind: 'merged', warnings,
    worktree: built.temporary ? null : worktree, conflicts: [],
    message: t(lang, 'git.merged', { branch, base }),
    checkout: moved.checkout,
  };
}

const splitLines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);

export interface MergeCheckResult {
  /** 'clean' — сольётся без конфликтов, 'nothing' — сливать нечего. */
  state: 'clean' | 'conflict' | 'nothing' | 'unknown';
  conflicts: string[];
  /** Готовая фраза для интерфейса. */
  message: string;
}

/**
 * Сухая проверка: сольётся ли ветка задачи в базовую. Ничего не меняет —
 * ни рабочую копию, ни базовую ветку, ни индекс.
 *
 * Основной путь — `git merge-tree --write-tree`: слияние считается целиком
 * в объектной базе, рабочая копия не участвует. На git старше 2.38 этой формы
 * нет — там пробуем то же самое во временном отсоединённом worktree
 * (`merge --no-commit --no-ff` с последующим `merge --abort`), он тоже никак
 * не трогает основную ветку.
 */
export async function checkMergeable(
  repoDir: string, branch: string, base: string, lang: Lang,
): Promise<MergeCheckResult> {
  for (const ref of [base, branch]) {
    if (!(await git(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`])).ok) {
      return { state: 'unknown', conflicts: [], message: t(lang, 'git.noRef', { ref }) };
    }
  }

  const ahead = await git(repoDir, ['rev-list', '--count', `${base}..${branch}`]);
  if (ahead.ok && ahead.stdout === '0') {
    return {
      state: 'nothing', conflicts: [], message: t(lang, 'git.nothingBeyond', { branch, base }),
    };
  }

  const tree = await git(repoDir, ['merge-tree', '--write-tree', '--name-only', base, branch]);
  if (tree.ok) {
    return { state: 'clean', conflicts: [], message: t(lang, 'git.mergesClean', { base }) };
  }
  // Единица и хеш дерева первой строкой — это конфликт, а не сбой команды.
  const lines = tree.stdout.split('\n');
  if (tree.code === 1 && /^[0-9a-f]{40,64}$/.test(lines[0]?.trim() ?? '')) {
    const conflicts = collectConflictNames(lines.slice(1));
    return { state: 'conflict', conflicts, message: conflictMessage(base, conflicts, lang) };
  }

  return checkMergeableInWorktree(repoDir, branch, base, tree.stderr || tree.stdout, lang);
}

/**
 * У `merge-tree --name-only` после списка файлов идёт пустая строка,
 * а за ней пояснения вида «CONFLICT (content): …» — они не имена файлов.
 */
function collectConflictNames(lines: string[]): string[] {
  const names: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) break;
    names.push(line);
  }
  return names;
}

const conflictMessage = (base: string, conflicts: string[], lang: Lang): string => (conflicts.length
  ? t(lang, 'git.conflictsWithFiles', { base, files: conflicts.join(', ') })
  : t(lang, 'git.conflictsWith', { base }));

/** Запасной путь для старого git: слияние во временном worktree с откатом. */
async function checkMergeableInWorktree(
  repoDir: string, branch: string, base: string, reason: string, lang: Lang,
): Promise<MergeCheckResult> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), 'office-merge-check-'));
  } catch {
    return { state: 'unknown', conflicts: [], message: t(lang, 'git.checkFailed', { error: reason }) };
  }
  const path = resolve(dir, 'wt');
  const added = await git(repoDir, ['worktree', 'add', '--detach', path, base]);
  if (!added.ok) {
    await rm(dir, { recursive: true, force: true });
    return {
      state: 'unknown', conflicts: [], message: t(lang, 'git.checkFailed', { error: added.stderr || reason }),
    };
  }
  try {
    const merge = await git(path, ['merge', '--no-commit', '--no-ff', branch]);
    if (merge.ok) return { state: 'clean', conflicts: [], message: t(lang, 'git.mergesClean', { base }) };
    const conflicted = await git(path, ['diff', '--name-only', '--diff-filter=U']);
    const conflicts = splitLines(conflicted.stdout);
    if (!conflicts.length) {
      return {
        state: 'unknown', conflicts: [],
        message: t(lang, 'git.checkFailed', { error: merge.stderr || merge.stdout }),
      };
    }
    return { state: 'conflict', conflicts, message: conflictMessage(base, conflicts, lang) };
  } finally {
    await git(path, ['merge', '--abort']);
    await git(repoDir, ['worktree', 'remove', path, '--force']);
    await git(repoDir, ['worktree', 'prune']);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Ограничение на размер патча: гигантский дифф незачем гнать в браузер. */
const MAX_PATCH = 200_000;

export interface Diff {
  stat: string;
  patch: string;
  truncated: boolean;
}

/** Что задача изменила относительно базовой ветки. */
export async function diffBranch(
  repoDir: string, base: string, branch: string, lang: Lang,
): Promise<Diff | { error: string }> {
  const exists = await git(repoDir, ['rev-parse', '--verify', branch]);
  if (!exists.ok) return { error: t(lang, 'git.branchGone', { branch }) };

  // Три точки: изменения ветки от точки расхождения, без чужих коммитов из base.
  const stat = await git(repoDir, ['diff', '--stat', `${base}...${branch}`]);
  if (!stat.ok) return { error: stat.stderr || t(lang, 'git.diffFailed') };
  if (!stat.stdout) return { stat: '', patch: '', truncated: false };

  const patch = await git(repoDir, ['diff', `${base}...${branch}`]);
  const full = patch.stdout;
  return {
    stat: stat.stdout,
    patch: full.slice(0, MAX_PATCH),
    truncated: full.length > MAX_PATCH,
  };
}

export async function removeWorktree(
  repoDir: string, path: string, branch: string,
  options: { keepBranch?: boolean } = {},
): Promise<void> {
  await git(repoDir, ['worktree', 'remove', path, '--force']);
  await git(repoDir, ['worktree', 'prune']);
  if (!options.keepBranch) await git(repoDir, ['branch', '-D', branch]);
}

/** Есть ли в ветке коммиты сверх базовой. */
export async function hasWork(repoDir: string, branch: string, base: string): Promise<boolean> {
  const r = await git(repoDir, ['rev-list', '--count', `${base}..${branch}`]);
  return r.ok && r.stdout !== '0';
}

/**
 * Сохранить ветку под новым именем вместо удаления.
 * Нужно при перезапуске задачи: обещали, что сделанное не пропадёт.
 */
export async function preserveBranch(repoDir: string, branch: string): Promise<string | null> {
  for (let n = 1; n < 50; n += 1) {
    const target = `${branch}.stopped-${n}`;
    const exists = await git(repoDir, ['rev-parse', '--verify', target]);
    if (exists.ok) continue;
    const renamed = await git(repoDir, ['branch', '-m', branch, target]);
    return renamed.ok ? target : null;
  }
  return null;
}

/** URL origin — по нему облачный режим понимает, какой репозиторий монтировать. */
export async function remoteUrl(dir: string): Promise<string | null> {
  const res = await git(dir, ['remote', 'get-url', 'origin']);
  return res.ok && res.stdout ? res.stdout : null;
}

/**
 * Забрать ветку из origin в локальный репозиторий. Облачный исполнитель
 * пушит результат в GitHub, и без этого «Показать diff» и «Смержить»
 * не с чем работать.
 */
export async function fetchBranch(dir: string, branch: string): Promise<boolean> {
  const res = await git(dir, ['fetch', 'origin', `+${branch}:${branch}`]);
  return res.ok;
}

/** Есть ли в рабочей копии незакоммиченные правки. */
export async function isDirty(dir: string): Promise<boolean> {
  const r = await git(dir, ['status', '--porcelain']);
  return r.ok && r.stdout !== '';
}

/**
 * Какие именно файлы правлены, но не закоммичены, — вместе с новыми.
 * Имя достаём регулярным выражением, а не по колонкам: вывод git приходит
 * сюда уже подрезанным по краям, и у первой строки ведущий пробел состояния
 * (` M файл`) теряется — разбор по позиции символа съел бы первую букву имени.
 */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const r = await git(dir, ['-c', 'core.quotepath=false', 'status', '--porcelain']);
  if (!r.ok || !r.stdout) return [];
  const files: string[] = [];
  for (const raw of r.stdout.split('\n')) {
    const m = /^(\S{1,2})\s+(.+)$/.exec(raw.trim());
    if (!m) continue;
    // Переименование приходит как «старое -> новое»: интересно новое имя.
    const parts = m[2].split(' -> ');
    const name = (parts[1] ?? parts[0]).trim().replace(/^"(.*)"$/, '$1');
    if (name && !files.includes(name)) files.push(name);
  }
  return files;
}

/**
 * Убрать правки рабочей копии в stash — вместе с неотслеживаемыми файлами.
 * Подпись нужна и здесь: stash делает настоящий коммит, а в чужом
 * репозитории git может быть не настроен, и он бы просто отказал.
 */
export async function stashPush(dir: string, message: string): Promise<boolean> {
  const r = await git(dir, ['stash', 'push', '--include-untracked', '-m', message], signed());
  return r.ok && !/no local changes/i.test(r.stdout);
}

/** Вернуть последний stash в рабочую копию. */
export async function stashPop(dir: string): Promise<{ ok: boolean; message: string }> {
  const r = await git(dir, ['stash', 'pop'], signed());
  return { ok: r.ok, message: r.ok ? r.stdout : (r.stderr || r.stdout) };
}

/**
 * Дошёл ли коммит до ревизии: лежит ли он в её истории. Нужно надзору, чтобы
 * заметить откат: коммит слияния закрытой задачи, которого больше нет в
 * основной ветке, — это работа, которую человек выбросил руками.
 * null — проверить не удалось (нет такого коммита или ревизии).
 */
export async function isAncestor(dir: string, commit: string, ref: string): Promise<boolean | null> {
  const r = await git(dir, ['merge-base', '--is-ancestor', commit, ref]);
  if (r.ok) return true;
  // Единица — честное «нет», всё остальное — поломка вызова.
  return r.code === 1 ? false : null;
}

/** Хеш ветки или ревизии. null — такой ревизии нет. */
export async function revision(dir: string, ref: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--verify', ref]);
  return r.ok && r.stdout ? r.stdout : null;
}

export interface BaseMerge {
  /** 'nothing' — база не ушла вперёд, сливать нечего. */
  kind: 'merged' | 'nothing' | 'conflict' | 'failed';
  conflicts: string[];
  message: string;
}

/**
 * Влить базовую ветку В ветку задачи, прямо в рабочей копии исполнителя.
 * Обратное направление обычному слиянию: так автор разбирается со своими
 * конфликтами сам и в своей копии, а основная ветка до самого конца остаётся
 * нетронутой.
 *
 * Конфликт НЕ отменяем: рабочая копия остаётся в состоянии незавершённого
 * слияния — именно её и чинит автор, а потом коммитит результат.
 */
export async function mergeBaseInto(
  worktreePath: string, base: string, lang: Lang, sign?: Signature,
): Promise<BaseMerge> {
  const behind = await git(worktreePath, ['rev-list', '--count', `HEAD..${base}`]);
  if (behind.ok && behind.stdout === '0') {
    return { kind: 'nothing', conflicts: [], message: t(lang, 'git.alreadyIncludes', { base }) };
  }

  const merge = await git(worktreePath, ['merge', '--no-edit', base], signed(sign));
  if (merge.ok) {
    return { kind: 'merged', conflicts: [], message: t(lang, 'git.baseMergedIn', { base }) };
  }

  const conflicted = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
  const conflicts = splitLines(conflicted.stdout);
  if (!conflicts.length) {
    // Не конфликт, а поломка: откатываем, чтобы не оставить копию в полуслиянии.
    await git(worktreePath, ['merge', '--abort']);
    return {
      kind: 'failed', conflicts: [],
      message: t(lang, 'git.baseMergeFailed', { base, error: merge.stderr || merge.stdout }),
    };
  }
  return {
    kind: 'conflict', conflicts,
    message: t(lang, 'git.conflictFiles', { base, files: conflicts.join(', ') }),
  };
}

/** Идёт ли в рабочей копии незавершённое слияние. */
export async function mergeInProgress(dir: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--verify', 'MERGE_HEAD']);
  return r.ok;
}

/** Бросить незавершённое слияние и вернуть копию как было. */
export async function abortMerge(dir: string): Promise<void> {
  await git(dir, ['merge', '--abort']);
}

/**
 * URL для походов в origin с токеном. Токен подставляется только в аргументы
 * одной команды и никогда не пишется в конфиг репозитория: иначе он утечёт
 * в .git/config вместе с проектом.
 */
function authUrl(url: string, token: string | null): string {
  if (!token) return url;
  const m = /^https:\/\/(?:[^@/]*@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (!m) return url;
  return `https://x-access-token:${token}@${m[1]}/${m[2]}.git`;
}

/** Отправить ветку в origin. force — ветку задачи переписывает только её автор. */
export async function pushBranch(
  repoDir: string, branch: string, token: string | null, lang: Lang,
): Promise<{ ok: boolean; message: string }> {
  const url = await remoteUrl(repoDir);
  if (!url) return { ok: false, message: t(lang, 'git.noOrigin') };
  const r = await git(repoDir, ['push', '--force-with-lease', authUrl(url, token), `${branch}:${branch}`]);
  return {
    ok: r.ok,
    // Токен мог попасть в текст ошибки вместе с URL — вырезаем.
    message: hideToken(r.ok ? r.stdout : (r.stderr || r.stdout), token),
  };
}

/** Убрать ветку задачи из origin — после того как её слили. */
export async function deleteRemoteBranch(
  repoDir: string, branch: string, token: string | null,
): Promise<boolean> {
  const url = await remoteUrl(repoDir);
  if (!url) return false;
  return (await git(repoDir, ['push', authUrl(url, token), '--delete', branch])).ok;
}

/** Подтянуть origin целиком: база могла уехать не только у нас. */
export async function fetchRemote(repoDir: string, token: string | null): Promise<boolean> {
  const url = await remoteUrl(repoDir);
  if (!url) return false;
  return (await git(repoDir, ['fetch', authUrl(url, token), '--prune'])).ok;
}

const hideToken = (s: string, token: string | null): string =>
  (token ? s.split(token).join('***') : s);

/**
 * Вернуть рабочую копию ветки задачи. Обычно она уже есть — её сделал
 * исполнитель; но конвейер переживает перезапуск сервера и уборку каталогов,
 * а чинить ветку без рабочей копии негде.
 */
export async function ensureWorktree(
  repoDir: string, worktreesRoot: string, taskId: string, branch: string,
): Promise<string | null> {
  const path = resolve(worktreesRoot, taskId);
  if (existsSync(resolve(path, '.git'))) return path;

  await rm(path, { recursive: true, force: true });
  await git(repoDir, ['worktree', 'prune']);
  const added = await git(repoDir, ['worktree', 'add', path, branch]);
  if (!added.ok) return null;
  await linkNodeModules(repoDir, path);
  return path;
}

/**
 * Подтянуть базовую ветку к удалённой без слияния. Нужно после того, как
 * пулл-реквест влили на GitHub: локальная копия основной ветки иначе отстаёт,
 * и следующая задача ответвится от вчерашнего кода.
 */
export async function fastForward(repoDir: string, base: string, remoteRef: string): Promise<boolean> {
  const now = await currentBranch(repoDir);
  if (now !== base) return false;
  if (await isDirty(repoDir)) return false;
  return (await git(repoDir, ['merge', '--ff-only', remoteRef])).ok;
}

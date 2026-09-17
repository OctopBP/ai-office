/**
 * Проверки окружения офиса: всё, без чего он не сможет выполнять задачи.
 *
 * Считаются при открытии офиса и по явному запросу — окружение живёт мимо
 * офиса (директорию удалили, git init сделали, ключ положили в переменную), и
 * единственный честный способ узнать о нём — сходить и посмотреть заново.
 * Провал проверки ничего не роняет: сервер стартует в любом случае, а список
 * с готовым текстом «что сделать» уезжает в состояние офиса. Место одно,
 * потому что раньше те же вопросы решались по ходу старта и ответ на них
 * оставался в консоли — там, где человек его уже не найдёт.
 */

import { accessSync, constants, statSync } from 'node:fs';
import type { EnvCheck, EnvReport } from '../shared/types';
import { repoProblem } from './git';
import type { Role } from './roles';
import type { OfficeState } from './state';

/** Проверка прошла: вопросов к окружению нет. */
const ok = (id: string, title: string, detail: string): EnvCheck =>
  ({ id, status: 'ok', title, detail, fix: '' });

/** Проверка провалилась: `fix` — что человеку сделать, чтобы стало ok. */
const fail = (id: string, title: string, detail: string, fix: string): EnvCheck =>
  ({ id, status: 'fail', title, detail, fix });

/**
 * Ключ модели. В облачном режиме он обязателен: Managed Agents работают только
 * на платном API, и без ключа офис не выполнит ни одной задачи. В локальном
 * режиме ключа может не быть — тогда работаем на авторизации Claude Code, и
 * это не провал, а другой источник расхода.
 */
function keyCheck(state: OfficeState): EnvCheck {
  const title = state.say('env.key.title');
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (state.settings.engine === 'cloud') {
    return hasKey
      ? ok('key', title, state.say('env.key.cloudOk'))
      // Текст про ключ один на весь офис: тот же, которым облако отказывает
      // в запуске задачи, — иначе проверка и отказ расходились бы в советах.
      : fail('key', title, state.say('env.key.cloudNone'), state.say('cloud.needApiKey'));
  }
  return ok('key', title, state.say(hasKey ? 'env.key.apiKey' : 'env.key.subscription'));
}

/**
 * Рабочая директория: есть, это директория и в неё можно писать. Прав на
 * запись хватает проверить один раз здесь: в них упираются и worktree, и
 * коммиты, и файлы, которые пишет исполнитель.
 */
function dirCheck(state: OfficeState): EnvCheck {
  const title = state.say('env.dir.title');
  const dir = state.projectDir;
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return fail('workdir', title, state.say('env.dir.missing', { dir }), state.say('env.dir.missingFix', { dir }));
  }
  if (!stat.isDirectory()) {
    return fail('workdir', title, state.say('env.dir.notDir', { dir }), state.say('env.dir.notDirFix'));
  }
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return fail('workdir', title, state.say('env.dir.readonly', { dir }), state.say('env.dir.readonlyFix', { dir }));
  }
  return ok('workdir', title, dir);
}

/**
 * Git рабочей директории. Заодно это единственное место, где выставляется
 * `gitReady`: изоляция задач по worktree возможна ровно тогда, когда проверка
 * зелёная, и держать два независимых ответа на один вопрос нельзя.
 */
async function gitCheck(state: OfficeState): Promise<EnvCheck> {
  const title = state.say('env.git.title');
  const dir = state.projectDir;
  // Та же проверка, что не даёт сохранить роль с негодным путём: старт и
  // форма роли обязаны одинаково считать, какой путь рабочий.
  const problem = await repoProblem(dir, state.lang());
  state.gitReady = problem === null;
  return problem === null
    ? ok('git', title, state.say('env.git.ok'))
    : fail('git', title, problem, state.say('env.git.fix', { dir }));
}

/**
 * Репозиторий роли. Роль может работать в своём репозитории — узнать, что путь
 * неверный, из проваленной задачи слишком поздно.
 */
async function roleRepoCheck(state: OfficeState, role: Role, dir: string): Promise<EnvCheck> {
  const title = state.say('env.repo.title', { role: role.title });
  const problem = await repoProblem(dir, state.lang());
  return problem === null
    ? ok(`repo:${role.id}`, title, dir)
    : fail(`repo:${role.id}`, title, problem, state.say('env.repo.fix', { role: role.title }));
}

/**
 * Состав офиса: задачу раздаёт менеджер, а выполняет исполнитель, и без любого
 * из них доска встанет. Считаем по ролям, а не по нанятым: сотрудников офис
 * заводит по активным ролям сам, и пустая роль — это ровно та дыра, которую
 * человеку надо закрыть.
 */
function rolesCheck(state: OfficeState): EnvCheck {
  const title = state.say('env.roles.title');
  const manager = state.activeRoles().find((r) => r.isManager);
  const workers = state.workerRoles();
  if (!manager) {
    return fail('roles', title, state.say('env.roles.noManager'), state.say('env.roles.noManagerFix'));
  }
  if (!workers.length) {
    return fail('roles', title, state.say('env.roles.noWorkers'), state.say('env.roles.noWorkersFix'));
  }
  return ok('roles', title, state.say('env.roles.ok', { n: workers.length, manager: manager.title }));
}

/**
 * Пересчитать проверки окружения и положить их в состояние офиса. Ничего не
 * бросает: проверка окружения, которая падает сама, бесполезна — поэтому даже
 * неожиданная ошибка превращается в проваленную проверку.
 */
export async function refreshEnvChecks(state: OfficeState): Promise<EnvReport> {
  const checks: EnvCheck[] = [keyCheck(state), dirCheck(state)];
  try {
    checks.push(await gitCheck(state));
  } catch (err) {
    state.gitReady = false;
    checks.push(fail('git', state.say('env.git.title'), (err as Error).message,
      state.say('env.git.fix', { dir: state.projectDir })));
  }
  checks.push(rolesCheck(state));
  // Архивные роли пропускаем: работать в них некому, и ходить в git ради
  // строчки про репозиторий уволенной роли незачем.
  for (const role of state.activeRoles()) {
    const dir = state.repoFor(role);
    if (dir === state.projectDir) continue;
    try {
      checks.push(await roleRepoCheck(state, role, dir));
    } catch (err) {
      checks.push(fail(`repo:${role.id}`, state.say('env.repo.title', { role: role.title }),
        (err as Error).message, state.say('env.repo.fix', { role: role.title })));
    }
  }
  return state.setEnv(checks);
}

/**
 * Напечатать проверки в консоль. Терминал видит тот, кто запустил сервер, и
 * именно ему чинить окружение: провал с готовым советом полезнее, чем зелёная
 * тишина, поэтому строка «что сделать» печатается отдельно.
 */
export function logEnvChecks(state: OfficeState, report: EnvReport): void {
  const bad = report.checks.filter((ch) => ch.status === 'fail');
  console.log(state.say(bad.length ? 'env.console.bad' : 'env.console.ok', {
    n: bad.length, total: report.checks.length,
  }));
  for (const ch of report.checks) {
    console.log(`   ${ch.status === 'ok' ? '✅' : '⚠️ '} ${ch.title}: ${ch.detail}`);
    if (ch.fix) console.log(`      → ${ch.fix}`);
  }
}

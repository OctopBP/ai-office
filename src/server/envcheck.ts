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
import { OFFICE_SENDER } from '../shared/types';
import type { EnvCheck, EnvReport } from '../shared/types';
import { PROVIDER_IDS, PROVIDERS, isConnected, type ProviderId } from '../shared/providers';
import { engineFor, type ProviderStatus } from './engines';
import { repoProblem } from './git';
import type { Role } from './roles';
import { criticalEnvFail } from './state';
import type { OfficeState, Task } from './state';

/**
 * Критичные проверки: пока такая красная, не выполнима ни одна задача, и
 * пробовать — значит платить за гарантированный провал. Список намеренно
 * короткий.
 *
 * `git` в него не входит: без репозитория теряется изоляция по worktree, но
 * задача выполнима — офис работает прямо в директории. `roles` не входит,
 * потому что пустую роль уже ловит проверка «некому взять» на раздаче, а
 * `repo:<roleId>` — потому что он мешает одной роли, а не офису, и общий стоп
 * из-за него остановил бы всех остальных. По той же причине `provider:<id>`
 * критичен, только если на нём работает менеджер (или облако): без него не
 * раздать ни одной задачи. Провайдер одних исполнителей останавливает только
 * их задачи — с причиной на карточке (`roleProviderProblem`).
 */
const isCritical = (id: string): boolean => id === 'workdir' || id.startsWith('provider:');

/** Проверка прошла: вопросов к окружению нет. */
const ok = (id: string, title: string, detail: string): EnvCheck =>
  ({ id, status: 'ok', title, detail, fix: '', critical: isCritical(id) });

/** Проверка провалилась: `fix` — что человеку сделать, чтобы стало ok. */
const fail = (id: string, title: string, detail: string, fix: string): EnvCheck =>
  ({ id, status: 'fail', title, detail, fix, critical: isCritical(id) });

/**
 * Провайдеры, которым есть кого обслуживать: на каждом хотя бы одна активная
 * роль. В облачном режиме Claude проверяется всегда — Managed Agents считают
 * на нём весь офис, какие бы провайдеры ни стояли у ролей.
 */
function providersInUse(state: OfficeState): ProviderId[] {
  return PROVIDER_IDS.filter((id) =>
    (id === 'claude-code' && state.settings.engine === 'cloud')
    || state.activeRoles().some((role) => state.runtimeOf(role)?.provider === id));
}

/** Провайдер, без которого офис не работает вовсе: менеджера или облака. */
function officeWideProvider(state: OfficeState, provider: ProviderId): boolean {
  if (provider === 'claude-code' && state.settings.engine === 'cloud') return true;
  return state.officeRuntime()?.provider === provider;
}

/**
 * Роли без провайдера: своего выбора нет, а провайдер офиса не выбран.
 * Claude Code им не подставляется — их задачи встают с причиной.
 */
function unsetRoles(state: OfficeState): Role[] {
  return state.activeRoles().filter((role) => !state.runtimeOf(role));
}

/**
 * Провайдер не выбран. Критична, когда без провайдера остался менеджер: тогда
 * не раздать ни одной задачи. Без провайдера одни исполнители — встают только
 * их задачи, с причиной на карточке (`roleProviderProblem`).
 */
function unsetProviderCheck(state: OfficeState, roles: Role[]): EnvCheck {
  return {
    ...fail('provider:unset', state.say('env.provider.unsetTitle'),
      state.say('env.provider.unsetDetail', { roles: roles.map((r) => r.title).join(', ') }),
      state.say('env.provider.unsetFix')),
    critical: state.officeRuntime() === null,
  };
}

/**
 * Почему задача этой роли сейчас не стартует на её провайдере, — готовым
 * текстом «что подключить», или null, если провайдер подключён (при лимите
 * тоже: окно откроется само, и это уже забота надзора). Проверка только по
 * метаданным: платный ход модели ради неё не запускается.
 *
 * Запасного провайдера нет намеренно: задача, тихо уехавшая на другой
 * провайдер, тратила бы чужой счёт и работала бы не той моделью.
 */
export async function roleProviderProblem(state: OfficeState, role: Role): Promise<string | null> {
  const runtime = state.runtimeOf(role);
  if (!runtime) return state.say('agent.provider.unset', { role: role.title });
  const { provider } = runtime;
  const check = await providerCheck(state, provider);
  if (check.status === 'ok') return null;
  return state.say('agent.task.providerNotReady', {
    role: role.title, provider: check.title, detail: check.detail, fix: check.fix,
  });
}

/**
 * Провайдер — одна проверка `provider:<id>` по статусу его движка (spec
 * провайдеров §5.3): ставить ли движок, войти ли, ждать ли лимита — всё это
 * отвечает адаптер, а не envcheck. `ready` и `limited` — ок: при лимите офис
 * сам ждёт сброса, чинить человеку нечего. Остальное — провал с советом.
 */
export async function providerCheck(state: OfficeState, provider: ProviderId): Promise<EnvCheck> {
  const check = await providerStatusCheck(state, provider);
  return { ...check, critical: officeWideProvider(state, provider) };
}

async function providerStatusCheck(state: OfficeState, provider: ProviderId): Promise<EnvCheck> {
  const id = `provider:${provider}`;
  const title = PROVIDERS[provider].label;
  let status: ProviderStatus;
  try {
    status = await engineFor(provider).status(provider);
  } catch (err) {
    status = { state: 'error', detail: (err as Error).message };
  }
  const cloud = provider === 'claude-code' && state.settings.engine === 'cloud';
  switch (status.state) {
    case 'ready':
      if (cloud) {
        // Managed Agents работают только на платном API: вход Claude Code по
        // подписке облаку не годится. Текст совета тот же, которым облако
        // отказывает в запуске задачи, — иначе проверка и отказ расходились бы.
        return status.auth === 'api-key'
          ? ok(id, title, state.say('env.key.cloudOk'))
          : fail(id, title, state.say('env.key.cloudNone'), state.say('cloud.needApiKey'));
      }
      if (provider === 'claude-code') {
        return ok(id, title, state.say(status.auth === 'api-key' ? 'env.key.apiKey' : 'env.key.subscription'));
      }
      return ok(id, title, state.say('env.provider.ready'));
    case 'limited':
      return ok(id, title, status.detail ?? state.say('env.provider.limited'));
    case 'not-installed':
      return provider === 'claude-code'
        ? fail(id, title, state.say('env.engine.none'), state.say('env.engine.noneFix'))
        : fail(id, title, status.detail ?? state.say('env.provider.notInstalled'), state.say('env.engine.noneFix'));
    case 'needs-login':
      return fail(id, title, status.detail ?? state.say('env.provider.needsLogin'),
        state.say(provider === 'codex' ? 'env.provider.codexFix' : 'env.provider.loginFix'));
    case 'installing':
      return fail(id, title, state.say('env.provider.installing'), state.say('env.engine.noneFix'));
    case 'unreachable':
    case 'error':
      return fail(id, title, status.detail,
        state.say(provider === 'codex' ? 'env.provider.codexFix' : 'env.provider.loginFix'));
  }
}

/**
 * Подключён ли хоть один провайдер. Провайдер по умолчанию у офиса — лишь
 * стартовое значение выбора, а не требование: пока не подключён никто, речь о
 * том, что провайдера нет вовсе, а не о том, что не стоит именно Claude Code.
 */
async function anyProviderReady(): Promise<boolean> {
  const statuses = await Promise.all(PROVIDER_IDS.map((id) =>
    engineFor(id).status(id).catch((err: Error): ProviderStatus => ({ state: 'error', detail: err.message }))));
  return statuses.some(isConnected);
}

/**
 * Одна проверка вместо провала по каждому провайдеру ролей: человеку чинить
 * одно — выбрать и подключить провайдера. Критична: без провайдера не
 * выполнится ни одна задача. Id с префиксом `provider:` — как у остальных
 * проверок провайдера, баннер по нему же предлагает перейти к выбору.
 */
const NO_PROVIDER_CHECK = 'provider:none';

function noProviderCheck(state: OfficeState): EnvCheck {
  return fail(NO_PROVIDER_CHECK, state.say('env.provider.noneTitle'),
    state.say('env.provider.noneDetail'), state.say('env.provider.noneFix'));
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
  const checks: EnvCheck[] = [dirCheck(state)];
  if (await anyProviderReady()) {
    checks.push(...await Promise.all(providersInUse(state).map((id) => providerCheck(state, id))));
    // Подключённый провайдер есть, но кому-то он не назначен: это отдельная
    // беда — чинится выбором, а не входом.
    const unset = unsetRoles(state);
    if (unset.length) checks.push(unsetProviderCheck(state, unset));
  } else {
    checks.push(noProviderCheck(state));
  }
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
 * Почему офис сейчас не может выполнить ни одной задачи, готовым к показу
 * текстом, — или null, если критичные проверки зелёные. Одна причина, а не
 * список: человеку чинить по одной, а карточке задачи нужна строка.
 *
 * Пока проверок ещё не считали (`at === 0`), молчим: на этот момент офис о
 * своём окружении не знает ничего, и «ждут окружения» было бы догадкой.
 */
export function envBlock(state: OfficeState): string | null {
  const bad = criticalEnvFail(state.env.checks);
  if (!bad || state.env.at === 0) return null;
  return bad.fix
    ? state.say('env.block.reason', { title: bad.title, detail: bad.detail, fix: bad.fix })
    : state.say('env.block.reasonBare', { title: bad.title, detail: bad.detail });
}

/**
 * Пометить задачу ждущей окружения. Одна строка в ленту на постановку, как у
 * очереди за слотом: раздачу дёргает надзор каждый проход, и без этого лента
 * заполнилась бы одним и тем же сообщением.
 */
export function markEnvWait(state: OfficeState, task: Task, reason: string): void {
  if (task.envWait === reason) return;
  const first = task.envWait === null;
  state.updateTask(task.id, { envWait: reason });
  if (!first) return;
  state.addChat(OFFICE_SENDER,
    state.say('env.wait.chat', { task: task.id, title: task.title, reason }));
  state.addLog(null, 'system', state.say('env.wait.log', { task: task.id }));
}

/**
 * Окружение починили — снять ожидание со всех задач офиса. Причину стираем
 * молча: про починку офис скажет одной строкой тот, кто отпускает очередь, а
 * не каждая задача по отдельности.
 */
export function clearEnvWait(state: OfficeState): Task[] {
  const freed: Task[] = [];
  for (const task of [...state.tasks.values()]) {
    if (!task.envWait) continue;
    const updated = state.updateTask(task.id, { envWait: null });
    if (updated) freed.push(updated);
  }
  return freed;
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

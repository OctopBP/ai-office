/**
 * Смена базового проекта роли менеджером (инструмент `set_role_base`):
 * закрепление за зонами или путь репозитория роли. Правку делает тот же
 * `editRole`, что и форма роли в интерфейсе, — проверки пути, заведение
 * repo-зоны и рассылка ролей одни на всех. Здесь только то, что нужно
 * менеджеру сверх формы: разбор его слов, строгая проверка зон, строка в
 * ленту «было → стало» и перечень задач, которых смена не коснётся.
 */
import type { OfficeState, Task } from './state';
import type { Role } from './roles';
import { admits } from './subprojects';

export interface RoleBaseInput {
  roleId: string;
  /** id зоны, несколько через запятую или `none`. undefined — закрепление не называли. */
  subprojectId?: string;
  /** Путь к репозиторию роли; пустая строка — общий репозиторий офиса. undefined — путь не называли. */
  path?: string;
}

export interface RoleBaseOutcome {
  ok: boolean;
  message: string;
}

/** Задача уже стартовала: репозиторий, ветка и копия у неё свои, смена роли их не трогает. */
const isRunning = (task: Task): boolean =>
  task.status === 'assigned' || task.status === 'in_progress' || task.status === 'review'
  || (task.status === 'blocked' && Boolean(task.repoDir));

/** Задача ещё поедет: не закрыта, не снята и не провалена. */
const isOpen = (task: Task): boolean =>
  task.status !== 'done' && task.status !== 'failed' && task.status !== 'cancelled';

/** База роли словами: зоны и папка, в которой роль работает вне задачи. */
function baseWord(state: OfficeState, role: Role): string {
  const subs = state.subprojects();
  const own = role.subprojects ?? [];
  const zones = own.length
    ? own.map((id) => {
      const name = subs.find((s) => s.id === id)?.name;
      return name && name !== id ? `${id} (${name})` : id;
    }).join(', ')
    : state.say('subprojects.zone.whole');
  return state.say('roleBase.where', { zones, dir: state.repoForRole(role) });
}

/**
 * Сменить базу роли. Ровно одно из двух: `subprojectId` — закрепление за
 * существующими зонами (`none` — снять), `path` — репозиторий роли (пусто —
 * общий репозиторий офиса). Отказ не меняет ничего.
 */
export async function setRoleBase(state: OfficeState, input: RoleBaseInput): Promise<RoleBaseOutcome> {
  const no = (message: string): RoleBaseOutcome => ({ ok: false, message });
  const roleId = input.roleId.trim();
  const before = state.role(roleId);
  if (!before) return no(state.say('state.role.missing', { role: roleId }));
  if (before.isManager) return no(state.say('subprojects.err.pinManager'));

  // Модель нередко шлёт необязательный параметр пустой строкой. Пустая зона
  // рядом с путём — «зону не называли»; пустой путь рядом с зоной — тоже.
  // Пусто и там и там неотличимо от «ничего не сказал», и угадывать нельзя:
  // одно из прочтений снимает закрепление. Сброс — это пустой путь без зоны.
  const zoneRaw = input.subprojectId?.trim();
  const pathRaw = input.path?.trim();
  if (zoneRaw && pathRaw) return no(state.say('roleBase.err.both'));
  const reset = input.path !== undefined && input.subprojectId === undefined;
  if (!zoneRaw && !pathRaw && !reset) return no(state.say('roleBase.err.neither'));

  const zonesBefore = state.subprojects().length;
  let errors;
  if (zoneRaw) {
    const ids = zoneRaw === 'none'
      ? []
      : [...new Set(zoneRaw.split(',').map((id) => id.trim()).filter(Boolean))];
    // Строже формы: та терпит пропавшую зону, уже стоящую на роли, чтобы не
    // мешать снять соседнюю. Менеджер называет закрепление целиком — и
    // закрепить за зоной, которой нет, значит оставить роль без задач.
    const known = state.subprojects().map((s) => s.id);
    const unknown = ids.find((id) => !known.includes(id));
    if (unknown) {
      return no(state.say('subprojects.zone.unknown', { zone: unknown, zones: known.join(', ') || '—' }));
    }
    errors = await state.editRole(roleId, { subprojects: ids });
  } else {
    errors = await state.editRole(roleId, { repoDir: pathRaw ?? '' });
  }
  if (errors.length) return no(errors.map((e) => e.message).join(' '));

  const after = state.role(roleId) as Role;
  const was = baseWord(state, before);
  const now = baseWord(state, after);
  const label = after.title && after.title !== after.id ? `${after.id} (${after.title})` : after.id;
  if ((before.subprojects ?? []).join() === (after.subprojects ?? []).join()) {
    return { ok: true, message: state.say('roleBase.same', { role: label, now }) };
  }

  state.addLog(null, 'system', state.say('roleBase.log', { role: label, was, now }));
  // Роли уже разосланы самим editRole, но закреплённые в зоне и заведённая
  // по пути зона едут только в снимке: без него список подпроектов в
  // настройках остался бы прежним до перезагрузки страницы.
  state.emit(state.snapshot());

  const lines = [state.say('roleBase.done', { role: label, was, now })];
  if (state.subprojects().length > zonesBefore) {
    const made = state.subprojects()[state.subprojects().length - 1];
    lines.push(state.say('roleBase.zoneCreated', { zone: made.id, root: made.root }));
  }
  const own = [...state.tasks.values()].filter((t) => t.roleId === roleId && isOpen(t));
  const running = own.filter(isRunning);
  if (running.length) {
    lines.push(state.say('roleBase.running'));
    for (const t of running) {
      lines.push(state.say('roleBase.taskRow', {
        task: t.id, title: t.title, status: t.status, dir: t.repoDir ?? state.repoForTask(t),
      }));
    }
    // Доработку после ревью допуск проверяет заново (spec подпроектов §3.2):
    // молчать об этом значит обещать менеджеру больше, чем офис сделает.
    if (running.some((t) => !admits(after, t.subprojectId))) lines.push(state.say('roleBase.reworkNote'));
  }
  // Зона задачи записана при заведении и за ролью не переезжает: задача,
  // которая ещё не стартовала, встанет на допуске, пока её не перенесут.
  const stuck = own.filter((t) => !isRunning(t) && !admits(after, t.subprojectId));
  if (stuck.length) {
    lines.push(state.say('roleBase.stuck'));
    for (const t of stuck) {
      const zone = t.subprojectId ?? state.say('subprojects.zone.whole');
      lines.push(state.say('roleBase.stuckRow', { task: t.id, title: t.title, zone }));
    }
  }
  return { ok: true, message: lines.join('\n') };
}

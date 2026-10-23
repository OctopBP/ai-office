/**
 * Запрос доступа песочницы через вопрос владельцу (T-685).
 *
 * Исполнитель упирается в «Operation not permitted» и спрашивает владельца.
 * Раньше ответ «Открыть доступ» ложился только в журнал, а права не менялись.
 * Теперь у вопроса есть структура — какие пути на запись и какие хосты
 * нужны, — и согласие владельца дописывает их в настройку песочницы роли
 * (`writePaths`, `allowedHosts`, T-684). Действуют они со следующей сессии
 * роли: песочница собирается на старте сессии, идущую не перестроить.
 *
 * Вопрос о доступе свободным текстом права не меняет и не обещает: офис
 * помечает его как ручную настройку и говорит, где её сделать.
 */
import type { OwnerQuestion, SandboxRequest } from '../shared/types';
import { badSandboxEntries, cleanAllowedHost, cleanAllowedHosts, cleanWritePath, cleanWritePaths } from '../shared/sandbox';
import type { UnityProjectChoice } from './mcp';
import type { SandboxRule, SandboxView } from './sandbox';
import type { OfficeState } from './state';

/** Разобранный запрос: годные записи и то, что не годится (для ошибки агенту). */
export interface ParsedRequest {
  request: SandboxRequest | null;
  bad: string[];
}

/** Привести запрос от агента к годному виду. Пустой запрос — `request: null`. */
export function parseSandboxRequest(raw: unknown): ParsedRequest {
  if (!raw || typeof raw !== 'object') return { request: null, bad: [] };
  const { writePaths, allowedHosts } = raw as Partial<Record<keyof SandboxRequest, unknown>>;
  const paths = Array.isArray(writePaths) ? writePaths : [];
  const hosts = Array.isArray(allowedHosts) ? allowedHosts : [];
  const bad = [...badSandboxEntries(paths, cleanWritePath), ...badSandboxEntries(hosts, cleanAllowedHost)];
  const request = { writePaths: cleanWritePaths(paths), allowedHosts: cleanAllowedHosts(hosts) };
  return { request: request.writePaths.length || request.allowedHosts.length ? request : null, bad };
}

/**
 * Похож ли вопрос на просьбу о доступе песочницы. Нарочно узкий: ложное
 * срабатывание добавит к обычному вопросу лишнюю приписку, и только.
 */
export function looksLikeAccessQuestion(text: string): boolean {
  return /песочниц|sandbox|operation not permitted|\beperm\b|allowWrite|allowedDomains|прав[аео]? на запись|доступ\w* (на запись|к сети|к хост|к домен|к папк|к каталог)|write access|network access/i
    .test(text);
}

/** Кнопки вопроса о доступе: согласие первым — оно и есть «Открыть доступ…». */
export function accessOptions(state: OfficeState, roleId: string): string[] {
  return [state.say('access.option.grant', { role: roleId }), state.say('access.option.deny')];
}

/**
 * Согласие ли это. Кнопка согласия — да; свободный ответ — если начинается
 * с «открыть», «да», «разрешить» и подобного. Всё прочее (в том числе
 * «Не открывать» и «нет») — отказ: права расширяются только явным «да».
 */
export function isGrantAnswer(state: OfficeState, question: OwnerQuestion, answer: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const given = norm(answer);
  const roleId = question.sandboxRequest?.roleId ?? '';
  if (given === norm(accessOptions(state, roleId)[0])) return true;
  if (given === norm(accessOptions(state, roleId)[1])) return false;
  // \b в JS не видит кириллицу — конец слова проверяем сами: «да», но не «дальше».
  return /^(открыть|открой|откройте|разреш|согласен|согласна|open|allow|grant|approve|(да|ок|ok|yes)(?!\p{L}))/iu.test(given);
}

/** Строка списка для текста: `a, b` или прочерк. */
const list = (items: readonly string[]): string => (items.length ? items.join(', ') : '—');

/** Приписка к тексту вопроса о доступе: что именно просят и когда начнёт действовать. */
export function requestText(state: OfficeState, roleId: string, request: SandboxRequest): string {
  return state.say('access.requestText', {
    role: roleId, paths: list(request.writePaths), hosts: list(request.allowedHosts),
  });
}

/**
 * Применить ответ владельца на запрос доступа. Согласие дописывает пути и
 * хосты в настройку роли (поверх того, что там уже есть), отказ ничего не
 * меняет. Оба исхода — событием в ленту. Возвращает строку для чата.
 */
export function applyAccessAnswer(state: OfficeState, question: OwnerQuestion, answer: string): string {
  const request = question.sandboxRequest;
  if (!request) return '';
  const { roleId } = request;
  if (!isGrantAnswer(state, question, answer)) {
    state.addLog(null, 'system', state.say('access.deniedLog', { id: question.id, role: roleId }));
    return state.say('access.deniedChat', { id: question.id, role: roleId });
  }
  const role = state.role(roleId);
  if (!role) {
    state.addLog(null, 'system', state.say('access.noRoleLog', { id: question.id, role: roleId }));
    return state.say('access.noRoleLog', { id: question.id, role: roleId });
  }
  const hadPaths = cleanWritePaths(role.writePaths);
  const hadHosts = cleanAllowedHosts(role.allowedHosts);
  const writePaths = cleanWritePaths([...hadPaths, ...request.writePaths]);
  const allowedHosts = cleanAllowedHosts([...hadHosts, ...request.allowedHosts]);
  const granted: SandboxRequest = {
    writePaths: writePaths.filter((p) => !hadPaths.includes(p)),
    allowedHosts: allowedHosts.filter((h) => !hadHosts.includes(h)),
  };
  // Не влезло в предел списка — говорим прямо, а не делаем вид, что открыли.
  const skipped = [
    ...request.writePaths.filter((p) => !writePaths.includes(p)),
    ...request.allowedHosts.filter((h) => !allowedHosts.includes(h)),
  ];
  if (granted.writePaths.length || granted.allowedHosts.length) state.updateRole(roleId, { writePaths, allowedHosts });
  state.updateQuestion(question.id, { sandboxGranted: granted });
  const vars = {
    id: question.id, role: roleId, paths: list(granted.writePaths), hosts: list(granted.allowedHosts),
    skipped: skipped.length ? state.say('access.skipped', { items: skipped.join(', ') }) : '',
  };
  state.addLog(null, 'system', state.say('access.grantedLog', vars));
  return state.say('access.grantedChat', vars);
}

/**
 * Какие записи песочницы роли пришли ответом владельца: запись → Q-N.
 * Берётся из отвеченных вопросов, а не хранится на роли: убрал владелец
 * запись руками — её нет в роли, и источник ни на что не влияет.
 */
export function sandboxGrants(state: OfficeState, roleId: string): Map<string, string> {
  const grants = new Map<string, string>();
  for (const q of state.questionList()) {
    if (q.sandboxRequest?.roleId !== roleId || !q.sandboxGranted) continue;
    for (const entry of [...q.sandboxGranted.writePaths, ...q.sandboxGranted.allowedHosts]) grants.set(entry, q.id);
  }
  return grants;
}

// ------------------------------------------------------------ sandbox_status

/** Сколько команд вне песочницы перечислять в `sandbox_status`. */
const UNSANDBOXED_SHOWN = 8;

function ruleLine(state: OfficeState, rule: SandboxRule): string {
  const source = state.say(`sandbox.status.source.${rule.source}`, { id: rule.questionId ?? '' });
  return `- ${rule.value} — ${source}: ${state.say(`sandbox.status.reason.${rule.reason}`)}`;
}

function rulesBlock(state: OfficeState, title: string, rules: readonly SandboxRule[]): string {
  return [title, ...(rules.length ? rules.map((r) => ruleLine(state, r)) : [state.say('sandbox.status.none')])].join('\n');
}

/**
 * Текст инструмента `sandbox_status`: права, с которыми стартовала сессия,
 * с источником каждого правила, рабочая копия и путь моста Unity. `next` —
 * права по нынешней настройке роли: что в них сверх сессии, придёт со
 * следующей сессией (ответ владельца, правка роли).
 */
export function sandboxStatusText(
  state: OfficeState, view: SandboxView, next: SandboxView | null, unity: UnityProjectChoice | null,
): string {
  const parts = [
    state.say('sandbox.status.cwd', { path: view.cwd ?? '—' }),
    rulesBlock(state, state.say('sandbox.status.write'), view.write),
    rulesBlock(state, state.say('sandbox.status.read'), view.read),
    state.say('sandbox.status.readNote'),
    rulesBlock(state, state.say('sandbox.status.hosts'), view.hosts),
    state.say(view.localBinding ? 'sandbox.status.localOn' : 'sandbox.status.localOff'),
  ];
  // У Unity шаблонов под три десятка — первых хватает, чтобы понять правило.
  const shown = view.unsandboxed.slice(0, UNSANDBOXED_SHOWN);
  const more = view.unsandboxed.length - shown.length;
  if (shown.length) {
    parts.push(state.say('sandbox.status.unsandboxed', { list: shown.join(', ') + (more > 0 ? ` (+${more})` : '') }));
  }
  parts.push(unity
    ? state.say('sandbox.status.unity', {
      path: unity.path, reason: state.say(`agent.log.unityProject.${unity.reason}`),
      editor: state.say(unity.editorOpen ? 'sandbox.status.editorOpen' : 'sandbox.status.editorClosed'),
    })
    : state.say('sandbox.status.noUnity'));
  if (next) {
    const has = (rules: readonly SandboxRule[], value: string): boolean => rules.some((r) => r.value === value);
    const pending = [
      ...next.write.filter((r) => !has(view.write, r.value)),
      ...next.hosts.filter((r) => !has(view.hosts, r.value)),
    ];
    if (pending.length) parts.push(rulesBlock(state, state.say('sandbox.status.pending'), pending));
  }
  parts.push(state.say('sandbox.status.howTo'));
  return parts.join('\n\n');
}

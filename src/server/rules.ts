/**
 * Правила офиса (docs/design/rules/spec.md): как работать, в отличие от
 * направлений, которые говорят, что делать.
 *
 * Правило живёт файлом `RULES.md`, а не записью в состоянии, и круг правила
 * задаётся тем, где этот файл лежит: в корне офиса — правило для всех, в корне
 * репозитория — для всех, кто в нём работает. Так правило про анимации уезжает
 * вместе с фронтенд-репозиторием, видно в diff, правится руками мимо офиса и
 * достаётся сразу всем трём фронтендерам, а не вписывается в бриф каждого.
 *
 * Третий круг — роль: её правила по-прежнему лежат в приписке к брифу
 * (`selfchange.ts`), и здесь они только показываются. Двух редакторов одного
 * текста быть не должно.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { RuleScopeView, RuleView } from '../shared/types';
import type { Role } from './roles';
import type { OfficeState } from './state';

/** Имя файла правил. Одно и то же в корне офиса и в корне репозитория. */
export const RULES_FILE = 'RULES.md';

/** Заголовок, под которым правила роли лежат в брифе (см. selfchange.ts). */
const ROLE_RULES_HEADER = '## Правила офиса';

export const MAX_RULE_LEN = 500;
export const MAX_RULES = 50;

/** Сколько символов правил уезжает в промпт: дальше блок обрезается, как бриф. */
const PROMPT_LIMIT = 4000;

/**
 * Разобранный файл: правила отдельно, всё остальное — дословно. Файл читает не
 * только офис, но и человек, поэтому его шапку и хвост мы не пересобираем.
 */
export interface RulesDoc {
  head: string;
  rules: string[];
  tail: string;
}

const BULLET = /^-\s+(?=\S)/;

/** Пункт списка верхнего уровня — правило; строка с отступом — его продолжение. */
export function parseRules(text: string): RulesDoc {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((l) => BULLET.test(l));
  if (first < 0) return { head: text.trim(), rules: [], tail: '' };

  const rules: string[] = [];
  let current: string[] | null = null;
  // Где кончился блок правил: пустые строки внутри блока в хвост не уводят.
  let blockEnd = first;
  let i = first;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (BULLET.test(line)) {
      if (current) rules.push(current.join(' '));
      current = [line.replace(BULLET, '').trim()];
      blockEnd = i + 1;
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      current.push(line.trim());
      blockEnd = i + 1;
      continue;
    }
    if (!line.trim()) continue;
    break;
  }
  if (current) rules.push(current.join(' '));

  return {
    head: lines.slice(0, first).join('\n').trim(),
    rules,
    tail: lines.slice(blockEnd).join('\n').trim(),
  };
}

export function serializeRules(doc: RulesDoc): string {
  const blocks = [
    doc.head.trim(),
    doc.rules.map((r) => `- ${r}`).join('\n'),
    doc.tail.trim(),
  ].filter(Boolean);
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

const filePath = (dir: string): string => resolve(dir, RULES_FILE);

export function readRulesFile(dir: string): RulesDoc {
  try {
    return parseRules(readFileSync(filePath(dir), 'utf8'));
  } catch {
    // файла нет или он не читается — правил просто нет
    return { head: '', rules: [], tail: '' };
  }
}

/**
 * Записать файл. Шапку дописываем только новому файлу: она объясняет человеку,
 * который откроет `RULES.md` в репозитории, почему список не стоит ломать.
 */
function writeRulesFile(state: OfficeState, dir: string, doc: RulesDoc): string | null {
  const head = doc.head.trim() || state.say('rules.fileHead');
  try {
    writeFileSync(filePath(dir), serializeRules({ ...doc, head }), 'utf8');
    return null;
  } catch (err) {
    return state.say('rules.writeFailed', { file: filePath(dir), error: (err as Error).message });
  }
}

/** Ключ направления из пути: имя папки латиницей. Пустой — первые буквы пути. */
const slug = (dir: string): string => basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'repo';

/** Правила роли — из приписки к брифу пакета или из раздела в её брифе. */
function roleRules(role: Role): string[] {
  const text = role.package
    ? role.package.briefExtra
    : role.brief.split(ROLE_RULES_HEADER)[1] ?? '';
  return text.split('\n').map((l) => l.replace(BULLET, '').trim()).filter(Boolean);
}

const ruleViews = (scopeId: string, texts: string[]): RuleView[] =>
  texts.map((text, i) => ({ id: `${scopeId}#${i + 1}`, scopeId, text }));

/**
 * Круги правил этого офиса: офис, направления (репозитории, где работают роли)
 * и роли. Считается на каждый запрос, а не хранится: источник правды — файлы и
 * брифы, и список, разошедшийся с ними, врал бы обеим сторонам.
 */
export function ruleScopes(state: OfficeState): RuleScopeView[] {
  const roles = state.roles().filter((r) => !r.archived);
  const atDir = (dir: string): Role[] => roles.filter((r) => state.repoFor(r) === dir);

  const office: RuleScopeView = {
    id: 'office',
    kind: 'office',
    label: state.say('rules.scope.office'),
    path: state.projectDir,
    roles: atDir(state.projectDir).map((r) => ({ id: r.id, title: r.title })),
    editable: true,
    rules: ruleViews('office', readRulesFile(state.projectDir).rules),
  };

  // Направления — по репозиториям ролей. Совпал с корнем офиса — это и есть
  // офисный круг, второй раз он не показывается.
  const dirs = [...new Set(roles.map((r) => state.repoFor(r)))]
    .filter((dir) => dir !== state.projectDir)
    .sort();
  const taken = new Set(['office']);
  const repos = dirs.map((dir) => {
    let id = `repo:${slug(dir)}`;
    for (let n = 2; taken.has(id); n += 1) id = `repo:${slug(dir)}-${n}`;
    taken.add(id);
    return {
      id,
      kind: 'repo' as const,
      label: basename(dir),
      path: dir,
      roles: atDir(dir).map((r) => ({ id: r.id, title: r.title })),
      editable: true,
      rules: ruleViews(id, readRulesFile(dir).rules),
    };
  });

  const roleScopes = roles
    .map((role) => ({ role, rules: roleRules(role) }))
    .filter(({ rules }) => rules.length)
    .map(({ role, rules }) => ({
      id: `role:${role.id}`,
      kind: 'role' as const,
      label: role.title,
      path: '',
      roles: [{ id: role.id, title: role.title }],
      // Правила роли правятся в её карточке: они часть брифа, а не файла.
      editable: false,
      rules: ruleViews(`role:${role.id}`, rules),
    }));

  return [office, ...repos, ...roleScopes];
}

const scopeById = (state: OfficeState, id: string): RuleScopeView | undefined =>
  ruleScopes(state).find((s) => s.id === id);

/** Правила одного круга строками — для промпта и для проверок. */
export const rulesOf = (state: OfficeState, scopeId: string): string[] =>
  scopeById(state, scopeId)?.rules.map((r) => r.text) ?? [];

function block(header: string, rules: string[]): string {
  return rules.length ? `\n\n${header}\n${rules.map((r) => `- ${r}`).join('\n')}` : '';
}

/**
 * Правила в системный промпт. Клеится туда же, куда бриф проекта, и в ту же
 * статическую часть: правила меняются редко, и платить за них в каждой
 * короткой сессии незачем.
 *
 * Исполнитель получает свой круг: офис и свой репозиторий. Менеджер — все
 * круги с подписями: файлов он не видит, а критерии готовности пишет он, и
 * правило, до него не доехавшее, так и останется пожеланием.
 */
export function rulesBrief(state: OfficeState, roleId: string | null): string {
  const scopes = ruleScopes(state);
  const office = scopes.find((s) => s.id === 'office');
  let text = block(state.say('prompt.rules.office'), office?.rules.map((r) => r.text) ?? []);

  if (roleId) {
    const role = state.role(roleId);
    const dir = role ? state.repoFor(role) : state.projectDir;
    const own = scopes.find((s) => s.kind === 'repo' && s.path === dir);
    if (own) text += block(state.say('prompt.rules.repo', { label: own.label }), own.rules.map((r) => r.text));
  } else {
    for (const scope of scopes) {
      if (scope.kind === 'repo') {
        const who = scope.roles.map((r) => r.id).join(', ') || state.say('rules.nobody');
        text += block(state.say('prompt.rules.repo', { label: `${scope.label} — ${who}` }), scope.rules.map((r) => r.text));
      }
      if (scope.kind === 'role') {
        text += block(state.say('prompt.rules.role', { role: scope.roles[0]?.id ?? scope.label }), scope.rules.map((r) => r.text));
      }
    }
  }

  if (text.length <= PROMPT_LIMIT) return text;
  return `${text.slice(0, PROMPT_LIMIT)}\n${state.say('prompt.rules.clipped')}`;
}

/** Результат правки: либо готовое правило, либо причина отказа словами. */
export type RuleResult = { ok: true; rule: RuleView } | { ok: false; error: string };

/** Текст правила одной строкой: перенос внутри пункта списка сломал бы файл. */
function cleanText(state: OfficeState, text: string): string | { error: string } {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return { error: state.say('rules.empty') };
  if (clean.length > MAX_RULE_LEN) return { error: state.say('rules.tooLong', { max: MAX_RULE_LEN, n: clean.length }) };
  return clean;
}

/** Круг, в который можно писать: ролевой правится в карточке роли. */
function writableScope(state: OfficeState, scopeId: string): RuleScopeView | { error: string } {
  const scope = scopeById(state, scopeId);
  if (!scope) return { error: state.say('rules.noScope', { id: scopeId, known: ruleScopes(state).map((s) => s.id).join(', ') }) };
  if (!scope.editable) return { error: state.say('rules.readOnly', { id: scopeId }) };
  return scope;
}

function announce(state: OfficeState, key: 'rules.log.added' | 'rules.log.edited' | 'rules.log.dropped', scope: RuleScopeView, text: string): void {
  // Громко — это про ленту и панель: офис не меняет поведение исполнителей
  // молча, но и не требует клика там, где владелец сам попросил.
  state.addLog(null, 'system', state.say(key, { scope: scope.label, text }));
  state.emit({ t: 'rules', scopes: ruleScopes(state) });
}

export function addRule(state: OfficeState, scopeId: string, text: string): RuleResult {
  const scope = writableScope(state, scopeId);
  if ('error' in scope) return { ok: false, error: scope.error };
  const clean = cleanText(state, text);
  if (typeof clean !== 'string') return { ok: false, error: clean.error };

  const doc = readRulesFile(scope.path);
  if (doc.rules.length >= MAX_RULES) return { ok: false, error: state.say('rules.tooMany', { max: MAX_RULES }) };
  if (doc.rules.some((r) => r === clean)) return { ok: false, error: state.say('rules.duplicate') };

  doc.rules.push(clean);
  const problem = writeRulesFile(state, scope.path, doc);
  if (problem) return { ok: false, error: problem };
  announce(state, 'rules.log.added', scope, clean);
  return { ok: true, rule: { id: `${scope.id}#${doc.rules.length}`, scopeId: scope.id, text: clean } };
}

/** Разобрать id правила: круг и номер пункта в файле, с единицы. */
function locate(state: OfficeState, ruleId: string): { scope: RuleScopeView; index: number } | { error: string } {
  const at = String(ruleId ?? '').lastIndexOf('#');
  const scopeId = at > 0 ? ruleId.slice(0, at) : '';
  const index = at > 0 ? Number(ruleId.slice(at + 1)) : NaN;
  if (!scopeId || !Number.isInteger(index) || index < 1) return { error: state.say('rules.badId', { id: ruleId }) };
  const scope = writableScope(state, scopeId);
  if ('error' in scope) return { error: scope.error };
  if (index > scope.rules.length) return { error: state.say('rules.noRule', { id: ruleId }) };
  return { scope, index };
}

export function editRule(state: OfficeState, ruleId: string, text: string): RuleResult {
  const found = locate(state, ruleId);
  if ('error' in found) return { ok: false, error: found.error };
  const clean = cleanText(state, text);
  if (typeof clean !== 'string') return { ok: false, error: clean.error };

  const doc = readRulesFile(found.scope.path);
  if (found.index > doc.rules.length) return { ok: false, error: state.say('rules.noRule', { id: ruleId }) };
  doc.rules[found.index - 1] = clean;
  const problem = writeRulesFile(state, found.scope.path, doc);
  if (problem) return { ok: false, error: problem };
  announce(state, 'rules.log.edited', found.scope, clean);
  return { ok: true, rule: { id: ruleId, scopeId: found.scope.id, text: clean } };
}

export function dropRule(state: OfficeState, ruleId: string): RuleResult {
  const found = locate(state, ruleId);
  if ('error' in found) return { ok: false, error: found.error };

  const doc = readRulesFile(found.scope.path);
  if (found.index > doc.rules.length) return { ok: false, error: state.say('rules.noRule', { id: ruleId }) };
  const [gone] = doc.rules.splice(found.index - 1, 1);
  const problem = writeRulesFile(state, found.scope.path, doc);
  if (problem) return { ok: false, error: problem };
  announce(state, 'rules.log.dropped', found.scope, gone);
  return { ok: true, rule: { id: ruleId, scopeId: found.scope.id, text: gone } };
}

/**
 * Правила списком для менеджера: с id, по кругам. Он правит их инструментами,
 * а значит, должен видеть ровно то, на что сошлётся в `edit_rule`.
 */
export function rulesText(state: OfficeState): string {
  const scopes = ruleScopes(state);
  const lines = scopes.map((scope) => {
    const who = scope.roles.map((r) => r.id).join(', ');
    const head = state.say('rules.scopeRow', {
      id: scope.id,
      label: scope.label,
      who: who || state.say('rules.nobody'),
      mode: state.say(scope.editable ? 'rules.editable' : 'rules.roleOwned'),
    });
    const body = scope.rules.length
      ? scope.rules.map((r) => `  ${r.id}: ${r.text}`).join('\n')
      : `  ${state.say('rules.none')}`;
    return `${head}\n${body}`;
  });
  return `${state.say('rules.header')}\n${lines.join('\n')}`;
}

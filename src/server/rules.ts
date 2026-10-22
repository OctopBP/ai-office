/**
 * Правила офиса (docs/design/rules/spec.md): как работать, в отличие от
 * направлений, которые говорят, что делать.
 *
 * Правило живёт файлом `RULES.md`, а не записью в состоянии, и круг правила
 * задаётся тем, где этот файл лежит: в корне офиса — правило для всех, в корне
 * подпроекта (папки или отдельного репозитория) — для задач этой зоны. Так
 * правило про анимации уезжает вместе с кодом веба, видно в diff, правится
 * руками мимо офиса и достаётся каждому, кто берёт задачу веба, а не
 * вписывается в бриф каждого фронтендера.
 *
 * Третий круг — роль: её правила по-прежнему лежат в приписке к брифу
 * (`selfchange.ts`), и здесь они только показываются. Двух редакторов одного
 * текста быть не должно.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Lang } from '../shared/i18n';
import type { RuleScopeView, RuleView, Subproject } from '../shared/types';
import type { Role } from './roles';
import type { OfficeState } from './state';
import { soleZone, zonePath } from './subprojects';

/** Имя файла правил. Одно и то же в корне офиса и в корне зоны. */
export const RULES_FILE = 'RULES.md';

/**
 * Заголовок, под которым правила роли лежат в брифе (см. selfchange.ts). Бриф
 * написан на языке общения офиса, и заголовок пишется на нём же; читаем оба —
 * иначе правила, дописанные до смены языка, пропали бы из вида.
 */
export const ROLE_RULES_HEADERS: Readonly<Record<Lang, string>> = {
  ru: '## Правила офиса',
  en: '## Office rules',
};

/**
 * Где в брифе начинаются правила роли: позиция заголовка и его длина, или null,
 * если раздела нет. Заголовок любого из языков, причём только целой строкой,
 * а не упоминанием внутри фразы; при нескольких — первый.
 */
export function findRoleRules(brief: string): { at: number; header: string } | null {
  let found: { at: number; header: string } | null = null;
  for (const header of Object.values(ROLE_RULES_HEADERS)) {
    const at = new RegExp(`(^|\n)${header}[ \t]*(?=\n|$)`).exec(brief);
    if (!at) continue;
    const pos = at.index + at[1].length;
    if (!found || pos < found.at) found = { at: pos, header };
  }
  return found;
}

/** Текст правил роли в брифе — всё после заголовка; раздела нет — пусто. */
export function roleRulesText(brief: string): string {
  const found = findRoleRules(brief);
  return found ? brief.slice(found.at + found.header.length) : '';
}

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
  // Шапка — часть файла в репозитории проекта: язык реализации, не общения.
  const head = doc.head.trim() || state.projectSay('rules.fileHead');
  try {
    writeFileSync(filePath(dir), serializeRules({ ...doc, head }), 'utf8');
    return null;
  } catch (err) {
    return state.say('rules.writeFailed', { file: filePath(dir), error: (err as Error).message });
  }
}

/** Правила роли — из приписки к брифу пакета или из раздела в её брифе. */
function roleRules(role: Role): string[] {
  const text = role.package
    ? role.package.briefExtra
    : roleRulesText(role.brief);
  return text.split('\n').map((l) => l.replace(BULLET, '').trim()).filter(Boolean);
}

const ruleViews = (scopeId: string, texts: string[]): RuleView[] =>
  texts.map((text, i) => ({ id: `${scopeId}#${i + 1}`, scopeId, text }));

/** Префикс круга зоны и его старое имя, оставшееся синонимом (spec подпроектов §4.3). */
const SUB = 'sub:';
const LEGACY_REPO = 'repo:';

/**
 * Зоны, у которых свой круг: корень офиса кругом-зоной не бывает — он и есть
 * `office`, и repo-зона на самом репозитории офиса второго файла не заводит.
 */
function ruleZones(state: OfficeState): Array<{ sub: Subproject; path: string }> {
  return state.subprojects()
    .map((sub) => ({ sub, path: zonePath(sub, state.projectDir) }))
    .filter(({ path }) => path !== state.projectDir);
}

/** Подпись зоны человеку и в промпт: «Веб (`web/`)». */
function zoneLabel(state: OfficeState, sub: Subproject): string {
  const root = sub.kind === 'repo' ? basename(zonePath(sub, state.projectDir)) : `${sub.root}/`;
  return `${sub.name || sub.id} (\`${root}\`)`;
}

/**
 * Круги правил этого офиса: офис, подпроекты и роли. Считается на каждый
 * запрос, а не хранится: источник правды — файлы и брифы, и список,
 * разошедшийся с ними, врал бы обеим сторонам. Круги подпроектов строятся из
 * `state.subprojects`, а не из репозиториев ролей.
 */
export function ruleScopes(state: OfficeState): RuleScopeView[] {
  const roles = state.roles().filter((r) => !r.archived);
  const brief = (list: Role[]) => list.map((r) => ({ id: r.id, title: r.title }));

  const office: RuleScopeView = {
    id: 'office',
    kind: 'office',
    label: state.say('rules.scope.office'),
    path: state.projectDir,
    roles: brief(roles.filter((r) => !r.isManager)),
    editable: true,
    rules: ruleViews('office', readRulesFile(state.projectDir).rules),
  };

  const zones = ruleZones(state).map(({ sub, path }): RuleScopeView => {
    const id = `${SUB}${sub.id}`;
    return {
      id,
      kind: 'subproject',
      subprojectId: sub.id,
      label: zoneLabel(state, sub),
      path,
      roles: brief(roles.filter((r) => !r.isManager && (r.subprojects ?? []).includes(sub.id))),
      editable: true,
      rules: ruleViews(id, readRulesFile(path).rules),
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

  return [office, ...zones, ...roleScopes];
}

/**
 * Круг по id. `repo:<slug>` — синоним `sub:<slug>` навсегда: миграция заводит
 * repo-зону с тем же слагом, и старые ссылки менеджера и ленты не ломаются.
 */
const scopeById = (state: OfficeState, id: string): RuleScopeView | undefined => {
  const wanted = String(id ?? '').startsWith(LEGACY_REPO) ? SUB + id.slice(LEGACY_REPO.length) : id;
  return ruleScopes(state).find((s) => s.id === wanted);
};

/** Правила одного круга строками — для промпта и для проверок. */
export const rulesOf = (state: OfficeState, scopeId: string): string[] =>
  scopeById(state, scopeId)?.rules.map((r) => r.text) ?? [];

function block(header: string, rules: string[]): string {
  return rules.length ? `\n\n${header}\n${rules.map((r) => `- ${r}`).join('\n')}` : '';
}

/**
 * Зона сессии — одна на бриф зоны, её правила и оглавление документов, чтобы
 * блоки промпта не расходились. `subprojectId` — зона задачи: строка — эта
 * зона, null — задача «весь проект», без зоны; undefined — сессия без задачи
 * (разговор, совещание, консультация), и тогда это единственная зона роли,
 * а у роли с несколькими зонами или без них — без зоны. Менеджер — без зоны.
 */
export function sessionZone(state: OfficeState, roleId: string | null, subprojectId: string | null | undefined): string | null {
  if (!roleId) return null;
  if (subprojectId !== undefined) return subprojectId || null;
  const role = state.role(roleId);
  return role ? soleZone(role, state.subprojects())?.id ?? null : null;
}

/**
 * Правила в системный промпт. Клеится туда же, куда бриф проекта, и в ту же
 * статическую часть: правила меняются редко, и платить за них в каждой
 * короткой сессии незачем.
 *
 * Исполнитель на задаче получает правила офиса и зоны ЗАДАЧИ, а не своих
 * закреплений: универсал на задаче веба живёт по правилам веба. Без задачи —
 * офис и единственная зона роли (`sessionZone`). Менеджер — все круги: файлов он не видит,
 * а критерии готовности пишет он, и правило, до него не доехавшее, так и
 * останется пожеланием.
 */
export function rulesBrief(state: OfficeState, roleId: string | null, subprojectId?: string | null): string {
  const scopes = ruleScopes(state);
  const office = scopes.find((s) => s.id === 'office');
  let text = block(state.say('prompt.rules.office'), office?.rules.map((r) => r.text) ?? []);

  if (roleId) {
    const zone = sessionZone(state, roleId, subprojectId);
    const own = scopes.find((s) => s.kind === 'subproject' && s.subprojectId === zone);
    if (own) text += block(state.say('prompt.rules.subproject', { label: own.label }), own.rules.map((r) => r.text));
  } else {
    for (const scope of scopes) {
      if (scope.kind === 'subproject') {
        const who = scope.roles.map((r) => r.id).join(', ') || state.say('rules.nobody');
        text += block(state.say('prompt.rules.subproject', { label: `${scope.label} — ${who}` }), scope.rules.map((r) => r.text));
      }
      if (scope.kind === 'role') {
        text += block(state.say('prompt.rules.role', { role: scope.roles[0]?.id ?? scope.label }), scope.rules.map((r) => r.text));
      }
    }
  }

  if (text.length <= PROMPT_LIMIT) return text;
  return `${text.slice(0, PROMPT_LIMIT)}\n${state.say('prompt.rules.clipped')}`;
}

/** Файл брифа зоны — тот же, что у офиса, в корне подпроекта (spec подпроектов §4.1). */
const ZONE_BRIEF_FILE = 'OFFICE.md';

/**
 * Бриф зоны в системный промпт — сразу после брифа офиса, в статику. Получают
 * его сессии задач зоны и разговоры роли, закреплённой ровно за одной зоной
 * (с несколькими непонятно, чей бриф главный);
 * менеджер — нет (ему хватает `summary` в списке зон). Как и `RULES.md`, это
 * файл, а не поле: уезжает с кодом и правится руками мимо офиса.
 */
export function zoneBrief(state: OfficeState, roleId: string | null, subprojectId?: string | null): string {
  const own = sessionZone(state, roleId, subprojectId);
  if (!own) return '';
  const zone = ruleZones(state).find(({ sub }) => sub.id === own);
  if (!zone) return '';
  try {
    const text = readFileSync(resolve(zone.path, ZONE_BRIEF_FILE), 'utf8').trim();
    if (!text) return '';
    const body = text.length > PROMPT_LIMIT
      ? `${text.slice(0, PROMPT_LIMIT)}\n${state.say('prompt.zoneBrief.clipped')}`
      : text;
    return `\n\n${state.say('prompt.zoneBrief.header', { label: zoneLabel(state, zone.sub) })}\n${body}`;
  } catch {
    // брифа у зоны нет — хватает брифа офиса
    return '';
  }
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
  return { ok: true, rule: { id: `${found.scope.id}#${found.index}`, scopeId: found.scope.id, text: clean } };
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
  return { ok: true, rule: { id: `${found.scope.id}#${found.index}`, scopeId: found.scope.id, text: gone } };
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

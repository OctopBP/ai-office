/**
 * Пакеты агентов: то, из чего в офисе заводится роль.
 *
 * Пакет — папка в формате плагина Claude Code плюс манифест офиса:
 *
 *   packages/@office/backend/
 *     .claude-plugin/plugin.json   имя плагина, версия, описание — формат Claude Code
 *     agent.json                   манифест офиса: роль, модель, инструменты, скилы
 *     brief/ru.md, brief/en.md     системный промпт роли по языкам
 *     skills/<навык>/SKILL.md      навыки — формат Claude Code
 *
 * Здесь пакет читается с диска, проверяется и превращается в роль. Что из
 * пакета уезжает в сессию (скилы, плагины, просьбы о серверах) — в
 * `skills.ts`; как роль живёт в офисе и правится — в `state.ts`.
 *
 * Правила, которые здесь держатся:
 *
 * - Пакет объявляет умения, офис выдаёт инструменты. Серверы из пакета —
 *   просьба, а не подключение; хуки, команды и сабагенты плагина офис не
 *   берёт вовсе (см. `IGNORED_PLUGIN_PARTS`).
 * - Модель — алиасом (`opus`, `sonnet`, `haiku`), а не полным id: пакет
 *   должен пережить смену поколения моделей. Алиас разрешает офис.
 * - Бриф — файлами по языкам, а не строкой в JSON: он длинный и его правят
 *   руками. Нет своего языка — берётся английский.
 * - Диск читается на каждый запрос, а не один раз при старте: поправленный
 *   бриф должен доезжать до следующей задачи, а не до перезапуска сервера.
 *
 * Спека: docs/design/agent-market/spec.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLang, LANGS, type Lang } from '../shared/i18n';
import { MODEL_RE, resolveModel } from '../shared/models';
import {
  MAX_ROLE_INSTANCES, MAX_TASK_MAX_TURNS, MIN_ROLE_INSTANCES, MIN_TASK_MAX_TURNS,
  type McpServerDef, type PermissionMode,
} from '../shared/types';
import { checkMcpServers } from './mcp';
import { isPermissionMode } from './permissions';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Где лежат пакеты. Сейчас — папка в репозитории: там живут наши, `@office/*`.
 * С появлением установки из реестра сюда же подставится кеш на машине
 * (`~/.office/packages`), и структура внутри останется той же: `@область/имя`.
 * Переопределяется переменной окружения — так проверки гоняют пакеты на
 * времянке, не трогая репозиторий.
 */
export const PACKAGES_DIR = process.env.OFFICE_PACKAGES_DIR
  ? resolve(process.env.OFFICE_PACKAGES_DIR)
  : resolve(ROOT, 'packages');

/**
 * Кеш пакетов, поставленных из реестра или по ссылке: `<кеш>/@область/имя/версия/`.
 * Версии не перезаписываются — что проверялось, то и стоит; рядом с пакетом
 * лежит `.office-lock.json` с коммитом и отпечатком дерева. Общий на машину:
 * один пакет может стоять в десяти офисах.
 */
export const PACKAGE_CACHE = process.env.OFFICE_PACKAGE_CACHE
  ? resolve(process.env.OFFICE_PACKAGE_CACHE)
  : resolve(homedir(), '.office/packages');

/** Имя файла с записью об установке рядом с пакетом в кеше. */
export const LOCK_FILE = '.office-lock.json';

/** Область наших пакетов. Зарезервирована: чужой пакет так называться не может. */
export const OFFICIAL_SCOPE = '@office';

/** Версия схемы манифеста. Не версия пакета — та лежит в plugin.json. */
export const MANIFEST_SCHEMA = 1;

/**
 * Имя пакета: `@область/имя`, как в npm. Область обязательна — коллизии
 * «backend» против «backend» решать нечем; область же принадлежит издателю.
 */
export const PACKAGE_NAME_RE = /^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,38}$/;

/** Движки, для которых офис умеет собирать сессию. Пока один. */
export const ENGINES = ['claude-code'] as const;
export type Engine = (typeof ENGINES)[number];

/**
 * Части плагина Claude Code, которые офис намеренно не берёт. Пакет с
 * маркета — чужой код на вашей машине: хук — произвольная команда,
 * выполняемая молча; сабагент — ещё один системный промпт с инструментами
 * мимо ролей офиса; `.mcp.json` — сервер мимо каталога, где живут доверие и
 * разбор рисков. Валидатор предупреждает о них: автор должен знать, что его
 * хук не сработает, а не гадать.
 */
export const IGNORED_PLUGIN_PARTS = ['hooks', 'commands', 'agents', '.mcp.json'] as const;

/** Текст по языкам. Ключ — язык офиса; чего нет — берётся английский. */
export type Localized = Partial<Record<Lang, string>>;

/** Участник команды: пакет агента и сколько сотрудников в него нанять. */
export interface TeamMember {
  package: string;
  count: number;
  /** Нужная версия. Пусто — старшая из доступных. */
  version: string;
}

/**
 * Настройки офиса, которые пакет-команда вправе предложить. Список белый:
 * бюджеты, движок и каталог серверов — решения владельца, не пакета.
 */
export const TEAM_SETTING_KEYS = [
  'officePermissionMode', 'autoPipeline', 'focusEpics', 'planApproval', 'layoutId', 'maxConcurrentWorkers', 'taskMaxTurns',
] as const;
export type TeamSettings = Partial<Record<(typeof TEAM_SETTING_KEYS)[number], unknown>>;

/** Манифест пакета после разбора: все поля на месте, умолчания подставлены. */
export interface AgentManifest {
  schema: typeof MANIFEST_SCHEMA;
  name: string;
  /**
   * Агент — роль; команда — набор агентов и настройки офиса под задачу
   * («стартап на Next.js», «контент-отдел»). Команда собирается поверх
   * агентов: своих брифа и скилов у неё нет, только участники.
   */
  kind: 'agent' | 'team';
  /** Только у команды. */
  members: TeamMember[];
  /** Только у команды: что предложить выставить в офисе при найме. */
  settings: TeamSettings;
  title: Localized;
  summary: Localized;
  tags: string[];
  color: string;
  emoji: string;
  /** Внешность из `shared/looks.ts`. Пусто — подберёт офис по id роли. */
  look: string;
  /**
   * Пакет менеджера. Менеджер в офисе один, и командные инструменты
   * (create_task и прочие) выдаёт ему офис по этому флагу, а не пакет.
   */
  manager: boolean;
  maxInstances: number;
  /** Папка артефактов у ролей, работающих не кодом. Пусто — нет. */
  docsDir: string;
  license: string;
  runtime: {
    engine: Engine;
    /** Как написано в манифесте: алиас или полный id. Разрешается в `roleFromPackage`. */
    model: string;
    /** null — все встроенные инструменты. */
    tools: string[] | null;
    /** Предложение, не приказ: режим доступа наследуется агент → роль → офис. */
    permissionMode: PermissionMode | null;
    isolate: boolean;
    maxTurns: number | null;
    /** Серверы из каталога офиса, на которые роль подписана по умолчанию. */
    mcp: string[];
  };
  // Ровно то, что было в pack.json — см. skills.ts.
  skills: string[];
  builtin: string[];
  use: string[];
  servers: McpServerDef[];
  /** Чего пакет ждёт снаружи — витрина для экрана найма, не механизм. */
  requires: {
    office: string;
    env: string[];
    network: boolean;
  };
}

/** Что не так с пакетом. `warn` — пакет годен, но автору стоит знать. */
export interface PackageProblem {
  level: 'error' | 'warn';
  /** Где: имя файла или путь поля в манифесте. */
  path: string;
  message: string;
}

export interface AgentPackage {
  name: string;
  version: string;
  dir: string;
  manifest: AgentManifest;
  /** Брифы по языкам из `brief/<lang>.md`. Пусто — бриф у пакета отсутствует. */
  briefs: Localized;
}

// --------------------------------------------------------------- разбор

const asRecord = (v: unknown): Record<string, unknown> | null =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

const strList = (v: unknown): string[] | null =>
  (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.map((s) => s.trim()).filter(Boolean) : null);

/** Текст по языкам: строка считается английским. Чужие языки отбрасываются. */
function localized(v: unknown, path: string, problems: PackageProblem[]): Localized {
  if (typeof v === 'string') return v.trim() ? { en: v.trim() } : {};
  const rec = asRecord(v);
  if (!rec) {
    if (v !== undefined) problems.push({ level: 'error', path, message: 'expected a string or an object keyed by language' });
    return {};
  }
  const out: Localized = {};
  for (const [lang, text] of Object.entries(rec)) {
    if (!isLang(lang)) {
      problems.push({ level: 'warn', path: `${path}.${lang}`, message: `unknown language, the office speaks: ${LANGS.join(', ')}` });
      continue;
    }
    if (typeof text !== 'string') problems.push({ level: 'error', path: `${path}.${lang}`, message: 'expected a string' });
    else if (text.trim()) out[lang] = text.trim();
  }
  return out;
}

/**
 * Разобрать манифест. Возвращает и манифест, и замечания: с ошибками пакет
 * не грузится, с предупреждениями — грузится, но автору о них говорят.
 * `fallbackName` — имя по папке, если в манифесте его нет: так пакет хотя бы
 * находится в отчёте валидатора.
 */
export function parseManifest(raw: unknown, fallbackName: string): { manifest: AgentManifest; problems: PackageProblem[] } {
  const problems: PackageProblem[] = [];
  const err = (path: string, message: string) => problems.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => problems.push({ level: 'warn', path, message });
  const m = asRecord(raw) ?? {};
  if (!asRecord(raw)) err('agent.json', 'expected a JSON object');

  if (m.schema !== MANIFEST_SCHEMA) err('schema', `expected ${MANIFEST_SCHEMA}`);

  let name = typeof m.name === 'string' ? m.name.trim() : '';
  if (!name) { err('name', 'required, e.g. "@office/backend"'); name = fallbackName; }
  else if (!PACKAGE_NAME_RE.test(name)) err('name', '"@scope/name": lowercase letters, digits and dashes, scope required');

  const kind: 'agent' | 'team' = m.kind === 'team' ? 'team' : 'agent';
  if (m.kind !== undefined && m.kind !== 'agent' && m.kind !== 'team') err('kind', '"agent" or "team"');
  const members: TeamMember[] = [];
  const settings: TeamSettings = {};
  if (kind === 'team') {
    const list = Array.isArray(m.members) ? m.members : (err('members', 'a team needs a list of members'), []);
    for (const [i, item] of list.entries()) {
      const rec = asRecord(item);
      const pkgName = typeof rec?.package === 'string' ? rec.package.trim() : '';
      if (!rec || !PACKAGE_NAME_RE.test(pkgName)) { err(`members[${i}]`, 'expected { "package": "@scope/name" }'); continue; }
      const n = rec.count === undefined ? 1 : (typeof rec.count === 'number' ? Math.floor(rec.count) : NaN);
      if (!Number.isFinite(n) || n < MIN_ROLE_INSTANCES || n > MAX_ROLE_INSTANCES) { err(`members[${i}].count`, `an integer from ${MIN_ROLE_INSTANCES} to ${MAX_ROLE_INSTANCES}`); continue; }
      if (members.some((x) => x.package === pkgName)) { err(`members[${i}]`, `${pkgName} listed twice`); continue; }
      members.push({ package: pkgName, count: n, version: typeof rec.version === 'string' ? rec.version.trim() : '' });
    }
    if (!members.length) err('members', 'a team needs at least one member');
    const raw = asRecord(m.settings);
    if (m.settings !== undefined && !raw) err('settings', 'expected an object');
    for (const [key, value] of Object.entries(raw ?? {})) {
      if ((TEAM_SETTING_KEYS as readonly string[]).includes(key)) (settings as Record<string, unknown>)[key] = value;
      else warn(`settings.${key}`, 'not a setting a team may propose; ignored');
    }
    for (const key of ['runtime', 'skills', 'builtin', 'use', 'servers', 'docsDir', 'manager']) {
      if (m[key] !== undefined) warn(key, 'a team has no role of its own; ignored');
    }
  } else if (m.members !== undefined || m.settings !== undefined) {
    warn('members', 'only a team has members and settings; ignored');
  }

  const title = localized(m.title, 'title', problems);
  if (!Object.keys(title).length) err('title', 'required in at least one language');
  const summary = localized(m.summary, 'summary', problems);

  const tags = strList(m.tags) ?? (m.tags === undefined ? [] : (err('tags', 'expected a list of strings'), []));
  const color = typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color.trim()) ? m.color.trim() : '#94a3b8';
  if (m.color !== undefined && color === '#94a3b8' && m.color !== '#94a3b8') err('color', 'expected "#rrggbb"');
  const emoji = typeof m.emoji === 'string' && m.emoji.trim() ? m.emoji.trim() : '🙂';
  const look = typeof m.look === 'string' ? m.look.trim() : '';
  const manager = m.manager === true;
  const license = typeof m.license === 'string' ? m.license.trim() : '';

  let maxInstances = 1;
  if (m.maxInstances !== undefined) {
    const n = typeof m.maxInstances === 'number' ? Math.floor(m.maxInstances) : NaN;
    if (!Number.isFinite(n) || n < MIN_ROLE_INSTANCES || n > MAX_ROLE_INSTANCES) {
      err('maxInstances', `an integer from ${MIN_ROLE_INSTANCES} to ${MAX_ROLE_INSTANCES}`);
    } else maxInstances = n;
  }
  const docsDir = typeof m.docsDir === 'string' ? m.docsDir.trim().replace(/^\/+|\/+$/g, '') : '';
  if (docsDir.startsWith('..') || docsDir.includes('/../')) err('docsDir', 'must stay inside the working copy');

  // --- runtime
  const rt = asRecord(m.runtime) ?? {};
  if (m.runtime !== undefined && !asRecord(m.runtime)) err('runtime', 'expected an object');
  const engine = rt.engine === undefined ? 'claude-code' : rt.engine;
  if (!ENGINES.includes(engine as Engine)) err('runtime.engine', `unknown engine, the office runs: ${ENGINES.join(', ')}`);
  const model = typeof rt.model === 'string' && rt.model.trim() ? rt.model.trim() : 'sonnet';
  if (!MODEL_RE.test(model)) err('runtime.model', 'an alias (opus, sonnet, haiku) or a full model id');
  let tools: string[] | null = null;
  if (rt.tools !== undefined) {
    tools = strList(rt.tools);
    if (!tools) { err('runtime.tools', 'expected a list of tool names'); tools = null; }
  }
  let permissionMode: PermissionMode | null = null;
  if (rt.permissionMode !== undefined && rt.permissionMode !== null) {
    if (isPermissionMode(rt.permissionMode)) permissionMode = rt.permissionMode;
    else err('runtime.permissionMode', 'auto, ask-risky, ask-writes, readonly or null');
  }
  const isolate = rt.isolate === undefined ? true : rt.isolate === true;
  if (rt.isolate !== undefined && typeof rt.isolate !== 'boolean') err('runtime.isolate', 'expected true or false');
  let maxTurns: number | null = null;
  if (rt.maxTurns !== undefined && rt.maxTurns !== null) {
    const n = typeof rt.maxTurns === 'number' ? Math.floor(rt.maxTurns) : NaN;
    if (!Number.isFinite(n) || n < MIN_TASK_MAX_TURNS || n > MAX_TASK_MAX_TURNS) {
      err('runtime.maxTurns', `an integer from ${MIN_TASK_MAX_TURNS} to ${MAX_TASK_MAX_TURNS} or null`);
    } else maxTurns = n;
  }
  const mcp = strList(rt.mcp) ?? (rt.mcp === undefined ? [] : (err('runtime.mcp', 'expected a list of server ids'), []));

  // --- то, что было в pack.json
  const skills = strList(m.skills) ?? (m.skills === undefined ? [] : (err('skills', 'expected a list of skill names'), []));
  const builtin = strList(m.builtin) ?? (m.builtin === undefined ? [] : (err('builtin', 'expected a list of skill names'), []));
  const use = strList(m.use) ?? (m.use === undefined ? [] : (err('use', 'expected a list of plugin paths'), []));
  // Серверы проходят ту же проверку, что и каталог из формы. Сервер с
  // замечанием отбрасывается целиком: показать человеку «почти как объявлено»
  // (например, с молча вычищенным токеном) значит показать не то, что
  // написал автор.
  const checked = checkMcpServers(m.servers ?? []);
  for (const p of checked.problems) err(`servers.${p.id || '?'}`, `${p.key}${p.detail ? `: ${p.detail}` : ''}`);
  const broken = new Set(checked.problems.map((p) => p.id));
  const servers = checked.servers.filter((srv) => !broken.has(srv.id));

  // --- requires
  const rq = asRecord(m.requires) ?? {};
  if (m.requires !== undefined && !asRecord(m.requires)) err('requires', 'expected an object');
  const requires = {
    office: typeof rq.office === 'string' ? rq.office.trim() : '',
    env: strList(rq.env) ?? (rq.env === undefined ? [] : (err('requires.env', 'expected a list of variable names'), [])),
    network: rq.network === true,
  };
  for (const key of Object.keys(m)) {
    if (!KNOWN_KEYS.has(key)) warn(key, 'unknown field, the office ignores it');
  }

  return {
    manifest: {
      schema: MANIFEST_SCHEMA, name, kind, members, settings, title, summary, tags, color, emoji, look,
      manager, maxInstances, docsDir, license,
      runtime: { engine: engine as Engine, model, tools, permissionMode, isolate, maxTurns, mcp },
      skills, builtin, use, servers, requires,
    },
    problems,
  };
}

const KNOWN_KEYS = new Set([
  'schema', 'name', 'kind', 'title', 'summary', 'tags', 'color', 'emoji', 'look', 'manager',
  'maxInstances', 'docsDir', 'license', 'runtime', 'skills', 'builtin', 'use', 'servers', 'requires',
  'members', 'settings',
]);

// ----------------------------------------------------------------- чтение

function readJson(file: string): { value: unknown; error: string | null } {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')), error: null };
  } catch (e) {
    return { value: undefined, error: (e as Error).message };
  }
}

/** Брифы из `brief/<lang>.md`. Хвостовые переводы строк снимаем: бриф клеится к промпту. */
function readBriefs(dir: string): Localized {
  const out: Localized = {};
  const briefDir = resolve(dir, 'brief');
  if (!existsSync(briefDir)) return out;
  for (const lang of LANGS) {
    const file = resolve(briefDir, `${lang}.md`);
    if (existsSync(file)) out[lang] = readFileSync(file, 'utf8').trimEnd();
  }
  return out;
}

/**
 * Прочитать пакет из папки и найти всё, что с ним не так. Одна функция и на
 * загрузку, и на валидатор: пакет, который прошёл проверку, обязан
 * грузиться, а который не грузится — обязан объяснить почему.
 *
 * `pkg` есть, только если ошибок нет: половину пакета в роль не превратить.
 */
export function readPackage(dir: string): { pkg: AgentPackage | null; problems: PackageProblem[] } {
  const problems: PackageProblem[] = [];
  const fallbackName = dir.split('/').slice(-2).join('/');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { pkg: null, problems: [{ level: 'error', path: dir, message: 'no such directory' }] };
  }

  const manifestFile = resolve(dir, 'agent.json');
  if (!existsSync(manifestFile)) {
    return { pkg: null, problems: [{ level: 'error', path: 'agent.json', message: 'missing' }] };
  }
  const rawManifest = readJson(manifestFile);
  if (rawManifest.error) {
    return { pkg: null, problems: [{ level: 'error', path: 'agent.json', message: `not valid JSON: ${rawManifest.error}` }] };
  }
  const parsed = parseManifest(rawManifest.value, fallbackName);
  problems.push(...parsed.problems);

  // Версия — в plugin.json, где её ждёт Claude Code. Два поля версии в
  // одном пакете разъехались бы при первом же обновлении.
  let version = '';
  const pluginFile = resolve(dir, '.claude-plugin/plugin.json');
  if (!existsSync(pluginFile)) {
    problems.push({ level: 'error', path: '.claude-plugin/plugin.json', message: 'missing: a package is a Claude Code plugin, the manifest is required' });
  } else {
    const plugin = readJson(pluginFile);
    const rec = asRecord(plugin.value);
    if (plugin.error || !rec) {
      problems.push({ level: 'error', path: '.claude-plugin/plugin.json', message: `not valid JSON: ${plugin.error ?? 'expected an object'}` });
    } else {
      version = typeof rec.version === 'string' ? rec.version.trim() : '';
      if (!/^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/i.test(version)) {
        problems.push({ level: 'error', path: '.claude-plugin/plugin.json:version', message: 'semver required, e.g. "0.1.0"' });
      }
      if (typeof rec.name !== 'string' || !rec.name.trim()) {
        problems.push({ level: 'error', path: '.claude-plugin/plugin.json:name', message: 'plugin name required: skills are addressed as <plugin>:<skill>' });
      }
    }
  }

  const briefs = readBriefs(dir);
  if (!Object.keys(briefs).length && !parsed.manifest.manager && parsed.manifest.kind === 'agent') {
    problems.push({ level: 'warn', path: 'brief/', message: 'no brief in any language: the role will run on the office prompt alone' });
  }
  for (const part of IGNORED_PLUGIN_PARTS) {
    if (existsSync(resolve(dir, part))) {
      problems.push({ level: 'warn', path: part, message: 'the office does not load this part of a plugin' });
    }
  }
  const skillsDir = resolve(dir, 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = resolve(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(file)) {
        problems.push({ level: 'warn', path: `skills/${entry.name}`, message: 'no SKILL.md, the skill is invisible' });
        continue;
      }
      const head = readFileSync(file, 'utf8').slice(0, 2000);
      if (!/^---\s*\n[\s\S]*?^name:\s*\S+[\s\S]*?^description:\s*\S/m.test(head)) {
        problems.push({ level: 'warn', path: `skills/${entry.name}/SKILL.md`, message: 'front matter needs name and description: the model picks skills by description' });
      }
    }
  }
  if (!parsed.manifest.license) {
    problems.push({ level: 'warn', path: 'license', message: 'no license: the registry does not list packages without one' });
  }

  if (problems.some((p) => p.level === 'error')) return { pkg: null, problems };
  return {
    pkg: { name: parsed.manifest.name, version, dir, manifest: parsed.manifest, briefs },
    problems,
  };
}

/** Папка пакета по имени: `@office/backend` → `<PACKAGES_DIR>/@office/backend`. */
export const packageDir = (name: string, root = PACKAGES_DIR): string =>
  resolve(root, ...name.split('/'));

/**
 * Пакет по имени — или null, если его нет или он битый. Битый пакет
 * неотличим от отсутствующего намеренно: роль обязана подняться из
 * сохранения и без него, а причина видна валидатору (`readPackage`).
 */
export function loadPackage(name: string, root = PACKAGES_DIR): AgentPackage | null {
  if (!PACKAGE_NAME_RE.test(name)) return null;
  const { pkg } = readPackage(packageDir(name, root));
  // Пакет обязан называться так, как папка, в которой лежит: иначе ссылка
  // из сохранения указывала бы на одно, а внутри лежало бы другое.
  return pkg && pkg.name === name ? pkg : null;
}

/** Все пакеты в каталоге, по имени. Битые пропускаются. */
export function listPackages(root = PACKAGES_DIR): AgentPackage[] {
  if (!existsSync(root)) return [];
  const out: AgentPackage[] = [];
  for (const scope of readdirSync(root, { withFileTypes: true })) {
    if (!scope.isDirectory() || !scope.name.startsWith('@')) continue;
    for (const entry of readdirSync(resolve(root, scope.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = loadPackage(`${scope.name}/${entry.name}`, root);
      if (pkg) out.push(pkg);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Проверить пакет в папке. Для валидатора и тестов: возвращает все замечания. */
export const validatePackage = (dir: string): PackageProblem[] => readPackage(dir).problems;

// ------------------------------------------------------------ слова пакета

/** Текст на языке офиса; нет своего — английский; нет и его — какой есть. */
export function pick(text: Localized, lang: Lang): string {
  return text[lang] ?? text.en ?? Object.values(text).find((v) => typeof v === 'string') ?? '';
}

/** Бриф пакета на языке офиса. */
export const packageBrief = (pkg: AgentPackage, lang: Lang): string => pick(pkg.briefs, lang);

/** Название роли из пакета на языке офиса; нет ни одного — имя пакета. */
export const packageTitle = (pkg: AgentPackage, lang: Lang): string =>
  pick(pkg.manifest.title, lang) || pkg.name.split('/').pop() || pkg.name;

/** Модель роли из пакета: алиас разрешён в актуальный id. */
export const packageModel = (pkg: AgentPackage): string => resolveModel(pkg.manifest.runtime.model);

/**
 * Каталог по умолчанию: с него начинается новый офис. Порядок — порядок
 * показа в UI и рассадки по столам, поэтому он записан явно, а не берётся
 * по алфавиту. Файла нет — все наши пакеты по алфавиту, менеджер первым.
 */
export function defaultTeam(root = PACKAGES_DIR): string[] {
  const file = resolve(root, 'default-office.json');
  if (existsSync(file)) {
    const { value } = readJson(file);
    const roles = strList(asRecord(value)?.roles);
    if (roles?.length) return roles;
  }
  const all = listPackages(root).filter((p) => p.name.startsWith(`${OFFICIAL_SCOPE}/`));
  return [
    ...all.filter((p) => p.manifest.manager).map((p) => p.name),
    ...all.filter((p) => !p.manifest.manager).map((p) => p.name),
  ];
}

// ------------------------------------------------------------------ кеш

/** Запись об установке: откуда пакет взят и что именно лежит в папке. */
export interface PackageLock {
  name: string;
  version: string;
  repo: string;
  path: string;
  commit: string;
  installedAt: number;
  /** Отпечаток дерева пакета (`packageIntegrity`) на момент установки. */
  integrity: string;
}

/** Папка версии пакета в кеше. */
export const cacheDir = (name: string, version: string, root = PACKAGE_CACHE): string =>
  resolve(root, ...name.split('/'), version);

/** Запись об установке из папки кеша. null — папка не из кеша или запись битая. */
export function readLock(dir: string): PackageLock | null {
  const file = resolve(dir, LOCK_FILE);
  if (!existsSync(file)) return null;
  const { value } = readJson(file);
  const rec = asRecord(value);
  if (!rec) return null;
  const str = (k: string): string => (typeof rec[k] === 'string' ? rec[k] as string : '');
  if (!str('name') || !str('version') || !str('commit')) return null;
  return {
    name: str('name'), version: str('version'), repo: str('repo'), path: str('path'),
    commit: str('commit'), integrity: str('integrity'),
    installedAt: typeof rec.installedAt === 'number' ? rec.installedAt : 0,
  };
}

/**
 * Отпечаток дерева пакета: sha256 по отсортированным путям и содержимому.
 * Запись об установке и `.git` не считаются — первая меняется после
 * установки, второго в пакете быть не должно. Один и тот же пакет из
 * зеркала и из репозитория автора обязан дать один отпечаток (спека §12.3).
 */
export function packageIntegrity(dir: string): string {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === LOCK_FILE) continue;
      const full = resolve(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(relative(dir, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
}

/**
 * Пакет роли по её ссылке. С источником — из кеша, по имени и версии; без
 * источника — встроенный из `packages/`. null — на диске нет: роль тогда
 * поднимается из сохранения, а ссылка ждёт, пока пакет вернётся.
 */
export function resolvePackage(
  link: { name: string; version: string; source?: { repo: string } | null },
  cache = PACKAGE_CACHE,
): AgentPackage | null {
  if (!link.source) return loadPackage(link.name);
  if (!PACKAGE_NAME_RE.test(link.name) || !link.version) return null;
  const { pkg } = readPackage(cacheDir(link.name, link.version, cache));
  return pkg && pkg.name === link.name ? pkg : null;
}

/** Всё, что стоит в кеше: пакет и запись об установке, по имени и версии. */
export function listCached(cache = PACKAGE_CACHE): Array<{ pkg: AgentPackage; lock: PackageLock }> {
  if (!existsSync(cache)) return [];
  const out: Array<{ pkg: AgentPackage; lock: PackageLock }> = [];
  for (const scope of readdirSync(cache, { withFileTypes: true })) {
    if (!scope.isDirectory() || !scope.name.startsWith('@')) continue;
    for (const entry of readdirSync(resolve(cache, scope.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = `${scope.name}/${entry.name}`;
      for (const ver of readdirSync(resolve(cache, scope.name, entry.name), { withFileTypes: true })) {
        if (!ver.isDirectory()) continue;
        const dir = resolve(cache, scope.name, entry.name, ver.name);
        const lock = readLock(dir);
        const { pkg } = readPackage(dir);
        if (lock && pkg && pkg.name === name && pkg.version === ver.name) out.push({ pkg, lock });
      }
    }
  }
  return out.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name) || compareVersions(a.pkg.version, b.pkg.version));
}

/** Сравнение semver без сборки: 1.10.0 старше 1.9.0. Возвращает знак a − b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  // Предрелиз младше релиза той же тройки.
  const ra = a.includes('-') ? 1 : 0;
  const rb = b.includes('-') ? 1 : 0;
  return rb - ra;
}

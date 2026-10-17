/**
 * Свои агенты офиса (docs/design/custom-agent/spec.md, D-5 §4.1).
 *
 * Свой агент — пакет того же формата, что `packages/@office/*`: `agent.json`,
 * `.claude-plugin/plugin.json`, `brief/<язык>.md`, `skills/<имя>/SKILL.md`.
 * Область — `@local`. Живёт в данных офиса, рядом с его состоянием (решение
 * владельца Q-206): `.office/offices/o-2.json` → `.office/offices/o-2.agents/@local/<id>/`
 * (`OfficeState.agentsDir()`). В другой офис агент попадает только через
 * публикацию в маркет: пакет в папке — обычный, его берут export.ts и publish.ts.
 *
 * Сбоку от манифеста лежит `.office-local.json` — то, что нужно офису, но не
 * пакету: зона для найма. Валидатор его не читает, в реестр он не уходит.
 *
 * HTTP, у всех — `?office=<id>` (без него — открытый последним):
 *   GET    /api/my-agents                  — список;
 *   POST   /api/my-agents                  — создать и нанять, `{ draft, hire? }`;
 *   POST   /api/my-agents/from-role        — создать на основе роли, `{ roleId, patch?, hire? }`;
 *   GET    /api/my-agents/draft?roleId=    — черновик из роли для формы;
 *   PUT    /api/my-agents/<id>             — править, `{ patch }`; правка доезжает до копий офиса;
 *   POST   /api/my-agents/<id>/hire        — нанять ещё раз (карточка «Нанять»);
 *   DELETE /api/my-agents/<id>             — удалить; нанятого — 409.
 * `<id>` — имя без области: `boardgame-designer` для `@local/boardgame-designer`.
 * `hire` по умолчанию true («Сохранить и нанять»); false — только сохранить.
 * В ответе создания и найма — `hired: { roleId, problem }`, правки — `roleIds`.
 *
 * Найм идёт через `hireFromPackage`, правка копий — через `updateRolePackage`
 * (раздел «офис» ниже). Набор инструментов сессии берётся из `runtime.tools`
 * пакета: `roleFromPackage` → `Role.tools` → `sessionTools` (skills.ts).
 * Веб получает состав офиса по сокету: найм и правка шлют `roles` сами.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { Lang } from '../shared/i18n';
import { isLookId } from '../shared/looks';
import { MODEL_RE } from '../shared/models';
import type { MyAgentDraft, MyAgentSkill, MyAgentView } from '../shared/myagent';
import { engineOf, isProviderId, unknownEngineTools, type ProviderId } from '../shared/providers';
import { ROLE_TITLE_LIMIT, type FieldError } from '../shared/types';
import { isCapability } from '../shared/workflow';
import { scaffoldFromRole, scaffoldPackage, type Scaffold } from './export';
import { c, t } from './i18n';
import { mcpCatalog } from './mcp';
import { readBody } from './officeicon';
import { currentOffice, officeById } from './offices';
import { loadPackage, packageDir, pick, readPackage, type AgentPackage } from './packages';
import { isPermissionMode } from './permissions';
import { slugifyRoleId, type LinkOverrides, type Role } from './roles';
import { LOCAL_SCOPE } from './scopes';
import { getOffice, isOpened, type OfficeState } from './state';

/** Пороги формы — те же, что в спеке §5. */
export const SUMMARY_LIMIT = 140;
export const BRIEF_MIN = 40;
export const BRIEF_SOFT = 8000;
export const BRIEF_MAX = 30000;

/** Файл офиса рядом с манифестом: зона для найма. */
export const LOCAL_META = '.office-local.json';

/** Имя пакета без области: то же правило, что у второй половины `PACKAGE_NAME_RE`. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const SKILL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Что модулю нужно знать об офисе. */
export interface MyAgentCtx {
  lang: Lang;
  /** id серверов каталога MCP офиса. */
  mcpIds: readonly string[];
  /** Роли офиса — кто нанят из своего агента. */
  roles: readonly Role[];
}

export type MyAgentResult =
  | { ok: true; agent: MyAgentView; warnings: FieldError[] }
  | { ok: false; errors: FieldError[]; warnings: FieldError[] };

export const localName = (id: string): string => `${LOCAL_SCOPE}/${id}`;
const shortId = (name: string): string => name.split('/').pop() ?? name;

// ------------------------------------------------------------ чтение

function readMeta(dir: string): { zone: string | null } {
  try {
    const raw = JSON.parse(readFileSync(resolve(dir, LOCAL_META), 'utf8')) as { zone?: unknown };
    return { zone: typeof raw.zone === 'string' && raw.zone ? raw.zone : null };
  } catch {
    return { zone: null };
  }
}

/** Свои скилы пакета: `skills/<имя>/SKILL.md` без front matter. */
export function readSkills(skillsDir: string): MyAgentSkill[] {
  if (!existsSync(skillsDir)) return [];
  const out: MyAgentSkill[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = resolve(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, 'utf8');
    const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
    const description = m ? (/^description:\s*(.*)$/m.exec(m[1])?.[1] ?? '').trim() : '';
    out.push({ name: entry.name, description, text: (m ? m[2] : raw).trim() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Черновик формы ровно из того, что лежит в пакете. */
function draftOf(pkg: AgentPackage, lang: Lang, zone: string | null): MyAgentDraft {
  const m = pkg.manifest;
  return {
    id: shortId(pkg.name),
    title: pick(m.title, lang),
    summary: pick(m.summary, lang),
    emoji: m.emoji,
    color: m.color,
    look: m.look,
    brief: pick(pkg.briefs, lang),
    engine: m.runtime.engine,
    model: m.runtime.model,
    permissionMode: m.runtime.permissionMode,
    isolate: m.runtime.isolate,
    docsDir: m.docsDir,
    tools: m.runtime.tools,
    mcp: [...m.runtime.mcp],
    skills: readSkills(resolve(pkg.dir, 'skills')),
    builtin: [...m.builtin],
    capabilities: [...m.capabilities],
    zone,
  };
}

function viewOf(pkg: AgentPackage, warnings: string[], ctx: MyAgentCtx): MyAgentView {
  const { zone } = readMeta(pkg.dir);
  const draft = draftOf(pkg, ctx.lang, zone);
  return {
    name: pkg.name,
    version: pkg.version,
    title: draft.title,
    summary: draft.summary ?? '',
    emoji: draft.emoji ?? '',
    color: draft.color ?? '',
    draft,
    zone,
    dir: pkg.dir,
    roleIds: hiredFrom(pkg.name, ctx.roles),
    warnings,
  };
}

/** Роли офиса, нанятые из своего агента, без архивных. */
export function hiredFrom(name: string, roles: readonly Role[]): string[] {
  return roles.filter((r) => !r.archived && r.package?.name === name && r.package.local).map((r) => r.id);
}

function load(root: string, name: string): { pkg: AgentPackage | null; warnings: string[] } {
  const { pkg, problems } = readPackage(packageDir(name, root));
  return {
    pkg: pkg && pkg.name === name ? pkg : null,
    warnings: problems.filter((p) => p.level === 'warn').map((p) => `${p.path}: ${p.message}`),
  };
}

/** Свои агенты офиса по имени. Битые пакеты в список не попадают. */
export function listMyAgents(root: string, ctx: MyAgentCtx): MyAgentView[] {
  const scope = resolve(root, LOCAL_SCOPE);
  if (!existsSync(scope)) return [];
  const out: MyAgentView[] = [];
  for (const entry of readdirSync(scope, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const { pkg, warnings } = load(root, localName(entry.name));
    if (pkg) out.push(viewOf(pkg, warnings, ctx));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getMyAgent(root: string, id: string, ctx: MyAgentCtx): MyAgentView | null {
  if (!ID_RE.test(id)) return null;
  const { pkg, warnings } = load(root, localName(id));
  return pkg ? viewOf(pkg, warnings, ctx) : null;
}

// ------------------------------------------------------------ проверка

/**
 * Проверить черновик целиком. `selfId` — агент, которого правят: его имя и
 * название не считаются занятыми. Ошибки и предупреждения — по полям формы.
 */
export function checkDraft(
  draft: MyAgentDraft, root: string, ctx: MyAgentCtx, selfId: string | null,
): { errors: FieldError[]; warnings: FieldError[] } {
  const errors: FieldError[] = [];
  const warnings: FieldError[] = [];
  const say = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) => t(ctx.lang, key, vars);
  const others = listMyAgents(root, ctx).filter((a) => shortId(a.name) !== selfId);

  if (selfId === null && draft.id !== undefined && draft.id !== '') {
    if (!ID_RE.test(draft.id)) errors.push({ field: 'id', message: say('myagent.idBad', { id: draft.id }) });
    else if (existsSync(packageDir(localName(draft.id), root))) {
      errors.push({ field: 'id', message: say('myagent.idTaken', { name: localName(draft.id) }) });
    }
  }

  const title = (draft.title ?? '').trim();
  if (!title) errors.push({ field: 'title', message: say('myagent.titleEmpty') });
  else if (title.length > ROLE_TITLE_LIMIT) {
    errors.push({ field: 'title', message: say('myagent.titleLong', { limit: ROLE_TITLE_LIMIT, n: title.length }) });
  } else if (others.some((a) => a.title.trim().toLowerCase() === title.toLowerCase())) {
    errors.push({ field: 'title', message: say('myagent.titleTaken', { title }) });
  }
  const summary = (draft.summary ?? '').trim();
  if (summary.length > SUMMARY_LIMIT) {
    errors.push({ field: 'summary', message: say('myagent.summaryLong', { limit: SUMMARY_LIMIT, n: summary.length }) });
  }

  const brief = (draft.brief ?? '').trim();
  if (!brief) errors.push({ field: 'brief', message: say('myagent.briefEmpty') });
  else if (brief.length < BRIEF_MIN) errors.push({ field: 'brief', message: say('myagent.briefShort', { min: BRIEF_MIN }) });
  else if (brief.length > BRIEF_MAX) errors.push({ field: 'brief', message: say('myagent.briefLong', { max: BRIEF_MAX }) });
  else if (brief.length > BRIEF_SOFT) {
    warnings.push({ field: 'brief', message: say('myagent.briefSoft', { tokens: Math.round(brief.length / 3.5) }) });
  }

  let engine: ProviderId = 'claude-code';
  if (draft.engine) {
    if (isProviderId(draft.engine)) engine = draft.engine;
    else errors.push({ field: 'engine', message: say('myagent.engineBad', { engine: String(draft.engine) }) });
  }
  if (draft.model && !MODEL_RE.test(draft.model)) errors.push({ field: 'model', message: say('myagent.modelBad') });
  if (draft.permissionMode != null && !isPermissionMode(draft.permissionMode)) {
    errors.push({ field: 'permissionMode', message: say('myagent.modeBad') });
  }
  if (draft.color && !COLOR_RE.test(draft.color)) errors.push({ field: 'color', message: say('myagent.colorBad') });
  if (draft.look && !isLookId(draft.look)) errors.push({ field: 'look', message: say('myagent.lookBad', { look: draft.look }) });
  if (draft.docsDir) {
    const d = draft.docsDir.trim();
    if (isAbsolute(d) || d.split(/[\\/]/).includes('..')) {
      errors.push({ field: 'docsDir', message: say('myagent.docsDirBad', { id: draft.id || 'agent' }) });
    }
  }

  if (Array.isArray(draft.tools)) {
    if (!draft.tools.length) errors.push({ field: 'tools', message: say('myagent.toolsEmpty') });
    else {
      // Механизм T-612: имя, которого движок не знает, сессия отбросит молча.
      const unknown = unknownEngineTools(engineOf(engine), draft.tools);
      if (unknown.length) warnings.push({ field: 'tools', message: say('myagent.toolsUnknown', { tools: unknown.join(', '), engine }) });
    }
  }
  const missing = (draft.mcp ?? []).filter((id) => !ctx.mcpIds.includes(id));
  if (missing.length) errors.push({ field: 'mcp', message: say('myagent.mcpUnknown', { ids: missing.join(', ') }) });
  const badCaps = (draft.capabilities ?? []).filter((cap) => !isCapability(cap));
  if (badCaps.length) warnings.push({ field: 'capabilities', message: say('myagent.capUnknown', { caps: badCaps.join(', ') }) });

  const seen = new Set<string>();
  (draft.skills ?? []).forEach((s, i) => {
    if (!s || typeof s.name !== 'string' || !SKILL_RE.test(s.name) || seen.has(s.name)) {
      errors.push({ field: `skills.${i}.name`, message: say('myagent.skillName') });
    } else seen.add(s.name);
    if (!s || typeof s.text !== 'string' || !s.text.trim()) errors.push({ field: `skills.${i}.text`, message: say('myagent.skillText') });
  });
  return { errors, warnings };
}

/** Свободное имя из названия: `boardgame-designer`, `-2`, `-3`… */
function freeId(title: string, root: string): string {
  const base = slugifyRoleId(title);
  let id = base;
  for (let n = 2; existsSync(packageDir(localName(id), root)); n++) id = `${base.slice(0, 35)}-${n}`;
  return id;
}

// ------------------------------------------------------------ запись

/** `0.1.3` → `0.1.4`: правка своего агента — новая версия пакета. */
const bumpPatch = (v: string): string => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '0.1.0';
};

/**
 * Собрать пакет во временную папку, проверить валидатором и поставить на
 * место. Старый пакет снимается только после удачной сборки нового.
 */
function writeAgent(
  root: string, id: string, draft: MyAgentDraft, version: string, ctx: MyAgentCtx, base: Partial<Scaffold> = {},
): { ok: true; pkg: AgentPackage; warnings: string[] } | { ok: false; error: string } {
  const name = localName(id);
  const target = packageDir(name, root);
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(resolve(root, LOCAL_SCOPE), { recursive: true });
  const engine = draft.engine && isProviderId(draft.engine) ? draft.engine : 'claude-code';
  const isolate = draft.isolate ?? true;
  const caps = (draft.capabilities ?? []).filter(isCapability);
  try {
    scaffoldPackage(tmp, {
      ...base,
      name,
      version,
      title: { [ctx.lang]: draft.title.trim() },
      ...(draft.summary?.trim() ? { summary: { [ctx.lang]: draft.summary.trim() } } : { summary: undefined }),
      ...(draft.color ? { color: draft.color } : {}),
      ...(draft.emoji ? { emoji: draft.emoji } : {}),
      look: draft.look ?? '',
      manager: false,
      docsDir: draft.docsDir?.trim() || (isolate ? '' : `docs/${id}`),
      runtime: {
        ...base.runtime,
        engine,
        ...(draft.model ? { model: draft.model } : { model: base.runtime?.model }),
        tools: draft.tools === undefined ? (base.runtime?.tools ?? null) : draft.tools,
        permissionMode: draft.permissionMode ?? null,
        isolate,
        mcp: [...(draft.mcp ?? [])],
      },
      builtin: draft.builtin ?? base.builtin ?? [],
      briefs: { [ctx.lang]: draft.brief.trim() },
      skillsFrom: undefined,
    });
    if (caps.length) {
      // scaffoldPackage способностей не пишет — дописываем в манифест сами.
      const file = resolve(tmp, 'agent.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      manifest.capabilities = caps;
      writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    for (const skill of draft.skills ?? []) {
      const dir = resolve(tmp, 'skills', skill.name);
      mkdirSync(dir, { recursive: true });
      const description = (skill.description ?? '').replace(/\s+/g, ' ').trim() || skill.name;
      writeFileSync(resolve(dir, 'SKILL.md'), `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n${skill.text.trim()}\n`);
    }
    writeFileSync(resolve(tmp, LOCAL_META), `${JSON.stringify({ zone: draft.zone ?? null }, null, 2)}\n`);

    const { pkg, problems } = readPackage(tmp);
    if (!pkg) {
      const why = problems.filter((p) => p.level === 'error').map((p) => `${p.path}: ${p.message}`).join('; ');
      throw new Error(why || 'package did not load');
    }
    rmSync(target, { recursive: true, force: true });
    renameSync(tmp, target);
    const loaded = load(root, name);
    if (!loaded.pkg) throw new Error('package did not load after move');
    return { ok: true, pkg: loaded.pkg, warnings: loaded.warnings };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    return { ok: false, error: t(ctx.lang, 'myagent.writeFailed', { error: (err as Error).message }) };
  }
}

/** Черновик из того, что прислали: строки обрезаны, лишнее отброшено. */
function normalize(raw: Partial<MyAgentDraft>): MyAgentDraft {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const list = (v: unknown): string[] | undefined =>
    (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean) : undefined);
  const out: MyAgentDraft = { title: str(raw.title) ?? '', brief: str(raw.brief) ?? '' };
  const id = str(raw.id)?.trim();
  if (id !== undefined) out.id = id;
  for (const key of ['summary', 'emoji', 'color', 'look', 'model', 'docsDir'] as const) {
    const v = str(raw[key]);
    if (v !== undefined) out[key] = v.trim();
  }
  if (raw.engine !== undefined) out.engine = raw.engine;
  if (raw.permissionMode !== undefined) out.permissionMode = raw.permissionMode;
  if (typeof raw.isolate === 'boolean') out.isolate = raw.isolate;
  if (raw.tools === null) out.tools = null;
  else if (Array.isArray(raw.tools)) out.tools = list(raw.tools);
  if (raw.mcp !== undefined) out.mcp = list(raw.mcp) ?? [];
  if (raw.builtin !== undefined) out.builtin = list(raw.builtin) ?? [];
  if (raw.capabilities !== undefined) out.capabilities = list(raw.capabilities) ?? [];
  if (Array.isArray(raw.skills)) out.skills = raw.skills as MyAgentSkill[];
  if (raw.zone !== undefined) out.zone = typeof raw.zone === 'string' && raw.zone.trim() ? raw.zone.trim() : null;
  return out;
}

// ------------------------------------------------------------ операции

/** Создать своего агента. Пустой `id` — выводится из названия. */
export function createMyAgent(
  root: string, raw: Partial<MyAgentDraft>, ctx: MyAgentCtx, base: Partial<Scaffold> = {},
): MyAgentResult {
  const draft = normalize(raw ?? {});
  const { errors, warnings } = checkDraft(draft, root, ctx, null);
  if (errors.length) return { ok: false, errors, warnings };
  const id = draft.id || freeId(draft.title, root);
  draft.id = id;
  const written = writeAgent(root, id, draft, '0.1.0', ctx, base);
  if (!written.ok) return { ok: false, errors: [{ field: '', message: written.error }], warnings };
  return { ok: true, agent: viewOf(written.pkg, written.warnings, ctx), warnings };
}

/** Править: что прислали, то и меняется. Имя пакета не меняется, версия растёт. */
export function updateMyAgent(root: string, id: string, patch: Partial<MyAgentDraft>, ctx: MyAgentCtx): MyAgentResult {
  const current = getMyAgent(root, id, ctx);
  if (!current) return { ok: false, errors: [{ field: '', message: t(ctx.lang, 'myagent.missing', { name: localName(id) }) }], warnings: [] };
  const { id: _ignored, ...rest } = patch ?? {};
  const draft = normalize({ ...current.draft, ...rest, id });
  const { errors, warnings } = checkDraft(draft, root, ctx, id);
  if (errors.length) return { ok: false, errors, warnings };
  // Поля, которых нет в черновике формы (use, servers, requires…), переносим из старого манифеста.
  const old = load(root, current.name).pkg!.manifest;
  const written = writeAgent(root, id, draft, bumpPatch(current.version), ctx, {
    tags: old.tags, license: old.license, skills: old.skills, use: old.use, servers: old.servers, requires: old.requires,
    runtime: {
      maxTurns: old.runtime.maxTurns,
      ...(old.runtime.allowLocalBinding ? { allowLocalBinding: true } : {}),
      ...(old.runtime.spendFuseTokens ? { spendFuseTokens: old.runtime.spendFuseTokens } : {}),
    },
  });
  if (!written.ok) return { ok: false, errors: [{ field: '', message: written.error }], warnings };
  return { ok: true, agent: viewOf(written.pkg, written.warnings, ctx), warnings };
}

/** Черновик из роли офиса — копия её настроек. Менеджер и архивные — null. */
export function draftFromRole(role: Role, lang: Lang): { draft: MyAgentDraft; base: Partial<Scaffold> } | null {
  if (role.isManager || role.archived) return null;
  const spec = scaffoldFromRole(role, localName('draft'), lang);
  const draft: MyAgentDraft = {
    title: role.title,
    summary: spec.summary ? pick(spec.summary, lang) : '',
    emoji: role.emoji,
    color: role.color,
    look: spec.look ?? '',
    brief: role.brief,
    engine: spec.runtime?.engine ?? null,
    model: spec.runtime?.model ?? '',
    permissionMode: role.permissionMode,
    isolate: role.isolate,
    docsDir: role.docsDir ?? '',
    tools: role.tools ?? null,
    mcp: [...(role.mcp ?? [])],
    skills: spec.skillsFrom ? readSkills(spec.skillsFrom) : [],
    builtin: [...(spec.builtin ?? [])],
    capabilities: [...(role.capabilities ?? [])],
  };
  return {
    draft,
    base: {
      tags: spec.tags, license: spec.license, skills: spec.skills, use: spec.use, servers: spec.servers, requires: spec.requires,
      runtime: {
        maxTurns: spec.runtime?.maxTurns ?? null,
        ...(spec.runtime?.allowLocalBinding ? { allowLocalBinding: true } : {}),
        ...(spec.runtime?.spendFuseTokens ? { spendFuseTokens: spec.runtime.spendFuseTokens } : {}),
      },
    },
  };
}

/** «Создать на основе»: настройки роли плюс правки `patch`. */
export function createFromRole(root: string, role: Role | undefined, patch: Partial<MyAgentDraft>, ctx: MyAgentCtx): MyAgentResult {
  const from = role ? draftFromRole(role, ctx.lang) : null;
  if (!from) return { ok: false, errors: [{ field: 'roleId', message: t(ctx.lang, 'myagent.sourceManager') }], warnings: [] };
  return createMyAgent(root, { ...from.draft, ...(patch ?? {}) }, ctx, from.base);
}

/** Удалить. Нельзя, пока агент нанят в этом офисе. */
export function deleteMyAgent(root: string, id: string, ctx: MyAgentCtx): { ok: true; name: string } | { ok: false; errors: FieldError[] } {
  const current = getMyAgent(root, id, ctx);
  if (!current) return { ok: false, errors: [{ field: '', message: t(ctx.lang, 'myagent.missing', { name: localName(id) }) }] };
  if (current.roleIds.length) {
    return { ok: false, errors: [{ field: '', message: t(ctx.lang, 'myagent.hiredBusy', { roles: current.roleIds.join(', ') }) }] };
  }
  rmSync(current.dir, { recursive: true, force: true });
  return { ok: true, name: current.name };
}

// ------------------------------------------------------------ офис

/**
 * Что нужно от офиса для найма, правки копий и ленты. В сервере — OfficeState
 * открытого офиса, в проверке — он же на временном файле.
 */
export type MyAgentOffice = Pick<
  OfficeState, 'hireFromPackage' | 'updateRolePackage' | 'detachRole' | 'roles' | 'subprojects' | 'addLog'
>;

/** Чем кончился найм: новая (или закрытая вакансией) роль либо причина отказа. */
export interface MyAgentHire {
  roleId: string | null;
  problem: string | null;
  warnings: FieldError[];
}

/** Роли офиса, ссылающиеся на свой агент по имени, включая архивные. */
const linkedRoles = (name: string, roles: readonly Role[]): Role[] =>
  roles.filter((r) => r.package?.name === name && r.package.local && !r.package.source);

/**
 * Нанять своего агента в офис тем же путём, что пакет из маркета
 * (`hireFromPackage`): роль ссылается на папку своих агентов через
 * `RoleLink.local`. Зона из `.office-local.json` ложится оверрайдом
 * `subprojects`; зоны, которой в офисе нет, — найм без закрепления и
 * предупреждение.
 */
export function hireMyAgent(office: MyAgentOffice, root: string, id: string, ctx: MyAgentCtx): MyAgentHire {
  const name = localName(id);
  const pkg = ID_RE.test(id) ? loadPackage(name, root) : null;
  if (!pkg) return { roleId: null, problem: t(ctx.lang, 'myagent.missing', { name }), warnings: [] };
  const warnings: FieldError[] = [];
  const { zone } = readMeta(pkg.dir);
  const extra: LinkOverrides = {};
  if (zone) {
    if (office.subprojects().some((s) => s.id === zone)) extra.subprojects = [zone];
    else warnings.push({ field: 'zone', message: t(ctx.lang, 'myagent.zoneUnknown', { zone }) });
  }
  const before = new Set(office.roles().map((r) => r.id));
  const problem = office.hireFromPackage(pkg, null, extra);
  const after = linkedRoles(name, office.roles()).filter((r) => !r.archived);
  // Новая роль — та, которой не было; иначе найм закрыл открытую вакансию.
  const roleId = after.find((r) => !before.has(r.id))?.id ?? (problem ? null : after[0]?.id ?? null);
  return { roleId, problem, warnings };
}

/**
 * Довести правку своего агента до всех его копий в этом офисе через
 * `updateRolePackage`: оверрайды и приписка остаются, остальное считается
 * из нового пакета. Другие офисы не трогаются (Q-206). Вернёт id обновлённых.
 */
export function syncMyAgentCopies(office: MyAgentOffice, root: string, name: string): string[] {
  const pkg = loadPackage(name, root);
  if (!pkg) return [];
  const done: string[] = [];
  for (const role of linkedRoles(name, office.roles())) {
    if (!office.updateRolePackage(role.id, pkg, null)) done.push(role.id);
  }
  return done;
}

/** Создать и, если просили, сразу нанять. В ленту — «создан». */
export function createAndHire(
  office: MyAgentOffice, root: string, made: MyAgentResult, ctx: MyAgentCtx, hire: boolean,
): { result: MyAgentResult; hired: MyAgentHire | null } {
  if (!made.ok) return { result: made, hired: null };
  office.addLog(null, 'system', t(ctx.lang, 'myagent.created', {
    title: made.agent.title, name: made.agent.name, version: made.agent.version,
  }));
  if (!hire) return { result: made, hired: null };
  const hired = hireMyAgent(office, root, shortId(made.agent.name), ctx);
  // Кто нанят — пересчитываем по свежему составу офиса.
  const agent = getMyAgent(root, shortId(made.agent.name), { ...ctx, roles: office.roles() }) ?? made.agent;
  return { result: { ...made, agent, warnings: [...made.warnings, ...hired.warnings] }, hired };
}

/** Править, довести до копий этого офиса и записать в ленту. */
export function updateAndSync(
  office: MyAgentOffice, root: string, id: string, patch: Partial<MyAgentDraft>, ctx: MyAgentCtx,
): { result: MyAgentResult; roleIds: string[] } {
  const from = getMyAgent(root, id, ctx)?.version ?? '';
  const result = updateMyAgent(root, id, patch, ctx);
  if (!result.ok) return { result, roleIds: [] };
  office.addLog(null, 'system', t(ctx.lang, 'myagent.updated', {
    title: result.agent.title, name: result.agent.name, from, to: result.agent.version,
  }));
  return { result, roleIds: syncMyAgentCopies(office, root, result.agent.name) };
}

/**
 * Удалить. Пока агент нанят (не в архиве) — отказ `myagent.hiredBusy`,
 * нанятых не ломаем. Архивные копии перед удалением отвязываются (форк):
 * без пакета они не восстановились бы.
 */
export function deleteAndDetach(
  office: MyAgentOffice, root: string, id: string, ctx: MyAgentCtx,
): ReturnType<typeof deleteMyAgent> {
  const live = { ...ctx, roles: office.roles() };
  const current = getMyAgent(root, id, live);
  if (current && !current.roleIds.length) {
    for (const role of linkedRoles(current.name, live.roles)) if (role.archived) office.detachRole(role.id);
  }
  const result = deleteMyAgent(root, id, live);
  if (result.ok) office.addLog(null, 'system', t(ctx.lang, 'myagent.deleted', { name: result.name }));
  return result;
}

// ------------------------------------------------------------ HTTP

/** Потолок тела: бриф до 30 000 символов плюс скилы. */
export const MY_AGENTS_BODY_MAX = 2 * 1024 * 1024;

/**
 * Откуда ручка берёт офис. Подменяется в проверке (scripts/test-custom-agents.ts):
 * там нет реестра офисов и живого сервера.
 */
export interface MyAgentsHttpEnv {
  office: (wanted: string | null) =>
    | { root: string; ctx: MyAgentCtx; role: (id: string) => Role | undefined; office: MyAgentOffice }
    | { code: number; error: string };
}

const defaultEnv: MyAgentsHttpEnv = {
  office: (wanted) => {
    const office = wanted ? officeById(wanted) : currentOffice();
    if (!office) return { code: 404, error: c('offices.notFound', { id: wanted ?? '' }) };
    // Папка своих агентов известна только открытому офису — как у документов.
    if (!isOpened(office.id)) return { code: 503, error: c('myagent.closed', { office: office.name }) };
    const state = getOffice(office.id);
    return {
      root: state.agentsDir(),
      ctx: { lang: state.lang(), mcpIds: mcpCatalog(state.settings).map((d) => d.id), roles: state.roles() },
      role: (id) => state.role(id),
      office: state,
    };
  },
};

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const got = await readBody(req, MY_AGENTS_BODY_MAX);
  if (!('bytes' in got)) return null;
  try {
    const parsed = JSON.parse(got.bytes.toString('utf8') || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Ответ на результат создания или правки: 201/200 с агентом или 400 с ошибками по полям. */
function answer(res: ServerResponse, result: MyAgentResult, okCode: number): void {
  if (result.ok) json(res, okCode, { agent: result.agent, warnings: result.warnings });
  else json(res, 400, { errors: result.errors, warnings: result.warnings });
}

/**
 * Ответ на создание: 201 с агентом и итогом найма. Отказ найма (нет места,
 * лимит копий) — не ошибка создания: агент сохранён, причина в `hired.problem`.
 */
function created(res: ServerResponse, got: { result: MyAgentResult; hired: MyAgentHire | null }): void {
  if (!got.result.ok) return answer(res, got.result, 201);
  json(res, 201, {
    agent: got.result.agent, warnings: got.result.warnings,
    hired: got.hired ? { roleId: got.hired.roleId, problem: got.hired.problem } : null,
  });
}

/** Обработать запрос к `/api/my-agents*`. false — адрес не наш. */
export function handleMyAgentsHttp(
  req: IncomingMessage, res: ServerResponse, url: string, query: string, env: MyAgentsHttpEnv = defaultEnv,
): boolean {
  if (url !== '/api/my-agents' && !url.startsWith('/api/my-agents/')) return false;
  void serve(req, res, url, query, env).catch((err: Error) => {
    if (!res.headersSent) json(res, 500, { error: err.message });
  });
  return true;
}

async function serve(req: IncomingMessage, res: ServerResponse, url: string, query: string, env: MyAgentsHttpEnv): Promise<void> {
  const params = new URLSearchParams(query);
  const office = env.office(params.get('office'));
  if ('code' in office) {
    json(res, office.code, { error: office.error });
    return;
  }
  const { root, ctx, office: state } = office;
  const method = req.method ?? 'GET';
  const rest = url.slice('/api/my-agents'.length).replace(/^\/|\/$/g, '');
  const bad = () => json(res, 400, { errors: [{ field: '', message: c('myagent.badBody') }], warnings: [] });

  if (rest === '') {
    if (method === 'GET') return json(res, 200, { agents: listMyAgents(root, ctx) });
    if (method === 'POST') {
      const got = await body(req);
      if (!got) return bad();
      const made = createMyAgent(root, (got.draft ?? {}) as Partial<MyAgentDraft>, ctx);
      return created(res, createAndHire(state, root, made, ctx, got.hire !== false));
    }
    return json(res, 405, { error: c('myagent.method') }, { Allow: 'GET, POST' });
  }
  if (rest === 'draft') {
    if (method !== 'GET') return json(res, 405, { error: c('myagent.method') }, { Allow: 'GET' });
    const role = office.role(params.get('roleId') ?? '');
    const from = role ? draftFromRole(role, ctx.lang) : null;
    if (!from) return json(res, 400, { errors: [{ field: 'roleId', message: t(ctx.lang, 'myagent.sourceManager') }], warnings: [] });
    return json(res, 200, { draft: from.draft });
  }
  if (rest === 'from-role') {
    if (method !== 'POST') return json(res, 405, { error: c('myagent.method') }, { Allow: 'POST' });
    const got = await body(req);
    if (!got) return bad();
    const role = typeof got.roleId === 'string' ? office.role(got.roleId) : undefined;
    const made = createFromRole(root, role, (got.patch ?? {}) as Partial<MyAgentDraft>, ctx);
    return created(res, createAndHire(state, root, made, ctx, got.hire !== false));
  }
  if (rest.endsWith('/hire')) {
    if (method !== 'POST') return json(res, 405, { error: c('myagent.method') }, { Allow: 'POST' });
    const hid = rest.slice(0, -'/hire'.length);
    if (!getMyAgent(root, hid, ctx)) return json(res, 404, { error: t(ctx.lang, 'myagent.missing', { name: localName(hid) }) });
    const hired = hireMyAgent(state, root, hid, ctx);
    const agent = getMyAgent(root, hid, { ...ctx, roles: state.roles() });
    return json(res, hired.problem ? 409 : 200, {
      agent, hired: { roleId: hired.roleId, problem: hired.problem }, warnings: hired.warnings,
    });
  }
  let id: string;
  try {
    id = decodeURIComponent(rest);
  } catch {
    id = '';
  }
  if (method === 'GET') {
    const agent = getMyAgent(root, id, ctx);
    return agent ? json(res, 200, { agent }) : json(res, 404, { error: t(ctx.lang, 'myagent.missing', { name: localName(id) }) });
  }
  if (method === 'PUT') {
    const got = await body(req);
    if (!got) return bad();
    const { result, roleIds } = updateAndSync(state, root, id, (got.patch ?? {}) as Partial<MyAgentDraft>, ctx);
    if (!result.ok && !getMyAgent(root, id, ctx)) return json(res, 404, { errors: result.errors, warnings: [] });
    if (result.ok) return json(res, 200, { agent: result.agent, warnings: result.warnings, roleIds });
    return answer(res, result, 200);
  }
  if (method === 'DELETE') {
    const result = deleteAndDetach(state, root, id, ctx);
    if (result.ok) return json(res, 200, { ok: true, name: result.name });
    return json(res, getMyAgent(root, id, ctx) ? 409 : 404, { errors: result.errors });
  }
  return json(res, 405, { error: c('myagent.method') }, { Allow: 'GET, PUT, DELETE' });
}

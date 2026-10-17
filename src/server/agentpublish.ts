/**
 * «Опубликовать в маркет» для своего агента офиса (решение владельца Q-206).
 *
 * Свой агент живёт в данных офиса под `@local` (myagents.ts) и в другие офисы
 * попадает только отсюда. Путь тот же, что у автора пакета в CLI
 * (`office-agent publish`), новых правил нет:
 *
 *   1. копия пакета из офиса переименовывается под область владельца
 *      (`@alice/<имя>`) с версией, которую задал владелец, — это форк;
 *   2. копия проходит валидатор `validatePackage`, ошибки — по полям;
 *   3. копия ложится в рабочую копию репозитория владельца, коммит, тег
 *      версии, пуш в origin — реестр не может ссылаться на коммит, которого
 *      нет на GitHub, поэтому без удачного пуша записи в реестре не будет;
 *   4. запись реестра собирает `publishInfo`, а вписывается она либо в файл
 *      реестра (`upsertEntry`), либо в сервис индекса (POST /v1/publish,
 *      идентичность — токен GitHub);
 *   5. в файл офиса рядом с пакетом пишется, что и куда опубликовано.
 *
 * Нанимают опубликованного агента в другом офисе обычным маркетом: запись
 * реестра → `installFromRegistry` → роль из пакета.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { MyAgentPublished, MyAgentPublishRequest, MyAgentView } from '../shared/myagent';
import type { FieldError } from '../shared/types';
import { git } from './git';
import { t } from './i18n';
import { loadRegistry, REGISTRY_SOURCE, serviceBase } from './market';
import { bumpPatch, getMyAgent, LOCAL_META, writePublished, type MyAgentCtx } from './myagents';
import { compareVersions, PACKAGE_NAME_RE, validatePackage } from './packages';
import { githubSlug, publishInfo, readRegistryFile, scopeProblem, upsertEntry, writeRegistryFile } from './publish';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/i;
/** Папка в репозитории: относительный путь из простых сегментов. */
const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
/** Лицензия по умолчанию: без лицензии пакет в индекс не попадает (спека маркета §12.3). */
export const DEFAULT_LICENSE = 'MIT';
/**
 * Лицензия — идентификатор или выражение SPDX: `MIT`, `Apache-2.0`,
 * `GPL-3.0-or-later`, `MIT OR Apache-2.0`, `LicenseRef-Своя`. Не больше 100 знаков.
 */
const LICENSE_ID = String.raw`\(?[A-Za-z0-9][A-Za-z0-9.+-]*\)?`;
const LICENSE_RE = new RegExp(`^${LICENSE_ID}( (AND|OR|WITH) ${LICENSE_ID})*$`);
export const licenseOk = (license: string): boolean => license.length <= 100 && LICENSE_RE.test(license);

/** Куда публиковать. Подменяется в проверке: там временный реестр. */
export interface PublishEnv {
  /** Источник реестра: файл или адрес сервиса (`https://x/v1/registry.json`). */
  registry: string;
  /** Токен GitHub по умолчанию — для сервиса индекса. */
  token: string;
  /** Запрос к сервису индекса. */
  fetch: typeof fetch;
}

export const defaultPublishEnv = (): PublishEnv => ({
  registry: REGISTRY_SOURCE,
  token: process.env.GITHUB_TOKEN ?? '',
  fetch: globalThis.fetch,
});

export type PublishResult =
  | { ok: true; agent: MyAgentView; published: MyAgentPublished; warnings: FieldError[] }
  | { ok: false; code: number; errors: FieldError[]; warnings: FieldError[] };

const fail = (code: number, errors: FieldError[], warnings: FieldError[] = []): PublishResult => ({ ok: false, code, errors, warnings });
const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/** Лицензия в манифесте агента офиса; пусто — не задана или манифест не читается. */
function manifestLicense(dir: string): string {
  try {
    const m = JSON.parse(readFileSync(resolve(dir, 'agent.json'), 'utf8')) as { license?: unknown };
    return typeof m.license === 'string' ? m.license.trim() : '';
  } catch {
    return '';
  }
}

/** Переименовать копию пакета, выставить версию и лицензию: `agent.json` и `plugin.json`. */
function retarget(dir: string, name: string, version: string, license: string): void {
  const manifestFile = resolve(dir, 'agent.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
  manifest.name = name;
  manifest.license = license;
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const pluginFile = resolve(dir, '.claude-plugin/plugin.json');
  const plugin = existsSync(pluginFile) ? JSON.parse(readFileSync(pluginFile, 'utf8')) as Record<string, unknown> : {};
  plugin.name = name.split('/')[1];
  plugin.version = version;
  plugin.license = license;
  writeFileSync(pluginFile, `${JSON.stringify(plugin, null, 2)}\n`);
  // Файл офиса (зона, прошлые публикации) в пакет реестра не уходит.
  rmSync(resolve(dir, LOCAL_META), { force: true });
}

/**
 * Собрать пакет для реестра: копия папки агента под новым именем, версией и
 * лицензией — и валидатор, тот же, что у `office-agent validate`. Замечания —
 * по полям вида `package:<файл или поле манифеста>`. Замечание о лицензии здесь
 * ошибка, а не предупреждение: пакет без лицензии реестр не покажет.
 */
export function stagePublication(
  src: string, name: string, version: string, dest: string, license = DEFAULT_LICENSE,
): { errors: FieldError[]; warnings: FieldError[] } {
  cpSync(src, dest, { recursive: true });
  try {
    retarget(dest, name, version, license);
  } catch (err) {
    return { errors: [{ field: 'package:agent.json', message: (err as Error).message }], warnings: [] };
  }
  const problems = validatePackage(dest);
  const blocking = (p: { level: string; path: string }): boolean => p.level === 'error' || p.path === 'license';
  const as = (pick: (p: { level: string; path: string }) => boolean): FieldError[] =>
    problems.filter(pick).map((p) => ({ field: `package:${p.path}`, message: p.message }));
  return { errors: as(blocking), warnings: as((p) => !blocking(p)) };
}

/** Проверить запрос до любых записей: имя, версия, репозиторий, токен. */
async function checkRequest(
  agent: MyAgentView, req: MyAgentPublishRequest, env: PublishEnv, ctx: MyAgentCtx,
): Promise<{ errors: FieldError[]; version: string; license: string; repoDir: string; path: string; origin: string; token: string }> {
  const errors: FieldError[] = [];
  const lang = ctx.lang;
  const name = (req.name ?? '').trim();
  const prev = agent.published;
  const version = (req.version ?? '').trim() || (prev && prev.name === name ? bumpPatch(prev.version) : agent.version);
  // Не задана — прошлая публикация, манифест агента, MIT; задана пустой — ошибка.
  const license = typeof req.license === 'string'
    ? req.license.trim()
    : prev?.license || manifestLicense(agent.dir) || DEFAULT_LICENSE;
  const repoDir = (req.repoDir ?? '').trim();
  const path = (req.path ?? '').trim().replace(/^\/+|\/+$/g, '') || `agents/${name.split('/')[1] ?? ''}`;
  let origin = '';

  if (!PACKAGE_NAME_RE.test(name)) errors.push({ field: 'name', message: t(lang, 'publishAgent.nameBad', { name }) });
  if (!SEMVER_RE.test(version)) errors.push({ field: 'version', message: t(lang, 'publishAgent.versionBad', { version }) });
  else if (prev && prev.name === name && compareVersions(version, prev.version) <= 0) {
    errors.push({ field: 'version', message: t(lang, 'publishAgent.versionOld', { version, prev: prev.version }) });
  }
  if (!license) errors.push({ field: 'package:license', message: t(lang, 'publishAgent.licenseEmpty') });
  else if (!licenseOk(license)) errors.push({ field: 'package:license', message: t(lang, 'publishAgent.licenseBad', { license }) });
  // Папку по умолчанию выводим из имени: при плохом имени ошибка одна — у имени.
  const pathGiven = Boolean((req.path ?? '').trim()) || PACKAGE_NAME_RE.test(name);
  if (pathGiven && (!PATH_RE.test(path) || path.split('/').some((s) => s === '..' || s === '.'))) {
    errors.push({ field: 'path', message: t(lang, 'publishAgent.pathBad', { path }) });
  }
  if (!repoDir || !isAbsolute(repoDir) || !existsSync(repoDir) || !statSync(repoDir).isDirectory()) {
    errors.push({ field: 'repoDir', message: t(lang, 'publishAgent.repoMissing', { dir: repoDir }) });
  } else {
    const top = await git(repoDir, ['rev-parse', '--show-toplevel']);
    if (!top.ok) errors.push({ field: 'repoDir', message: t(lang, 'publishAgent.repoNotGit', { dir: repoDir }) });
    else {
      // Адрес как записан, без подстановок insteadOf: в реестр уходит он.
      origin = (await git(repoDir, ['config', '--get', 'remote.origin.url'])).stdout;
      // Реестр ссылается на коммит в git автора: без origin на GitHub ссылаться не на что.
      if (!origin || !githubSlug(origin)) {
        errors.push({ field: 'repoDir', message: t(lang, 'publishAgent.noGithub', { origin: origin || '—' }) });
      } else if (PACKAGE_NAME_RE.test(name)) {
        const scope = scopeProblem(name, origin);
        if (scope) errors.push({ field: 'name', message: t(lang, 'publishAgent.scope', { name, owner: githubSlug(origin)!.split('/')[0], why: scope }) });
      }
    }
  }
  const token = (req.token ?? '').trim() || env.token;
  if (/^https?:\/\//.test(env.registry)) {
    if (!serviceBase(env.registry)) errors.push({ field: 'registry', message: t(lang, 'publishAgent.registryReadOnly', { source: env.registry }) });
    else if (!token) errors.push({ field: 'token', message: t(lang, 'publishAgent.noToken') });
  }
  return { errors, version, license, repoDir, path, origin, token };
}

/**
 * Опубликовать своего агента в маркет. Ничего не пишет, пока запрос и пакет
 * не прошли проверку; запись в реестре появляется только после пуша.
 */
export async function publishMyAgent(
  root: string, id: string, req: MyAgentPublishRequest, ctx: MyAgentCtx, env: PublishEnv = defaultPublishEnv(),
): Promise<PublishResult> {
  const lang = ctx.lang;
  const agent = getMyAgent(root, id, ctx);
  if (!agent) return fail(404, [{ field: '', message: t(lang, 'myagent.missing', { name: `@local/${id}` }) }]);
  const checked = await checkRequest(agent, req ?? ({} as MyAgentPublishRequest), env, ctx);
  if (checked.errors.length) return fail(400, checked.errors);
  const { version, license, repoDir, path, origin, token } = checked;
  const name = req.name.trim();

  // 1–2. Копия под новым именем во времянке — и валидатор, как у `office-agent publish`.
  const stage = await mkdtemp(resolve(tmpdir(), 'office-publish-'));
  const staged = resolve(stage, 'pkg');
  try {
    const { errors, warnings } = stagePublication(agent.dir, name, version, staged, license);
    if (errors.length) return fail(400, errors, warnings);

    // 3. В репозиторий владельца: коммит только папки пакета, тег версии, пуш.
    const target = resolve(repoDir, path);
    const dirty = await git(repoDir, ['status', '--porcelain', '--', path]);
    if (dirty.ok && dirty.stdout) return fail(409, [{ field: 'repoDir', message: t(lang, 'publishAgent.dirty', { path }) }], warnings);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(staged, target, { recursive: true });
    const gitFail = (what: string, stderr: string): PublishResult =>
      fail(502, [{ field: 'repoDir', message: t(lang, 'publishAgent.gitFailed', { what, error: firstLine(stderr) }) }], warnings);
    const added = await git(repoDir, ['add', '--', path]);
    if (!added.ok) return gitFail('git add', added.stderr);
    const staged2 = await git(repoDir, ['diff', '--cached', '--quiet', '--', path]);
    if (!staged2.ok) {
      const made = await git(repoDir, ['commit', '--quiet', '-m', `${name}@${version}: публикация своего агента офиса`, '--', path]);
      if (!made.ok) return gitFail('git commit', made.stderr);
    }
    const info = await publishInfo(target, { repo: origin });
    if ('error' in info) return gitFail('publish', info.error);
    if (!info.tagged) {
      const tagged = await git(repoDir, ['tag', info.tag, info.commit]);
      if (!tagged.ok) return fail(409, [{ field: 'version', message: t(lang, 'publishAgent.tagTaken', { tag: info.tag }) }], warnings);
    }
    const branch = (await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout;
    if (!branch || branch === 'HEAD') return fail(409, [{ field: 'repoDir', message: t(lang, 'publishAgent.detached') }], warnings);
    const pushed = await git(repoDir, ['push', '--quiet', 'origin', `refs/heads/${branch}`, `refs/tags/${info.tag}`]);
    if (!pushed.ok) {
      return fail(502, [{ field: 'repoDir', message: t(lang, 'publishAgent.pushFailed', { origin: info.entry.repo, error: firstLine(pushed.stderr) }) }], warnings);
    }

    // 4. Запись реестра: сервис индекса по токену или файл.
    const base = serviceBase(env.registry);
    if (base) {
      let res: Response;
      try {
        res = await env.fetch(`${base}/v1/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ repo: info.entry.repo, path: info.entry.path, commit: info.commit }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        return fail(502, [{ field: 'registry', message: t(lang, 'publishAgent.registryFailed', { source: base, error: (err as Error).message }) }], warnings);
      }
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        const field = res.status === 401 || res.status === 403 ? 'token' : 'registry';
        return fail(502, [{ field, message: t(lang, 'publishAgent.registryRefused', { error: body.error ?? `HTTP ${res.status}` }) }], warnings);
      }
    } else {
      const file = resolve(env.registry);
      const registry = readRegistryFile(file);
      if ('error' in registry) return fail(500, [{ field: 'registry', message: t(lang, 'publishAgent.registryFailed', { source: file, error: registry.error }) }], warnings);
      try {
        writeRegistryFile(file, upsertEntry(registry, info.entry));
      } catch (err) {
        return fail(500, [{ field: 'registry', message: t(lang, 'publishAgent.registryFailed', { source: file, error: (err as Error).message }) }], warnings);
      }
    }
    // Маркет этого процесса видит запись сразу, а не через десять минут кеша.
    await loadRegistry(env.registry, true);

    // 5. Связь с исходным агентом офиса.
    const published: MyAgentPublished = {
      name, version, commit: info.commit, repo: info.entry.repo, path: info.entry.path,
      at: new Date().toISOString(), registry: base || resolve(env.registry), license,
    };
    writePublished(agent.dir, published);
    return { ok: true, agent: getMyAgent(root, id, ctx)!, published, warnings };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

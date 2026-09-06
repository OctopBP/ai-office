/**
 * Публикация пакета и проверка реестра — то, что гоняет CLI и CI индекса.
 *
 * Публикация в фазе 2 — это запись в реестр: имя, репозиторий, путь, версия
 * и КОММИТ, на котором пакет проверен. Сервиса нет, реестр — файл в git, и
 * попасть в него — PR с этой записью. Что запись честная, проверяет
 * `checkRegistry`: область имени принадлежит владельцу репозитория, версии —
 * semver, коммиты — хеши, а с `fetch` — по каждой записи в репозитории на
 * этом коммите действительно лежит годный пакет с тем же именем.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { git } from './git';
import {
  installFromGit, latestVersion, parseRegistry, type Registry, type RegistryEntry,
} from './market';
import { compareVersions, OFFICIAL_SCOPE, PACKAGE_NAME_RE, readPackage, type AgentPackage } from './packages';

/** Репозиторий, которому принадлежит область `@office`. */
export const OFFICIAL_REPO = 'OctopBP/ai-office';

/** `owner/repo` из адреса GitHub любого вида. null — не GitHub. */
export function githubSlug(repo: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repo.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Кому принадлежит область имени. `@office` — нашему репозиторию; остальные
 * — владельцу репозитория на GitHub, строчными: `@alice/*` ставится только из
 * `github.com/alice/...`. Регистрировать области отдельно — значит завести
 * аккаунты до первого чужого пакета (спека §12.4).
 */
export function scopeProblem(name: string, repo: string): string | null {
  const scope = name.split('/')[0];
  const slug = githubSlug(repo);
  if (scope === OFFICIAL_SCOPE) {
    return slug?.toLowerCase() === OFFICIAL_REPO.toLowerCase() ? null : `scope ${OFFICIAL_SCOPE} is reserved for ${OFFICIAL_REPO}`;
  }
  if (!slug) return `scope ${scope}: only GitHub repositories can claim a scope (got ${repo || 'nothing'})`;
  const owner = slug.split('/')[0].toLowerCase();
  return owner === scope.slice(1) ? null : `scope ${scope} does not match repository owner ${owner}`;
}

export interface PublishInfo {
  entry: RegistryEntry;
  version: string;
  commit: string;
  /** Тег версии, который ждём на этом коммите: `lawyer@1.2.0` или `v1.2.0`. */
  tag: string;
  tagged: boolean;
  dirty: boolean;
}

/**
 * Запись реестра для пакета в рабочей копии: репозиторий из origin, путь от
 * корня, версия из plugin.json, коммит — HEAD. Грязное дерево и отсутствующий
 * тег не запрещают, но возвращаются: CLI скажет об этом словами, а CI —
 * откажет.
 */
export async function publishInfo(dir: string, opts: { repo?: string } = {}): Promise<PublishInfo | { error: string }> {
  const { pkg, problems } = readPackage(dir);
  if (!pkg) return { error: problems.filter((p) => p.level === 'error').map((p) => `${p.path}: ${p.message}`).join('; ') };
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { error: 'not inside a git repository' };
  const head = await git(dir, ['rev-parse', 'HEAD']);
  if (!head.ok) return { error: 'repository has no commits' };
  const origin = opts.repo ?? (await git(dir, ['remote', 'get-url', 'origin'])).stdout;
  if (!origin) return { error: 'no origin remote: pass --repo <url>' };
  // Оба пути — настоящие: git отдаёт корень через realpath, и относительный
  // путь от «/var/…» к «/private/var/…» уехал бы в «../../..».
  const path = relative(realpathSync(top.stdout), realpathSync(resolve(dir))).replace(/\\/g, '/');
  const base = path ? (path.split('/').pop() ?? '') : '';
  const tag = base ? `${base}@${pkg.version}` : `v${pkg.version}`;
  const tagCommit = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  const status = await git(dir, ['status', '--porcelain', '--', '.']);
  return {
    entry: {
      name: pkg.name, repo: normalizeRepo(origin), path,
      versions: [{ version: pkg.version, commit: head.stdout, at: new Date().toISOString().slice(0, 10) }],
      trust: pkg.name.startsWith(`${OFFICIAL_SCOPE}/`) ? 'official' : 'community',
    },
    version: pkg.version, commit: head.stdout, tag,
    tagged: tagCommit.ok && tagCommit.stdout === head.stdout,
    dirty: status.ok && status.stdout !== '',
  };
}

/** ssh-адрес GitHub — в https: реестр читают и те, у кого нет ключа. */
export function normalizeRepo(repo: string): string {
  const slug = githubSlug(repo);
  return slug ? `https://github.com/${slug}.git` : repo;
}

/**
 * Вписать версию в реестр: новая запись — целиком, существующая — версией
 * сверху (та же версия с другим коммитом заменяется: тег передвинули).
 * Доверие существующей записи не трогаем — его выдаёт реестр, а не автор.
 */
export function upsertEntry(registry: Registry, entry: RegistryEntry): Registry {
  const found = registry.packages.find((e) => e.name === entry.name);
  if (!found) return { schema: 1, packages: [...registry.packages, entry].sort((a, b) => a.name.localeCompare(b.name)) };
  const fresh = entry.versions[0];
  const versions = [fresh, ...found.versions.filter((v) => v.version !== fresh.version)]
    .sort((a, b) => compareVersions(b.version, a.version));
  return {
    schema: 1,
    packages: registry.packages.map((e) => (e.name === entry.name ? { ...e, repo: entry.repo, path: entry.path, versions } : e)),
  };
}

/** Прочитать файл реестра; нет файла — пустой реестр. */
export function readRegistryFile(file: string): Registry | { error: string } {
  if (!existsSync(file)) return { schema: 1, packages: [] };
  try {
    const parsed = parseRegistry(JSON.parse(readFileSync(file, 'utf8')));
    return parsed ?? { error: 'not a registry: expected { schema: 1, packages: [] }' };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export function writeRegistryFile(file: string, registry: Registry): void {
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
}

export interface RegistryProblem {
  name: string;
  message: string;
}

/**
 * Проверить реестр. Без `fetch` — только форма и правило областей; с ним —
 * установка каждой старшей версии во времянку и сверка имени пакета.
 */
export async function checkRegistry(
  file: string, opts: { fetch?: boolean; log?: (line: string) => void } = {},
): Promise<{ problems: RegistryProblem[]; checked: number }> {
  const problems: RegistryProblem[] = [];
  const raw = (() => { try { return JSON.parse(readFileSync(file, 'utf8')) as unknown; } catch (e) { return e as Error; } })();
  if (raw instanceof Error) return { problems: [{ name: '', message: `cannot read ${file}: ${raw.message}` }], checked: 0 };
  const registry = parseRegistry(raw);
  if (!registry) return { problems: [{ name: '', message: 'not a registry: expected { schema: 1, packages: [] }' }], checked: 0 };

  // Разбор молча выкинул битые записи — а здесь они должны быть ошибкой.
  const declared = Array.isArray((raw as { packages?: unknown }).packages) ? (raw as { packages: unknown[] }).packages.length : 0;
  if (declared !== registry.packages.length) {
    problems.push({ name: '', message: `${declared - registry.packages.length} entries are malformed (name, repo or versions)` });
  }
  const seen = new Set<string>();
  for (const entry of registry.packages) {
    if (seen.has(entry.name)) problems.push({ name: entry.name, message: 'listed twice' });
    seen.add(entry.name);
    if (!PACKAGE_NAME_RE.test(entry.name)) problems.push({ name: entry.name, message: 'bad name' });
    const scope = scopeProblem(entry.name, entry.repo);
    if (scope) problems.push({ name: entry.name, message: scope });
    for (const v of entry.versions) {
      if (!/^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/i.test(v.version)) problems.push({ name: entry.name, message: `version ${v.version} is not semver` });
      if (!/^[0-9a-f]{40}$/.test(v.commit)) problems.push({ name: entry.name, message: `version ${v.version}: commit must be a full 40-hex sha` });
    }
    if (!latestVersion(entry)) problems.push({ name: entry.name, message: 'every version is yanked' });
  }

  let checked = 0;
  if (opts.fetch) {
    const cache = await mkdtemp(resolve(tmpdir(), 'office-registry-check-'));
    try {
      for (const entry of registry.packages) {
        const latest = latestVersion(entry);
        if (!latest) continue;
        opts.log?.(`fetching ${entry.name}@${latest.version} from ${entry.repo} ${latest.commit.slice(0, 7)}`);
        const made = await installFromGit({ repo: entry.repo, path: entry.path, commit: latest.commit, expectName: entry.name }, cache);
        if (!made.ok) problems.push({ name: entry.name, message: made.error });
        else if (made.pkg.version !== latest.version) {
          problems.push({ name: entry.name, message: `registry says ${latest.version}, plugin.json at ${latest.commit.slice(0, 7)} says ${made.pkg.version}` });
        } else checked += 1;
      }
    } finally {
      await rm(cache, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { problems, checked };
}

/** Пакет из папки — для CLI, с ошибками текстом. */
export function packageAt(dir: string): AgentPackage | { error: string } {
  const { pkg, problems } = readPackage(dir);
  return pkg ?? { error: problems.filter((p) => p.level === 'error').map((p) => `${p.path}: ${p.message}`).join('; ') };
}

/**
 * Маркет агентов: реестр, установка пакетов из git, обновления и витрина.
 *
 * Что здесь решено (спека docs/design/agent-market/spec.md, §4–5):
 *
 * - Источник правды — git. Пакет ставится по КОММИТУ, а не по тегу: тег можно
 *   передвинуть, коммит — нет, и в ссылку роли ложится именно хеш.
 * - Реестр — это индекс, а не хранилище: файл `registry.json` со списком
 *   пакетов и ссылками на их репозитории. Читается по адресу или с диска
 *   (`OFFICE_REGISTRY`); по умолчанию — из репозитория офиса.
 * - Добавить пакет по ссылке можно всегда, минуя реестр. Доверия у такого
 *   пакета столько, сколько у ссылки, и витрина это показывает.
 * - Установка и найм разведены. Разрешения пакета (инструменты, серверы,
 *   переменные, бриф) читаются из манифеста, а манифест есть только у
 *   установленного пакета — значит, сначала поставить и посмотреть, потом
 *   нанимать. Сама установка ничего не запускает: серверы из пакета — просьба
 *   в каталог, инструменты выдаёт офис (см. packages.ts).
 * - Обновление — руками. Проверка находит новую версию, применяет человек,
 *   по роли; оверрайды и приписка остаются (roleFromPackage).
 *
 * Состояние маркета — не офисное: кеш общий на машину, реестр один на
 * процесс. Офисное здесь только то, какие роли из каких пакетов заведены, —
 * это читается из состояния при сборке витрины.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import type { Lang } from '../shared/i18n';
import {
  OFFICE_SENDER, type ClientCommand, type MarketPackageView, type MarketRoleView, type MarketView,
  type PackageTrust, type ServerEvent,
} from '../shared/types';
import { git } from './git';
import { c, t } from './i18n';
import {
  cacheDir, compareVersions, listCached, listPackages, LOCK_FILE, PACKAGE_CACHE, PACKAGE_NAME_RE,
  packageBrief, packageIntegrity, packageModel, packageTitle, pick, readLock, readPackage,
  type AgentPackage, type Localized, type PackageLock,
} from './packages';
import type { PackageSource } from './roles';
import type { OfficeState } from './state';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// --------------------------------------------------------------- реестр

export interface RegistryVersion {
  version: string;
  commit: string;
  at?: string;
  /**
   * Отпечаток дерева пакета (`packageIntegrity`) — его ставит сервис индекса,
   * достав пакет по коммиту. С ним архив из зеркала и папка из git обязаны
   * совпасть: источник не влияет на то, что поставится.
   */
  integrity?: string;
  /** Адрес архива в зеркале сервиса. Пусто — только git. */
  mirror?: string;
}

export interface RegistryEntry {
  name: string;
  repo: string;
  /** Путь пакета внутри репозитория. Пусто — пакет в корне. */
  path: string;
  versions: RegistryVersion[];
  trust: Exclude<PackageTrust, 'link'>;
  /** Отозванные версии: ставить нельзя, стоящие — с предупреждением. */
  yanked?: string[];
  /**
   * Снимок манифеста старшей версии — его кладёт сервис индекса, чтобы
   * витрина показывала название и описание ещё не установленного пакета.
   * Реестр-файл без сервиса этих полей не имеет, и это нормально.
   */
  title?: Localized;
  summary?: Localized;
  tags?: string[];
  emoji?: string;
  color?: string;
  /** Сколько раз ставили — счётчик сервиса, по согласию клиентов. */
  installs?: number;
  /**
   * Доступ. `licensed` — зеркало отдаёт архив только по ключу лицензии;
   * цена и адрес покупки — витрина, ключ выдаёт продавец. Сам сбор денег —
   * не наше дело: сервис проверяет право, магазин живёт снаружи.
   */
  access?: 'public' | 'licensed';
  price?: string;
  buyUrl?: string;
}

export interface Registry {
  schema: 1;
  packages: RegistryEntry[];
}

/**
 * Откуда читать реестр: адрес (http/https) или путь к файлу. По умолчанию —
 * файл в репозитории офиса: работает без сети, а наш индекс всё равно живёт
 * в git и приезжает вместе с офисом.
 */
export const REGISTRY_SOURCE = process.env.OFFICE_REGISTRY ?? resolve(ROOT, 'registry/registry.json');

/** Сколько держать прочитанный реестр, прежде чем перечитать. */
const REGISTRY_TTL_MS = 10 * 60 * 1000;

interface RegistryCache {
  registry: Registry | null;
  error: string | null;
  at: number;
}

let registryCache: RegistryCache | null = null;

/** Разобрать реестр: битые записи пропускаем, а не роняем весь индекс. */
export function parseRegistry(raw: unknown): Registry | null {
  if (!raw || typeof raw !== 'object' || (raw as { schema?: unknown }).schema !== 1) return null;
  const list = (raw as { packages?: unknown }).packages;
  if (!Array.isArray(list)) return null;
  const packages: RegistryEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.name !== 'string' || !PACKAGE_NAME_RE.test(e.name)) continue;
    if (typeof e.repo !== 'string' || !e.repo.trim()) continue;
    const versions = (Array.isArray(e.versions) ? e.versions : [])
      .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
      .filter((v) => typeof v.version === 'string' && typeof v.commit === 'string' && /^[0-9a-f]{7,40}$/.test(v.commit))
      .map((v) => ({
        version: v.version as string, commit: v.commit as string,
        ...(typeof v.at === 'string' ? { at: v.at } : {}),
        ...(typeof v.integrity === 'string' && /^sha256-[0-9a-f]{64}$/.test(v.integrity) ? { integrity: v.integrity } : {}),
        ...(typeof v.mirror === 'string' && /^https?:\/\//.test(v.mirror) ? { mirror: v.mirror } : {}),
      }))
      .sort((a, b) => compareVersions(b.version, a.version));
    if (!versions.length) continue;
    const trust = e.trust === 'official' || e.trust === 'verified' || e.trust === 'community' ? e.trust : 'community';
    const words = (v: unknown): Localized | undefined => {
      const rec = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
      if (!rec) return undefined;
      const out: Localized = {};
      for (const [k, text] of Object.entries(rec)) if ((k === 'ru' || k === 'en') && typeof text === 'string') out[k] = text;
      return Object.keys(out).length ? out : undefined;
    };
    const title = words(e.title);
    const summary = words(e.summary);
    packages.push({
      name: e.name,
      repo: e.repo.trim(),
      path: typeof e.path === 'string' ? e.path.replace(/^\/+|\/+$/g, '') : '',
      versions,
      trust,
      ...(Array.isArray(e.yanked) ? { yanked: e.yanked.filter((y): y is string => typeof y === 'string') } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(Array.isArray(e.tags) ? { tags: e.tags.filter((x): x is string => typeof x === 'string') } : {}),
      ...(typeof e.emoji === 'string' ? { emoji: e.emoji } : {}),
      ...(typeof e.color === 'string' ? { color: e.color } : {}),
      ...(typeof e.installs === 'number' ? { installs: e.installs } : {}),
      ...(e.access === 'licensed' ? { access: 'licensed' as const } : {}),
      ...(typeof e.price === 'string' && e.price.trim() ? { price: e.price.trim() } : {}),
      ...(typeof e.buyUrl === 'string' && /^https?:\/\//.test(e.buyUrl) ? { buyUrl: e.buyUrl } : {}),
    });
  }
  return { schema: 1, packages };
}

/** Прочитать реестр по адресу или с диска. Ошибка — текстом, не исключением. */
export async function loadRegistry(source = REGISTRY_SOURCE, force = false): Promise<RegistryCache> {
  if (!force && registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache;
  let error: string | null = null;
  let registry: Registry | null = null;
  try {
    let text: string;
    if (/^https?:\/\//.test(source)) {
      const res = await fetch(source, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } else {
      text = readFileSync(source, 'utf8');
    }
    registry = parseRegistry(JSON.parse(text));
    if (!registry) error = 'schema';
  } catch (err) {
    error = (err as Error).message;
  }
  if (error) console.log(c('market.registryFailed', { source, error }));
  registryCache = { registry, error, at: Date.now() };
  return registryCache;
}

/** Последняя не отозванная версия записи. */
export const latestVersion = (entry: RegistryEntry): RegistryVersion | null =>
  entry.versions.find((v) => !entry.yanked?.includes(v.version)) ?? null;

// ------------------------------------------------------------ лицензии

/** Ключи лицензий по имени пакета — рядом с кешем, общие на машину. */
export const LICENSES_FILE = resolve(PACKAGE_CACHE, '..', 'licenses.json');

export function readLicenses(file = LICENSES_FILE): Record<string, string> {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((kv): kv is [string, string] => PACKAGE_NAME_RE.test(kv[0]) && typeof kv[1] === 'string' && kv[1] !== ''));
  } catch {
    return {};
  }
}

/** Запомнить ключ (пустой — забыть). Ключ на витрину не едет никогда. */
export function setLicense(name: string, key: string, file = LICENSES_FILE): void {
  const all = readLicenses(file);
  if (key.trim()) all[name] = key.trim();
  else delete all[name];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
}

/** Сервис за адресом реестра: `https://x/v1/registry.json` → `https://x`. Пусто — реестр из файла. */
export const serviceBase = (source = REGISTRY_SOURCE): string =>
  (/^https?:\/\/.+\/v1\/registry\.json$/.test(source) ? source.replace(/\/v1\/registry\.json$/, '') : '');

// -------------------------------------------------------------- ссылки

export interface LinkSpec {
  repo: string;
  path: string;
  /** Тег или ветка; пусто — по тегам версий, а нет их — ветка по умолчанию. */
  ref: string;
}

/**
 * Разобрать ссылку человека. Понимаем адрес репозитория GitHub, адрес папки
 * в нём (`/tree/<ветка или тег>/<путь>`), короткое `owner/repo`, ssh-адрес и
 * путь к репозиторию на диске. Путь внутри репозитория можно дать и после
 * `#`: `owner/repo#packages/x`.
 */
export function parseLink(input: string): LinkSpec | null {
  let text = input.trim();
  if (!text) return null;
  let path = '';
  const hash = text.indexOf('#');
  if (hash > 0) { path = text.slice(hash + 1).replace(/^\/+|\/+$/g, ''); text = text.slice(0, hash); }

  const gh = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/.exec(text);
  if (gh) {
    return {
      repo: `https://github.com/${gh[1]}/${gh[2]}.git`,
      path: (gh[4] ?? path).replace(/^\/+|\/+$/g, ''),
      ref: gh[3] ?? '',
    };
  }
  if (/^git@[\w.-]+:[\w./-]+$/.test(text) || /^(https?|ssh|git|file):\/\//.test(text)) {
    return { repo: text, path, ref: '' };
  }
  if (text.startsWith('/') || text.startsWith('~/')) {
    return { repo: text.startsWith('~/') ? resolve(process.env.HOME ?? '', text.slice(2)) : text, path, ref: '' };
  }
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(text);
  if (short) return { repo: `https://github.com/${short[1]}/${short[2]}.git`, path, ref: '' };
  return null;
}

/**
 * Теги версий пакета. В монорепозитории тег — с именем пакета:
 * `backend@1.2.0`; у одиночного пакета — `v1.2.0` или `1.2.0`.
 * `base` — последний сегмент пути пакета (или имени), пусто — только v-теги.
 */
export function versionTags(tags: Array<{ tag: string; commit: string }>, base: string): RegistryVersion[] {
  const out: RegistryVersion[] = [];
  for (const { tag, commit } of tags) {
    const own = base && tag.startsWith(`${base}@`) ? tag.slice(base.length + 1) : null;
    const plain = /^v?(\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)$/i.exec(tag)?.[1] ?? null;
    const version = own && /^\d+\.\d+\.\d+/.test(own) ? own : (base ? null : plain);
    if (version) out.push({ version, commit });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/** Строки `git ls-remote --tags` / `git show-ref --tags` → теги с коммитом (у аннотированных — peeled). */
export function parseTagLines(text: string): Array<{ tag: string; commit: string }> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (!m) continue;
    const [, sha, tag, peeled] = m;
    // Peeled-строка идёт после самой ссылки и указывает на коммит: берём её.
    if (peeled || !map.has(tag)) map.set(tag, sha);
  }
  return [...map].map(([tag, commit]) => ({ tag, commit }));
}

// ----------------------------------------------------------- установка

export interface InstallSpec {
  repo: string;
  path: string;
  /** Точный коммит — из реестра. */
  commit?: string;
  /** Тег или ветка — из ссылки человека. */
  ref?: string;
  /** Имя, которое ждём в манифесте. Пусто — любое. */
  expectName?: string;
}

export type InstallResult =
  | { ok: true; pkg: AgentPackage; lock: PackageLock; dir: string; reused: boolean }
  | { ok: false; error: string };

/**
 * Поставить пакет из репозитория в кеш.
 *
 * Клонируем без рабочей копии и с ленивыми блобами (где транспорт умеет),
 * выбираем коммит, достаём из него папку пакета и проверяем её тем же
 * `readPackage`, что и встроенные. Ничего из пакета при этом не запускается.
 */
export async function installFromGit(spec: InstallSpec, cache = PACKAGE_CACHE, lang: Lang = 'en'): Promise<InstallResult> {
  const fail = (error: string): InstallResult => ({ ok: false, error });
  const tmp = await mkdtemp(resolve(tmpdir(), 'office-pkg-'));
  try {
    const clone = await git(tmp, ['clone', '--quiet', '--no-checkout', '--filter=blob:none', spec.repo, 'repo']);
    if (!clone.ok) {
      // Транспорт без фильтров (старый сервер, локальный путь) — клонируем как есть.
      rmSync(resolve(tmp, 'repo'), { recursive: true, force: true });
      const plain = await git(tmp, ['clone', '--quiet', '--no-checkout', spec.repo, 'repo']);
      if (!plain.ok) return fail(plain.stderr.split('\n')[0] || 'git clone failed');
    }
    const dir = resolve(tmp, 'repo');
    const base = basename(spec.path || '');

    let commit = spec.commit ?? '';
    if (commit) {
      const known = await git(dir, ['cat-file', '-e', `${commit}^{commit}`]);
      if (!known.ok) return fail(t(lang, 'market.noCommit', { commit }));
      const full = await git(dir, ['rev-parse', `${commit}^{commit}`]);
      commit = full.stdout;
    } else if (spec.ref) {
      const found = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${spec.ref}^{commit}`]);
      const branch = found.ok ? found : await git(dir, ['rev-parse', '--verify', '--quiet', `origin/${spec.ref}^{commit}`]);
      if (!branch.ok || !branch.stdout) return fail(t(lang, 'market.noRef', { ref: spec.ref }));
      commit = branch.stdout;
    } else {
      // Без указаний — старший тег версии пакета, а нет тегов — ветка по умолчанию.
      const tags = await git(dir, ['show-ref', '--tags', '--dereference']);
      const versions = versionTags(parseTagLines(tags.ok ? tags.stdout : ''), base);
      if (versions.length) commit = versions[0].commit;
      else {
        const head = await git(dir, ['rev-parse', 'HEAD']);
        if (!head.ok) return fail(head.stderr);
        commit = head.stdout;
      }
    }

    const checkout = await git(dir, ['checkout', '--quiet', commit, '--', spec.path || '.']);
    if (!checkout.ok) return fail(t(lang, 'market.noPath', { path: spec.path || '.', commit: commit.slice(0, 7) }));
    const src = resolve(dir, spec.path || '.');
    const read = readPackage(src);
    if (!read.pkg) {
      return fail(t(lang, 'market.noPackage', {
        problems: read.problems.filter((p) => p.level === 'error').map((p) => `${p.path}: ${p.message}`).join('; '),
      }));
    }
    if (spec.expectName && read.pkg.name !== spec.expectName) {
      return fail(t(lang, 'market.nameMismatch', { repo: spec.repo, path: spec.path || '.', found: read.pkg.name, name: spec.expectName }));
    }

    const dest = cacheDir(read.pkg.name, read.pkg.version, cache);
    const existing = readLock(dest);
    if (existing && existing.commit === commit && existsSync(dest)) {
      const { pkg } = readPackage(dest);
      if (pkg) return { ok: true, pkg, lock: existing, dir: dest, reused: true };
    }
    // Та же версия с другого коммита — автор передвинул тег. Ставим то, что
    // проверялось сейчас: коммит в записи скажет, что именно лежит.
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, filter: (p) => basename(p) !== '.git' });
    const lock: PackageLock = {
      name: read.pkg.name, version: read.pkg.version, repo: spec.repo, path: spec.path,
      commit, installedAt: Date.now(), integrity: packageIntegrity(dest),
    };
    writeFileSync(resolve(dest, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
    const { pkg } = readPackage(dest);
    if (!pkg) return fail('package unreadable after copy');
    return { ok: true, pkg, lock, dir: dest, reused: false };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Запустить tar: архивы зеркала — обычные .tgz, и tar есть везде, где есть git. */
const tar = (args: string[], cwd: string): Promise<{ ok: boolean; err: string }> => new Promise((done) => {
  execFile('tar', args, { cwd }, (e, _out, stderr) => done({ ok: !e, err: (stderr || e?.message || '').trim() }));
});

/**
 * Поставить пакет из зеркала сервиса: скачать архив версии, распаковать,
 * сверить отпечаток с реестром. Отпечаток обязателен: зеркало — чужой
 * сервер, и без сверки оно могло бы подменить пакет. Не совпало — отказ, а
 * не «почти то».
 */
export async function installFromMirror(
  spec: { mirror: string; integrity: string; commit: string; repo: string; path: string; expectName: string; version: string; license?: string },
  cache = PACKAGE_CACHE,
): Promise<InstallResult> {
  const fail = (error: string): InstallResult => ({ ok: false, error });
  const dest = cacheDir(spec.expectName, spec.version, cache);
  const existing = readLock(dest);
  if (existing && existing.commit === spec.commit && existing.integrity === spec.integrity) {
    const { pkg } = readPackage(dest);
    if (pkg) return { ok: true, pkg, lock: existing, dir: dest, reused: true };
  }
  const tmp = await mkdtemp(resolve(tmpdir(), 'office-mirror-'));
  try {
    const res = await fetch(spec.mirror, {
      signal: AbortSignal.timeout(60_000),
      ...(spec.license ? { headers: { Authorization: `Bearer ${spec.license}` } } : {}),
    });
    if (res.status === 401 || res.status === 402 || res.status === 403) return fail(`mirror: license required or not accepted (HTTP ${res.status})`);
    if (!res.ok) return fail(`mirror: HTTP ${res.status}`);
    const file = resolve(tmp, 'package.tgz');
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    mkdirSync(resolve(tmp, 'out'));
    const unpacked = await tar(['-xzf', file, '-C', resolve(tmp, 'out')], tmp);
    if (!unpacked.ok) return fail(`mirror: ${unpacked.err || 'bad archive'}`);
    const src = resolve(tmp, 'out');
    const integrity = packageIntegrity(src);
    if (integrity !== spec.integrity) return fail(`mirror: integrity mismatch (${integrity.slice(0, 19)}… vs registry ${spec.integrity.slice(0, 19)}…)`);
    const read = readPackage(src);
    if (!read.pkg || read.pkg.name !== spec.expectName || read.pkg.version !== spec.version) return fail('mirror: archive is not the package the registry describes');
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    const lock: PackageLock = {
      name: read.pkg.name, version: read.pkg.version, repo: spec.repo, path: spec.path,
      commit: spec.commit, installedAt: Date.now(), integrity,
    };
    writeFileSync(resolve(dest, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
    const { pkg } = readPackage(dest);
    return pkg ? { ok: true, pkg, lock, dir: dest, reused: false } : fail('package unreadable after copy');
  } catch (err) {
    return fail(`mirror: ${(err as Error).message}`);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Поставить версию из реестра: сначала зеркало, потом git автора. Зеркало —
 * доступность и неизменяемость (автор мог удалить репозиторий), git —
 * источник правды; отпечаток сверяется в обоих случаях, так что источник не
 * влияет на то, что поставится (спека §12.3).
 */
export async function installFromRegistry(
  entry: RegistryEntry, version: RegistryVersion, cache = PACKAGE_CACHE, lang: Lang = 'en',
): Promise<InstallResult> {
  if (version.mirror && version.integrity) {
    const viaMirror = await installFromMirror({
      mirror: version.mirror, integrity: version.integrity, commit: version.commit,
      repo: entry.repo, path: entry.path, expectName: entry.name, version: version.version,
      license: readLicenses()[entry.name],
    }, cache);
    if (viaMirror.ok) return viaMirror;
    // Лицензионный пакет из git не взять: репозиторий продавца закрыт, а
    // отказ зеркала — не сбой, а ответ. Говорим его как есть.
    if (entry.access === 'licensed') return viaMirror;
    console.log(c('market.mirrorFailed', { name: entry.name, error: viaMirror.error }));
  } else if (entry.access === 'licensed') {
    return { ok: false, error: t(lang, 'market.licenseNoMirror', { name: entry.name }) };
  }
  const viaGit = await installFromGit({ repo: entry.repo, path: entry.path, commit: version.commit, expectName: entry.name }, cache, lang);
  if (viaGit.ok && version.integrity && viaGit.lock.integrity !== version.integrity) {
    rmSync(viaGit.dir, { recursive: true, force: true });
    return { ok: false, error: t(lang, 'market.integrity', { name: entry.name, version: version.version }) };
  }
  return viaGit;
}

// ---------------------------------------------------------- обновления

/** Что нашла проверка: новая версия и её коммит. */
interface Update {
  version: string;
  commit: string;
}

/** Найденные обновления по имени пакета. Живут в памяти процесса. */
const updates = new Map<string, Update | null>();
let checkedAt: number | null = null;

/**
 * Новая версия пакета относительно установленной: сначала по реестру, потом
 * по тегам репозитория. null — новее нет или узнать не удалось.
 */
export async function findUpdate(lock: PackageLock, registry: Registry | null): Promise<Update | null> {
  const entry = registry?.packages.find((e) => e.name === lock.name);
  const fromRegistry = entry ? latestVersion(entry) : null;
  if (fromRegistry && compareVersions(fromRegistry.version, lock.version) > 0) return fromRegistry;
  if (!lock.repo) return null;
  const remote = await git(ROOT, ['ls-remote', '--tags', lock.repo]);
  if (!remote.ok) return null;
  const newest = versionTags(parseTagLines(remote.stdout), basename(lock.path || ''))[0];
  return newest && compareVersions(newest.version, lock.version) > 0 && newest.commit !== lock.commit ? newest : null;
}

// ------------------------------------------------------------- витрина

/** Замечания валидатора для карточки: только предупреждения, по одному в строку. */
const warningsOf = (dir: string): string[] =>
  readPackage(dir).problems.filter((p) => p.level === 'warn').map((p) => `${p.path}: ${p.message}`);

const emptyCard = (name: string): MarketPackageView => ({
  name, version: '', origin: 'registry', trust: 'community', installed: false,
  repo: '', path: '', commit: '', latest: '', yanked: false,
  title: '', summary: '', tags: [], emoji: '', color: '', manager: false, model: '',
  tools: null, mcp: [], servers: [], env: [], network: false, skills: [], brief: '',
  warnings: [], roles: [], kind: 'agent', members: [], settings: {}, access: 'public', price: '', buyUrl: '', licensed: false,
});

function fillFromPackage(card: MarketPackageView, pkg: AgentPackage, lang: Lang): void {
  const m = pkg.manifest;
  card.version = pkg.version;
  card.installed = true;
  card.title = packageTitle(pkg, lang);
  card.summary = pick(m.summary, lang);
  card.tags = m.tags;
  card.emoji = m.emoji;
  card.color = m.color;
  card.manager = m.manager;
  card.model = packageModel(pkg);
  card.tools = m.runtime.tools;
  card.mcp = m.runtime.mcp;
  card.servers = m.servers;
  card.env = m.requires.env;
  card.network = m.requires.network;
  card.skills = skillNames(pkg);
  card.brief = packageBrief(pkg, lang);
  card.warnings = warningsOf(pkg.dir);
  card.kind = m.kind;
  card.settings = { ...m.settings };
  card.members = m.members.map((member) => ({
    package: member.package, count: member.count, version: member.version, installed: false, available: false, title: '',
  }));
}

/** Имена скилов пакета: свои по папкам плюс встроенные из манифеста. */
function skillNames(pkg: AgentPackage): string[] {
  const dir = resolve(pkg.dir, 'skills');
  const own = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  return [...own, ...pkg.manifest.builtin];
}

/**
 * Витрина для офиса: встроенные пакеты, реестр и кеш — одной таблицей по
 * имени, плюс роли этого офиса, заведённые из каждого пакета.
 */
export async function marketView(state: OfficeState, opts: { busy?: boolean; refresh?: boolean } = {}): Promise<MarketView> {
  const lang = state.lang();
  const { registry, error } = await loadRegistry(REGISTRY_SOURCE, opts.refresh === true);
  const cards = new Map<string, MarketPackageView>();
  const card = (name: string): MarketPackageView => {
    let c0 = cards.get(name);
    if (!c0) { c0 = emptyCard(name); cards.set(name, c0); }
    return c0;
  };

  // Встроенные: то, что лежит в packages/ репозитория офиса.
  for (const pkg of listPackages()) {
    const c0 = card(pkg.name);
    fillFromPackage(c0, pkg, lang);
    c0.origin = 'builtin';
    c0.trust = 'official';
  }
  // Реестр: доверие, источник, последняя версия.
  for (const entry of registry?.packages ?? []) {
    const c0 = card(entry.name);
    const latest = latestVersion(entry);
    c0.trust = entry.trust;
    c0.repo = entry.repo;
    c0.path = entry.path;
    c0.commit = latest?.commit ?? '';
    c0.latest = latest?.version ?? '';
    if (c0.origin !== 'builtin') c0.origin = 'registry';
    // Снимок манифеста от сервиса: карточка неустановленного пакета получает
    // название и описание, а не голое имя. Установленный знает всё сам.
    if (!c0.installed) {
      c0.title = entry.title ? pick(entry.title, lang) : c0.title;
      c0.summary = entry.summary ? pick(entry.summary, lang) : c0.summary;
      c0.tags = entry.tags ?? c0.tags;
      c0.emoji = entry.emoji ?? c0.emoji;
      c0.color = entry.color ?? c0.color;
    }
    c0.access = entry.access ?? 'public';
    c0.price = entry.price ?? '';
    c0.buyUrl = entry.buyUrl ?? '';
  }
  // Кеш: установленное по ссылке или из реестра — старшая версия на карточку.
  for (const { pkg, lock } of listCached()) {
    const c0 = card(pkg.name);
    if (c0.origin === 'builtin') continue;
    if (c0.installed && compareVersions(c0.version, pkg.version) >= 0) continue;
    fillFromPackage(c0, pkg, lang);
    c0.repo = lock.repo;
    c0.path = lock.path;
    c0.commit = lock.commit;
    const entry = registry?.packages.find((e) => e.name === pkg.name);
    if (!entry) { c0.origin = 'link'; c0.trust = 'link'; }
    c0.yanked = entry?.yanked?.includes(pkg.version) === true;
    if (!c0.latest) c0.latest = updates.get(pkg.name)?.version ?? '';
  }
  // Роли офиса из пакетов.
  for (const role of state.roles()) {
    const link = role.package;
    if (!link) continue;
    const c0 = card(link.name);
    const found = updates.get(link.name);
    const newer = found && compareVersions(found.version, link.version) > 0 ? found.version
      : (c0.latest && compareVersions(c0.latest, link.version) > 0 ? c0.latest : null);
    const view: MarketRoleView = {
      id: role.id, title: role.title, version: link.version,
      updateTo: link.source ? newer : null,
      builtin: !link.source,
    };
    c0.roles.push(view);
    if (!c0.installed && !c0.title) c0.title = role.title;
  }

  // Участники команд: установлен, есть в реестре, как называется.
  const licenses = readLicenses();
  for (const c0 of cards.values()) {
    c0.licensed = Boolean(licenses[c0.name]);
    for (const member of c0.members) {
      const found = cards.get(member.package);
      member.installed = found?.installed === true;
      member.available = Boolean(found) && (found!.installed || found!.origin === 'registry');
      member.title = found?.title || member.package;
    }
  }
  const order: Record<MarketPackageView['origin'], number> = { builtin: 0, registry: 1, link: 2 };
  const packages = [...cards.values()].sort((a, b) =>
    order[a.origin] - order[b.origin] || a.name.localeCompare(b.name));
  return {
    packages, registrySource: REGISTRY_SOURCE, registryError: error, checkedAt, busy: opts.busy === true,
    service: Boolean(serviceBase()),
  };
}

// ------------------------------------------------------------- команды

type MarketCommand = Extract<ClientCommand, { c: `market_${string}` }>;

/**
 * Сообщить сервису об установке — только по галочке в настройках офиса и
 * только сервису (файлу сообщать некому). Молча: счётчик — не повод мешать.
 */
async function tellInstalled(state: OfficeState, name: string): Promise<void> {
  const base = serviceBase();
  if (!base || state.settings.marketTelemetry !== true) return;
  await fetch(`${base}/v1/packages/${name}/install`, { method: 'POST', signal: AbortSignal.timeout(5_000) }).catch(() => {});
}

/**
 * Поставить пакет по имени, если он не встроен и не в кеше: из реестра.
 * Общий шаг для установки, найма команды и обновления участников.
 */
async function ensureInstalled(state: OfficeState, name: string, version = ''): Promise<{ pkg: AgentPackage; source: PackageSource | null } | { error: string }> {
  const have = installedPackage(name);
  if (have && (!version || have.pkg.version === version)) return have;
  const { registry } = await loadRegistry();
  const entry = registry?.packages.find((e) => e.name === name);
  const wanted = entry ? (version ? entry.versions.find((v) => v.version === version) ?? null : latestVersion(entry)) : null;
  if (!entry || !wanted) return have ?? { error: t(state.lang(), 'market.notInRegistry', { name }) };
  const made = await installFromRegistry(entry, wanted, PACKAGE_CACHE, state.lang());
  if (!made.ok) return { error: made.error };
  state.addLog(null, 'system', t(state.lang(), 'market.installed', {
    name: made.pkg.name, version: made.pkg.version, repo: made.lock.repo, commit: made.lock.commit.slice(0, 7),
  }));
  void tellInstalled(state, name);
  return { pkg: made.pkg, source: toSource(made.lock) };
}

/** Установленный пакет по имени: встроенный или старшая версия из кеша. */
function installedPackage(name: string): { pkg: AgentPackage; source: PackageSource | null } | null {
  const builtin = listPackages().find((p) => p.name === name);
  if (builtin) return { pkg: builtin, source: null };
  const cached = listCached().filter((x) => x.pkg.name === name);
  const top = cached[cached.length - 1];
  return top ? { pkg: top.pkg, source: { repo: top.lock.repo, path: top.lock.path, commit: top.lock.commit } } : null;
}

const toSource = (lock: PackageLock): PackageSource => ({ repo: lock.repo, path: lock.path, commit: lock.commit });

/**
 * Разобрать команду маркета. Отказы говорим тем же способом, что найм и
 * настройки, — готовым текстом в чат офиса: форма ловит его как уведомление.
 * После каждой команды просившему уезжает свежая витрина.
 */
export async function handleMarketCommand(
  cmd: MarketCommand, state: OfficeState, send: (e: ServerEvent) => void,
): Promise<void> {
  const lang = state.lang();
  const say = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
    state.addChat(OFFICE_SENDER, t(lang, key, vars));
  const view = async (busy = false, refresh = false) => send({ t: 'market', market: await marketView(state, { busy, refresh }) });

  if (cmd.c === 'market_open') {
    await view(false, cmd.refresh === true);
    return;
  }
  if (cmd.c === 'market_install' || cmd.c === 'market_add_link') {
    await view(true);
    let spec: InstallSpec | null = null;
    if (cmd.c === 'market_install') {
      const { registry } = await loadRegistry();
      const entry = registry?.packages.find((e) => e.name === cmd.name);
      const latest = entry ? latestVersion(entry) : null;
      if (!entry || !latest) say('market.notInRegistry', { name: cmd.name });
      else {
        const made = await installFromRegistry(entry, latest, PACKAGE_CACHE, lang);
        if (!made.ok) say('market.installFailed', { error: made.error });
        else {
          state.addLog(null, 'system', t(lang, 'market.installed', {
            name: made.pkg.name, version: made.pkg.version, repo: made.lock.repo, commit: made.lock.commit.slice(0, 7),
          }));
          void tellInstalled(state, made.pkg.name);
        }
        await view();
        return;
      }
    } else {
      const link = parseLink(cmd.url);
      if (!link) say('market.badLink', { url: cmd.url });
      else spec = { repo: link.repo, path: link.path, ref: link.ref };
    }
    if (spec) {
      const made = await installFromGit(spec, PACKAGE_CACHE, lang);
      if (!made.ok) say('market.installFailed', { error: made.error });
      else {
        state.addLog(null, 'system', t(lang, 'market.installed', {
          name: made.pkg.name, version: made.pkg.version, repo: made.lock.repo, commit: made.lock.commit.slice(0, 7),
        }));
      }
    }
    await view();
    return;
  }
  if (cmd.c === 'market_hire') {
    const found = installedPackage(cmd.name);
    if (!found) say('market.notInstalled', { name: cmd.name });
    else if (found.pkg.manifest.kind === 'team') say('market.isTeam', { name: cmd.name });
    else {
      const problem = state.hireFromPackage(found.pkg, found.source);
      if (problem) state.addChat(OFFICE_SENDER, problem);
    }
    await view();
    return;
  }
  if (cmd.c === 'market_hire_team') {
    const team = installedPackage(cmd.name);
    if (!team) say('market.notInstalled', { name: cmd.name });
    else if (team.pkg.manifest.kind !== 'team') say('market.notTeam', { name: cmd.name });
    else {
      await view(true);
      const problems: string[] = [];
      let hired = 0;
      for (const member of team.pkg.manifest.members) {
        const got = await ensureInstalled(state, member.package, member.version);
        if ('error' in got) { problems.push(`${member.package}: ${got.error}`); continue; }
        if (got.pkg.manifest.kind !== 'agent') { problems.push(`${member.package}: ${t(lang, 'market.isTeam', { name: member.package })}`); continue; }
        // Менеджер в офисе уже есть: участник-менеджер — это «оставить как есть».
        if (got.pkg.manifest.manager) continue;
        for (let i = 0; i < member.count; i += 1) {
          const problem = state.hireFromPackage(got.pkg, got.source);
          if (problem) { problems.push(`${member.package}: ${problem}`); break; }
          hired += 1;
        }
      }
      const settings = Object.fromEntries(Object.entries(team.pkg.manifest.settings).filter(([, v]) => v !== undefined));
      if (Object.keys(settings).length) {
        const problem = state.updateSettings(settings as Parameters<OfficeState['updateSettings']>[0]);
        if (problem) problems.push(problem);
      }
      say(problems.length ? 'market.teamHiredWithProblems' : 'market.teamHired', {
        name: cmd.name, n: hired, problems: problems.join('; '),
      });
    }
    await view();
    return;
  }
  if (cmd.c === 'market_license') {
    if (!PACKAGE_NAME_RE.test(cmd.name)) say('market.notInRegistry', { name: cmd.name });
    else {
      setLicense(cmd.name, cmd.key);
      say(cmd.key.trim() ? 'market.licenseSaved' : 'market.licenseForgotten', { name: cmd.name });
    }
    await view();
    return;
  }
  if (cmd.c === 'market_check') {
    await view(true);
    const { registry } = await loadRegistry(REGISTRY_SOURCE, true);
    const seen = new Set<string>();
    for (const role of state.roles()) {
      const link = role.package;
      if (!link?.source || seen.has(link.name)) continue;
      seen.add(link.name);
      const lock: PackageLock = {
        name: link.name, version: link.version, repo: link.source.repo, path: link.source.path,
        commit: link.source.commit, installedAt: 0, integrity: '',
      };
      updates.set(link.name, await findUpdate(lock, registry));
    }
    checkedAt = Date.now();
    const fresh = [...updates.values()].filter(Boolean).length;
    say(fresh ? 'market.updatesFound' : 'market.noUpdates', { n: fresh });
    await view();
    return;
  }
  if (cmd.c === 'market_update') {
    const role = state.role(cmd.roleId);
    const link = role?.package;
    if (!role || !link) say('market.roleNotLinked', { title: role?.title ?? cmd.roleId });
    else if (!link.source) say('market.builtin', { name: link.name });
    else {
      await view(true);
      const { registry } = await loadRegistry();
      const lock: PackageLock = {
        name: link.name, version: link.version, repo: link.source.repo, path: link.source.path,
        commit: link.source.commit, installedAt: 0, integrity: '',
      };
      const next = updates.get(link.name) ?? await findUpdate(lock, registry);
      if (!next) say('market.noUpdate', { name: link.name });
      else {
        // Версия из реестра ставится через него (зеркало, отпечаток); из тегов — из git.
        const entry = registry?.packages.find((e) => e.name === link.name);
        const known = entry?.versions.find((v) => v.version === next.version && v.commit === next.commit);
        const made = entry && known
          ? await installFromRegistry(entry, known, PACKAGE_CACHE, lang)
          : await installFromGit(
            { repo: link.source.repo, path: link.source.path, commit: next.commit, expectName: link.name }, PACKAGE_CACHE, lang,
          );
        if (!made.ok) say('market.installFailed', { error: made.error });
        else {
          const problem = state.updateRolePackage(role.id, made.pkg, toSource(made.lock));
          if (problem) state.addChat(OFFICE_SENDER, problem);
          else updates.delete(link.name);
        }
      }
    }
    await view();
  }
}

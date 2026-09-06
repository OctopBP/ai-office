/**
 * Сервис индекса — фаза 3 маркета (спека §4.2, §6, §12.2–12.4).
 *
 * Тот же реестр, что и файл, но с тем, чего файлу не дать: поиск по снимкам
 * манифестов, страницы пакетов с README, зеркало архивов на случай удалённого
 * репозитория, счётчики установок, публикация по GitHub-идентичности и
 * отметки доверия. Формат записи — тот же `registry.json`: клиент офиса ходит
 * в `GET /v1/registry.json`, а при недоступности сервиса — в git автора.
 *
 * Хранилище — папка на диске, без базы:
 *
 *   <data>/registry.json                       индекс (обогащённый: снимок манифеста, зеркало, отпечаток)
 *   <data>/mirror/@scope/name/<version>.tgz    архив версии — что проверялось, то и лежит
 *   <data>/mirror/@scope/name/<version>.json   манифест, README, бриф, отпечаток — для страницы и поиска
 *   <data>/stats.json                          счётчики установок
 *
 * Что сервис НЕ делает: не запускает ничего из пакетов (архив — это файлы),
 * не гоняет стенд на публикации (он стоит токенов — это админская задача),
 * не хранит токены GitHub (токен только проверяется запросом к API и
 * забывается).
 *
 * Запуск: `npm run registry -- --port 8787 --data ./registry-data [--seed registry/registry.json]`.
 * Переменные: OFFICE_REGISTRY_ADMIN_TOKEN — токен админа (verified, yank),
 * OFFICE_REGISTRY_GITHUB_API — адрес API GitHub (для тестов подменяется).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  compareVersions, packageBrief, packageIntegrity, packageTitle, pick, PACKAGE_NAME_RE, readPackage,
  type AgentPackage, type Localized,
} from '../server/packages';
import {
  installFromGit, latestVersion, parseRegistry, type Registry, type RegistryEntry, type RegistryVersion,
} from '../server/market';
import { githubSlug, normalizeRepo, scopeProblem, upsertEntry } from '../server/publish';
import { OFFICIAL_SCOPE } from '../server/packages';

export interface ServiceOptions {
  dataDir: string;
  /** Публичный адрес сервиса — им подписываются ссылки на зеркало. Пусто — по запросу. */
  baseUrl?: string;
  adminToken?: string;
  /** Адрес API GitHub: `https://api.github.com`; в тестах — свой. */
  githubApi?: string;
  log?: (line: string) => void;
}

/** Снимок версии для страницы и поиска. */
export interface VersionMeta {
  name: string;
  version: string;
  commit: string;
  integrity: string;
  title: Localized;
  summary: Localized;
  tags: string[];
  emoji: string;
  color: string;
  manager: boolean;
  model: string;
  tools: string[] | null;
  mcp: string[];
  servers: string[];
  env: string[];
  network: boolean;
  skills: string[];
  briefs: Localized;
  readme: string;
  publishedAt: number;
}

interface Stats {
  installs: Record<string, number>;
}

/**
 * Лицензии: ключ → пакет и владелец. Выдаёт админ — то есть продавец: сервис
 * проверяет право на архив, а деньги берёт магазин снаружи. Ключи лежат в
 * `licenses.json` данных сервиса; истёкшие не отдают архив.
 */
interface License {
  name: string;
  owner: string;
  issuedAt: number;
  expiresAt: number | null;
}

const tar = (args: string[], cwd: string): Promise<{ ok: boolean; err: string }> => new Promise((done) => {
  execFile('tar', args, { cwd }, (e, _o, stderr) => done({ ok: !e, err: (stderr || e?.message || '').trim() }));
});

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body, null, 2));
};

const readBody = (req: IncomingMessage): Promise<string> => new Promise((done, fail) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => { chunks.push(c); if (chunks.reduce((n, b) => n + b.length, 0) > 1_000_000) fail(new Error('body too large')); });
  req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  req.on('error', fail);
});

export class RegistryService {
  private registry: Registry = { schema: 1, packages: [] };
  private stats: Stats = { installs: {} };
  private licenses: Record<string, License> = {};
  private server: Server | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ServiceOptions) {
    this.log = opts.log ?? (() => {});
    mkdirSync(resolve(opts.dataDir, 'mirror'), { recursive: true });
    const file = resolve(opts.dataDir, 'registry.json');
    if (existsSync(file)) this.registry = parseRegistry(JSON.parse(readFileSync(file, 'utf8'))) ?? this.registry;
    const stats = resolve(opts.dataDir, 'stats.json');
    if (existsSync(stats)) this.stats = JSON.parse(readFileSync(stats, 'utf8')) as Stats;
    const licenses = resolve(opts.dataDir, 'licenses.json');
    if (existsSync(licenses)) this.licenses = JSON.parse(readFileSync(licenses, 'utf8')) as Record<string, License>;
  }

  // ------------------------------------------------------------ хранение

  private save(): void {
    writeFileSync(resolve(this.opts.dataDir, 'registry.json'), `${JSON.stringify(this.registry, null, 2)}\n`);
    writeFileSync(resolve(this.opts.dataDir, 'stats.json'), `${JSON.stringify(this.stats, null, 2)}\n`);
    writeFileSync(resolve(this.opts.dataDir, 'licenses.json'), `${JSON.stringify(this.licenses, null, 2)}\n`);
  }

  /** Ключ годен для пакета: выдан на него и не истёк. */
  private licenseOk(name: string, key: string): boolean {
    const lic = this.licenses[key];
    return Boolean(lic) && lic.name === name && (lic.expiresAt === null || lic.expiresAt > Date.now());
  }

  private metaFile = (name: string, version: string): string =>
    resolve(this.opts.dataDir, 'mirror', ...name.split('/'), `${version}.json`);

  private tgzFile = (name: string, version: string): string =>
    resolve(this.opts.dataDir, 'mirror', ...name.split('/'), `${version}.tgz`);

  meta(name: string, version: string): VersionMeta | null {
    const file = this.metaFile(name, version);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as VersionMeta : null;
  }

  private mirrorUrl(name: string, version: string, base: string): string {
    return `${base.replace(/\/+$/, '')}/v1/packages/${name}/${version}.tgz`;
  }

  /** Публичный адрес: из настроек либо из заголовка Host запроса. */
  private base(req?: IncomingMessage): string {
    if (this.opts.baseUrl) return this.opts.baseUrl;
    const host = req?.headers.host ?? `127.0.0.1:${this.port()}`;
    return `http://${host}`;
  }

  port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? 0;
  }

  // ------------------------------------------------------------- индекс

  /**
   * Взять версию из репозитория по коммиту, положить архив в зеркало и
   * снимок манифеста рядом. Возвращает запись версии с отпечатком, готовую в
   * реестр. Что именно легло — то, что проверил `readPackage`.
   */
  async ingest(entry: Pick<RegistryEntry, 'name' | 'repo' | 'path'>, version: RegistryVersion): Promise<RegistryVersion | { error: string }> {
    const cache = await mkdtemp(resolve(tmpdir(), 'office-ingest-'));
    try {
      const made = await installFromGit({ repo: entry.repo, path: entry.path, commit: version.commit, expectName: entry.name }, cache);
      if (!made.ok) return { error: made.error };
      if (made.pkg.version !== version.version) return { error: `registry says ${version.version}, plugin.json says ${made.pkg.version}` };
      const tgz = this.tgzFile(entry.name, version.version);
      mkdirSync(dirname(tgz), { recursive: true });
      // Запись об установке в архив не кладём: это след клиента, а не пакет,
      // и отпечаток считается без неё.
      const packed = await tar(['-czf', tgz, '--exclude', '.office-lock.json', '-C', made.dir, '.'], made.dir);
      if (!packed.ok) return { error: `tar: ${packed.err}` };
      const meta = this.snapshot(made.pkg, version.commit, made.lock.integrity);
      writeFileSync(this.metaFile(entry.name, version.version), `${JSON.stringify(meta, null, 2)}\n`);
      this.log(`ingested ${entry.name}@${version.version} ${version.commit.slice(0, 7)}`);
      return { ...version, integrity: made.lock.integrity };
    } finally {
      await rm(cache, { recursive: true, force: true }).catch(() => {});
    }
  }

  private snapshot(pkg: AgentPackage, commit: string, integrity: string): VersionMeta {
    const m = pkg.manifest;
    const readme = resolve(pkg.dir, 'README.md');
    return {
      name: pkg.name, version: pkg.version, commit, integrity,
      title: m.title, summary: m.summary, tags: m.tags, emoji: m.emoji, color: m.color, manager: m.manager,
      model: m.runtime.model, tools: m.runtime.tools, mcp: m.runtime.mcp,
      servers: m.servers.map((s) => s.id), env: m.requires.env, network: m.requires.network,
      skills: [...m.skills, ...m.builtin], briefs: pkg.briefs,
      readme: existsSync(readme) ? readFileSync(readme, 'utf8').slice(0, 20_000) : '',
      publishedAt: Date.now(),
    };
  }

  /** Обогатить запись снимком старшей версии: название, описание, теги. */
  private decorate(entry: RegistryEntry): RegistryEntry {
    const latest = latestVersion(entry);
    const meta = latest ? this.meta(entry.name, latest.version) : null;
    return {
      ...entry,
      ...(meta ? { title: meta.title, summary: meta.summary, tags: meta.tags, emoji: meta.emoji, color: meta.color } : {}),
      installs: this.stats.installs[entry.name] ?? 0,
    };
  }

  /** Реестр наружу: зеркальные адреса подписаны публичным адресом. */
  view(base: string): Registry {
    return {
      schema: 1,
      packages: this.registry.packages.map((e) => this.decorate({
        ...e,
        versions: e.versions.map((v) => (existsSync(this.tgzFile(e.name, v.version)) && v.integrity
          ? { ...v, mirror: this.mirrorUrl(e.name, v.version, base) }
          : v)),
      })),
    };
  }

  /**
   * Засеять индекс из файла реестра: каждую версию, которой ещё нет в
   * зеркале, достать и проверить. Битые версии в индекс не попадают —
   * сервис не должен обещать то, чего не проверил.
   */
  async seed(file: string): Promise<{ added: number; problems: string[] }> {
    const parsed = parseRegistry(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed) return { added: 0, problems: ['not a registry'] };
    const problems: string[] = [];
    let added = 0;
    for (const entry of parsed.packages) {
      const scope = scopeProblem(entry.name, entry.repo);
      if (scope) { problems.push(`${entry.name}: ${scope}`); continue; }
      const versions: RegistryVersion[] = [];
      for (const v of entry.versions) {
        const have = this.registry.packages.find((e) => e.name === entry.name)?.versions.find((x) => x.version === v.version && x.commit === v.commit);
        if (have?.integrity && existsSync(this.tgzFile(entry.name, v.version))) { versions.push(have); continue; }
        const got = await this.ingest(entry, v);
        if ('error' in got) { problems.push(`${entry.name}@${v.version}: ${got.error}`); continue; }
        versions.push(got);
        added += 1;
      }
      if (!versions.length) continue;
      const existing = this.registry.packages.find((e) => e.name === entry.name);
      this.registry = upsertEntry(this.registry, {
        name: entry.name, repo: entry.repo, path: entry.path, versions: versions.slice(0, 1),
        trust: existing?.trust ?? entry.trust, ...(entry.yanked ? { yanked: entry.yanked } : {}),
      });
      for (const v of versions.slice(1)) this.registry = upsertEntry(this.registry, { ...entry, versions: [v] });
      // Старшая версия могла оказаться не первой в списке — пересортируем.
      this.registry.packages = this.registry.packages.map((e) => (e.name === entry.name
        ? { ...e, versions: [...e.versions].sort((a, b) => compareVersions(b.version, a.version)) }
        : e));
    }
    this.save();
    return { added, problems };
  }

  // --------------------------------------------------------- публикация

  /** Кто стоит за токеном GitHub. null — токен не принят. */
  private async githubLogin(token: string): Promise<string | null> {
    const api = (this.opts.githubApi ?? 'https://api.github.com').replace(/\/+$/, '');
    try {
      const res = await fetch(`${api}/user`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'ai-office-registry', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = await res.json() as { login?: unknown };
      return typeof body.login === 'string' && body.login ? body.login : null;
    } catch {
      return null;
    }
  }

  /**
   * Опубликовать версию: репозиторий, путь и коммит от автора, идентичность —
   * от GitHub. Область имени обязана совпасть с логином (или пакет — из
   * репозитория админа). Доверие новой записи — community; verified ставит
   * админ отдельно.
   */
  async publish(body: { repo?: unknown; path?: unknown; commit?: unknown }, token: string): Promise<{ status: number; result: unknown }> {
    const repo = typeof body.repo === 'string' ? normalizeRepo(body.repo.trim()) : '';
    const path = typeof body.path === 'string' ? body.path.replace(/^\/+|\/+$/g, '') : '';
    const commit = typeof body.commit === 'string' ? body.commit.trim() : '';
    if (!repo || !/^[0-9a-f]{40}$/.test(commit)) return { status: 400, result: { error: 'repo and a full 40-hex commit are required' } };

    const admin = Boolean(this.opts.adminToken) && token === this.opts.adminToken;
    const login = admin ? null : await this.githubLogin(token);
    if (!admin && !login) return { status: 401, result: { error: 'GitHub token not accepted' } };
    const owner = githubSlug(repo)?.split('/')[0] ?? '';
    if (!admin && owner.toLowerCase() !== login!.toLowerCase()) {
      return { status: 403, result: { error: `repository owner ${owner} is not you (${login})` } };
    }

    const cache = await mkdtemp(resolve(tmpdir(), 'office-publish-'));
    try {
      const made = await installFromGit({ repo, path, commit }, cache);
      if (!made.ok) return { status: 422, result: { error: made.error } };
      const name = made.pkg.name;
      const scope = scopeProblem(name, repo);
      if (scope && !(admin && name.startsWith(`${OFFICIAL_SCOPE}/`))) return { status: 403, result: { error: scope } };
      const existing = this.registry.packages.find((e) => e.name === name);
      if (existing && normalizeRepo(existing.repo) !== repo) {
        return { status: 409, result: { error: `${name} is published from ${existing.repo}; a package does not move between repositories` } };
      }
      const version: RegistryVersion = { version: made.pkg.version, commit, at: new Date().toISOString().slice(0, 10) };
      const got = await this.ingest({ name, repo, path }, version);
      if ('error' in got) return { status: 422, result: { error: got.error } };
      this.registry = upsertEntry(this.registry, { name, repo, path, versions: [got], trust: existing?.trust ?? 'community' });
      this.save();
      this.log(`published ${name}@${got.version} by ${admin ? 'admin' : login}`);
      return { status: 200, result: { name, version: got.version, commit, integrity: got.integrity, trust: existing?.trust ?? 'community' } };
    } finally {
      await rm(cache, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Админ: доверие и отзыв версий. */
  private admin(body: { name?: unknown; trust?: unknown; yank?: unknown; unyank?: unknown }): { status: number; result: unknown } {
    const name = typeof body.name === 'string' ? body.name : '';
    const entry = this.registry.packages.find((e) => e.name === name);
    if (!entry) return { status: 404, result: { error: `no package ${name}` } };
    if (body.trust !== undefined) {
      if (body.trust !== 'official' && body.trust !== 'verified' && body.trust !== 'community') return { status: 400, result: { error: 'trust: official | verified | community' } };
      entry.trust = body.trust;
    }
    const yanked = new Set(entry.yanked ?? []);
    if (typeof body.yank === 'string') yanked.add(body.yank);
    if (typeof body.unyank === 'string') yanked.delete(body.unyank);
    entry.yanked = [...yanked];
    if (!entry.yanked.length) delete entry.yanked;
    const b = body as { access?: unknown; price?: unknown; buyUrl?: unknown };
    if (b.access !== undefined) {
      if (b.access !== 'public' && b.access !== 'licensed') return { status: 400, result: { error: 'access: public | licensed' } };
      if (b.access === 'licensed') entry.access = 'licensed'; else delete entry.access;
    }
    if (typeof b.price === 'string') { if (b.price.trim()) entry.price = b.price.trim(); else delete entry.price; }
    if (typeof b.buyUrl === 'string') { if (/^https?:\/\//.test(b.buyUrl)) entry.buyUrl = b.buyUrl; else delete entry.buyUrl; }
    this.save();
    return { status: 200, result: this.decorate(entry) };
  }

  /**
   * Выдать ключ лицензии на пакет. Ключ случайный, хранится у сервиса и
   * возвращается продавцу один раз — дальше он отдаёт его покупателю сам.
   */
  private issueLicense(body: { name?: unknown; owner?: unknown; days?: unknown }): { status: number; result: unknown } {
    const name = typeof body.name === 'string' ? body.name : '';
    if (!this.registry.packages.some((e) => e.name === name)) return { status: 404, result: { error: `no package ${name}` } };
    const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
    if (!owner) return { status: 400, result: { error: 'owner required' } };
    const days = typeof body.days === 'number' && body.days > 0 ? body.days : null;
    const key = `lic_${randomBytes(18).toString('base64url')}`;
    this.licenses[key] = { name, owner, issuedAt: Date.now(), expiresAt: days ? Date.now() + days * 86_400_000 : null };
    this.save();
    this.log(`license issued for ${name} to ${owner}`);
    return { status: 200, result: { key, name, owner, expiresAt: this.licenses[key].expiresAt } };
  }

  // -------------------------------------------------------------- HTTP

  /** Маркетплейс Claude Code: тот же индекс, только скилы — без роли (спека §12.2). */
  marketplace(): unknown {
    return {
      name: 'ai-office',
      owner: { name: 'AI Office registry' },
      plugins: this.registry.packages.flatMap((e) => {
        const latest = latestVersion(e);
        // Лицензионный пакет в открытый маркетплейс не идёт: его источник закрыт.
        if (!latest || e.access === 'licensed') return [];
        const slug = githubSlug(e.repo);
        const short = e.name.split('/')[1];
        return [{
          name: short,
          description: pick(this.meta(e.name, latest.version)?.summary ?? {}, 'en') || e.name,
          version: latest.version,
          source: slug ? { source: 'github', repo: slug, ...(e.path ? { path: e.path } : {}) } : { source: 'url', url: e.repo },
        }];
      }),
    };
  }

  search(q: string, tag: string, lang: 'ru' | 'en'): unknown[] {
    const needle = q.trim().toLowerCase();
    return this.view('').packages.filter((e) => {
      if (tag && !(e.tags ?? []).includes(tag)) return false;
      if (!needle) return true;
      const hay = [e.name, pick(e.title ?? {}, lang), pick(e.summary ?? {}, lang), ...(e.tags ?? [])].join(' ').toLowerCase();
      return hay.includes(needle);
    }).map((e) => ({
      name: e.name, trust: e.trust, latest: latestVersion(e)?.version ?? '', installs: e.installs ?? 0,
      title: pick(e.title ?? {}, lang), summary: pick(e.summary ?? {}, lang), tags: e.tags ?? [], emoji: e.emoji ?? '', color: e.color ?? '',
    }));
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const base = this.base(req);
    const parts = url.pathname.split('/').filter(Boolean);
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' }); res.end(); return; }
      if (parts[0] !== 'v1') { json(res, 404, { error: 'not found' }); return; }
      const rest = parts.slice(1);

      if (req.method === 'GET' && rest[0] === 'registry.json' && rest.length === 1) { json(res, 200, this.view(base)); return; }
      if (req.method === 'GET' && rest[0] === 'marketplace.json' && rest.length === 1) { json(res, 200, this.marketplace()); return; }
      if (req.method === 'GET' && rest[0] === 'packages' && rest.length === 1) {
        const lang = url.searchParams.get('lang') === 'ru' ? 'ru' : 'en';
        json(res, 200, { packages: this.search(url.searchParams.get('q') ?? '', url.searchParams.get('tag') ?? '', lang) });
        return;
      }
      if (rest[0] === 'packages' && rest.length >= 3) {
        const name = decodeURIComponent(`${rest[1]}/${rest[2]}`);
        if (!PACKAGE_NAME_RE.test(name)) { json(res, 400, { error: 'bad package name' }); return; }
        const entry = this.registry.packages.find((e) => e.name === name);
        if (!entry) { json(res, 404, { error: `no package ${name}` }); return; }
        if (req.method === 'GET' && rest.length === 3) {
          const versions = entry.versions.map((v) => ({ ...v, meta: this.meta(name, v.version) }));
          json(res, 200, { ...this.decorate(entry), versions, mirror: this.view(base).packages.find((e) => e.name === name)?.versions });
          return;
        }
        const tail = rest[3] ?? '';
        if (req.method === 'GET' && tail.endsWith('.tgz')) {
          const version = tail.slice(0, -4);
          const file = this.tgzFile(name, version);
          if (!existsSync(file)) { json(res, 404, { error: 'no archive' }); return; }
          // Лицензионный пакет — только по ключу. 402: «нужна оплата», и это
          // честный код: право проверено здесь, деньги — в магазине снаружи.
          if (entry.access === 'licensed' && !this.licenseOk(name, token)) {
            json(res, 402, { error: 'license key required', price: entry.price ?? '', buyUrl: entry.buyUrl ?? '' });
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/gzip', 'Access-Control-Allow-Origin': '*' });
          res.end(readFileSync(file));
          return;
        }
        if (req.method === 'POST' && tail === 'install') {
          this.stats.installs[name] = (this.stats.installs[name] ?? 0) + 1;
          this.save();
          json(res, 200, { installs: this.stats.installs[name] });
          return;
        }
      }
      if (req.method === 'POST' && rest[0] === 'publish' && rest.length === 1) {
        if (!token) { json(res, 401, { error: 'Authorization: Bearer <GitHub token> required' }); return; }
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        const out = await this.publish(body, token);
        json(res, out.status, out.result);
        return;
      }
      if (req.method === 'POST' && rest[0] === 'admin' && (rest.length === 1 || (rest.length === 2 && rest[1] === 'license'))) {
        if (!this.opts.adminToken || token !== this.opts.adminToken) { json(res, 401, { error: 'admin token required' }); return; }
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        const out = rest.length === 2 ? this.issueLicense(body) : this.admin(body);
        json(res, out.status, out.result);
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  }

  listen(port: number, host = '127.0.0.1'): Promise<number> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    return new Promise((done) => this.server!.listen(port, host, () => done(this.port())));
  }

  close(): Promise<void> {
    return new Promise((done) => (this.server ? this.server.close(() => done()) : done()));
  }
}

/** Названия ролей в снимке — как на карточке. Экспорт ради тестов. */
export const snapshotTitle = (pkg: AgentPackage, lang: 'ru' | 'en'): string => packageTitle(pkg, lang);
export const snapshotBrief = (pkg: AgentPackage, lang: 'ru' | 'en'): string => packageBrief(pkg, lang);
export const treeIntegrity = packageIntegrity;

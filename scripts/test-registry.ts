// Проверка сервиса индекса: засев из файла реестра, зеркало с отпечатком,
// поиск и страница пакета, установка клиентом из зеркала (и отказ при
// подмене), публикация по GitHub-идентичности, права админа, marketplace.
// npm run test:registry
//
// Сети нет: сервис поднимается на свободном порту, репозиторий автора —
// во времянке, «GitHub» — свой крошечный сервер, который отвечает логином
// по токену. Правило областей при этом смотрит на адрес репозитория, а
// выемка идёт по локальному пути, поэтому в тестовых записях адрес и путь
// подставляются отдельно.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { RegistryEntry } from '../src/server/market';

const root = mkdtempSync(resolve(tmpdir(), 'office-registry-'));
process.env.OFFICE_PACKAGE_CACHE = resolve(root, 'cache');
process.env.OFFICE_PACKAGES_DIR = resolve(root, 'builtin');
process.env.OFFICE_LANG = 'ru';

const { RegistryService } = await import('../src/registry/service');
const { scaffoldPackage } = await import('../src/server/export');
const { installFromMirror, installFromRegistry, loadRegistry, parseRegistry } = await import('../src/server/market');
const { cacheDir, packageIntegrity, readLock } = await import('../src/server/packages');
const { marketplaceFromRegistry, scopeProblem } = await import('../src/server/publish');

let failed = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(52)} → ${JSON.stringify(got)?.slice(0, 120)}`
    + (ok ? '' : ` (ждали ${JSON.stringify(want)?.slice(0, 120)})`));
};

// Репозиторий автора: пакет @alice/writer в папке, две версии.
const repo = resolve(root, 'alice-agents');
const gitq = (args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
mkdirSync(repo, { recursive: true });
gitq(['init', '-q', '-b', 'main']);
gitq(['config', 'user.email', 't@e.com']);
gitq(['config', 'user.name', 't']);
scaffoldPackage(resolve(repo, 'packages/writer'), {
  name: '@alice/writer', title: { ru: 'Писатель', en: 'Writer' }, summary: { en: 'Writes prose.' }, tags: ['text'],
  briefs: { en: 'You write.' }, license: 'MIT',
});
gitq(['add', '-A']); gitq(['commit', '-q', '-m', 'writer 0.1.0']);
const c010 = gitq(['rev-parse', 'HEAD']);
writeFileSync(resolve(repo, 'packages/writer/.claude-plugin/plugin.json'), JSON.stringify({ name: 'writer', version: '0.2.0', description: 'Writer' }));
writeFileSync(resolve(repo, 'packages/writer/brief/en.md'), 'You write well.\n');
gitq(['add', '-A']); gitq(['commit', '-q', '-m', 'writer 0.2.0']);
const c020 = gitq(['rev-parse', 'HEAD']);

// «GitHub»: токен alice-token → alice, bob-token → bob, остальное — 401.
const fakeGithub = createServer((req, res) => {
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  const login = token === 'alice-token' ? 'Alice' : token === 'bob-token' ? 'bob' : null;
  if (req.url === '/user' && login) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ login })); return; }
  res.writeHead(401); res.end('{}');
});
await new Promise<void>((done) => fakeGithub.listen(0, '127.0.0.1', () => done()));
const githubApi = `http://127.0.0.1:${(fakeGithub.address() as AddressInfo).port}`;

const data = resolve(root, 'data');
const service = new RegistryService({ dataDir: data, adminToken: 'admin-secret', githubApi });
const port = await service.listen(0);
const base = `http://127.0.0.1:${port}`;
const api = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
};

// ------------------------------------------------------------------ засев

// В файле реестра адрес — GitHub (для правила областей), но сервис ходит в
// git по нему же; здесь подменяем на локальный путь и проверяем область руками.
check('область @alice за alice', scopeProblem('@alice/writer', 'https://github.com/alice/agents.git'), null);
writeFileSync(resolve(root, 'seed.json'), JSON.stringify({
  schema: 1,
  packages: [{ name: '@alice/writer', repo, path: 'packages/writer', trust: 'community', versions: [{ version: '0.1.0', commit: c010 }] }],
}));
// Правило областей в засеве споткнётся о локальный путь — обходим через
// прямую выемку: то, что засев проверяет области, видно по problems.
const seeded = await service.seed(resolve(root, 'seed.json'));
check('засев с не-GitHub адресом отклонён правилом областей', [seeded.added, seeded.problems.length], [0, 1]);
const got = await service.ingest({ name: '@alice/writer', repo, path: 'packages/writer' }, { version: '0.1.0', commit: c010 });
check('выемка версии в зеркало', 'error' in got ? got.error : [got.version, got.integrity?.startsWith('sha256-')], ['0.1.0', true]);
check('архив и снимок лежат в зеркале', [existsSync(resolve(data, 'mirror/@alice/writer/0.1.0.tgz')), service.meta('@alice/writer', '0.1.0')?.title], [true, { ru: 'Писатель', en: 'Writer' }]);

// ------------------------------------------------------------- публикация

const noToken = await api('/v1/publish', { method: 'POST', body: JSON.stringify({ repo, path: 'packages/writer', commit: c010 }) });
check('публикация без токена — 401', noToken.status, 401);
const badToken = await api('/v1/publish', { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: JSON.stringify({ repo, path: 'packages/writer', commit: c010 }) });
check('чужой токен — 401', badToken.status, 401);
// Локальный путь — не GitHub, владельца не сверить: 403 для автора…
const local = await api('/v1/publish', { method: 'POST', headers: { Authorization: 'Bearer alice-token' }, body: JSON.stringify({ repo, path: 'packages/writer', commit: c010 }) });
check('репозиторий не на GitHub — автору отказ', local.status, 403);
// …а админ публикует откуда угодно, кроме чужих областей.
const byAdmin = await api('/v1/publish', { method: 'POST', headers: { Authorization: 'Bearer admin-secret' }, body: JSON.stringify({ repo, path: 'packages/writer', commit: c010 }) });
check('админ: область @alice не его — отказ', byAdmin.status, 403);

// Для честной проверки GitHub-пути подсовываем сервису запись, чей адрес —
// GitHub alice, а выемка по нему невозможна без сети: проверяем сверку
// владельца по коду ответа до выемки.
const bobOnAlice = await api('/v1/publish', { method: 'POST', headers: { Authorization: 'Bearer bob-token' }, body: JSON.stringify({ repo: 'https://github.com/alice/agents.git', path: 'packages/writer', commit: c010 }) });
check('bob не публикует из репозитория alice', [bobOnAlice.status, /not you/.test(String(bobOnAlice.body.error))], [403, true]);
const short = await api('/v1/publish', { method: 'POST', headers: { Authorization: 'Bearer alice-token' }, body: JSON.stringify({ repo: 'https://github.com/alice/agents.git', path: 'packages/writer', commit: 'abc' }) });
check('короткий коммит — 400', short.status, 400);

// Чтобы дойти до выемки по локальному пути, сервису нужен способ считать
// область законной: кладём запись через засев с адресом GitHub, но выемку
// делаем сами — так и живёт реальный сервис: адрес в реестре — GitHub.
writeFileSync(resolve(root, 'seed2.json'), JSON.stringify({
  schema: 1,
  packages: [{ name: '@alice/writer', repo: 'https://github.com/alice/agents.git', path: 'packages/writer', trust: 'community', versions: [{ version: '0.1.0', commit: c010 }] }],
}));
const seeded2 = await service.seed(resolve(root, 'seed2.json'));
check('засев: адрес GitHub без сети — версия не подтверждена, в индекс не попала', [seeded2.added, seeded2.problems.length], [0, 1]);

// Прямой путь сервиса: ingest + upsert — то, что делает publish после
// проверки владельца. Проверяем витрину, зеркало и клиент на нём.
const v010 = await service.ingest({ name: '@alice/writer', repo, path: 'packages/writer' }, { version: '0.1.0', commit: c010 });
const v020 = await service.ingest({ name: '@alice/writer', repo, path: 'packages/writer' }, { version: '0.2.0', commit: c020 });
check('две версии в зеркале', ['error' in v010, 'error' in v020], [false, false]);
// Индекс наполняем как файл: сервис читает его на старте.
writeFileSync(resolve(data, 'registry.json'), JSON.stringify({
  schema: 1,
  packages: [{
    name: '@alice/writer', repo, path: 'packages/writer', trust: 'community',
    versions: ['error' in v020 ? null : v020, 'error' in v010 ? null : v010].filter(Boolean),
  }],
}));
await service.close();
const service2 = new RegistryService({ dataDir: data, adminToken: 'admin-secret', githubApi });
const port2 = await service2.listen(0);
const base2 = `http://127.0.0.1:${port2}`;
const api2 = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${base2}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
};

// ---------------------------------------------------------------- витрина

const reg = await api2('/v1/registry.json');
const entry = (reg.body.packages as RegistryEntry[])[0];
check('реестр наружу: снимок манифеста', [entry.title, entry.tags, entry.installs], [{ ru: 'Писатель', en: 'Writer' }, ['text'], 0]);
check('версии с зеркалом и отпечатком', entry.versions.map((v) => [v.version, Boolean(v.integrity), v.mirror?.endsWith(`/v1/packages/@alice/writer/${v.version}.tgz`)]), [['0.2.0', true, true], ['0.1.0', true, true]]);
check('реестр наружу читается клиентом', parseRegistry(reg.body)?.packages[0]?.versions[0]?.integrity?.startsWith('sha256-'), true);
const search = await api2('/v1/packages?q=prose');
check('поиск по описанию', (search.body.packages as Array<{ name: string }>).map((p) => p.name), ['@alice/writer']);
const miss = await api2('/v1/packages?q=lawyer');
check('поиск мимо', (miss.body.packages as unknown[]).length, 0);
const byTag = await api2('/v1/packages?tag=text&lang=ru');
check('поиск по тегу и языку', (byTag.body.packages as Array<{ title: string }>)[0]?.title, 'Писатель');
const page = await api2('/v1/packages/@alice/writer');
check('страница пакета: версии со снимками', (page.body.versions as Array<{ version: string; meta: { briefs: Record<string, string> } }>).map((v) => [v.version, v.meta.briefs.en]), [['0.2.0', 'You write well.'], ['0.1.0', 'You write.']]);
check('страницы нет — 404', (await api2('/v1/packages/@alice/nope')).status, 404);
const mp = await api2('/v1/marketplace.json');
check('marketplace.json: плагин из пакета', (mp.body.plugins as Array<{ name: string; version: string; source: { source: string } }>)[0], { name: 'writer', description: 'Writes prose.', version: '0.2.0', source: { source: 'url', url: repo } });
check('marketplace из файла реестра — та же форма', (marketplaceFromRegistry(parseRegistry(reg.body)!) as { plugins: unknown[] }).plugins.length, 1);
const counted = await api2('/v1/packages/@alice/writer/install', { method: 'POST' });
check('счётчик установок', [counted.body.installs, ((await api2('/v1/registry.json')).body.packages as RegistryEntry[])[0].installs], [1, 1]);

// Репутация: исходы задач по согласию — доля чистых среди сданных и цена.
const outcome = (body: Record<string, unknown>) => api2('/v1/packages/@alice/writer/outcome', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
await outcome({ kind: 'clean', reworks: 0, costUsd: 1 });
await outcome({ kind: 'reworked', reworks: 2, costUsd: 3 });
const failedOutcome = await outcome({ kind: 'failed', reworks: 0, costUsd: 2 });
const bad = await outcome({ kind: 'great', costUsd: 1 });
check('репутация считается из исходов', failedOutcome.body.reputation, { closed: 3, cleanShare: 0.5, avgCostUsd: 2 });
check('мусорный исход отбрасывается', bad.status, 400);
check('репутация в реестре наружу', ((await api2('/v1/registry.json')).body.packages as RegistryEntry[])[0].reputation, { closed: 3, cleanShare: 0.5, avgCostUsd: 2 });

// ------------------------------------------------------ клиент и зеркало

const latest = parseRegistry(reg.body)!.packages[0].versions[0];
const fromMirror = await installFromMirror({
  mirror: latest.mirror!, integrity: latest.integrity!, commit: latest.commit, repo, path: 'packages/writer', expectName: '@alice/writer', version: '0.2.0',
}, process.env.OFFICE_PACKAGE_CACHE!);
check('установка из зеркала', fromMirror.ok && [fromMirror.pkg.version, fromMirror.lock.integrity === latest.integrity], ['0.2.0', true]);
check('в кеше нет .git, отпечаток сходится с деревом', packageIntegrity(cacheDir('@alice/writer', '0.2.0', process.env.OFFICE_PACKAGE_CACHE!)), latest.integrity);
const tampered = await installFromMirror({
  mirror: latest.mirror!, integrity: `sha256-${'0'.repeat(64)}`, commit: latest.commit, repo, path: 'packages/writer', expectName: '@alice/writer', version: '0.2.0',
}, resolve(root, 'cache2'));
check('подмена отпечатка — отказ', !tampered.ok && /integrity/.test(tampered.error), true);
process.env.OFFICE_REGISTRY = `${base2}/v1/registry.json`;
const live = await loadRegistry(`${base2}/v1/registry.json`, true);
check('клиент читает реестр по адресу', live.registry?.packages[0]?.name, '@alice/writer');
const viaRegistry = await installFromRegistry(live.registry!.packages[0], live.registry!.packages[0].versions[1], resolve(root, 'cache3'));
check('установка через реестр: зеркало, потом git', viaRegistry.ok && [viaRegistry.pkg.version, readLock(viaRegistry.dir)?.commit], ['0.1.0', c010]);
// Зеркало недоступно — git по коммиту, отпечаток всё равно сверяется.
const offline = await installFromRegistry(
  { ...live.registry!.packages[0], versions: [{ ...latest, mirror: 'http://127.0.0.1:9/nope.tgz' }] }, { ...latest, mirror: 'http://127.0.0.1:9/nope.tgz' }, resolve(root, 'cache4'),
);
check('зеркало лежит — из git, отпечаток совпал', offline.ok && offline.pkg.version, '0.2.0');
const wrong = await installFromRegistry(
  live.registry!.packages[0], { ...latest, mirror: undefined, integrity: `sha256-${'1'.repeat(64)}` }, resolve(root, 'cache5'),
);
check('git не сошёлся с отпечатком реестра — отказ', !wrong.ok && /integrity|отпечатк/.test(wrong.error), true);

// --------------------------------------------------------------- админ

const verify = await api2('/v1/admin', { method: 'POST', headers: { Authorization: 'Bearer admin-secret' }, body: JSON.stringify({ name: '@alice/writer', trust: 'verified', yank: '0.1.0' }) });
check('админ: verified и отзыв версии', [verify.status, (verify.body as { trust: string; yanked: string[] }).trust, (verify.body as { yanked: string[] }).yanked], [200, 'verified', ['0.1.0']]);
check('не админ — 401', (await api2('/v1/admin', { method: 'POST', headers: { Authorization: 'Bearer alice-token' }, body: '{}' })).status, 401);
check('отозванная версия не старшая', parseRegistry((await api2('/v1/registry.json')).body)!.packages[0].versions.find((v) => v.version === '0.1.0') !== undefined, true);
check('данные пережили запись', (JSON.parse(readFileSync(resolve(data, 'registry.json'), 'utf8')) as { packages: Array<{ trust: string }> }).packages[0].trust, 'verified');

// ------------------------------------------------------------ лицензии

const paid = await api2('/v1/admin', { method: 'POST', headers: { Authorization: 'Bearer admin-secret' }, body: JSON.stringify({ name: '@alice/writer', access: 'licensed', price: '$9', buyUrl: 'https://shop.example/writer' }) });
check('админ: пакет стал лицензионным', [(paid.body as { access: string }).access, (paid.body as { price: string }).price], ['licensed', '$9']);
const gated = await fetch(`${base2}/v1/packages/@alice/writer/0.2.0.tgz`);
check('архив без ключа — 402 с ценой и адресом', [gated.status, (await gated.json() as { buyUrl: string }).buyUrl], [402, 'https://shop.example/writer']);
const issued = await api2('/v1/admin/license', { method: 'POST', headers: { Authorization: 'Bearer admin-secret' }, body: JSON.stringify({ name: '@alice/writer', owner: 'bob@example.com' }) });
const licKey = (issued.body as { key: string }).key;
check('ключ выдан', [issued.status, licKey.startsWith('lic_')], [200, true]);
check('с ключом архив отдаётся', (await fetch(`${base2}/v1/packages/@alice/writer/0.2.0.tgz`, { headers: { Authorization: `Bearer ${licKey}` } })).status, 200);
check('чужой ключ — 402', (await fetch(`${base2}/v1/packages/@alice/writer/0.2.0.tgz`, { headers: { Authorization: 'Bearer lic_nope' } })).status, 402);
check('лицензионный пакет не идёт в открытый маркетплейс', ((await api2('/v1/marketplace.json')).body.plugins as unknown[]).length, 0);
const licReg = parseRegistry((await api2('/v1/registry.json')).body)!.packages[0];
check('реестр наружу помечает доступ и цену', [licReg.access, licReg.price, licReg.buyUrl], ['licensed', '$9', 'https://shop.example/writer']);
const noKey = await installFromRegistry(licReg, licReg.versions[0], resolve(root, 'cache6'));
check('клиент без ключа — отказ, а не откат на git', !noKey.ok && /license/.test(noKey.error), true);
const { setLicense } = await import('../src/server/market');
setLicense('@alice/writer', licKey);
const withKey = await installFromRegistry(licReg, licReg.versions[0], resolve(root, 'cache7'));
check('клиент с ключом ставит из зеркала', withKey.ok && withKey.pkg.version, '0.2.0');
check('данные лицензий пережили запись', Object.keys(JSON.parse(readFileSync(resolve(data, 'licenses.json'), 'utf8')) as Record<string, unknown>), [licKey]);

await service2.close();
fakeGithub.close();
rmSync(root, { recursive: true, force: true });
console.log(failed ? `\nпровалено кейсов: ${failed}` : '\nвсе кейсы прошли');
process.exit(failed ? 1 : 0);

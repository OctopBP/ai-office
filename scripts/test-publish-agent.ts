/**
 * «Опубликовать в маркет» для своего агента офиса (src/server/agentpublish.ts,
 * T-626): ошибки запроса и валидатора по полям, понятный отказ без GitHub и
 * без токена, публикация во ВРЕМЕННЫЙ реестр, найм из него и повторная
 * публикация с поднятой версией. Лицензия (T-628): по умолчанию MIT, пустая
 * или кривая — ошибка поля `package:license`, повтор берёт прошлую, пакет с
 * лицензией виден в списке реестра.
 *
 * Живой реестр и GitHub не трогаем: «GitHub» — голый репозиторий во
 * времянке, на который git переадресует `https://github.com/alice/agents.git`
 * (`url.<путь>.insteadOf` в своём глобальном конфиге git).
 *
 * Запуск: npm run test:publishagent
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { MyAgentOffice } from '../src/server/myagents';

const tmp = mkdtempSync(join(tmpdir(), 'office-publish-agent-'));
const remote = join(tmp, 'remote.git');
const GITHUB = 'https://github.com/alice/agents.git';
const gitconfig = join(tmp, 'gitconfig');
writeFileSync(gitconfig, [
  '[user]', '\tname = Test', '\temail = test@example.com',
  `[url "${remote}"]`, `\tinsteadOf = ${GITHUB}`,
  '[init]', '\tdefaultBranch = main',
  '[commit]', '\tgpgsign = false',
  '[tag]', '\tgpgsign = false', '',
].join('\n'));
// До импорта сервера: git офиса берёт окружение процесса.
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.OFFICE_LANG = 'ru';

const { publishMyAgent, stagePublication } = await import('../src/server/agentpublish');
const { createMyAgent, getMyAgent, handleMyAgentsHttp, updateMyAgent } = await import('../src/server/myagents');
const { installFromRegistry, latestVersion, loadRegistry, parseRegistry } = await import('../src/server/market');
const { readPackage, validatePackage } = await import('../src/server/packages');
const { getOffice } = await import('../src/server/state');
type MyAgentCtx = import('../src/server/myagents').MyAgentCtx;
type PublishEnv = import('../src/server/agentpublish').PublishEnv;
type FieldError = import('../src/shared/types').FieldError;

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();

// «GitHub» и рабочая копия репозитория владельца.
sh(tmp, 'init', '--quiet', '--bare', remote);
const work = join(tmp, 'work');
mkdirSync(work);
sh(work, 'init', '--quiet');
writeFileSync(join(work, 'README.md'), '# agents\n');
sh(work, 'add', 'README.md');
sh(work, 'commit', '--quiet', '-m', 'init');
sh(work, 'remote', 'add', 'origin', GITHUB);
sh(work, 'push', '--quiet', 'origin', 'main');

const state = getOffice('test-publish-agent');
state.setStateFile(join(tmp, 'o-test.json'));
const root = state.agentsDir();
const ctx: MyAgentCtx = { lang: 'ru', mcpIds: [], roles: [] };
const registryFile = join(tmp, 'registry.json');
const env: PublishEnv = { registry: registryFile, token: '', fetch: globalThis.fetch };
const fields = (errors: FieldError[]): string[] => errors.map((e) => e.field).sort();

const BRIEF = 'Ты геймдизайнер настольных игр: пишешь правила, считаешь баланс, готовишь карточки.';
const created = createMyAgent(root, { title: 'Геймдизайнер', brief: BRIEF }, ctx);
assert.ok(created.ok, JSON.stringify(created));
const id = created.agent.draft.id!;

console.log('публикация своего агента в маркет');

await check('новый агент не опубликован', () => {
  assert.equal(getMyAgent(root, id, ctx)!.published, null);
});

await check('ошибки запроса — по полям, до любых записей', async () => {
  const r = await publishMyAgent(root, id, { name: 'Alice/Agent', version: '1.0', repoDir: 'relative/dir', path: '../up' }, ctx, env);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 400);
  assert.deepEqual(fields(r.errors), ['name', 'path', 'repoDir', 'version']);
  assert.equal(existsSync(registryFile), false);
});

await check('@local и чужая область отклоняются полем name', async () => {
  for (const name of [`@local/${id}`, '@office/x', '@bob/x']) {
    const r = await publishMyAgent(root, id, { name, repoDir: work }, ctx, env);
    assert.ok(!r.ok && fields(r.errors).includes('name'), `${name}: ${JSON.stringify(r)}`);
  }
});

await check('origin не на GitHub — понятная ошибка про GitHub', async () => {
  const local = join(tmp, 'local');
  mkdirSync(local);
  sh(local, 'init', '--quiet');
  sh(local, 'remote', 'add', 'origin', remote);
  const r = await publishMyAgent(root, id, { name: '@alice/x', repoDir: local }, ctx, env);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.deepEqual(fields(r.errors), ['repoDir']);
  assert.match(r.errors[0].message, /GitHub/);
});

await check('сервис индекса без токена — ошибка поля token, без пуша', async () => {
  const before = sh(remote, 'rev-parse', 'main');
  const r = await publishMyAgent(root, id, { name: '@alice/x', repoDir: work }, ctx, {
    ...env, registry: 'https://registry.example/v1/registry.json',
    fetch: (() => { throw new Error('сеть в проверке не нужна'); }) as unknown as typeof fetch,
  });
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.deepEqual(fields(r.errors), ['token']);
  assert.match(r.errors[0].message, /GITHUB_TOKEN/);
  assert.equal(sh(remote, 'rev-parse', 'main'), before);
});

await check('реестр по адресу, но не сервис — только на чтение', async () => {
  const r = await publishMyAgent(root, id, { name: '@alice/x', repoDir: work, token: 't' }, ctx, { ...env, registry: 'https://example.com/registry.json' });
  assert.ok(!r.ok && fields(r.errors).includes('registry'));
});

await check('валидатор: битый пакет — ошибки по полям package:*', () => {
  const bad = join(tmp, 'bad-src');
  mkdirSync(join(bad, '.claude-plugin'), { recursive: true });
  writeFileSync(join(bad, 'agent.json'), JSON.stringify({ schema: 1, name: '@local/bad', kind: 'agent', title: { ru: 'x' } }));
  writeFileSync(join(bad, '.claude-plugin/plugin.json'), '{ не json');
  const out = join(tmp, 'bad-out');
  const { errors } = stagePublication(bad, '@alice/bad', '1.0.0', out);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((e) => e.field.startsWith('package:')), JSON.stringify(errors));
  // Годный пакет агента проходит под новым именем, файл офиса в него не попадает.
  const good = join(tmp, 'good-out');
  const ok = stagePublication(getMyAgent(root, id, ctx)!.dir, '@alice/gamer', '2.0.0', good);
  assert.deepEqual(ok.errors, []);
  const { pkg } = readPackage(good);
  assert.equal(pkg?.name, '@alice/gamer');
  assert.equal(pkg?.version, '2.0.0');
  assert.equal(pkg?.manifest.license, 'MIT');
  assert.equal(JSON.parse(readFileSync(join(good, '.claude-plugin/plugin.json'), 'utf8')).license, 'MIT');
  // Своя лицензия ложится в манифест как есть.
  const apache = join(tmp, 'apache-out');
  stagePublication(getMyAgent(root, id, ctx)!.dir, '@alice/gamer', '2.0.0', apache, 'Apache-2.0');
  assert.equal(readPackage(apache).pkg?.manifest.license, 'Apache-2.0');
  assert.equal(existsSync(join(good, '.office-local.json')), false);
});

await check('пакет без лицензии — ошибка package:license, а не предупреждение', () => {
  const src = join(tmp, 'nolicense-src');
  mkdirSync(join(src, '.claude-plugin'), { recursive: true });
  writeFileSync(join(src, 'agent.json'), JSON.stringify({ schema: 1, name: '@local/x', kind: 'agent', title: { ru: 'x' } }));
  writeFileSync(join(src, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'x', version: '0.1.0' }));
  const { errors, warnings } = stagePublication(src, '@alice/x', '1.0.0', join(tmp, 'nolicense-out'), '');
  assert.ok(fields(errors).includes('package:license'), JSON.stringify(errors));
  assert.ok(!fields(warnings).includes('package:license'));
});

await check('пустая или кривая лицензия — ошибка поля package:license, до любых записей', async () => {
  const before = sh(remote, 'rev-parse', 'main');
  for (const license of ['', '   ', 'MIT; rm -rf', 'не лицензия', 'MIT OR', 'x'.repeat(101)]) {
    const r = await publishMyAgent(root, id, { name: '@alice/x', repoDir: work, license }, ctx, env);
    assert.ok(!r.ok, license);
    if (r.ok) return;
    assert.equal(r.code, 400);
    assert.deepEqual(fields(r.errors), ['package:license'], `${license}: ${JSON.stringify(r.errors)}`);
  }
  assert.equal(sh(remote, 'rev-parse', 'main'), before);
  assert.equal(existsSync(registryFile), false);
});

const NAME = '@alice/boardgame-designer';

await check('публикация: коммит и тег на «GitHub», запись в реестре, связь у агента', async () => {
  const r = await publishMyAgent(root, id, { name: NAME, version: '1.0.0', repoDir: work }, ctx, env);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.published.name, NAME);
  assert.equal(r.published.version, '1.0.0');
  assert.equal(r.published.path, 'agents/boardgame-designer');
  assert.equal(r.published.repo, GITHUB);
  assert.equal(r.published.license, 'MIT');
  assert.ok(!r.warnings.some((w) => w.field === 'package:license'), JSON.stringify(r.warnings));
  // Коммит и тег — на удалённом, а не только в рабочей копии.
  assert.equal(sh(remote, 'rev-parse', 'main'), r.published.commit);
  assert.equal(sh(remote, 'rev-parse', 'boardgame-designer@1.0.0^{commit}'), r.published.commit);
  const registry = parseRegistry(JSON.parse(readFileSync(registryFile, 'utf8')))!;
  const entry = registry.packages.find((e) => e.name === NAME)!;
  assert.equal(entry.repo, GITHUB);
  assert.equal(latestVersion(entry)!.commit, r.published.commit);
  // Связь с исходным агентом офиса.
  const view = getMyAgent(root, id, ctx)!;
  assert.equal(view.name, `@local/${id}`);
  assert.deepEqual({ name: view.published?.name, version: view.published?.version }, { name: NAME, version: '1.0.0' });
  assert.equal(view.published?.license, 'MIT');
});

await check('пакет с лицензией виден в списке реестра', async () => {
  const { registry, error } = await loadRegistry(registryFile, true);
  assert.equal(error, null);
  const entry = registry?.packages.find((e) => e.name === NAME);
  assert.ok(entry, JSON.stringify(registry));
  assert.equal(latestVersion(entry)!.version, '1.0.0');
  // В опубликованном коммите манифест с лицензией, валидатор о ней молчит.
  const manifest = JSON.parse(sh(work, 'show', `${entry.versions[0].commit}:agents/boardgame-designer/agent.json`));
  assert.equal(manifest.license, 'MIT');
  const checkout = join(tmp, 'checkout');
  execFileSync('git', ['clone', '--quiet', GITHUB, checkout], { env: process.env });
  const problems = validatePackage(join(checkout, 'agents/boardgame-designer'));
  assert.ok(!problems.some((p) => p.path === 'license'), JSON.stringify(problems));
  assert.ok(!problems.some((p) => p.level === 'error'), JSON.stringify(problems));
});

await check('другой офис нанимает из реестра: пакет ставится по коммиту', async () => {
  const registry = parseRegistry(JSON.parse(readFileSync(registryFile, 'utf8')))!;
  const entry = registry.packages.find((e) => e.name === NAME)!;
  const cache = join(tmp, 'cache');
  const made = await installFromRegistry(entry, latestVersion(entry)!, cache, 'ru');
  assert.ok(made.ok, JSON.stringify(made));
  if (!made.ok) return;
  assert.equal(made.pkg.name, NAME);
  assert.equal(made.pkg.version, '1.0.0');
  assert.equal(made.pkg.manifest.license, 'MIT');
  assert.match(made.pkg.briefs.ru ?? '', /геймдизайнер/);
});

await check('правка агента не теряет связь с публикацией', () => {
  const r = updateMyAgent(root, id, { summary: 'Правила и баланс настольных игр' }, ctx);
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) assert.equal(r.agent.published?.version, '1.0.0');
});

await check('та же или старая версия — ошибка поля version', async () => {
  const r = await publishMyAgent(root, id, { name: NAME, version: '1.0.0', repoDir: work }, ctx, env);
  assert.ok(!r.ok && fields(r.errors).includes('version'));
});

await check('повторная публикация без версии поднимает её, лицензию можно сменить', async () => {
  const r = await publishMyAgent(root, id, { name: NAME, repoDir: work, license: 'Apache-2.0' }, ctx, env);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.published.version, '1.0.1');
  assert.equal(r.published.license, 'Apache-2.0');
  const registry = parseRegistry(JSON.parse(readFileSync(registryFile, 'utf8')))!;
  const entry = registry.packages.find((e) => e.name === NAME)!;
  assert.deepEqual(entry.versions.map((v) => v.version), ['1.0.1', '1.0.0']);
  assert.equal(getMyAgent(root, id, ctx)!.published?.version, '1.0.1');
});

await check('повтор без лицензии берёт лицензию прошлой публикации', async () => {
  const r = await publishMyAgent(root, id, { name: NAME, repoDir: work }, ctx, env);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.published.version, '1.0.2');
  assert.equal(r.published.license, 'Apache-2.0');
  assert.equal(getMyAgent(root, id, ctx)!.published?.license, 'Apache-2.0');
  const manifest = JSON.parse(sh(work, 'show', `${r.published.commit}:agents/boardgame-designer/agent.json`));
  assert.equal(manifest.license, 'Apache-2.0');
});

await check('пуш не прошёл — понятная ошибка, реестр не тронут', async () => {
  const before = readFileSync(registryFile, 'utf8');
  rmSync(remote, { recursive: true, force: true });
  const r = await publishMyAgent(root, id, { name: NAME, repoDir: work }, ctx, env);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.deepEqual(fields(r.errors), ['repoDir']);
  assert.match(r.errors[0].message, /запушить/);
  assert.equal(readFileSync(registryFile, 'utf8'), before);
  assert.equal(getMyAgent(root, id, ctx)!.published?.version, '1.0.2');
});

await check('HTTP: POST /api/my-agents/<id>/publish отвечает ошибками по полям', async () => {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  req.method = 'POST';
  let code = 0;
  let text = '';
  const done = new Promise<void>((ok) => {
    const res = {
      headersSent: false,
      writeHead(c: number) { code = c; res.headersSent = true; return res; },
      end(s: string) { text = s; ok(); },
    };
    handleMyAgentsHttp(req, res as unknown as ServerResponse, `/api/my-agents/${id}/publish`, '', {
      // Публикация офис не трогает: найм и правка копий тут не нужны.
      office: () => ({ root, ctx, role: () => undefined, office: {} as MyAgentOffice }),
      publish: () => env,
    });
  });
  req.end(JSON.stringify({ name: 'плохое', repoDir: work }));
  await done;
  assert.equal(code, 400);
  assert.deepEqual(fields(JSON.parse(text).errors), ['name']);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} проверок прошло`);

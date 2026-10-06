/**
 * Ключи провайдеров не доезжают до команд агента (T-200), а переменные офиса
 * хранятся только в связке ключей и наружу отдают лишь метаданные (T-301).
 *
 * Сервер держит ключи в окружении ради движка, а Bash агента, проверки гейта
 * и git получают окружение без них. Проверяем три пути: `projectEnv` для
 * проверок и git; движок Claude Code — поддельный исполняемый файл получает
 * env так, как его получил бы настоящий, и запускает команду так, как это
 * делает Bash-инструмент (содержимое `CLAUDE_ENV_FILE` перед командой);
 * Bash движка Codex — команда, которую инструмент офиса отдаёт app-server.
 *
 *   npm run test:secrets
 */
import './_isolate';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PROVIDER_SECRET_VARS, engineEnv, projectEnv } from '../src/server/childenv';

const DECOY = 'office-decoy-secret';
for (const name of PROVIDER_SECRET_VARS) process.env[name] = `${DECOY}-${name}`;

/** Ключи из списка, которые нашлись в выводе `env`. */
const leaked = (envOutput: string): string[] =>
  PROVIDER_SECRET_VARS.filter((name) => envOutput.includes(`${name}=`) || envOutput.includes(`${DECOY}-${name}`));

let failed = 0;
const check = (name: string, fn: () => unknown | Promise<unknown>) =>
  Promise.resolve().then(fn).then(
    () => console.log(`ok   ${name}`),
    (e) => { failed++; console.log(`FAIL ${name}\n     ${e instanceof Error ? e.message : e}`); },
  );

const dir = mkdtempSync(resolve(tmpdir(), 'office-secrets-'));

await check('projectEnv без ключей провайдеров', () => {
  const env = projectEnv();
  for (const name of PROVIDER_SECRET_VARS) assert.equal(env[name], undefined, name);
});

await check('projectEnv снимает ключ, даже переданный явно', () => {
  assert.equal(projectEnv({ OPENAI_API_KEY: 'x' }).OPENAI_API_KEY, undefined);
});

await check('команда проверки гейта не видит ключей', () => {
  const out = execFileSync('/usr/bin/env', [], { env: projectEnv(), encoding: 'utf8' });
  assert.deepEqual(leaked(out), []);
});

await check('движку ключ по-прежнему доходит', () => {
  const env = engineEnv();
  assert.equal(env.ANTHROPIC_API_KEY, `${DECOY}-ANTHROPIC_API_KEY`);
  assert.equal(env.OPENAI_API_KEY, `${DECOY}-OPENAI_API_KEY`);
});

// Поддельный движок Claude Code: сохраняет своё окружение и выполняет `env`
// так, как Bash-инструмент выполняет команду, — с файлом окружения впереди.
const engineDump = resolve(dir, 'engine.env');
const bashDump = resolve(dir, 'bash.env');
const fakeClaude = resolve(dir, 'claude');
writeFileSync(fakeClaude, `#!/bin/bash
/usr/bin/env > '${engineDump}'
prelude="$(cat "$CLAUDE_ENV_FILE")"
/bin/bash -c "$prelude
/usr/bin/env" > '${bashDump}'
exit 1
`, { mode: 0o755 });
process.env.OFFICE_CLAUDE_BIN = fakeClaude;

await check('Bash движка Claude Code не видит ключей, сам движок видит', async () => {
  const { startSession: query } = await import('../src/server/engines');
  try {
    for await (const _ of query({ prompt: 'env', options: { cwd: dir, provider: 'claude-code' } })) { /* поддельный движок молчит */ }
  } catch { /* выход с ошибкой — ожидаем */ }
  const engine = readFileSync(engineDump, 'utf8');
  assert(engine.includes(`ANTHROPIC_API_KEY=${DECOY}-ANTHROPIC_API_KEY`), 'движок остался без ключа');
  assert.match(engine, /^CLAUDE_ENV_FILE=/m, 'движку не передан файл окружения');
  assert.deepEqual(leaked(readFileSync(bashDump, 'utf8')), []);
});

await check('Bash движка Codex не видит ключей', async () => {
  const { codexTools } = await import('../src/server/providers/codex-tools');
  let command: string[] = [];
  const rpc = { request: async (_method: string, params: { command: string[] }) => {
    command = params.command;
    return { stdout: '', stderr: '', exitCode: 0 };
  } };
  const catalog = await codexTools({ cwd: dir, tools: ['Bash'] }, rpc as never);
  await catalog.tools.find((t) => t.name === 'Bash')!.run({ command: '/usr/bin/env' });
  // app-server исполняет команду со своим окружением — а в нём ключи есть.
  const out = execFileSync(command[0], command.slice(1), { env: engineEnv(), encoding: 'utf8' });
  assert.deepEqual(leaked(out), []);
});

await check('вход по подписке не видит ключей провайдеров', async () => {
  const loginDump = resolve(dir, 'login.env');
  const fakeLogin = resolve(dir, 'claude-login');
  writeFileSync(fakeLogin, `#!/bin/bash\n/usr/bin/env > '${loginDump}'\n`, { mode: 0o755 });
  process.env.OFFICE_CLAUDE_BIN = fakeLogin;
  const { forgetClaudeBin } = await import('../src/server/engines/claude-code');
  const { onLoginFlow } = await import('../src/server/engines/login');
  forgetClaudeBin();
  const { engineFor } = await import('../src/server/engines');
  const done = new Promise<void>((ok) => {
    const off = onLoginFlow((_, flow) => { if (flow.phase !== 'starting' && flow.phase !== 'waiting') { off(); ok(); } });
  });
  await engineFor('claude-code').login({ provider: 'claude-code', kind: 'subscription' });
  await done;
  assert.deepEqual(leaked(readFileSync(loginDump, 'utf8')), []);
});

// ---------- переменные офиса (secrets.ts, T-301) ----------
// Связка ключей подменена хранилищем в памяти: настоящий Keychain не трогаем.

const { memoryKeychain } = await import('../src/server/engines/keys');
const secrets = await import('../src/server/secrets');
const { getOffice } = await import('../src/server/state');
const mem = memoryKeychain();
secrets.useSecretStore(mem);
const OFFICE = 'secrets-test';
const P8 = `-----BEGIN PRIVATE KEY-----\n${'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg'.repeat(4)}\n${'x'.repeat(48)}\n-----END PRIVATE KEY-----`;

const rejects = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof secrets.SecretError && e.code === code && e.message.length > 0);
};

await check('имена: годные проходят, кривые отклоняются', async () => {
  for (const ok of ['DEPLOY_TOKEN', '_X', 'A', `A${'B'.repeat(63)}`, 'APP_STORE_KEY_P8']) assert.equal(secrets.checkSecretName(ok), ok);
  for (const bad of ['', 'lower', '1ABC', 'A-B', 'A B', `A${'B'.repeat(64)}`, 'ПУТЬ', 42]) {
    assert.throws(() => secrets.checkSecretName(bad), (e: unknown) => (e as { code?: string }).code === 'bad-name', String(bad));
  }
});

await check('зарезервированные имена отклоняются', async () => {
  for (const name of ['PATH', 'HOME', 'SHELL', 'USER', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OFFICE_STATE_FILE', 'ANTHROPIC_BASE_URL']) {
    await rejects(secrets.setSecret(OFFICE, name, 'value-1234'), 'reserved');
  }
});

await check('значение: пустое и длиннее 32 КБ отклоняются, .p8 проходит', async () => {
  await rejects(secrets.setSecret(OFFICE, 'EMPTY', ''), 'bad-value');
  await rejects(secrets.setSecret(OFFICE, 'EMPTY', '  \n '), 'bad-value');
  await rejects(secrets.setSecret(OFFICE, 'HUGE', 'x'.repeat(32 * 1024 + 1)), 'bad-value');
  await secrets.setSecret(OFFICE, 'MAX_SIZE', 'я'.repeat(16 * 1024));
  await secrets.setSecret(OFFICE, 'ASC_KEY_P8', P8);
  assert.equal((await secrets.secretsEnv(OFFICE)).MAX_SIZE, 'я'.repeat(16 * 1024));
  await secrets.deleteSecret(OFFICE, 'MAX_SIZE');
});

await check('list отдаёт только имя и даты, без значений', async () => {
  await secrets.setSecret(OFFICE, 'DEPLOY_TOKEN', 'tok-very-secret-1');
  const list = secrets.listSecrets(OFFICE);
  assert.deepEqual(list.map((m) => m.name), ['ASC_KEY_P8', 'DEPLOY_TOKEN']);
  for (const meta of list) {
    assert.deepEqual(Object.keys(meta).sort(), ['createdAt', 'name', 'updatedAt']);
    assert.ok(meta.createdAt > 0 && meta.updatedAt >= meta.createdAt);
  }
  assert.ok(!JSON.stringify(list).includes('tok-very-secret-1'));
});

await check('замена меняет updatedAt, а не createdAt', async () => {
  const before = secrets.listSecrets(OFFICE).find((m) => m.name === 'DEPLOY_TOKEN')!;
  await new Promise((r) => setTimeout(r, 5));
  await secrets.setSecret(OFFICE, 'DEPLOY_TOKEN', 'tok-very-secret-2');
  const after = secrets.listSecrets(OFFICE).find((m) => m.name === 'DEPLOY_TOKEN')!;
  assert.equal(after.createdAt, before.createdAt);
  assert.ok(after.updatedAt > before.updatedAt);
  assert.equal((await secrets.secretsEnv(OFFICE)).DEPLOY_TOKEN, 'tok-very-secret-2');
});

await check('состояние офиса и его снимок для state.json без значений', async () => {
  const persisted = JSON.stringify(getOffice(OFFICE).toPersisted());
  assert.ok(persisted.includes('DEPLOY_TOKEN'), 'метаданных нет в снимке');
  for (const leak of ['tok-very-secret', 'MIGTAgEAMBMG', 'BEGIN PRIVATE KEY']) assert.ok(!persisted.includes(leak), leak);
});

await check('значения лежат только в связке, с привязкой к офису', async () => {
  await secrets.setSecret('other-office', 'DEPLOY_TOKEN', 'other-value-9');
  assert.equal((await secrets.secretsEnv(OFFICE)).DEPLOY_TOKEN, 'tok-very-secret-2');
  assert.deepEqual(await secrets.secretsEnv('other-office'), { DEPLOY_TOKEN: 'other-value-9' });
  assert.ok(await mem.get('office:other-office:env:DEPLOY_TOKEN:0'));
});

await check('secretsEnv собирает длинное значение из кусков', async () => {
  assert.equal((await secrets.secretsEnv(OFFICE)).ASC_KEY_P8, P8);
  const big = 'Q'.repeat(20_000);
  await secrets.setSecret(OFFICE, 'BIG', big);
  assert.equal((await secrets.secretsEnv(OFFICE)).BIG, big);
  await secrets.setSecret(OFFICE, 'BIG', 'short-one');
  assert.equal(await mem.get('office:secrets-test:env:BIG:1'), null, 'остался хвост старого значения');
  await secrets.deleteSecret(OFFICE, 'BIG');
  assert.equal(await mem.get('office:secrets-test:env:BIG:0'), null);
  assert.ok(!secrets.listSecrets(OFFICE).some((m) => m.name === 'BIG'));
});

await check('mask заменяет значения на ***', async () => {
  const lines = P8.split('\n');
  const out = await secrets.maskSecrets(OFFICE,
    `token=tok-very-secret-2; key:\n${P8}\npart: ${lines[1]}\nok on`);
  assert.ok(!out.includes('tok-very-secret-2'));
  assert.ok(!out.includes('MIGTAgEAMBMG'));
  assert.ok(out.includes('token=***'));
  assert.ok(out.endsWith('ok on'), 'короткое не должно маскироваться');
  assert.equal(secrets.maskValues('a abc abcd', ['abc', 'abcd']), 'a abc ***');
});

await check('недоступная связка — понятная ошибка, не падение и не файл', async () => {
  secrets.useSecretStore({
    available: async () => false,
    get: async () => { throw new Error('не должно вызываться'); },
    set: async () => { throw new Error('не должно вызываться'); },
    delete: async () => { throw new Error('не должно вызываться'); },
  });
  await rejects(secrets.setSecret(OFFICE, 'NEW_ONE', 'value-1234'), 'keychain');
  await rejects(secrets.secretsEnv(OFFICE), 'keychain');
  assert.ok(!secrets.listSecrets(OFFICE).some((m) => m.name === 'NEW_ONE'));
  secrets.useSecretStore(mem);
});

if (failed) {
  console.log(`\n${failed} провал(ов)`);
  process.exit(1);
}
console.log('\nвсе проверки прошли');

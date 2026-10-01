/**
 * Ключи провайдеров не доезжают до команд агента (T-200).
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
    for await (const _ of query({ prompt: 'env', options: { cwd: dir } })) { /* поддельный движок молчит */ }
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

if (failed) {
  console.log(`\n${failed} провал(ов)`);
  process.exit(1);
}
console.log('\nвсе проверки прошли');

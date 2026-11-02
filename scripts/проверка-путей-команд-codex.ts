import assert from 'node:assert/strict';
import { codexTools } from '../src/server/providers/codex-tools';
import { sandboxFor } from '../src/server/sandbox';
import { песочницаКомандCodex } from '../src/server/providers/codex-sandbox';
import type { CodexRpc } from '../src/server/providers/rpc';

const папка = '/office/worktree';
const одобренныйПуть = '/Applications';
const роль = {
  capabilities: [], isolate: true, isManager: false, tools: ['Bash'],
  writePaths: [одобренныйПуть, папка], allowedHosts: ['traictory.com'],
};
const запросы: Array<{ метод: string; параметры: any }> = [];
const rpc = {
  async request(метод: string, параметры: unknown) {
    запросы.push({ метод, параметры });
    return { stdout: '', stderr: '', exitCode: 0 };
  },
} as unknown as CodexRpc;

// Проверяем весь участок sandboxFor → каталог Bash → параметры command/exec.
// Команды и сеть не запускаются, данные владельца не читаются.
for (const сПравами of [false, true]) {
  const параметры = {
    cwd: папка, tools: ['Bash'],
    sandbox: sandboxFor(сПравами ? роль : { ...роль, writePaths: [], allowedHosts: [] }, папка),
  };
  const профиль = песочницаКомандCodex(параметры);
  if (сПравами) {
    assert.deepEqual(профиль.аргументы, ['-c', 'default_permissions=":read-only"', '-c',
      'permissions.office-command={extends=":workspace",workspace_roots=["/office/worktree","/Applications"],network={mode="limited",domains={"traictory.com"="allow"}}}']);
  } else {
    assert.deepEqual(профиль.аргументы, []);
  }
  const каталог = await codexTools(параметры, rpc);
  try {
    await каталог.tools.find(инструмент => инструмент.name === 'Bash')!.run({ command: 'true' });
  } finally {
    await каталог.close();
  }
  const запрос = запросы.at(-1)!;
  assert.equal(запрос.метод, 'command/exec');
  if (сПравами) {
    assert.equal(запрос.параметры.permissionProfile, 'office-command');
    assert.equal(запрос.параметры.sandboxPolicy, undefined,
      'Legacy-политика не должна перекрывать ограниченный сетевой профиль');
  } else {
    assert.deepEqual(запрос.параметры.sandboxPolicy.writableRoots, [папка]);
    assert.equal(запрос.параметры.sandboxPolicy.networkAccess, false);
    assert.equal(запрос.параметры.permissionProfile, undefined);
  }
}
assert.equal(запросы.length, 2);
console.log('Передача профиля команд Codex проверена: одобренный домен выбирает профиль, без домена сеть закрыта.');

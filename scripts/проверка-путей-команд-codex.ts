import assert from 'node:assert/strict';
import { codexTools } from '../src/server/providers/codex-tools';
import { sandboxFor } from '../src/server/sandbox';
import type { CodexRpc } from '../src/server/providers/rpc';

const папка = '/office/worktree';
const одобренныйПуть = '/Applications';
const роль = {
  capabilities: [], isolate: true, isManager: false, tools: ['Bash'],
  writePaths: [одобренныйПуть, папка], allowedHosts: ['registry.npmjs.org'],
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
  const каталог = await codexTools({
    cwd: папка, tools: ['Bash'],
    sandbox: sandboxFor(сПравами ? роль : { ...роль, writePaths: [], allowedHosts: [] }, папка),
  }, rpc);
  try {
    await каталог.tools.find(инструмент => инструмент.name === 'Bash')!.run({ command: 'true' });
  } finally {
    await каталог.close();
  }
  const запрос = запросы.at(-1)!;
  assert.equal(запрос.метод, 'command/exec');
  assert.deepEqual(запрос.параметры.sandboxPolicy.writableRoots,
    сПравами ? [папка, одобренныйПуть] : [папка]);
  assert.equal(запрос.параметры.sandboxPolicy.networkAccess, false,
    'Сеть исправляет отдельная T-737: файловое разрешение не открывает её целиком');
  assert.equal(запрос.параметры.sandboxPolicy.writableRoots.includes('/неодобренный'), false);
}
assert.equal(запросы.length, 2);
console.log('Передача одобренных путей команд Codex проверена; неодобренные пути и сеть закрыты.');

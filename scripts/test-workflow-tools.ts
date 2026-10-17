/**
 * Инструменты менеджера для процессов офиса (src/server/workflow-tools.ts):
 * list_workflows, edit_workflow, reset_workflow — обработчики зовутся
 * напрямую, без сессии, без токенов и без сервера.
 *
 * Сценарий владельца «убери ревью из процесса кода»: edit_workflow выключает
 * узел review, list_workflows показывает его выключенным (и доработку —
 * выпавшей), запрещённая правка слияния отвергается понятным текстом,
 * reset_workflow возвращает базу. И что промпт менеджера про это говорит.
 *
 * Запуск: npm run test:workflow-tools
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import assert from 'node:assert/strict';
import { getOffice } from '../src/server/state';
import { workflowTools } from '../src/server/workflow-tools';
import { effectiveWorkflowById, overridesOf } from '../src/server/workflow-overrides';
import { pmPrompt } from '../src/server/agents';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

type Result = { content: { type: string; text: string }[]; isError?: boolean };
type Tool = { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<Result> };

const state = getOffice('test-workflow-tools');
const tools = new Map((workflowTools(state) as unknown as Tool[]).map((t) => [t.name, t]));
async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const t = tools.get(name);
  assert.ok(t, `нет инструмента ${name}`);
  return t.handler(args, {});
}
const textOf = (r: Result) => r.content.map((c) => c.text).join('\n');
/** Строка узла процесса feature в выводе list_workflows. */
function nodeLine(list: string, node: string): string {
  const block = list.split('\n\n').find((b) => b.startsWith('feature —'));
  assert.ok(block, `нет процесса feature в выводе:\n${list}`);
  const line = block.split('\n').find((l) => new RegExp(`^\\s+\\d+\\. ${node}\\b`).test(l));
  assert.ok(line, `нет узла ${node} в процессе feature:\n${block}`);
  return line;
}

await check('у менеджера три инструмента процессов', () => {
  assert.deepEqual([...tools.keys()].sort(), ['edit_workflow', 'list_workflows', 'reset_workflow']);
});

await check('list_workflows: процесс кода, для каких задач, обязательные узлы, правок нет', async () => {
  const r = await call('list_workflows');
  assert.ok(!r.isError);
  const list = textOf(r);
  assert.match(list, /^feature — Процесс кода \(встроенный\)\. Для: на сданную задачу, тип code\. Правки офиса: нет\./m);
  assert.match(nodeLine(list, 'merge'), /обязательный/);
  assert.match(nodeLine(list, 'checks'), /обязательный/);
  assert.doesNotMatch(nodeLine(list, 'review'), /выключен/);
});

await check('«убери ревью из процесса кода» → edit_workflow выключает review', async () => {
  const r = await call('edit_workflow', {
    workflowId: 'feature',
    changes: [{ node: 'review', action: 'disable' }],
    reason: 'владелец в чате: «убери ревью из процесса кода»',
  });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /узел «review» выключен/);
  const rules = overridesOf(state, 'feature').rules;
  assert.deepEqual(rules, [{ node: 'review' }]);
  assert.equal(overridesOf(state, 'feature').history.at(-1)?.by, 'pm#1');
  const wf = effectiveWorkflowById(state, 'feature');
  assert.ok(wf && !wf.nodes.some((n) => n.id === 'review'), 'review остался в действующем процессе');
});

await check('повтор list_workflows показывает review выключенным, rework — выпавшим', async () => {
  const list = textOf(await call('list_workflows'));
  assert.match(list, /^feature — .*Правки офиса: есть, ревизия 1\./m);
  assert.match(nodeLine(list, 'review'), /выключен \(всегда\)/);
  assert.match(nodeLine(list, 'rework'), /выпадает/);
  assert.match(nodeLine(list, 'merge'), /обязательный/);
});

await check('выключить слияние нельзя: понятная ошибка, правки не тронуты', async () => {
  const r = await call('edit_workflow', {
    workflowId: 'feature', changes: [{ node: 'merge', action: 'disable' }], reason: 'проверка',
  });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Правка процесса не принята: .*обязательный — слияние и гейт с проверками выключить нельзя/);
  assert.deepEqual(overridesOf(state, 'feature').rules, [{ node: 'review' }]);
});

await check('набор с запрещённой правкой не применяется даже частично', async () => {
  const r = await call('edit_workflow', {
    workflowId: 'feature',
    changes: [{ node: 'open-pr', action: 'disable' }, { node: 'recheck', action: 'disable' }],
    reason: 'проверка',
  });
  assert.equal(r.isError, true);
  assert.deepEqual(overridesOf(state, 'feature').rules, [{ node: 'review' }]);
});

await check('неизвестный узел и неизвестный тип задачи — ошибка с подсказкой', async () => {
  const noNode = await call('edit_workflow', {
    workflowId: 'feature', changes: [{ node: 'ревью', action: 'disable' }], reason: 'проверка',
  });
  assert.equal(noNode.isError, true);
  assert.match(textOf(noNode), /нет узла «ревью»; есть: sync/);
  const badType = await call('edit_workflow', {
    workflowId: 'feature', changes: [{ node: 'review', action: 'disable', when: { types: ['кот'] } }], reason: 'проверка',
  });
  assert.equal(badType.isError, true);
  assert.match(textOf(badType), /неизвестный тип задачи: кот/);
  const noWf = await call('edit_workflow', {
    workflowId: 'нет-такого', changes: [{ node: 'review', action: 'disable' }], reason: 'проверка',
  });
  assert.equal(noWf.isError, true);
  assert.match(textOf(noWf), /процесса «нет-такого» нет/);
});

await check('условный пропуск виден в list_workflows', async () => {
  const r = await call('edit_workflow', {
    workflowId: 'feature',
    changes: [{ node: 'review', action: 'disable', when: { roles: ['backend'] } }],
    reason: 'владелец: бэкенду без ревью',
  });
  assert.ok(!r.isError, textOf(r));
  assert.match(nodeLine(textOf(await call('list_workflows')), 'review'), /пропуск при условии: роль: backend/);
});

await check('reset_workflow возвращает базовый процесс', async () => {
  const r = await call('reset_workflow', { workflowId: 'feature', reason: 'владелец: верни ревью' });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /процесс снова базовый/);
  assert.deepEqual(overridesOf(state, 'feature').rules, []);
  const list = textOf(await call('list_workflows'));
  assert.doesNotMatch(nodeLine(list, 'review'), /выключен|пропуск/);
  assert.doesNotMatch(nodeLine(list, 'rework'), /выпадает/);
  assert.match(list, /^feature — .*Правки офиса: были, сейчас сброшены\./m);
  const again = await call('reset_workflow', { workflowId: 'feature', reason: 'ещё раз' });
  assert.match(textOf(again), /сбрасывать нечего/);
});

await check('промпт менеджера: когда менять процесс и что нельзя выключить', () => {
  const prompt = pmPrompt(state, true);
  for (const name of ['list_workflows', 'edit_workflow', 'reset_workflow']) assert.ok(prompt.includes(name), name);
  assert.match(prompt, /меняются только словом владельца/);
  assert.match(prompt, /Слияние и гейт с проверками выключить нельзя/);
  assert.match(prompt, /идущие доезжают по процессу, с которым начинали/);
});

console.log(`\nworkflow-tools: ${passed} проверок прошли`);

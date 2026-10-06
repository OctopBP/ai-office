/**
 * Документы у агентов (T-306): инструменты docs_* (src/server/docs-tools.ts),
 * оглавление в системном промпте и архив рабочих материалов при закрытии
 * задачи (outcomes.ts → archiveWorkingDocsOfTask).
 *
 * Офис пишет во временную папку: живое состояние не трогаем.
 *
 * Запуск: npm run test:docstools
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOffice } from '../src/server/state';
import { listDocs, readDoc } from '../src/server/docs';
import { docsBrief, docTools } from '../src/server/docs-tools';
import { cancelTask, recordOutcome } from '../src/server/outcomes';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

type Result = { content: { type: string; text: string }[]; isError?: boolean };
type Tool = { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<Result> };

const tmp = mkdtempSync(join(tmpdir(), 'office-docs-tools-'));
const state = getOffice('test-docs-tools');
state.setStateFile(join(tmp, 'o-test.json'));

function tools(author: string, taskId: string | null): Map<string, Tool> {
  return new Map((docTools(state, author, taskId) as unknown as Tool[]).map((t) => [t.name, t]));
}
async function call(set: Map<string, Tool>, name: string, args: Record<string, unknown>): Promise<Result> {
  const t = set.get(name);
  assert.ok(t, `нет инструмента ${name}`);
  return t.handler(args, {});
}
const textOf = (r: Result) => r.content.map((c) => c.text).join('\n');

try {
  const task = state.createTask({ title: 'Экран документов', description: '', criteria: [], roleId: null });
  const worker = tools('backend-2#1', task.id);
  const pm = tools('pm#1', null);

  console.log('инструменты');

  await check('четыре инструмента у исполнителя и у менеджера', () => {
    for (const set of [worker, pm]) {
      assert.deepEqual([...set.keys()], ['docs_list', 'docs_read', 'docs_write', 'docs_set_kind']);
    }
  });

  await check('без документов промпт без блока, список — «не нашлось»', async () => {
    assert.equal(docsBrief(state), '');
    assert.match(textOf(await call(worker, 'docs_list', {})), /не нашлось/);
  });

  await check('docs_write без типа — рабочий материал текущей задачи', async () => {
    const r = await call(worker, 'docs_write', { title: 'Спека', summary: 'что делаем', body: 'секретный текст спеки' });
    assert.ok(!r.isError, textOf(r));
    const d = readDoc(state, 'D-1');
    assert.equal(d?.kind, 'working');
    assert.equal(d?.taskId, task.id);
    assert.equal(d?.createdBy, 'backend-2#1');
  });

  await check('docs_write с типом — без привязки к задаче', async () => {
    await call(worker, 'docs_write', { title: 'Как устроено', summary: 'карта', body: 'текст', kind: 'documentation' });
    assert.equal(readDoc(state, 'D-2')?.kind, 'documentation');
    assert.equal(readDoc(state, 'D-2')?.taskId, undefined);
  });

  await check('docs_write с id правит: новая версия, тип прежний', async () => {
    const r = await call(worker, 'docs_write', { id: 'D-1', title: 'Спека', summary: 'что делаем', body: 'v2' });
    assert.match(textOf(r), /версия 2/);
    assert.equal(readDoc(state, 'D-1')?.kind, 'working');
    assert.equal(readDoc(state, 'D-1')?.body, 'v2');
  });

  await check('docs_read: текущая и прошлая версия, нет такого — ошибка', async () => {
    assert.match(textOf(await call(worker, 'docs_read', { id: 'D-1' })), /v2$/);
    assert.match(textOf(await call(worker, 'docs_read', { id: 'D-1', version: 1 })), /секретный текст спеки/);
    assert.ok((await call(worker, 'docs_read', { id: 'D-99' })).isError);
  });

  await check('docs_list: поиск и фильтр по типу', async () => {
    assert.match(textOf(await call(pm, 'docs_list', { query: 'карта' })), /D-2/);
    const working = textOf(await call(pm, 'docs_list', { kind: 'working' }));
    assert.match(working, /D-1/);
    assert.doesNotMatch(working, /D-2/);
  });

  await check('менеджер без типа создаёт рабочий материал без задачи', async () => {
    await call(pm, 'docs_write', { title: 'Заметки PM', summary: '', body: 'x' });
    assert.equal(readDoc(state, 'D-3')?.kind, 'working');
    assert.equal(readDoc(state, 'D-3')?.taskId, undefined);
  });

  await check('docs_set_kind меняет тип; плохой id — ошибка', async () => {
    assert.match(textOf(await call(pm, 'docs_set_kind', { id: 'D-3', kind: 'documentation' })), /документация/);
    assert.equal(readDoc(state, 'D-3')?.kind, 'documentation');
    assert.ok((await call(pm, 'docs_set_kind', { id: 'D-42', kind: 'working' })).isError);
  });

  console.log('промпт');

  await check('оглавление в промпте: названия и описания, без текстов', () => {
    const brief = docsBrief(state);
    assert.match(brief, /Документы офиса/);
    assert.match(brief, /D-1 .*Спека — что делаем/);
    assert.doesNotMatch(brief, /секретный текст|v2\b/);
  });

  console.log('закрытие задачи');

  await check('провал не архивирует: задачу перезапустят', () => {
    recordOutcome(state, task.id, 'failed');
    assert.equal(readDoc(state, 'D-1')?.archived, false);
    state.updateTask(task.id, { outcome: null });
  });

  await check('влитая задача уносит свои рабочие материалы в архив', () => {
    recordOutcome(state, task.id, 'clean');
    assert.equal(readDoc(state, 'D-1')?.archived, true);
    assert.equal(readDoc(state, 'D-2')?.archived, false, 'документация остаётся');
    assert.ok(!listDocs(state).some((d) => d.id === 'D-1'));
  });

  await check('снятая задача тоже архивирует рабочие материалы', async () => {
    const other = state.createTask({ title: 'Другая', description: '', criteria: [], roleId: null });
    await call(tools('backend#1', other.id), 'docs_write', { title: 'Черновик', summary: '', body: 'y' });
    const id = listDocs(state, { query: 'черновик' })[0].id;
    cancelTask(state, other);
    assert.equal(readDoc(state, id)?.archived, true);
  });

  console.log(`\nвсе проверки прошли: ${passed}`);
} finally {
  state.retire();
  rmSync(tmp, { recursive: true, force: true });
}

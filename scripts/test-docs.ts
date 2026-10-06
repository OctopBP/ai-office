/**
 * Библиотека документов офиса (src/server/docs.ts, T-305): создание, правка с
 * историей, поиск, архив рабочих материалов задачи, оглавление для промпта,
 * импорт markdown и события doc.* в шину.
 *
 * Офис пишет во временную папку: живое состояние не трогаем.
 *
 * Запуск: npm run test:docs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '../src/shared/types';
import { getOffice } from '../src/server/state';
import {
  archiveWorkingDocsOfTask, createDoc, docHistory, docIndexForPrompt, importFromDir, listDocs,
  readDoc, setKind, updateDoc,
} from '../src/server/docs';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'office-docs-'));
const OFFICE = 'test-docs';
const state = getOffice(OFFICE);
state.setStateFile(join(tmp, 'o-test.json'));
const dir = state.docsDir();

const events: ServerEvent[] = [];
state.subscribe((e) => events.push(e));
const docEvents = () => events.filter((e) => e.t.startsWith('doc.')).map((e) => e.t);

try {
  console.log('создание');

  check('папка библиотеки рядом с файлом состояния', () => {
    assert.equal(dir, join(tmp, 'o-test.docs'));
  });

  check('createDoc: id, версия 1, тип по умолчанию working, событие и строка ленты', () => {
    const d = createDoc(state, { title: 'Спека экрана', summary: 'что\nи как', body: '# Спека\nкнопка', taskId: 'T-1', author: 'designer' }, 1000);
    assert.equal(d.id, 'D-1');
    assert.equal(d.version, 1);
    assert.equal(d.kind, 'working');
    assert.equal(d.archived, false);
    assert.equal(d.summary, 'что и как', 'описание — одна строка');
    assert.equal(d.createdBy, 'designer');
    assert.deepEqual(docEvents(), ['doc.created']);
    assert.ok(events.some((e) => e.t === 'log' && e.entry.text.includes('D-1')), 'правка видна в ленте');
    assert.ok(existsSync(join(dir, 'index.json')));
    assert.equal(readFileSync(join(dir, 'D-1.md'), 'utf8'), '# Спека\nкнопка');
    assert.ok(existsSync(join(dir, 'history', 'D-1', 'v1.json')));
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'временных файлов не осталось');
  });

  check('createDoc: другие типы, сквозная нумерация', () => {
    assert.equal(createDoc(state, { title: 'Видение', summary: 'куда идём', body: 'офис агентов', kind: 'foundation', author: 'pm' }, 2000).id, 'D-2');
    assert.equal(createDoc(state, { title: 'Как устроен сервер', summary: 'карта модулей', body: 'state.ts ведёт доску', kind: 'documentation', author: 'pm' }, 3000).id, 'D-3');
  });

  check('createDoc: без названия и с чужим типом — отказ', () => {
    assert.throws(() => createDoc(state, { title: '  ', author: 'x' }));
    assert.throws(() => createDoc(state, { title: 'x', kind: 'plan' as never, author: 'x' }));
  });

  console.log('правка и история');

  check('updateDoc поднимает версию и пишет её в историю', () => {
    events.length = 0;
    const d = updateDoc(state, 'D-1', { body: '# Спека\nкнопка синяя' }, 'frontend', 4000);
    assert.ok(d);
    assert.equal(d.version, 2);
    assert.equal(d.updatedBy, 'frontend');
    assert.equal(d.createdBy, 'designer');
    assert.deepEqual(docEvents(), ['doc.updated']);
    const d2 = updateDoc(state, 'D-1', { title: 'Спека экрана входа' }, 'designer', 5000);
    assert.equal(d2?.version, 3);
    const hist = docHistory(state, 'D-1');
    assert.deepEqual(hist.map((v) => v.version), [1, 2, 3]);
    assert.deepEqual(hist.map((v) => v.author), ['designer', 'frontend', 'designer']);
    assert.equal(hist[0].body, '# Спека\nкнопка');
  });

  check('правка без изменений — не правка', () => {
    events.length = 0;
    const d = updateDoc(state, 'D-1', { title: 'Спека экрана входа' }, 'x', 6000);
    assert.equal(d?.version, 3);
    assert.deepEqual(docEvents(), []);
  });

  check('readDoc: текущая и прошлая версия, нет такого — null', () => {
    const now = readDoc(OFFICE, 'D-1');
    assert.equal(now?.body, '# Спека\nкнопка синяя');
    assert.equal(now?.title, 'Спека экрана входа');
    const v1 = readDoc(OFFICE, 'D-1', 1);
    assert.equal(v1?.version, 1);
    assert.equal(v1?.body, '# Спека\nкнопка');
    assert.equal(v1?.title, 'Спека экрана');
    assert.equal(readDoc(OFFICE, 'D-1', 9), null);
    assert.equal(readDoc(OFFICE, 'D-99'), null);
    assert.equal(readDoc(OFFICE, '../index'), null);
    assert.equal(updateDoc(state, 'D-99', { body: 'x' }, 'x'), null);
  });

  check('setKind — тоже правка с новой версией', () => {
    events.length = 0;
    const d = setKind(state, 'D-3', 'foundation', 'pm', 7000);
    assert.equal(d?.kind, 'foundation');
    assert.equal(d?.version, 2);
    assert.deepEqual(docEvents(), ['doc.updated']);
    setKind(state, 'D-3', 'documentation', 'pm', 7100);
    assert.equal(readDoc(state, 'D-3')?.version, 3);
  });

  console.log('поиск');

  check('listDocs: по названию, описанию и тексту, без учёта регистра', () => {
    assert.deepEqual(listDocs(state, { query: 'ВИДЕНИЕ' }).map((d) => d.id), ['D-2']);
    assert.deepEqual(listDocs(state, { query: 'карта' }).map((d) => d.id), ['D-3']);
    assert.deepEqual(listDocs(state, { query: 'синяя' }).map((d) => d.id), ['D-1']);
    assert.deepEqual(listDocs(state, { query: 'синяя кнопка' }).map((d) => d.id), ['D-1'], 'все слова');
    assert.deepEqual(listDocs(state, { query: 'синяя видение' }), []);
  });

  check('listDocs: совпадение в названии выше, чем в тексте', () => {
    createDoc(state, { title: 'Заметки', body: 'про сервер и доску', kind: 'documentation', author: 'pm' }, 8000); // D-4
    assert.deepEqual(listDocs(state, { query: 'сервер' }).map((d) => d.id), ['D-3', 'D-4']);
  });

  check('listDocs: фильтр по типу, свежие сверху', () => {
    assert.deepEqual(listDocs(state, { kind: 'documentation' }).map((d) => d.id), ['D-4', 'D-3']);
    assert.equal(listDocs(state).length, 4);
    assert.ok(listDocs(state).every((d) => !('body' in d)), 'в оглавлении нет текста');
  });

  console.log('архив рабочих материалов задачи');

  check('archiveWorkingDocsOfTask убирает только рабочие материалы этой задачи', () => {
    createDoc(state, { title: 'Исследование', body: 'r', taskId: 'T-1', author: 'r' }, 9000); // D-5
    createDoc(state, { title: 'Чужая спека', body: 'o', taskId: 'T-2', author: 'r' }, 9100); // D-6
    createDoc(state, { title: 'Бренд к задаче', body: 'b', kind: 'foundation', taskId: 'T-1', author: 'r' }, 9200); // D-7
    events.length = 0;
    const gone = archiveWorkingDocsOfTask(state, 'T-1', 10000);
    assert.deepEqual(gone.sort(), ['D-1', 'D-5']);
    assert.deepEqual(docEvents(), ['doc.archived', 'doc.archived']);
    assert.equal(readDoc(state, 'D-1')?.archived, true);
    assert.equal(readDoc(state, 'D-1')?.version, 3, 'архив — пометка, а не новая версия');
    assert.equal(readDoc(state, 'D-6')?.archived, false);
    assert.equal(readDoc(state, 'D-7')?.archived, false);
    assert.deepEqual(archiveWorkingDocsOfTask(state, 'T-1'), [], 'повтор ничего не делает');
  });

  check('архивные не ищутся по умолчанию, но находятся с includeArchived', () => {
    assert.deepEqual(listDocs(state, { query: 'синяя' }), []);
    assert.deepEqual(listDocs(state, { query: 'синяя', includeArchived: true }).map((d) => d.id), ['D-1']);
  });

  check('updateDoc возвращает из архива', () => {
    const d = updateDoc(state, 'D-5', { archived: false }, 'pm', 11000);
    assert.equal(d?.archived, false);
    assert.equal(d?.version, 2);
    updateDoc(state, 'D-5', { archived: true }, 'pm', 11100);
    assert.equal(events.at(-2)?.t, 'doc.archived');
  });

  console.log('оглавление для промпта');

  check('docIndexForPrompt: без архивных, основа первой, с типом и описанием', () => {
    const text = docIndexForPrompt(OFFICE);
    const lines = text.split('\n');
    assert.match(lines[0], /Документы офиса/);
    assert.ok(text.includes('- D-2 [основа] Видение — куда идём'));
    assert.ok(text.includes('- D-6 [рабочее, T-2] Чужая спека'));
    assert.ok(!text.includes('D-1 '), 'архивный не едет');
    assert.ok(!text.includes('D-5 '), 'архивный не едет');
    assert.ok(lines.findIndex((l) => l.includes('D-2')) < lines.findIndex((l) => l.includes('D-6')));
    assert.ok(!text.includes('синяя'), 'текста в оглавлении нет');
  });

  check('docIndexForPrompt: длина ограничена, хвост «…и ещё N»', () => {
    const text = docIndexForPrompt(OFFICE, 120);
    assert.ok(text.length <= 120, `длина ${text.length}`);
    assert.match(text, /…и ещё \d+$/);
  });

  check('docIndexForPrompt: пустая библиотека — пустая строка', () => {
    const other = getOffice('test-docs-empty');
    other.setStateFile(join(tmp, 'empty.json'));
    assert.equal(docIndexForPrompt(other), '');
  });

  console.log('импорт');

  check('importFromDir: заголовок и первый абзац, повтор без дублей', () => {
    const src = join(tmp, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'gdd.md'), '# Игровой дизайн\n\n<!-- служебное -->\nМеханики и цикл игры.\n\nДальше текст.');
    writeFileSync(join(src, 'sub', 'chars.md'), 'Без заголовка, сразу текст.');
    writeFileSync(join(src, 'skip.txt'), 'не markdown');
    const r = importFromDir(state, src, 'foundation');
    assert.equal(r.created.length, 2);
    const gdd = listDocs(state, { query: 'игровой дизайн' })[0];
    assert.equal(gdd.kind, 'foundation');
    assert.equal(gdd.summary, 'Механики и цикл игры.');
    assert.equal(gdd.createdBy, 'import');
    assert.ok(listDocs(state, { kind: 'foundation' }).some((d) => d.title === 'chars'));
    const again = importFromDir(state, src, 'foundation');
    assert.equal(again.created.length, 0);
    assert.equal(again.skipped.length, 2);
  });

  console.log('хранилище');

  check('документы переживают перезагрузку: всё читается с диска', () => {
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { seq: number; docs: unknown[] };
    assert.equal(index.seq, 9);
    assert.equal(index.docs.length, 9);
    // Индекс — точка фиксации: оборванная правка (версия записана, индекс нет) не видна.
    writeFileSync(join(dir, 'history', 'D-2', 'v2.json'), JSON.stringify({ version: 2, body: 'недописано' }));
    assert.equal(readDoc(state, 'D-2')?.body, 'офис агентов');
    assert.equal(updateDoc(state, 'D-2', { body: 'офис агентов, v2' }, 'pm')?.version, 2);
    assert.equal(readDoc(state, 'D-2')?.body, 'офис агентов, v2');
  });

  console.log(`\nвсе проверки прошли: ${passed}`);
} finally {
  state.retire();
  rmSync(tmp, { recursive: true, force: true });
}

/**
 * Макеты FigCraft (src/server/figcraft.ts): какой файл можно открыть, откуда
 * берётся список задачи (живая копия против основной директории), поиск
 * приложения, запрет на открытие по удалённому запросу и ручка открытия.
 * Само приложение не запускается: запуск подменён шпионом.
 *
 *   npm run test:figcraft
 */
import './_isolate';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FigcraftFilesView, FigcraftOpenResult } from '../src/shared/types';
import {
  checkFigcraftPath, findFigcraftApp, openAccess, openCommand, scanFigcraft, serveFigcraftList,
  serveFigcraftOpen, taskFigcraftList, type FigcraftHttpEnv,
} from '../src/server/figcraft';
import { t } from '../src/server/i18n';
import type { OfficeState } from '../src/server/state';

let failed = 0;
const check = (name: string, fn: () => unknown | Promise<unknown>) =>
  Promise.resolve().then(fn).then(
    () => console.log(`ok   ${name}`),
    (e) => { failed++; console.log(`FAIL ${name}\n     ${e instanceof Error ? e.message : e}`); },
  );

const tmp = realpathSync(mkdtempSync(resolve(tmpdir(), 'office-figcraft-')));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* временная */ } });

const put = (path: string, body = 'PK'): string => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', [
  '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args,
], { cwd, encoding: 'utf8' });

// ------------------------------------------------------------ путь

const root = resolve(tmp, 'office');
const outside = resolve(tmp, 'outside');
const inFile = put(resolve(root, 'docs/design/T-1/экран.figcraft'));
const outFile = put(resolve(outside, 'чужой.figcraft'));
put(resolve(root, 'docs/notes.md'), '# заметка');
symlinkSync(outFile, resolve(root, 'docs/ссылка.figcraft'));

await check('путь: .figcraft внутри корня открывается', () => {
  const r = checkFigcraftPath(inFile, [root]);
  assert.deepEqual(r, { ok: true, real: inFile });
});

await check('путь: относительный — от первого корня', () => {
  const r = checkFigcraftPath('docs/design/T-1/экран.figcraft', [root]);
  assert.equal(r.ok, true);
});

await check('путь: файл снаружи корня — отказ', () => {
  const r = checkFigcraftPath(outFile, [root]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'bad-path');
});

await check('путь: не .figcraft — отказ', () => {
  const r = checkFigcraftPath(resolve(root, 'docs/notes.md'), [root]);
  assert.equal(!r.ok && r.key, 'figcraft.notFigcraft');
});

await check('путь: «..» — отказ даже с выходом обратно внутрь', () => {
  const r = checkFigcraftPath(`${root}/docs/../docs/design/T-1/экран.figcraft`, [root]);
  assert.equal(!r.ok && r.code, 'bad-path');
});

await check('путь: ссылка изнутри наружу — отказ', () => {
  const r = checkFigcraftPath(resolve(root, 'docs/ссылка.figcraft'), [root]);
  assert.equal(!r.ok && r.code, 'bad-path');
});

await check('путь: нет файла внутри корня — not-found', () => {
  const r = checkFigcraftPath(resolve(root, 'нет.figcraft'), [root]);
  assert.equal(!r.ok && r.code, 'not-found');
});

await check('путь: второй корень (копия задачи) тоже годится', () => {
  const r = checkFigcraftPath(outFile, [root, outside]);
  assert.equal(r.ok, true);
});

// ------------------------------------------------------------ обход

await check('обход: пропускает node_modules, .git, .office, ссылки и копии задач', () => {
  put(resolve(root, 'node_modules/pkg/x.figcraft'));
  put(resolve(root, '.office/worktrees/o-1/T-2/y.figcraft'));
  put(resolve(root, 'копии/T-3/z.figcraft'));
  put(resolve(root, 'A.FIGCRAFT'));
  const { files, truncated } = scanFigcraft(root, 'main', [resolve(root, 'копии')]);
  assert.equal(truncated, false);
  assert.deepEqual(files.map((f) => f.path), ['A.FIGCRAFT', 'docs/design/T-1/экран.figcraft']);
  const f = files[1]!;
  assert.equal(f.absPath, inFile);
  assert.equal(f.source, 'main');
  assert.equal(f.size, 2);
  assert.ok(f.mtime > 0);
});

// ------------------------------------------------------------ worktree против main

const repo = resolve(tmp, 'repo');
mkdirSync(repo);
sh(repo, 'init', '-q', '-b', 'main');
put(resolve(repo, 'docs/старый.figcraft'));
put(resolve(repo, 'docs/правится.figcraft'));
sh(repo, 'add', '.');
sh(repo, 'commit', '-q', '-m', 'база');
const wt = resolve(tmp, 'wt', 'T-7');
sh(repo, 'worktree', 'add', '-q', '-b', 'task/T-7', wt, 'main');
put(resolve(wt, 'docs/design/T-7/закоммичен.figcraft'));
sh(wt, 'add', '.');
sh(wt, 'commit', '-q', '-m', 'T-7: макет');
put(resolve(wt, 'docs/design/T-7/новый.figcraft'));
put(resolve(wt, 'docs/правится.figcraft'), 'PK2');
put(resolve(wt, 'docs/design/T-7/описание.md'), '# не макет');

await check('задача с живой копией: только её макеты и из копии', async () => {
  const r = await taskFigcraftList({
    worktree: wt, baseBranch: 'main', mainDir: repo,
    merged: () => { throw new Error('у живой копии в слияние не ходим'); },
  });
  assert.equal(r.source, 'worktree');
  assert.deepEqual(r.files.map((f) => f.path), [
    'docs/design/T-7/закоммичен.figcraft', 'docs/design/T-7/новый.figcraft', 'docs/правится.figcraft',
  ]);
  assert.ok(r.files.every((f) => f.source === 'worktree' && f.absPath.startsWith(wt)));
});

await check('влитая задача без копии: файлы слияния из основной директории', async () => {
  put(resolve(repo, 'docs/design/T-7/закоммичен.figcraft'));
  const r = await taskFigcraftList({
    worktree: resolve(tmp, 'wt', 'снята'), baseBranch: 'main', mainDir: repo,
    merged: async () => ['docs/design/T-7/закоммичен.figcraft', 'docs/design/T-7/описание.md', 'docs/удалён-потом.figcraft'],
  });
  assert.equal(r.source, 'main');
  assert.deepEqual(r.files.map((f) => f.path), ['docs/design/T-7/закоммичен.figcraft']);
  assert.equal(r.files[0]!.absPath, resolve(repo, 'docs/design/T-7/закоммичен.figcraft'));
});

await check('задача без копии и не влитая: пусто', async () => {
  const r = await taskFigcraftList({ worktree: null, baseBranch: 'main', mainDir: repo, merged: async () => null });
  assert.deepEqual(r, { source: 'none', files: [], truncated: false });
});

// ------------------------------------------------------------ приложение

await check('приложение: FIGCRAFT_APP важнее мест по умолчанию', () => {
  const app = findFigcraftApp({ env: { FIGCRAFT_APP: '/opt/FC.app' }, platform: 'darwin', exists: () => true });
  assert.deepEqual(app, { path: '/opt/FC.app', kind: 'bundle' });
});

await check('приложение: FIGCRAFT_APP на несуществующий путь — не найдено, без подмены', () => {
  const app = findFigcraftApp({ env: { FIGCRAFT_APP: '/нет/FigCraft' }, platform: 'darwin', exists: (p) => p !== '/нет/FigCraft' });
  assert.equal(app, null);
});

await check('приложение: macOS — /Applications/FigCraft.app', () => {
  const app = findFigcraftApp({ env: {}, platform: 'darwin', home: '/h', exists: (p) => p === '/Applications/FigCraft.app' });
  assert.deepEqual(app, { path: '/Applications/FigCraft.app', kind: 'bundle' });
});

await check('приложение: Windows — FigCraft.exe в Programs', () => {
  const exe = join('C:\\Users\\b\\AppData\\Local', 'Programs', 'FigCraft', 'FigCraft.exe');
  const app = findFigcraftApp({ env: { LOCALAPPDATA: 'C:\\Users\\b\\AppData\\Local' }, platform: 'win32', exists: (p) => p === exe });
  assert.deepEqual(app, { path: exe, kind: 'binary' });
});

await check('команда: бандл через open -a, бинарник — путь аргументом', () => {
  assert.deepEqual(openCommand({ path: '/Applications/FigCraft.app', kind: 'bundle' }, '/a b/x.figcraft'),
    { cmd: 'open', args: ['-a', '/Applications/FigCraft.app', '/a b/x.figcraft'] });
  assert.deepEqual(openCommand({ path: '/bin/FigCraft', kind: 'binary' }, '/a;rm -rf/x.figcraft'),
    { cmd: '/bin/FigCraft', args: ['/a;rm -rf/x.figcraft'] });
});

// ------------------------------------------------------------ доступ

await check('доступ: локальный офис, своя страница — можно', () => {
  assert.deepEqual(openAccess({ exposed: false, remoteAddress: '127.0.0.1', forwarded: false, origin: 'http://localhost:3001', host: 'localhost:3001' }), { ok: true });
});

await check('доступ: офис наружу, запрос издалека — remote', () => {
  assert.deepEqual(openAccess({ exposed: true, remoteAddress: '192.168.1.5', forwarded: false, host: 'office.lan:3001' }), { ok: false, code: 'remote' });
});

await check('доступ: офис наружу, через прокси на этой машине — remote', () => {
  assert.deepEqual(openAccess({ exposed: true, remoteAddress: '127.0.0.1', forwarded: true }), { ok: false, code: 'remote' });
  assert.deepEqual(openAccess({
    exposed: true, remoteAddress: '::1', forwarded: false, host: 'office.example.com', publicUrl: 'https://office.example.com',
  }), { ok: false, code: 'remote' });
});

await check('доступ: офис наружу, владелец за этой же машиной — можно', () => {
  assert.deepEqual(openAccess({ exposed: true, remoteAddress: '::ffff:127.0.0.1', forwarded: false, origin: 'http://127.0.0.1:3001', host: '127.0.0.1:3001' }), { ok: true });
});

await check('доступ: чужая страница — forbidden', () => {
  assert.deepEqual(openAccess({ exposed: false, remoteAddress: '127.0.0.1', forwarded: false, origin: 'https://evil.example', host: 'localhost:3001' }), { ok: false, code: 'forbidden' });
});

// ------------------------------------------------------------ HTTP

const state = {
  officeId: 'o-test',
  projectDir: repo,
  tasks: new Map([['T-7', {
    id: 'T-7', status: 'review', worktreePath: wt, baseBranch: 'main', repoDir: null,
  }]]),
  lang: () => 'ru',
  say: (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) => t('ru', key, vars),
} as unknown as OfficeState;

const launched: Array<{ cmd: string; args: string[] }> = [];
const makeEnv = (over: Partial<FigcraftHttpEnv> = {}): FigcraftHttpEnv => ({
  exposed: () => false,
  env: { FIGCRAFT_APP: '/Applications/FigCraft.app' },
  platform: 'darwin',
  launch: async (cmd, args) => { launched.push({ cmd, args }); return { ok: true }; },
  office: () => ({ state }),
  ...over,
});

function fakeReq(body: unknown, opts: { remote?: string; headers?: Record<string, string> } = {}): IncomingMessage {
  const stream = new PassThrough();
  Object.assign(stream, {
    method: 'POST', headers: { host: 'localhost:3001', ...opts.headers }, socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
  });
  queueMicrotask(() => stream.end(body === undefined ? '' : JSON.stringify(body)));
  return stream as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; out: () => { code: number; body: unknown } } {
  let code = 0;
  let text = '';
  const res = {
    headersSent: false,
    writeHead(c: number) { code = c; return res; },
    end(b?: string) { text = b ?? ''; },
  };
  return { res: res as unknown as ServerResponse, out: () => ({ code, body: text ? JSON.parse(text) : null }) };
}

// Приложение «есть» на этом пути только в проверке: exists настоящий, поэтому
// для ручки подсовываем реальный каталог.
const appDir = resolve(tmp, 'FigCraft.app');
mkdirSync(appDir);

const wtFile = resolve(wt, 'docs/design/T-7/новый.figcraft');

await check('открыть: файл копии задачи запускает FigCraft без шелла', async () => {
  launched.length = 0;
  const { res, out } = fakeRes();
  await serveFigcraftOpen(fakeReq({ office: 'o-test', path: wtFile }), res, makeEnv({ env: { FIGCRAFT_APP: appDir } }));
  const { code, body } = out();
  assert.equal(code, 200, JSON.stringify(body));
  assert.deepEqual(body, { ok: true, path: wtFile, app: appDir } satisfies FigcraftOpenResult);
  assert.deepEqual(launched, [{ cmd: 'open', args: ['-a', appDir, wtFile] }]);
});

await check('открыть: файл снаружи — 400 и без запуска', async () => {
  launched.length = 0;
  const { res, out } = fakeRes();
  await serveFigcraftOpen(fakeReq({ path: outFile }), res, makeEnv({ env: { FIGCRAFT_APP: appDir } }));
  assert.equal(out().code, 400);
  assert.equal((out().body as { code: string }).code, 'bad-path');
  assert.equal(launched.length, 0);
});

await check('открыть: не .figcraft — 400', async () => {
  const { res, out } = fakeRes();
  await serveFigcraftOpen(fakeReq({ path: resolve(wt, 'docs/design/T-7/описание.md') }), res, makeEnv({ env: { FIGCRAFT_APP: appDir } }));
  assert.equal(out().code, 400);
});

await check('открыть: нет приложения — 503 no-app с подсказкой и ссылкой', async () => {
  const { res, out } = fakeRes();
  await serveFigcraftOpen(fakeReq({ path: wtFile }), res, makeEnv({ env: { FIGCRAFT_APP: resolve(tmp, 'нет.app') } }));
  const body = out().body as { code: string; error: string; docs: string };
  assert.equal(out().code, 503);
  assert.equal(body.code, 'no-app');
  assert.match(body.error, /FIGCRAFT_APP/);
  assert.equal(body.docs, 'docs/design/figcraft/setup.md');
});

await check('открыть: нет файла — 404', async () => {
  const { res, out } = fakeRes();
  await serveFigcraftOpen(fakeReq({ path: resolve(wt, 'пропал.figcraft') }), res, makeEnv({ env: { FIGCRAFT_APP: appDir } }));
  assert.equal(out().code, 404);
});

await check('открыть: офис наружу, запрос издалека — 403 remote, без запуска', async () => {
  launched.length = 0;
  const { res, out } = fakeRes();
  await serveFigcraftOpen(fakeReq({ path: wtFile }, { remote: '10.0.0.7' }), res, makeEnv({ exposed: () => true, env: { FIGCRAFT_APP: appDir } }));
  assert.equal(out().code, 403);
  assert.equal((out().body as { code: string }).code, 'remote');
  assert.equal(launched.length, 0);
});

await check('открыть: сбой запуска — 500 launch-failed', async () => {
  const { res, out } = fakeRes();
  await serveFigcraftOpen(fakeReq({ path: wtFile }), res, makeEnv({
    env: { FIGCRAFT_APP: appDir }, launch: async () => ({ ok: false, message: 'LSOpen -10810' }),
  }));
  assert.equal(out().code, 500);
  assert.match((out().body as { error: string }).error, /-10810/);
});

await check('список задачи: из копии и с флагом приложения', async () => {
  const { res, out } = fakeRes();
  const req = { method: 'GET', headers: { host: 'localhost:3001' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
  await serveFigcraftList(req, res, new URLSearchParams('task=T-7'), makeEnv({ env: { FIGCRAFT_APP: resolve(tmp, 'нет.app') } }));
  const view = out().body as FigcraftFilesView;
  assert.equal(out().code, 200);
  assert.equal(view.source, 'worktree');
  assert.equal(view.files.length, 3);
  assert.equal(view.app.found, false);
  assert.equal(view.app.canOpen, false);
  assert.match(view.app.reason ?? '', /FIGCRAFT_APP/);
});

await check('список офиса: основная директория без копий задач', async () => {
  const { res, out } = fakeRes();
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
  await serveFigcraftList(req, res, new URLSearchParams(''), makeEnv({ env: { FIGCRAFT_APP: appDir } }));
  const view = out().body as FigcraftFilesView;
  assert.equal(view.task, null);
  assert.equal(view.source, 'main');
  assert.deepEqual(view.files.map((f) => f.path), [
    'docs/design/T-7/закоммичен.figcraft', 'docs/правится.figcraft', 'docs/старый.figcraft',
  ]);
  assert.equal(view.app.canOpen, true);
});

if (failed) {
  console.log(`\n${failed} проверок не прошло`);
  process.exit(1);
}
console.log('\nвсе проверки прошли');

/**
 * Файлы результата задачи (taskfiles.ts) — на настоящем временном репозитории
 * и без единого токена.
 *
 * Стенд: ветка task/T-N меняет, добавляет и удаляет файлы, кладёт два файла
 * указателями LFS (один с объектом в `.git/lfs/objects`, другой — с настоящим
 * содержимым только в рабочем дереве) и файл больше потолка. В истории рядом
 * лежат ловушки с тем же номером задачи: старое слияние чужой задачи и
 * «Merge branch 'main' into task/T-N» из самой ветки.
 *
 * Проверяем:
 *  1. список изменённых файлов по коммиту слияния — со статусами;
 *  2. запасной поиск коммита по истории для задачи без сохранённого результата;
 *  3. вид, размер и LFS в списке;
 *  4. содержимое файла с правильным типом, включая LFS;
 *  5. отказы: чужой путь, «..», удалённый файл, больше потолка, незаконченная задача.
 *
 * Запуск: npm run test:taskfiles
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { getOffice, unloadOfficeState } from '../src/server/state';
import {
  deliveryAt, fileContentType, findMergeCommit, handleTaskFiles, readTaskFile, RESULT_FILE_MAX_BYTES,
  taskFiles,
} from '../src/server/taskfiles';
import type { TaskFilesView } from '../src/shared/types';

process.env.OFFICE_LANG = 'ru';

const results: string[] = [];
const check = (what: string, ok: boolean): void => {
  results.push(`  ${ok ? '✅' : '❌'} ${what}: ${ok}`);
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function run(dir: string, args: string[], at?: number): string {
  const date = at ? `@${Math.floor(at / 1000)} +0000` : undefined;
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
}

function put(dir: string, path: string, body: string | Buffer): void {
  mkdirSync(dirname(resolve(dir, path)), { recursive: true });
  writeFileSync(resolve(dir, path), body);
}

const pointer = (bytes: Buffer): string =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(bytes).digest('hex')}\nsize ${bytes.length}\n`;

// Содержимое «настоящих» файлов: двоичное, чтобы порча при чтении как текста была видна.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x20]);
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(2048, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1500, 3)]);

interface Fixture { dir: string; real: string; decoy: string }

function fixture(now: number): Fixture {
  const dir = mkdtempSync(resolve(tmpdir(), 'office-taskfiles-'));
  const g = (args: string[], at?: number) => run(dir, args, at);
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'office@local']);
  g(['config', 'user.name', 'AI Office']);
  put(dir, 'a.txt', 'было\n');
  put(dir, 'old.txt', 'уйдёт\n');
  put(dir, 'secret.txt', 'в список задачи не входит\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'Начало'], now - 400 * DAY);

  // Ловушка 1: слияние чужой задачи с тем же номером год назад — вне окна.
  g(['checkout', '-qb', 'task/T-1'], now - 399 * DAY);
  put(dir, 'ancient.txt', 'давно\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'T-1: древняя'], now - 399 * DAY);
  g(['checkout', '-q', 'main']);
  g(['merge', '--no-ff', '-q', '-m', "Merge branch 'task/T-1' into HEAD", 'task/T-1'], now - 399 * DAY);
  g(['branch', '-q', '-m', 'task/T-1', 'task/T-1-old']);

  // Ловушка 2: слияние другой задачи с тем же номером в окне, но далеко от завершения.
  g(['checkout', '-qb', 'task/T-1'], now - 20 * HOUR);
  put(dir, 'decoy.txt', 'чужое\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'T-1: чужая'], now - 20 * HOUR);
  g(['checkout', '-q', 'main']);
  g(['merge', '--no-ff', '-q', '-m', "Merge branch 'task/T-1' into HEAD", 'task/T-1'], now - 20 * HOUR);
  const decoy = g(['rev-parse', 'HEAD']);
  g(['branch', '-q', '-D', 'task/T-1']);

  // Настоящая задача.
  g(['checkout', '-qb', 'task/T-1'], now - 2 * HOUR);
  put(dir, 'a.txt', 'стало\n');
  put(dir, 'docs/отчёт с пробелом.md', '# Итог\n');
  put(dir, 'img/pic.png', PNG);
  put(dir, 'models/room.glb', pointer(GLB));
  put(dir, 'img/photo.jpg', pointer(JPG));
  put(dir, 'big.bin', Buffer.alloc(RESULT_FILE_MAX_BYTES + 1024, 1));
  rmSync(resolve(dir, 'old.txt'));
  g(['add', '-A']);
  g(['commit', '-qm', 'T-1: работа'], now - 2 * HOUR);
  // Основная ветка ушла вперёд, и её влили в ветку задачи: такое слияние
  // тоже упоминает task/T-1, но на первой линии main его нет.
  g(['checkout', '-q', 'main']);
  put(dir, 'other.txt', 'соседняя задача\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'T-2: соседняя'], now - HOUR);
  g(['checkout', '-q', 'task/T-1']);
  g(['merge', '--no-ff', '-q', '-m', "Merge branch 'main' into task/T-1", 'main'], now - 30 * 60 * 1000);
  g(['checkout', '-q', 'main']);
  g(['merge', '--no-ff', '-q', '-m', "Merge branch 'task/T-1' into HEAD", 'task/T-1'], now - 60 * 1000);
  const real = g(['rev-parse', 'HEAD']);

  // LFS: объект модели — в хранилище, фото — только в рабочем дереве.
  const oid = createHash('sha256').update(GLB).digest('hex');
  put(resolve(dir, '.git/lfs/objects', oid.slice(0, 2), oid.slice(2, 4)), oid, GLB);
  put(dir, 'img/photo.jpg', JPG);
  return { dir, real, decoy };
}

/** Вызвать ручку на поддельных запросе и ответе. code 0 — ручка адрес не взяла. */
function httpCall(method: string, path: string): Promise<{ code: number; body: string }> {
  return new Promise((done) => {
    const [url = '/', query = ''] = path.split('?');
    let code = 0;
    const res = {
      headersSent: false,
      writeHead(c: number) { code = c; this.headersSent = true; return this; },
      end(body?: string | Buffer) { done({ code, body: String(body ?? '') }); },
    };
    const taken = handleTaskFiles({ method } as IncomingMessage, res as unknown as ServerResponse, url, query);
    if (!taken) done({ code: 0, body: '' });
  });
}

async function main(): Promise<void> {
  const now = Date.now();
  const fx = fixture(now);
  const office = getOffice('o-taskfiles');
  office.seed();
  office.opened = true;

  try {
    // ---------- 1. список по коммиту слияния ----------
    const d = await deliveryAt(fx.dir, fx.real);
    const status = new Map(d?.files.map((f) => [f.path, f.status]));
    check('база — первый родитель слияния', d?.base === run(fx.dir, ['rev-parse', `${fx.real}^1`]));
    check('изменённый файл помечен modified', status.get('a.txt') === 'modified');
    check('новые файлы помечены added', status.get('img/pic.png') === 'added'
      && status.get('docs/отчёт с пробелом.md') === 'added' && status.get('models/room.glb') === 'added');
    check('удалённый файл помечен deleted', status.get('old.txt') === 'deleted');
    check('чужие правки main в список не попали', !status.has('other.txt') && !status.has('decoy.txt'));

    // ---------- 2. запасной поиск по истории ----------
    const task = office.createTask({ title: 'Работа', description: '', criteria: ['есть'], roleId: 'backend' });
    // Номер задачи в стенде — T-1: ровно его и ищем в истории.
    check('задача стенда — T-1', task.id === 'T-1');
    office.updateTask(task.id, {
      status: 'done', merged: true, repoDir: fx.dir, baseBranch: 'main',
      createdAt: now - DAY, startedAt: now - 3 * HOUR, finishedAt: now,
    });
    const found = await findMergeCommit(fx.dir, office.tasks.get(task.id)!);
    check('по истории найден ближайший к завершению коммит, а не чужой', found?.commit === fx.real);
    check('ловушка в окне отвергнута', found?.commit !== fx.decoy);

    // ---------- 3. список с видами ----------
    const view = await taskFiles(office, office.tasks.get(task.id)!) as TaskFilesView;
    const row = (p: string) => view.files?.find((f) => f.path === p);
    check('список найден по истории', view.source === 'log' && view.commit === fx.real);
    check('найденный результат запомнен в задаче', office.tasks.get(task.id)?.delivery?.commit === fx.real);
    check('вид по расширению', row('a.txt')?.kind === 'text' && row('docs/отчёт с пробелом.md')?.kind === 'markdown'
      && row('img/pic.png')?.kind === 'image' && row('models/room.glb')?.kind === 'model3d'
      && row('big.bin')?.kind === 'other');
    check('размер обычного файла', row('img/pic.png')?.size === PNG.length && row('img/pic.png')?.lfs === false);
    check('у файла LFS размер содержимого, а не указателя',
      row('models/room.glb')?.size === GLB.length && row('models/room.glb')?.lfs === true);
    check('у удалённого размера нет', row('old.txt')?.size === null);
    const again = await taskFiles(office, office.tasks.get(task.id)!) as TaskFilesView;
    check('второй запрос берёт сохранённое', again.source === 'saved');

    // ---------- 4. содержимое ----------
    const t = () => office.tasks.get(task.id)!;
    const text = await readTaskFile(office, t(), 'a.txt');
    check('текст отдаётся из коммита', text.ok && text.bytes.toString('utf8') === 'стало\n'
      && text.type === 'text/plain; charset=utf-8');
    const md = await readTaskFile(office, t(), 'docs/отчёт с пробелом.md');
    check('markdown с типом text/markdown', md.ok && md.type.startsWith('text/markdown'));
    const png = await readTaskFile(office, t(), 'img/pic.png');
    check('картинка байт в байт, image/png', png.ok && png.bytes.equals(PNG) && png.type === 'image/png');
    const glb = await readTaskFile(office, t(), 'models/room.glb');
    check('модель из хранилища LFS, model/gltf-binary',
      glb.ok && glb.bytes.equals(GLB) && glb.type === 'model/gltf-binary');
    const jpg = await readTaskFile(office, t(), 'img/photo.jpg');
    check('LFS из рабочего дерева при совпадении хеша', jpg.ok && jpg.bytes.equals(JPG) && jpg.type === 'image/jpeg');
    check('типы pdf и svg', fileContentType('x/y.pdf') === 'application/pdf'
      && fileContentType('logo.svg') === 'image/svg+xml' && fileContentType('page.html').startsWith('text/plain'));

    // ---------- 5. отказы ----------
    const code = (r: Awaited<ReturnType<typeof readTaskFile>>) => (r.ok ? 200 : r.code);
    check('файл репозитория вне списка задачи — 404', code(await readTaskFile(office, t(), 'secret.txt')) === 404);
    check('«..» — 400', code(await readTaskFile(office, t(), '../a.txt')) === 400
      && code(await readTaskFile(office, t(), 'img/../secret.txt')) === 400);
    check('абсолютный путь — 400', code(await readTaskFile(office, t(), '/etc/passwd')) === 400);
    check('удалённый файл — 410', code(await readTaskFile(office, t(), 'old.txt')) === 410);
    check('больше 20 МБ — 413', code(await readTaskFile(office, t(), 'big.bin')) === 413);

    office.updateTask(task.id, { status: 'review' });
    check('задача не done — 409 и на список, и на файл',
      code(await readTaskFile(office, t(), 'a.txt')) === 409
      && 'error' in (await taskFiles(office, t())) && (await taskFiles(office, t()) as { code: number }).code === 409);

    const plain = office.createTask({ title: 'Без слияния', description: '', criteria: ['есть'], roleId: 'backend' });
    office.updateTask(plain.id, { status: 'done', merged: false, repoDir: fx.dir, finishedAt: now });
    const none = await taskFiles(office, office.tasks.get(plain.id)!) as TaskFilesView;
    check('невлитая задача — пустой список без ошибки', none.source === 'none' && none.files.length === 0);

    // ---------- HTTP: чужие адреса и методы ----------
    // Без настоящего сервера: песочница исполнителя не даёт слушать порт, а
    // ручке хватает метода запроса и двух методов ответа.
    check('чужой адрес ручка не берёт', (await httpCall('GET', '/api/other')).code === 0);
    check('POST — 405', (await httpCall('POST', '/api/task/files?task=T-1')).code === 405);
    check('неизвестный офис — 404',
      (await httpCall('GET', '/api/task/files?office=o-нет&task=T-1')).code === 404);
  } finally {
    unloadOfficeState('o-taskfiles');
    rmSync(fx.dir, { recursive: true, force: true });
  }

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.includes('❌')).length;
  console.log(failed ? `\n${failed} проверок не прошло` : '\nвсё прошло');
  process.exit(failed ? 1 : 0);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

/**
 * Файлы результата задачи: что влитая задача создала, поменяла или удалила —
 * и содержимое этих файлов в том виде, в каком они легли в основную ветку.
 *
 * Источник — коммит слияния, а не рабочее дерево: после слияния файл могли
 * поправить следующие задачи, а показать надо то, что сделала эта. Коммит и
 * список конвейер запоминает при слиянии (review.ts → delivery). У задач,
 * влитых раньше, их нет — тогда коммит ищется по истории базовой ветки.
 *
 * Маршруты только на чтение:
 *   GET /api/task/files?office=<id>&task=T-N              — список (TaskFilesView);
 *   GET /api/task/file?office=<id>&task=T-N&path=<путь>   — содержимое одного файла.
 *
 * Путь из запроса никогда не идёт в файловую систему или в git как есть: он
 * обязан дословно совпасть с путём из списка файлов задачи. Иначе ручка стала
 * бы способом прочитать любой файл репозитория — или машины.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, basename, isAbsolute, join, resolve } from 'node:path';
import type {
  ResultFile, ResultFileKind, ResultFileStatus, ResultFileView, TaskDelivery, TaskFilesView,
} from '../shared/types';
import { git, gitBytes, isRepo, revision } from './git';
import { c } from './i18n';
import { currentOffice, officeById } from './offices';
import { getOffice, isOpened, taskRepo, type OfficeState, type Task } from './state';

/** Больше этого содержимое не отдаём: показать такое в карточке задачи всё равно нельзя. */
export const RESULT_FILE_MAX_BYTES = 20 * 1024 * 1024;

/** Пустое дерево git: база для коммита без родителя (самый первый коммит репозитория). */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Указатель LFS — короткий текстовый файл; больше этого указателем он быть не может. */
const LFS_POINTER_MAX = 1024;

// ------------------------------------------------------------ вид и тип файла

const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const PDF = new Set(['.pdf']);

/** Тип по расширению для картинок, pdf и моделей. Он же список «что это за вид». */
const BINARY_MIME: Record<string, { kind: ResultFileKind; type: string }> = {
  '.png': { kind: 'image', type: 'image/png' },
  '.jpg': { kind: 'image', type: 'image/jpeg' },
  '.jpeg': { kind: 'image', type: 'image/jpeg' },
  '.gif': { kind: 'image', type: 'image/gif' },
  '.webp': { kind: 'image', type: 'image/webp' },
  '.avif': { kind: 'image', type: 'image/avif' },
  '.bmp': { kind: 'image', type: 'image/bmp' },
  '.ico': { kind: 'image', type: 'image/x-icon' },
  '.svg': { kind: 'image', type: 'image/svg+xml' },
  '.pdf': { kind: 'pdf', type: 'application/pdf' },
  '.glb': { kind: 'model3d', type: 'model/gltf-binary' },
  '.gltf': { kind: 'model3d', type: 'model/gltf+json' },
  '.obj': { kind: 'model3d', type: 'model/obj' },
  '.stl': { kind: 'model3d', type: 'model/stl' },
  '.3mf': { kind: 'model3d', type: 'model/3mf' },
  '.usdz': { kind: 'model3d', type: 'model/vnd.usdz+zip' },
  '.fbx': { kind: 'model3d', type: 'application/octet-stream' },
  '.ply': { kind: 'model3d', type: 'application/octet-stream' },
};

const TEXT_EXT = new Set([
  '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.jsonc', '.json5',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xml', '.yml', '.yaml', '.toml', '.ini',
  '.cfg', '.conf', '.env', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.py', '.rb',
  '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php',
  '.sql', '.csv', '.tsv', '.log', '.lock', '.vue', '.svelte', '.astro', '.graphql', '.gql',
  '.proto', '.plist', '.entitlements', '.gradle', '.properties', '.tex', '.rst', '.adoc', '.patch',
  '.diff', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc', '.prettierrc',
  '.eslintrc', '.glsl', '.vert', '.frag', '.wgsl', '.lua', '.r', '.dart', '.scala', '.ex', '.exs',
]);

/** Файлы без расширения, которые всё же текст. */
const TEXT_NAMES = new Set([
  'Dockerfile', 'Makefile', 'LICENSE', 'README', 'CHANGELOG', 'NOTICE', 'Procfile', 'Gemfile',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc', '.env',
]);

export function fileKind(path: string): ResultFileKind {
  const ext = extname(path).toLowerCase();
  if (MARKDOWN.has(ext)) return 'markdown';
  if (PDF.has(ext)) return 'pdf';
  const bin = BINARY_MIME[ext];
  if (bin) return bin.kind;
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(basename(path))) return 'text';
  return 'other';
}

/**
 * Content-Type для отдачи. Весь «текст» — text/plain, в том числе html и js:
 * отдавать их с родным типом значило бы исполнить чужой код на нашем
 * источнике, стоит открыть адрес вкладкой.
 */
export function fileContentType(path: string): string {
  const ext = extname(path).toLowerCase();
  const kind = fileKind(path);
  if (kind === 'markdown') return 'text/markdown; charset=utf-8';
  if (kind === 'text') return ext === '.json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
  return BINARY_MIME[ext]?.type ?? 'application/octet-stream';
}

// ------------------------------------------------------------ что принесла задача

const STATUS: Record<string, ResultFileStatus> = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' };

/**
 * Результат по коммиту слияния: база — первый родитель (основная ветка до
 * слияния), список — разница между ними. Переименования не склеиваем: для
 * показа «какие файлы теперь есть» удаление и добавление понятнее пары путей.
 * null — коммита нет или git не ответил.
 */
export async function deliveryAt(repo: string, commit: string, base?: string): Promise<TaskDelivery | null> {
  const full = await revision(repo, `${commit}^{commit}`);
  if (!full) return null;
  const from = base ?? await revision(repo, `${full}^1`) ?? EMPTY_TREE;
  if (from === full) return { commit: full, base: from, files: [] };
  const diff = await git(repo, ['diff', '--name-status', '--no-renames', '-z', from, full]);
  if (!diff.ok) return null;
  // -z: «статус\0путь\0» подряд — пути с пробелами и кириллицей без кавычек git.
  const parts = diff.stdout.split('\0').filter(Boolean);
  const files: ResultFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = STATUS[parts[i]![0] ?? ''];
    if (status) files.push({ path: parts[i + 1]!, status });
  }
  return { commit: full, base: from, files };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Найти коммит слияния задачи, влитой до того, как офис стал его запоминать.
 * Ищем по первой линии базовой ветки — на ней лежат ровно слияния в неё, а
 * «Merge branch 'main' into task/T-N» из самой ветки задачи туда не попадают.
 * Подходят слияния ветки `task/T-N` (у себя и пулл-реквестом) и squash с
 * заголовком «T-N: … (#12)», как его пишет GitHub.
 *
 * Номера задач в истории повторяются: в репозитории бывают старые ветки с тем
 * же номером от других задач (или других офисов). Поэтому берём коммит в
 * окне жизни задачи и ближайший к её завершению.
 */
export async function findMergeCommit(repo: string, task: Task): Promise<{ commit: string; base: string } | null> {
  const ref = (task.baseBranch && await revision(repo, task.baseBranch)) ? task.baseBranch : 'HEAD';
  const log = await git(repo, [
    'log', '--first-parent', '-F', `--grep=${task.id}`, '--format=%H%x1f%P%x1f%ct%x1f%s', ref,
  ]);
  if (!log.ok || !log.stdout) return null;
  const id = escapeRe(task.id);
  const branchRe = new RegExp(`task/${id}(?![\\d])`);
  const squashRe = new RegExp(`^${id}: .*\\(#\\d+\\)$`);
  const target = task.finishedAt ?? task.startedAt ?? task.createdAt;
  // Окно: слить раньше, чем задачу завели, нельзя; позже завершения — только
  // на сдвиг часов и медленный конвейер.
  const from = task.createdAt - 60 * 60 * 1000;
  const to = (task.finishedAt ?? Date.now()) + 2 * 24 * 60 * 60 * 1000;
  let best: { commit: string; base: string; gap: number } | null = null;
  for (const line of log.stdout.split('\n')) {
    const [hash, parentsRaw, time, subject = ''] = line.split('\x1f');
    if (!hash || !parentsRaw || !time) continue;
    const parents = parentsRaw.split(' ').filter(Boolean);
    const merge = parents.length >= 2 && branchRe.test(subject);
    const squash = parents.length === 1 && squashRe.test(subject);
    if (!merge && !squash) continue;
    const at = Number(time) * 1000;
    if (at < from || at > to) continue;
    const gap = Math.abs(at - target);
    if (!best || gap < best.gap) best = { commit: hash, base: parents[0]!, gap };
  }
  return best ? { commit: best.commit, base: best.base } : null;
}

// ------------------------------------------------------------ содержимое и LFS

interface TreeEntry { oid: string; size: number }

/** Блобы путей в коммите: хеш и размер. `--literal-pathspecs` — путь не маска. */
async function treeEntries(repo: string, commit: string, paths: string[]): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  if (!paths.length) return out;
  const r = await git(repo, ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', '--full-tree', commit, '--', ...paths]);
  if (!r.ok) return out;
  for (const rec of r.stdout.split('\0')) {
    // «<режим> <тип> <хеш> <размер>\t<путь>»
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [, type, oid, size] = rec.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' || !oid) continue;
    out.set(rec.slice(tab + 1), { oid, size: Number(size) || 0 });
  }
  return out;
}

interface LfsPointer { oid: string; size: number; raw: Buffer }

function parsePointer(bytes: Buffer): LfsPointer | null {
  if (bytes.length > LFS_POINTER_MAX) return null;
  const text = bytes.toString('utf8');
  if (!text.startsWith('version https://git-lfs.github.com/spec/')) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  return oid && size ? { oid, size: Number(size), raw: bytes } : null;
}

/**
 * Прочитать маленькие блобы разом через `cat-file --batch`: указатели LFS
 * ищутся среди всех файлов списка, и отдельный процесс git на каждый
 * мелкий файл сделал бы список задачи на сотню файлов заметно медленным.
 */
async function readSmallBlobs(repo: string, oids: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!oids.length) return out;
  const r = await gitBytes(repo, ['cat-file', '--batch'], { input: `${oids.join('\n')}\n` });
  if (!r.ok) return out;
  let at = 0;
  const buf = r.stdout;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const [oid, type, size] = buf.subarray(at, nl).toString('utf8').split(' ');
    at = nl + 1;
    if (type === 'missing' || !oid) continue;
    const n = Number(size) || 0;
    out.set(oid, buf.subarray(at, at + n));
    at += n + 1;   // содержимое и перевод строки после него
  }
  return out;
}

async function gitCommonDir(repo: string): Promise<string | null> {
  const r = await git(repo, ['rev-parse', '--git-common-dir']);
  return r.ok && r.stdout ? resolve(repo, r.stdout) : null;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Настоящее содержимое файла из LFS. Сначала то, что уже лежит на машине:
 * хранилище `.git/lfs/objects` и файл рабочего дерева, если он тот же самый
 * (сверяем хеш — дерево могли поправить после слияния). Только потом
 * `git lfs smudge`: он может пойти в сеть, и ждать его дольше всего.
 */
async function readLfs(repo: string, path: string, ptr: LfsPointer): Promise<Buffer | null> {
  const common = await gitCommonDir(repo);
  if (common) {
    const stored = join(common, 'lfs', 'objects', ptr.oid.slice(0, 2), ptr.oid.slice(2, 4), ptr.oid);
    try {
      if (existsSync(stored) && statSync(stored).size === ptr.size) return readFileSync(stored);
    } catch { /* нет доступа — пробуем дальше */ }
  }
  try {
    const top = await git(repo, ['rev-parse', '--show-toplevel']);
    const local = join(top.ok && top.stdout ? top.stdout : repo, path);
    if (existsSync(local) && statSync(local).size === ptr.size) {
      const bytes = readFileSync(local);
      if (sha256(bytes) === ptr.oid) return bytes;
    }
  } catch { /* файла нет или он другой */ }
  const smudge = await gitBytes(repo, ['lfs', 'smudge', '--', path], {
    input: ptr.raw, maxBytes: RESULT_FILE_MAX_BYTES + 1, timeoutMs: 120_000,
  });
  // Без git-lfs smudge вернёт ошибку, а с выключенным скачиванием — тот же
  // указатель: ни то ни другое содержимым не считается.
  if (!smudge.ok || parsePointer(smudge.stdout)) return null;
  return sha256(smudge.stdout) === ptr.oid ? smudge.stdout : null;
}

// ------------------------------------------------------------ задача → список и файл

type Resolved =
  | { ok: true; repo: string; delivery: TaskDelivery; source: 'saved' | 'log' | 'none' }
  | { ok: false; code: number; error: string };

/**
 * Результат задачи: сохранённый при слиянии или найденный по истории. Найденный
 * запоминаем в задаче — второй раз искать незачем, а коммит слияния из истории
 * основной ветки сам не денется.
 */
async function resolveDelivery(state: OfficeState, task: Task): Promise<Resolved> {
  if (task.status !== 'done') {
    return { ok: false, code: 409, error: state.say('files.notDone', { task: task.id }) };
  }
  const repo = taskRepo(task, state);
  const empty: TaskDelivery = { commit: '', base: '', files: [] };
  if (!(await isRepo(repo))) return { ok: true, repo, delivery: empty, source: 'none' };
  if (task.delivery) return { ok: true, repo, delivery: task.delivery, source: 'saved' };
  // Сданная без ветки (или без конвейера) задача в основную ветку ничего не
  // сливала: искать ей коммит — значит найти чужую задачу с тем же номером.
  if (!task.merged) return { ok: true, repo, delivery: empty, source: 'none' };
  const found = await findMergeCommit(repo, task);
  const delivery = found ? await deliveryAt(repo, found.commit, found.base) : null;
  if (!delivery) return { ok: true, repo, delivery: empty, source: 'none' };
  state.updateTask(task.id, { delivery });
  return { ok: true, repo, delivery, source: 'log' };
}

export async function taskFiles(state: OfficeState, task: Task): Promise<TaskFilesView | { code: number; error: string }> {
  const res = await resolveDelivery(state, task);
  if (!res.ok) return { code: res.code, error: res.error };
  const { repo, delivery, source } = res;
  const present = delivery.files.filter((f) => f.status !== 'deleted').map((f) => f.path);
  const entries = await treeEntries(repo, delivery.commit, present);
  const small = [...entries.values()].filter((e) => e.size <= LFS_POINTER_MAX).map((e) => e.oid);
  const blobs = await readSmallBlobs(repo, [...new Set(small)]);
  const files: ResultFileView[] = delivery.files.map((f) => {
    const entry = f.status === 'deleted' ? undefined : entries.get(f.path);
    const blob = entry ? blobs.get(entry.oid) : undefined;
    const ptr = blob ? parsePointer(blob) : null;
    return {
      path: f.path, status: f.status, kind: fileKind(f.path),
      size: entry ? (ptr ? ptr.size : entry.size) : null,
      lfs: Boolean(ptr),
    };
  });
  return {
    task: task.id, commit: delivery.commit || null, base: delivery.base || null, source, files,
  };
}

export type FileRead =
  | { ok: true; bytes: Buffer; type: string }
  | { ok: false; code: number; error: string };

/** Содержимое одного файла результата — только если путь есть в списке задачи. */
export async function readTaskFile(state: OfficeState, task: Task, path: string): Promise<FileRead> {
  // Путь сверяется со списком дословно, так что «..» и абсолютные пути туда не
  // пройдут и без этой строки; но отказ по форме понятнее «нет в списке».
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    return { ok: false, code: 400, error: state.say('files.badPath', { path }) };
  }
  const res = await resolveDelivery(state, task);
  if (!res.ok) return res;
  const file = res.delivery.files.find((f) => f.path === path);
  if (!file) return { ok: false, code: 404, error: state.say('files.notInTask', { path, task: task.id }) };
  if (file.status === 'deleted') {
    return { ok: false, code: 410, error: state.say('files.deleted', { path, task: task.id }) };
  }
  const tooBig = (size: number): FileRead => ({
    ok: false, code: 413,
    error: state.say('files.tooBig', {
      path, size: Math.ceil(size / 1024 / 1024), max: RESULT_FILE_MAX_BYTES / 1024 / 1024,
    }),
  });
  const unreadable: FileRead = { ok: false, code: 500, error: state.say('files.unreadable', { path }) };

  const entry = (await treeEntries(res.repo, res.delivery.commit, [path])).get(path);
  if (!entry) return unreadable;
  if (entry.size > RESULT_FILE_MAX_BYTES) return tooBig(entry.size);
  const blob = await gitBytes(res.repo, ['cat-file', 'blob', entry.oid], { maxBytes: RESULT_FILE_MAX_BYTES + 1 });
  if (!blob.ok) return unreadable;
  const type = fileContentType(path);
  const ptr = parsePointer(blob.stdout);
  if (!ptr) return { ok: true, bytes: blob.stdout, type };
  if (ptr.size > RESULT_FILE_MAX_BYTES) return tooBig(ptr.size);
  const real = await readLfs(res.repo, path, ptr);
  if (!real) return { ok: false, code: 502, error: state.say('files.lfsMissing', { path }) };
  return { ok: true, bytes: real, type };
}

// ------------------------------------------------------------ HTTP

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/** Офис и задача запроса. Как у журнала: офис не поднимаем ради чтения. */
function taskOf(res: ServerResponse, params: URLSearchParams): { state: OfficeState; task: Task } | null {
  const wantedId = params.get('office');
  const office = wantedId ? officeById(wantedId) : currentOffice();
  if (!office) {
    json(res, 404, { error: c('offices.notFound', { id: wantedId ?? '' }) });
    return null;
  }
  if (!isOpened(office.id)) {
    json(res, 503, { error: c('files.closed', { office: office.name }) });
    return null;
  }
  const state = getOffice(office.id);
  const id = params.get('task') ?? '';
  const task = state.tasks.get(id);
  if (!task) {
    json(res, 404, { error: state.say('files.noTask', { task: id }) });
    return null;
  }
  return { state, task };
}

async function serveList(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const found = taskOf(res, params);
  if (!found) return;
  const view = await taskFiles(found.state, found.task);
  if ('error' in view) json(res, view.code, { error: view.error });
  else json(res, 200, view);
}

async function serveFile(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const found = taskOf(res, params);
  if (!found) return;
  const path = params.get('path') ?? '';
  const read = await readTaskFile(found.state, found.task, path);
  if (!read.ok) {
    json(res, read.code, { error: read.error });
    return;
  }
  res.writeHead(200, {
    'Content-Type': read.type,
    'Content-Length': String(read.bytes.length),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
    // Содержимое коммита не меняется: коммит — часть адреса ответа по смыслу,
    // но задачу могут перезапустить и слить заново, так что кеш — ненадолго.
    'Cache-Control': 'private, max-age=60',
    // Файл пришёл из работы агента: браузеру не угадывать тип и ничего из
    // него не исполнять — SVG и html открывают и вкладкой.
    'X-Content-Type-Options': 'nosniff',
    // PDF — исключение: встроенный просмотрщик Chromium (и окна приложения)
    // не открывается ни в песочнице, ни под object-src 'none', который
    // включает default-src. Тип при этом зафиксирован nosniff, а PDF рисует
    // сам браузер, не страница офиса.
    ...(read.type === 'application/pdf' ? {} : {
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    }),
  });
  res.end(read.bytes);
}

/** Разобрать запрос, если он про файлы результата. `false` — адрес не наш. */
export function handleTaskFiles(req: IncomingMessage, res: ServerResponse, url: string, query: string): boolean {
  if (url !== '/api/task/files' && url !== '/api/task/file') return false;
  if (req.method !== 'GET') {
    json(res, 405, { error: c('files.getOnly') }, { Allow: 'GET' });
    return true;
  }
  const params = new URLSearchParams(query);
  const serve = url === '/api/task/files' ? serveList : serveFile;
  serve(res, params).catch((err: unknown) => {
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  });
  return true;
}

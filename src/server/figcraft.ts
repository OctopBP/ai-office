/**
 * Макеты FigCraft: где лежат файлы `.figcraft` и как открыть их владельцу в
 * десктопном приложении FigCraft на машине сервера.
 *
 *   GET  /api/figcraft/files?office=<id>[&task=T-N]  — список (FigcraftFilesView);
 *   POST /api/figcraft/open  { office, path }        — открыть файл (FigcraftOpenResult).
 *
 * Дизайнер сохраняет макет в рабочую копию своей задачи. Пока задача не
 * влита, файл живёт только там; после слияния — в основной рабочей директории
 * офиса. Поэтому список задачи берётся из живой копии (то, что задача
 * добавила или поменяла от точки ветвления, включая незакоммиченное), а у
 * влитой — из списка файлов слияния (taskfiles.ts) с диска основной директории.
 * Без задачи — все `.figcraft` основной директории, кроме node_modules, .git и
 * копий задач офиса.
 *
 * Открытие — запуск чужой программы с путём из запроса, поэтому:
 * - только `.figcraft`, и настоящий путь (после всех ссылок) лежит внутри
 *   папки офиса или копии его задачи;
 * - запуск через execFile-подобный spawn с массивом аргументов, без шелла;
 * - окно откроется на машине сервера, так что открытый наружу офис открывает
 *   макет только на запрос с этой же машины.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  FigcraftAppStatus, FigcraftFile, FigcraftFileSource, FigcraftFilesView, FigcraftOpenErrorCode,
  FigcraftOpenResult,
} from '../shared/types';
import type { Lang } from '../shared/i18n';
import { git, isRepo, liveBase, revision } from './git';
import { c, t } from './i18n';
import { readBody } from './officeicon';
import { currentOffice, officeById } from './offices';
import { getOffice, isOpened, taskRepo, worktreesRoot, type OfficeState, type Task } from './state';
import { taskFiles } from './taskfiles';
import { DEV_ORIGINS, isExposed } from './terminal';

export const FIGCRAFT_EXT = '.figcraft';
export const FIGCRAFT_DOCS = 'docs/design/figcraft/setup.md';
/** Переменная окружения сервера с путём к приложению — по образцу FIGCRAFT_CLI. */
export const FIGCRAFT_APP_ENV = 'FIGCRAFT_APP';

/** Потолки обхода: основная директория офиса бывает большой, а ответ нужен быстро. */
const SCAN_MAX_FILES = 2000;
const SCAN_MAX_DIRS = 20000;
const SCAN_MAX_DEPTH = 16;
/** Каталоги, в которых макетов не бывает, а файлов — тысячи. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.office']);

/** Тело POST: путь и id офиса, с запасом на длинные кириллические пути. */
const OPEN_BODY_MAX = 16 * 1024;

const isFigcraft = (path: string): boolean => extname(path).toLowerCase() === FIGCRAFT_EXT;

// ------------------------------------------------------------ приложение

export interface FigcraftApp {
  path: string;
  /** Бандл macOS открывается через `open -a`, исполняемый файл — напрямую. */
  kind: 'bundle' | 'binary';
}

export interface AppLookup {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (path: string) => boolean;
}

/** Куда приложение ставится по умолчанию — по порядку поиска. */
export function appCandidates(lookup: AppLookup = {}): string[] {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const home = lookup.home ?? homedir();
  if (platform === 'darwin') {
    return ['/Applications/FigCraft.app', join(home, 'Applications', 'FigCraft.app')];
  }
  if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']];
    return roots.filter((r): r is string => Boolean(r)).map((r) => join(r, 'FigCraft', 'FigCraft.exe'));
  }
  // Linux и прочее: установщика нет, ищем бинарник `figcraft` в PATH.
  return (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'figcraft'));
}

const kindOf = (path: string): FigcraftApp['kind'] =>
  /\.app\/?$/i.test(path) ? 'bundle' : 'binary';

/**
 * Найти десктопный FigCraft. Сначала `FIGCRAFT_APP` — если задана, другие
 * места не смотрим: владелец явно сказал, где приложение, и молча открыть
 * другую версию было бы хуже честного «не найдено».
 */
export function findFigcraftApp(lookup: AppLookup = {}): FigcraftApp | null {
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? existsSync;
  const fromEnv = env[FIGCRAFT_APP_ENV]?.trim();
  if (fromEnv) return exists(fromEnv) ? { path: fromEnv, kind: kindOf(fromEnv) } : null;
  const found = appCandidates(lookup).find((p) => exists(p));
  return found ? { path: found, kind: kindOf(found) } : null;
}

/** Текст «приложения нет» с тем, что и куда поставить. */
export function noAppMessage(lang: Lang, lookup: AppLookup = {}): string {
  const fromEnv = (lookup.env ?? process.env)[FIGCRAFT_APP_ENV]?.trim();
  if (fromEnv) return t(lang, 'figcraft.noAppEnv', { path: fromEnv });
  const where = appCandidates(lookup)[0] ?? 'PATH';
  return t(lang, 'figcraft.noApp', { where: (lookup.platform ?? process.platform) === 'linux' ? 'PATH' : where });
}

/**
 * Команда открытия без шелла. Бандл macOS регистрирует тип `.figcraft`
 * (UTI ai.storyteller.figcraft.document), но `-a` с путём бандла открывает
 * именно этот FigCraft, а не тот, что Launch Services считает главным.
 */
export function openCommand(app: FigcraftApp, file: string): { cmd: string; args: string[] } {
  if (app.kind === 'bundle') return { cmd: 'open', args: ['-a', app.path, file] };
  return { cmd: app.path, args: [file] };
}

export type LaunchResult = { ok: true } | { ok: false; message: string };
export type Launcher = (cmd: string, args: string[]) => Promise<LaunchResult>;

/**
 * Запуск по умолчанию. `open` дожидаемся: он сам быстро выходит и кодом
 * говорит, получилось ли. Бинарник живёт как окно — ждём только старта и
 * отвязываем от сервера, чтобы он пережил его перезапуск.
 */
export const spawnLauncher: Launcher = (cmd, args) => new Promise((done) => {
  let settled = false;
  const finish = (r: LaunchResult): void => { if (!settled) { settled = true; done(r); } };
  const waitExit = cmd === 'open';
  const child = spawn(cmd, args, {
    shell: false, detached: !waitExit, stdio: waitExit ? ['ignore', 'ignore', 'pipe'] : 'ignore', windowsHide: false,
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
  child.on('error', (err) => finish({ ok: false, message: err.message }));
  if (waitExit) {
    child.on('exit', (code) => finish(code === 0
      ? { ok: true }
      : { ok: false, message: stderr.trim() || `open завершился с кодом ${code}` }));
  } else {
    child.on('spawn', () => { child.unref(); finish({ ok: true }); });
  }
});

// ------------------------------------------------------------ путь

export type PathCheck =
  | { ok: true; real: string }
  | { ok: false; code: 'bad-path' | 'not-found'; key: 'figcraft.notFigcraft' | 'figcraft.badPath' | 'figcraft.notFound' };

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' ? false : !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Можно ли открыть этот файл. Путь — абсолютный (так его отдаёт список) или
 * относительный от первого корня. Расширение проверяется и у пути из запроса,
 * и у настоящего файла: ссылка «a.figcraft → ~/.ssh/id_rsa» не пройдёт ни по
 * корням, ни по расширению.
 */
export function checkFigcraftPath(raw: string, roots: string[]): PathCheck {
  const path = (raw ?? '').trim();
  if (!path || path.includes('\0')) return { ok: false, code: 'bad-path', key: 'figcraft.badPath' };
  if (!isFigcraft(path)) return { ok: false, code: 'bad-path', key: 'figcraft.notFigcraft' };
  if (path.split(/[\\/]/).includes('..')) return { ok: false, code: 'bad-path', key: 'figcraft.badPath' };
  const real = (p: string): string | null => {
    try { return realpathSync(p); } catch { return null; }
  };
  const tops = roots.map(real).filter((r): r is string => Boolean(r));
  if (!tops.length) return { ok: false, code: 'bad-path', key: 'figcraft.badPath' };
  const full = isAbsolute(path) ? path : resolve(tops[0]!, path);
  // Снаружи корней «нет такого файла» не говорим: это подсказывало бы, что
  // лежит на машине.
  const fullInside = roots.some((r) => inside(resolve(r), full)) || tops.some((r) => inside(r, full));
  if (!fullInside) return { ok: false, code: 'bad-path', key: 'figcraft.badPath' };
  if (!existsSync(full)) return { ok: false, code: 'not-found', key: 'figcraft.notFound' };
  const target = real(full);
  if (!target) return { ok: false, code: 'not-found', key: 'figcraft.notFound' };
  if (!isFigcraft(target) || !tops.some((r) => inside(r, target))) {
    return { ok: false, code: 'bad-path', key: 'figcraft.badPath' };
  }
  if (target.split(sep).some((p) => p.toLowerCase() === '.git')) {
    return { ok: false, code: 'bad-path', key: 'figcraft.badPath' };
  }
  try {
    if (!statSync(target).isFile()) return { ok: false, code: 'not-found', key: 'figcraft.notFound' };
  } catch {
    return { ok: false, code: 'not-found', key: 'figcraft.notFound' };
  }
  return { ok: true, real: target };
}

/**
 * Корни, внутри которых офис открывает макеты: основная директория, папки
 * подпроектов задач и копии задач (общая папка worktree офиса и каждая
 * записанная копия — она могла остаться от прежнего расположения папки).
 */
export function officeRoots(state: OfficeState): string[] {
  const out = new Set<string>();
  if (state.projectDir) out.add(resolve(state.projectDir));
  out.add(resolve(worktreesRoot(state)));
  for (const task of state.tasks.values()) {
    if (task.repoDir) out.add(resolve(task.repoDir));
    if (task.worktreePath) out.add(resolve(task.worktreePath));
  }
  return [...out];
}

// ------------------------------------------------------------ список

function entry(root: string, rel: string, source: FigcraftFileSource): FigcraftFile | null {
  const abs = resolve(root, rel);
  try {
    const st = lstatSync(abs);
    if (!st.isFile()) return null;
    return { path: rel.split(sep).join('/'), absPath: abs, source, size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

/**
 * Все `.figcraft` под корнем. Символические ссылки не проходим вовсе — ни
 * каталоги, ни файлы: так обход не выйдет наружу и не зациклится. `skip` —
 * абсолютные каталоги, куда не заходить (копии задач, если они под корнем).
 */
export function scanFigcraft(
  root: string, source: FigcraftFileSource, skip: string[] = [],
): { files: FigcraftFile[]; truncated: boolean } {
  const files: FigcraftFile[] = [];
  const skipped = new Set(skip.flatMap((s) => {
    const out = [resolve(s)];
    try { out.push(realpathSync(s)); } catch { /* каталога нет — и не надо */ }
    return out;
  }));
  let dirs = 0;
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (truncated) return;
    if (++dirs > SCAN_MAX_DIRS) { truncated = true; return; }
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (truncated) return;
      const abs = join(dir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name) || skipped.has(abs) || depth >= SCAN_MAX_DEPTH) continue;
        walk(abs, depth + 1);
      } else if (item.isFile() && isFigcraft(item.name)) {
        const file = entry(root, relative(root, abs), source);
        if (file) files.push(file);
        if (files.length >= SCAN_MAX_FILES) truncated = true;
      }
    }
  };
  if (existsSync(root)) walk(resolve(root), 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated };
}

const splitZ = (s: string): string[] => s.split('\0').filter(Boolean);

/**
 * Макеты, которые задача добавила или поменяла в своей копии: разница с
 * точкой ветвления от базовой ветки (вместе с незакоммиченным) и новые
 * неотслеживаемые файлы. null — копия не под git или база не нашлась; тогда
 * вызывающий обходит копию целиком.
 */
export async function worktreeChanges(worktree: string, baseBranch: string | null): Promise<string[] | null> {
  if (!(await isRepo(worktree))) return null;
  const base = baseBranch ? await liveBase(worktree, baseBranch) : null;
  const baseSha = base ? await revision(worktree, base) : null;
  if (!baseSha) return null;
  const fork = await git(worktree, ['merge-base', 'HEAD', baseSha]);
  if (!fork.ok || !fork.stdout.trim()) return null;
  const [diff, untracked] = await Promise.all([
    git(worktree, ['diff', '--name-only', '--no-renames', '--diff-filter=d', '-z', fork.stdout.trim()]),
    git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (!diff.ok || !untracked.ok) return null;
  return [...new Set([...splitZ(diff.stdout), ...splitZ(untracked.stdout)])].filter(isFigcraft);
}

export interface TaskListInput {
  /** Живая копия задачи — путь, если каталог есть на диске. */
  worktree: string | null;
  baseBranch: string | null;
  /** Директория, куда задача влита (основная или подпроекта). */
  mainDir: string;
  /** Пути файлов слияния без удалённых; null — задача не влита. */
  merged: () => Promise<string[] | null>;
}

/**
 * Выбор источника списка задачи: живая копия важнее — в ней свежее, в том
 * числе несохранённое в коммит. Нет копии — файлы слияния с диска основной
 * директории (те, что с тех пор удалили, не показываем).
 */
export async function taskFigcraftList(
  input: TaskListInput,
): Promise<{ source: FigcraftFileSource | 'none'; files: FigcraftFile[]; truncated: boolean }> {
  if (input.worktree && existsSync(input.worktree)) {
    const changed = await worktreeChanges(input.worktree, input.baseBranch);
    if (!changed) return { source: 'worktree', ...scanFigcraft(input.worktree, 'worktree') };
    const files = changed.map((p) => entry(input.worktree!, p, 'worktree')).filter((f): f is FigcraftFile => Boolean(f));
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { source: 'worktree', files, truncated: false };
  }
  const merged = await input.merged();
  if (!merged) return { source: 'none', files: [], truncated: false };
  const files = merged.filter(isFigcraft)
    .map((p) => entry(input.mainDir, p, 'main'))
    .filter((f): f is FigcraftFile => Boolean(f));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { source: 'main', files, truncated: false };
}

async function mergedPaths(state: OfficeState, task: Task): Promise<string[] | null> {
  if (task.status !== 'done') return null;
  const view = await taskFiles(state, task);
  if ('error' in view) return null;
  return view.files.filter((f) => f.status !== 'deleted').map((f) => f.path);
}

// ------------------------------------------------------------ доступ

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

export interface OpenAccessInput {
  exposed: boolean;
  /** `req.socket.remoteAddress`. */
  remoteAddress?: string;
  /** Есть заголовки прокси (X-Forwarded-For, Forwarded, X-Real-IP). */
  forwarded: boolean;
  origin?: string;
  host?: string;
  publicUrl?: string;
}

export type OpenAccess = { ok: true } | { ok: false; code: 'remote' | 'forbidden' };

/**
 * Можно ли открыть окно на машине сервера по этому запросу.
 * - Запрос не с этой машины (или через прокси) у открытого наружу офиса —
 *   нельзя: окно открылось бы не у того, кто нажал кнопку.
 * - Страница чужая (`Origin` не совпадает с адресом офиса) — нельзя ни в
 *   каком режиме: иначе любая вкладка браузера владельца запускала бы
 *   программы на 127.0.0.1.
 */
export function openAccess(input: OpenAccessInput): OpenAccess {
  const local = Boolean(input.remoteAddress && LOOPBACK.test(input.remoteAddress)) && !input.forwarded;
  if (input.exposed && !local) return { ok: false, code: 'remote' };
  if (input.exposed && input.publicUrl && input.host) {
    // Пришло через шлюз публичного адреса на этой же машине — всё равно издалека.
    try {
      if (new URL(input.publicUrl).host.toLowerCase() === input.host.toLowerCase()) return { ok: false, code: 'remote' };
    } catch { /* кривой адрес — проверка ниже */ }
  }
  const origin = input.origin?.trim();
  if (origin) {
    let own: string | null = null;
    try { own = new URL(origin).host.toLowerCase(); } catch { own = null; }
    const same = own !== null && own === (input.host ?? '').toLowerCase();
    if (!same && !(!input.exposed && DEV_ORIGINS.includes(origin))) return { ok: false, code: 'forbidden' };
  }
  return { ok: true };
}

function accessOf(req: IncomingMessage, env: FigcraftHttpEnv): OpenAccess {
  const h = req.headers;
  return openAccess({
    exposed: env.exposed(),
    remoteAddress: req.socket?.remoteAddress,
    forwarded: Boolean(h['x-forwarded-for'] || h.forwarded || h['x-real-ip']),
    origin: typeof h.origin === 'string' ? h.origin : undefined,
    host: h.host,
    publicUrl: env.env.OFFICE_PUBLIC_URL?.trim() || undefined,
  });
}

// ------------------------------------------------------------ HTTP

/** Что ручка берёт снаружи. Подменяется в проверке (scripts/test-figcraft.ts). */
export interface FigcraftHttpEnv {
  exposed: () => boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  launch: Launcher;
  /** Открытый офис по id (без id — текущий) или отказ. */
  office: (wanted: string | null) => { state: OfficeState } | { code: number; error: string };
}

const defaultEnv: FigcraftHttpEnv = {
  exposed: () => isExposed(),
  env: process.env,
  platform: process.platform,
  launch: spawnLauncher,
  office: (wanted) => {
    const office = wanted ? officeById(wanted) : currentOffice();
    if (!office) return { code: 404, error: c('offices.notFound', { id: wanted ?? '' }) };
    // Как у файлов задачи: офис ради списка макетов не поднимаем.
    if (!isOpened(office.id)) return { code: 503, error: c('figcraft.closed', { office: office.name }) };
    return { state: getOffice(office.id) };
  },
};

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function appStatus(state: OfficeState, req: IncomingMessage, env: FigcraftHttpEnv): FigcraftAppStatus {
  const lookup: AppLookup = { env: env.env, platform: env.platform };
  const app = findFigcraftApp(lookup);
  const access = accessOf(req, env);
  // Чужая страница для списка не довод: список читают и с dev-сервера vite.
  const remote = !access.ok && access.code === 'remote';
  const reason = !app ? noAppMessage(state.lang(), lookup) : remote ? state.say('figcraft.remote') : null;
  return { found: Boolean(app), path: app?.path ?? null, canOpen: Boolean(app) && !remote, reason, docs: FIGCRAFT_DOCS };
}

export async function serveFigcraftList(
  req: IncomingMessage, res: ServerResponse, params: URLSearchParams, env: FigcraftHttpEnv = defaultEnv,
): Promise<void> {
  const found = env.office(params.get('office'));
  if ('error' in found) {
    json(res, found.code, { error: found.error });
    return;
  }
  const { state } = found;
  const taskId = params.get('task');
  let listed: { source: FigcraftFileSource | 'none'; files: FigcraftFile[]; truncated: boolean };
  if (taskId) {
    const task = state.tasks.get(taskId);
    if (!task) {
      json(res, 404, { error: state.say('files.noTask', { task: taskId }) });
      return;
    }
    listed = await taskFigcraftList({
      worktree: task.worktreePath,
      baseBranch: task.baseBranch,
      mainDir: taskRepo(task, state),
      merged: () => mergedPaths(state, task),
    });
  } else {
    listed = { source: 'main', ...scanFigcraft(state.projectDir, 'main', [worktreesRoot(state)]) };
  }
  const view: FigcraftFilesView = {
    office: state.officeId, task: taskId, ...listed, app: appStatus(state, req, env),
  };
  json(res, 200, view);
}

function fail(res: ServerResponse, status: number, code: FigcraftOpenErrorCode, error: string, docs?: string): void {
  const body: FigcraftOpenResult = { ok: false, code, error, ...(docs ? { docs } : {}) };
  json(res, status, body);
}

export async function serveFigcraftOpen(
  req: IncomingMessage, res: ServerResponse, env: FigcraftHttpEnv = defaultEnv,
): Promise<void> {
  // Доступ — до чтения тела: чужому незачем узнавать, есть ли такой файл.
  const access = accessOf(req, env);
  if (!access.ok) {
    fail(res, 403, access.code, c(access.code === 'remote' ? 'figcraft.remote' : 'figcraft.foreign'));
    return;
  }
  const body = await readBody(req, OPEN_BODY_MAX);
  if (!('bytes' in body)) {
    fail(res, 'over' in body ? 413 : 400, 'bad-request', c('figcraft.badRequest'));
    return;
  }
  let input: { office?: unknown; path?: unknown };
  try {
    input = JSON.parse(body.bytes.toString('utf8')) as typeof input;
  } catch {
    fail(res, 400, 'bad-request', c('figcraft.badRequest'));
    return;
  }
  if (!input || typeof input !== 'object' || typeof input.path !== 'string'
    || (input.office !== undefined && input.office !== null && typeof input.office !== 'string')) {
    fail(res, 400, 'bad-request', c('figcraft.badRequest'));
    return;
  }
  const found = env.office((input.office as string | null | undefined) || null);
  if ('error' in found) {
    fail(res, found.code, 'closed', found.error);
    return;
  }
  const { state } = found;
  const check = checkFigcraftPath(input.path, officeRoots(state));
  if (!check.ok) {
    fail(res, check.code === 'not-found' ? 404 : 400, check.code, state.say(check.key, { path: input.path }));
    return;
  }
  const lookup: AppLookup = { env: env.env, platform: env.platform };
  const app = findFigcraftApp(lookup);
  if (!app) {
    fail(res, 503, 'no-app', noAppMessage(state.lang(), lookup), FIGCRAFT_DOCS);
    return;
  }
  const { cmd, args } = openCommand(app, check.real);
  const launched = await env.launch(cmd, args);
  if (!launched.ok) {
    fail(res, 500, 'launch-failed', state.say('figcraft.launchFailed', { reason: launched.message }), FIGCRAFT_DOCS);
    return;
  }
  const ok: FigcraftOpenResult = { ok: true, path: check.real, app: app.path };
  json(res, 200, ok);
}

/** Разобрать запрос, если он про макеты FigCraft. `false` — адрес не наш. */
export function handleFigcraft(
  req: IncomingMessage, res: ServerResponse, url: string, query: string, env: FigcraftHttpEnv = defaultEnv,
): boolean {
  if (url !== '/api/figcraft/files' && url !== '/api/figcraft/open') return false;
  const list = url === '/api/figcraft/files';
  const method = list ? 'GET' : 'POST';
  if (req.method !== method) {
    json(res, 405, { error: c(list ? 'figcraft.getOnly' : 'figcraft.postOnly') }, { Allow: method });
    return true;
  }
  const work = list ? serveFigcraftList(req, res, new URLSearchParams(query), env) : serveFigcraftOpen(req, res, env);
  work.catch((err: unknown) => {
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  });
  return true;
}

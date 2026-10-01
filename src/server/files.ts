/**
 * Просмотр файла проекта по пути: владелец щёлкает «docs/design/T-189/ui.md»
 * в чате с PM — и видит файл в приложении, без файловой системы.
 *
 *   GET /api/file?office=<id>&path=<путь>[&task=T-N][&base=<каталог>]
 *
 * Без задачи файл читается из основной ветки репозитория офиса. С задачей —
 * сначала из её работы: рабочая копия (пока задача идёт или ждёт ревью), её
 * ветка, коммит слияния (ветку после слияния удаляют); не нашёлся там — из
 * основной ветки. Так открывается и файл, который задача только пишет, и
 * файл, который она лишь упомянула.
 *
 * `base` — для короткого имени: «providers-tab.png» без каталогов ищется
 * сначала в `base` (веб берёт каталог соседней ссылки того же сообщения),
 * потом в корне.
 *
 * Путь приходит из текста, написанного агентом, поэтому до файловой системы и
 * git он доходит только после проверки: относительный, без «..», не в .git и
 * не .env*, а на диске — без символических ссылок наружу. Содержимое, типы и
 * заголовки — общие с результатом задачи (taskfiles.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';
import { baseBranch, isRepo, liveBase, revision } from './git';
import { c } from './i18n';
import { currentOffice, officeById } from './offices';
import { getOffice, isOpened, taskRepo, type OfficeState, type Task } from './state';
import {
  RESULT_FILE_MAX_BYTES, fileContentType, readCommitFile, sendFileBytes, tooBigFile, type FileRead,
} from './taskfiles';

/** Откуда в итоге взят файл — уходит заголовком `X-Office-File-Source`. */
export type FileSource = 'worktree' | 'branch' | 'delivery' | 'main' | 'disk';

// ------------------------------------------------------------ путь

/**
 * Привести путь из запроса к виду «a/b/c» или отказать (null). Обратные
 * слеши — тоже разделители: агент на Windows пишет пути с ними, а пропустить
 * «..\\» мимо проверки значило бы выйти из репозитория.
 */
export function cleanPath(raw: string): string | null {
  if (!raw || raw.includes('\0')) return null;
  const slashed = raw.trim().replace(/\\/g, '/');
  // Абсолютный путь, диск Windows и UNC — отказ, а не «обрежем до относительного».
  if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) return null;
  const parts = slashed.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.includes('..')) return null;
  const path = parts.join('/');
  return forbidden(path) ? null : path;
}

/** .git в любом месте пути и файлы окружения (.env, .env.local…) не отдаём. */
function forbidden(path: string): boolean {
  const parts = path.split('/');
  if (parts.some((p) => p.toLowerCase() === '.git')) return true;
  return /^\.env(\.|$)/i.test(parts[parts.length - 1] ?? '');
}

/**
 * Кандидаты пути по порядку. Короткое имя с `base` ищется сначала в нём;
 * негодный `base` просто не участвует — имя всё равно ищется в корне.
 */
export function candidatePaths(rawPath: string, rawBase: string | null): string[] | null {
  const path = cleanPath(rawPath);
  if (!path) return null;
  const short = !rawPath.trim().replace(/\\/g, '/').includes('/');
  const base = short && rawBase ? cleanDir(rawBase) : null;
  const out = base ? [posix.join(base, path), path] : [path];
  return out.filter((p) => !forbidden(p));
}

/** Каталог для короткого имени: те же правила, что у пути. */
function cleanDir(raw: string): string | null {
  return cleanPath(raw.replace(/[\\/]+$/, ''));
}

// ------------------------------------------------------------ источники

interface Source {
  kind: FileSource;
  read: (state: OfficeState, path: string) => Promise<FileRead | null>;
}

/** Файл из коммита; null — такого файла там нет (пробовать следующий источник). */
function commitSource(kind: FileSource, repo: string, ref: string): Source {
  return {
    kind,
    read: async (state, path) => {
      const read = await readCommitFile(state, repo, ref, path, '');
      return !read.ok && read.code === 404 ? null : read;
    },
  };
}

/**
 * Файл с диска внутри `root`. Настоящий путь (после всех символических ссылок)
 * обязан остаться внутри настоящего `root` и сам не попасть под запрет: иначе
 * ссылка «docs/x → ../../.ssh/id_rsa» или «a → .git/config» стала бы лазейкой.
 */
function diskSource(kind: FileSource, root: string): Source {
  return {
    kind,
    read: async (state, path) => {
      let top: string;
      let real: string;
      try {
        top = realpathSync(root);
        const full = resolve(top, path);
        if (!existsSync(full)) return null;
        real = realpathSync(full);
      } catch {
        return null;
      }
      const rel = relative(top, real);
      if (!rel || rel.startsWith('..') || rel.startsWith(sep) || forbidden(rel.split(sep).join('/'))) {
        return { ok: false, code: 400, error: state.say('file.badPath', { path }) };
      }
      const stat = statSync(real);
      if (!stat.isFile()) return null;
      if (stat.size > RESULT_FILE_MAX_BYTES) return tooBigFile(state, path, stat.size);
      try {
        return { ok: true, bytes: readFileSync(real), type: fileContentType(path) };
      } catch {
        return { ok: false, code: 500, error: state.say('file.unreadable', { path }) };
      }
    },
  };
}

/**
 * Основная ветка репозитория. Не репозиторий (или в нём нет ни одного
 * коммита) — сама папка на диске: проект офиса не обязан быть под git.
 */
async function mainSource(repo: string, recorded: string | null): Promise<Source> {
  if (await isRepo(repo)) {
    const branch = recorded ? await liveBase(repo, recorded) : await baseBranch(repo);
    const commit = branch ? await revision(repo, branch) : null;
    if (commit) return commitSource('main', repo, commit);
  }
  return diskSource('disk', repo);
}

/**
 * Источники задачи по порядку: рабочая копия — самое свежее (в ней и
 * несохранённые в коммит правки), потом ветка, потом коммит слияния, и в конце
 * основная ветка репозитория задачи.
 */
async function taskSources(state: OfficeState, task: Task): Promise<Source[]> {
  const repo = taskRepo(task, state);
  const out: Source[] = [];
  if (task.worktreePath && existsSync(task.worktreePath)) out.push(diskSource('worktree', task.worktreePath));
  if (await isRepo(repo)) {
    const branch = task.branch ? await revision(repo, task.branch) : null;
    if (branch) out.push(commitSource('branch', repo, branch));
    const merged = task.delivery?.commit ? await revision(repo, `${task.delivery.commit}^{commit}`) : null;
    if (merged) out.push(commitSource('delivery', repo, merged));
  }
  out.push(await mainSource(repo, task.baseBranch));
  return out;
}

export type ProjectFileRead =
  | { ok: true; bytes: Buffer; type: string; path: string; source: FileSource }
  | { ok: false; code: number; error: string };

/**
 * Найти и прочитать файл. Перебор — источник за источником, внутри источника
 * кандидаты пути: файл задачи в `base` важнее одноимённого файла в корне main.
 * Отказ источника (слишком большой, не читается) — окончательный ответ:
 * подсунуть вместо него другую версию файла значило бы показать не то.
 */
export async function readProjectFile(
  state: OfficeState, rawPath: string, opts: { task?: Task | null; base?: string | null } = {},
): Promise<ProjectFileRead> {
  const paths = candidatePaths(rawPath, opts.base ?? null);
  if (!paths?.length) return { ok: false, code: 400, error: state.say('file.badPath', { path: rawPath }) };
  const sources = opts.task
    ? await taskSources(state, opts.task)
    : [await mainSource(state.projectDir, null)];
  for (const source of sources) {
    for (const path of paths) {
      const read = await source.read(state, path);
      if (!read) continue;
      if (!read.ok) return read;
      return { ...read, path, source: source.kind };
    }
  }
  return {
    ok: false, code: 404,
    error: opts.task
      ? state.say('file.notFoundTask', { path: paths[0]!, task: opts.task.id })
      : state.say('file.notFound', { path: paths[0]! }),
  };
}

// ------------------------------------------------------------ HTTP

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

async function serve(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const wantedId = params.get('office');
  const office = wantedId ? officeById(wantedId) : currentOffice();
  if (!office) {
    json(res, 404, { error: c('offices.notFound', { id: wantedId ?? '' }) });
    return;
  }
  // Как журнал и результат задачи: офис ради чтения файла не поднимаем.
  if (!isOpened(office.id)) {
    json(res, 503, { error: c('file.closed', { office: office.name }) });
    return;
  }
  const state = getOffice(office.id);
  const taskId = params.get('task');
  let task: Task | null = null;
  if (taskId) {
    task = state.tasks.get(taskId) ?? null;
    if (!task) {
      json(res, 404, { error: state.say('files.noTask', { task: taskId }) });
      return;
    }
  }
  const read = await readProjectFile(state, params.get('path') ?? '', { task, base: params.get('base') });
  if (!read.ok) {
    json(res, read.code, { error: read.error });
    return;
  }
  sendFileBytes(res, read.path, read.bytes, read.type, {
    // Рабочую копию правят прямо сейчас: кешировать её нельзя совсем.
    ...(read.source === 'worktree' || read.source === 'disk' ? { 'Cache-Control': 'no-store' } : {}),
    'X-Office-File-Source': read.source,
    'X-Office-File-Path': encodeURIComponent(read.path),
  });
}

/** Разобрать запрос, если он про файл проекта. `false` — адрес не наш. */
export function handleProjectFile(req: IncomingMessage, res: ServerResponse, url: string, query: string): boolean {
  if (url !== '/api/file') return false;
  if (req.method !== 'GET') {
    json(res, 405, { error: c('file.getOnly') }, { Allow: 'GET' });
    return true;
  }
  serve(res, new URLSearchParams(query)).catch((err: unknown) => {
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  });
  return true;
}

/**
 * Файлы результата задачи: список и адрес содержимого.
 *
 * Ходим в HTTP, а не в сокет: список нужен только открытой карточке, а
 * содержимое — это байты картинок и PDF, которые браузер сам тянет по адресу
 * из `<img>` и `<iframe>`. Маршруты — src/server/taskfiles.ts.
 */
import type { ResultFileView, TaskFilesView } from '../../shared/types';
import { useStore } from '../store';
import { locale } from '../i18n';

/** Офис, чью задачу смотрим. Без `office=` сервер взял бы «текущий» — а он мог смениться. */
function officeQuery(): string {
  const id = useStore.getState().offices.find((o) => o.current)?.id;
  return id ? `office=${encodeURIComponent(id)}&` : '';
}

export async function fetchTaskFiles(taskId: string): Promise<TaskFilesView> {
  const res = await fetch(`/api/task/files?${officeQuery()}task=${encodeURIComponent(taskId)}`);
  const body = await res.json().catch(() => null) as (TaskFilesView & { error?: string }) | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/** Адрес содержимого файла: его же берут `<img>`, `<iframe>` и ссылка «Скачать». */
export function fileUrl(taskId: string, path: string): string {
  return `/api/task/file?${officeQuery()}task=${encodeURIComponent(taskId)}&path=${encodeURIComponent(path)}`;
}

/**
 * Адрес файла проекта по пути из текста (GET /api/file, src/server/files.ts).
 * С задачей файл ищется сначала в её работе — так открывается и то, что ещё
 * не влито; `base` — каталог, где сначала искать голое имя.
 */
export function projectFileUrl(path: string, opts: { task?: string | null; base?: string | null } = {}): string {
  return `/api/file?${officeQuery()}path=${encodeURIComponent(path)}`
    + (opts.task ? `&task=${encodeURIComponent(opts.task)}` : '')
    + (opts.base ? `&base=${encodeURIComponent(opts.base)}` : '');
}

/**
 * Текст файла по его адресу — результата задачи или файла проекта. Ошибку
 * сервер присылает JSON-ом с полем error — её и показываем.
 */
export async function fetchFileText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.text();
}

const isDoc = (path: string) => path.startsWith('docs/');

/**
 * Порядок списка: сперва docs/ — там то, ради чего задачу обычно и ставили
 * (спека, отчёт, план), — потом остальное; удалённые в конце каждой группы,
 * смотреть в них нечего. Внутри — по пути.
 */
export function sortFiles(files: ResultFileView[]): ResultFileView[] {
  return [...files].sort((a, b) =>
    Number(isDoc(b.path)) - Number(isDoc(a.path))
    || Number(a.status === 'deleted') - Number(b.status === 'deleted')
    || a.path.localeCompare(b.path));
}

/** Какой файл открыть сразу: первый живой из docs/, иначе первый живой вообще. */
export function defaultFile(sorted: ResultFileView[]): ResultFileView | null {
  return sorted.find((f) => f.status !== 'deleted') ?? sorted[0] ?? null;
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  const fmt = (v: number) => v.toLocaleString(locale(), { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${fmt(bytes / 1024)} KB`;
  return `${fmt(bytes / 1024 / 1024)} MB`;
}

/** Имя файла без каталогов. */
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Макеты FigCraft: блок в карточке задачи и действие «Открыть в FigCraft».
 *
 * Данные — с сервера (GET /api/figcraft/files, POST /api/figcraft/open,
 * src/server/figcraft.ts). Файл .figcraft — zip, показывать его содержимое
 * нечем, поэтому ссылки на него в чате и отчётах (FileLink) ведут сюда.
 */
import { useCallback, useEffect, useState } from 'react';
import type { FigcraftFile, FigcraftFilesView, FigcraftOpenResult, TaskView } from '../../shared/types';
import { t } from '../i18n';
import { pushToast } from '../store';
import { baseName, formatSize, officeQuery } from './api';

export const isFigcraftPath = (path: string) => /\.figcraft$/i.test(path);

export async function fetchFigcraftFiles(taskId: string | null): Promise<FigcraftFilesView> {
  const res = await fetch(`/api/figcraft/files?${officeQuery()}${taskId ? `task=${encodeURIComponent(taskId)}` : ''}`);
  const body = await res.json().catch(() => null) as (FigcraftFilesView & { error?: string }) | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

let toastSeq = 0;
const fail = (detail: string) => pushToast({
  id: `figcraft-${Date.now()}-${toastSeq++}`, kind: 'failed', title: t('figcraft.openFailed'), detail,
});

/** Открыть файл в приложении. Любой отказ — уведомление с текстом сервера. */
export async function openInFigcraft(absPath: string): Promise<boolean> {
  try {
    const office = new URLSearchParams(officeQuery()).get('office');
    const res = await fetch('/api/figcraft/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ office, path: absPath }),
    });
    const body = await res.json().catch(() => null) as FigcraftOpenResult | null;
    if (res.ok && body?.ok) return true;
    fail(body && !body.ok ? body.error : `HTTP ${res.status}`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  return false;
}

export async function copyPath(absPath: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(absPath);
    pushToast({ id: `figcraft-copy-${Date.now()}`, kind: 'info', title: t('figcraft.copied'), ttl: 2500 });
  } catch {
    fail(t('figcraft.copyFailed'));
  }
}

/** Подсказка неактивной кнопки: причина от сервера и куда смотреть. */
function disabledTip(view: FigcraftFilesView): string {
  const reason = view.app.reason ?? t('figcraft.noApp');
  return `${reason} ${t('figcraft.setupHint', { docs: view.app.docs })}`;
}

function Row({ file, view }: { file: FigcraftFile; view: FigcraftFilesView }) {
  const [busy, setBusy] = useState(false);
  const canOpen = view.app.canOpen;
  const open = async () => {
    setBusy(true);
    await openInFigcraft(file.absPath);
    setBusy(false);
  };
  return (
    <div className="figcraft-row">
      <div className="figcraft-info">
        <span className="figcraft-name" title={file.path}>{baseName(file.path)}</span>
        <span className="figcraft-path mono muted" title={file.absPath}>{file.path}</span>
        <span className="figcraft-meta muted small">
          <span className="chip">{t(file.source === 'worktree' ? 'figcraft.inBranch' : 'figcraft.inMain')}</span>
          {' '}{formatSize(file.size)}
        </span>
      </div>
      <div className="figcraft-actions">
        <button className="primary" disabled={!canOpen || busy} title={canOpen ? undefined : disabledTip(view)}
          onClick={open}>
          {busy ? t('figcraft.opening') : t('figcraft.open')}
        </button>
        <button className="ghost" onClick={() => { void copyPath(file.absPath); }}>{t('figcraft.copyPath')}</button>
      </div>
    </div>
  );
}

/** Блок «Макеты FigCraft» в карточке задачи. Без файлов не рисуется. */
export function FigcraftSection({ task }: { task: TaskView }) {
  const [view, setView] = useState<FigcraftFilesView | null>(null);
  const commit = task.delivery?.commit ?? '';
  const load = useCallback(() => {
    let alive = true;
    fetchFigcraftFiles(task.id).then((v) => { if (alive) setView(v); }, () => { if (alive) setView(null); });
    return () => { alive = false; };
  }, [task.id]);
  useEffect(() => load(), [load, commit, task.status]);

  if (!view || view.files.length === 0) return null;
  return (
    <section>
      <h3 className="section-title">{t('figcraft.title')}</h3>
      {!view.app.canOpen && <p className="muted small">{disabledTip(view)}</p>}
      <div className="figcraft-list">
        {view.files.map((f) => <Row key={f.absPath} file={f} view={view} />)}
      </div>
    </section>
  );
}

/**
 * Ссылка на .figcraft из текста: находим файл в списке задачи/офиса по пути
 * (или по имени) и открываем в приложении.
 */
export async function openFigcraftRef(refPath: string, task: string | null): Promise<void> {
  try {
    const view = await fetchFigcraftFiles(task);
    const name = baseName(refPath);
    const file = view.files.find((f) => f.path === refPath)
      ?? view.files.find((f) => f.path.endsWith(`/${refPath}`))
      ?? view.files.find((f) => baseName(f.path) === name);
    if (!file) { fail(t('figcraft.notFound', { name })); return; }
    if (!view.app.canOpen) { fail(disabledTip(view)); return; }
    await openInFigcraft(file.absPath);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * «Результат» законченной задачи: какие файлы она создала, поменяла или
 * удалила, и просмотр каждого — без терминала и без git.
 *
 * В карточке задачи (дровер) — короткий раздел со списком; сам просмотр
 * открывается окном поверх: дровер узкий, а документу и картинке нужна
 * ширина. В окне слева список, справа выбранный файл.
 */
import { useEffect, useState } from 'react';
import type { ResultFileView, TaskView } from '../../shared/types';
import { t } from '../i18n';
import { Hint, Tooltip } from '../Tooltip';
import { HOTKEY } from '../hotkeys';
import { baseName, defaultFile, fetchTaskFiles, fileUrl, formatSize, sortFiles } from './api';
import { DeletedViewer, DownloadViewer, VIEWERS } from './viewers';

/** Больше этого сервер содержимое не отдаёт (taskfiles.ts → RESULT_FILE_MAX_BYTES). */
const SERVER_MAX_BYTES = 20 * 1024 * 1024;

/** Сколько файлов видно прямо в карточке; остальные — в окне. */
const DRAWER_ROWS = 6;

type Loaded = { files: ResultFileView[]; error: null } | { files: null; error: string | null };

/**
 * Список файлов задачи. Перечитывается, когда задача сменилась или её
 * заново слили (новый коммит в `delivery`).
 */
function useTaskFiles(task: TaskView): Loaded {
  const [state, setState] = useState<Loaded>({ files: null, error: null });
  const commit = task.delivery?.commit ?? '';
  useEffect(() => {
    let alive = true;
    setState({ files: null, error: null });
    fetchTaskFiles(task.id).then(
      (view) => { if (alive) setState({ files: sortFiles(view.files), error: null }); },
      (err: unknown) => {
        if (alive) setState({ files: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => { alive = false; };
  }, [task.id, commit]);
  return state;
}

function FileRow({ file, active, onClick }: { file: ResultFileView; active?: boolean; onClick: () => void }) {
  return (
    <button className={`result-row ${file.status}${active ? ' on' : ''}`} onClick={onClick} title={file.path}>
      <span className={`result-status ${file.status}`}>{t(`result.status.${file.status}`)}</span>
      <span className="result-path mono">{file.path}</span>
      <span className="result-size muted small">{formatSize(file.size)}</span>
    </button>
  );
}

/** Просмотр одного файла: удалённый, слишком большой или по таблице видов. */
function Viewer({ taskId, file }: { taskId: string; file: ResultFileView }) {
  const url = fileUrl(taskId, file.path);
  if (file.status === 'deleted') return <DeletedViewer file={file} />;
  if (file.size !== null && file.size > SERVER_MAX_BYTES) {
    return <DownloadViewer taskId={taskId} file={file} url={url} note={t('result.tooBigServer')} noLink />;
  }
  const View = VIEWERS[file.kind] ?? VIEWERS.other;
  return <View taskId={taskId} file={file} url={url} />;
}

/** Окно результата: слева список, справа выбранный файл. */
function ResultWindow({ task, files, initial, onClose }: {
  task: TaskView; files: ResultFileView[]; initial: string | null; onClose: () => void;
}) {
  const [path, setPath] = useState(initial ?? defaultFile(files)?.path ?? null);
  const file = files.find((f) => f.path === path) ?? null;

  useEffect(() => {
    // Окно лежит поверх карточки задачи: Esc закрывает сначала его. Слушаем
    // на document в фазе захвата — раньше общего обработчика приложения на
    // window, но позже увеличенной картинки, которая слушает window.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="panel-backdrop result-layer" onClick={onClose}>
      <div className="panel float wide fixed result-window" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{t('result.windowTitle', { task: task.id })}</h2>
          <span className="muted small">{task.title}</span>
          <Tooltip tip={<Hint label={t('panel.close')} keys={HOTKEY.close} />}>
            <button className="sq ghost" onClick={onClose}>✕</button>
          </Tooltip>
        </header>
        <div className="panel-body result-body">
          <div className="result-list">
            {files.map((f) => (
              <FileRow key={f.path} file={f} active={f.path === path} onClick={() => setPath(f.path)} />
            ))}
          </div>
          <div className="result-view">
            {file ? (
              <>
                <div className="result-view-head">
                  <span className="mono">{file.path}</span>
                  {file.status !== 'deleted' && (
                    <a className="result-dl-link" href={fileUrl(task.id, file.path)} download={baseName(file.path)}>
                      {t('result.download')}
                    </a>
                  )}
                </div>
                <div className="result-view-body">
                  <Viewer key={file.path} taskId={task.id} file={file} />
                </div>
              </>
            ) : (
              <p className="muted result-note">{t('result.pick')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Раздел «Результат» в карточке законченной задачи. */
export function TaskResultSection({ task }: { task: TaskView }) {
  const { files, error } = useTaskFiles(task);
  // null — окно закрыто; строка — открыто на этом файле; '' — на файле по умолчанию.
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setOpen(null); }, [task.id]);

  return (
    <section>
      <h3 className="section-title">
        {files ? t('result.titleCount', { n: files.length }) : t('result.title')}
      </h3>
      {!files && <p className="muted small">{error ?? t('result.loading')}</p>}
      {files && files.length === 0 && <p className="muted small">{t('result.empty')}</p>}
      {files && files.length > 0 && (
        <>
          <div className="result-list compact">
            {files.slice(0, DRAWER_ROWS).map((f) => (
              <FileRow key={f.path} file={f} onClick={() => setOpen(f.path)} />
            ))}
          </div>
          <button className="result-open" onClick={() => setOpen('')}>
            {files.length > DRAWER_ROWS
              ? t('result.openAll', { n: files.length })
              : t('result.open')}
          </button>
        </>
      )}
      {files && open !== null && (
        <ResultWindow task={task} files={files} initial={open || null} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}

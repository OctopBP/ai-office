/**
 * Просмотрщики файлов результата — по одному на вид файла (`ResultFileKind`).
 *
 * Выбор идёт по таблице `VIEWERS`, а не по цепочке условий: вид файла
 * определяет сервер (taskfiles.ts → fileKind), и новый просмотрщик
 * подключается заменой одной строки в таблице.
 */
import { lazy, useEffect, useState, type ComponentType } from 'react';
import type { ResultFileKind, ResultFileView } from '../../shared/types';
import { t } from '../i18n';
import { baseName, fetchFileText, formatSize } from './api';
import { Markdown } from './markdown';

/**
 * Просмотр 3D-моделей — единственный тяжёлый просмотрщик (тянет three.js),
 * поэтому единственный ленивый: подключается кодом только когда открыт файл
 * вида `model3d`, а не всякий раз, когда открывают карточку задачи.
 */
const Model3dViewer = lazy(() => import('./Model3dViewer'));

export interface ViewerProps {
  taskId: string;
  file: ResultFileView;
  /** Адрес содержимого файла (GET /api/task/file). */
  url: string;
}

/**
 * Больше этого текст в окне не рисуем: сотни тысяч строк в DOM вешают
 * вкладку, а читать такое глазами всё равно не станут — отдаём «Скачать».
 */
const TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** Имя, размер и ссылка «Скачать» — для всего, что показать нечем. */
export function DownloadViewer({ file, url, note, noLink }: ViewerProps & { note?: string; noLink?: boolean }) {
  return (
    <div className="result-download">
      <div className="result-download-name mono">{baseName(file.path)}</div>
      <div className="muted small">{formatSize(file.size)}{file.lfs ? ' · Git LFS' : ''}</div>
      {note && <p className="muted small">{note}</p>}
      {!noLink && <a className="result-dl-link" href={url} download={baseName(file.path)}>{t('result.download')}</a>}
    </div>
  );
}

/** Удалённый файл: содержимого в коммите результата нет. */
export function DeletedViewer({ file }: { file: ResultFileView }) {
  return (
    <div className="result-download">
      <div className="result-download-name mono">{baseName(file.path)}</div>
      <p className="muted">{t('result.deleted')}</p>
    </div>
  );
}

/** Текст файла с загрузкой и ошибкой. Смена файла сбрасывает прошлое содержимое. */
function useFileText(taskId: string, path: string, skip: boolean) {
  const [state, setState] = useState<{ text: string | null; error: string | null }>({ text: null, error: null });
  useEffect(() => {
    if (skip) return;
    let alive = true;
    setState({ text: null, error: null });
    fetchFileText(taskId, path).then(
      (text) => { if (alive) setState({ text, error: null }); },
      (err: unknown) => { if (alive) setState({ text: null, error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { alive = false; };
  }, [taskId, path, skip]);
  return state;
}

const tooBig = (file: ResultFileView) => file.size !== null && file.size > TEXT_MAX_BYTES;

function Loading({ error }: { error: string | null }) {
  return <p className="muted result-note">{error ?? t('result.loading')}</p>;
}

/** Моноширинный текст с номерами строк. */
function TextBody({ text }: { text: string }) {
  const lines = text.replace(/\n$/, '').split('\n');
  return (
    <div className="result-text mono">
      {lines.map((line, i) => (
        <div key={i} className="result-line">
          <span className="result-ln">{i + 1}</span>
          <span className="result-lc">{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}

export function TextViewer(props: ViewerProps) {
  const big = tooBig(props.file);
  const { text, error } = useFileText(props.taskId, props.file.path, big);
  if (big) return <DownloadViewer {...props} note={t('result.tooBig')} />;
  if (text === null) return <Loading error={error} />;
  return <TextBody text={text} />;
}

/** Документ отрисованным, с переключателем на исходник. */
export function MarkdownViewer(props: ViewerProps) {
  const [raw, setRaw] = useState(false);
  const big = tooBig(props.file);
  const { text, error } = useFileText(props.taskId, props.file.path, big);
  if (big) return <DownloadViewer {...props} note={t('result.tooBig')} />;
  if (text === null) return <Loading error={error} />;
  return (
    <div className="result-md">
      <div className="seg result-md-seg">
        <button className={raw ? '' : 'on'} onClick={() => setRaw(false)}>{t('result.rendered')}</button>
        <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>{t('result.source')}</button>
      </div>
      {raw ? <TextBody text={text} /> : <Markdown source={text} />}
    </div>
  );
}

/**
 * Картинка с увеличением по клику. SVG тоже идёт через `<img>`: встроенный в
 * DOM он исполнял бы свои скрипты и стили в окне офиса, а в `<img>` это
 * просто картинка.
 */
export function ImageViewer({ file, url }: ViewerProps) {
  const [zoom, setZoom] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setZoom(false); setBroken(false); }, [url]);
  useEffect(() => {
    if (!zoom) return;
    // Ловим Esc раньше окна результата и приложения: сначала закрывается
    // увеличение, а не всё остальное разом.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setZoom(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [zoom]);
  if (broken) return <DownloadViewer taskId="" file={file} url={url} note={t('result.imageBroken')} />;
  return (
    <div className="result-image">
      <img src={url} alt={file.path} title={t('result.zoom')} onClick={() => setZoom(true)} onError={() => setBroken(true)} />
      {zoom && (
        <div className="result-zoom" onClick={() => setZoom(false)} title={t('panel.close')}>
          <img src={url} alt={file.path} />
        </div>
      )}
    </div>
  );
}

/** PDF — встроенным просмотрщиком браузера. */
export function PdfViewer({ file, url }: ViewerProps) {
  return <iframe className="result-pdf" src={url} title={file.path} />;
}

/** Всё без своего просмотрщика — имя, размер, скачать. */
export function OtherViewer(props: ViewerProps) {
  return <DownloadViewer {...props} />;
}

/** Какой просмотрщик у какого вида. */
export const VIEWERS: Record<ResultFileKind, ComponentType<ViewerProps>> = {
  text: TextViewer,
  markdown: MarkdownViewer,
  image: ImageViewer,
  pdf: PdfViewer,
  model3d: Model3dViewer,
  other: OtherViewer,
};

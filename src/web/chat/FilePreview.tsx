/**
 * Окно просмотра файла, открытого по ссылке из текста реплики. Просмотрщики —
 * те же, что у результата задачи (result/viewers.tsx); здесь только окно и
 * первый запрос, который отвечает на «есть ли файл и что это».
 *
 * Модуль грузится лениво (из FileLink.tsx): разметка реплик есть везде, а окно
 * нужно только по щелчку.
 */
import { Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ResultFileKind, ResultFileView } from '../../shared/types';
import { t } from '../i18n';
import { Hint, Tooltip } from '../Tooltip';
import { HOTKEY } from '../hotkeys';
import { baseName, projectFileUrl } from '../result/api';
import { VIEWERS } from '../result/viewers';
import type { FileRef } from './filePaths';

/**
 * Вид файла по Content-Type ответа. Сервер выставляет тип по той же таблице,
 * по которой определяет вид для результата задачи (taskfiles.ts → fileKind),
 * поэтому второй таблицы расширений на вебе не заводим.
 */
function kindOf(type: string): ResultFileKind {
  const mime = type.split(';')[0].trim().toLowerCase();
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('model/')) return 'model3d';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  return 'other';
}

type Probe =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'error'; message: string }
  | { state: 'ok'; file: ResultFileView; url: string };

/**
 * Найти файл. Голое имя сервер ищет сначала в `base`, потом в корне, — какой
 * путь нашёлся, он возвращает заголовком; дальше просмотрщики ходят уже по
 * нему, без `base`. Тело первого ответа не читаем: текст просмотрщик запросит
 * сам, картинку и PDF браузер тянет по адресу.
 */
function useProbe(ref: FileRef, task: string | null): Probe {
  const [probe, setProbe] = useState<Probe>({ state: 'loading' });
  useEffect(() => {
    const ctrl = new AbortController();
    setProbe({ state: 'loading' });
    fetch(projectFileUrl(ref.path, { task, base: ref.base }), { signal: ctrl.signal }).then(async (res) => {
      if (res.status === 404) { setProbe({ state: 'missing' }); return; }
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        setProbe({ state: 'error', message: body?.error ?? `HTTP ${res.status}` });
        return;
      }
      void res.body?.cancel().catch(() => {});
      const found = res.headers.get('X-Office-File-Path');
      const path = found ? decodeURIComponent(found) : ref.path;
      const length = res.headers.get('Content-Length');
      const file: ResultFileView = {
        path,
        status: 'modified',
        size: length !== null ? Number(length) : null,
        kind: kindOf(res.headers.get('Content-Type') ?? ''),
        lfs: false,
      };
      setProbe({ state: 'ok', file, url: projectFileUrl(path, { task }) });
    }, (err: unknown) => {
      if (ctrl.signal.aborted) return;
      setProbe({ state: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    return () => ctrl.abort();
  }, [ref.path, ref.base, task]);
  return probe;
}

export default function FilePreview({ fileRef, task, onClose }: {
  fileRef: FileRef; task: string | null; onClose: () => void;
}) {
  const probe = useProbe(fileRef, task);
  const title = probe.state === 'ok' ? probe.file.path : fileRef.base ? `${fileRef.base}/${fileRef.path}` : fileRef.path;

  useEffect(() => {
    // Как окно результата: Esc закрывает сначала это окно, а не панель под
    // ним; увеличенная картинка слушает window и успевает раньше.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  let body;
  if (probe.state === 'loading') body = <p className="muted result-note">{t('result.loading')}</p>;
  else if (probe.state === 'missing') {
    body = (
      <div className="result-download">
        <div className="result-download-name">{t('fileView.notFound')}</div>
        <p className="muted small">{task ? t('fileView.notFoundTask', { task }) : t('fileView.notFoundHint')}</p>
      </div>
    );
  } else if (probe.state === 'error') body = <p className="muted result-note">{probe.message}</p>;
  else {
    const View = VIEWERS[probe.file.kind] ?? VIEWERS.other;
    body = (
      <Suspense fallback={<p className="muted result-note">{t('result.loading')}</p>}>
        <View taskId={task ?? ''} file={probe.file} url={probe.url} />
      </Suspense>
    );
  }

  // Окно — в body: реплика лежит в прокручиваемой ленте, и внутри неё
  // фиксированный слой обрезался бы её рамкой. Щелчки из портала React всё
  // равно доносит до реплики — гасим их на подложке.
  return createPortal(
    <div className="panel-backdrop result-layer" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="panel float wide fixed result-window file-preview" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 className="mono file-preview-title" title={title}>{title}</h2>
          {probe.state === 'ok' && (
            <a className="result-dl-link" href={probe.url} download={baseName(probe.file.path)}>{t('result.download')}</a>
          )}
          <Tooltip tip={<Hint label={t('panel.close')} keys={HOTKEY.close} />}>
            <button className="sq ghost" onClick={onClose} aria-label={t('panel.close')}>✕</button>
          </Tooltip>
        </header>
        <div className="panel-body">
          <div className="result-view-body">{body}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Путь к файлу в тексте реплики — ссылка, по щелчку окно просмотра в
 * приложении. Не `<a href>`: файл открывается окном офиса, а не вкладкой.
 */
import { lazy, Suspense, useCallback, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { t } from '../i18n';
import { useStore } from '../store';
import type { FileRef } from './filePaths';

const FilePreview = lazy(() => import('./FilePreview'));

export function FileLink({ fileRef, task, children }: { fileRef: FileRef; task: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  // «T-N» в тексте бывает и опечаткой, и задачей из другого офиса: сервер на
  // неизвестную задачу ответит 404, и найденный в main файл не откроется.
  const known = useStore((s) => (task ? s.tasks[task] !== undefined : false));
  const go = (e: MouseEvent | KeyboardEvent) => {
    // Реплика и карточка вокруг могут сами ловить клик — открытие только наше.
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };
  return (
    <>
      <span
        className="md-file"
        role="button"
        tabIndex={0}
        title={t('fileLink.open')}
        onClick={go}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') go(e); }}
      >
        {children}
      </span>
      {open && (
        <Suspense fallback={null}>
          <FilePreview fileRef={fileRef} task={known ? task : null} onClose={close} />
        </Suspense>
      )}
    </>
  );
}

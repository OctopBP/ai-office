import { dismissToast, useStore } from './store';
import { t as tr } from './i18n';

/** Всплывающие сообщения о заметных событиях: завершение, провал, слияние. */
export function Toasts({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast pixel ${t.kind}`}>
          <div className="toast-text">
            <b>{t.kind === 'done' ? '✅' : t.kind === 'failed' ? '⚠️' : 'ℹ️'} {t.title}</b>
            {t.detail && <div className="muted small">{t.detail}</div>}
          </div>
          {t.taskId && (
            <button className="primary" onClick={() => { onOpenTask(t.taskId!); dismissToast(t.id); }}>
              {tr('toast.openTask')}
            </button>
          )}
          <button className="sq" onClick={() => dismissToast(t.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}

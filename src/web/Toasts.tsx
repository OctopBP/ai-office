import { dismissToast, useStore } from './store';
import { t as tr } from './i18n';
import { Icon } from './icons';

/** Всплывающие сообщения о заметных событиях: завершение, провал, слияние. */
export function Toasts({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast pixel ${t.kind}`}>
          <div className="toast-text">
            <b>
              <Icon name={t.kind === 'done' ? 'circle-check' : t.kind === 'failed' ? 'alert-triangle' : 'info-circle'} size={16} />
              {' '}{t.title}
            </b>
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

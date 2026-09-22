import { dismissToast, showDiff, useStore } from './store';
import { displayInstance } from './instanceName';
import { t as tr } from './i18n';

/** Всплывающие сообщения о заметных событиях: завершение, провал, слияние. */
export function Toasts({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const toasts = useStore((s) => s.toasts);
  const tasks = useStore((s) => s.tasks);
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((t) => {
        const task = t.taskId ? tasks[t.taskId] : undefined;
        // Подпись агента приходит уже вшитой в переведённый заголовок первым
        // словом (шаблон toast.taskDone/toast.taskFailed начинается с
        // {who}) — красим этот кусок, собирая ту же подпись, какой её собрал
        // стор, когда заводил тост.
        const who = task?.assigneeId
          ? displayInstance(task.assigneeId, instances, roles)
          : undefined;
        const [titleHead, titleTail] = who && t.title.startsWith(who)
          ? [who, t.title.slice(who.length)]
          : [null, t.title];
        return (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="toast-marker" />
            <div className="toast-body">
              <div className="toast-head">
                <div className="toast-title">
                  {titleHead && <span className="toast-who">{titleHead}</span>}
                  {titleTail}
                </div>
                <button className="ghost mini toast-close" onClick={() => dismissToast(t.id)}>✕</button>
              </div>
              {t.detail && <div className="toast-detail">{t.detail}</div>}
              {t.taskId && (
                <div className="toast-actions">
                  <button className="primary mini" onClick={() => { onOpenTask(t.taskId!); dismissToast(t.id); }}>
                    {tr('toast.openTask')}
                  </button>
                  {task?.branch && (
                    <button className="ghost mini" onClick={() => showDiff(t.taskId!)}>
                      {tr('board.showDiff')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

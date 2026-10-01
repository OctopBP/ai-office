import { useEffect, useRef, useState } from 'react';
import { dismissToast, showDiff, TOAST_TTL, useStore, type Toast } from './store';
import { displayInstance } from './instanceName';
import { t as tr } from './i18n';

/**
 * Запас на случай, если `animationend` так и не придёт (вкладка в фоне,
 * анимацию сняли стилями): карточка всё равно уйдёт из стора. Больше самой
 * длинной анимации ухода в toasts.css.
 */
const LEAVE_FALLBACK_MS = 600;

/** Всплывающие сообщения о заметных событиях: завершение, провал, слияние. */
export function Toasts({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((t) => <ToastCard key={t.id} toast={t} onOpenTask={onOpenTask} />)}
    </div>
  );
}

/**
 * Одна карточка. Срок жизни отсчитывает она сама: таймер заводится при
 * появлении и гасится при размонтировании. Закрытие — по сроку, крестиком или
 * переходом к задаче — сначала проигрывает анимацию ухода и только по её
 * окончании убирает тост из стора, а с ним и из DOM.
 */
function ToastCard({ toast: t, onOpenTask }: { toast: Toast; onOpenTask: (id: string) => void }) {
  const task = useStore((s) => (t.taskId ? s.tasks[t.taskId] : undefined));
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  const [leaving, setLeaving] = useState(false);
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setLeaving(true), t.ttl ?? TOAST_TTL);
    return () => clearTimeout(timer);
  }, [t.ttl]);

  useEffect(() => {
    if (!leaving) return;
    fallback.current = setTimeout(() => dismissToast(t.id), LEAVE_FALLBACK_MS);
    return () => { if (fallback.current) clearTimeout(fallback.current); };
  }, [leaving, t.id]);

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
    <div
      className={`toast ${t.kind}${leaving ? ' leaving' : ''}`}
      onAnimationEnd={(e) => {
        // Всплывшие события анимаций кнопок внутри карточки не в счёт.
        if (leaving && e.target === e.currentTarget) dismissToast(t.id);
      }}
    >
      <span className="toast-marker" />
      <div className="toast-body">
        <div className="toast-head">
          <div className="toast-title">
            {titleHead && <span className="toast-who">{titleHead}</span>}
            {titleTail}
          </div>
          <button className="ghost mini toast-close" onClick={() => setLeaving(true)}>✕</button>
        </div>
        {t.detail && <div className="toast-detail">{t.detail}</div>}
        {t.taskId && (
          <div className="toast-actions">
            <button className="primary mini" onClick={() => { onOpenTask(t.taskId!); setLeaving(true); }}>
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
}

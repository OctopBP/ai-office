import type { ReactNode } from 'react';

/** Оверлей поверх офиса: чат, доска, лог, справка. */
export function Panel({ title, hint, wide, size, onClose, children }: {
  title: string; hint?: string; wide?: boolean; size?: 'board'; onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="panel-backdrop" onClick={onClose}>
      <div className={`panel pixel ${wide ? 'wide' : ''} ${size === 'board' ? 'board-panel' : ''}`.trim()}
        onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          {hint && <span className="muted small">{hint}</span>}
          <button className="sq" onClick={onClose} title="Закрыть — ESC">✕</button>
        </header>
        <div className="panel-body">{children}</div>
      </div>
    </div>
  );
}

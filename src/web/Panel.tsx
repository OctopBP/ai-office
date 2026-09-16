import type { ReactNode } from 'react';
import { t } from './i18n';

/**
 * Оверлей поверх офиса: чат, доска, лог, справка.
 *
 * `tabs` — сегмент вкладок в шапке рядом с заголовком, как в окне «Команда»;
 * `fixed` — окно держит одну высоту, какая бы вкладка ни была открыта, и
 * прокручивается содержимое, а не прыгает рамка.
 */
export function Panel({ title, hint, wide, size, fixed, tabs, onClose, children }: {
  title: string; hint?: string; wide?: boolean; size?: 'board'; fixed?: boolean; tabs?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const cls = ['panel', 'float', wide && 'wide', size === 'board' && 'board-panel', fixed && 'fixed']
    .filter(Boolean).join(' ');
  return (
    <div className="panel-backdrop" onClick={onClose}>
      <div className={cls} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          {tabs}
          {hint && <span className="muted small">{hint}</span>}
          <button className="sq ghost" onClick={onClose} title={t('panel.close')}>✕</button>
        </header>
        <div className="panel-body">{children}</div>
      </div>
    </div>
  );
}

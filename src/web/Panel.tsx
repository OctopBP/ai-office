import type { ReactNode } from 'react';
import { t } from './i18n';
import { Kbd } from './Kbd';
import { Hint, Tooltip } from './Tooltip';
import { HOTKEY } from './hotkeys';

/**
 * Оверлей поверх офиса: чат, доска, лог, справка.
 *
 * `hotkey` — клавиша, которой окно открывается (`hotkeys.ts`), плашкой у
 * заголовка; `tabs` — сегмент вкладок в шапке рядом с заголовком, как в окне
 * «Команда»; `fixed` — окно держит одну высоту, какая бы вкладка ни была
 * открыта, и прокручивается содержимое, а не прыгает рамка.
 */
export function Panel({ title, hint, hotkey, wide, size, fixed, tabs, onClose, children }: {
  title: string; hint?: string; hotkey?: string; wide?: boolean; size?: 'board'; fixed?: boolean; tabs?: ReactNode;
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
          {hotkey && <Kbd keys={hotkey} className="panel-key" />}
          {tabs}
          {hint && <span className="muted small">{hint}</span>}
          <Tooltip tip={<Hint label={t('panel.close')} keys={HOTKEY.close} />}>
            <button className="sq ghost" onClick={onClose}>✕</button>
          </Tooltip>
        </header>
        <div className="panel-body">{children}</div>
      </div>
    </div>
  );
}

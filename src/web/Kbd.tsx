import { Fragment } from 'react';

/**
 * Горячая клавиша в тексте: плашка-клавиша, а не просто буквы. Сочетание
 * пишется через плюс — `SHIFT+ENTER` даст две плашки с плюсом между ними.
 * Оформление самой плашки — у `kbd` в `styles/kit.css`; здесь только разбор
 * сочетания, чтобы никто не собирал его руками из `<kbd>` и `+`.
 */
export function Kbd({ keys, className }: { keys: string; className?: string }) {
  const parts = keys.split('+').map((k) => k.trim()).filter(Boolean);
  return (
    <span className={`kbd-combo${className ? ` ${className}` : ''}`}>
      {parts.map((k, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="kbd-plus">+</span>}
          <kbd>{k}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

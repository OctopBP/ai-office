import type { ReactNode } from 'react';

/**
 * Страница в главной области оболочки: заголовок с действиями и
 * прокручиваемое содержимое на всё место между верхним рядом и низом окна.
 * Так открываются окна из рейла (`RailView` в сторе) — вместо модалки: без
 * подложки и затемнения, рейл и сегменты остаются под рукой.
 *
 * `bodyClass` нужен окнам со своей внутренней прокруткой (как у настроек —
 * меню разделов стоит, едет контент): тогда тело страницы не прокручивается
 * само, а отдаёт высоту содержимому.
 */
export function ShellPage({ title, actions, bodyClass, children }: {
  title: ReactNode;
  actions?: ReactNode;
  bodyClass?: string;
  children: ReactNode;
}) {
  return (
    <section className="shell-view shell-page">
      <header className="shell-page-head">
        <h2 className="shell-page-title">{title}</h2>
        {actions && <div className="shell-page-actions">{actions}</div>}
      </header>
      <div className={`shell-page-body card${bodyClass ? ` ${bodyClass}` : ''}`}>{children}</div>
    </section>
  );
}

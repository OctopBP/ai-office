import { useMemo, useState, type CSSProperties } from 'react';
import menuBg from '../../design/sprites/out/menu_bg.png';
import { formatLastOpened, retryConnect, sortedOffices, useStore } from './store';
import { spriteOf } from './sprites';
import { LimitBars } from './LimitBars';
import { money } from './money';
import type { OfficeView } from '../shared/types';
import { t } from './i18n';

/** Кадры спиннера как CSS-переменные — рамка панели и кнопки заводятся так же. */
const SPINNER_FRAMES = 8;

/**
 * Стартовый экран приложения: выбор существующего офиса или создание нового.
 * До входа в офис комната (office3d/Office3D.tsx) не монтируется — вся логика входа
 * и создания живёт в сторе (enterOffice/requestCreateOffice), здесь только
 * отрисовка её состояний. См. docs/design/office-menu/spec.md.
 */
export function MenuScreen() {
  const theme = useStore((s) => s.theme);
  const offices = useStore((s) => s.offices);
  const booted = useStore((s) => s.booted);
  const connected = useStore((s) => s.connected);
  const connectFailed = useStore((s) => s.connectFailed);
  const pending = useStore((s) => s.pending);
  const pendingLabel = useStore((s) => s.pendingLabel);
  const menuNotice = useStore((s) => s.menuNotice);
  const enterOffice = useStore((s) => s.enterOffice);
  const requestCreateOffice = useStore((s) => s.requestCreateOffice);
  const dismissMenuNotice = useStore((s) => s.dismissMenuNotice);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');

  const list = useMemo(() => sortedOffices(offices), [offices]);
  const empty = booted && list.length === 0;
  const showForm = creating || empty;

  // Рамка панели, кнопки и кадры спиннера — пиксель-арт в двух темах;
  // прокидываем url() через CSS-переменные, чтобы сама раскладка 9-slice
  // и переключение состояний (:hover/:active/:disabled) оставались в CSS.
  const spriteVars = useMemo(() => {
    const v: Record<string, string> = {
      '--menu-panel-img': `url(${spriteOf(theme, 'menu_panel')})`,
      '--menu-btn-img': `url(${spriteOf(theme, 'menu_button')})`,
      '--menu-btn-hover-img': `url(${spriteOf(theme, 'menu_button_hover')})`,
      '--menu-btn-active-img': `url(${spriteOf(theme, 'menu_button_active')})`,
      '--menu-btn-disabled-img': `url(${spriteOf(theme, 'menu_button_disabled')})`,
    };
    for (let i = 0; i < SPINNER_FRAMES; i++) {
      v[`--menu-spinner-${i}`] = `url(${spriteOf(theme, `menu_spinner_${i}`)})`;
    }
    return v as CSSProperties;
  }, [theme]);

  const startCreate = () => {
    setName(''); setDir(''); dismissMenuNotice(); setCreating(true);
  };
  const cancelCreate = () => { setCreating(false); dismissMenuNotice(); };
  const submitCreate = () => {
    if (!dir.trim() || pending === 'create') return;
    requestCreateOffice(name, dir);
  };
  // Начали переписывать форму после неудачной попытки — старая ошибка уже не про этот ввод.
  const clearCreateError = () => { if (menuNotice?.kind === 'create-error') dismissMenuNotice(); };

  return (
    <div className="menu-screen" style={{ backgroundImage: `url(${menuBg})` }}>
      <div className="menu-veil" />

      <header className="menu-title">
        <h1>AI OFFICE</h1>
        <p>{t('menu.subtitle')}</p>
      </header>

      <div className="menu-panel" style={spriteVars}>
        {!booted && !connectFailed && (
          <>
            <h2>{t('menu.yourOffices')}</h2>
            <p className="muted menu-loading">{t('menu.opening')}<Spinner /></p>
          </>
        )}

        {!booted && connectFailed && (
          <div className="menu-conn-error">
            <h2>{t('menu.yourOffices')}</h2>
            <p>{t('menu.noConnection')}</p>
            <button className="primary" onClick={retryConnect}>{t('menu.retry')}</button>
          </div>
        )}

        {booted && pending === 'enter' && (
          <>
            <h2>{t('menu.yourOffices')}</h2>
            <p className="muted menu-loading">
              {t('menu.entering', { name: pendingLabel ?? '' })}<Spinner />
            </p>
          </>
        )}

        {booted && pending !== 'enter' && (
          <>
            <h2>{t(showForm ? 'menu.newOffice' : 'menu.yourOffices')}</h2>

            {!showForm && (
              <>
                <div className="offices menu-offices">
                  {list.map((o) => (
                    <div
                      key={o.id}
                      className={`office-row menu-office-row ${o.current ? 'current' : ''}`}
                      onClick={() => enterOffice(o.id)}
                    >
                      <img className="menu-office-icon" src={spriteOf(theme, 'menu_icon_office')} alt="" />
                      <div className="office-who">
                        <b>{o.name}</b>
                        <div className="muted mono" title={o.projectDir}>{o.projectDir}</div>
                        <div className="muted small">
                          {t('menu.lastOpened', { when: formatLastOpened(o.lastOpenedAt) })}
                        </div>
                      </div>
                      <Spent office={o} />
                      {o.current ? (
                        <span className="chip done">{t('menu.openNow')}</span>
                      ) : (
                        <button className="mini go" onClick={(e) => { e.stopPropagation(); enterOffice(o.id); }}>
                          {t('menu.open')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {menuNotice?.kind === 'blocked' && <p className="menu-error">{menuNotice.text}</p>}

                <Spending offices={list} />

                <div className="modal-actions">
                  <button className="primary" onClick={startCreate}>{t('offices.new')}</button>
                </div>
              </>
            )}

            {showForm && (
              <>
                {empty && <p className="empty">{t('menu.noOffices')}</p>}

                <label>{t('offices.name')}
                  <input value={name} placeholder={t('offices.namePlaceholder')}
                    disabled={pending === 'create'}
                    onChange={(e) => { clearCreateError(); setName(e.target.value); }} />
                </label>
                <label>{t('offices.dir')}
                  <input value={dir} placeholder="/Users/you/projects/my-app" disabled={pending === 'create'}
                    onChange={(e) => { clearCreateError(); setDir(e.target.value); }} />
                  <span className="hint muted">{t('offices.dirHint')}</span>
                </label>

                {menuNotice?.kind === 'create-error' && <p className="menu-error">{menuNotice.text}</p>}

                <div className="modal-actions">
                  {!empty && (
                    <button onClick={cancelCreate} disabled={pending === 'create'}>
                      {t('common.cancel')}
                    </button>
                  )}
                  <button className="primary" disabled={!dir.trim() || pending === 'create'} onClick={submitCreate}>
                    {pending === 'create' ? <Spinner /> : t('offices.create')}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <footer className="menu-footer muted">
        {t(connected ? 'menu.connected' : 'menu.reconnecting')}
      </footer>
    </div>
  );
}

/**
 * Расход офиса в его строке списка. Стоит рядом с названием, а не внутри
 * офиса: понять, куда уходят деньги, можно только сравнив проекты между
 * собой, а заходить в каждый за цифрой — это уже не сравнение.
 *
 * Расход неоткрытого офиса читается из его файла состояния (`activity.ts`),
 * поэтому цифры есть у всех строк, а не только у текущей.
 */
function Spent({ office }: { office: OfficeView }) {
  const spent = office.activity?.usage.costUsd ?? 0;
  const today = office.activity?.today.costUsd ?? 0;
  if (spent === 0) return null;
  return (
    <div className="menu-office-money">
      <b>{money(spent)}</b>
      {/* Ноль за сегодня не пишем: «сегодня $0.000» занимает строку ровно
          затем, чтобы сказать, что сегодня здесь ничего не было. */}
      <span className="muted small">
        {today > 0 ? t('menu.spentToday', { cost: money(today) }) : t('usage.allTime')}
      </span>
    </div>
  );
}

/**
 * Итог по всем офисам и лимиты плана — то же, что на доске расходов внутри
 * офиса, но здесь это единственное место, где видно всю картину сразу:
 * деньги считаются по офисам, а лимит плана один на аккаунт, и упереться в
 * него можно из-за соседнего проекта.
 */
function Spending({ offices }: { offices: OfficeView[] }) {
  const total = offices.reduce((sum, o) => sum + (o.activity?.usage.costUsd ?? 0), 0);
  const today = offices.reduce((sum, o) => sum + (o.activity?.today.costUsd ?? 0), 0);

  return (
    <div className="menu-stats">
      <div className="menu-stats-head">
        <span className="menu-stats-title">{t('menu.spending')}</span>
        <span><b>{money(today)}</b> <span className="muted small">{t('common.today')}</span></span>
        <span><b>{money(total)}</b> <span className="muted small">{t('usage.allTime')}</span></span>
      </div>
      <LimitBars />
    </div>
  );
}

/** Покадровая анимация загрузки — 8 спрайтов, кадры листаются в CSS (menu-spin-frames). */
function Spinner() {
  return <span className="menu-spinner" aria-hidden />;
}

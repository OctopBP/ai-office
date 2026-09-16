import { useMemo, useState } from 'react';
import { formatLastOpened, retryConnect, sortedOffices, useStore } from './store';
import { LimitBars } from './LimitBars';
import { SetupWizard } from './SetupWizard';
import { money } from './money';
import type { OfficeView } from '../shared/types';
import { t } from './i18n';

/** Цвета аватарок офисов — те же и в том же порядке, что в рейле. */
const HUES = ['var(--hue-blue)', 'var(--hue-amber)', 'var(--hue-pink)', 'var(--hue-violet)'];

/**
 * Стартовый экран приложения: выбор существующего офиса или создание нового.
 * До входа в офис комната (office3d/Office3D.tsx) не монтируется — вся логика
 * входа живёт в сторе (enterOffice), создание — в мастере (SetupWizard.tsx),
 * здесь только отрисовка их состояний.
 *
 * Собран по правилам кита, а не по макету: макета для меню нет, а список
 * офисов внутри офиса уже живёт в рейле — здесь та же строка, только шире и с
 * расходом, чтобы проекты можно было сравнить до входа.
 */
export function MenuScreen() {
  const offices = useStore((s) => s.offices);
  const booted = useStore((s) => s.booted);
  const connected = useStore((s) => s.connected);
  const connectFailed = useStore((s) => s.connectFailed);
  const pending = useStore((s) => s.pending);
  const pendingLabel = useStore((s) => s.pendingLabel);
  const menuNotice = useStore((s) => s.menuNotice);
  const enterOffice = useStore((s) => s.enterOffice);
  const dismissMenuNotice = useStore((s) => s.dismissMenuNotice);

  const [creating, setCreating] = useState(false);

  const list = useMemo(() => sortedOffices(offices), [offices]);
  const empty = booted && list.length === 0;

  const startCreate = () => { dismissMenuNotice(); setCreating(true); };
  const cancelCreate = () => { setCreating(false); dismissMenuNotice(); };

  return (
    <div className="menu-screen">
      <div className="menu-card float">
        <header className="menu-brand">
          <span className="menu-logo" />
          <div>
            <div className="menu-name">AI Office</div>
            <div className="menu-subtitle">{t('menu.subtitle')}</div>
          </div>
        </header>

        {!booted && !connectFailed && (
          <p className="menu-loading"><Spinner />{t('menu.opening')}</p>
        )}

        {!booted && connectFailed && (
          <div className="menu-conn-error">
            <p>{t('menu.noConnection')}</p>
            <button className="primary" onClick={retryConnect}>{t('menu.retry')}</button>
          </div>
        )}

        {booted && pending === 'enter' && (
          <p className="menu-loading"><Spinner />{t('menu.entering', { name: pendingLabel ?? '' })}</p>
        )}

        {booted && pending !== 'enter' && (
          <>
            <div className="section-title">{t('menu.yourOffices')}</div>
            {empty && <p className="empty">{t('menu.noOffices')}</p>}
            <div className="menu-offices">
              {list.map((o) => (
                <OfficeRow key={o.id} office={o} hue={HUES[offices.indexOf(o) % HUES.length]}
                  onOpen={() => enterOffice(o.id)} />
              ))}
              <button className="dashed" onClick={startCreate}>{t('shell.newOffice')}</button>
            </div>

            {menuNotice?.kind === 'blocked' && <p className="menu-error">{menuNotice.text}</p>}

            <Spending offices={list} />
          </>
        )}

        {creating && <SetupWizard onClose={cancelCreate} />}
      </div>

      <footer className="menu-footer">
        <span className={`menu-dot${connected ? ' on' : ''}`} />
        {t(connected ? 'menu.connected' : 'menu.reconnecting')}
      </footer>
    </div>
  );
}

/**
 * Строка офиса: та же, что в рейле, плюс путь, дата и расход. Расход стоит
 * рядом с названием, а не внутри офиса: понять, куда уходят деньги, можно
 * только сравнив проекты между собой, а заходить в каждый за цифрой — это
 * уже не сравнение. Расход неоткрытого офиса читается из его файла состояния
 * (`activity.ts`), поэтому цифры есть у всех строк, а не только у текущей.
 */
function OfficeRow({ office: o, hue, onOpen }: { office: OfficeView; hue: string; onOpen: () => void }) {
  const spent = o.activity?.usage.costUsd ?? 0;
  const today = o.activity?.today.costUsd ?? 0;
  return (
    <button className={`menu-office${o.current ? ' current' : ''}`} onClick={onOpen}
      title={o.projectDir}>
      <span className="menu-office-avatar" style={{ background: hue }} />
      <span className="menu-office-text">
        <span className="menu-office-name">{o.name}</span>
        {o.noProject
          ? <span className="menu-office-path">{t('menu.noProject')}</span>
          : <span className="menu-office-path mono">{o.projectDir}</span>}
        <span className="menu-office-when">{t('menu.lastOpened', { when: formatLastOpened(o.lastOpenedAt) })}</span>
      </span>
      {spent > 0 && (
        <span className="menu-office-money">
          <b>{money(spent)}</b>
          {/* Ноль за сегодня не пишем: «сегодня $0.000» занимает строку ровно
              затем, чтобы сказать, что сегодня здесь ничего не было. */}
          <span>{today > 0 ? t('menu.spentToday', { cost: money(today) }) : t('usage.allTime')}</span>
        </span>
      )}
      {o.current
        ? <span className="chip done">{t('menu.openNow')}</span>
        : <span className="chip menu-office-open">{t('menu.open')}</span>}
    </button>
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
        <span className="section-title">{t('menu.spending')}</span>
        <span><b>{money(today)}</b> <span className="muted small">{t('common.today')}</span></span>
        <span><b>{money(total)}</b> <span className="muted small">{t('usage.allTime')}</span></span>
      </div>
      <LimitBars />
    </div>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden />;
}

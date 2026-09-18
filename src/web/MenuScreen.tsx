import { useMemo, useState } from 'react';
import {
  formatLastOpened, retryConnect, sortedOffices, summarizeOfficeActivity, useStore, type ThemeMode,
} from './store';
import { LimitBars } from './LimitBars';
import { SetupWizard } from './SetupWizard';
import { money } from './money';
import type { OfficeView } from '../shared/types';
import type { HomeTab } from './router';
import { t, type UiKey } from './i18n';
import { officeAvatarColor, officeAvatarInk } from './officeColor';

const TABS: Array<[HomeTab, UiKey]> = [
  ['offices', 'home.tab.offices'],
  ['spending', 'home.tab.spending'],
  ['settings', 'home.tab.settings'],
];

const THEME_MODES: Array<[ThemeMode, UiKey]> = [
  ['day', 'settings.theme.day'],
  ['night', 'settings.theme.night'],
  ['system', 'settings.theme.system'],
];

const initial = (name: string): string => Array.from(name.trim())[0]?.toUpperCase() ?? '?';

/**
 * Аватарка офиса — та же, что в рейле (shell/Rail.tsx): цвет подложки по id
 * офиса, а внутри назначенная иконка (эмодзи или картинка) или инициал имени.
 * Картинку отдаёт сервер по id (`/api/office-icon`): путь к файлу хранится
 * относительно директории проекта и браузеру напрямую недоступен.
 */
function OfficeAvatar({ office: o, small }: { office: OfficeView; small?: boolean }) {
  const icon = o.icon;
  return (
    <span className={`office-card-avatar${small ? ' sm' : ''}`}
      style={{ background: officeAvatarColor(o.id), color: officeAvatarInk(o.id) }}>
      {icon?.kind === 'emoji' && icon.value}
      {icon?.kind === 'image' && <img className="office-card-icon-img" src={`/api/office-icon?office=${o.id}`} alt="" />}
      {!icon && initial(o.name)}
    </span>
  );
}

/**
 * Главный экран приложения: офисы карточками, расходы по всем офисам и
 * настройки этого компьютера. Вкладка — часть адреса (`router.ts`), поэтому
 * её переживает перезагрузка и «назад» в браузере.
 *
 * До входа в офис комната (office3d/Office3D.tsx) не монтируется — вся логика
 * входа и создания живёт в сторе (enterOffice/requestCreateOffice), здесь
 * только отрисовка её состояний.
 */
export function MenuScreen() {
  const offices = useStore((s) => s.offices);
  const booted = useStore((s) => s.booted);
  const connected = useStore((s) => s.connected);
  const connectFailed = useStore((s) => s.connectFailed);
  const pending = useStore((s) => s.pending);
  const pendingLabel = useStore((s) => s.pendingLabel);
  const menuNotice = useStore((s) => s.menuNotice);
  const tab = useStore((s) => s.homeTab);
  const setTab = useStore((s) => s.setHomeTab);
  const dismissMenuNotice = useStore((s) => s.dismissMenuNotice);

  const [creating, setCreating] = useState(false);
  const list = useMemo(() => sortedOffices(offices), [offices]);

  // Вкладке настроек сервер не нужен: там только то, что живёт на этом компьютере.
  const needsServer = tab !== 'settings';

  return (
    <div className="home">
      <header className="home-head">
        <div className="menu-brand">
          <span className="menu-logo" />
          <div>
            <div className="menu-name">AI Office</div>
            <div className="menu-subtitle">{t('menu.subtitle')}</div>
          </div>
        </div>
        <nav className="seg home-tabs">
          {TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {t(label)}
            </button>
          ))}
        </nav>
      </header>

      <main className="home-body">
        {needsServer && !booted && !connectFailed && (
          <p className="menu-loading"><Spinner />{t('menu.opening')}</p>
        )}

        {needsServer && !booted && connectFailed && (
          <div className="menu-conn-error">
            <p>{t('menu.noConnection')}</p>
            <button className="primary" onClick={retryConnect}>{t('menu.retry')}</button>
          </div>
        )}

        {needsServer && booted && pending === 'enter' && (
          <p className="menu-loading"><Spinner />{t('menu.entering', { name: pendingLabel ?? '' })}</p>
        )}

        {tab === 'offices' && booted && pending !== 'enter' && (
          <>
            {menuNotice?.kind === 'blocked' && <p className="menu-error">{menuNotice.text}</p>}
            {list.length === 0 && <p className="muted">{t('menu.noOffices')}</p>}
            <div className="home-grid">
              <button className="office-card office-card-add"
                onClick={() => { dismissMenuNotice(); setCreating(true); }}>
                <span className="office-card-plus" aria-hidden>+</span>
                <span className="office-card-name">{t('home.addOffice')}</span>
                <span className="muted small">{t('home.addOfficeHint')}</span>
              </button>
              {list.map((o) => <OfficeCard key={o.id} office={o} />)}
            </div>
          </>
        )}

        {tab === 'spending' && booted && pending !== 'enter' && <Spending offices={list} />}

        {tab === 'settings' && <DeviceSettings />}
      </main>

      <footer className="menu-footer">
        <span className={`menu-dot${connected ? ' on' : ''}`} />
        {t(connected ? 'menu.connected' : 'menu.reconnecting')}
      </footer>

      {creating && <SetupWizard onClose={() => { setCreating(false); dismissMenuNotice(); }} />}
    </div>
  );
}

/**
 * Карточка офиса: кто он, что в нём сейчас происходит и во что обошёлся.
 * Расход стоит прямо на карточке, а не внутри офиса: понять, куда уходят
 * деньги, можно только сравнив проекты между собой. Расход неоткрытого офиса
 * читается из его файла состояния (`activity.ts`), поэтому цифры есть у всех.
 */
function OfficeCard({ office: o }: { office: OfficeView }) {
  const enterOffice = useStore((s) => s.enterOffice);
  const activity = summarizeOfficeActivity(o);
  const spent = o.activity?.usage.costUsd ?? 0;
  const today = o.activity?.today.costUsd ?? 0;
  return (
    <button className={`office-card float${o.current ? ' current' : ''}`}
      onClick={() => enterOffice(o.id)} title={o.projectDir}>
      <span className="office-card-top">
        <OfficeAvatar office={o} />
        {o.current
          ? <span className="chip done">{t('menu.openNow')}</span>
          : <span className="chip office-card-open">{t('menu.open')}</span>}
      </span>

      <span className="office-card-text">
        <span className="office-card-name">{o.name}</span>
        {o.noProject
          ? <span className="office-card-path">{t('menu.noProject')}</span>
          : <span className="office-card-path mono">{o.projectDir}</span>}
      </span>

      <span className="office-card-status">
        <span className={`office-card-dot${activity.live ? ' live' : ''}`} />
        {activity.text}
      </span>
      {activity.waiting > 0 && (
        <span className="office-card-waiting">{t('home.waiting', { n: activity.waiting })}</span>
      )}

      <span className="office-card-foot">
        <span className="office-card-when">{formatLastOpened(o.lastOpenedAt)}</span>
        <span className="office-card-money">
          <b>{money(spent)}</b>
          {/* Ноль за сегодня не пишем: «сегодня $0.000» занимает строку ровно
              затем, чтобы сказать, что сегодня здесь ничего не было. */}
          {today > 0 && <span>{t('menu.spentToday', { cost: money(today) })}</span>}
        </span>
      </span>
    </button>
  );
}

/**
 * Итог по всем офисам, лимиты плана и разбивка по офисам. Деньги считаются
 * по офисам, а лимит плана один на аккаунт, и упереться в него можно из-за
 * соседнего проекта — поэтому всё на одной вкладке.
 */
function Spending({ offices }: { offices: OfficeView[] }) {
  const enterOffice = useStore((s) => s.enterOffice);
  const total = offices.reduce((sum, o) => sum + (o.activity?.usage.costUsd ?? 0), 0);
  const today = offices.reduce((sum, o) => sum + (o.activity?.today.costUsd ?? 0), 0);
  const rows = [...offices].sort((a, b) => (b.activity?.usage.costUsd ?? 0) - (a.activity?.usage.costUsd ?? 0));
  const top = rows[0]?.activity?.usage.costUsd ?? 0;

  return (
    <div className="home-spending">
      <div className="home-stats">
        <div className="home-stat float">
          <span className="muted small">{t('common.today')}</span>
          <b>{money(today)}</b>
        </div>
        <div className="home-stat float">
          <span className="muted small">{t('usage.allTime')}</span>
          <b>{money(total)}</b>
        </div>
      </div>

      <section className="home-panel float">
        <LimitBars />
      </section>

      <section className="home-panel float">
        <div className="section-title">{t('home.spending.byOffice')}</div>
        {total === 0 && <p className="muted">{t('home.spending.none')}</p>}
        <div className="home-spend-rows">
          {rows.map((o) => {
            const spent = o.activity?.usage.costUsd ?? 0;
            const day = o.activity?.today.costUsd ?? 0;
            return (
              <button key={o.id} className="home-spend-row" onClick={() => enterOffice(o.id)} title={o.projectDir}>
                <OfficeAvatar office={o} small />
                <span className="home-spend-name">{o.name}</span>
                <span className="meter home-spend-bar">
                  <i style={{ width: `${top > 0 ? (spent / top) * 100 : 0}%` }} />
                </span>
                <span className="home-spend-today muted small">
                  {day > 0 ? t('menu.spentToday', { cost: money(day) }) : ''}
                </span>
                <b className="home-spend-total">{money(spent)}</b>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/**
 * Настройки этого компьютера: тема и картинка комнаты. Применяются сразу —
 * на сервер они не уезжают, и комнаты, которую надо было бы пересобрать, на
 * главном экране нет. Всё, что про офис, — в настройках внутри офиса.
 */
function DeviceSettings() {
  const themeMode = useStore((s) => s.themeMode);
  const setThemeMode = useStore((s) => s.setThemeMode);
  const graphics = useStore((s) => s.graphics);
  const setGraphics = useStore((s) => s.setGraphics);

  return (
    <div className="home-settings">
      <section className="home-panel float">
        <div className="section-title">{t('home.settings.device')}</div>

        <h4>{t('settings.theme')}</h4>
        <div className="seg">
          {THEME_MODES.map(([mode, label]) => (
            <button key={mode} className={themeMode === mode ? 'on' : ''} onClick={() => setThemeMode(mode)}>
              {t(label)}
            </button>
          ))}
        </div>
        <p className="hint">{t('settings.theme.hint')}</p>

        <h4>{t('settings.gfx.title')}</h4>
        <div className="engine">
          <button className={graphics.pixelate ? 'on' : ''} onClick={() => setGraphics({ pixelate: true })}>
            {t('settings.gfx.on')}
            <span className="muted small">{t('settings.gfx.on.hint')}</span>
          </button>
          <button className={graphics.pixelate ? '' : 'on'} onClick={() => setGraphics({ pixelate: false })}>
            {t('settings.gfx.off')}
            <span className="muted small">{t('settings.gfx.off.hint')}</span>
          </button>
        </div>

        <h4>{t('settings.gfx.grid.title')}</h4>
        <label className="home-checkbox">
          <input type="checkbox" checked={graphics.grid} onChange={(e) => setGraphics({ grid: e.target.checked })} />
          {t('settings.gfx.grid')}
        </label>
      </section>

      <p className="muted home-note">{t('home.settings.officeNote')}</p>
    </div>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden />;
}

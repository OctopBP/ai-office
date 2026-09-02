/**
 * Стенд кита — dev-экран, на котором все детали оболочки лежат рядом в обеих
 * темах: `?kit=1`, только в разработке (см. `main.tsx`).
 *
 * Зачем он: экранов без макета в Figma больше, чем с макетом, и собирать их
 * будут по правилам из `styles/kit.css`. Сравнить правило с фреймом можно
 * только здесь — в офисе кнопка всегда стоит в чём-то, и не видно, она
 * такая или её подвинул сосед. Стенд — это и определение готовности для
 * переноса: «скриншот стенда совпадает с фреймом».
 *
 * Стенд не подключается к серверу и не трогает стор: темы здесь — просто
 * `data-theme` на двух половинах страницы, токены сами переключаются по нему.
 */
import type { Theme } from './sprites';

const SWATCHES: Array<[string, string]> = [
  ['canvas', 'холст'], ['surface', 'поверхность'], ['film', 'плёнка'], ['film-2', 'активная строка'],
  ['hairline', 'граница'], ['ink', 'заголовок'], ['ink-2', 'текст'], ['ink-3', 'второстепенный'],
  ['ink-4', 'подпись'], ['accent', 'акцент'], ['ok', 'статус'], ['ok-live', 'агент'],
  ['ok-ink', 'зелёный текст'], ['warn', 'предупреждение'], ['danger', 'опасность'],
];

const ROLES: Array<[string, string]> = [
  ['PM1', 'var(--hue-amber)'], ['B1', 'var(--hue-blue)'], ['F2', 'var(--hue-pink)'], ['D1', 'var(--hue-violet)'],
];

function Half({ theme }: { theme: Theme }) {
  return (
    <div className="kit-half" data-theme={theme}>
      <h1 className="kit-brand">AI Office <span className="muted">· {theme === 'day' ? 'светлая' : 'тёмная'}</span></h1>

      <section>
        <h2 className="section-title">Цвет</h2>
        <div className="kit-swatches">
          {SWATCHES.map(([name, label]) => (
            <div key={name} className="kit-swatch">
              <i style={{ background: `var(--${name})` }} />
              <b>--{name}</b><span className="muted small">{label}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-title">Текст</h2>
        <p style={{ fontSize: 'var(--fs-title)', fontWeight: 600, fontFamily: 'var(--font-brand)' }}>Sora 15 SemiBold — название продукта</p>
        <p style={{ fontSize: 'var(--fs-md)', fontWeight: 500, color: 'var(--ink)' }}>Inter 13 Medium — название офиса, Notes App</p>
        <p style={{ fontSize: 'var(--fs-body)' }}>Inter 12.5 — пункт списка, подпись кнопки, «Доска задач»</p>
        <p style={{ fontSize: 'var(--fs-small)' }} className="muted">Inter 11 — статус офиса, «4 агента · 2 в работе», детали тоста</p>
        <p className="section-title">Inter 10 — заголовок секции</p>
        <p className="mono">mono 11 — BACK-1, ~/dev/notes-app</p>
      </section>

      <section>
        <h2 className="section-title">Шкалы</h2>
        <div className="kit-row kit-scale">
          {[1, 2, 3, 4, 5, 6, 8].map((n) => (
            <span key={n} className="kit-space" title={`--space-${n}`}>
              <i style={{ width: `var(--space-${n})` }} /><b>{n}</b>
            </span>
          ))}
        </div>
        <div className="kit-row kit-scale">
          {['hud', 'popover', 'toast', 'panel', 'drawer', 'modal', 'avatar', 'menu'].map((z) => (
            <span key={z} className="chip">z-{z}</span>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-title">Кнопки</h2>
        <div className="kit-row">
          <button className="primary">Поставить задачу</button>
          <button>Показать diff</button>
          <button className="on">Включено</button>
          <button disabled>Недоступно</button>
          <button className="sq" title="Пауза">II</button>
          <button className="sq primary" title="Отправить">↑</button>
          <button className="mini primary">Открыть задачу</button>
          <button className="mini">Показать diff</button>
          <button className="ghost">✕</button>
        </div>
        <div className="kit-row" style={{ width: 238 }}>
          <button className="dashed">+  Новый офис</button>
        </div>
      </section>

      <section>
        <h2 className="section-title">Сегменты и чипы</h2>
        <div className="kit-row">
          <div className="seg">
            <button className="on">Офис</button>
            <button>Доска</button>
            <button>Чат</button>
          </div>
          <button>Sonnet 5 ▾</button>
          <button>Правки: спрашивать ▾</button>
          <button>Бюджет $5.00 ▾</button>
        </div>
        <div className="kit-row">
          <span className="chip">план</span>
          <span className="chip in_progress" style={{ color: 'var(--accent)' }}>в работе</span>
          <span className="chip" style={{ color: 'var(--ok-ink)' }}>готово</span>
          <span className="chip" style={{ color: 'var(--danger)' }}>сломалось</span>
          <kbd>B</kbd><kbd>ENTER</kbd><kbd>ESC</kbd>
        </div>
      </section>

      <section>
        <h2 className="section-title">Бейдж агента</h2>
        <div className="kit-row kit-scene">
          {ROLES.map(([code, color], i) => (
            <span key={code} className="agent-badge">
              <span className="agent-badge-role" style={{ background: color }}>{code}</span>
              <span className={`agent-badge-dot ${['live', 'live', 'warn', ''][i]}`} />
            </span>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-title">Поля</h2>
        <div className="kit-row">
          <input placeholder="Поставьте задачу PM — он разложит её на команду…" style={{ flex: 1 }} />
          <select><option>Sonnet 5</option><option>Opus 5</option></select>
        </div>
      </section>

      <section>
        <h2 className="section-title">Карточка и шкала</h2>
        <div className="float kit-card">
          <div className="kit-card-row">
            <span className="kit-dot" />
            <b>backend#1</b> закончил BACK-1 «Каркас проекта» — на ревью
            <button className="ghost mini" style={{ marginLeft: 'auto' }}>✕</button>
          </div>
          <div className="muted small">+$0.09 · 6 мин · 3 файла</div>
          <div className="kit-row" style={{ marginTop: 2 }}>
            <button className="mini primary">Открыть задачу</button>
            <button className="mini">Показать diff</button>
          </div>
        </div>
        <div className="kit-meter">
          <div className="kit-meter-head"><span className="muted small">Расход сегодня</span><b className="small">$0.42 из $5.00</b></div>
          <div className="meter"><i style={{ width: '8%' }} /></div>
        </div>
      </section>
    </div>
  );
}

export function KitBench() {
  return (
    <div className="kit">
      <Half theme="day" />
      <Half theme="night" />
    </div>
  );
}

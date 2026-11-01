import { createRoot } from 'react-dom/client';
import type { LimitsView, ProviderView, РасходЗаПериоды, РасходОкна } from '../../shared/types';
import { RailSpend } from '../shell/RailSpend';
import { useStore } from '../store';
import { setLang } from '../i18n';
import { словари } from './i18n';
import '@fontsource-variable/inter';
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/kit.css';
import '../styles/shell.css';
import './стенд-рейла.css';

// Отдельная точка входа: App и connect() никогда не импортируются/не вызываются.
// Нет текущего офиса — эффект RailSpend не делает fetch и не начинает опрос.
const параметры = new URLSearchParams(location.search);
const язык = параметры.get('lang') === 'en' ? 'en' : 'ru';
const тема = параметры.get('theme') === 'night' ? 'night' : 'day';
setLang(язык);
document.documentElement.dataset.theme = тема;
const текст = словари[язык];
const сценарии = ['full', 'unknown', 'partial', 'expired', 'noReset', 'long', 'stale', 'empty', 'loading', 'edges'] as const;
type Сценарий = typeof сценарии[number];
const выбранный = параметры.get('scenario');
const сценарий: Сценарий = сценарии.find(значение => значение === выбранный) ?? 'full';
const сейчас = Date.now();

function окно(часы: number, сумма: number): РасходОкна {
  return { from: сейчас - часы * 3600_000, to: сейчас, costUsd: сумма,
    costStatus: 'available', historyPartial: false, unknownCostEntries: 0, entries: 3 };
}
const расходы: РасходЗаПериоды = {
  calculatedAt: сейчас, historyFrom: сейчас - 7 * 86400_000,
  fiveHour: окно(5, 12.34), sevenDay: окно(168, 123.45),
};
const лимиты: LimitsView = {
  available: true, plan: null, updatedAt: сейчас, status: null,
  windows: [
    { provider: 'codex', kind: 'codex_secondary', windowMinutes: 300, utilization: 25,
      updatedAt: сейчас, resetsAt: сейчас + 65 * 60_000 },
    { provider: 'codex', kind: 'codex_primary', windowMinutes: 10080, utilization: 80,
      updatedAt: сейчас, resetsAt: сейчас + 135 * 60_000 },
  ],
};
// Компонент читает только id/label/status; остальные поля провайдера ему не нужны.
const провайдер = { id: 'codex', label: 'Codex', status: { state: 'ready', auth: 'subscription' } } as ProviderView;
if (сценарий === 'unknown') {
  лимиты.available = false;
  for (const расход of [расходы.fiveHour, расходы.sevenDay]) {
    расход.costUsd = null; расход.costStatus = 'unavailable';
  }
}
if (сценарий === 'partial') {
  расходы.fiveHour.costStatus = 'partial'; расходы.fiveHour.unknownCostEntries = 2;
  расходы.sevenDay.historyPartial = true;
}
if (сценарий === 'expired' || сценарий === 'noReset') {
  for (const лимит of лимиты.windows) лимит.resetsAt = сценарий === 'expired' ? сейчас - 60_000 : null;
}
if (сценарий === 'long') {
  расходы.fiveHour.costUsd = 1234567890123.45;
  расходы.sevenDay.costUsd = 9876543210987.65;
}
if (сценарий === 'stale') расходы.calculatedAt = сейчас - 3600_000;
if (сценарий === 'edges') {
  лимиты.windows[0].utilization = 0; лимиты.windows[1].utilization = 100;
  расходы.fiveHour.costUsd = 0;
}
useStore.setState({
  offices: [], connected: false,
  pending: сценарий === 'loading' ? 'enter' : null,
  spendWindows: сценарий === 'empty' ? null : расходы,
  limits: сценарий === 'empty' ? { ...лимиты, available: false, windows: [] } : лимиты,
  providers: { providers: [провайдер], noneReady: false, keychain: false },
  settings: { ...useStore.getState().settings, model: { provider: 'codex', model: 'fixture' } },
});

function Стенд() {
  return <main className="preview shell">
    <h1>{текст.title}</h1>
    <p>{текст.help}</p>
    <form method="get">
      <label>{текст.scenario}
        <select name="scenario" defaultValue={сценарий} onChange={событие => событие.currentTarget.form?.requestSubmit()}>
          {сценарии.map(имя => <option key={имя} value={имя}>{текст[имя]}</option>)}
        </select>
      </label>
      <label>{текст.language}
        <select name="lang" defaultValue={язык} onChange={событие => событие.currentTarget.form?.requestSubmit()}>
          <option value="ru">Русский</option><option value="en">English</option>
        </select>
      </label>
      <label>{текст.theme}
        <select name="theme" defaultValue={тема} onChange={событие => событие.currentTarget.form?.requestSubmit()}>
          <option value="day">{текст.day}</option><option value="night">{текст.night}</option>
        </select>
      </label>
      <button type="submit">{текст.retry}</button>
    </form>
    <p role="status">{текст.ready}</p>
    <section className={`preview-rail${параметры.get('edge') === 'right' ? ' preview-right' : ''}`} aria-label={текст[сценарий]}>
      <div className="rail-foot"><RailSpend /></div>
    </section>
  </main>;
}

// Защита от включения стенда в production при случайном открытии html.
if (import.meta.env.DEV) createRoot(document.getElementById('root')!).render(<Стенд />);

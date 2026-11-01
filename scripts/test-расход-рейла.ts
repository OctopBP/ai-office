import assert from 'node:assert/strict';
import type { LimitsView, ProviderView, РасходОкна } from '../src/shared/types';

Object.assign(globalThis, { localStorage: { getItem: () => 'ru' }, document: { documentElement: {} } });
const { суммаРейла, данныеСтроки } = await import('../src/web/shell/расходыРейла');
const { setLang } = await import('../src/web/i18n');
const сейчас = Date.UTC(2026, 10, 1, 10);
const расход: РасходОкна = { from: 0, to: сейчас, costUsd: 12.34, costStatus: 'available', historyPartial: false, unknownCostEntries: 0, entries: 1 };
assert.equal(суммаРейла(расход), '$12.3');
assert.equal(суммаРейла({ ...расход, costUsd: 12.35 }), '$12.4');
assert.equal(суммаРейла({ ...расход, costUsd: 0 }), '$0.0');
assert.equal(суммаРейла({ ...расход, costUsd: 0, costStatus: 'partial' }), '≈$0.0');
assert.equal(суммаРейла({ ...расход, costUsd: null }), '—');
assert.equal(суммаРейла({ ...расход, costStatus: 'unavailable' }), '—');
assert.equal(суммаРейла(undefined), '—');
assert.equal(суммаРейла(расход, true), '≈$12.3');
assert.equal(суммаРейла({ ...расход, historyPartial: true }), '≈$12.3');
assert.equal(суммаРейла({ ...расход, costUsd: NaN }), '—');
assert.equal(суммаРейла({ ...расход, costUsd: 0 }, true), '≈$0.0');
const провайдер = { id: 'codex', label: 'Codex', status: { state: 'ready', auth: 'subscription' } } as ProviderView;
const лимиты: LimitsView = { available: true, plan: null, updatedAt: сейчас, status: null, windows: [
  { provider: 'codex', kind: 'codex_primary', windowMinutes: 10080, utilization: 80, updatedAt: сейчас, resetsAt: сейчас + 135 * 60_000 },
  { provider: 'codex', kind: 'codex_secondary', windowMinutes: 300, utilization: 0.5, updatedAt: сейчас, resetsAt: сейчас + 3600_000 },
  { provider: 'claude-code', kind: 'five_hour', utilization: 99, updatedAt: сейчас, resetsAt: сейчас + 3600_000 },
] };
assert.equal(данныеСтроки(лимиты, провайдер, '5h', сейчас).процент, 0.5);
assert.equal(данныеСтроки(лимиты, провайдер, '1w', сейчас).процент, 80);
for (const доля of [0, 100]) {
  const край: LimitsView = { ...лимиты, windows: [{ ...лимиты.windows[1], utilization: доля }] };
  assert.equal(данныеСтроки(край, провайдер, '5h', сейчас).процент, доля);
}
assert.equal(данныеСтроки({ ...лимиты, available: false }, провайдер, '5h', сейчас).процент, null);
const claude = { ...провайдер, id: 'claude-code' } as ProviderView;
assert.equal(данныеСтроки(лимиты, claude, '5h', сейчас).процент, 99);
assert.equal(данныеСтроки(лимиты, claude, '1w', сейчас).процент, null);
assert.equal(данныеСтроки(лимиты, null, '5h', сейчас).процент, null);
assert.equal(данныеСтроки(лимиты, { ...провайдер, status: { state: 'ready', auth: 'api-key' } }, '5h', сейчас).процент, null);
assert.equal(данныеСтроки(лимиты, провайдер, '5h', сейчас + 3600_000).процент, null);
assert.match(данныеСтроки(лимиты, провайдер, '5h', сейчас + 3600_000).строки.join(' '), /прошлого/);
const безСброса: LimitsView = { ...лимиты, windows: [{ ...лимиты.windows[1], resetsAt: null }] };
assert.match(данныеСтроки(безСброса, провайдер, '5h', сейчас).строки.join(' '), /время неизвестно/);
assert.equal(данныеСтроки(безСброса, провайдер, '5h', сейчас + 6 * 3600_000).процент, null);
const стараяДлительность = { ...лимиты, windows: [{ ...лимиты.windows[1], windowMinutes: undefined }] };
assert.equal(данныеСтроки(стараяДлительность, провайдер, '5h', сейчас).процент, null);
for (const язык of ['ru', 'en']) {
  // Переключение словаря без браузера.
  Object.assign(globalThis.localStorage, { setItem: () => {} });
  setLang(язык);
  const строки = данныеСтроки(лимиты, провайдер, '1w', сейчас).строки.join(' ');
  assert.match(строки, /Codex/);
  assert.match(строки, /80%/);
  assert.match(строки, /2026/);
  assert.match(строки, /2.*15/);
  assert.notEqual(данныеСтроки(лимиты, провайдер, '1w', сейчас + 60_000).строки[2],
    данныеСтроки(лимиты, провайдер, '1w', сейчас).строки[2]);
}
console.log('Проверки расхода рейла: формат, провайдеры, окна, сброс, давность и ru/en — пройдены');

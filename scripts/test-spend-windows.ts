import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const папка = mkdtempSync(resolve(tmpdir(), 'office-windows-'));
const файл = resolve(папка, 'state.json');
process.env.OFFICE_STATE_FILE = файл;
const { расходыЗаПериоды, foldSpend, SPEND_MAX, dayStart } = await import('../src/server/spend');
const { emptyUsage, окноЛимита } = await import('../src/shared/types');
const { openOfficeState } = await import('../src/server/state');
const { flush } = await import('../src/server/store');
const { createLimitTracker } = await import('../src/server/limits');
import type { SpendEntryView } from '../src/shared/types';

// Проверяем преобразование каталога OpenAI в цены Codex без сетевых запросов.
const настоящийFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ openai: { models: {
  'gpt-test': { cost: { input: 2, cache_read: 0.2, output: 8 } },
} } }));
try {
  const { codexPrice } = await import('../src/server/providers/pricing');
  assert.deepEqual(await codexPrice('gpt-test'), { input: 2, cachedInput: 0.2, output: 8 });
  assert.equal(await codexPrice('missing'), null);
  process.env.OFFICE_CODEX_PRICING = JSON.stringify({ 'gpt-test': { input: 0, cachedInput: 0, output: 0 } });
  assert.deepEqual(await codexPrice('gpt-test'), { input: 0, cachedInput: 0, output: 0 });
  delete process.env.OFFICE_CODEX_PRICING;
} finally { globalThis.fetch = настоящийFetch; }

const сейчас = new Date(2026, 9, 30, 12).getTime();
const час = 3600000, сутки = 24 * час;
function запись(at: number, costUsd = 1, неизвестна = false): SpendEntryView {
  return { id: `S-${at}`, at, office: 'o-test', taskId: null, roleId: 'backend', instanceId: 'backend#1', model: 'test',
    usage: { ...emptyUsage(), costUsd, ...(неизвестна ? { costUnavailable: true } : {}) } };
}
const история = [запись(сейчас - 7 * сутки - 1, 100), запись(сейчас - 7 * сутки, 2),
  запись(сейчас - 5 * час - 1, 4), запись(сейчас - 5 * час, 8), запись(сейчас, 16), запись(сейчас + 1, 1000)];
const суммы = расходыЗаПериоды(история, сейчас - 8 * сутки, сейчас);
assert.equal(суммы.fiveHour.costUsd, 24);
assert.equal(суммы.sevenDay.costUsd, 30);
assert.equal(суммы.sevenDay.costStatus, 'available');
assert.equal(расходыЗаПериоды([], сейчас - 8 * сутки, сейчас).fiveHour.costUsd, 0);
assert.equal(расходыЗаПериоды([], сейчас, сейчас).fiveHour.costUsd, null);
assert.equal(расходыЗаПериоды([запись(сейчас, 0, true)], 0, сейчас).fiveHour.costStatus, 'unavailable');
const частичная = расходыЗаПериоды([запись(сейчас, 0, true), запись(сейчас, 5)], 0, сейчас).fiveHour;
assert.equal(частичная.costStatus, 'partial'); assert.equal(частичная.costUsd, 5);
assert.equal(частичная.unknownCostEntries, 1);
assert.equal(расходыЗаПериоды([запись(сейчас, 0)], 0, сейчас).fiveHour.costStatus, 'available');
// Восемь календарных суток сохраняют точные метки всей скользящей недели.
const граница = запись(сейчас - 7 * сутки);
assert.equal(foldSpend([граница], сейчас)[0].rolled, undefined);
const стараяСвёртка = { ...запись(dayStart(сейчас - 7 * сутки), 10), rolled: 3 };
assert.equal(расходыЗаПериоды([стараяСвёртка], 0, сейчас).sevenDay.historyPartial, true);
assert.equal(расходыЗаПериоды([стараяСвёртка], 0, сейчас).sevenDay.costUsd, null);
assert.equal(расходыЗаПериоды([{ ...запись(dayStart(сейчас - сутки), 10), rolled: 3 }], 0, сейчас).sevenDay.costUsd, 10);

const офис = openOfficeState({ id: 'o-windows', projectDir: папка, stateFile: файл }).state;
const события: any[] = [];
офис.subscribe(e => события.push(e));
офис.addUsage('backend#1', { ...emptyUsage(), costUsd: 2, tokensIn: 10 });
офис.addUsage('backend#1', { ...emptyUsage(), costUnavailable: true });
const до = офис.spendWindows();
assert.equal(до.fiveHour.costUsd, 2); assert.equal(до.fiveHour.unknownCostEntries, 1);
assert.equal(события.filter(e => e.t === 'usage').pop().windows.fiveHour.costUsd, 2);
flush(файл);
const после = openOfficeState({ id: 'o-windows-restored', projectDir: папка, stateFile: файл }).state;
assert.equal(после.spendWindows().fiveHour.costUsd, 2);
assert.equal(после.spendWindows().historyFrom, до.historyFrom);
assert.equal(после.spendWindows().fiveHour.unknownCostEntries, 1);
const снимок = после.snapshot();
assert.equal(снимок.t === 'snapshot' && снимок.usage.windows.fiveHour.costUsd, 2);
// Старые сохранения без покрытия не объявляют всю неделю полной.
const сохранение = JSON.parse(readFileSync(файл, 'utf8'));
delete сохранение.spendHistoryFrom;
writeFileSync(файл, JSON.stringify(сохранение));
const старый = openOfficeState({ id: 'o-windows-legacy', projectDir: папка, stateFile: файл }).state;
assert.equal(старый.spendWindows().sevenDay.historyPartial, true);
// Жёсткая подрезка не выдаёт оставшиеся записи за полную историю.
сохранение.spendHistoryFrom = 0;
сохранение.spend = Array.from({ length: SPEND_MAX + 1 }, (_, i) => ({ ...запись(Date.now() - SPEND_MAX + i), id: `S-${i + 1}` }));
writeFileSync(файл, JSON.stringify(сохранение));
const подрезанный = openOfficeState({ id: 'o-windows-trimmed', projectDir: папка, stateFile: файл }).state;
assert.equal(подрезанный.spendList().length, SPEND_MAX);
assert.equal(подрезанный.spendWindows().fiveHour.historyPartial, true);

офис.noteRateLimit({ status: 'allowed', usageReport: { rate_limits: {
  codex_secondary: { utilization: 0.5, window_minutes: 300 },
} } }, 'codex');
const событиеЛимита = события.filter(e => e.t === 'limits').pop();
assert.equal(окноЛимита(событиеЛимита.limits, 'codex', '5h')?.utilization, 0.5);

const трекер = createLimitTracker('codex'); трекер.forgetLimits();
assert.equal(окноЛимита(трекер.limitsView(), 'codex', '5h'), null);
трекер.noteRateLimit({ status: 'allowed', usageReport: { rate_limits_available: true, rate_limits: {
  codex_primary: { utilization: 0.5, window_minutes: 10080 }, codex_secondary: { utilization: 12, window_minutes: 300 },
} } });
assert.equal(окноЛимита(трекер.limitsView(), 'codex', '5h')?.utilization, 12);
assert.equal(окноЛимита(трекер.limitsView(), 'codex', '1w')?.utilization, 0.5);
assert.equal(окноЛимита(трекер.limitsView(), 'claude-code', '5h'), null);
трекер.noteUsageReport({ rate_limits: { codex_primary: { utilization: 31 }, codex_secondary: { utilization: 0, window_minutes: 300 } } });
assert.equal(окноЛимита(трекер.limitsView(), 'codex', '1w'), null);
assert.equal(окноЛимита(трекер.limitsView(), 'codex', '5h')?.utilization, 0);
трекер.noteUsageReport({ rate_limits: { codex_secondary: { utilization: 20, window_minutes: 300, resets_at: new Date(1).toISOString() } } });
assert.equal(окноЛимита(трекер.limitsView(), 'codex', '5h'), null);
console.log('Проверены стоимость, границы 5h/1w, полнота, перезапуск, подрезка и события лимитов.');

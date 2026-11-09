import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { КаталогCodex } from '../src/shared/codex';
import { каталогCodex, создатьHttpКаталогаCodex } from '../src/server/providers/каталог-codex';

const модель = {
  model: 'тест-модель', displayName: 'Тестовая модель', hidden: false, isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: 'особое', description: 'Из установленного Codex' }],
  defaultReasoningEffort: 'особое',
};
async function проверить(страницы: unknown[], ошибкаИнициализации = false) {
  let закрытия = 0;
  const вызовы: Array<{ метод: string; параметры: any; таймаут: number | undefined }> = [];
  const результат = await каталогCodex(() => ({
    async request(метод, параметры, таймаут) {
      вызовы.push({ метод, параметры, таймаут });
      if (метод === 'initialize') {
        if (ошибкаИнициализации) throw new Error('секретная диагностика');
        return {};
      }
      const страница = страницы.shift();
      if (страница instanceof Error) throw страница;
      return страница;
    },
    send(сообщение) { assert.deepEqual(сообщение, { method: 'initialized' }); },
    close() { закрытия++; },
  }));
  assert.equal(закрытия, 1);
  assert.ok(вызовы.every(вызов => вызов.таймаут === 10_000));
  assert.ok(вызовы.every(вызов => ['initialize', 'model/list'].includes(вызов.метод)));
  return { результат, вызовы };
}

const { результат, вызовы } = await проверить([
  { data: [модель, { ...модель, model: 'скрытая', hidden: true }], nextCursor: 'следующая' },
  { data: [{ ...модель, model: 'вторая', isDefault: false }], nextCursor: null },
]);
assert.deepEqual(результат, { ok: true, models: [
  { id: 'тест-модель', label: 'Тестовая модель', supportedReasoningEfforts: модель.supportedReasoningEfforts,
    defaultReasoningEffort: 'особое', isDefault: true },
  { id: 'вторая', label: 'Тестовая модель', supportedReasoningEfforts: модель.supportedReasoningEfforts,
    defaultReasoningEffort: 'особое', isDefault: false },
] });
assert.deepEqual(вызовы[1]?.параметры, { cursor: undefined, limit: 100, includeHidden: false });
assert.equal(вызовы[2]?.параметры.cursor, 'следующая');
assert.deepEqual((await проверить([{ data: [], nextCursor: null }])).результат, { ok: true, models: [] });

for (const страницы of [
  [new Error('таймаут')],
  [{ data: [модель], nextCursor: 'далее' }, new Error('поздняя ошибка')],
  [{ data: [модель], nextCursor: 'повтор' }, { data: [], nextCursor: 'повтор' }],
  [{ data: [{ ...модель, supportedReasoningEfforts: undefined }], nextCursor: null }],
  [{ data: [{ ...модель, defaultReasoningEffort: 'выдуманное' }], nextCursor: null }],
  [{ data: [модель], nextCursor: 42 }],
  [{ data: null, nextCursor: null }],
  [{}],
]) {
  const { результат } = await проверить(страницы);
  assert.equal(результат.ok, false);
  assert.ok(!('models' in результат), 'При ошибке нет частичного или фиктивного каталога');
}
const ошибка = (await проверить([], true)).результат;
assert.equal(ошибка.ok, false);
assert.ok(!JSON.stringify(ошибка).includes('секретная'));
assert.equal((await каталогCodex(() => { throw new Error('нет бинарника'); })).ok, false);

async function http(каталог: КаталогCodex, метод = 'GET', путь = '/api/providers/codex/models') {
  let статус = 0;
  let заголовки: Record<string, string> = {};
  let тело = '';
  let вызван = false;
  let завершить!: () => void;
  const готово = new Promise<void>(решить => { завершить = решить; });
  const ответ = {
    setHeader(имя: string, значение: string) { заголовки[имя] = значение; },
    writeHead(код: number, поля: Record<string, string>) { статус = код; заголовки = { ...заголовки, ...поля }; },
    end(текст: string) { тело = текст; завершить(); },
  } as unknown as ServerResponse;
  const обработано = создатьHttpКаталогаCodex(async () => { вызван = true; return каталог; })(
    { method: метод } as IncomingMessage, ответ, путь);
  if (обработано) await готово;
  return { обработано, статус, заголовки, тело: тело ? JSON.parse(тело) : null, вызван };
}
assert.deepEqual((await http(результат)).тело, результат);
assert.equal((await http(результат)).статус, 200);
assert.equal((await http({ ok: true, models: [] })).статус, 200);
const сбой = await http(ошибка);
assert.equal(сбой.статус, 502);
assert.deepEqual(сбой.тело, ошибка);
assert.equal(сбой.заголовки['Cache-Control'], 'no-store');
const неверныйМетод = await http(результат, 'POST');
assert.equal(неверныйМетод.статус, 405);
assert.equal(неверныйМетод.вызван, false);
assert.equal(неверныйМетод.заголовки.Allow, 'GET');
assert.equal((await http(результат, 'GET', '/api/providers/другой')).обработано, false);
console.log('Каталог Codex: модели, усилия, страницы, ошибки и HTTP проверены');

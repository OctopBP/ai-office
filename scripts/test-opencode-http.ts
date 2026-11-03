import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { создатьHttpOpenCode } from '../src/server/providers/opencode-http';
import { каталогDTO, ОшибкаOpenCode } from '../src/server/providers/подключение-opencode';
import { handleProvidersHttp } from '../src/server/providers-api';
import { engineFor } from '../src/server/engines';

const секрет = 'СЕКРЕТ-upstream-api-key';
const снимок = каталогDTO({ all: [{ id: 'openrouter', npm: '@openrouter/ai-sdk-provider', models: {
  'vendor/model': { name: 'Модель', capabilities: { toolcall: true, input: { text: true }, output: { text: true },
    temperature: true, reasoning: false }, limit: { output: 100 }, variants: { high: { apiKey: секрет } },
    options: { apiKey: секрет }, headers: { Authorization: секрет } },
  reasoning: { capabilities: { toolcall: true, input: { text: true }, output: { text: true }, reasoning: true } },
} }, { id: 'azure', npm: '@ai-sdk/azure', models: { hidden: {} } }] }, '1.18.34', { openrouter: { хвост: '1234' } });
const выбор = { provider: 'opencode', model: 'openrouter/vendor/model', opencode: { температура: 0, пределОтвета: 100, вариант: 'high' } };
let доступен = true, версия = '1.18.34', сбой: Error | undefined, устарел = false;
const запросы: Array<[string, boolean]> = [];
const обработчик = создатьHttpOpenCode({
  найти: async () => доступен ? { version: версия } : null,
  каталог: async (v, force = false) => {
    запросы.push([v, force]);
    if (сбой) throw сбой;
    if (v !== '1.18.34') return каталогDTO({}, v);
    const копия = structuredClone(снимок);
    копия.dto.устарел = устарел;
    return копия;
  },
});
async function запрос(method: string, путь: string, тело?: unknown, handler = обработчик, части?: Buffer[]) {
  const [url, query = ''] = путь.split('?');
  const req = Readable.from(части ?? (тело === undefined ? [] : [Buffer.from(typeof тело === 'string' ? тело : JSON.stringify(тело))])) as IncomingMessage;
  req.method = method;
  return new Promise<{ статус: number; тело: any }>((resolve, reject) => {
    let статус = 0;
    const res = {
      writeHead(code: number) { статус = code; },
      end(body: string) {
        try {
          assert(!body.includes(секрет), 'Секрет не должен попадать в HTTP');
          resolve({ статус, тело: JSON.parse(body) });
        } catch (e) { reject(e); }
      },
    } as unknown as ServerResponse;
    if (!handler(req, res, url!, query)) reject(new Error('Маршрут не зарегистрирован'));
  });
}
const каталог = await запрос('GET', '/api/providers/opencode?force=1');
assert.equal(каталог.статус, 200);
assert.equal(каталог.тело.status.state, 'ready');
assert.deepEqual(каталог.тело.models.map((m: any) => m.id), ['openrouter/vendor/model', 'openrouter/reasoning']);
assert.deepEqual(каталог.тело.models[0].opencode.температура, { мин: 0, макс: 2 });
assert.deepEqual(каталог.тело.models[0].opencode.пределОтвета, { мин: 1, макс: 100 });
assert.equal(каталог.тело.models[1].opencode.температура, undefined);
assert(каталог.тело.models[1].opencode.причиныПараметров.температура);
assert.equal(каталог.тело.opencode.провайдеры[1].модели[0].opencode.доступна, false);
assert.deepEqual(запросы.pop(), ['1.18.34', true]);
await запрос('GET', '/api/providers/opencode');
assert.deepEqual(запросы.pop(), ['1.18.34', false]);
const ревизия = снимок.dto.ревизия;
const результат = await запрос('POST', '/api/providers/opencode/validate', { выбор, ревизия });
assert.deepEqual(результат, { статус: 200, тело: { выбор, предупреждения: [], ревизия } });

for (const неверный of [
  { ...выбор, model: 'несуществующая' },
  { ...выбор, model: 'azure/hidden' },
  { ...выбор, provider: 'openrouter' },
  { ...выбор, opencode: { температура: 3 } },
  { ...выбор, opencode: { пределОтвета: 101 } },
  { ...выбор, opencode: { вариант: 'нет' } },
  { ...выбор, opencode: null },
  { ...выбор, model: 'openrouter/reasoning', opencode: { температура: 1 } },
  { ...выбор, model: 'openrouter/reasoning', opencode: { пределОтвета: 1 } },
  { ...выбор, opencode: { [секрет]: 1 } },
  { ...выбор, [секрет]: секрет },
]) {
  const ответ = await запрос('POST', '/api/providers/opencode/validate', { выбор: неверный, ревизия });
  assert.equal(ответ.статус, 400);
  assert.equal(typeof ответ.тело.сообщение, 'string');
}
for (const тело of ['{', 'null', '[]', {}, { выбор }, { выбор, ревизия: 5 }, { выбор, ревизия, [секрет]: секрет }, 'x'.repeat(65537)]) {
  assert.equal((await запрос('POST', '/api/providers/opencode/validate', тело)).статус, 400);
}
const изменился = await запрос('POST', '/api/providers/opencode/validate', { выбор, ревизия: 'старая' });
assert.equal(изменился.статус, 409);
assert.equal(изменился.тело.код, 'catalog-changed');
устарел = true;
assert.equal((await запрос('GET', '/api/providers/opencode')).тело.status.state, 'unreachable');
assert.equal((await запрос('POST', '/api/providers/opencode/validate', { выбор, ревизия })).статус, 409);
устарел = false;
// Разрываем обязательный ключ «выбор» между байтами первой кириллической буквы.
const байты = Buffer.from(JSON.stringify({ выбор, ревизия }));
const граница = байты.indexOf(Buffer.from('в')) + 1;
assert(граница > 0);
const части = [байты.subarray(0, граница), байты.subarray(граница)];
assert.deepEqual(await запрос('POST', '/api/providers/opencode/validate', undefined, обработчик, части), результат);
доступен = false;
assert.deepEqual(await запрос('POST', '/api/providers/opencode/validate', undefined, обработчик, части), {
  статус: 503, тело: { код: 'not-installed', сообщение: 'Движок OpenCode не установлен' },
});
for (const [метод, путь, тело] of [['GET', '/api/providers/opencode', undefined],
  ['POST', '/api/providers/opencode/validate', { выбор, ревизия }]] as const) {
  assert.equal((await запрос(метод, путь, тело)).статус, 503);
}
доступен = true;
версия = '1.19.5';
assert.equal((await запрос('GET', '/api/providers/opencode')).статус, 503);
версия = '1.18.34';
сбой = new Error(секрет);
assert.deepEqual(await запрос('GET', '/api/providers/opencode'), {
  статус: 502, тело: { код: 'upstream', сообщение: 'Не удалось получить метаданные OpenCode' },
});
сбой = new ОшибкаOpenCode(409, 'catalog-changed', 'Подключения изменились; обновите каталог');
assert.equal((await запрос('GET', '/api/providers/opencode')).статус, 409);
assert.equal((await запрос('POST', '/api/providers/opencode', undefined, handleProvidersHttp)).статус, 405);
assert.equal((await запрос('GET', '/api/providers/opencode/validate', undefined, handleProvidersHttp)).статус, 405);
// Защитный отказ запуска T-797 остаётся в адаптере.
assert.equal((await engineFor('opencode').status('opencode')).state, 'error');
console.log('HTTP OpenCode: каталог, параметры, валидация, ошибки и регистрация — успешно');

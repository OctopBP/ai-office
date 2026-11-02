import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS, sameChoice, проверитьФормуOpenCode } from '../src/shared/providers';
import { каталогOpenCode, каталогDTO, проверитьВыбор } from '../src/server/providers/подключение-opencode';
import { кешКаталогаOpenCode, СРОК_КАТАЛОГА_OPENCODE } from '../src/server/providers/кеш-каталога-opencode';
import { окружениеКаталогаOpenCode } from '../src/server/providers/каталог-процесс-opencode';
import { хранилищеКлючейOpenCode } from '../src/server/providers/ключи-opencode';
import { memoryKeychain, KEY_VAR, providerKey, saveKey } from '../src/server/engines/keys';
import { projectEnv } from '../src/server/childenv';
import { engineFor } from '../src/server/engines';

const версия = '1.18.34';
const секрет = 'СЕКРЕТ-не-для-DTO-1234';
const модель = {
  name: 'Модель', capabilities: { toolcall: true, input: { text: true }, output: { text: true }, temperature: true, reasoning: false },
  limit: { context: 100000, input: 90000, output: 40000 }, cost: { input: 1, output: 2 },
  variants: { high: { secret: секрет } }, options: { apiKey: секрет }, headers: { secret: секрет },
};
const сырой = { all: [
  { id: 'openrouter', name: 'OpenRouter', npm: '@openrouter/ai-sdk-provider', models: { 'vendor/model': модель } },
  { id: 'opencode', npm: '@ai-sdk/openai-compatible', models: {
    free: { ...модель, cost: { input: 0, output: 0 } }, paid: модель,
    reasoning: { ...модель, capabilities: { ...модель.capabilities, reasoning: true }, variants: {} },
  } },
  { id: 'azure', npm: '@ai-sdk/azure', models: { model: модель } },
], connected: ['opencode'] };

assert.equal(PROVIDERS.xai.defaultModel, 'grok-4.7');
assert.equal(PROVIDERS.google.sdk.npm, '@ai-sdk/google');
assert.equal(PROVIDERS.opencode.engine, 'opencode');
assert.equal(KEY_VAR.opencode, undefined);
assert.equal(providerKey('opencode'), null);
await assert.rejects(saveKey('opencode', секрет));
assert.deepEqual(проверитьФормуOpenCode({ температура: 0, пределОтвета: 1 }), { температура: 0, пределОтвета: 1 });
for (const параметры of [null, [], { foo: 1 }, { температура: '1' }, { температура: NaN }, { температура: Infinity },
  { температура: -1 }, { температура: 2.1 }, { пределОтвета: 0 }, { пределОтвета: 1.1 }, { пределОтвета: 32001 }, { вариант: '' }]) {
  assert.throws(() => проверитьФормуOpenCode(параметры));
}
const выбор = { provider: 'opencode' as const, model: 'openrouter/vendor/model' };
assert(sameChoice(выбор, { ...выбор, opencode: {} }));
assert(!sameChoice(выбор, { ...выбор, opencode: { температура: 0 } }));
assert(sameChoice({ ...выбор, opencode: { температура: 1, вариант: 'high' } },
  { ...выбор, opencode: { вариант: 'high', температура: 1 } }));
const снимок = каталогDTO(сырой, версия, { openrouter: { хвост: '1234' } });
assert(!JSON.stringify(снимок.dto).includes(секрет));
for (const запрещено of ['apiKey', 'headers', 'npm', 'options']) assert(!JSON.stringify(снимок.dto).includes(запрещено));
assert.equal(снимок.dto.провайдеры[0].модели[0].opencode.модель, 'vendor/model');
assert.equal(снимок.dto.провайдеры[1].модели[0].opencode.доступна, true);
assert.equal(снимок.dto.провайдеры[1].модели[1].opencode.доступна, false);
assert.equal(снимок.dto.провайдеры[1].модели[2].opencode.пределОтвета, undefined);
assert.equal(снимок.dto.провайдеры[2].модели[0].opencode.доступна, false);
assert.equal(каталогDTO(сырой, '1.19.5').dto.совместима, false);
assert.equal((await каталогOpenCode('1.19.5')).dto.совместима, false);
assert.throws(() => проверитьВыбор(выбор, каталогDTO(сырой, '1.19.5')));
assert.throws(() => проверитьВыбор(выбор, снимок, 'прошлая-ревизия'));
assert.throws(() => проверитьВыбор({ ...выбор, opencode: { вариант: 'unknown' } }, снимок));
assert.throws(() => проверитьВыбор({ ...выбор, model: 'unknown' }, снимок));
assert.deepEqual(проверитьВыбор({ ...выбор, opencode: { температура: 0, пределОтвета: 32000 } }, снимок).opencode,
  { температура: 0, пределОтвета: 32000 });
const несовместимый = structuredClone(сырой);
несовместимый.all[0].npm = 'неизвестный-sdk';
assert.throws(() => проверитьВыбор(выбор, каталогDTO(несовместимый, версия, { openrouter: { хвост: '1234' } })));
assert.notEqual(снимок.dto.ревизия, каталогDTO(сырой, версия, { openrouter: { хвост: '1234' } }, 1).dto.ревизия);

let время = 1000, вызовы = 0, сбой = false;
const кеш = кешКаталогаOpenCode(async (v, r) => {
  вызовы++;
  await Promise.resolve();
  if (сбой) throw new Error('сеть');
  return каталогDTO(сырой, v, {}, r);
}, () => время);
await Promise.all([кеш(версия, 0), кеш(версия, 0)]);
assert.equal(вызовы, 1);
const копия = await кеш(версия, 0);
копия.dto.провайдеры.length = 0;
assert((await кеш(версия, 0)).dto.провайдеры.length);
время += СРОК_КАТАЛОГА_OPENCODE;
сбой = true;
const старый = await кеш(версия, 0);
assert.equal(старый.dto.устарел, true);
assert.equal(старый.dto.обновлёнВ, 1000);
assert.throws(() => проверитьВыбор(выбор, старый));
await assert.rejects(кеш('другая', 0));
await assert.rejects(кеш(версия, 1));
сбой = false;
await кеш(версия, 0, true);
assert.equal((await кеш(версия, 0)).dto.устарел, false);

const связка = memoryKeychain();
await связка.set('provider:openrouter', 'старый-пресет');
const ключи = хранилищеКлючейOpenCode(связка);
await ключи.сохранить('openrouter', секрет);
await ключи.сохранить('openai', 'другой-ключ');
assert.equal(await связка.get('provider:opencode:openrouter'), секрет);
assert.deepEqual((await ключи.сведения()).openrouter, { хвост: '1234' });
assert(!JSON.stringify(await ключи.сведения()).includes(секрет));
await ключи.удалить('openrouter');
assert.equal(await ключи.прочитать('openrouter'), null);
assert.equal(await ключи.прочитать('openai'), 'другой-ключ');
assert.equal(await связка.get('provider:openrouter'), 'старый-пресет');
await assert.rejects(ключи.сохранить('azure', секрет));
for (const неверный of ['', 'с пробелом', 'a\nb', 'a'.repeat(1501), null]) await assert.rejects(ключи.сохранить('openai', неверный));
for (const метод of ['available', 'get', 'set', 'delete'] as const) {
  const отказ = хранилищеКлючейOpenCode({ ...memoryKeychain(), [метод]: async () => { throw new Error(секрет); } });
  const действия = метод === 'set' ? отказ.сохранить('openai', секрет) : метод === 'delete' ? отказ.удалить('openai') : отказ.сведения();
  await assert.rejects(действия, e => e instanceof Error && !e.message.includes(секрет) && /связка/.test(e.message));
}
const нетСвязки = хранилищеКлючейOpenCode({ ...memoryKeychain(), available: async () => false });
await assert.rejects(нетСвязки.сохранить('openai', секрет));
const дом = mkdtempSync(join(tmpdir(), 'office-test-catalog-'));
try {
  const env = окружениеКаталогаOpenCode(дом, { PATH: '/bin', HOME: '/личный', XDG_CONFIG_HOME: '/личный',
    OPENAI_API_KEY: секрет, OFFICE_OPENCODE_API_KEY: секрет, OPENCODE_CONFIG: '/личный/config', NODE_OPTIONS: секрет });
  assert.equal(env.HOME, дом);
  assert(env.XDG_CONFIG_HOME?.startsWith(дом));
  assert(!JSON.stringify(env).includes(секрет));
  assert.equal(env.OPENCODE_CONFIG, undefined);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(config.permission, { '*': 'deny' });
  assert.deepEqual(config.plugin, []);
  assert.deepEqual(config.mcp, {});
} finally { rmSync(дом, { recursive: true, force: true }); }
assert.equal(projectEnv({ OFFICE_OPENCODE_API_KEY: секрет }).OFFICE_OPENCODE_API_KEY, undefined);
assert.equal((await engineFor('opencode').status('opencode')).state, 'error');
assert.deepEqual(await engineFor('opencode').models('opencode'), []);
console.log('Каталог OpenCode, совместимость, кеш, окружение и ключи: проверки прошли');

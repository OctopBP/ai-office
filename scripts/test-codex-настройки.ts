import assert from 'node:assert/strict';
import {
  эффективныйВыборМодели, проверитьВыборCodex, ОшибкаНастроекCodex,
  type КаталогCodex,
} from '../src/shared/codex.js';
import { sameChoice, type ModelChoice } from '../src/shared/providers.js';

const каталог: КаталогCodex = {
  ok: true,
  models: [
    { id: 'модель-а', label: 'А', isDefault: true, defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }] },
    { id: 'модель-б', label: 'Б', isDefault: false, defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }] },
  ],
};
const офис: ModelChoice = { provider: 'codex', model: 'модель-а', codex: { reasoningEffort: 'high' } };
const агент: ModelChoice = { provider: 'codex', model: 'модель-б', codex: { reasoningEffort: 'medium' } };
const снимок = JSON.stringify({ офис, агент, каталог });
const ошибка = (код: ОшибкаНастроекCodex['code']) =>
  (значение: unknown) => значение instanceof ОшибкаНастроекCodex && значение.code === код;

assert.deepEqual(эффективныйВыборМодели(офис, undefined, каталог), офис, 'наследование офиса');
assert.deepEqual(эффективныйВыборМодели(офис, агент, каталог), агент, 'полное переопределение');
assert.deepEqual(эффективныйВыборМодели(офис, null, каталог), офис, 'возврат к наследованию');
assert.deepEqual(эффективныйВыборМодели(null, агент, каталог), агент, 'собственный выбор без офисного');
assert.equal(эффективныйВыборМодели(null, undefined, каталог), null);
assert.deepEqual(проверитьВыборCodex({ provider: 'codex', model: 'default' }, каталог),
  { provider: 'codex', model: 'модель-а' }, 'старое умолчание без усилия');
assert.deepEqual(эффективныйВыборМодели(офис, { provider: 'codex', model: 'модель-б' }, каталог),
  { provider: 'codex', model: 'модель-б' }, 'усилие офиса не переносится на другую модель');
assert.throws(() => проверитьВыборCodex({ ...офис, model: 'модель-б' }, каталог), ошибка('invalid-effort'));
assert.throws(() => проверитьВыборCodex({ ...офис, model: 'нет' }, каталог), ошибка('invalid-model'));
assert.throws(() => проверитьВыборCodex(офис, { ok: true, models: [] }), ошибка('invalid-model'));
assert.throws(() => проверитьВыборCodex(офис, { ok: false, code: 'catalog-unavailable', message: 'нет каталога' }),
  ошибка('catalog-unavailable'));
for (const codex of [null, [], { reasoningEffort: 1 }, { reasoningEffort: '' }, { другое: true }]) {
  assert.throws(() => проверитьВыборCodex({ ...офис, codex }, каталог), ошибка('invalid-settings'));
}
assert.throws(() => проверитьВыборCodex({ provider: 'claude-code', model: 'модель-а' }, каталог),
  ошибка('invalid-settings'));
assert.deepEqual(эффективныйВыборМодели({ ...офис, model: 'нет' }, агент, каталог), агент,
  'неиспользуемый офисный выбор не проверяется');
const иной: ModelChoice = { provider: 'claude-code', model: 'другая' };
assert.equal(эффективныйВыборМодели(иной, undefined, { ok: false, code: 'catalog-unavailable', message: '' }), иной);
assert.equal(sameChoice(офис, { ...офис, codex: { reasoningEffort: 'low' } }), false);
assert.equal(sameChoice(офис, { ...офис }), true);
assert.equal(sameChoice({ provider: 'codex', model: 'модель-а' },
  { provider: 'codex', model: 'модель-а', codex: {} }), true);
assert.equal(JSON.stringify({ офис, агент, каталог }), снимок, 'входные данные не изменены');
console.log('Настройки Codex: наследование, переопределение, старые данные и ошибки проверены');

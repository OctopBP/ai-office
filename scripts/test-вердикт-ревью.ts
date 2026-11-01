/** Адресные проверки настоящего reviewPr с поддельной сессией, без модели и живого офиса. */
import './_isolate';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

process.env.OFFICE_LANG = 'ru';
const { openOfficeState } = await import('../src/server/state');
const { reviewPr } = await import('../src/server/agents');
const { engineFor, localTools } = await import('../src/server/engines');
type Запрос = import('../src/server/engines').SessionRequest;
type Сессия = import('../src/server/engines').EngineSession;
type ПР = import('../src/shared/types').PullRequestView;
const корень = dirname(process.env.OFFICE_STATE_FILE!);
mkdirSync(корень, { recursive: true });
const офис = openOfficeState({ id: 'o-verdict', projectDir: корень, stateFile: process.env.OFFICE_STATE_FILE! }).state;
офис.updateSettings({ model: { provider: 'codex', model: 'default' } });
const движок = engineFor('codex');
движок.status = async () => ({ state: 'ready', auth: 'subscription' });
const задача = офис.createTask({ title: 'Вердикт', description: 'Проверка завершения', criteria: [], roleId: 'backend' });
const пр = { branch: 'нет-ветки', base: 'main', repoDir: корень, rounds: 0, reviews: [], reviewerId: null } as unknown as ПР;
type Действие = 'approve_pr' | 'request_changes' | 'текст' | 'ошибка' | 'отмена' | 'бюджет' | 'обрыв' | 'двойной' | 'вердикт-и-ошибка' | 'предохранитель';
let открытия = 0;
let ввод: string[] = [];
let дубли: boolean[] = [];
function сессия(запрос: Запрос, действия: Действие[]): Сессия {
  открытия++;
  const инструменты = localTools.get(запрос.options.mcpServers!.office as object)!;
  assert(инструменты.some(и => и.name === 'approve_pr') && инструменты.some(и => и.name === 'request_changes'));
  const вызвать = async (имя: string) => инструменты.find(и => и.name === имя)!.handler({ summary: имя }, {} as never);
  return {
    async *[Symbol.asyncIterator]() {
      const поток = typeof запрос.prompt === 'string'
        ? (async function* () { yield { message: { content: запрос.prompt } }; })() : запрос.prompt;
      let номер = 0;
      for await (const сообщение of поток) {
        const текст = String(сообщение.message.content);
        ввод.push(текст);
        yield { type: 'system', subtype: 'init', session_id: 'codex:review-test' } as never;
        if (текст.startsWith('/compact')) {
          yield { type: 'result', subtype: 'success', is_error: false, result: '' } as never;
          continue;
        }
        const действие = действия[номер++];
        assert(действие, 'лишнее продолжение');
        if (действие === 'ошибка') throw new Error('ошибка транспорта');
        if (действие === 'обрыв') return;
        if (действие === 'предохранитель') {
          yield { type: 'assistant', message: { id: 'usage', content: [], usage: {
            input_tokens: 50_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          } } } as never;
          throw new Error('сессия остановлена предохранителем');
        }
        if (действие === 'отмена') запрос.options.abortController!.abort();
        if (['approve_pr', 'request_changes', 'двойной', 'вердикт-и-ошибка'].includes(действие)) {
          await вызвать(действие === 'request_changes' ? 'request_changes' : 'approve_pr');
          if (действие === 'двойной') дубли.push(Boolean((await вызвать('request_changes')).isError));
        }
        const ошибка = действие === 'бюджет' || действие === 'вердикт-и-ошибка';
        yield { type: 'result', subtype: ошибка ? 'error_max_budget_usd' : 'success',
          is_error: ошибка, result: 'Одобрено обычным текстом', errors: ошибка ? ['лимит'] : [] } as never;
      }
    },
    mcpServerStatus: async () => [],
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('нет лимитов'); },
  } as Сессия;
}
async function проверить(действия: Действие[], продолжение: boolean, ошибка?: RegExp) {
  ввод = []; открытия = 0; дубли = [];
  движок.start = запрос => сессия(запрос, действия);
  const сжимать = Boolean(задача.reviewerSessionId);
  const результат = await reviewPr(офис, задача, пр);
  const задания = ввод.filter(т => !т.startsWith('/compact'));
  assert.equal(открытия, 1, 'продолжение не открывает новую сессию и предохранитель');
  assert.equal(задания.length, продолжение ? 2 : 1);
  assert.equal(ввод.filter(т => т.startsWith('/compact')).length, сжимать ? 1 : 0,
    'продолжение вердикта не запускает новое сжатие');
  if (продолжение) {
    assert.match(задания[1], /Не запускай повторную полную проверку/);
    assert(!задания[1].includes('Текущий полный дифф'));
  }
  assert.equal(офис.tasks.get(задача.id)!.reviewerSessionId, 'codex:review-test');
  if (ошибка) {
    assert.match(результат.error!, ошибка);
    assert.equal(результат.verdict, 'changes');
    assert.equal(результат.text, '', 'текст или вердикт ошибочной сессии не принимается');
  } else {
    assert.equal(результат.error, undefined);
    assert.equal(результат.verdict, действия.includes('request_changes') ? 'changes' : 'approve');
  }
  assert.equal(офис.instances.get('reviewer#1')!.currentTaskId, null);
  return результат;
}
await проверить(['approve_pr'], false);
await проверить(['request_changes'], false);
await проверить(['текст', 'approve_pr'], true);
await проверить(['текст', 'request_changes'], true);
await проверить(['текст', 'текст'], true, /единственное продолжение исчерпано/);
await проверить(['ошибка'], false, /ошибка транспорта/);
await проверить(['отмена'], false, /отменено/);
await проверить(['бюджет'], false, /лимит|бюджет/i);
await проверить(['обрыв'], false, /не ответив|без итогового|не дождалась|не дойдя/);
await проверить(['двойной'], false);
assert.deepEqual(дубли, [true], 'второй вердикт отклонён');
await проверить(['вердикт-и-ошибка'], false, /лимит|бюджет/i);
await проверить(['текст', 'ошибка'], true, /ошибка транспорта/);
await проверить(['текст', 'отмена'], true, /отменено/);
await проверить(['предохранитель'], false, /предохранитель|порог/i);
console.log('Вердикт ревью: 14 сценариев прошли.');

/**
 * Кнопки быстрого ответа в чате с менеджером (T-599): варианты нормализуются
 * одной функцией (2–4, до 40 символов, без пустых и повторов), `offer_replies`
 * копит их на сессии чата, а конец хода прикрепляет к последней реплике хода —
 * той, что ложится в чат по `result`. Реплика с вариантами уходит на веб
 * событием `chat`, сохраняется в состоянии и переживает перезапуск; кнопки
 * гаснут, как только владелец ответил в этом чате.
 *
 * Запуск: npm run test:replies
 */
import assert from 'node:assert/strict';
import type { ChatEntry, ServerEvent } from '../src/shared/types';
import { REPLY_LEN, repliesOpen, tidyReplies } from '../src/shared/types';
import { offerReplies, settlePmReply } from '../src/server/replies';
import { getOffice, unloadOfficeState } from '../src/server/state';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const OFFICE_ID = 'o-replies';

function main(): void {
  console.log('нормализация');
  check('пробелы схлопнуты, пустые и повторы без учёта регистра выброшены', () => {
    assert.deepEqual(tidyReplies(['  Да,   запускай ', '', '   ', 'да, запускай', 'Пока нет']), ['Да, запускай', 'Пока нет']);
  });
  check('не больше четырёх, лишние отброшены', () => {
    assert.deepEqual(tidyReplies(['А', 'Б', 'В', 'Г', 'Д']), ['А', 'Б', 'В', 'Г']);
  });
  check('меньше двух — кнопок нет', () => {
    assert.deepEqual(tidyReplies(['Да']), []);
    assert.deepEqual(tidyReplies(['Да', ' да ']), []);
    assert.deepEqual(tidyReplies([]), []);
    assert.deepEqual(tidyReplies(undefined), []);
  });
  check('длинный вариант обрезан до 40 символов с многоточием', () => {
    const [long] = tidyReplies(['слово '.repeat(20), 'Нет']);
    assert.ok(long.length <= REPLY_LEN, long);
    assert.ok(long.endsWith('…'), long);
  });
  check('не строки пропускаются', () => {
    assert.deepEqual(tidyReplies([1, null, 'Да', { a: 1 }, 'Нет']), ['Да', 'Нет']);
  });

  const office = getOffice(OFFICE_ID);
  office.seed();
  const chat = office.ensureMainChat();
  const other = office.createPmChat('Другая тема');
  const pm = office.pmSession(chat.id);
  const events: ServerEvent[] = [];
  const off = office.subscribe((e) => { events.push(e); });

  console.log('привязка к реплике хода');
  check('плохие варианты не принимаются и прежние не трогают', () => {
    assert.equal(offerReplies(pm, ['Да']), null);
    assert.equal(pm.replies, null);
  });
  let entry!: ChatEntry;
  check('варианты ждут конца хода и ложатся на итоговую реплику', () => {
    assert.deepEqual(offerReplies(pm, ['Запускай', 'Подожди']), ['Запускай', 'Подожди']);
    // Повторный вызов в том же ходе заменяет прежние: кнопки — к последней реплике.
    assert.deepEqual(offerReplies(pm, ['Да, запускай', 'Пока нет', 'да, запускай']), ['Да, запускай', 'Пока нет']);
    entry = settlePmReply(office, pm, 'Задача готова к запуску. Хотите, запущу?');
    assert.deepEqual(entry.replies, ['Да, запускай', 'Пока нет']);
    assert.equal(entry.chatId, chat.id);
    assert.equal(entry.from, 'pm#1');
    assert.equal(pm.replies, null, 'после хода варианты забыты');
  });
  check('следующая реплика без offer_replies кнопок не получает', () => {
    const next = settlePmReply(office, pm, 'Принято.');
    assert.equal(next.replies, undefined);
  });
  check('реплика с вариантами ушла на веб событием chat', () => {
    const sent = events.find((e): e is Extract<ServerEvent, { t: 'chat' }> => e.t === 'chat' && e.entry.id === entry.id);
    assert.ok(sent, 'событие chat с репликой');
    assert.deepEqual(sent.entry.replies, ['Да, запускай', 'Пока нет']);
  });
  check('варианты сохраняются в состоянии и читаются после перезапуска', () => {
    const saved = JSON.parse(JSON.stringify(office.toPersisted())) as { chat: ChatEntry[] };
    assert.deepEqual(saved.chat.find((e) => e.id === entry.id)?.replies, ['Да, запускай', 'Пока нет']);
  });

  console.log('отработанные кнопки');
  check('кнопки живы, пока владелец не ответил в этом чате', () => {
    assert.equal(repliesOpen(entry, office.chat), true);
    office.addChat('user', 'Про другое', 'pm#1', undefined, other.id);
    assert.equal(repliesOpen(entry, office.chat), true, 'ответ в другом чате не гасит');
    office.addChat('pm#1', 'Задача T-1 в работе', 'pm#1', undefined, chat.id);
    assert.equal(repliesOpen(entry, office.chat), true, 'реплика менеджера не гасит');
    office.addChat('user', 'Да, запускай', 'pm#1', undefined, chat.id);
    assert.equal(repliesOpen(entry, office.chat), false);
  });
  check('реплика без вариантов кнопок не показывает', () => {
    const plain = office.chat.find((e) => e.text === 'Принято.')!;
    assert.equal(repliesOpen(plain, office.chat), false);
  });

  off();
  unloadOfficeState(OFFICE_ID);
  console.log(`\nКнопки быстрого ответа: ${passed} проверок прошло`);
}

main();

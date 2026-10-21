/**
 * Кнопки быстрого ответа в чате с менеджером (T-599): варианты нормализуются
 * одной функцией (2–4, до 40 символов, без пустых и повторов), `offer_replies`
 * копит их на сессии чата, а конец хода прикрепляет к последней реплике хода —
 * той, что ложится в чат по `result`. Реплика с вариантами уходит на веб
 * событием `chat`, сохраняется в состоянии и переживает перезапуск; кнопки
 * гаснут, как только владелец ответил в этом чате. Ход из нескольких
 * текстовых блоков с кнопками даёт реплику со всем текстом хода (T-643), и
 * без кнопок тоже; рассуждения в реплику не идут, итог Codex не дублируется (T-664).
 *
 * Запуск: npm run test:replies
 */
import assert from 'node:assert/strict';
import type { ChatEntry, ServerEvent } from '../src/shared/types';
import { REPLY_LEN, repliesOpen, tidyReplies } from '../src/shared/types';
import { notePmText, offerReplies, settlePmReply as settleOrNull, turnHasText, turnReply } from '../src/server/replies';
import type { SDKMessage } from '../src/server/engines/types';
import { getOffice, unloadOfficeState } from '../src/server/state';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const OFFICE_ID = 'o-replies';

/** Готовое сообщение SDK с текстовыми блоками менеджера (и, по желанию, вызовом инструмента). */
function assistant(texts: string[], opts: { tool?: string; parent?: string } = {}): SDKMessage {
  const content: unknown[] = texts.map((text) => ({ type: 'text', text }));
  if (opts.tool) content.push({ type: 'tool_use', id: `tu-${opts.tool}`, name: opts.tool, input: {} });
  return {
    type: 'assistant',
    parent_tool_use_id: opts.parent ?? null,
    session_id: 's-replies',
    uuid: `u-${Math.random()}`,
    message: { role: 'assistant', content },
  } as unknown as SDKMessage;
}

/** Реплика хода, которая обязана лечь в чат. */
function settlePmReply(...args: Parameters<typeof settleOrNull>): ChatEntry {
  const entry = settleOrNull(...args);
  assert.ok(entry, 'реплика легла в чат');
  return entry;
}

/** Готовое сообщение SDK с блоком рассуждений. */
function thinking(text: string): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 's-replies',
    uuid: `u-${Math.random()}`,
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: text, signature: 'sig' }] },
  } as unknown as SDKMessage;
}

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

  console.log('ход из нескольких текстовых блоков (T-643)');
  check('реплика с кнопками несёт весь текст хода, кнопки под ней', () => {
    const intro = 'Уведомления из модуля партий можно собрать так:\n1. Вас добавили в партию.\n2. Выставлены результаты игры.\n3. Партия перенесена.\n4. Партия отменена.\n5. Напоминание за час.\n6. Новый участник.';
    const plan = 'Варианты: «1–2» — только два главных события, push; «1–4» — плюс перенос и отмена; «всё 1–6» — все события и список в приложении.';
    const tail = 'Какой состав берём?';
    notePmText(pm, assistant([intro], { tool: 'mcp__team__list_tasks' }));
    notePmText(pm, assistant([plan], { tool: 'mcp__team__offer_replies' }));
    offerReplies(pm, ['1–2, только push', '1–4, только push', 'Всё 1–6 + список', 'Обсудим подробнее']);
    // Речь подагента в реплику менеджера не попадает.
    notePmText(pm, assistant(['служебный текст подагента'], { parent: 'tu-x' }));
    // Итог хода SDK присылает и сообщением, и в result — дубля быть не должно.
    notePmText(pm, assistant([tail]));
    const reply = settlePmReply(office, pm, tail);
    assert.equal(reply.text, `${intro}\n\n${plan}\n\n${tail}`);
    assert.deepEqual(reply.replies, ['1–2, только push', '1–4, только push', 'Всё 1–6 + список', 'Обсудим подробнее']);
    assert.equal(office.chat[office.chat.length - 1].id, reply.id, 'реплика с кнопками — последняя в чате');
    assert.equal(office.chat.filter((e) => e.chatId === chat.id && e.text.includes(intro)).length, 1, 'текст хода в чате один раз');
    assert.deepEqual(pm.turnText, [], 'текст хода после хода забыт');
    assert.equal(pm.replies, null);
  });
  check('итог хода, не пришедший отдельным сообщением, дописывается в конец', () => {
    notePmText(pm, assistant(['Есть два пути: А — быстро, Б — надёжно.'], { tool: 'mcp__team__offer_replies' }));
    offerReplies(pm, ['А', 'Б']);
    const reply = settlePmReply(office, pm, 'Что выбираем?');
    assert.equal(reply.text, 'Есть два пути: А — быстро, Б — надёжно.\n\nЧто выбираем?');
  });
  check('реплика без кнопок тоже несёт весь текст хода (T-664)', () => {
    notePmText(pm, assistant(['Предлагаю разбить фичу на три задачи: сервер, веб, тест.'], { tool: 'mcp__team__create_task' }));
    notePmText(pm, assistant(['Завёл T-5.']));
    const reply = settlePmReply(office, pm, 'Завёл T-5.');
    assert.equal(reply.text, 'Предлагаю разбить фичу на три задачи: сервер, веб, тест.\n\nЗавёл T-5.');
    assert.equal(reply.replies, undefined);
    assert.deepEqual(pm.turnText, []);
  });
  check('сжатие памяти и передача дел в текст хода не попадают', () => {
    pm.rotating = true;
    notePmText(pm, assistant(['Передача дел: …']));
    pm.rotating = false;
    assert.deepEqual(pm.turnText, []);
  });

  console.log('текст до вызова инструмента (T-664)');
  check('ход «текст → offer_replies → текст»: оба текста по порядку, кнопки под ними', () => {
    const before = office.chat.length;
    // Claude шлёт каждый блок отдельным сообщением: текст, затем вызов, затем хвост.
    notePmText(pm, assistant(['Ссылки на файлы в чате нигде не описаны. Могу поставить ресёрч: исполнитель посмотрит docs и код веба.']));
    assert.equal(turnHasText(pm), true, 'текст до вызова уже учтён');
    notePmText(pm, assistant([], { tool: 'mcp__team__offer_replies' }));
    offerReplies(pm, ['Да, поставь ресёрч', 'Не надо']);
    notePmText(pm, assistant(['Как поступим?']));
    const reply = settlePmReply(office, pm, 'Как поступим?');
    assert.equal(reply.text,
      'Ссылки на файлы в чате нигде не описаны. Могу поставить ресёрч: исполнитель посмотрит docs и код веба.\n\nКак поступим?');
    assert.ok(reply.text.indexOf('Ссылки') < reply.text.indexOf('Как поступим?'), 'порядок блоков сохранён');
    assert.deepEqual(reply.replies, ['Да, поставь ресёрч', 'Не надо']);
    assert.equal(office.chat.length, before + 1, 'одна реплика, без дублей');
    assert.equal(office.chat[office.chat.length - 1].id, reply.id, 'кнопки — под последней репликой хода');
    assert.equal(repliesOpen(reply, office.chat), true);
  });
  check('рассуждения в реплику не идут, а их отсутствие в тексте видно инструменту', () => {
    notePmText(pm, thinking('Я проверил библиотеку — про ссылки ничего нет. Могу поставить ресёрч.'));
    assert.equal(turnHasText(pm), false, 'ответ в рассуждениях текстом хода не считается');
    offerReplies(pm, ['Да', 'Нет']);
    notePmText(pm, assistant(['Про ссылки ничего не записано. Поставить ресёрч?']));
    const reply = settlePmReply(office, pm, 'Про ссылки ничего не записано. Поставить ресёрч?');
    assert.equal(reply.text, 'Про ссылки ничего не записано. Поставить ресёрч?');
  });
  check('итог Codex — все блоки через перевод строки — второй раз не дописывается', () => {
    notePmText(pm, assistant(['Вариант А — быстро.'], { tool: 'offer_replies' }));
    offerReplies(pm, ['А', 'Б']);
    notePmText(pm, assistant(['Что берём?']));
    const reply = settlePmReply(office, pm, 'Вариант А — быстро.\nЧто берём?');
    assert.equal(reply.text, 'Вариант А — быстро.\n\nЧто берём?');
  });
  check('пустой итог при сказанном раньше: реплика из текста хода, кнопки на месте', () => {
    notePmText(pm, assistant(['Готово к запуску, запускать?'], { tool: 'offer_replies' }));
    offerReplies(pm, ['Да', 'Нет']);
    const reply = settlePmReply(office, pm, '');
    assert.equal(reply.text, 'Готово к запуску, запускать?');
    assert.deepEqual(reply.replies, ['Да', 'Нет']);
  });
  check('ни текста, ни итога — реплики нет', () => {
    assert.equal(settleOrNull(office, pm, '  '), null);
  });
  check('сборка реплики: итог шире пришедших блоков — берётся итог', () => {
    assert.equal(turnReply(['Второй.'], 'Первый.\nВторой.'), 'Первый.\nВторой.');
    assert.equal(turnReply([], 'Только итог'), 'Только итог');
    assert.equal(turnReply(['Раз.', 'Два.'], 'Три.'), 'Раз.\n\nДва.\n\nТри.');
  });

  off();
  unloadOfficeState(OFFICE_ID);
  console.log(`\nКнопки быстрого ответа: ${passed} проверок прошло`);
}

main();

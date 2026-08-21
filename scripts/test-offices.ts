/**
 * Проверки API офисов: список, создание с валидацией пути, переключение,
 * скрытие из списка и то, что события одного офиса не текут в клиента,
 * который смотрит другой.
 *
 * Проверка идёт против office-api.ts — того же кода, который вызывает сокет, —
 * но с подставным клиентом (`Sink`) вместо WebSocket: сеть здесь ничего не
 * доказывает, а без неё проверка запускается где угодно и за секунду.
 * Токенов не тратит: ни одна команда не будит агентов.
 *
 * Запуск: npm run test:offices
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ServerEvent } from '../src/shared/types';
import { office, officeViews, openOfficeState, subscribeOffices } from '../src/server/state';
import {
  broadcast, handleOfficeCommand, initOfficeApi, sendSnapshot, unwatch, watch, watching,
  type Sink,
} from '../src/server/office-api';
import { currentOffice, loadRegistry, offices } from '../src/server/offices';

const ROOT = resolve(tmpdir(), `office-api-test-${process.pid}`);
const STATE_FILE = resolve(ROOT, 'state.json');
const REGISTRY = resolve(ROOT, 'offices.json');
const DIR_A = resolve(ROOT, 'proj-a');
const DIR_B = resolve(ROOT, 'proj-b');
const DIR_C = resolve(ROOT, 'proj-c');

const results: string[] = [];
const check = (text: string, ok: boolean): void => { results.push(`${text}: ${ok}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Подставной клиент: тот же интерфейс, что у сокета, только без сети. */
class Fake implements Sink {
  readyState = 1;
  events: ServerEvent[] = [];

  send(payload: string): void {
    this.events.push(JSON.parse(payload) as ServerEvent);
  }

  /** Последнее событие такого типа после отметки. */
  last<T extends ServerEvent['t']>(t: T, from = 0): Extract<ServerEvent, { t: T }> | null {
    const found = [...this.events.slice(from)].reverse().find((e) => e.t === t);
    return (found as Extract<ServerEvent, { t: T }>) ?? null;
  }

  count(t: ServerEvent['t'], from = 0): number {
    return this.events.slice(from).filter((e) => e.t === t).length;
  }
}

/** Читать реестр с диска: это и есть то, что переживает перезапуск. */
function onDisk(): { currentId: string; offices: Array<{ id: string; name: string; projectDir: string; stateFile: string; hidden?: boolean }> } {
  return JSON.parse(readFileSync(REGISTRY, 'utf8'));
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  for (const dir of [DIR_A, DIR_B, DIR_C]) mkdirSync(dir, { recursive: true });

  // 1. Холодный старт с уже лежащего на диске реестра — ровно то, что делает
  //    сервер после перезапуска. Второй офис здесь скрыт: он не должен попасть
  //    в список, но обязан остаться в файле вместе со своим состоянием.
  writeFileSync(REGISTRY, JSON.stringify({
    version: 1,
    currentId: 'o-1',
    seq: 2,
    offices: [
      { id: 'o-1', name: 'Первый', projectDir: DIR_A, stateFile: STATE_FILE, createdAt: 1, lastOpenedAt: 111 },
      {
        id: 'o-2', name: 'Убранный', projectDir: DIR_C, hidden: true,
        stateFile: resolve(ROOT, 'offices', 'o-2.json'), createdAt: 2, lastOpenedAt: 222,
      },
    ],
  }), 'utf8');

  loadRegistry(DIR_A, STATE_FILE);
  check('реестр поднялся с диска: офисы пережили перезапуск', offices().length === 1);
  check('скрытый офис в списке не показывается',
    offices().every((o) => o.projectDir !== DIR_C));
  check('текущий офис определён', currentOffice()?.id === 'o-1');

  const first = currentOffice()!;
  openOfficeState(first);
  office.projectDir = DIR_A;

  // Открытие офиса без git и рабочей директории: сервер делает это же плюс
  // проверку репозитория, к списку офисов она отношения не имеет.
  initOfficeApi({
    openOffice: async (entry) => {
      openOfficeState(entry);
      await sleep(0);
    },
  });
  subscribeOffices((e: ServerEvent) => broadcast(e));

  // 2. Список офисов: id, название, путь, время открытия, число задач в работе.
  const view = officeViews();
  check('в списке есть id, название и путь',
    view.length === 1 && view[0].id === 'o-1' && view[0].name === 'Первый'
    && view[0].projectDir === DIR_A);
  check('в списке есть время последней активности',
    view[0].lastOpenedAt === 111 && typeof view[0].activity?.lastEventAt !== 'undefined');
  office.createTask({ title: 'в работе', description: '', criteria: [], roleId: 'backend' });
  const inWork = [...office.tasks.values()][0];
  office.updateTask(inWork.id, { status: 'in_progress' });
  check('в списке видно число активных задач', officeViews()[0].activity?.inProgress === 1);
  office.updateTask(inWork.id, { status: 'done' });

  // 3. Клиенты: A остаётся в первом офисе, B уходит во второй.
  const a = new Fake();
  const b = new Fake();
  watch(a);
  watch(b);
  sendSnapshot(a);
  check('подписка привязана к открытому офису', watching(a) === 'o-1');
  check('снапшот содержит список офисов', (a.last('snapshot')?.offices.length ?? 0) === 1);

  // 4. Создание: несуществующая директория — отказ по-русски, офиса нет.
  let mark = b.events.length;
  handleOfficeCommand(
    { c: 'create_office', name: 'Мимо', projectDir: resolve(ROOT, 'нет-такой-папки') }, b,
  );
  await sleep(20);
  const missing = b.last('office.error', mark);
  check('несуществующая директория отклонена', missing?.op === 'create');
  check('текст отказа по-русски и называет путь',
    Boolean(missing && /не найдена/i.test(missing.message)
      && missing.message.includes('нет-такой-папки')));
  check('офис из неудачного создания в списке не появился', officeViews().length === 1);

  // 5. Путь ведёт на файл, а не на директорию.
  mark = b.events.length;
  handleOfficeCommand({ c: 'create_office', name: 'Файл', projectDir: REGISTRY }, b);
  await sleep(20);
  check('файл вместо директории отклонён',
    Boolean(b.last('office.error', mark)?.message.includes('это файл, а не директория')));

  // 6. Пустой путь.
  mark = b.events.length;
  handleOfficeCommand({ c: 'create_office', name: 'Без пути', projectDir: '  ' }, b);
  await sleep(20);
  check('пустой путь отклонён',
    Boolean(b.last('office.error', mark)?.message.includes('Укажите путь')));

  // 7. Настоящее создание: офис заводится и сразу открывается у просившего.
  mark = b.events.length;
  const markA = a.events.length;
  handleOfficeCommand({ c: 'create_office', name: 'Второй проект', projectDir: DIR_B }, b);
  await sleep(50);
  const snapB = b.last('snapshot', mark);
  check('после создания приходит снапшот нового офиса', snapB?.projectDir === DIR_B);
  const madeId = snapB?.offices.find((o) => o.projectDir === DIR_B)?.id ?? '';
  check('новый офис в списке помечен текущим',
    snapB?.offices.find((o) => o.id === madeId)?.current === true);
  check('подписка просившего переехала в новый офис', watching(b) === madeId);
  check('клиент другого офиса остался на своём', watching(a) === 'o-1');
  check('список офисов дошёл и до клиента другого офиса',
    (a.last('offices', markA)?.offices.length ?? 0) === 2);
  check('чужой снапшот клиенту не пришёл', a.count('snapshot', markA) === 0);

  // 8. Изоляция потока событий: событие второго офиса не уходит в первый.
  const aBefore = a.events.length;
  const bBefore = b.events.length;
  office.addChat('офис', 'реплика во втором офисе');
  office.addLog(null, 'system', 'запись во втором офисе');
  await sleep(20);
  check('события открытого офиса доходят до его клиента',
    b.count('chat', bBefore) === 1 && b.count('log', bBefore) === 1);
  check('в чужой офис события не текут',
    a.count('chat', aBefore) === 0 && a.count('log', aBefore) === 0);

  // 9. Отдельный запрос списка — меню открывается раньше офиса.
  mark = a.events.length;
  handleOfficeCommand({ c: 'list_offices' }, a);
  check('list_offices отдаёт список', (a.last('offices', mark)?.offices.length ?? 0) === 2);

  // 10. Переименование.
  mark = b.events.length;
  handleOfficeCommand({ c: 'rename_office', officeId: madeId, name: 'Переименованный' }, b);
  check('переименование меняет список',
    b.last('offices', mark)?.offices.find((o) => o.id === madeId)?.name === 'Переименованный');
  mark = b.events.length;
  handleOfficeCommand({ c: 'rename_office', officeId: madeId, name: '   ' }, b);
  check('пустое название отклонено', b.last('office.error', mark)?.op === 'rename');

  // 11. Открытый офис из списка не убрать — сначала перейти в другой.
  mark = b.events.length;
  handleOfficeCommand({ c: 'remove_office', officeId: madeId }, b);
  check('открытый офис из списка не убрать',
    Boolean(b.last('office.error', mark)?.message.includes('сейчас открыт')));

  // 12. Переключение назад: снапшот меняется, поток событий — тоже.
  mark = b.events.length;
  handleOfficeCommand({ c: 'switch_office', officeId: 'o-1' }, b);
  await sleep(50);
  check('переключение меняет снапшот', b.last('snapshot', mark)?.projectDir === DIR_A);
  check('доска прежнего офиса восстановилась из памяти',
    Boolean(b.last('snapshot', mark)?.tasks.some((t) => t.id === inWork.id)));
  check('оба клиента снова смотрят один офис',
    watching(a) === 'o-1' && watching(b) === 'o-1');

  // 13. Скрытие: офис уходит из списка, файлы остаются.
  mark = b.events.length;
  handleOfficeCommand({ c: 'remove_office', officeId: madeId }, b);
  const afterRemove = b.last('offices', mark);
  check('скрытый офис пропал из списка',
    afterRemove?.offices.length === 1 && afterRemove.offices[0].id === 'o-1');
  const hidden = onDisk().offices.find((o) => o.id === madeId);
  check('запись скрытого офиса осталась в реестре вместе с файлом состояния',
    hidden?.hidden === true && Boolean(hidden.stateFile));
  check('директория проекта и сохранение доски на диске целы',
    existsSync(DIR_B) && existsSync(hidden!.stateFile));

  // 14. Войти в скрытый офис по устаревшему id нельзя.
  mark = b.events.length;
  handleOfficeCommand({ c: 'switch_office', officeId: madeId }, b);
  await sleep(20);
  check('переключение в скрытый офис отклонено',
    Boolean(b.last('office.error', mark)?.message.includes('не найден')));

  // 15. Единственный оставшийся офис он же открытый — убрать нельзя,
  //     иначе список опустел бы, а вернуть офис было бы неоткуда.
  mark = b.events.length;
  handleOfficeCommand({ c: 'remove_office', officeId: 'o-1' }, b);
  check('последний офис из списка не убрать', b.last('office.error', mark)?.op === 'remove');
  check('список после отказа не изменился', officeViews().length === 1);

  // 16. Тот же путь заводят снова — офис возвращается со своим id и доской,
  //     а не появляется пустой дубль рядом.
  mark = b.events.length;
  handleOfficeCommand({ c: 'create_office', name: 'Второй снова', projectDir: DIR_B }, b);
  await sleep(50);
  check('скрытый офис возвращается со своим id',
    b.last('snapshot', mark)?.offices.find((o) => o.projectDir === DIR_B)?.id === madeId);

  // 17. Занятый офис не бросаем на полдороге.
  const busy = office.createTask({
    title: 'идёт работа', description: '', criteria: [], roleId: 'backend',
  });
  office.updateTask(busy.id, { status: 'in_progress' });
  mark = b.events.length;
  handleOfficeCommand({ c: 'switch_office', officeId: 'o-1' }, b);
  await sleep(20);
  const blocked = b.last('office.error', mark);
  check('переключение при задаче в работе отклонено', blocked?.op === 'switch');
  check('отказ называет задачу', Boolean(blocked?.message.includes(busy.id)));
  check('офис не переключился', office.projectDir === DIR_B);
  office.updateTask(busy.id, { status: 'done' });

  // 18. Отключившийся клиент из рассылки уходит.
  const closed = new Fake();
  watch(closed);
  unwatch(closed);
  office.addChat('офис', 'после отключения');
  await sleep(20);
  check('отключённый клиент событий не получает', closed.count('chat') === 0);

  // 19. Всё сделанное записано на диск: следующий запуск увидит то же самое.
  const saved = onDisk();
  check('реестр на диске знает все три офиса, включая скрытый',
    saved.offices.length === 3 && saved.offices.filter((o) => o.hidden).length === 1);
  check('текущий офис записан', saved.currentId === madeId);
  check('возвращённый офис на диске уже не скрыт',
    saved.offices.find((o) => o.id === madeId)?.hidden === false);

  office.flush();
  rmSync(ROOT, { recursive: true, force: true });

  const failed = results.filter((r) => r.endsWith('false'));
  for (const r of results) console.log(`  ${r.endsWith('false') ? '❌' : '✅'} ${r}`);
  console.log(failed.length ? `ПРОВАЛЕНО: ${failed.length}` : 'Все проверки прошли');
  process.exit(failed.length ? 1 : 0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Проверки API офисов: список, создание с валидацией пути, переключение,
 * скрытие из списка, пауза, архив, постоянный порядок списка и то, что
 * события одного офиса не текут в клиента, который смотрит другой.
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
import {
  getOffice, isOpened, officeViews, openedOffices, openOfficeState, subscribeOffices,
  unloadOfficeState,
} from '../src/server/state';
import { officeAssign, setPaused } from '../src/server/agents';
import { MessageQueue } from '../src/server/queue';
import { dispatch } from '../src/server/plan';
import { dueRitual, runRitual, standupDue } from '../src/server/rituals';
import { isSupervised, startSupervisor } from '../src/server/supervisor';
import {
  broadcast, greet, handleOfficeCommand, initOfficeApi, sendSnapshot, stateFor, unwatch, watch,
  watching, type Sink,
} from '../src/server/office-api';
import { createOffice, currentOffice, loadRegistry, offices } from '../src/server/offices';

// Проверки сверяют тексты офиса дословно и написаны по-русски — значит,
// и офисы здесь должны быть русскими. Язык нового офиса берётся из
// окружения, и задать его надо до того, как офис откроется.
process.env.OFFICE_LANG = 'ru';

const ROOT = resolve(tmpdir(), `office-api-test-${process.pid}`);
const STATE_FILE = resolve(ROOT, 'state.json');
const REGISTRY = resolve(ROOT, 'offices.json');
const DIR_A = resolve(ROOT, 'proj-a');
const DIR_B = resolve(ROOT, 'proj-b');
const DIR_C = resolve(ROOT, 'proj-c');
const DIR_D = resolve(ROOT, 'proj-d');

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
function onDisk(): {
  currentId: string;
  offices: Array<{
    id: string; name: string; projectDir: string; stateFile: string;
    createdAt?: number; hidden?: boolean; paused?: boolean; archived?: boolean;
  }>;
} {
  return JSON.parse(readFileSync(REGISTRY, 'utf8'));
}

/** Порядок видимых офисов — тот самый, который человек видит в рейле. */
const order = (): string => officeViews().map((o) => o.id).join(',');

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  for (const dir of [DIR_A, DIR_B, DIR_C, DIR_D]) mkdirSync(dir, { recursive: true });

  // 1. Холодный старт с уже лежащего на диске реестра — ровно то, что делает
  //    сервер после перезапуска. Второй офис здесь скрыт: он не должен попасть
  //    в список, но обязан остаться в файле вместе со своим состоянием.
  //    Времени создания у записей нет намеренно: так выглядит реестр, заведённый
  //    до того, как порядок списка стали считать по нему, — и миграция обязана
  //    проставить его, никого не переставив.
  writeFileSync(REGISTRY, JSON.stringify({
    version: 1,
    currentId: 'o-1',
    seq: 2,
    offices: [
      { id: 'o-1', name: 'Первый', projectDir: DIR_A, stateFile: STATE_FILE, lastOpenedAt: 111 },
      {
        id: 'o-2', name: 'Убранный', projectDir: DIR_C, hidden: true,
        stateFile: resolve(ROOT, 'offices', 'o-2.json'), lastOpenedAt: 222,
      },
    ],
  }), 'utf8');

  loadRegistry(DIR_A, STATE_FILE);
  const migrated = onDisk().offices;
  check('записям без времени создания его проставила миграция',
    migrated.every((o) => typeof o.createdAt === 'number' && Number.isFinite(o.createdAt)));
  check('миграция никого не переставила: порядок остался тот же, что в файле',
    migrated.map((o) => o.id).join(',') === 'o-1,o-2'
    && migrated[0].createdAt! < migrated[1].createdAt!);
  check('реестр поднялся с диска: офисы пережили перезапуск', offices().length === 1);
  check('скрытый офис в списке не показывается',
    offices().every((o) => o.projectDir !== DIR_C));
  check('текущий офис определён', currentOffice()?.id === 'o-1');

  const first = currentOffice()!;
  openOfficeState(first);
  // Дальше офисы держим за явные ссылки, а не через `office`: офисов в памяти
  // несколько, и «текущий на процесс» больше не отвечает на вопрос, в чей
  // именно офис ушло событие.
  const stateA = getOffice('o-1');
  stateA.projectDir = DIR_A;

  // Открытие офиса без git и рабочей директории: сервер делает это же плюс
  // проверку репозитория, к списку офисов она отношения не имеет.
  // Заходы считаем: повторный вход в уже поднятый офис не должен поднимать
  // его второй раз — это были бы вторые сессии и второй надзор.
  let opens = 0;
  let openDelayMs = 0;
  initOfficeApi({
    openOffice: async (entry) => {
      opens += 1;
      await sleep(openDelayMs);
      openOfficeState(entry);
    },
  });
  // Подписчик один на все офисы: покинутый офис продолжает слать события,
  // и разбирает их по адресатам метка officeId, а не «кто сейчас открыт».
  subscribeOffices((e: ServerEvent, officeId: string) => broadcast(e, officeId));

  // 2. Список офисов: id, название, путь, время открытия, число задач в работе.
  const view = officeViews();
  check('в списке есть id, название и путь',
    view.length === 1 && view[0].id === 'o-1' && view[0].name === 'Первый'
    && view[0].projectDir === DIR_A);
  check('в списке есть время последней активности',
    view[0].lastOpenedAt === 111 && typeof view[0].activity?.lastEventAt !== 'undefined');
  // Время создания уезжает в веб: по нему рейл, модалка и главный экран
  // строят один и тот же порядок, не выдумывая свой.
  check('в списке есть время создания офиса', view[0].createdAt > 0);
  stateA.createTask({ title: 'в работе', description: '', criteria: [], roleId: 'backend' });
  const inWork = [...stateA.tasks.values()][0];
  stateA.updateTask(inWork.id, { status: 'in_progress' });
  check('в списке видно число активных задач', officeViews()[0].activity?.inProgress === 1);
  check('без живых сессий офис в списке не помечен работающим',
    officeViews()[0].activity?.live === false);
  stateA.updateTask(inWork.id, { status: 'done' });

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
  const stateB = getOffice(madeId);
  check('оба офиса подняты в памяти одновременно',
    stateA.opened && stateB.opened && stateA !== stateB);
  check('команда каждого клиента идёт в его собственный офис',
    stateFor(a) === stateA && stateFor(b) === stateB);

  // 8. Изоляция потока событий: событие второго офиса не уходит в первый.
  const aBefore = a.events.length;
  const bBefore = b.events.length;
  stateB.addChat('офис', 'реплика во втором офисе');
  stateB.addLog(null, 'system', 'запись во втором офисе');
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

  // 13. Скрытие: офис уходит из списка и гаснет целиком — надзор, сессии,
  //     место в памяти. Файлы на диске при этом остаются: скрытие ≠ удаление.
  //     Заводим заранее всё, что обязано погаснуть.
  const removedState = getOffice(madeId);
  const goneQueue = new MessageQueue();
  removedState.pmQueue = goneQueue;
  removedState.pmLoop = Promise.resolve();
  const goneAbort = new AbortController();
  [...removedState.instances.values()][0].abort = goneAbort;
  startSupervisor(removedState);
  check('перед скрытием офис под надзором', isSupervised(madeId));

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

  // Надзор скрытого офиса остановлен: иначе он продолжал бы раз в минуту
  // толкать конвейер офиса, которого человек больше не видит.
  check('надзиратель скрытого офиса остановлен', !isSupervised(madeId));
  // Сессии закрыты: очередь менеджера кончилась, а не ждёт нового сообщения,
  // и исполнителю послан сигнал прерывания.
  const drained = await Promise.race([
    goneQueue[Symbol.asyncIterator]().next(),
    sleep(20).then(() => null),
  ]);
  check('очередь менеджера скрытого офиса закрыта', drained?.done === true);
  check('сессии скрытого офиса погашены',
    removedState.pmQueue === null && removedState.pmLoop === null && goneAbort.signal.aborted);
  // Состояние выгружено из памяти — ради этого всё и затевалось.
  check('состояние скрытого офиса выгружено из памяти',
    !isOpened(madeId) && !openedOffices().includes(removedState));
  // И дописано на диск: то, что не успело доехать до отложенной записи,
  // обязано лежать в файле — иначе выгрузка означала бы потерю работы.
  const savedHidden = JSON.parse(readFileSync(hidden!.stateFile, 'utf8'));
  check('состояние скрытого офиса дописано на диск при выгрузке',
    savedHidden.projectDir === DIR_B
    && savedHidden.chat.some((c: { text: string }) => c.text === 'реплика во втором офисе'));

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
  // Выгруженный офис поднимается заново — из своего файла состояния. Доска и
  // разговоры при этом на месте: скрытие ничего не стёрло.
  check('вернувшийся офис поднял свою доску с диска, а не начал с нуля',
    Boolean(b.last('snapshot', mark)?.chat.some((c) => c.text === 'реплика во втором офисе')));
  const backState = getOffice(madeId);
  check('вернувшийся офис поднят заново, а не оживил выгруженное состояние',
    backState !== removedState && backState.opened);

  // 17. Уйти можно всегда, в том числе из офиса с задачами в работе: сессии
  //     покинутого офиса не трогаем, они продолжают писать в своё состояние.
  const busy = backState.createTask({
    title: 'идёт работа', description: '', criteria: [], roleId: 'backend',
  });
  backState.updateTask(busy.id, { status: 'in_progress' });
  const leaving = backState;
  // Живая сессия менеджера и прерыватель исполнителя: по ним и видно,
  // сбросили сессии при переключении или оставили работать.
  const pmQueue = new MessageQueue();
  leaving.pmQueue = pmQueue;
  leaving.pmLoop = Promise.resolve();
  const abort = new AbortController();
  const worker = [...leaving.instances.values()][0];
  worker.abort = abort;

  mark = b.events.length;
  handleOfficeCommand({ c: 'switch_office', officeId: 'o-1' }, b);
  await sleep(50);
  check('переключение при задаче в работе не отклоняется',
    b.last('office.error', mark) === null);
  check('переключение при задаче в работе доводится до снапшота',
    b.last('snapshot', mark)?.projectDir === DIR_A);
  check('клиент переехал в запрошенный офис',
    watching(b) === 'o-1' && stateFor(b) === stateA);
  check('открытым в реестре записан запрошенный офис', currentOffice()?.id === 'o-1');
  check('сессии покинутого офиса не сброшены',
    leaving.pmQueue === pmQueue && !abort.signal.aborted);
  check('задача покинутого офиса осталась в работе',
    leaving.tasks.get(busy.id)?.status === 'in_progress');
  check('состояние покинутого офиса живёт в памяти', getOffice(madeId) === leaving);
  check('работающий офис помечен в списке как активный',
    officeViews().find((o) => o.id === madeId)?.activity?.live === true);
  check('в сводке покинутого офиса видно задачу в работе',
    officeViews().find((o) => o.id === madeId)?.activity?.inProgress === 1);

  // События покинутого офиса продолжают идти, но только его зрителям:
  // клиент b смотрит уже другой проект и чужой чат видеть не должен.
  const afterSwitch = b.events.length;
  leaving.addChat('офис', 'работа продолжается в покинутом офисе');
  await sleep(20);
  check('события покинутого офиса не текут в открытый', b.count('chat', afterSwitch) === 0);

  // 18. Пока в покинутом офисе идёт работа, убрать его из списка нельзя:
  //     иначе задачи тратили бы деньги там, где человек их больше не видит.
  mark = b.events.length;
  handleOfficeCommand({ c: 'remove_office', officeId: madeId }, b);
  const working = b.last('office.error', mark);
  check('работающий офис из списка не убрать', working?.op === 'remove');
  check('отказ называет идущую задачу', Boolean(working?.message.includes(busy.id)));
  check('офис остался в списке', officeViews().some((o) => o.id === madeId));

  // 19. Работа в покинутом офисе идёт дальше и доезжает до его файла: клиент
  //     вернётся и должен увидеть всё, что случилось без него.
  const away = leaving.createTask({
    title: 'сделано без зрителей', description: '', criteria: [], roleId: 'backend',
  });
  leaving.updateTask(away.id, { status: 'done', finishedAt: Date.now(), branch: 'task/away' });
  leaving.addChat('офис', 'отчёт пришёл, пока никто не смотрел');
  // Дебаунс записи — 400 мс: ждём его, а не зовём flush, иначе проверка
  // доказывала бы, что работает flush, а не то, что офис сохраняется сам.
  await sleep(700);
  const savedAway = JSON.parse(readFileSync(onDisk().offices.find((o) => o.id === madeId)!.stateFile, 'utf8'));
  check('покинутый офис сам сохранил работу в свой файл',
    savedAway.tasks.some((t: { id: string; status: string }) => t.id === away.id && t.status === 'done'));
  check('в файл покинутого офиса попал и его чат',
    savedAway.chat.some((c: { text: string }) => c.text === 'отчёт пришёл, пока никто не смотрел'));

  const beforeBack = b.events.length;
  const opensBeforeBack = opens;
  handleOfficeCommand({ c: 'switch_office', officeId: madeId }, b);
  await sleep(50);
  const back = b.last('snapshot', beforeBack);
  check('при возврате снапшот содержит сделанное без зрителей',
    Boolean(back?.tasks.some((t) => t.id === away.id && t.status === 'done')));
  check('при возврате в снапшоте есть и разговоры без зрителей',
    Boolean(back?.chat.some((c) => c.text === 'отчёт пришёл, пока никто не смотрел')));
  check('возврат в поднятый офис его заново не поднимает', opens === opensBeforeBack);

  // 20. Два клиента в разных офисах одновременно: у каждого свой поток.
  handleOfficeCommand({ c: 'switch_office', officeId: 'o-1' }, a);
  await sleep(20);
  check('клиенты смотрят разные офисы', watching(a) === 'o-1' && watching(b) === madeId);
  const aSplit = a.events.length;
  const bSplit = b.events.length;
  stateA.addChat('офис', 'это первому');
  leaving.addChat('офис', 'это второму');
  await sleep(20);
  check('каждый клиент получил только своё',
    a.count('chat', aSplit) === 1 && b.count('chat', bSplit) === 1);
  check('первому пришла именно его реплика',
    a.last('chat', aSplit)?.entry.text === 'это первому');
  check('второму пришла именно его реплика',
    b.last('chat', bSplit)?.entry.text === 'это второму');

  // Сводка в списке офисов обновляется от работы ЛЮБОГО офиса, включая тот,
  // который этот клиент не смотрит: иначе индикатор замирал бы ровно тогда,
  // когда он и нужен — пока человек занят соседним проектом.
  const aBoard = a.events.length;
  const far = leaving.createTask({
    title: 'заведена в соседнем офисе', description: '', criteria: [], roleId: 'backend',
  });
  leaving.updateTask(far.id, { status: 'in_progress' });
  await sleep(1300);
  const list = a.last('offices', aBoard);
  check('список офисов дошёл до клиента чужого офиса', list !== null);
  check('в сводке видно задачи, начатые в соседнем офисе',
    (list?.offices.find((o) => o.id === madeId)?.activity?.inProgress ?? 0) >= 2);
  leaving.updateTask(far.id, { status: 'done' });

  // Запрос доступа в покинутом офисе останавливает там работу: пока человек
  // смотрит другой проект, в списке должно быть видно, что его ждут.
  const askBoard = a.events.length;
  const decision = leaving.requestPermission({
    agentId: 'backend#1', taskId: null, toolName: 'Bash', key: 'Bash:rm',
    summary: 'rm -rf build', detail: 'rm -rf build', risk: 'danger',
    reason: 'команда удаляет файлы',
  });
  await sleep(1300);
  check('в сводке видно, что покинутый офис ждёт решения',
    (a.last('offices', askBoard)?.offices.find((o) => o.id === madeId)?.activity?.waiting ?? 0) === 1);
  const pending = leaving.pendingRequests()[0];
  leaving.resolvePermission(pending.id, 'deny');
  await decision;
  check('после ответа офис снова никого не ждёт',
    officeViews().find((o) => o.id === madeId)?.activity?.waiting === 0);

  // 21. Два клиента входят в один ещё не поднятый офис одновременно: офис
  //     поднимается один раз, снапшот получают оба.
  const slow = createOffice({ name: 'Третий', projectDir: DIR_D, mustExist: true });
  const slowId = 'office' in slow ? slow.office.id : '';
  openDelayMs = 40;
  const opensBefore = opens;
  const aRace = a.events.length;
  const bRace = b.events.length;
  handleOfficeCommand({ c: 'switch_office', officeId: slowId }, a);
  handleOfficeCommand({ c: 'switch_office', officeId: slowId }, b);
  await sleep(120);
  openDelayMs = 0;
  check('одновременный вход поднимает офис один раз', opens - opensBefore === 1);
  check('снапшот получили оба вошедших',
    a.count('snapshot', aRace) === 1 && b.count('snapshot', bRace) === 1);
  check('оба клиента подписаны на новый офис',
    watching(a) === slowId && watching(b) === slowId);

  leaving.updateTask(busy.id, { status: 'done' });
  worker.abort = null;
  leaving.pmQueue = null;
  leaving.pmLoop = null;

  // 22. Порядок списка офисов зафиксирован раз и навсегда: по времени
  //     создания, самый старый сверху. Его не двигают ни выбор офиса, ни
  //     скрытие с возвратом, ни перезапуск сервера. Список к этому месту
  //     из трёх видимых офисов — есть и верх, и низ, и середина.
  const fixed = order();
  check('список идёт по времени создания офисов',
    fixed === ['o-1', madeId, slowId].join(','));
  const byName = [...officeViews()]
    .sort((x, y) => x.name.localeCompare(y.name, 'ru')).map((o) => o.id).join(',');
  // Без этой проверки следующие ничего не доказывали бы: совпади порядок по
  // имени с порядком по времени, сортировка по имени прошла бы незамеченной.
  check('порядок по времени и порядок по имени в этом прогоне разные', byName !== fixed);

  // Выбор офиса — и верхнего, и нижнего — только подсвечивает строку.
  handleOfficeCommand({ c: 'switch_office', officeId: 'o-1' }, b);
  await sleep(50);
  check('переключение на верхний офис порядок не меняет', order() === fixed);
  const bottomId = fixed.split(',').pop()!;
  mark = b.events.length;
  handleOfficeCommand({ c: 'switch_office', officeId: bottomId }, b);
  await sleep(50);
  check('переключение на нижний офис порядок не меняет', order() === fixed);
  check('текущий офис не всплыл наверх, а остался на своём месте',
    officeViews().findIndex((o) => o.current) === officeViews().length - 1);
  // Клиент видит ровно тот же порядок — и в рассылке списка, и в снапшоте:
  // именно из них веб строит рейл, модалку офисов и главный экран.
  check('в разосланном списке офисов порядок тот же',
    b.last('offices', mark)?.offices.map((o) => o.id).join(',') === fixed);
  check('в снапшоте после переключения порядок тот же',
    b.last('snapshot', mark)?.offices.map((o) => o.id).join(',') === fixed);

  // Скрытие и возврат: офис уходит из середины списка и встаёт обратно туда же,
  // а не в конец, — время создания скрытие не трогает. Возвращаем напрямую
  // реестром, а не командой: create_office заодно входит в офис, а здесь
  // проверяется порядок, а не переключение.
  mark = b.events.length;
  handleOfficeCommand({ c: 'remove_office', officeId: madeId }, b);
  check('скрытый офис ушёл из списка', order() === ['o-1', slowId].join(','));
  const back2 = createOffice({ name: 'Второй снова', projectDir: DIR_B, mustExist: true });
  check('офис вернулся со своим id', 'office' in back2 && back2.office.id === madeId);
  check('возвращённый офис встал на своё прежнее место, а не в конец',
    order() === fixed);

  // Перезапуск сервера: реестр читается с диска заново. Поднимаем модуль
  // офисов вторым экземпляром (у импорта с другим адресом своё состояние) —
  // для реестра это и есть холодный старт, только без поднятия всего сервера.
  const fresh = '../src/server/offices.ts?restart=1';
  const again = await import(fresh) as typeof import('../src/server/offices');
  again.loadRegistry(DIR_A, STATE_FILE);
  check('после перезапуска порядок тот же',
    again.offices().map((o) => o.id).join(',') === fixed);
  check('в файле реестра офисы лежат в том же порядке, в каком показываются',
    onDisk().offices.filter((o) => !o.hidden).map((o) => o.id).join(',') === fixed);

  // 23. Стартовый офис не открылся. Клиенту в этом случае обязана уйти
  //     причина по-русски, а не тишина: снапшота не будет никогда, и без
  //     ответа экран входа остаётся в загрузке до таймаута соединения.
  //     Проверяем ту же функцию, которой отвечает на подключение сервер.
  const cold = new Fake();
  watch(cold);
  await greet(cold, Promise.resolve(
    'Офис «Первый» не открылся: EACCES, permission denied. Проверьте директорию.',
  ));
  const boot = cold.last('office.error');
  check('при неудачном старте клиент получает отказ, а не тишину', boot?.op === 'open');
  check('текст отказа при старте по-русски и называет причину',
    Boolean(boot?.message.includes('не открылся') && boot.message.includes('Проверьте')));
  check('снапшот при неудачном старте не приходит', cold.count('snapshot') === 0);
  check('вместе с отказом уходит список офисов — меню есть что показать',
    (cold.last('offices')?.offices.length ?? 0) > 0);
  unwatch(cold);

  // Тот же путь при удачном старте — снапшот, как и раньше.
  const warm = new Fake();
  watch(warm);
  await greet(warm, Promise.resolve(null));
  check('при удачном старте клиент получает снапшот', warm.count('snapshot') === 1);
  check('при удачном старте отказа не приходит', warm.count('office.error') === 0);
  unwatch(warm);

  // 24. Отключившийся клиент из рассылки уходит: ни событий, ни подписки,
  //     ни офиса, к которому его команды могли бы отнести.
  const closed = new Fake();
  watch(closed);
  unwatch(closed);
  check('отключённый клиент офис больше не смотрит', watching(closed) === null);
  check('команда от неизвестного клиента ни к какому офису не относится',
    stateFor(closed) === null);
  stateA.addChat('офис', 'после отключения');
  await sleep(20);
  check('отключённый клиент событий не получает', closed.count('chat') === 0);

  // 25. Пауза офиса. Она не про живые сессии, а про сам офис: человек
  //     остановил работу, и перезапуск сервера не должен её возобновлять.
  //     Поэтому признак лежит в реестре рядом с именем и путём и пишется
  //     сразу, а не отложенной записью состояния.
  const pauseOffice = getOffice('o-1');
  setPaused(pauseOffice, true);
  check('пауза оказалась в реестре на диске сразу, без ожидания дебаунса',
    onDisk().offices.find((o) => o.id === 'o-1')?.paused === true);
  check('офис на паузе помечен в списке офисов',
    officeViews().find((o) => o.id === 'o-1')?.activity?.paused === true);

  // Задача, заведённая на паузе, остаётся в очереди: офис её не раздаёт.
  // officeAssign — то же место, куда ходит надзор (supervisor.watchBoard).
  const idle = pauseOffice.createTask({
    title: 'ждёт снятия паузы', description: '', criteria: [], roleId: 'backend',
  });
  check('офис на паузе задачу не берёт',
    !officeAssign(pauseOffice, idle.id).ok
    && pauseOffice.tasks.get(idle.id)?.status === 'backlog');

  // Выгрузка офиса из памяти: состояния больше нет, а метка осталась —
  // и список показывает паузу, не поднимая офис обратно.
  unloadOfficeState('o-1');
  check('выгруженный офис из памяти ушёл', !isOpened('o-1'));
  check('неподнятый офис в списке всё равно на паузе',
    officeViews().find((o) => o.id === 'o-1')?.activity?.paused === true);

  // Перезапуск сервера: запись берём с диска, а не из памяти, — сервер
  // поднимает офис ровно из неё.
  const fromDisk = onDisk().offices.find((o) => o.id === 'o-1')!;
  const restarted = openOfficeState(fromDisk).state;
  check('после перезапуска офис поднялся на паузе', restarted.paused === true);
  check('после перезапуска офис задачу по-прежнему не берёт',
    !officeAssign(restarted, idle.id).ok
    && restarted.tasks.get(idle.id)?.status === 'backlog');

  // Снятие паузы тоже доезжает до диска сразу. Зовём метод состояния, а не
  // agents.setPaused: обвязка снятия будит живую сессию менеджера, чтобы тот
  // разобрал очередь, а проверки токенов не тратят.
  restarted.setPaused(false);
  check('снятая пауза убрана из реестра на диске',
    onDisk().offices.find((o) => o.id === 'o-1')?.paused === undefined);
  check('после снятия паузы список офисов её больше не показывает',
    officeViews().find((o) => o.id === 'o-1')?.activity?.paused === false);

  // 26. Архив офиса. Пауза — «остановились и сейчас продолжим», архив —
  //     «этим проектом больше не занимаемся»: по архивному офису не идёт
  //     никакая работа, в память он не поднимается, задач не берёт и ритуалов
  //     не проводит. Из списка при этом не исчезает — иначе его нечем было бы
  //     вернуть, — а данные целы: архив это не удаление.
  mark = b.events.length;
  handleOfficeCommand({ c: 'archive_office', officeId: 'o-1', archived: true }, b);
  check('признак архива лёг в реестр на диске сразу, без ожидания дебаунса',
    onDisk().offices.find((o) => o.id === 'o-1')?.archived === true);
  check('архивный офис выгружен из памяти', !isOpened('o-1'));
  check('надзор за архивным офисом остановлен', !isSupervised('o-1'));
  check('архивный офис остался в списке — иначе его нечем вернуть',
    officeViews().some((o) => o.id === 'o-1'));
  check('в списке офис помечен архивным',
    officeViews().find((o) => o.id === 'o-1')?.archived === true);
  check('клиенту уехал список с признаком архива',
    b.last('offices', mark)?.offices.find((o) => o.id === 'o-1')?.archived === true);
  check('порядок списка архивация не сбила', order() === fixed);

  // Войти в архивный офис нельзя: открытие — это уже работа по нему.
  mark = b.events.length;
  handleOfficeCommand({ c: 'switch_office', officeId: 'o-1' }, b);
  await sleep(20);
  check('в архивный офис не переключиться, и он от этого не поднялся',
    b.last('office.error', mark)?.op === 'switch' && !isOpened('o-1'));

  // Дальше поднимаем состояние из архивной записи руками — так делать
  // некому, кроме этой проверки, но иначе не увидеть, что заслоны стоят
  // именно в работе, а не только в команде архивации.
  const dead = openOfficeState(onDisk().offices.find((o) => o.id === 'o-1')!).state;
  check('состояние из архивной записи знает, что офис в архиве', dead.archived === true);
  check('архив и пауза независимы: архивный офис не «на паузе»', dead.paused === false);
  check('доска архивного офиса цела: задача на месте', dead.tasks.has(idle.id));
  const refusedByArchive = officeAssign(dead, idle.id);
  check('архивный офис задачу не берёт',
    !refusedByArchive.ok && dead.tasks.get(idle.id)?.status === 'backlog');
  check('отказ объясняет причину архивом, а не паузой',
    refusedByArchive.message === dead.say('archive.stopped'));
  dispatch(dead);
  check('планировщик по архивному офису ничего не двигает',
    dead.tasks.get(idle.id)?.status === 'backlog');
  check('ритуала архивному офису не полагается', dueRitual(dead) === null);
  // Завтрашним временем: планёрку этому офису сегодня уже показывали, и «не
  // пора» вышло бы само собой, ничего не доказав про архив.
  const tomorrow = Date.now() + 36 * 60 * 60 * 1000;
  check('планёрка архивному офису не нужна и назавтра', !standupDue(dead, tomorrow));
  const runsBefore = dead.life.runs.length;
  const forced = await runRitual(dead, 'standup');
  check('ритуал по кнопке в архиве тоже не идёт',
    forced === null && dead.life.runs.length === runsBefore);
  startSupervisor(dead);
  check('надзор для архивного офиса не заводится', !isSupervised('o-1'));
  unloadOfficeState('o-1');

  // Возврат из архива: поле в реестре стирается целиком (нет поля — обычный
  // офис, и миграция никому не нужна), а офис снова готов работать. Чтобы
  // проверить это, не тратя токенов на настоящую сессию, ставим вернувшийся
  // офис на паузу: заслон архива снят, если отказ стал про паузу.
  mark = b.events.length;
  handleOfficeCommand({ c: 'archive_office', officeId: 'o-1', archived: false }, b);
  check('возврат из архива стёр поле в реестре, а не записал false',
    'archived' in (onDisk().offices.find((o) => o.id === 'o-1') ?? {}) === false);
  check('в списке офис снова обычный',
    officeViews().find((o) => o.id === 'o-1')?.archived === false);
  const revived = openOfficeState(onDisk().offices.find((o) => o.id === 'o-1')!).state;
  check('вернувшийся офис про архив не помнит', revived.archived === false);
  check('вернувшемуся офису снова полагается планёрка', standupDue(revived, tomorrow));
  check('доска пережила архив: задача на месте с тем же названием',
    revived.tasks.get(idle.id)?.title === 'ждёт снятия паузы');
  revived.setPaused(true);
  const refusedByPause = officeAssign(revived, idle.id);
  check('заслон архива снят: офис держит пауза, а не архив',
    !refusedByPause.ok && refusedByPause.message === revived.say('assign.paused'));
  revived.setPaused(false);

  // 27. Всё сделанное записано на диск: следующий запуск увидит то же самое.
  const saved = onDisk();
  check('реестр на диске знает все четыре офиса, включая скрытый',
    saved.offices.length === 4 && saved.offices.filter((o) => o.hidden).length === 1);
  check('текущий офис записан', saved.currentId === slowId);
  check('возвращённый офис на диске уже не скрыт',
    saved.offices.find((o) => o.id === madeId)?.hidden === false);

  // Досохраняем все поднятые офисы: у каждого свой файл и свой отложенный
  // таймер записи, и оставленный хвост дописался бы уже после уборки.
  for (const open of openedOffices()) open.flush();
  rmSync(ROOT, { recursive: true, force: true });

  // Прошедшей считается только строка, кончающаяся на true: «не false» пропускало
  // в зачёт всё, что вообще не булево, — например undefined из-за опечатки.
  const failed = results.filter((r) => !r.endsWith('true'));
  for (const r of results) console.log(`  ${r.endsWith('true') ? '✅' : '❌'} ${r}`);
  if (results.length === 0) {
    console.error('не выполнено ни одной проверки — прогону верить нельзя');
    process.exit(2);
  }
  console.log(failed.length
    ? `ПРОВАЛЕНО: ${failed.length} из ${results.length}`
    : `Все проверки прошли: ${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

// Прогон, оборвавшийся на середине, — не успех: часть проверок не выполнялась.
void main().catch((err) => {
  console.error(`прогон сорвался: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(2);
});

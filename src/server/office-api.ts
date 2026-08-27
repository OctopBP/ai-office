/**
 * Серверный API офисов: список, создание, переключение и скрытие, плюс
 * привязка подключённого клиента к тому офису, который он смотрит.
 *
 * Живёт отдельно от index.ts по двум причинам. Во-первых, это цельная часть
 * контракта: одни и те же правила («список без скрытых», «отказ уходит
 * просившему», «события чужого офиса не рассылаются») нужны и сокету,
 * и HTTP-ручке. Во-вторых, так их можно проверить, не поднимая сервер, —
 * рассылка знает про клиента ровно то, что описано в `Sink`.
 */
import type { ClientCommand, OfficeOp, ServerEvent } from '../shared/types';
import {
  getOffice, isOpened, officeViews, runningTasksOf, unloadOfficeState, type OfficeState,
} from './state';
import {
  createOffice, currentOffice, officeById, removeOffice, renameOffice, setCurrent,
  type OfficeEntry,
} from './offices';
import { stopSupervisor } from './supervisor';
import { c } from './i18n';
import { OFFICE_SENDER } from '../shared/types';

/**
 * Что рассылке нужно от клиента. Интерфейс вместо класса `ws.WebSocket`:
 * офисам всё равно, чем именно доставляют байты, а проверки подставляют
 * сюда свой сокет и обходятся без сети.
 */
export interface Sink {
  /** Числовые состояния сокета из WebSocket: 1 — соединение открыто. */
  readyState: number;
  send(payload: string): void;
}

const OPEN = 1;

/**
 * Клиент смотрит ровно один офис — тот, который выбрал. Значение в карте
 * и есть его выбор: события другого офиса ему не уходят, иначе в открытой
 * вкладке смешались бы доски двух разных проектов.
 */
const clients = new Map<Sink, string>();

/**
 * Открыть офис по-настоящему: поднять состояние, рабочую директорию и git.
 * Это делает index.ts — там же живут настройки запуска, — а сюда передаётся
 * при старте, чтобы переключение офиса не тянуло за собой полсервера.
 */
let openOffice: (entry: OfficeEntry) => Promise<void> = async () => {};

export function initOfficeApi(hooks: { openOffice: (entry: OfficeEntry) => Promise<void> }): void {
  openOffice = hooks.openOffice;
}

/**
 * Офис для только что подключившегося клиента: тот, который человек открывал
 * последним. Спрашиваем реестр, а не память: поднятых офисов несколько, и
 * «кого поднимали последним» — это не «куда человек заходил последним».
 * null — офис ещё не поднят (например, сервер только стартует): показывать
 * тогда нечего, а подписка клиента уже стоит на нужном офисе.
 */
function defaultState(): OfficeState | null {
  const current = currentOffice();
  return current && isOpened(current.id) ? getOffice(current.id) : null;
}

/**
 * Подписать клиента на офис, который человек открывал последним. Берём id из
 * реестра, даже если офис ещё открывается: снапшот уйдёт, когда тот откроется,
 * а команды до этого момента получат внятный отказ вместо чужого офиса.
 * Пустой реестр бывает только в юнит-проверках — там клиенту офиса нет.
 */
export function watch(ws: Sink): void {
  const id = currentOffice()?.id;
  if (id) clients.set(ws, id);
}

export function unwatch(ws: Sink): void {
  clients.delete(ws);
}

/** Какой офис смотрит клиент. null — клиент не подключён. */
export function watching(ws: Sink): string | null {
  return clients.get(ws) ?? null;
}

/** Сколько клиентов смотрят офис прямо сейчас. */
function viewers(officeId: string): number {
  let n = 0;
  for (const seen of clients.values()) if (seen === officeId) n += 1;
  return n;
}

/**
 * Офис, на который действует команда клиента, — тот, который он открыл.
 * null — офис ещё не поднят (клиент прислал команду, пока тот открывается):
 * применять её не к чему, и вызывающий говорит об этом человеку.
 *
 * Единственного офиса на процесс тут быть не может: клиентов несколько,
 * смотрят они разные офисы, и «текущий на процесс» отправил бы остановку
 * задачи или сообщение менеджеру в чужой проект.
 */
export function stateFor(ws: Sink): OfficeState | null {
  const id = clients.get(ws);
  if (!id || !isOpened(id)) return null;
  return getOffice(id);
}

/**
 * Событие офиса — только тем, кто этот офис открыл. Офис приходит отдельным
 * аргументом, а не подразумевается «текущим»: покинутый офис продолжает
 * работать и слать события, и его чат ушёл бы людям в совсем другом проекте.
 */
export function broadcast(event: ServerEvent, officeId: string): void {
  const payload = JSON.stringify(event);
  for (const [ws, seen] of clients) {
    if (seen !== officeId) continue;
    if (ws.readyState === OPEN) ws.send(payload);
  }
  // Работа любого офиса — включая тот, который сейчас никто не смотрит, —
  // меняет сводку в списке офисов. Иначе индикатор активности замирал бы
  // ровно тогда, когда он и нужен: пока человек работает в соседнем проекте.
  // Запрос доступа важен не меньше задачи: он останавливает работу до
  // возвращения человека, и в списке это должно быть видно сразу.
  if (event.t === 'task' || event.t === 'permission.request' || event.t === 'permission.resolved') {
    scheduleOffices();
  }
}

/**
 * Сколько копим изменения доски, прежде чем разослать список офисов. Список
 * идёт всем клиентам и считается по всем офисам, а задачи меняются пачками:
 * без склейки один прогон конвейера рассылал бы его десятки раз.
 */
const OFFICES_DEBOUNCE_MS = 1000;
let officesTimer: NodeJS.Timeout | null = null;

function scheduleOffices(): void {
  // Некому показывать — незачем и считать: сводка ходит по файлам состояния
  // неоткрытых офисов, а офис вполне может работать вообще без клиентов.
  if (officesTimer || clients.size === 0) return;
  officesTimer = setTimeout(() => {
    officesTimer = null;
    broadcastOffices();
  }, OFFICES_DEBOUNCE_MS);
  // Не держим процесс живым ради обновления списка.
  officesTimer.unref?.();
}

export function send(ws: Sink, event: ServerEvent): void {
  if (ws.readyState === OPEN) ws.send(JSON.stringify(event));
}

/** Разослать снапшот офиса тем, кто смотрит именно его. */
export function broadcastSnapshot(state: OfficeState): void {
  broadcast(state.snapshot(), state.officeId);
}

/**
 * Реестр офисов один на процесс, поэтому его изменения уходят всем сокетам,
 * а не только тем, кто смотрит открытый офис: у клиента в меню офис ещё не
 * выбран, и фильтр по подписке оставил бы меню с устаревшим списком.
 */
export function broadcastOffices(): void {
  const payload = JSON.stringify({ t: 'offices', offices: officeViews() } satisfies ServerEvent);
  for (const ws of clients.keys()) {
    if (ws.readyState === OPEN) ws.send(payload);
  }
}

/**
 * Отдать клиенту открытый офис целиком и записать, что он смотрит именно его.
 * Закрытый сокет в карту не возвращаем: между командой и ответом вкладку
 * успевают закрыть, а карта живёт до конца процесса.
 */
export function sendSnapshot(ws: Sink, state: OfficeState | null = defaultState()): void {
  // Офис не поднят — снапшота нет: отдавать вместо него пустую доску значило бы
  // показать человеку чужой или несуществующий офис.
  if (!state || ws.readyState !== OPEN) return;
  clients.set(ws, state.officeId);
  ws.send(JSON.stringify(state.snapshot()));
}

/**
 * Первый ответ подключившемуся клиенту. Стартовый офис поднимается один раз
 * на процесс, а подключений к нему сколько угодно, поэтому сюда передаётся
 * одно и то же обещание старта: оно отдаёт причину отказа по-русски либо
 * null, если офис открылся.
 *
 * Отказ уходит клиенту событием, а не молчанием: снапшота при неудачном
 * старте не будет никогда, и экран входа иначе ждал бы ответа до таймаута,
 * показывая «Открываем офис…». Вместе с причиной отдаём и список офисов —
 * тогда человеку есть что делать дальше: открыть другой проект или завести
 * новый, не перезапуская сервер.
 */
export async function greet(ws: Sink, startup: Promise<string | null>): Promise<void> {
  const problem = await startup;
  const officeId = watching(ws);
  // Вкладку успели закрыть, пока офис открывался.
  if (!officeId) return;
  // Снапшот берём по подписке клиента, а не «у текущего офиса»: пока стартовый
  // открывался, другой клиент мог перевести текущий на соседний проект.
  const state = problem ? null : stateFor(ws);
  if (state) {
    sendSnapshot(ws, state);
    return;
  }
  send(ws, { t: 'offices', offices: officeViews() });
  send(ws, {
    t: 'office.error', op: 'open', officeId,
    message: problem
      ?? c('office.notOpen', { id: officeId }),
  });
}

/**
 * Погасить офис целиком: надзор, живые сессии, хвост записи на диск и место
 * в памяти. Зовётся при скрытии офиса из списка — до этого поднятый офис жил
 * до конца процесса, и десяток проектов за смену означал десяток досок в
 * памяти и десяток тикающих надзирателей.
 *
 * Первым гасим надзор: его проход перезапускает конвейеры и будит сессии, и
 * попади он между закрытием сессий и удалением состояния — офис ожил бы уже
 * выгруженным. Файлы на диске не трогаем: скрытие — не удаление.
 *
 * Офисы, которые просто давно никто не смотрит, так НЕ выгружаются, и это
 * решение, а не недоделка. Покинутый офис в этом проекте продолжает работать:
 * его надзор доводит сданные ветки до основной, возобновляет прибитые
 * перезапуском задачи и раздаёт застоявшиеся. Выгрузка по таймауту бездействия
 * ровно это и выключала бы — причём тем вернее, чем дольше человек занят
 * соседним проектом, то есть именно тогда, когда фоновая работа и нужна.
 * «Нет задач и сессий прямо сейчас» этого не спасает: задача в очереди ждёт
 * своего прохода надзора, а его-то мы бы и остановили. Памяти же офис занимает
 * доску, чат и обрезанный до 500 записей лог — мегабайты, а не десятки.
 * Поэтому решение простое и предсказуемое: офис уходит из памяти тогда, когда
 * человек сам убрал его из списка.
 */
function unloadOffice(officeId: string): void {
  stopSupervisor(officeId);
  unloadOfficeState(officeId);
}

/**
 * Отказать в операции с офисом. Событие уходит просившему клиенту, а не
 * только в общий чат: меню показывает причину в форме, а не ищет её в
 * переписке постороннего проекта. Реплика в чат остаётся — её читают
 * клиенты, написанные до появления этого события, и она же оставляет след
 * в истории офиса.
 */
function refuse(op: OfficeOp, officeId: string | null, message: string, ws?: Sink): void {
  if (ws) send(ws, { t: 'office.error', op, officeId, message });
  // Реплика ложится в чат того офиса, где сидит просивший, а не «текущего на
  // процесс»: у соседнего клиента открыт другой проект, и запись про чужую
  // неудачу была бы там мусором. Офиса у просившего может и не быть (его ещё
  // открывают) — тогда следу лечь некуда, и человеку хватает события выше.
  const here = ws ? stateFor(ws) : null;
  here?.addChat(OFFICE_SENDER, message);
}

/**
 * Переключение проекта на ходу. Уйти можно всегда, в том числе из офиса с
 * задачами в работе: сессии покинутого офиса не трогаем — они продолжают
 * писать в своё состояние и отчитываться своему менеджеру, а состояние
 * сохраняется в свой файл. Переключение — это смена того, что видит человек,
 * а не остановка работы.
 *
 * `ws` — клиент, который попросил: снапшот выбранного офиса уходит ему в любом
 * случае, даже если офис уже был открыт, — иначе экран входа остался бы ждать
 * ответа, которого нет.
 */
export async function switchOffice(officeId: string, ws?: Sink): Promise<void> {
  const target = officeById(officeId);
  if (!target || target.hidden) {
    refuse('switch', officeId, c('offices.notFound', { id: officeId }), ws);
    return;
  }

  // Офис, который человек покидает, продолжает работать: задачи, сессии и
  // таймеры мы не трогаем. Но хвост его записи дописываем сразу — у каждого
  // офиса свой файл и свой отложенный таймер, а вкладку закрывают и раньше,
  // чем тот дотикает.
  const leaving = ws ? stateFor(ws) : null;
  if (leaving && leaving.officeId !== target.id) leaving.flush();
  setCurrent(target.id);

  let firstOpen = false;
  if (!isOpened(target.id)) {
    try {
      firstOpen = await openOnce(target);
    } catch (err) {
      refuse('switch', target.id,
        c('office.openFailed', { name: target.name, error: (err as Error).message }), ws);
      return;
    }
  }

  const state = getOffice(target.id);
  if (firstOpen) {
    state.addLog(null, 'system',
      state.say('office.opened', { name: target.name, dir: target.projectDir }));
    // Тем, кто уже ждёт этот офис, — целиком: события открытия прошли мимо них.
    broadcastSnapshot(state);
  }
  // Просившему снапшот уходит всегда, даже если офис уже был открыт: иначе
  // экран входа остался бы ждать ответа, которого нет. sendSnapshot заодно
  // перепишет его подписку — с этой минуты он смотрит новый офис.
  if (ws) sendSnapshot(ws, state);
  // Отметка «открыт сейчас» переехала на другую строку — это касается всех,
  // включая тех, кто сидит в меню и офис ещё не выбрал.
  broadcastOffices();
}

/**
 * Офисы, которые прямо сейчас открываются. Открытие ходит в файловую систему
 * и git, поэтому длится, а команд за это время может прийти сколько угодно:
 * два клиента входят в один офис одновременно, человек жмёт по списку дважды.
 * Второй заход обязан дождаться первого, а не поднять офису вторую доску,
 * второго надзирателя и второй набор сессий.
 */
const opening = new Map<string, Promise<void>>();

/** Возвращает true, если офис поднял именно этот заход, а не тот, кого он ждал. */
async function openOnce(entry: OfficeEntry): Promise<boolean> {
  const already = opening.get(entry.id);
  if (already) {
    await already;
    return false;
  }
  const started = openOffice(entry).finally(() => opening.delete(entry.id));
  opening.set(entry.id, started);
  await started;
  return true;
}

/**
 * Команды офисов. Возвращает false, если команда не про офисы, — тогда её
 * разбирает общий обработчик в index.ts.
 */
export function handleOfficeCommand(cmd: ClientCommand, ws: Sink): boolean {
  // Куда писать в ленту о случившемся: офис просившего. Он же адресат отказов.
  // null — офис клиента ещё поднимается: команды офисов от этого не зависят,
  // теряется только запись в ленте, которой пока некуда лечь.
  const here = stateFor(ws);
  if (cmd.c === 'list_offices') {
    send(ws, { t: 'offices', offices: officeViews() });
    return true;
  }
  if (cmd.c === 'switch_office') {
    void switchOffice(cmd.officeId, ws);
    return true;
  }
  if (cmd.c === 'create_office') {
    // Путь пришёл от человека: несуществующую папку не заводим молча,
    // а объясняем, что не так.
    const made = createOffice({ name: cmd.name, projectDir: cmd.projectDir, mustExist: true });
    if ('error' in made) {
      refuse('create', null, made.error, ws);
      return true;
    }
    if (made.restored) {
      here?.addLog(null, 'system',
        c('office.restored', { name: made.office.name }));
    }
    broadcastOffices();
    void switchOffice(made.office.id, ws);
    return true;
  }
  if (cmd.c === 'rename_office') {
    const problem = renameOffice(cmd.officeId, cmd.name);
    if (problem) refuse('rename', cmd.officeId, problem, ws);
    else broadcastOffices();
    return true;
  }
  if (cmd.c === 'remove_office') {
    // Название читаем до скрытия — потом офиса в списке уже нет.
    const name = officeById(cmd.officeId)?.name ?? cmd.officeId;
    // Покинутый офис продолжает работать: уйти из него можно и с задачами
    // в работе. Значит, «не открыт» больше не значит «пуст», и убирать из
    // списка офис, где идут задачи, нельзя — они бы тратили деньги в офисе,
    // которого человек больше не видит. Само состояние скрытие не трогает:
    // доска и расходы остаются в памяти и возвращаются вместе с офисом.
    const running = runningTasksOf(cmd.officeId);
    if (running.length) {
      refuse('remove', cmd.officeId,
        c('office.busy', { name, tasks: running.join(', ') }), ws);
      return true;
    }
    // Скрытие теперь гасит офис, а не только прячет строку в списке, поэтому
    // убирать тот, на который кто-то смотрит, нельзя: у него бы просто
    // перестали работать команды. Реестр знает только про «открытый сейчас»,
    // а вкладок несколько, и смотреть они могут разные проекты.
    if (viewers(cmd.officeId)) {
      refuse('remove', cmd.officeId,
        c('office.openElsewhere', { name }), ws);
      return true;
    }
    // Офис прямо сейчас поднимается: открытие ходит в файловую систему и git
    // и потому длится. Выгрузить его посередине значит получить обратно офис
    // с надзором и сессиями, которого в списке уже нет.
    if (opening.has(cmd.officeId)) {
      refuse('remove', cmd.officeId,
        c('office.stillOpening', { name }), ws);
      return true;
    }
    const problem = removeOffice(cmd.officeId);
    if (problem) {
      refuse('remove', cmd.officeId, problem, ws);
    } else {
      // Из списка офис убран — теперь его надо погасить: иначе он остался бы
      // в памяти со своим надзором и сессиями, невидимый и неостановимый.
      unloadOffice(cmd.officeId);
      here?.addLog(null, 'system',
        c('office.removed', { name }));
      broadcastOffices();
    }
    return true;
  }
  return false;
}

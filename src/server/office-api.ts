/**
 * Серверный API офисов: список, создание, переключение, перестановка и
 * скрытие, плюс привязка подключённого клиента к тому офису, который он
 * смотрит.
 *
 * Живёт отдельно от index.ts по двум причинам. Во-первых, это цельная часть
 * контракта: одни и те же правила («список без скрытых», «отказ уходит
 * просившему», «события чужого офиса не рассылаются») нужны и сокету,
 * и HTTP-ручке. Во-вторых, так их можно проверить, не поднимая сервер, —
 * рассылка знает про клиента ровно то, что описано в `Sink`.
 */
import type { ClientCommand, OfficeOp, ServerEvent } from '../shared/types';
import {
  getOffice, isOpened, officeViews, openedOffices, runningTasksOf, unloadOfficeState,
  type OfficeState,
} from './state';
import {
<<<<<<< HEAD
  createOffice, currentOffice, officeById, removeOffice, renameOffice, reorderOffice, setCurrent,
  setOfficeIcon, type OfficeEntry,
=======
  createOffice, currentOffice, officeById, removeOffice, renameOffice, setCurrent,
  setOfficeArchived, setOfficeIcon, type OfficeEntry,
>>>>>>> main
} from './offices';
import { stopSupervisor } from './supervisor';
import { stopHealth } from './health';
import { noteOfficeViewed } from './rituals';
import { buildOffice, planProblem, setupCatalog } from './setup';
import { pickFolder } from './pickfolder';
import { c, consoleLang } from './i18n';
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
  // Пауза — редкое ручное действие одного человека, а не поток событий доски,
  // поэтому её рассылаем без склейки: нажал SPACE — метка в списке офисов
  // переключилась сразу, а не через секунду.
  if (event.t === 'paused') broadcastOffices();
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
  // Планёрка — до снапшота: тогда она уезжает внутри него, а не отдельным
  // событием следом, и клиент видит её сразу, как открыл офис.
  noteOfficeViewed(state);
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
 * в памяти. Зовётся при скрытии офиса из списка и при уборке его в архив —
 * до этого поднятый офис жил до конца процесса, и десяток проектов за смену
 * означал десяток досок в памяти и десяток тикающих надзирателей.
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
  stopHealth(officeId);
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
  // Архивный офис не открывается: открытие и есть начало работы — состояние
  // в памяти, надзор, сессии. Из списка он при этом не пропадает, иначе
  // вернуть его было бы неоткуда.
  if (target.archived) {
    refuse('switch', officeId, c('office.archivedOpen', { name: target.name }), ws);
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
 * Собрать офис по плану мастера. Прогресс уходит просившему; итог — вход в
 * новый офис тем же путём, что `switch_office` (офис уже поднят сборкой, так
 * что это только снапшот), либо отказ с op `create`, как у старой формы.
 * Язык — процесса: офиса, на языке которого говорить, ещё нет.
 */
async function runSetup(plan: Parameters<typeof planProblem>[0], ws: Sink): Promise<void> {
  const lang = consoleLang();
  const problem = planProblem(plan, lang);
  if (problem) {
    refuse('create', null, problem, ws);
    return;
  }
  const made = await buildOffice(plan, lang, {
    open: async (entry) => { await openOnce(entry); },
    state: getOffice,
    progress: (steps) => send(ws, { t: 'setup.progress', steps }),
  });
  if ('error' in made) {
    refuse('create', null, made.error, ws);
    return;
  }
  broadcastOffices();
  await switchOffice(made.officeId, ws);
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
  if (cmd.c === 'setup_catalog') {
    void setupCatalog(consoleLang()).then((catalog) => send(ws, { t: 'setup.catalog', catalog }));
    return true;
  }
  if (cmd.c === 'setup_office') {
    void runSetup(cmd.plan, ws);
    return true;
  }
  if (cmd.c === 'pick_folder') {
    const purpose = String(cmd.purpose ?? '');
    void pickFolder(typeof cmd.start === 'string' ? cmd.start : undefined, consoleLang()).then((got) => {
      send(ws, {
        t: 'folder.picked', purpose,
        dir: 'dir' in got ? got.dir : null,
        error: 'error' in got ? got.error : null,
      });
    });
    return true;
  }
  if (cmd.c === 'rename_office') {
    const problem = renameOffice(cmd.officeId, cmd.name);
    if (problem) refuse('rename', cmd.officeId, problem, ws);
    else broadcastOffices();
    return true;
  }
  if (cmd.c === 'reorder_office') {
    const problem = reorderOffice(cmd.officeId, cmd.index);
    if (problem) {
      refuse('reorder', cmd.officeId, problem, ws);
      return true;
    }
    // Порядок списка уходит всем сокетам, а не только тому, кто перетаскивал:
    // рейл с офисами висит в каждой вкладке, и во второй он иначе остался бы
    // с прежним порядком до перезагрузки страницы.
    broadcastOffices();
    // И снапшот тем, кто смотрит открытые офисы: список офисов лежит внутри
    // снапшота, и без этого доска показывала бы старый порядок до следующего
    // события. Снапшот идёт КАЖДОМУ поднятому офису: порядок общий на процесс,
    // а не свойство того офиса, в котором нажали.
    for (const state of openedOffices()) broadcastSnapshot(state);
    return true;
  }
  if (cmd.c === 'set_office_icon') {
    const problem = setOfficeIcon(cmd.officeId, cmd.icon ?? null);
    if (problem) {
      refuse('icon', cmd.officeId, problem, ws);
      return true;
    }
    // Список офисов уходит всем: аватарка видна в рейле, а не только в той
    // вкладке, где её меняли.
    broadcastOffices();
    // И снапшот тому, кто смотрит этот офис: список офисов лежит внутри
    // снапшота, и без этого открытая доска показывала бы старую иконку до
    // следующего события.
    const state = isOpened(cmd.officeId) ? getOffice(cmd.officeId) : null;
    if (state) broadcastSnapshot(state);
    return true;
  }
  if (cmd.c === 'archive_office') {
    const office = officeById(cmd.officeId);
    if (!office || office.hidden) {
      refuse('archive', cmd.officeId, c('offices.notFound', { id: cmd.officeId }), ws);
      return true;
    }
    // Уже в том состоянии, которое просят: отвечаем списком, а не отказом —
    // две вкладки вполне могут нажать одно и то же.
    if ((office.archived === true) === cmd.archived) {
      broadcastOffices();
      return true;
    }
    if (!cmd.archived) {
      // Возврат из архива ничего не поднимает: офис становится обычным, и
      // человек входит в него тем же переключением, что и в любой другой.
      setOfficeArchived(office.id, false);
      here?.addLog(null, 'system', c('office.unarchived', { name: office.name }));
      broadcastOffices();
      return true;
    }
    // Дальше — уборка в архив. Запреты те же, что у скрытия из списка, и по
    // тем же причинам: архивация гасит офис целиком.
    // Идущая работа: оборвать её на середине означало бы бросить ветку и
    // рабочую копию посередине задачи.
    const running = runningTasksOf(office.id);
    if (running.length) {
      refuse('archive', office.id,
        c('office.archiveBusy', { name: office.name, tasks: running.join(', ') }), ws);
      return true;
    }
    // На офис смотрят — свой или чужой вкладкой: у зрителя просто перестали бы
    // работать команды, потому что состояние выгружено.
    if (viewers(office.id)) {
      refuse('archive', office.id, c('office.archiveOpenElsewhere', { name: office.name }), ws);
      return true;
    }
    // Офис прямо сейчас поднимается: выгрузить его посередине значит получить
    // обратно офис с надзором и сессиями — уже архивный.
    if (opening.has(office.id)) {
      refuse('archive', office.id, c('office.archiveOpening', { name: office.name }), ws);
      return true;
    }
    setOfficeArchived(office.id, true);
    // Признак — на живое состояние до выгрузки: между этими двумя строками
    // офис ещё может успеть дёрнуть надзор или раздачу задачи.
    if (isOpened(office.id)) getOffice(office.id).archived = true;
    // И гасим: надзор, сессии, хвост записи, место в памяти. Файлы целы —
    // архив это не удаление.
    unloadOffice(office.id);
    here?.addLog(null, 'system', c('office.archived', { name: office.name }));
    broadcastOffices();
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

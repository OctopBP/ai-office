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
import { getOffice, isOpened, office, officeViews, runningTasksOf, type OfficeState } from './state';
import {
  createOffice, currentOffice, officeById, removeOffice, renameOffice, setCurrent,
  type OfficeEntry,
} from './offices';

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
 * последним. Берём его из реестра, а не из `office`: тот показывает, какой
 * офис последним поднимали в память, а это не одно и то же — вернуться можно
 * и в уже поднятый, поднимать его при этом не надо.
 */
function defaultState(): OfficeState {
  const current = currentOffice();
  return current && isOpened(current.id) ? getOffice(current.id) : office;
}

/** Подписать клиента на офис, который человек открывал последним. */
export function watch(ws: Sink): void {
  clients.set(ws, defaultState().officeId);
}

export function unwatch(ws: Sink): void {
  clients.delete(ws);
}

/** Какой офис смотрит клиент. null — клиент не подключён. */
export function watching(ws: Sink): string | null {
  return clients.get(ws) ?? null;
}

/**
 * Офис, на который действует команда клиента, — тот, который он открыл.
 * null — офис ещё не поднят (клиент прислал команду, пока тот открывается):
 * применять её не к чему, и вызывающий говорит об этом человеку.
 *
 * Брать `office` вместо этого нельзя: клиентов несколько, смотрят они разные
 * офисы, и «текущий на процесс» отправил бы остановку задачи или сообщение
 * менеджеру в чужой проект.
 */
export function stateFor(ws: Sink): OfficeState | null {
  const id = clients.get(ws);
  if (!id || !isOpened(id)) return null;
  return getOffice(id);
}

/**
 * Событие офиса — только тем, кто этот офис открыл. Офис приходит отдельным
 * аргументом, а не берётся из `office`: покинутый офис продолжает работать и
 * слать события, и его чат ушёл бы людям, сидящим в совсем другом проекте.
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
export function sendSnapshot(ws: Sink, state: OfficeState = defaultState()): void {
  if (ws.readyState !== OPEN) return;
  clients.set(ws, state.officeId);
  ws.send(JSON.stringify(state.snapshot()));
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
  // неудачу была бы там мусором.
  const here = ws ? stateFor(ws) : null;
  (here ?? office).addChat('офис', message);
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
    refuse('switch', officeId, `Офис ${officeId} не найден — похоже, список устарел.`, ws);
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
        `Офис «${target.name}» не открылся: ${(err as Error).message}. ` +
        'Проверьте, что директория проекта на месте и доступна, и попробуйте снова.', ws);
      return;
    }
  }

  const state = getOffice(target.id);
  if (firstOpen) {
    state.addLog(null, 'system', `Открыт офис «${target.name}» (${target.projectDir})`);
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
  const here = stateFor(ws) ?? office;
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
      here.addLog(null, 'system',
        `Офис «${made.office.name}» вернулся в список вместе со своей доской`);
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
        `В офисе «${name}» ещё идёт работа: ${running.join(', ')}. ` +
        'Дождитесь этих задач или остановите их, а потом убирайте офис из списка.', ws);
      return true;
    }
    const problem = removeOffice(cmd.officeId);
    if (problem) {
      refuse('remove', cmd.officeId, problem, ws);
    } else {
      here.addLog(null, 'system',
        `Офис «${name}» убран из списка. Файлы проекта и его доска остались на диске.`);
      broadcastOffices();
    }
    return true;
  }
  return false;
}

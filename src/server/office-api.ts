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
import { office, officeViews, runningTasksOf } from './state';
import {
  createOffice, officeById, removeOffice, renameOffice, setCurrent, type OfficeEntry,
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

/** Подписать клиента на открытый офис. */
export function watch(ws: Sink): void {
  clients.set(ws, office.officeId);
}

export function unwatch(ws: Sink): void {
  clients.delete(ws);
}

/** Какой офис смотрит клиент. null — клиент не подключён. */
export function watching(ws: Sink): string | null {
  return clients.get(ws) ?? null;
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
}

export function send(ws: Sink, event: ServerEvent): void {
  if (ws.readyState === OPEN) ws.send(JSON.stringify(event));
}

export function broadcastSnapshot(): void {
  broadcast(office.snapshot(), office.officeId);
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
export function sendSnapshot(ws: Sink): void {
  if (ws.readyState !== OPEN) return;
  clients.set(ws, office.officeId);
  ws.send(JSON.stringify(office.snapshot()));
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
  office.addChat('офис', message);
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
  if (target.id === office.officeId) {
    setCurrent(target.id);
    if (ws) sendSnapshot(ws);
    broadcastOffices();
    return;
  }

  setCurrent(target.id);
  // Досохраняем именно покидаемый офис: openOffice ниже переставит `office`.
  // Хвост его записи после этого идёт в его собственный файл — путь хранится
  // в самом состоянии, а не в общем на процесс хранилище.
  office.flush();
  await openOffice(target);
  office.addLog(null, 'system', `Открыт офис «${target.name}» (${target.projectDir})`);
  // Сначала тем, кто уже смотрел этот офис, потом просившему: он до сих пор
  // числится за прежним офисом, и sendSnapshot заодно перепишет его выбор —
  // иначе он получил бы снапшот дважды.
  broadcastSnapshot();
  if (ws) sendSnapshot(ws);
  // Отметка «открыт сейчас» переехала на другую строку — это касается всех,
  // включая тех, кто сидит в меню и офис ещё не выбрал.
  broadcastOffices();
}

/**
 * Команды офисов. Возвращает false, если команда не про офисы, — тогда её
 * разбирает общий обработчик в index.ts.
 */
export function handleOfficeCommand(cmd: ClientCommand, ws: Sink): boolean {
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
      office.addLog(null, 'system',
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
      office.addLog(null, 'system',
        `Офис «${name}» убран из списка. Файлы проекта и его доска остались на диске.`);
      broadcastOffices();
    }
    return true;
  }
  return false;
}

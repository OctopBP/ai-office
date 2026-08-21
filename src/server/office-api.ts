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
import { office, officeViews } from './state';
import { resetSessions } from './agents';
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

/** Событие открытого офиса — только тем, кто смотрит именно его. */
export function broadcast(event: ServerEvent): void {
  const payload = JSON.stringify(event);
  for (const [ws, seen] of clients) {
    if (seen !== office.officeId) continue;
    if (ws.readyState === OPEN) ws.send(payload);
  }
}

export function send(ws: Sink, event: ServerEvent): void {
  if (ws.readyState === OPEN) ws.send(JSON.stringify(event));
}

export function broadcastSnapshot(): void {
  broadcast(office.snapshot());
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
 * Переключение проекта на ходу. Идущие задачи не бросаем: их сессии живут
 * в рабочей директории этого офиса, и оборвать их переключением значило бы
 * потерять работу молча. `ws` — клиент, который попросил: снапшот выбранного
 * офиса уходит ему в любом случае, даже если офис уже был открыт, — иначе
 * экран входа остался бы ждать ответа, которого нет.
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
    return;
  }

  // Переключение обрывает сессии открытого офиса (resetSessions ниже),
  // поэтому незаконченную работу оно потеряло бы молча — на это нужен
  // ответ человека, а не автоматика.
  const running = [...office.tasks.values()].filter((t) => t.status === 'in_progress');
  if (running.length) {
    refuse('switch', officeId,
      `Сначала дождитесь или остановите задачи в работе: ${running.map((t) => t.id).join(', ')}.`,
      ws);
    return;
  }

  setCurrent(target.id);
  resetSessions();
  // Досохраняем именно закрываемый офис: openOffice ниже переключит файл.
  office.flush();
  await openOffice(target);
  office.addLog(null, 'system', `Открыт офис «${target.name}» (${target.projectDir})`);
  if (ws && clients.has(ws)) clients.set(ws, office.officeId);
  broadcastSnapshot();
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

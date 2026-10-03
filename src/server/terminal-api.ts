/**
 * Протокол встроенного терминала поверх WebSocket офиса: команды `term_*` от
 * клиента и события `term.*` ему же. Сам псевдотерминал — в terminal.ts, здесь
 * только транспорт: кому принадлежит сессия, право открыть, обратное давление.
 *
 * Терминал не трогает доску и ленту событий: его события уходят одному
 * сокету-владельцу через `send`, а не через рассылку офиса.
 */

import type { ClientCommand, ServerEvent, TerminalCommand } from '../shared/types';
import { send, stateFor, watching, type Sink } from './office-api';
import {
  canOpenTerminal, closeAll, closeAllForClient, isExposed, openTerminal, terminalFor,
  TerminalError, type TerminalHandle,
} from './terminal';

/** Сокет терминала: к рассылке добавляется размер неотправленного буфера. */
export interface TermSocket extends Sink {
  bufferedAmount: number;
}

/** Заголовки запроса на апгрейд сокета — по ним решается право открыть. */
export interface TermHeaders {
  origin?: string;
  host?: string;
}

/** Выше этого буфера сокета терминал ставится на паузу. */
const HIGH_WATER = 1024 * 1024;
/** Ниже этого — снимается с паузы: зазор, чтобы не дёргать pause/resume на каждом куске. */
const LOW_WATER = 256 * 1024;
/** Как часто смотреть, сошёл ли буфер: у `ws` нет своего события «слил». */
const DRAIN_POLL_MS = 50;

interface Client {
  id: string;
  headers: TermHeaders;
  /** Терминалы на паузе из-за полного буфера этого сокета. */
  paused: Set<TerminalHandle>;
  timer: NodeJS.Timeout | null;
}

const clients = new Map<TermSocket, Client>();
let seq = 0;

/** Запомнить сокет и заголовки его апгрейда. Зовётся на `connection`. */
export function attachTerminalClient(ws: TermSocket, headers: TermHeaders): void {
  clients.set(ws, { id: `ws${++seq}`, headers, paused: new Set(), timer: null });
}

/** Сокет закрылся — все его терминалы убиваются. */
export function detachTerminalClient(ws: TermSocket): void {
  const client = clients.get(ws);
  if (!client) return;
  if (client.timer) clearInterval(client.timer);
  clients.delete(ws);
  closeAllForClient(client.id);
}

/** Остановка сервера: закрыть все терминалы всех клиентов. */
export function closeAllTerminals(): void {
  for (const client of clients.values()) if (client.timer) clearInterval(client.timer);
  closeAll();
}

function isTerminalCommand(cmd: ClientCommand): cmd is TerminalCommand {
  return cmd.c === 'term_open' || cmd.c === 'term_input' || cmd.c === 'term_resize' || cmd.c === 'term_close';
}

/** Отдать событие терминала и проверить буфер сокета. */
function emit(ws: TermSocket, client: Client, handle: TerminalHandle | null, event: ServerEvent): void {
  send(ws, event);
  if (!handle || ws.bufferedAmount <= HIGH_WATER || client.paused.has(handle)) return;
  handle.pause();
  client.paused.add(handle);
  if (client.timer) return;
  client.timer = setInterval(() => {
    // Сокет закрылся — снимать с паузы нечего, терминалы закроет `close`.
    if (ws.readyState !== 1 || ws.bufferedAmount < LOW_WATER) {
      if (client.timer) clearInterval(client.timer);
      client.timer = null;
      for (const h of client.paused) h.resume();
      client.paused.clear();
    }
  }, DRAIN_POLL_MS);
  client.timer.unref?.();
}

function fail(ws: TermSocket, err: unknown, ids: { nonce?: string; id?: string }): void {
  if (err instanceof TerminalError) {
    send(ws, { t: 'term.error', ...ids, reason: err.reason, message: err.message });
    return;
  }
  // Неожиданный сбой — тоже ответ, а не молчание: клиент ждёт `term.opened`.
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[terminal] ${message}`);
  send(ws, { t: 'term.error', ...ids, reason: 'unavailable', message });
}

function open(ws: TermSocket, client: Client, cmd: Extract<TerminalCommand, { c: 'term_open' }>): void {
  const { nonce } = cmd;
  const access = canOpenTerminal({
    exposed: isExposed(),
    // Входа владельца пока нет: офис запускают как приложение на 127.0.0.1.
    ownerSignedIn: false,
    origin: client.headers.origin,
    host: client.headers.host,
    publicUrl: process.env.OFFICE_PUBLIC_URL?.trim() || undefined,
  });
  if (!access.ok) {
    send(ws, { t: 'term.error', nonce, reason: access.reason, message: access.message });
    return;
  }
  // Папку берёт сервер, не клиент: репозиторий офиса, который смотрит этот сокет.
  const state = stateFor(ws);
  const officeId = watching(ws);
  if (!state || !officeId || !state.projectDir) {
    send(ws, { t: 'term.error', nonce, reason: 'no_dir', message: 'Офис ещё не открыт — терминалу негде стартовать.' });
    return;
  }
  let handle: TerminalHandle | null = null;
  try {
    handle = openTerminal({
      clientId: client.id,
      cwd: state.projectDir,
      cols: cmd.cols,
      rows: cmd.rows,
      onData: (data) => {
        if (handle) emit(ws, client, handle, { t: 'term.output', id: handle.id, data });
      },
      onExit: ({ code, signal }) => {
        if (!handle) return;
        client.paused.delete(handle);
        send(ws, { t: 'term.exit', id: handle.id, code, signal });
      },
    });
  } catch (err) {
    fail(ws, err, { nonce });
    return;
  }
  send(ws, { t: 'term.opened', nonce, id: handle.id, cwd: handle.cwd, shell: handle.shell, officeId });
}

/**
 * Разобрать команду терминала. true — команда терминала и обработана; false —
 * не наша, пусть разбирает дальше index.ts.
 */
export function handleTerminalCommand(cmd: ClientCommand, ws: TermSocket): boolean {
  if (!isTerminalCommand(cmd)) return false;
  const client = clients.get(ws);
  if (!client) return true;
  if (cmd.c === 'term_open') {
    open(ws, client, cmd);
    return true;
  }
  // Чужой или закрытый терминал не виден: `terminalFor` сверяет владельца.
  const handle = terminalFor(client.id, cmd.id);
  if (!handle) {
    send(ws, { t: 'term.error', id: cmd.id, reason: 'unknown_id', message: `Терминал ${cmd.id} не найден.` });
    return true;
  }
  try {
    if (cmd.c === 'term_input') {
      if (typeof cmd.data === 'string') handle.write(cmd.data);
    } else if (cmd.c === 'term_resize') {
      handle.resize(cmd.cols, cmd.rows);
    } else {
      client.paused.delete(handle);
      handle.close();
    }
  } catch (err) {
    fail(ws, err, { id: cmd.id });
  }
  return true;
}

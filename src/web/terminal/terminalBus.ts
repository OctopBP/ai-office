/**
 * Шина встроенного терминала: команды уходят серверу по общему сокету стора,
 * события `term.*` раздаются подписчикам по ключу. Ключ — `nonce` запроса на
 * открытие, пока сервер не ответил, и `id` терминала после `term.opened`.
 * Подписчик сам подписывается на `id`, когда его узнаёт.
 *
 * Протокол — `TerminalCommand`/`TerminalEvent` в shared/types.ts; источник
 * правды — сервер, здесь только доставка.
 */
import type { TerminalCommand, TerminalEvent } from '../../shared/types';
import { onServerEvent, sendTerminal, useStore } from '../store';

type Listener = (e: TerminalEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const dropListeners = new Set<() => void>();

/** Отправить команду терминала. `false` — сокет закрыт, команда не ушла. */
export function sendTerm(cmd: TerminalCommand): boolean {
  return sendTerminal(cmd);
}

/** Слушать события терминала по `nonce` или `id`. Возвращает отписку. */
export function subscribeTerm(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
  };
}

/**
 * Слушать обрыв сокета. Сервер на обрыве убивает все терминалы соединения,
 * поэтому живые вкладки должны честно сказать, что их сессия кончилась.
 */
export function onTermDisconnect(listener: () => void): () => void {
  dropListeners.add(listener);
  return () => { dropListeners.delete(listener); };
}

function deliver(key: string | undefined, e: TerminalEvent): boolean {
  if (key === undefined) return false;
  const set = listeners.get(key);
  if (!set?.size) return false;
  for (const listener of [...set]) listener(e);
  return true;
}

function route(e: TerminalEvent): void {
  switch (e.t) {
    case 'term.opened':
      // Вкладку закрыли раньше, чем сервер ответил, — терминал никому не нужен.
      if (!deliver(e.nonce, e)) sendTerm({ c: 'term_close', id: e.id });
      return;
    case 'term.output':
    case 'term.exit':
      deliver(e.id, e);
      return;
    case 'term.error':
      if (!deliver(e.nonce, e)) deliver(e.id, e);
      return;
  }
}

function isTerminalEvent(e: { t: string }): e is TerminalEvent {
  return e.t.startsWith('term.');
}

// Подписки модуля живут, пока живёт страница.
onServerEvent((e) => { if (isTerminalEvent(e)) route(e); });
useStore.subscribe((s, prev) => {
  if (s.connected || !prev.connected) return;
  for (const listener of [...dropListeners]) listener();
});

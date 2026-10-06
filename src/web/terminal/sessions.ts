/**
 * Реестр сессий встроенного терминала. Один терминал — одно окно дока
 * (`terminal:N` в раскладке). Живые xterm и подписки лежат здесь, вне React:
 * компонент окна может размонтироваться (док перенесли, офис перерисовался),
 * а сессия и процесс на сервере — нет. Сессия закрывается, только когда окно
 * исчезло из раскладки (закрыли вкладку, сменили офис).
 *
 * Доставка команд и событий — `terminalBus.ts`.
 */
import { create } from 'zustand';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalErrorReason, TerminalEvent } from '../../shared/types';
import { t } from '../i18n';
import { useLayout } from '../layout/store';
import { findWindow } from '../layout/model';
import { onTermDisconnect, sendTerm, subscribeTerm } from './terminalBus';

export type TermStatus = 'opening' | 'live' | 'exited' | 'error';

/** Что нужно для отрисовки; сами объекты xterm в состояние не кладём. */
export interface TermView {
  status: TermStatus;
  /** Рабочая папка из `term.opened`. */
  cwd: string | null;
  /** Понятный текст отказа или обрыва; показывается над буфером. */
  error: string | null;
}

export const useTermViews = create<{ byId: Record<string, TermView> }>(() => ({ byId: {} }));

interface Session {
  term: Terminal;
  fit: FitAddon;
  /** Постоянный узел xterm: окно переносит его к себе, а не создаёт заново. */
  host: HTMLDivElement;
  opened: boolean;
  /** Номер терминала на сервере; до `term.opened` его нет. */
  id: string | null;
  status: TermStatus;
  unsubs: Array<() => void>;
}

const sessions = new Map<string, Session>();
let seq = 0;

/** Цвета и шрифт xterm — из токенов: canvas xterm не читает CSS-переменные сам. */
function themeFromTokens(): { fontFamily: string; theme: Record<string, string> } {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    fontFamily: v('--font-mono', 'monospace'),
    theme: {
      background: v('--surface', '#ffffff'),
      foreground: v('--ink-2', '#323232'),
      cursor: v('--accent', '#2f7bf6'),
      cursorAccent: v('--surface', '#ffffff'),
      selectionBackground: `rgba(${v('--accent-rgb', '47, 123, 246')}, .25)`,
    },
  };
}

/** Понятный текст отказа: своя фраза по причине и уточнение сервера ниже. */
function errorText(reason: TerminalErrorReason, message: string): string {
  const head = t(`terminal.error.${reason}`);
  return message && message !== head ? `${head}\n${message}` : head;
}

function patchView(winId: string, patch: Partial<TermView>): void {
  useTermViews.setState((s) => ({
    byId: { ...s.byId, [winId]: { ...(s.byId[winId] ?? { status: 'opening', cwd: null, error: null }), ...patch } },
  }));
}

/** Подогнать сетку xterm под контейнер; новый размер уйдёт серверу через `onResize`. */
export function fitSession(winId: string): void {
  const s = sessions.get(winId);
  if (!s || !s.opened || !s.host.isConnected || s.host.clientWidth === 0 || s.host.clientHeight === 0) return;
  s.fit.fit();
}

/** Узел xterm окна: посадить в контейнер и один раз открыть xterm. */
export function mountSession(winId: string, el: HTMLElement): void {
  const s = sessions.get(winId);
  if (!s) return;
  if (s.host.parentElement !== el) el.appendChild(s.host);
  if (!s.opened) {
    s.term.open(s.host);
    s.opened = true;
  }
}

export function focusSession(winId: string): void {
  sessions.get(winId)?.term.focus();
}

/** Создать сессию окна, если её ещё нет: xterm и запрос серверу открыть оболочку. */
export function ensureSession(winId: string): void {
  if (sessions.has(winId)) return;
  const key = `tt${Date.now().toString(36)}${++seq}`;
  const { fontFamily, theme } = themeFromTokens();
  const term = new Terminal({ cols: 80, rows: 24, fontFamily, fontSize: 12, theme, cursorBlink: true, scrollback: 5000 });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const host = document.createElement('div');
  host.className = 'term-xterm';
  const s: Session = { term, fit, host, opened: false, id: null, status: 'opening', unsubs: [] };
  sessions.set(winId, s);

  const setStatus = (status: TermStatus, patch: Partial<TermView> = {}) => {
    s.status = status;
    patchView(winId, { status, ...patch });
  };
  patchView(winId, { status: 'opening', cwd: null, error: null });

  // Ввод и размер уходят только живому терминалу: до `term.opened` id нет,
  // а размер на открытии сервер получает в самом `term_open`.
  term.onData((data) => {
    if (s.id && s.status === 'live') sendTerm({ c: 'term_input', id: s.id, data });
  });
  term.onResize(({ cols, rows }) => {
    if (s.id && s.status === 'live') sendTerm({ c: 'term_resize', id: s.id, cols, rows });
  });

  const onEvent = (e: TerminalEvent) => {
    switch (e.t) {
      case 'term.opened':
        if (s.id) return;
        s.id = e.id;
        s.unsubs.push(subscribeTerm(e.id, onEvent));
        setStatus('live', { cwd: e.cwd, error: null });
        // Пока ждали ответ, сетку могли подогнать под док — серверу нужен
        // настоящий размер, а не 80×24 из запроса.
        fitSession(winId);
        sendTerm({ c: 'term_resize', id: e.id, cols: term.cols, rows: term.rows });
        return;
      case 'term.output':
        term.write(e.data);
        return;
      case 'term.exit': {
        if (s.status === 'exited') return;
        const code = e.code ?? e.signal ?? 0;
        term.write(`\r\n\x1b[2m${t('terminal.exited', { code })}\x1b[0m\r\n`);
        setStatus('exited');
        return;
      }
      case 'term.error':
        setStatus('error', { error: errorText(e.reason, e.message) });
        return;
    }
  };
  s.unsubs.push(subscribeTerm(key, onEvent));
  s.unsubs.push(onTermDisconnect(() => {
    if (s.status === 'live' || s.status === 'opening') setStatus('error', { error: t('terminal.error.disconnected') });
  }));

  if (!sendTerm({ c: 'term_open', nonce: key, cols: term.cols, rows: term.rows })) {
    setStatus('error', { error: t('terminal.error.offline') });
  }
}

/** Закрыть сессию: серверу `term_close`, xterm — в утиль. */
function dropSession(winId: string): void {
  const s = sessions.get(winId);
  if (!s) return;
  if (s.id && s.status === 'live') sendTerm({ c: 'term_close', id: s.id });
  for (const unsub of s.unsubs) unsub();
  s.term.dispose();
  s.host.remove();
  sessions.delete(winId);
  useTermViews.setState((st) => {
    const { [winId]: _gone, ...rest } = st.byId;
    return { byId: rest };
  });
}

// Окно терминала исчезло из раскладки — сессия больше никому не нужна.
useLayout.subscribe((state) => {
  for (const winId of [...sessions.keys()]) {
    if (!findWindow(state.layout, winId)) dropSession(winId);
  }
});

// Сменилась тема — xterm рисует сам, CSS-переменные до него не доходят.
export function applyTermTheme(): void {
  const { fontFamily, theme } = themeFromTokens();
  for (const s of sessions.values()) {
    s.term.options.fontFamily = fontFamily;
    s.term.options.theme = theme;
  }
}

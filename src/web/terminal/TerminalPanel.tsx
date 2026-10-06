import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import type { TerminalErrorReason, TerminalEvent } from '../../shared/types';
import { useStore } from '../store';
import { t } from '../i18n';
import { Icon } from '../icons';
import { onTermDisconnect, sendTerm, subscribeTerm } from './terminalBus';

/**
 * Панель встроенного терминала: вкладки, у каждой свой xterm, заголовок с
 * папкой из `term.opened`, кнопки «свернуть» и «закрыть». Доставка команд и
 * событий — `terminalBus.ts`; здесь вкладки, раскладка и подгонка сетки.
 *
 * Экземпляры xterm лежат вне состояния React, в `sessions`: это живые
 * объекты с DOM, их нельзя ни копировать, ни сравнивать. В состоянии — только
 * то, что нужно для отрисовки.
 */

type TabStatus = 'opening' | 'live' | 'exited' | 'error';

interface TabView {
  /** Ключ вкладки на клиенте, он же `nonce` запроса на открытие. */
  key: string;
  status: TabStatus;
  /** Рабочая папка из `term.opened`. */
  cwd: string | null;
  /** Понятный текст отказа или обрыва; показывается поверх буфера. */
  error: string | null;
}

/** Живая часть вкладки. */
interface Session {
  term: Terminal;
  fit: FitAddon;
  /** Постоянный узел xterm: контейнер вкладки переносит его к себе, а не создаёт заново. */
  host: HTMLDivElement;
  opened: boolean;
  /** Номер терминала на сервере; до `term.opened` его нет. */
  id: string | null;
  status: TabStatus;
  /** Отписки от шины: по `nonce` и, после открытия, по `id`. */
  unsubs: Array<() => void>;
}

const MIN_HEIGHT = 140;
const DEFAULT_HEIGHT = 300;
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

/** Подпись вкладки: последняя папка пути, пока пути нет — номер. */
function tabName(tab: TabView, i: number): string {
  const base = tab.cwd?.split(/[\\/]/).filter(Boolean).pop();
  return base || t('terminal.tab', { n: i + 1 });
}

export function TerminalPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tabs, setTabs] = useState<TabView[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const sessions = useRef(new Map<string, Session>());
  const theme = useStore((s) => s.theme);

  const patchTab = useCallback((key: string, patch: Partial<TabView>) => {
    setTabs((list) => list.map((tab) => (tab.key === key ? { ...tab, ...patch } : tab)));
  }, []);

  /** Новая вкладка: создаёт xterm и просит сервер открыть оболочку. */
  const newTab = useCallback(() => {
    const key = `tt${Date.now().toString(36)}${++seq}`;
    const { fontFamily, theme } = themeFromTokens();
    const term = new Terminal({ cols: 80, rows: 24, fontFamily, fontSize: 12, theme, cursorBlink: true, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const host = document.createElement('div');
    host.className = 'term-xterm';
    const s: Session = { term, fit, host, opened: false, id: null, status: 'opening', unsubs: [] };
    sessions.current.set(key, s);

    const setStatus = (status: TabStatus, patch: Partial<TabView> = {}) => {
      s.status = status;
      patchTab(key, { status, ...patch });
    };

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
          // Пока ждали ответ, сетку могли подогнать под панель — сервер должен
          // узнать настоящий размер, а не 80×24 из запроса.
          fitSession(s);
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

    setTabs((list) => [...list, { key, status: 'opening', cwd: null, error: null }]);
    setActive(key);
    setMinimized(false);
    if (!sendTerm({ c: 'term_open', nonce: key, cols: term.cols, rows: term.rows })) {
      setStatus('error', { error: t('terminal.error.offline') });
    }
  }, [patchTab]);

  /** Убрать вкладку: серверу `term_close`, xterm — в утиль. */
  const dropSession = useCallback((key: string) => {
    const s = sessions.current.get(key);
    if (!s) return;
    if (s.id && s.status === 'live') sendTerm({ c: 'term_close', id: s.id });
    for (const unsub of s.unsubs) unsub();
    s.term.dispose();
    sessions.current.delete(key);
  }, []);

  const closeTab = useCallback((key: string) => {
    dropSession(key);
    const i = tabs.findIndex((x) => x.key === key);
    const rest = tabs.filter((x) => x.key !== key);
    setTabs(rest);
    if (active === key) setActive(rest[Math.min(i, rest.length - 1)]?.key ?? null);
    // Закрыли последнюю — панель уходит вместе с ней.
    if (rest.length === 0) onClose();
  }, [tabs, active, dropSession, onClose]);

  /** Закрыть панель целиком: все терминалы закрываются на сервере. */
  const closeAll = useCallback(() => {
    for (const key of [...sessions.current.keys()]) dropSession(key);
    setTabs([]);
    setActive(null);
    setMinimized(false);
    onClose();
  }, [dropSession, onClose]);

  // Открыли пустую панель — сразу первая вкладка.
  useEffect(() => {
    if (open && sessions.current.size === 0) newTab();
  }, [open, newTab]);

  // Панель ушла со страницы — терминалы на сервере больше никому не нужны.
  // Вкладки чистятся тоже: StrictMode монтирует эффекты дважды, и без этого
  // осталась бы вкладка без xterm.
  useEffect(() => () => {
    for (const key of [...sessions.current.keys()]) dropSession(key);
    setTabs([]);
    setActive(null);
  }, [dropSession]);

  // Сменилась тема — xterm рисует сам, CSS-переменные до него не доходят.
  useEffect(() => {
    const { fontFamily, theme: colors } = themeFromTokens();
    for (const s of sessions.current.values()) {
      s.term.options.fontFamily = fontFamily;
      s.term.options.theme = colors;
    }
  }, [theme]);

  // Перетаскивание верхней кромки: высота считается от низа окна.
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => {
      const max = Math.max(MIN_HEIGHT, window.innerHeight - 120);
      setHeight(Math.round(Math.min(max, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const current = tabs.find((x) => x.key === active) ?? null;

  return (
    <section className={`term-panel${minimized ? ' minimized' : ''}`} hidden={!open}
      style={minimized ? undefined : { height }} aria-label={t('terminal.title')}>
      {!minimized && <div className="term-grip" onPointerDown={onDragStart} title={t('terminal.resize')} />}
      <header className="term-head">
        <div className="term-tabs" role="tablist">
          {tabs.map((tab, i) => (
            <div key={tab.key} role="tab" aria-selected={tab.key === active}
              className={`term-tab${tab.key === active ? ' on' : ''} ${tab.status}`}
              onClick={() => { setActive(tab.key); setMinimized(false); }}>
              <span className="term-tab-dot" />
              <span className="term-tab-name">{tabName(tab, i)}</span>
              <button className="term-tab-x" title={t('terminal.closeTab')}
                onClick={(e) => { e.stopPropagation(); closeTab(tab.key); }}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          <button className="term-icon" onClick={newTab} title={t('terminal.newTab')}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        <span className="term-cwd" title={current?.cwd ?? ''}>
          {current?.cwd ?? (current?.status === 'opening' ? t('terminal.opening') : '')}
        </span>
        <div className="term-actions">
          <button className="term-icon" onClick={() => setMinimized(!minimized)}
            title={t(minimized ? 'terminal.expand' : 'terminal.minimize')}>
            <Icon name={minimized ? 'chevron-up' : 'minus'} size={14} />
          </button>
          <button className="term-icon" onClick={closeAll} title={t('terminal.close')}>
            <Icon name="x" size={14} />
          </button>
        </div>
      </header>
      {/* Свёрнутая панель не размонтирует вкладки: буферы xterm живут в
          постоянных узлах, а тело просто прячется. */}
      <div className="term-body" hidden={minimized}>
        {tabs.map((tab) => (
          <TabPane key={tab.key} tab={tab} session={sessions.current.get(tab.key)}
            visible={open && !minimized && tab.key === active} />
        ))}
      </div>
    </section>
  );
}

/** Подогнать сетку xterm под контейнер; новый размер уйдёт серверу через `onResize`. */
function fitSession(s: Session): void {
  if (!s.opened || !s.host.isConnected || s.host.clientWidth === 0 || s.host.clientHeight === 0) return;
  s.fit.fit();
}

function TabPane({ tab, session, visible }: { tab: TabView; session: Session | undefined; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  // Посадить постоянный узел xterm в свой контейнер. `open` у xterm зовётся
  // один раз — когда узел уже в документе, иначе ему нечем мерить символы.
  useEffect(() => {
    const el = ref.current;
    if (!el || !session) return;
    if (session.host.parentElement !== el) el.appendChild(session.host);
    if (!session.opened) {
      session.term.open(session.host);
      session.opened = true;
    }
  }, [session]);

  // Любая смена размера контейнера — перетаскивание кромки, окно, рейл —
  // подгоняет сетку; новый cols×rows уходит серверу через onResize xterm.
  useEffect(() => {
    const el = ref.current;
    if (!el || !session || !visible) return;
    fitSession(session);
    session.term.focus();
    const ro = new ResizeObserver(() => fitSession(session));
    ro.observe(el);
    return () => ro.disconnect();
  }, [session, visible]);

  return (
    <div className="term-view" hidden={!visible}>
      <div className="term-host" ref={ref} />
      {(tab.status === 'error' || tab.status === 'exited') && (
        <div className={`term-note ${tab.status}`} role={tab.status === 'error' ? 'alert' : 'status'}>
          <Icon name={tab.status === 'error' ? 'alert-triangle' : 'circle-x'} size={16} />
          <div>
            {(tab.error ?? t('terminal.ended')).split('\n').map((line, i) => (
              <p key={i} className={i ? 'term-note-detail' : ''}>{line}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

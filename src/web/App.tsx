import { useEffect, useRef, useState } from 'react';
import { Office } from './Office';
import { PermissionModal } from './PermissionModal';
import { TeamPanel } from './TeamPanel';
import { Board } from './Board';
import { MeetingModal } from './MeetingModal';
import { SettingsModal } from './SettingsModal';
import { connect, mergeTask, reset, send, useStore } from './store';
import type { TaskStatus } from '../shared/types';

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'бэклог', assigned: 'назначена', in_progress: 'в работе',
  review: 'на проверке', blocked: 'заблокирована', done: 'готово', failed: 'провал',
};

export function App() {
  const connected = useStore((s) => s.connected);
  const busy = useStore((s) => s.busy);
  const projectDir = useStore((s) => s.projectDir);
  const tasks = useStore((s) => s.tasks);
  const chat = useStore((s) => s.chat);
  const log = useStore((s) => s.log);
  const instances = useStore((s) => s.instances);
  const selected = useStore((s) => s.selected);
  const pending = useStore((s) => s.permissions.length);
  const [tab, setTab] = useState<'chat' | 'log'>('chat');
  const [showSettings, setShowSettings] = useState(false);
  const [showMeeting, setShowMeeting] = useState(false);
  const meeting = useStore((s) => s.meeting);
  const settings = useStore((s) => s.settings);
  const thread = useStore((s) => s.thread);
  const setThread = useStore((s) => s.setThread);
  const authSource = useStore((s) => s.authSource);
  const [draft, setDraft] = useState('');
  const chatEnd = useRef<HTMLDivElement>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => { connect(); }, []);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat.length]);
  useEffect(() => { logEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [log.length, tab]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    send(text);
    setDraft('');
  };

  const totalCost = Object.values(instances).reduce((sum, i) => sum + i.costUsd, 0);
  const visibleLog = selected ? log.filter((l) => l.agentId === selected) : log;
  const taskList = Object.values(tasks).sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div className="app">
      <PermissionModal />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showMeeting && <MeetingModal onClose={() => setShowMeeting(false)} />}
      <header>
        <h1>🏢 AI Office <span className="muted">MVP-0</span></h1>
        <div className="head-meta">
          <span className="muted mono">{projectDir}</span>
          <button
            className={`cost ${settings.globalBudgetUsd !== null && totalCost >= settings.globalBudgetUsd ? 'over' : ''}`}
            onClick={() => setShowSettings(true)}
            title="Бюджет офиса"
          >
            ${totalCost.toFixed(3)}
            {settings.globalBudgetUsd !== null && ` / $${settings.globalBudgetUsd.toFixed(2)}`}
          </button>
          <span
            className={`auth ${authSource}`}
            title={authSource === 'api-key'
              ? 'Задан ANTHROPIC_API_KEY — расход идёт в платный API, а не в подписку'
              : 'Работает на авторизации Claude Code — расход идёт в лимиты подписки'}
          >
            {authSource === 'api-key' ? '💳 API' : '🔑 подписка'}
          </span>
          <span className={`dot ${connected ? 'on' : 'off'}`} />
          {pending > 0 && <span className="ask-pill">ждут решения: {pending}</span>}
          {busy && <span className="working-pill">команда работает…</span>}
          <button onClick={() => setShowMeeting(true)}>Совещание</button>
          <button onClick={reset}>Сброс</button>
        </div>
      </header>

      <main>
        <section className="left">
          <Office />
          <TeamPanel />
          <Board />
        </section>

        <section className="right">
          <div className="tabs">
            <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
              {thread === 'pm#1' ? 'Чат с PM' : `Чат: ${instances[thread]?.label ?? thread}`}
            </button>
            <button
              className={thread === 'meeting' ? 'on' : ''}
              onClick={() => { setTab('chat'); setThread('meeting'); }}
            >
              Совещание{meeting?.status === 'running' ? ' •' : ''}
            </button>
            <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>
              Лог{selected ? ` · ${selected}` : ''}
            </button>
          </div>

          {tab === 'chat' ? (
            <div className="chat">
              {thread === 'meeting' && (
                <div className="thread-bar">
                  {meeting?.status === 'running'
                    ? <>Идёт совещание{meeting.speaking ? `, говорит ${instances[meeting.speaking]?.label ?? meeting.speaking}` : ''}…</>
                    : <>Переговорка. Участники высказываются по очереди, итог менеджер пишет в своём чате.</>}
                  <button onClick={() => setThread('pm#1')}>К менеджеру</button>
                </div>
              )}
              {thread !== 'pm#1' && thread !== 'meeting' && (
                <div className="thread-bar">
                  Прямой разговор с <b>{instances[thread]?.label ?? thread}</b> — мимо менеджера.
                  Он может смотреть проект, но не менять его.
                  <button onClick={() => setThread('pm#1')}>К менеджеру</button>
                </div>
              )}
              {chat.filter((m) => m.thread === thread).length === 0 && thread === 'pm#1' && (
                <p className="empty">
                  Напишите PM'у, что нужно сделать.<br />
                  Например: «Сделай CRUD для заметок: JSON API на бэке и страницу на фронте».
                </p>
              )}
              {chat.filter((m) => m.thread === thread).map((m) => (
                <div key={m.id} className={`msg ${m.from === 'user' ? 'from-user' : 'from-agent'}`}>
                  <div className="msg-from">{m.from === 'user' ? 'вы' : m.from}</div>
                  <div className="msg-text">{m.text}</div>
                </div>
              ))}
              <div ref={chatEnd} />
            </div>
          ) : (
            <div className="log">
              {visibleLog.map((l) => (
                <div key={l.id} className={`log-row ${l.kind}`}>
                  <span className="log-agent">{l.agentId ?? 'офис'}</span>
                  <span className="log-text">{l.text}</span>
                </div>
              ))}
              <div ref={logEnd} />
            </div>
          )}

          {thread !== 'meeting' && <div className="composer">
            <textarea
              value={draft}
              placeholder={thread === 'pm#1' ? 'Задача для PM…' : `Вопрос — ${instances[thread]?.label ?? thread}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              }}
            />
            <button onClick={submit} disabled={!connected}>Отправить ⌘↵</button>
          </div>}
        </section>
      </main>
    </div>
  );
}

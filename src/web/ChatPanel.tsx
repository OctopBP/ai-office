import { useEffect, useRef, useState } from 'react';
import { Panel } from './Panel';
import { send, useStore } from './store';

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const chat = useStore((s) => s.chat);
  const instances = useStore((s) => s.instances);
  const meeting = useStore((s) => s.meeting);
  const thread = useStore((s) => s.thread);
  const setThread = useStore((s) => s.setThread);
  const connected = useStore((s) => s.connected);
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const shown = chat.filter((m) => m.thread === thread);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [shown.length]);
  useEffect(() => { input.current?.focus(); }, [thread]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    send(text);
    setDraft('');
  };

  const title = thread === 'pm#1' ? 'Чат с менеджером'
    : thread === 'meeting' ? 'Переговорка'
    : `Разговор: ${instances[thread]?.label ?? thread}`;

  return (
    <Panel title={title} onClose={onClose}
      hint={thread === 'pm#1' ? 'ставьте задачу словами — PM разберёт её на части' : undefined}>
      <div className="threads">
        <button className={thread === 'pm#1' ? 'primary' : ''} onClick={() => setThread('pm#1')}>Менеджер</button>
        <button className={thread === 'meeting' ? 'primary' : ''} onClick={() => setThread('meeting')}>
          Переговорка{meeting?.status === 'running' ? ' •' : ''}
        </button>
        {Object.values(instances).filter((i) => i.roleId !== 'pm').map((i) => (
          <button key={i.id} className={thread === i.id ? 'primary' : ''} onClick={() => setThread(i.id)}>
            {i.id}
          </button>
        ))}
      </div>

      {thread === 'meeting' && (
        <p className="muted small note">
          Участники высказываются по очереди, каждый видит сказанное до него.
          Итог менеджер пишет в своём чате.
        </p>
      )}
      {thread !== 'pm#1' && thread !== 'meeting' && (
        <p className="muted small note">
          Разговор напрямую, мимо менеджера. Агент может смотреть проект, но не менять его.
        </p>
      )}

      <div className="chat">
        {shown.length === 0 && (
          <p className="empty">
            {thread === 'pm#1'
              ? 'Например: «Сделай CRUD для заметок: JSON API на бэке и страницу на фронте».'
              : 'Пока пусто.'}
          </p>
        )}
        {shown.map((m) => (
          <div key={m.id} className={`msg ${m.from === 'user' ? 'from-user' : 'from-agent'}`}>
            <div className="msg-from">{m.from === 'user' ? 'вы' : m.from}</div>
            <div className="msg-text">{m.text}</div>
          </div>
        ))}
        <div ref={end} />
      </div>

      {thread !== 'meeting' && (
        <div className="composer">
          <textarea
            ref={input} value={draft} rows={3}
            placeholder={thread === 'pm#1' ? 'Задача для менеджера…' : 'Вопрос агенту…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              e.stopPropagation();
            }}
          />
          <button className="primary" onClick={submit} disabled={!connected}>Отправить ⌘↵</button>
        </div>
      )}
    </Panel>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Panel } from './Panel';
import { isOfficeSender } from '../shared/types';
import { send, useStore } from './store';
import { t } from './i18n';

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

  const title = thread === 'pm#1' ? t('chat.title.pm')
    : thread === 'meeting' ? t('chat.title.meeting')
    : t('chat.title.agent', { who: instances[thread]?.label ?? thread });

  return (
    <Panel title={title} onClose={onClose}
      hint={thread === 'pm#1' ? t('chat.hint.pm') : undefined}>
      <div className="threads">
        <button className={thread === 'pm#1' ? 'primary' : ''} onClick={() => setThread('pm#1')}>
          {t('chat.tab.pm')}
        </button>
        <button className={thread === 'meeting' ? 'primary' : ''} onClick={() => setThread('meeting')}>
          {t('chat.tab.meeting')}{meeting?.status === 'running' ? ' •' : ''}
        </button>
        {Object.values(instances).filter((i) => i.roleId !== 'pm').map((i) => (
          <button key={i.id} className={thread === i.id ? 'primary' : ''} onClick={() => setThread(i.id)}>
            {i.id}
          </button>
        ))}
      </div>

      {thread === 'meeting' && (
        <p className="muted small note">{t('chat.note.meeting')}</p>
      )}
      {thread !== 'pm#1' && thread !== 'meeting' && (
        <p className="muted small note">{t('chat.note.direct')}</p>
      )}

      <div className="chat">
        {shown.length === 0 && (
          <p className="empty">
            {t(thread === 'pm#1' ? 'chat.empty.pm' : 'chat.empty')}
          </p>
        )}
        {shown.map((m) => (
          <div key={m.id} className={`msg ${m.from === 'user' ? 'from-user' : 'from-agent'}`}>
            <div className="msg-from">
              {m.from === 'user'
                ? t('chat.you')
                : (isOfficeSender(m.from) ? t('common.office') : m.from)}
            </div>
            <div className="msg-text">{m.text}</div>
          </div>
        ))}
        <div ref={end} />
      </div>

      {thread !== 'meeting' && (
        <div className="composer">
          <textarea
            ref={input} value={draft} rows={3}
            placeholder={t(thread === 'pm#1' ? 'chat.placeholder.pm' : 'chat.placeholder.agent')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              e.stopPropagation();
            }}
          />
          <button className="primary" onClick={submit} disabled={!connected}>
            {t('chat.send')}
          </button>
        </div>
      )}
    </Panel>
  );
}

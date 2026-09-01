import { useEffect, useRef, useState } from 'react';
import { Panel } from './Panel';
import { ChatThread } from './ChatThread';
import { send, useStore } from './store';
import { t } from './i18n';

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const instances = useStore((s) => s.instances);
  const thread = useStore((s) => s.thread);
  const connected = useStore((s) => s.connected);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);

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
      <ChatThread />

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

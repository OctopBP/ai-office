import { useEffect, useRef } from 'react';
import { isOfficeSender } from '../shared/types';
import { useStore } from './store';
import { t } from './i18n';
import { AgentTag } from './Avatar';

/**
 * Лента чата: вкладки тредов, пояснение к треду и сообщения. Без рамки и
 * без поля ввода — их даёт тот, кто ленту показывает: панель поверх офиса
 * со своим композером или вид «Чат» новой оболочки, где поле ввода — общий
 * композер внизу экрана.
 */
export function ChatThread() {
  const chat = useStore((s) => s.chat);
  const instances = useStore((s) => s.instances);
  const meeting = useStore((s) => s.meeting);
  const thread = useStore((s) => s.thread);
  const setThread = useStore((s) => s.setThread);
  const end = useRef<HTMLDivElement>(null);

  const shown = chat.filter((m) => m.thread === thread);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [shown.length]);

  return (
    <>
      <div className="threads">
        <button className={`mini${thread === 'pm#1' ? ' on' : ''}`} onClick={() => setThread('pm#1')}>
          {t('chat.tab.pm')}
        </button>
        <button className={`mini${thread === 'meeting' ? ' on' : ''}`} onClick={() => setThread('meeting')}>
          {t('chat.tab.meeting')}{meeting?.status === 'running' ? ' •' : ''}
        </button>
        {Object.values(instances).filter((i) => i.roleId !== 'pm').map((i) => (
          <button key={i.id} className={`mini${thread === i.id ? ' on' : ''}`} onClick={() => setThread(i.id)}>
            <AgentTag id={i.id} />
          </button>
        ))}
      </div>

      {thread === 'meeting' && (
        <p className="small note">{t('chat.note.meeting')}</p>
      )}
      {thread !== 'pm#1' && thread !== 'meeting' && (
        <p className="small note">{t('chat.note.direct')}</p>
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
                : (isOfficeSender(m.from) ? t('common.office') : <AgentTag id={m.from} size="sm" />)}
            </div>
            <div className="msg-text">{m.text}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { isOfficeSender, type MeetingView } from '../shared/types';
import { useStore } from './store';
import { Avatar } from './Avatar';
import { displayInstance, roleOfInstance } from './instanceName';
import { locale, t } from './i18n';

/** Когда совещание началось: день и время — совещаний в день бывает несколько. */
const when = (at: number): string =>
  new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Окно совещаний: слева список — от последнего к первому, справа стенограмма
 * выбранного. Открывается по столу переговорки и из рейла.
 *
 * Реплики берутся из общего чата по `meetingId`, а не из отдельного хранилища:
 * чат уже переживает перезапуск, и заводить второй экземпляр тех же строк
 * значило бы однажды получить два разных ответа на вопрос «что сказали».
 * Идущее совещание показывается той же лентой — строки в чат приходят по
 * одной, и лента дописывается сама.
 */
export function MeetingsPanel({ onCall }: { onCall: () => void }) {
  const meetings = useStore((s) => s.meetings);
  const chat = useStore((s) => s.chat);
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);

  const live = meetings.find((m) => m.status === 'running');
  // На открытии — идущее совещание, а без него последнее: за столом обычно
  // спрашивают «о чём говорят сейчас», а не «что было в прошлом месяце».
  const [picked, setPicked] = useState<string | null>(() => (live ?? meetings[meetings.length - 1])?.id ?? null);
  useEffect(() => {
    if (!picked && meetings.length) setPicked((live ?? meetings[meetings.length - 1]).id);
  }, [picked, meetings, live]);

  const current = meetings.find((m) => m.id === picked) ?? null;
  const lines = useMemo(() => chat.filter((c) => c.meetingId === picked), [chat, picked]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lines.length, picked]);

  const who = (id: string): string => id === 'user'
    ? t('chat.you')
    : isOfficeSender(id) ? t('common.office') : displayInstance(id, instances, roles);

  const ordered = [...meetings].reverse();

  if (meetings.length === 0) {
    return (
      <div className="meetings meetings-empty">
        <p className="empty">{t('meetings.empty')}</p>
        <button className="primary" onClick={onCall}>{t('meetings.call')}</button>
      </div>
    );
  }

  return (
    <div className="meetings">
      <div className="meetings-list">
        <button className="dashed" onClick={onCall}>{t('meetings.call')}</button>
        {ordered.map((m) => (
          <button key={m.id} className={`meeting-row${m.id === picked ? ' on' : ''}`} onClick={() => setPicked(m.id)}>
            <span className="meeting-row-topic">{m.topic}</span>
            <span className="meeting-row-meta">
              <Status m={m} />
              <span>{when(m.startedAt)}</span>
            </span>
            <Faces ids={m.participants} />
          </button>
        ))}
      </div>

      <div className="meetings-body">
        {current ? (
          <>
            <div className="meetings-head">
              <div className="meetings-topic">{current.topic}</div>
              <div className="meeting-row-meta">
                <Status m={current} />
                <span>{when(current.startedAt)}</span>
                {current.finishedAt && <span>→ {when(current.finishedAt)}</span>}
                <span>·</span>
                <span>{t('meetings.lines', { n: lines.length })}</span>
              </div>
              <div className="meetings-people">
                {current.participants.map((id) => (
                  <span key={id} className="chip">
                    {instances[id] && <Avatar roleId={instances[id].roleId} instanceId={id} size="sm" />}
                    {who(id)}
                  </span>
                ))}
              </div>
            </div>
            <div className="chat">
              {lines.length === 0 && <p className="empty">{t('meetings.noLines')}</p>}
              {lines.map((m) => (
                <div key={m.id} className={`msg ${m.from === 'user' ? 'from-user' : 'from-agent'}`}>
                  <div className="msg-from">
                    {m.from !== 'user' && !isOfficeSender(m.from) && (
                      <Avatar roleId={instances[m.from]?.roleId ?? roleOfInstance(m.from)} instanceId={m.from} size="sm" className="msg-face" />
                    )}
                    {who(m.from)}
                  </div>
                  <div className="msg-text">{m.text}</div>
                </div>
              ))}
              {current.status === 'running' && current.speaking && (
                <p className="small note meetings-speaking">{t('meetings.speaking', { who: who(current.speaking) })}</p>
              )}
              <div ref={end} />
            </div>
          </>
        ) : (
          <p className="empty">{t('meetings.pick')}</p>
        )}
      </div>
    </div>
  );
}

function Status({ m }: { m: MeetingView }) {
  return (
    <span className={`chip meeting-status ${m.status}`}>
      {m.status === 'running' && <span className="meeting-live-dot" />}
      {t(`meetings.status.${m.status}`)}
    </span>
  );
}

/** Участники в строке списка — только лица: имена есть в стенограмме. */
function Faces({ ids }: { ids: string[] }) {
  const instances = useStore((s) => s.instances);
  return (
    <span className="meeting-faces">
      {ids.map((id) => <Avatar key={id} roleId={instances[id]?.roleId ?? roleOfInstance(id)} instanceId={id} size="sm" />)}
    </span>
  );
}

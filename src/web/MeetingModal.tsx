import { useState } from 'react';
import { callMeeting, useStore } from './store';
import { Avatar } from './Avatar';
import { displayInstance } from './instanceName';
import { t } from './i18n';

export function MeetingModal({ onClose }: { onClose: () => void }) {
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  const [topic, setTopic] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  // Менеджер — такой же участник совещания, как и исполнители: раньше он был
  // скрыт этим фильтром, хотя позвать его на обсуждение темы вполне уместно.
  const candidates = Object.values(instances);
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const busy = candidates.filter((i) => picked.includes(i.id) && i.currentTaskId);
  const canStart = topic.trim().length > 0 && picked.length >= 2 && busy.length === 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{t('meeting.title')}</h3>
        <p className="modal-reason">{t('meeting.note')}</p>

        <label>{t('meeting.topic')}
          <textarea
            rows={3} value={topic} onChange={(e) => setTopic(e.target.value)}
            placeholder={t('meeting.topic.placeholder')}
          />
        </label>

        <label>{t('meeting.participants')} <span className="muted">{t('meeting.atLeastTwo')}</span></label>
        <div className="participants">
          {candidates.map((i) => (
            <label key={i.id} className={`participant ${i.currentTaskId ? 'busy' : ''}`}>
              <input
                type="checkbox" checked={picked.includes(i.id)}
                disabled={Boolean(i.currentTaskId)}
                onChange={() => toggle(i.id)}
              />
              <Avatar roleId={i.roleId} instanceId={i.id} size="sm" />
              {displayInstance(i.id, instances, roles)}
              {i.currentTaskId && (
                <span className="muted"> — {t('meeting.busy', { task: i.currentTaskId })}</span>
              )}
            </label>
          ))}
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="allow" disabled={!canStart}
            onClick={() => { callMeeting(topic.trim(), picked); onClose(); }}
          >
            {t('meeting.start')}
          </button>
        </div>
      </div>
    </div>
  );
}

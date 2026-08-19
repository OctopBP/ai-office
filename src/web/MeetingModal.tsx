import { useState } from 'react';
import { callMeeting, useStore } from './store';

export function MeetingModal({ onClose }: { onClose: () => void }) {
  const instances = useStore((s) => s.instances);
  const [topic, setTopic] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const candidates = Object.values(instances).filter((i) => i.roleId !== 'pm');
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const busy = candidates.filter((i) => picked.includes(i.id) && i.currentTaskId);
  const canStart = topic.trim().length > 0 && picked.length >= 2 && busy.length === 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Созвать совещание</h3>
        <p className="modal-reason">
          Участники высказываются по очереди, каждый видит сказанное до него.
          Итог менеджер напишет в чате с ним.
        </p>

        <label>Тема
          <textarea
            rows={3} value={topic} onChange={(e) => setTopic(e.target.value)}
            placeholder="Например: как хранить заметки, когда их станут тысячи?"
          />
        </label>

        <label>Участники <span className="muted">минимум двое</span></label>
        <div className="participants">
          {candidates.map((i) => (
            <label key={i.id} className={`participant ${i.currentTaskId ? 'busy' : ''}`}>
              <input
                type="checkbox" checked={picked.includes(i.id)}
                disabled={Boolean(i.currentTaskId)}
                onChange={() => toggle(i.id)}
              />
              {i.label}
              {i.currentTaskId && <span className="muted"> — занят {i.currentTaskId}</span>}
            </label>
          ))}
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>Отмена</button>
          <button
            className="allow" disabled={!canStart}
            onClick={() => { callMeeting(topic.trim(), picked); onClose(); }}
          >
            Начать
          </button>
        </div>
      </div>
    </div>
  );
}

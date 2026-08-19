import { useEffect } from 'react';
import { useStore } from './store';
import { GRID } from '../shared/types';
import type { AgentState } from '../shared/types';

const CELL = GRID.cell;

const STATE_ICON: Record<AgentState, string> = {
  idle: '', thinking: '💭', working: '⌨️', walking: '', talking: '💬',
  waiting_approval: '❗', blocked: '⏸', done: '✅', failed: '⚠️',
};

export function Office() {
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  const pos = useStore((s) => s.pos);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);

  const meeting = useStore((s) => s.meeting);

  /**
   * Живость офиса: свободный агент иногда отходит к кулеру и возвращается.
   * Чистая анимация на клиенте — сервер об этом не знает, состояние агента
   * не меняется, событий не порождается.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const st = useStore.getState();
      if (st.meeting?.status === 'running') return;
      const free = Object.values(st.instances).filter(
        (i) => i.state === 'idle' && !i.currentTaskId,
      );
      if (free.length === 0 || Math.random() > 0.3) return;

      const who = free[Math.floor(Math.random() * free.length)];
      const atDesk = st.pos[who.id]?.x === who.desk.x && st.pos[who.id]?.y === who.desk.y;
      if (!atDesk) return;

      useStore.setState((s) => ({
        pos: { ...s.pos, [who.id]: { x: 1.6 + Math.random() * 1.2, y: 11.2 } },
      }));
      setTimeout(() => {
        useStore.setState((s) => {
          const inst = s.instances[who.id];
          // За время прогулки агенту могли дать задачу — тогда он уже занят,
          // и возвращать его анимацией не нужно: позицию задаст другой код.
          if (!inst || inst.currentTaskId) return {};
          return { pos: { ...s.pos, [who.id]: { x: inst.desk.x, y: inst.desk.y } } };
        });
      }, 5000 + Math.random() * 4000);
    }, 7000);
    return () => clearInterval(timer);
  }, []);

  const roleOf = (id: string) => roles.find((r) => r.id === id);
  const list = Object.values(instances);
  const inMeeting = new Set(meeting?.status === 'running' ? meeting.participants : []);

  return (
    <div className="office" style={{ width: GRID.cols * CELL, height: GRID.cells * CELL }}>
      {/* рабочие места */}
      {list.map((inst) => (
        <div
          key={`desk-${inst.id}`}
          className="desk"
          style={{ left: inst.desk.x * CELL, top: inst.desk.y * CELL }}
        >
          <div className="desk-screen" />
        </div>
      ))}

      {/* переговорка и кулер — пока декор, оживают в v2 */}
      <div className="zone meeting" style={{ left: 1.2 * CELL, top: 5.6 * CELL }}>
        <span>переговорка</span>
      </div>
      <div className="zone cooler" style={{ left: 1.2 * CELL, top: 11 * CELL }}>
        <span>кулер</span>
      </div>

      {/* человечки */}
      {list.map((inst) => {
        const role = roleOf(inst.roleId);
        const p = pos[inst.id] ?? { x: inst.desk.x, y: inst.desk.y };
        const icon = STATE_ICON[inst.state];
        const active = inst.state === 'working' || inst.state === 'thinking';
        return (
          <div
            key={inst.id}
            className={`agent ${inst.state} ${selected === inst.id ? 'selected' : ''}` +
              `${inMeeting.has(inst.id) ? ' in-meeting' : ''}`}
            style={{ left: p.x * CELL, top: (p.y + 1) * CELL, borderColor: role?.color }}
            onClick={() => select(selected === inst.id ? null : inst.id)}
            title={inst.label}
          >
            {inst.note && (
              <div className="bubble" style={{ borderColor: role?.color }}>
                {inst.note}
              </div>
            )}
            <div className={`body ${active ? 'active' : ''}`} style={{ background: role?.color }}>
              <span className="face">{role?.emoji}</span>
              {icon && <span className="badge">{icon}</span>}
            </div>
            <div className="name">{inst.id}</div>
          </div>
        );
      })}
    </div>
  );
}

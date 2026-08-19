import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { agentSpriteName, spriteOf } from './sprites';
import { DESKS_ALL } from './desks';
import { GRID } from '../shared/types';
import type { AgentState } from '../shared/types';

const C = GRID.cell;
const px = (tiles: number) => tiles * C;

const STATE_TEXT: Record<AgentState, string> = {
  idle: 'свободен', thinking: 'думает', working: 'работает', walking: 'идёт',
  talking: 'разговор', waiting_approval: 'ждёт разрешения', blocked: 'заблокирован',
  done: 'сдал работу', failed: 'ошибка',
};

const STATE_ICON: Record<AgentState, string> = {
  idle: '', thinking: '💭', working: '⌨️', walking: '', talking: '💬',
  waiting_approval: '❗', blocked: '⏸', done: '✅', failed: '⚠️',
};

/** Неподвижная обстановка комнаты: спрайт и место в тайлах. */
const DECOR: Array<{ img: string; x: number; y: number; z?: number }> = [
  { img: 'board', x: 12.6, y: 0.1 },
  { img: 'logscreen', x: 6.2, y: 0.3 },
  { img: 'clock', x: 17.6, y: 0.5 },
  { img: 'window', x: 19.4, y: 0.4 },
  { img: 'bookshelf', x: 22.2, y: 0.2 },
  { img: 'door', x: 0.1, y: 5.6, z: 3 },
  { img: 'doormat', x: 0.9, y: 7.0 },
  { img: 'poster', x: 9.4, y: 2.4 },
  { img: 'neon_sign', x: 20.4, y: 2.5 },
  { img: 'server_rack', x: 22.2, y: 3.2 },
  { img: 'plant_big', x: 22.4, y: 6.4 },
  { img: 'plant_small', x: 0.4, y: 2.6 },
  { img: 'plant_small', x: 19.0, y: 8.6 },
  // переговорка
  { img: 'rug', x: 0.6, y: 10.6 },
  { img: 'round_table', x: 3.1, y: 11.9 },
  { img: 'chair', x: 3.2, y: 10.8 },
  { img: 'chair', x: 3.2, y: 13.6 },
  { img: 'chair', x: 1.7, y: 12.2 },
  { img: 'chair', x: 4.8, y: 12.2 },
  // кухня
  { img: 'kitchen_tiles', x: 19.0, y: 10.6 },
  { img: 'counter', x: 19.2, y: 12.9 },
  { img: 'fridge', x: 22.6, y: 10.9 },
  { img: 'cooler', x: 21.4, y: 11.2 },
  { img: 'coin', x: 20.2, y: 12.4 },
];

export function Office() {
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  const pos = useStore((s) => s.pos);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const meeting = useStore((s) => s.meeting);
  const theme = useStore((s) => s.theme);
  const tasks = useStore((s) => s.tasks);
  const img = (name: string) => spriteOf(theme, name);
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  /**
   * Комната масштабируется только кратно арту: спрайты нарисованы при
   * SCALE = 3, поэтому 1 и 2/3 дают целое число экранных пикселей на
   * арт-пиксель. Произвольный масштаб замылил бы пиксель-арт.
   */
  useLayoutEffect(() => {
    const fit = () => {
      const box = boxRef.current;
      if (!box) return;
      const fits = box.clientWidth >= px(GRID.cols) && box.clientHeight >= px(GRID.cells);
      setScale(fits ? 1 : 2 / 3);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  /**
   * Живость офиса: свободный агент иногда отходит к кулеру и возвращается.
   * Чистая анимация на клиенте — сервер об этом не знает и событий нет.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      const st = useStore.getState();
      if (st.meeting?.status === 'running') return;
      const free = Object.values(st.instances).filter((i) => i.state === 'idle' && !i.currentTaskId);
      if (free.length === 0 || Math.random() > 0.3) return;

      const who = free[Math.floor(Math.random() * free.length)];
      const at = st.pos[who.id];
      if (!at || at.x !== who.desk.x || at.y !== who.desk.y) return;

      useStore.setState((s) => ({
        pos: { ...s.pos, [who.id]: { x: 20.2 + Math.random() * 1.4, y: 12.6 } },
      }));
      setTimeout(() => {
        useStore.setState((s) => {
          const inst = s.instances[who.id];
          if (!inst || inst.currentTaskId) return {};
          return { pos: { ...s.pos, [who.id]: { x: inst.desk.x, y: inst.desk.y } } };
        });
      }, 5000 + Math.random() * 4000);
    }, 7000);
    return () => clearInterval(timer);
  }, []);

  const list = Object.values(instances);
  const busyDesks = new Set(list.map((i) => i.desk.index));
  const inMeeting = new Set(meeting?.status === 'running' ? meeting.participants : []);
  const roleOf = (id: string) => roles.find((r) => r.id === id);

  return (
    <div
      className="office-box" ref={boxRef}
      style={{ height: px(GRID.cells) * scale }}
    >
    <div
      className="office"
      style={{
        width: px(GRID.cols), height: px(GRID.cells),
        transform: `scale(${scale})`, transformOrigin: 'top left',
      }}
    >
      <img className="layer floor" src={img('floor')} alt="" />
      <img className="layer wall" src={img('wall')} alt="" />

      {DECOR.map((d, i) => (
        <img
          key={`${d.img}-${i}`} className="decor" src={img(d.img)} alt=""
          style={{ left: px(d.x), top: px(d.y), zIndex: d.z ?? 2 }}
        />
      ))}

      {/* свободные рабочие места */}
      {DESKS_ALL.filter((d) => !busyDesks.has(d.index)).map((d) => (
        <div key={`ghost-${d.index}`} className="ghost" style={{ left: px(d.x), top: px(d.y) }}>
          <img src={img('desk_ghost')} alt="" />
          <span>+</span>
        </div>
      ))}

      {/* столы: занятые и свободные места */}
      {[...busyDesks].map((index) => {
        const inst = list.find((i) => i.desk.index === index)!;
        const isPm = inst.roleId === 'pm';
        return (
          <img
            key={`desk-${index}`} className="desk-img"
            src={img(isPm ? 'desk_pm' : 'desk')} alt=""
            style={{ left: px(inst.desk.x), top: px(inst.desk.y), zIndex: 4 }}
          />
        );
      })}

      {/* таблички с кодом задачи на столах */}
      {list.filter((i) => i.currentTaskId).map((inst) => (
        <div
          key={`plate-${inst.id}`} className="plate"
          style={{ left: px(inst.desk.x) + C * 0.45, top: px(inst.desk.y) + C * 0.86 }}
        >
          {inst.currentTaskId}
        </div>
      ))}

      {/* человечки: за своим столом рисуются позади него, в проходе — поверх */}
      {list.map((inst) => {
        const p = pos[inst.id] ?? { x: inst.desk.x, y: inst.desk.y };
        const atDesk = p.x === inst.desk.x && p.y === inst.desk.y;
        const role = roleOf(inst.roleId);
        const icon = STATE_ICON[inst.state];
        const busy = inst.state === 'working' || inst.state === 'thinking';
        return (
          <div
            key={inst.id}
            className={`agent ${inst.state}${selected === inst.id ? ' selected' : ''}` +
              `${inMeeting.has(inst.id) ? ' in-meeting' : ''}${busy ? ' busy' : ''}`}
            style={{
              left: px(p.x) + (atDesk ? C * 0.55 : 0),
              top: px(p.y) - (atDesk ? C * 0.75 : 0),
              zIndex: atDesk ? 3 : 6,
            }}
            onClick={() => select(selected === inst.id ? null : inst.id)}
            title={inst.label}
          >
            <img className="shadow" src={img('shadow')} alt="" />
            <img className="body" src={img(agentSpriteName(inst.roleId, inst.id))} alt="" />
            {icon && <span className="badge">{icon}</span>}
          </div>
        );
      })}

      {/* подписи и реплики поверх мебели */}
      {list.map((inst) => {
        const p = pos[inst.id] ?? { x: inst.desk.x, y: inst.desk.y };
        const atDesk = p.x === inst.desk.x && p.y === inst.desk.y;
        const role = roleOf(inst.roleId);
        const task = inst.currentTaskId ? tasks[inst.currentTaskId] : null;
        const icon = STATE_ICON[inst.state];
        return (
          <div
            key={`tag-${inst.id}`} className="tags"
            style={{
              left: px(p.x) + (atDesk ? C * 0.55 : 0),
              top: px(p.y) - (atDesk ? C * 0.75 : 0),
            }}
          >
            {inst.note && inst.state !== 'idle' && <div className="bubble">{inst.note}</div>}
            <div className="statuscard pixel">
              <div className="line1">
                <b>{inst.id}</b>
                <span className="muted"> · {STATE_TEXT[inst.state]}</span>
                {icon && <span className="ico"> {icon}</span>}
              </div>
              <div className="line2 muted">
                {task ? `${task.id} · ${task.title}` : role?.title}
              </div>
            </div>
          </div>
        );
      })}
    </div>
    </div>
  );
}

import { useLayoutEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { agentSpriteName, spriteOf } from './sprites';
import { DESKS_ALL } from './desks';
import { GRID } from '../shared/types';
import type { AgentState } from '../shared/types';

const C = GRID.cell;
const px = (tiles: number) => tiles * C;

const STATE_TEXT: Record<AgentState, string> = {
  idle: 'свободен', thinking: 'думает', working: 'работает', walking: 'идёт',
  talking: 'разговор', waiting_approval: 'ждёт разрешения', paused: 'на паузе',
  blocked: 'заблокирован', done: 'сдал работу', failed: 'ошибка',
};

const STATE_ICON: Record<AgentState, string> = {
  idle: '', thinking: '💭', working: '⌨️', walking: '', talking: '💬',
  waiting_approval: '❗', paused: '⏸', blocked: '⏳', done: '✅', failed: '⚠️',
};

/** Неподвижная обстановка комнаты: спрайт, место в тайлах и необязательный масштаб. */
const DECOR: Array<{ img: string; x: number; y: number; z?: number; scale?: number }> = [
  { img: 'clock', x: 17.6, y: 0.5 },
  { img: 'window', x: 19.4, y: 0.4 },
  { img: 'bookshelf', x: 22.2, y: 0.2 },
  { img: 'doormat', x: 0.9, y: 7.0 },
  { img: 'poster', x: 9.4, y: 2.4 },
  { img: 'neon_sign', x: 20.4, y: 2.5 },
  { img: 'server_rack', x: 22.2, y: 3.2 },
  { img: 'plant_big', x: 22.4, y: 6.4 },
  { img: 'plant_small', x: 0.4, y: 2.6 },
  { img: 'plant_small', x: 19.0, y: 8.6 },
  // переговорка — стол расширен под переменное число участников совещания,
  // сами места (см. meetingSeats.ts) считаются отдельно от этой картинки
  { img: 'rug', x: 0.4, y: 10.0, scale: 1.2 },
  { img: 'round_table', x: 2.7, y: 11.1, scale: 1.6 },
  { img: 'chair', x: 3.8, y: 10.7 },
  { img: 'chair', x: 5.3, y: 11.3 },
  { img: 'chair', x: 5.3, y: 12.3 },
  { img: 'chair', x: 3.8, y: 12.8 },
  { img: 'chair', x: 2.2, y: 12.3 },
  { img: 'chair', x: 2.2, y: 11.3 },
  // кухня — зона отдыха для свободных агентов, места считаются динамически
  // от штата (см. KITCHEN_SEATS в desks.ts), здесь только неподвижная обстановка
  { img: 'kitchen_tiles', x: 19.0, y: 10.6 },
  { img: 'fridge', x: 22.6, y: 10.9 },
  { img: 'cooler', x: 21.4, y: 11.2 },
  { img: 'counter', x: 19.2, y: 12.9 },
  { img: 'coin', x: 20.2, y: 12.4 },
  // второй стол в свободном углу кухни — с ростом штата один стол уже не
  // читается как кухня, а зона отдыха стала просторнее
  { img: 'round_table', x: 19.15, y: 10.8, scale: 0.8 },
  { img: 'chair', x: 19.2, y: 11.95 },
  { img: 'chair', x: 20.2, y: 11.95 },
  { img: 'round_table', x: 20.9, y: 13.4 },
  { img: 'chair', x: 19.6, y: 13.0 },
  { img: 'chair', x: 22.2, y: 13.0 },
  { img: 'chair', x: 20.1, y: 14.4 },
  { img: 'chair', x: 21.9, y: 14.4 },
];

/** Предметы на стене, которые открывают панели: доска задач и терминал лога. */
const HOTSPOTS = [
  { img: 'board', x: 12.6, y: 0.1, key: 'B', panel: 'board' as const, title: 'Доска задач — B' },
  { img: 'logscreen', x: 6.2, y: 0.3, key: 'L', panel: 'log' as const, title: 'Лог событий — L' },
];

export function Office({ onOpen, onDoor }: {
  onOpen: (panel: 'board' | 'log') => void;
  onDoor: () => void;
}) {
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
   * Комната растягивается на всю доступную область (.office-box уже не
   * перекрыт HUD и нижней панелью — отступы под них заданы в CSS), но
   * масштабируется только кратно арту: спрайты нарисованы при SCALE = 3,
   * поэтому любой шаг вида k/3 даёт целое число экранных пикселей на
   * арт-пиксель. Произвольный масштаб замылил бы пиксель-арт. Берём
   * наибольший k, при котором комната ещё умещается по обеим осям —
   * так офис заполняет экран без прокрутки и без обрезки.
   */
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => {
      const kByWidth = Math.floor((box.clientWidth * 3) / px(GRID.cols));
      const kByHeight = Math.floor((box.clientHeight * 3) / px(GRID.cells));
      const k = Math.max(1, Math.min(kByWidth, kByHeight));
      setScale(k / 3);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  const list = Object.values(instances);
  const busyDesks = new Set(list.map((i) => i.desk.index));
  const inMeeting = new Set(meeting?.status === 'running' ? meeting.participants : []);
  const roleOf = (id: string) => roles.find((r) => r.id === id);

  return (
    <div className="office-box" ref={boxRef}>
    <div
      className="office"
      style={{
        width: px(GRID.cols), height: px(GRID.cells),
        transform: `scale(${scale})`,
      }}
    >
      <img className="layer floor" src={img('floor')} alt="" />
      <img className="layer wall" src={img('wall')} alt="" />

      {HOTSPOTS.map((h) => {
        const badge = h.panel === 'board'
          ? Object.values(tasks).filter((t) => t.status === 'review'
              || (t.status === 'done' && t.branch && !t.merged)).length
          : 0;
        return (
          <button
            key={h.key} className="hotspot" title={h.title}
            style={{ left: px(h.x), top: px(h.y), zIndex: 3 }}
            onClick={() => onOpen(h.panel)}
          >
            <img src={img(h.img)} alt="" />
            <span className="hot-key">{h.key}</span>
            {badge > 0 && <span className="hot-badge">{badge}</span>}
          </button>
        );
      })}

      {/* дверь: за ней другие проекты — офис на проект */}
      <button className="hotspot door" title="Офисы и проекты" onClick={onDoor}
        style={{ left: px(0.1), top: px(5.6), zIndex: 3 }}>
        <img src={img('door')} alt="" />
      </button>

      {DECOR.map((d, i) => (
        <img
          key={`${d.img}-${i}`} className="decor" src={img(d.img)} alt=""
          style={{
            left: px(d.x), top: px(d.y), zIndex: d.z ?? 2,
            ...(d.scale ? { transform: `scale(${d.scale})`, transformOrigin: 'top left' } : {}),
          }}
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

import { useLayoutEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { agentSpriteName, spriteOf } from './sprites';
import { catalog, furnitureZ, roomFor, spriteSize } from './layoutData';
import { deskPoint } from '../shared/layout';
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
  const layoutId = useStore((s) => s.settings.layoutId);
  const room = roomFor(layoutId);
  const img = (name: string) => spriteOf(theme, name);
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [roomCols, roomCells] = room.layout.size;

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
      const kByWidth = Math.floor((box.clientWidth * 3) / px(roomCols));
      const kByHeight = Math.floor((box.clientHeight * 3) / px(roomCells));
      const k = Math.max(1, Math.min(kByWidth, kByHeight));
      setScale(k / 3);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [roomCols, roomCells]);

  const list = Object.values(instances);
  const busyDesks = new Set(list.map((i) => i.desk.index));
  const inMeeting = new Set(meeting?.status === 'running' ? meeting.participants : []);
  const roleOf = (id: string) => roles.find((r) => r.id === id);

  return (
    <div className="office-box" ref={boxRef}>
    <div
      className="office"
      style={{
        width: px(roomCols), height: px(roomCells),
        transform: `scale(${scale})`,
      }}
    >
      {room.floorTiles.length > 0 ? (
        room.floorTiles.map((t) => (
          <img
            key={`floor-${t.x}-${t.y}`} className="floor-tile" src={img(t.sprite)} alt=""
            style={{ left: px(t.x), top: px(t.y) }}
          />
        ))
      ) : (
        <img className="layer floor" src={img('floor')} alt="" />
      )}

      {room.wallTiles.length > 0 ? (
        room.wallTiles.map((t) => (
          <img
            key={t.key} className="decor" src={img(t.sprite)} alt=""
            style={{ left: px(t.x), top: px(t.y), zIndex: t.z }}
          />
        ))
      ) : (
        <img className="layer wall" src={img('wall')} alt="" />
      )}

      {room.hotspots.map((h) => {
        const badge = h.panel === 'board'
          ? Object.values(tasks).filter((t) => t.status === 'review'
              || (t.status === 'done' && t.branch && !t.merged)).length
          : 0;
        return (
          <button
            key={h.key} className="hotspot" title={h.title}
            style={{ left: px(h.at[0]), top: px(h.at[1]), zIndex: 900 }}
            onClick={() => onOpen(h.panel)}
          >
            <img src={img(h.sprite)} alt="" />
            <span className="hot-key">{h.key}</span>
            {badge > 0 && <span className="hot-badge">{badge}</span>}
          </button>
        );
      })}

      {/* дверь: за ней другие проекты — офис на проект */}
      <button className="hotspot door" title={room.entrance.title} onClick={onDoor}
        style={{ left: px(room.entrance.at![0]), top: px(room.entrance.at![1]), zIndex: room.doorZ }}>
        <img src={img(room.entrance.sprite!)} alt="" />
      </button>

      {room.placedProps.map((p) => (
        <img
          key={p.key} className="decor" src={img(p.sprite)} alt=""
          style={{
            left: px(p.x), top: px(p.y), zIndex: p.z,
            ...(p.scale ? { transform: `scale(${p.scale})`, transformOrigin: 'top left' } : {}),
          }}
        />
      ))}

      {/* свободные рабочие места: сам стол уже нарисован как предмет из
          room.placedProps — здесь только «призрак»-подсказка поверх пустующих */}
      {room.allDesks.filter((d) => !busyDesks.has(d.index)).map((d) => (
        <div
          key={`ghost-${d.index}`} className="ghost"
          style={{ left: px(d.x), top: px(d.y), zIndex: furnitureZ(d.x, d.y, 'desk_ghost') }}
        >
          <img src={img('desk_ghost')} alt="" />
          <span>+</span>
        </div>
      ))}

      {/* таблички с кодом задачи на столах */}
      {list.filter((i) => i.currentTaskId).map((inst) => {
        const plate = deskPoint(room.layout, catalog, inst.desk.index, 'plate');
        return (
          <div
            key={`plate-${inst.id}`} className="plate"
            style={{ left: px(plate.x), top: px(plate.y) }}
          >
            {inst.currentTaskId}
          </div>
        );
      })}

      {/* человечки: за своим столом рисуются позади него, в проходе — поверх (y-сортировка, спека §5) */}
      {list.map((inst) => {
        const p = pos[inst.id] ?? { x: inst.desk.x, y: inst.desk.y };
        const atDesk = p.x === inst.desk.x && p.y === inst.desk.y;
        const work = atDesk ? deskPoint(room.layout, catalog, inst.desk.index, 'work') : p;
        const role = roleOf(inst.roleId);
        const icon = STATE_ICON[inst.state];
        const busy = inst.state === 'working' || inst.state === 'thinking';
        const [, agentH] = spriteSize(agentSpriteName(inst.roleId, inst.id));
        return (
          <div
            key={inst.id}
            className={`agent ${inst.state}${selected === inst.id ? ' selected' : ''}` +
              `${inMeeting.has(inst.id) ? ' in-meeting' : ''}${busy ? ' busy' : ''}`}
            style={{
              left: px(work.x),
              top: px(work.y),
              zIndex: 100 + Math.round((work.y + agentH) * 10),
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
        const work = atDesk ? deskPoint(room.layout, catalog, inst.desk.index, 'work') : p;
        const role = roleOf(inst.roleId);
        const task = inst.currentTaskId ? tasks[inst.currentTaskId] : null;
        const icon = STATE_ICON[inst.state];
        return (
          <div
            key={`tag-${inst.id}`} className="tags"
            style={{ left: px(work.x), top: px(work.y) }}
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

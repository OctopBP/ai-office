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

// --- Планировка комнаты: данные, не код (docs/design/office-layout/spec.md §3, §5) ---

interface CatalogSprite { size: [number, number] }
interface Catalog { version: number; tile: number; scale: number; sprites: Record<string, CatalogSprite> }

interface LayoutProp { sprite: string; at: [number, number]; scale?: number; id?: string }
interface LayoutZone { kind: string; at?: [number, number]; sprite?: string; title?: string }
interface LayoutHotspot { panel: 'board' | 'log'; sprite: string; at: [number, number]; key: string; title: string }
interface Layout {
  version: number; id: string; title: string; size: [number, number];
  props: LayoutProp[]; zones: LayoutZone[]; hotspots: LayoutHotspot[];
}

// Как и спрайты (sprites.ts), каталог и раскладка читаются прямо из design/ —
// на этом этапе сервер их вебу ещё не отдаёт (§8 — задача следующего этапа).
const catalogModules = import.meta.glob('../../design/sprites/out/catalog.json', {
  eager: true, import: 'default',
}) as Record<string, Catalog>;
const catalog = Object.values(catalogModules)[0];

const layoutModules = import.meta.glob('../../design/layouts/classic.json', {
  eager: true, import: 'default',
}) as Record<string, Layout>;
const layout = Object.values(layoutModules)[0];

function spriteSize(name: string): [number, number] {
  return catalog.sprites[name]?.size ?? [1, 1];
}

/** Порядок отрисовки мебели вместо ручных zIndex (спека §5): чем ниже нижняя кромка спрайта, тем позже рисуем. */
function furnitureZ(x: number, y: number, sprite: string): number {
  const [, h] = spriteSize(sprite);
  return 100 + Math.round((y + h) * 10);
}

interface RenderProp { key: string; sprite: string; x: number; y: number; scale?: number; z: number }

function bbox(x: number, y: number, sprite: string) {
  const [w, h] = spriteSize(sprite);
  return { x0: x, y0: y, x1: x + w, y1: y + h };
}

/**
 * Предметы, накрытые другой мебелью (кофемашина на тумбе, кружки на столе):
 * своя высота у них меньше, чем у мебели под ними, поэтому чистый y-сорт
 * задвинул бы их назад. Если bbox предмета целиком внутри чужого — рисуем
 * его следом за этим предметом, а не по формуле.
 */
function liftToppings(items: RenderProp[]): void {
  for (const item of items) {
    const ib = bbox(item.x, item.y, item.sprite);
    for (const host of items) {
      if (host === item) continue;
      const hb = bbox(host.x, host.y, host.sprite);
      const inside = ib.x0 >= hb.x0 && ib.x1 <= hb.x1 && ib.y0 >= hb.y0 && ib.y1 <= hb.y1;
      if (inside && item.z <= host.z) item.z = host.z + 1;
    }
  }
}

// Настенное — окна, доска, экран, часы (спека §5): рисуются поверх всей
// мебели и людей, стена от их положения не зависит.
const WALL_MOUNTED = new Set(['clock', 'window', 'board', 'logscreen']);
// Наложения на пол — ковры и плитка: всегда под мебелью, что на них стоит.
const FLOOR_OVERLAY = new Set(['rug', 'kitchen_tiles']);

const PLACED_PROPS: RenderProp[] = (() => {
  const fixed: RenderProp[] = [];
  const sorted: RenderProp[] = [];
  layout.props.forEach((p, i) => {
    const item: RenderProp = {
      key: `${p.sprite}-${i}`, sprite: p.sprite, x: p.at[0], y: p.at[1], scale: p.scale, z: 0,
    };
    if (WALL_MOUNTED.has(p.sprite)) fixed.push({ ...item, z: 900 });
    else if (FLOOR_OVERLAY.has(p.sprite)) fixed.push({ ...item, z: 1 });
    else sorted.push({ ...item, z: furnitureZ(item.x, item.y, item.sprite) });
  });
  liftToppings(sorted);
  return [...fixed, ...sorted];
})();

const ENTRANCE = layout.zones.find((z) => z.kind === 'entrance')!;
const DOOR_Z = furnitureZ(ENTRANCE.at![0], ENTRANCE.at![1], ENTRANCE.sprite!);

// Слот work у стола (человечек стоит правее и выше стола) и слот plate
// (табличка с кодом задачи) — переезжают в каталог со слотами на этапе 1,
// пока те же числа, что были в коде (спека §3.1, Приложение Б).
const DESK_WORK_SLOT = { x: 0.55, y: -0.75 };
const DESK_PLATE_SLOT = { x: 0.45, y: 0.86 };

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

      {layout.hotspots.map((h) => {
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
      <button className="hotspot door" title={ENTRANCE.title} onClick={onDoor}
        style={{ left: px(ENTRANCE.at![0]), top: px(ENTRANCE.at![1]), zIndex: DOOR_Z }}>
        <img src={img(ENTRANCE.sprite!)} alt="" />
      </button>

      {PLACED_PROPS.map((p) => (
        <img
          key={p.key} className="decor" src={img(p.sprite)} alt=""
          style={{
            left: px(p.x), top: px(p.y), zIndex: p.z,
            ...(p.scale ? { transform: `scale(${p.scale})`, transformOrigin: 'top left' } : {}),
          }}
        />
      ))}

      {/* свободные рабочие места */}
      {DESKS_ALL.filter((d) => !busyDesks.has(d.index)).map((d) => (
        <div
          key={`ghost-${d.index}`} className="ghost"
          style={{ left: px(d.x), top: px(d.y), zIndex: furnitureZ(d.x, d.y, 'desk_ghost') }}
        >
          <img src={img('desk_ghost')} alt="" />
          <span>+</span>
        </div>
      ))}

      {/* столы: занятые и свободные места */}
      {[...busyDesks].map((index) => {
        const inst = list.find((i) => i.desk.index === index)!;
        const isPm = inst.roleId === 'pm';
        const sprite = isPm ? 'desk_pm' : 'desk';
        return (
          <img
            key={`desk-${index}`} className="desk-img"
            src={img(sprite)} alt=""
            style={{
              left: px(inst.desk.x), top: px(inst.desk.y),
              zIndex: furnitureZ(inst.desk.x, inst.desk.y, sprite),
            }}
          />
        );
      })}

      {/* таблички с кодом задачи на столах */}
      {list.filter((i) => i.currentTaskId).map((inst) => (
        <div
          key={`plate-${inst.id}`} className="plate"
          style={{
            left: px(inst.desk.x) + C * DESK_PLATE_SLOT.x,
            top: px(inst.desk.y) + C * DESK_PLATE_SLOT.y,
          }}
        >
          {inst.currentTaskId}
        </div>
      ))}

      {/* человечки: за своим столом рисуются позади него, в проходе — поверх (y-сортировка, спека §5) */}
      {list.map((inst) => {
        const p = pos[inst.id] ?? { x: inst.desk.x, y: inst.desk.y };
        const atDesk = p.x === inst.desk.x && p.y === inst.desk.y;
        const role = roleOf(inst.roleId);
        const icon = STATE_ICON[inst.state];
        const busy = inst.state === 'working' || inst.state === 'thinking';
        const slotY = atDesk ? p.y + DESK_WORK_SLOT.y : p.y;
        const [, agentH] = spriteSize(agentSpriteName(inst.roleId, inst.id));
        return (
          <div
            key={inst.id}
            className={`agent ${inst.state}${selected === inst.id ? ' selected' : ''}` +
              `${inMeeting.has(inst.id) ? ' in-meeting' : ''}${busy ? ' busy' : ''}`}
            style={{
              left: px(p.x) + (atDesk ? C * DESK_WORK_SLOT.x : 0),
              top: px(slotY),
              zIndex: 100 + Math.round((slotY + agentH) * 10),
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
              left: px(p.x) + (atDesk ? C * DESK_WORK_SLOT.x : 0),
              top: px(p.y) + (atDesk ? C * DESK_WORK_SLOT.y : 0),
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

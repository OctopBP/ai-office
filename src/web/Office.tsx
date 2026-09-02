import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { endDrag, startDrag, updateDrag, useStore } from './store';
import { agentSpriteName, spriteOf } from './sprites';
import { agentSize, catalog, furnitureZ, roomFor, spriteSize, type HotspotPanel } from './layoutData';
import { deskPoint } from '../shared/layout';
import { GRID } from '../shared/types';
import type { InstanceView } from '../shared/types';
import { STATE_ICON, stateText } from './agentState';
import { t } from './i18n';
import { Icon } from './icons';

const C = GRID.cell;
const px = (tiles: number) => tiles * C;

/**
 * Тень под ногами берёт ширину у самой фигуры, а высоту — по своему аспекту:
 * арт человечка и арт тени рисовались независимо (36×72 против 42×15), и
 * тень шире фигуры выглядела бы лужей вокруг неё.
 */
const SHADOW_ASPECT = spriteSize('shadow')[1] / spriteSize('shadow')[0];

export function Office({ onOpen, onDoor }: {
  onOpen: (panel: HotspotPanel) => void;
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
  const layout = useStore((s) => s.layout);
  const editingLayout = useStore((s) => s.editingLayout);
  const dragItem = useStore((s) => s.dragItem);
  const room = roomFor(layout);
  const img = (name: string) => spriteOf(theme, name);
  const boxRef = useRef<HTMLDivElement>(null);
  const officeRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [roomCols, roomCells] = room.layout.size;

  /**
   * Комната занимает всю доступную область (.office-box — это вся сцена за
   * вычетом полосы под HUD, отступы заданы в CSS): масштаб берётся ровно
   * такой, при котором она упирается в край хотя бы по одной оси, без
   * запаса. Раньше шаг был кратен арту (k/3 — целое число экранных пикселей
   * на арт-пиксель), но округление вниз съедало до трети экрана: комната
   * висела в рамке пустоты. Дробный масштаб пиксель-арт не мылит —
   * `image-rendering: pixelated` (styles/office-sprites.css) масштабирует ближайшим
   * соседом, просто ширина арт-пикселя перестаёт быть одинаковой.
   */
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => {
      const byWidth = box.clientWidth / px(roomCols);
      const byHeight = box.clientHeight / px(roomCells);
      setScale(Math.max(Math.min(byWidth, byHeight), 0.05));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [roomCols, roomCells]);

  /**
   * Пока предмет взят мышью, ведём его за курсором: мировые координаты
   * считаются от рамки `.office` (она и есть система координат сетки —
   * левый верхний угол это [0,0] в тайлах) и делятся на текущий масштаб,
   * потому что сама рамка отрисована через CSS `transform: scale`.
   * Слушатели вешаются на `window`, а не на предмет, — курсор во время
   * перетаскивания обычно уходит за его границы.
   */
  const draggingKey = dragItem?.key ?? null;
  useEffect(() => {
    if (!draggingKey) return;
    const el = officeRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      updateDrag((e.clientX - rect.left) / (C * scale), (e.clientY - rect.top) / (C * scale));
    };
    const onUp = () => endDrag();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [draggingKey, scale]);

  const list = Object.values(instances);
  const busyDesks = new Set(list.map((i) => i.desk.index));
  const inMeeting = new Set(meeting?.status === 'running' ? meeting.participants : []);
  const roleOf = (id: string) => roles.find((r) => r.id === id);

  /** Точка отрисовки агента: если он «дома» за своим столом — нужный отступ
   * внутри клетки (deskPoint), иначе координата его ходьбы как есть.
   * У безместного стола с таким номером в раскладке нет — deskPoint по нему
   * бросил бы и обрушил всю комнату; он просто стоит там, где сказал сервер. */
  const workPointOf = (inst: InstanceView) => {
    const p = pos[inst.id] ?? { x: inst.desk.x, y: inst.desk.y, ms: 0 };
    const atDesk = !inst.deskless && p.x === inst.desk.x && p.y === inst.desk.y;
    return atDesk ? deskPoint(room.layout, catalog, inst.desk.index, 'work') : p;
  };

  const agentEls = useRef<Record<string, HTMLDivElement | null>>({});
  const agentAnims = useRef<Record<string, Animation | undefined>>({});
  const agentRendered = useRef<Record<string, { left: string; top: string }>>({});

  /**
   * Ходьба анимируется Web Animations API вместо CSS-перехода с фиксированной
   * длительностью (§7 спеки docs/design/office-layout/spec.md): длительность
   * берём из `pos[id].ms`, которую посчитал стор по длине отрезка, — скорость
   * постоянная, а не «любое расстояние за 900 мс». Если по агенту ещё не
   * доиграна предыдущая анимация, стартуем новую от его текущей видимой
   * позиции (getComputedStyle), а не от прежней цели, — иначе прерывание пути
   * (новая цель на середине отрезка) дёргало бы спрайт назад, чего не было у
   * CSS-переходов, которые ретаргетятся сами.
   */
  useLayoutEffect(() => {
    list.forEach((inst) => {
      const el = agentEls.current[inst.id];
      if (!el) return;
      const p = pos[inst.id] ?? { x: inst.desk.x, y: inst.desk.y, ms: 0 };
      const work = workPointOf(inst);
      const target = { left: `${px(work.x)}px`, top: `${px(work.y)}px` };
      const prev = agentRendered.current[inst.id];
      if (prev && prev.left === target.left && prev.top === target.top) return;
      const cs = prev ? getComputedStyle(el) : null;
      const from = cs ? { left: cs.left, top: cs.top } : target;
      agentRendered.current[inst.id] = target;
      agentAnims.current[inst.id]?.cancel();
      agentAnims.current[inst.id] = el.animate(
        [from, target],
        { duration: Math.max(1, p.ms), easing: 'linear', fill: 'forwards' },
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, instances, room]);

  return (
    <div className="office-box" ref={boxRef}>
    <div
      className={`office${editingLayout ? ' editing' : ''}`}
      ref={officeRef}
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

      {room.placedProps.map((p) => {
        const dragging = draggingKey === p.key;
        // Во время перетаскивания позиция превью держится в сторе (dragItem),
        // а не в самом предмете — так на отпускании кнопки уходит ровно та
        // точка, которую видел пользователь.
        const x = dragging && dragItem ? dragItem.x : p.x;
        const y = dragging && dragItem ? dragItem.y : p.y;
        const z = dragging ? 9999 : p.z;
        return (
          <img
            key={p.key}
            className={`decor${editingLayout ? ' edit-target' : ''}${dragging ? ' dragging' : ''}`}
            src={img(p.sprite)} alt=""
            // Размер задаётся явно, а не натуральным размером картинки: у
            // предмета может быть свой габарит в тайлах (§3.2, «стол 2×3»),
            // и тогда арт растягивается под него — по каждой оси своим
            // коэффициентом. Тот же габарит уже посчитан для z-порядка и
            // сетки проходимости, так что картинка и сетка не разъезжаются.
            style={{ left: px(x), top: px(y), width: px(p.w), height: px(p.h), zIndex: z }}
            // Поворот тащится вместе с предметом, хотя плоский рендер его и не
            // показывает: правка уходит на сервер целиком, и предмет, который
            // здесь просто подвинули, не должен вставать прямо в трёхмерном.
            onMouseDown={editingLayout ? (e) => { e.preventDefault(); startDrag(p.key, p.x, p.y, p.rot ?? 0); } : undefined}
          />
        );
      })}

      {/* свободные рабочие места: сам стол уже нарисован как предмет из
          room.placedProps — здесь только «призрак»-подсказка поверх пустующих */}
      {room.allDesks.filter((d) => !busyDesks.has(d.index)).map((d) => (
        <div
          key={`ghost-${d.index}`} className="desk-ghost"
          style={{
            left: px(d.x), top: px(d.y), width: px(d.w), height: px(d.h),
            zIndex: furnitureZ(d.y, d.h),
          }}
        >
          <img src={img('desk_ghost')} alt="" />
          <span>+</span>
        </div>
      ))}

      {/* таблички с кодом задачи на столах: у безместного стола нет — вешать
          табличку не на что */}
      {list.filter((i) => i.currentTaskId && !i.deskless).map((inst) => {
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
        const work = workPointOf(inst);
        const role = roleOf(inst.roleId);
        const icon = STATE_ICON[inst.state];
        const busy = inst.state === 'working' || inst.state === 'thinking';
        const spriteName = agentSpriteName(inst.roleId, inst.id, role?.sprite);
        const [agentW, agentH] = spriteSize(spriteName);
        return (
          <div
            key={inst.id}
            ref={(el) => {
              agentEls.current[inst.id] = el;
              if (!el) {
                delete agentAnims.current[inst.id];
                delete agentRendered.current[inst.id];
              }
            }}
            className={`agent ${inst.state}${selected === inst.id ? ' selected' : ''}` +
              `${inMeeting.has(inst.id) ? ' in-meeting' : ''}${busy ? ' busy' : ''}`}
            // Габарит фигуры — из каталога (спрайт 36×72 арт-пикселей, а не
            // 48×72, как рисовалось раньше) с общим AGENT_SCALE. Ширина и
            // высота задаются явно и обе, поэтому картинку не растягивает по
            // одной оси; тень, пузырь и карточка считаются от тех же величин
            // через CSS-переменные, а не от зашитых в стили пикселей.
            style={{
              left: px(work.x),
              top: px(work.y),
              width: px(agentW),
              zIndex: 100 + Math.round((work.y + agentH) * 10),
              ['--agent-w' as string]: `${px(agentW)}px`,
              ['--agent-h' as string]: `${px(agentH)}px`,
            }}
            onClick={() => select(selected === inst.id ? null : inst.id)}
            title={inst.label}
          >
            <img className="shadow" src={img('shadow')} alt="" />
            <img className="body" src={img(spriteName)} alt="" />
            {icon && <span className="badge"><Icon name={icon} size={13} /></span>}
          </div>
        );
      })}

      {/* подписи и реплики поверх мебели */}
      {list.map((inst) => {
        const work = workPointOf(inst);
        const role = roleOf(inst.roleId);
        const task = inst.currentTaskId ? tasks[inst.currentTaskId] : null;
        const icon = STATE_ICON[inst.state];
        const [agentW, agentH] = agentSize(agentSpriteName(inst.roleId, inst.id));
        return (
          <div
            key={`tag-${inst.id}`} className="tags"
            style={{
              left: px(work.x), top: px(work.y), width: px(agentW),
              ['--agent-h' as string]: `${px(agentH)}px`,
            }}
          >
            {inst.note && inst.state !== 'idle' && <div className="bubble">{inst.note}</div>}
            <div className="statuscard float">
              <div className="line1">
                <b>{inst.id}</b>
                <span className="muted"> · {stateText(inst.state)}</span>
                {icon && <span className="ico"> <Icon name={icon} size={12} /></span>}
                {inst.deskless && (
                  <span className="ico" title={t('office.desklessHint')}> <Icon name="armchair" size={12} /></span>
                )}
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

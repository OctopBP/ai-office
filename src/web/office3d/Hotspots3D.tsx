/**
 * Кликабельные предметы комнаты и метки свободных мест.
 *
 * Это последнее, чем плоский офис был богаче трёхмерного: доска задач, экран
 * лога и дверь в список офисов там нажимаются, а здесь до сих пор были просто
 * панелями на стене. Геометрия у них ровно та же, что у остальной обстановки
 * (`PropShape`), — отличается только поведение, поэтому они и живут отдельным
 * файлом, а не флагом внутри `Props3D`.
 */
import { useMemo, useState } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { desks } from '../../shared/layout';
import type { InstanceView } from '../../shared/types';
import { Kbd } from '../Kbd';
import type { Layout } from '../../shared/layout';
import { catalog, type HotspotPanel } from '../layoutData';
import { useStore } from '../store';
import { useInstanceName } from '../instanceName';
import type { Palette } from './palette';
import { PropLamp } from './Lights3D';
import { BoardArt } from './Boards3D';
import { PropShape, usePropMaterials } from './Props3D';
import type { Placed3 } from './props';
import { t } from '../i18n';

/** Кого именно из предметов раскладки нажимают. */
export type SpotKind = HotspotPanel | 'door';

/** Куда ведёт нажатие, кроме двери: панель раскладки или стол переговорки. */
export type SpotTarget = HotspotPanel | 'meeting';

export interface Spot3 {
  kind: SpotKind;
  item: Placed3;
  title: string;
  /** Горячая клавиша, если она у предмета есть — у двери её нет. */
  hotkey?: string;
}

/** Насколько предмет подрастает под курсором. Немного: это подсказка «сюда
 *  можно нажать», а не событие. */
const HOVER_SCALE = 1.06;

/**
 * Один нажимаемый предмет: сам предмет плюс подпись с горячей клавишей и
 * счётчиком.
 *
 * Луч ловит отдельная невидимая коробка вокруг предмета, а не его собственная
 * геометрия. Причина та же, что у агентов: доска висит на стене плоской
 * панелью в пару сантиметров толщиной, и попасть по ней с отдалённой камеры
 * без запаса почти нельзя.
 */
function Spot({ spot, materials, palette, badge, onClick }: {
  spot: Spot3;
  materials: Record<string, THREE.Material>;
  palette: Palette;
  badge: number;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { item } = spot;
  const scale = hovered ? HOVER_SCALE : 1;

  return (
    <group position={[item.cx, item.base, item.cy]} rotation={[0, -item.rot, 0]}>
      <group scale={[scale, scale, scale]}>
        <PropShape item={{ ...item, cx: 0, cy: 0, base: 0 }} materials={materials} />
        {/* Схематичная картинка данных на лицевой стороне — своя у каждой из
            трёх досок. Внутри растущей группы, чтобы она не отставала от
            панели, когда та подрастает под курсором. У двери лица нет. */}
        {spot.kind !== 'door' && (
          <BoardArt kind={spot.kind} item={item} palette={palette} hovered={hovered} />
        )}
      </group>
      {/* Доска и экран лога светятся всегда: это единственные предметы
          комнаты, которые сами что-то показывают, и погашенными они читаются
          как две тёмные панели на стене. Свет вынесен из группы, которую
          раздувает наведение, — иначе бы он дёргался вместе с ней. */}
      <PropLamp item={item} palette={palette} lit />

      <mesh
        position={[0, item.h / 2, 0]}
        onClick={(e: { stopPropagation: () => void }) => { e.stopPropagation(); onClick(); }}
        onPointerOver={(e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = ''; }}
      >
        <boxGeometry args={[Math.max(item.w, 0.7), Math.max(item.h, 0.7), Math.max(item.d, 0.7)]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <Html
        center
        position={[0, item.h / 2 + 0.5, 0]}
        distanceFactor={15}
        zIndexRange={[80, 0]}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        <div className="spot3d" title={spot.title}>
          {spot.hotkey && <Kbd keys={spot.hotkey} />}
          {badge > 0 && <span className="spot3d-badge">{badge}</span>}
        </div>
      </Html>
    </group>
  );
}

/**
 * Метка свободного рабочего места. В плоском офисе это «призрак» стола —
 * полупрозрачный спрайт с плюсом поверх пустующего места; здесь стол и так
 * стоит настоящий, поэтому от метки нужно только сказать, что за ним никто не
 * сидит.
 */
function FreeDesk({ at }: { at: [number, number] }) {
  return (
    <Html
      center
      position={[at[0], 1.4, at[1]]}
      distanceFactor={15}
      zIndexRange={[70, 0]}
      style={{ pointerEvents: 'none', userSelect: 'none' }}
    >
      <div className="spot3d-free" title={t('office.freeDesk')}>+</div>
    </Html>
  );
}

/**
 * Стол переговорки. Сам стол рисует `Props3D` вместе с остальной мебелью —
 * здесь только невидимая мишень над ним и метка: зелёная точка, пока за ним
 * говорят, и подсказка на наведении. В отличие от доски и экрана, стол не
 * светится и не растёт под курсором: он мебель, а не табло.
 */
function MeetingTable({ item, onClick }: { item: Placed3; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const live = useStore((s) => s.meeting?.status === 'running');

  return (
    <group position={[item.cx, item.base, item.cy]} rotation={[0, -item.rot, 0]}>
      <mesh
        position={[0, item.h / 2, 0]}
        onClick={(e: { stopPropagation: () => void }) => { e.stopPropagation(); onClick(); }}
        onPointerOver={(e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = ''; }}
      >
        <boxGeometry args={[item.w, Math.max(item.h, 0.7), item.d]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {(live || hovered) && (
        <Html
          center
          position={[0, item.h + 0.6, 0]}
          distanceFactor={15}
          zIndexRange={[80, 0]}
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          <div className="spot3d" title={t('office.meetingTable')}>
            {live ? <span className="spot3d-live" /> : <kbd>💬</kbd>}
          </div>
        </Html>
      )}
    </group>
  );
}

/**
 * Занятый рабочий стол. Стол с монитором рисует `Props3D`, здесь — мишень над
 * ним: нажатие открывает карточку того, кто за ним сидит, — ту же, что и
 * нажатие на самого человечка. Так по столу видно, чем агент занят, даже
 * когда фигура ушла с камеры или спряталась за спинкой стула.
 *
 * Мишень стола выше самого стола: экран и голова сидящего торчат над
 * столешницей, и клик «по монитору» должен попадать сюда же.
 */
function DeskSpot({ item, who, onClick }: { item: Placed3; who: InstanceView; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const name = useInstanceName(who.id);
  const height = Math.max(item.h, 0.7) + 0.8;

  return (
    <group position={[item.cx, item.base, item.cy]} rotation={[0, -item.rot, 0]}>
      <mesh
        position={[0, height / 2, 0]}
        onClick={(e: { stopPropagation: () => void }) => { e.stopPropagation(); onClick(); }}
        onPointerOver={(e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = ''; }}
      >
        <boxGeometry args={[item.w, height, item.d]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {hovered && (
        <Html
          center
          position={[0, height + 0.4, 0]}
          distanceFactor={15}
          zIndexRange={[80, 0]}
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          <div className="spot3d-desk" title={t('office.deskHint')}>
            <b>{name}</b>{who.note ? ` · ${who.note}` : ''}
          </div>
        </Html>
      )}
    </group>
  );
}

export function Hotspots3D({ spots, meetingTable, deskItems, layout, palette, offset, onOpen, onDoor }: {
  spots: Spot3[];
  /** Стол переговорки, если он в раскладке есть: по нему открывают совещания. */
  meetingTable?: Placed3;
  /** Рабочие столы в порядке `Desk.index` — тем же, что у `desks()`. */
  deskItems: Placed3[];
  layout: Layout;
  palette: Palette;
  /** сдвиг комнаты в мир — тот же, что у пола, стен и обстановки */
  offset: [number, number];
  /** Открыть панель доски, расходов или лога — те же обработчики, что у
   *  плоского офиса: какая панель открыта, знает App, а не комната. */
  onOpen: (target: SpotTarget) => void;
  onDoor: () => void;
}) {
  const materials = usePropMaterials(palette);
  const instances = useStore((s) => s.instances);
  const tasks = useStore((s) => s.tasks);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);

  /**
   * Счётчик на доске — сколько задач ждут решения: сданные на ревью и
   * доделанные, но ещё не влитые. Формула та же, что в плоском офисе: считать
   * её здесь по-своему значило бы завести второй ответ на один вопрос.
   */
  const badge = useMemo(() => Object.values(tasks).filter((t) => t.status === 'review'
    || (t.status === 'done' && t.branch && !t.merged)).length, [tasks]);

  /** Места, за которыми никто не сидит. Безместные сотрудники сюда не
   *  считаются: их `desk.index` — воспоминание о столе, которого сейчас нет. */
  const free = useMemo(() => {
    const busy = new Set(Object.values(instances).filter((i) => !i.deskless).map((i) => i.desk.index));
    return desks(layout, catalog).filter((d) => !busy.has(d.index));
  }, [instances, layout]);

  /** Кто за каким столом — по номеру места, как сажает сервер. */
  const occupied = useMemo(() => {
    const map = new Map<number, InstanceView>();
    for (const i of Object.values(instances)) if (!i.deskless) map.set(i.desk.index, i);
    return map;
  }, [instances]);

  return (
    <group position={[offset[0], 0, offset[1]]}>
      {spots.map((spot) => (
        <Spot
          key={spot.kind}
          spot={spot}
          materials={materials}
          palette={palette}
          badge={spot.kind === 'board' ? badge : 0}
          onClick={() => (spot.kind === 'door' ? onDoor() : onOpen(spot.kind))}
        />
      ))}
      {meetingTable && <MeetingTable item={meetingTable} onClick={() => onOpen('meeting')} />}
      {deskItems.map((item, index) => {
        const who = occupied.get(index);
        if (!who) return null;
        return (
          <DeskSpot
            key={`desk-${index}`} item={item} who={who}
            onClick={() => select(selected === who.id ? null : who.id)}
          />
        );
      })}
      {free.map((d) => (
        <FreeDesk key={`free-${d.index}`} at={[d.x + 1, d.y + 0.7]} />
      ))}
    </group>
  );
}

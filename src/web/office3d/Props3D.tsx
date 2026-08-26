/**
 * Обстановка комнаты: примитивы вместо мебели.
 *
 * Каждый предмет собран из двух-трёх коробок по габаритам из `props.ts`.
 * Это **заглушка с намерением**: цель шага не в том, чтобы нарисовать
 * красивый стол, а в том, чтобы комната встала целиком — с правильными
 * размерами, высотами, поворотами и тем, что на чём стоит, — и чтобы замена
 * на настоящие модели свелась к одной строке на предмет.
 *
 * Шов проходит ровно здесь: `Shape` выбирает, чем рисовать предмет.
 * Когда придут модели, `shape` станет ссылкой на файл, `shapeOf` — загрузкой
 * gltf, а `props.ts`, размещение, повороты и тени останутся как есть.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { endDrag, rotateDrag, startDrag, updateDrag, useStore } from '../store';
import type { Palette } from './palette';
import type { Placed3, Prop3 } from './props';

/** Шаг поворота колесом, градусы. Мелкий намеренно: прямые углы — не
 *  единственное, что бывает нужно, а набрать 90° шестью щелчками недолго. */
const ROT_STEP = 15;

/** Цвет подсветки предмета в редакторе — акцент интерфейса. */
const EDIT_ACCENT = '#f0b429';

/** Толщина столешниц, полок и спинок — одна на всю обстановку. */
const SLAB = 0.12;

type Part = {
  pos: [number, number, number];
  size: [number, number, number];
  tone?: Prop3['tone'];
  /** Круглая деталь: цилиндр по габаритам вместо коробки. */
  round?: true;
};
type Parts = Part[];

/**
 * Из чего состоит предмет. Координаты внутри предмета: начало — центр его
 * следа на полу, `y` вверх от низа предмета. Поворот и сдвиг в комнату
 * делает вызывающий, поэтому здесь предмет всегда «лицом на юг» (+y плана).
 */
function partsOf(item: Placed3): Parts {
  const { w, d, h } = item;

  switch (item.def.shape) {
    case 'desk':
      return [
        // столешница
        { pos: [0, h - SLAB / 2, 0], size: [w, SLAB, d] },
        // тумба сбоку и опора — вместо четырёх ножек, так читаемее издалека
        { pos: [-w / 2 + w * 0.16, (h - SLAB) / 2, 0], size: [w * 0.3, h - SLAB, d * 0.85] },
        { pos: [w / 2 - 0.06, (h - SLAB) / 2, 0], size: [0.1, h - SLAB, d * 0.85], tone: 'metal' },
        // монитор: экран у дальнего края, спиной к тому, кто сидит
        { pos: [w * 0.1, h + 0.42, -d * 0.28], size: [w * 0.42, 0.6, 0.08], tone: 'screen' },
        { pos: [w * 0.1, h + 0.07, -d * 0.28], size: [0.16, 0.14, 0.16], tone: 'metal' },
      ];

    case 'table':
      return [
        { pos: [0, h - SLAB / 2, 0], size: [w, SLAB, d] },
        { pos: [-w / 2 + 0.25, (h - SLAB) / 2, 0], size: [0.14, h - SLAB, d * 0.7], tone: 'metal' },
        { pos: [w / 2 - 0.25, (h - SLAB) / 2, 0], size: [0.14, h - SLAB, d * 0.7], tone: 'metal' },
      ];

    case 'round':
      // Столешница повторяет след предмета, а он у круглого стола не всегда
      // круглый: в раскладке ширина и глубина берутся из арта, нарисованного
      // в перспективе, — эллипс. Так и оставляем: стулья вокруг расставлены
      // по этому же эллипсу, и «исправленный» круг разъехался бы с ними.
      return [
        { pos: [0, h - SLAB / 2, 0], size: [w, SLAB, d], round: true },
        { pos: [0, (h - SLAB) / 2, 0], size: [w * 0.22, h - SLAB, d * 0.22], round: true, tone: 'metal' },
        { pos: [0, 0.03, 0], size: [w * 0.45, 0.06, d * 0.45], round: true, tone: 'metal' },
      ];

    case 'chair':
      return [
        { pos: [0, h * 0.42, 0], size: [w, SLAB, d] },
        // спинка у дальнего края: стул стоит лицом к столу, спинкой от него
        { pos: [0, h * 0.72, -d / 2 + SLAB / 2], size: [w, h * 0.55, SLAB] },
        { pos: [0, h * 0.21, 0], size: [w * 0.25, h * 0.42, d * 0.25], tone: 'metal' },
      ];

    case 'cabinet':
      return [
        { pos: [0, h / 2, 0], size: [w, h, d] },
        // лицевая панель чуть темнее и утоплена — иначе шкаф это просто куб
        { pos: [0, h / 2, d / 2 - 0.02], size: [w * 0.85, h * 0.9, 0.06], tone: 'screen' },
      ];

    case 'appliance':
      return [
        { pos: [0, h / 2, 0], size: [w, h, d] },
        { pos: [0, h * 0.62, d / 2 - 0.02], size: [w * 0.7, 0.06, 0.06], tone: 'screen' },
      ];

    case 'counter':
      return [
        { pos: [0, (h - SLAB) / 2, 0], size: [w, h - SLAB, d] },
        // столешница нависает над тумбой — так кухня читается как кухня
        { pos: [0, h - SLAB / 2, 0], size: [w + 0.08, SLAB, d + 0.08], tone: 'metal' },
      ];

    case 'soft':
      return [
        { pos: [0, h * 0.3, 0], size: [w, h * 0.6, d] },
        { pos: [0, h * 0.62, -d / 2 + 0.16], size: [w, h * 0.75, 0.3] },
        { pos: [-w / 2 + 0.12, h * 0.52, 0], size: [0.22, h * 0.45, d * 0.9] },
        { pos: [w / 2 - 0.12, h * 0.52, 0], size: [0.22, h * 0.45, d * 0.9] },
      ];

    case 'plant':
      return [
        { pos: [0, h * 0.16, 0], size: [w * 0.7, h * 0.32, d * 0.7], tone: 'accent' },
        { pos: [0, h * 0.62, 0], size: [w, h * 0.65, d] },
      ];

    case 'panel':
      return [{ pos: [0, h / 2, 0], size: [w, h, d] }];

    case 'slab':
      return [{ pos: [0, h / 2, 0], size: [w, h, d] }];

    case 'box':
    default:
      return [{ pos: [0, h / 2, 0], size: [w, h, d] }];
  }
}

/**
 * Один предмет. Группа ставится в центр следа и поворачивается вокруг своей
 * оси — поэтому поворот не сдвигает предмет с места и не требует пересчёта
 * координат в раскладке.
 *
 * Ковры и плитка тени не отбрасывают и не принимают: они лежат на полу
 * вплотную, и любая тень на них — это z-fighting, а не тень.
 */
function Prop({ item, materials, editing, dragged, onGrab }: {
  item: Placed3;
  materials: Record<string, THREE.Material>;
  /** Включён редактор расстановки: предмет можно взять мышью. */
  editing: boolean;
  /** Этот предмет сейчас в руках. */
  dragged: boolean;
  onGrab: (item: Placed3, hit: THREE.Vector3) => void;
}) {
  const parts = useMemo(() => partsOf(item), [item]);
  const flat = item.def.shape === 'slab';
  const base = item.def.tone ?? 'metal';
  const [hovered, setHovered] = useState(false);
  const marked = editing && (hovered || dragged);

  const grab = editing
    ? {
        onPointerDown: (e: { stopPropagation: () => void; point: THREE.Vector3 }) => {
          e.stopPropagation();
          onGrab(item, e.point);
        },
        onPointerOver: (e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'grab';
        },
        onPointerOut: () => {
          setHovered(false);
          document.body.style.cursor = '';
        },
      }
    : {};

  return (
    <group position={[item.cx, item.base, item.cy]} rotation={[0, -item.rot, 0]}>
      {parts.map((part, i) => (
        <mesh
          key={i}
          position={part.pos}
          scale={part.round ? [part.size[0], 1, part.size[2]] : undefined}
          material={materials[part.tone ?? base] ?? materials.metal}
          castShadow={!flat}
          receiveShadow={!flat}
          {...grab}
        >
          {part.round
            // Цилиндр строится по радиусу, поэтому неравные ширина и глубина
            // задаются масштабом меша, а не геометрией.
            ? <cylinderGeometry args={[0.5, 0.5, part.size[1], 20]} />
            : <boxGeometry args={part.size} />}
        </mesh>
      ))}

      {/* След предмета на полу — подсветка в редакторе. Показывает не только
          «этот предмет взят», но и сколько места он занимает: расставляя
          мебель, это и нужно знать, а по самой фигуре след угадывается плохо. */}
      {marked && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03 - item.base, 0]}>
          <planeGeometry args={[item.w, item.d]} />
          <meshBasicMaterial
            color={EDIT_ACCENT} transparent opacity={dragged ? 0.5 : 0.25}
            side={THREE.DoubleSide} depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}

/**
 * Вся обстановка комнаты. Материалы — по одному на тон, а не на предмет:
 * их семь на три десятка предметов, и общий материал позволяет three
 * складывать меши в один вызов отрисовки.
 */
export function Props3D({ items, palette, offset }: {
  items: Placed3[];
  palette: Palette;
  /** сдвиг комнаты в мир — тот же, что у пола и стен */
  offset: [number, number];
}) {
  const materials = useMemo(() => {
    const made: Record<string, THREE.Material> = {};
    for (const [tone, color] of Object.entries(palette.prop)) {
      made[tone] = new THREE.MeshLambertMaterial({ color });
    }
    return made;
  }, [palette.prop]);
  useEffect(() => () => { for (const m of Object.values(materials)) m.dispose(); }, [materials]);

  const editing = useStore((s) => s.editingLayout);
  const dragItem = useStore((s) => s.dragItem);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls);

  /** Куда предмет держат относительно точки, за которую взяли: без этого
   *  предмет прыгает якорем под курсор в момент нажатия. */
  const grab = useRef({ x: 0, y: 0 });

  const onGrab = (item: Placed3, hit: THREE.Vector3) => {
    grab.current = {
      x: item.ax - (hit.x - offset[0]),
      y: item.ay - (hit.z - offset[1]),
    };
    startDrag(item.key, item.ax, item.ay, (item.rot * 180) / Math.PI);
  };

  /**
   * Ведение и отпускание предмета.
   *
   * Курсор ловится на окне, а не на самом предмете: при быстром движении он
   * уходит за его границы, и предмет бы «отцепился». Ровно та же причина, по
   * которой плоский редактор вешает слушатели на `window` (Office.tsx).
   *
   * Точка под курсором считается пересечением луча камеры с плоскостью пола,
   * а не попаданием в мебель: тащить предмет по другой мебели значило бы
   * возить его по её крышкам, то ныряя, то подпрыгивая. Пол — единственная
   * поверхность, по которой мебель ездит.
   */
  const dragKey = dragItem?.key ?? null;
  useEffect(() => {
    if (!dragKey) return;
    const el = gl.domElement;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      ndc.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      updateDrag(hit.x - offset[0] + grab.current.x, hit.z - offset[1] + grab.current.y);
    };
    const onUp = () => endDrag();
    const onWheel = (e: WheelEvent) => {
      // Пока предмет в руках, колесо крутит его, а не камеру: наезжать и
      // разворачивать одновременно всё равно не выходит, а поворот — то, ради
      // чего трёхмерный редактор и заводился.
      e.preventDefault();
      rotateDrag(e.deltaY > 0 ? ROT_STEP : -ROT_STEP);
    };

    // Облёт на время перетаскивания выключаем: иначе то же движение мыши
    // одновременно возит предмет и вращает комнату.
    const orbit = controls as { enabled?: boolean } | null;
    const wasEnabled = orbit?.enabled;
    if (orbit) orbit.enabled = false;

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('wheel', onWheel);
      if (orbit && wasEnabled !== undefined) orbit.enabled = wasEnabled;
      document.body.style.cursor = '';
    };
  }, [dragKey, camera, gl, controls, offset]);

  return (
    <group position={[offset[0], 0, offset[1]]}>
      {items.map((item) => (
        <Prop
          key={item.key}
          item={dragItem?.key === item.key ? dragged(item, dragItem) : item}
          materials={materials}
          editing={editing}
          dragged={dragItem?.key === item.key}
          onGrab={onGrab}
        />
      ))}
    </group>
  );
}

/**
 * Предмет в руках рисуется по позиции превью, а не по сохранённой: до
 * отпускания кнопки на сервер ничего не уходит, и комната должна показывать
 * ровно то, что человек видит под курсором.
 *
 * Якорь сдвигается на дельту, а центр следа — на неё же: пересчитывать след
 * заново незачем, предмет не меняет ни размера, ни формы, пока его несут.
 */
function dragged(item: Placed3, drag: { x: number; y: number; rot: number }): Placed3 {
  return {
    ...item,
    cx: item.cx + (drag.x - item.ax),
    cy: item.cy + (drag.y - item.ay),
    ax: drag.x,
    ay: drag.y,
    rot: (drag.rot * Math.PI) / 180,
  };
}

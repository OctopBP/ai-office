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
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLoader, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRAG_GRID, endDrag, rotateDrag, startDrag, updateDrag, useStore } from '../store';
import type { Palette } from './palette';
import { MODEL_URLS } from './models';
import { MODEL_SCALE } from './props';
import type { ModelPart, Placed3, Prop3 } from './props';

/** Шаг поворота колесом, градусы. Мелкий намеренно: прямые углы — не
 *  единственное, что бывает нужно, а набрать 90° шестью щелчками недолго. */
const ROT_STEP = 15;

/** Цвет подсветки предмета в редакторе — акцент интерфейса. */
const EDIT_ACCENT = '#f0b429';

/**
 * Сетка расстановки, которая рисуется на полу, пока предмет несут.
 *
 * Шаг у неё ровно тот, к которому предмет прилипает (`DRAG_GRID`): сетка
 * здесь не украшение, а показ того, куда предмет может встать. Нарисовать её
 * с другим шагом значило бы обмануть — человек целился бы в линию, а предмет
 * вставал между.
 *
 * Появляется только на время переноса: постоянная сетка на полу превратила бы
 * офис в чертёж, а нужна она ровно тогда, когда что-то ставят.
 */
function EditGrid({ size }: { size: [number, number] }) {
  const [w, d] = size;
  const geometry = useMemo(() => {
    const pts: number[] = [];
    // Полтайла — мелкая сетка привязки; целые тайлы отрисованы отдельно и
    // ярче, иначе в частой сетке не найти опорную линию.
    for (let x = 0; x <= w + 1e-6; x += DRAG_GRID) pts.push(x, 0, 0, x, 0, d);
    for (let z = 0; z <= d + 1e-6; z += DRAG_GRID) pts.push(0, 0, z, w, 0, z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [w, d]);

  const major = useMemo(() => {
    const pts: number[] = [];
    for (let x = 0; x <= w + 1e-6; x += 1) pts.push(x, 0, 0, x, 0, d);
    for (let z = 0; z <= d + 1e-6; z += 1) pts.push(0, 0, z, w, 0, z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [w, d]);

  useEffect(() => () => { geometry.dispose(); major.dispose(); }, [geometry, major]);

  return (
    <>
      <lineSegments geometry={geometry} position={[0, 0.04, 0]}>
        <lineBasicMaterial color={EDIT_ACCENT} transparent opacity={0.18} depthWrite={false} />
      </lineSegments>
      <lineSegments geometry={major} position={[0, 0.05, 0]}>
        <lineBasicMaterial color={EDIT_ACCENT} transparent opacity={0.38} depthWrite={false} />
      </lineSegments>
    </>
  );
}

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

/** Загруженные сцены набора по имени файла. */
const ModelsContext = createContext<Record<string, THREE.Object3D>>({});

const MODEL_NAMES = Object.keys(MODEL_URLS);
const MODEL_LIST = MODEL_NAMES.map((n) => MODEL_URLS[n]);

/**
 * Загрузка всего набора мебели одной точкой.
 *
 * Раньше каждый предмет грузил свои модели сам и висел на собственном
 * `Suspense`. Два десятка точек подвешивания в одном дереве r3f сцену не
 * поднимали вовсе: ветка так и оставалась неотрисованной, хотя файлы
 * приходили. Одна загрузка на всю комнату — и проще, и надёжнее: моделей
 * всего четыре, а предметов, которые их делят, два десятка.
 */
export function FurnitureModels({ children }: { children: React.ReactNode }) {
  const loaded = useLoader(GLTFLoader, MODEL_LIST) as unknown as { scene: THREE.Object3D }[];
  const map = useMemo(() => {
    const made: Record<string, THREE.Object3D> = {};
    MODEL_NAMES.forEach((name, i) => { made[name] = loaded[i].scene; });
    return made;
  }, [loaded]);
  return <ModelsContext.Provider value={map}>{children}</ModelsContext.Provider>;
}

/**
 * Модели предмета, готовые к вставке в сцену.
 *
 * Загруженная сцена клонируется на каждый предмет: столов в комнате десять,
 * а файл один, и делить между ними один и тот же объект нельзя — у него одна
 * матрица на всех.
 *
 * Масштаб общий для всего набора (`MODEL_SCALE`), а не подогнанный под след
 * каждого предмета: набор нарисован соразмерным сам себе, и подгонка по
 * следу — который у нас посчитан по пиксельному арту — эту соразмерность бы
 * сломала. Стул рядом со столом должен быть стулом рядом со столом.
 */
function PropModels({ parts }: { parts: ModelPart[] }) {
  const models = useContext(ModelsContext);

  const objects = useMemo(() => parts.map((part) => {
    const source = models[part.file];
    if (!source) return null;
    const object = source.clone(true);
    object.scale.setScalar(MODEL_SCALE);
    object.traverse((o) => {
      if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; }
    });

    /**
     * Модель центрируется по собственным габаритам, а не ставится «как есть».
     *
     * У набора начало координат где придётся: у дивана оно в левом переднем
     * углу, у стола — у левой кромки. Поставить такую модель в центр следа
     * значит сдвинуть её на пол-ширины вбок — именно поэтому агенты
     * оказывались левее дивана, а стулья мимо столов. Здесь модель приводится
     * к общему правилу: середина по горизонтали, низ по вертикали, — и `at`
     * начинает значить то, что написано в его описании.
     *
     * Поворот делается вокруг уже выровненного центра, поэтому обёртка:
     * повернуть смещённую модель — снова увезти её в сторону.
     */
    const box = new THREE.Box3().setFromObject(object);
    object.position.set(
      -(box.min.x + box.max.x) / 2,
      -box.min.y,
      -(box.min.z + box.max.z) / 2,
    );

    const holder = new THREE.Group();
    holder.add(object);
    const [x, y, z] = part.at ?? [0, 0, 0];
    holder.position.set(x, y, z);
    holder.rotation.y = ((part.rot ?? 0) * Math.PI) / 180;
    return holder;
  }), [models, parts]);

  return <>{objects.map((o, i) => (o ? <primitive key={i} object={o} /> : null))}</>;
}

/**
 * Геометрия одного предмета без всякого поведения: коробки по частям из
 * `partsOf`, поставленные и повёрнутые. Вынесена отдельно, потому что ровно
 * то же самое рисуют интерактивные предметы — доска задач, экран лога,
 * дверь, — а вот ведут они себя иначе (`Hotspots3D.tsx`).
 */
export function PropShape({ item, materials }: {
  item: Placed3;
  materials: Record<string, THREE.Material>;
}) {
  // Есть модель — примитивы не рисуем вовсе. Пока она грузится, место
  // остаётся пустым: показывать коробку, которую через миг заменят, значит
  // моргать мебелью на каждом открытии комнаты.
  if (item.def.models) return <PropModels parts={item.def.models} />;
  return <PrimitiveShape item={item} materials={materials} />;
}

function PrimitiveShape({ item, materials }: {
  item: Placed3;
  materials: Record<string, THREE.Material>;
}) {
  const parts = useMemo(() => partsOf(item), [item]);
  const flat = item.def.shape === 'slab';
  const base = item.def.tone ?? 'metal';
  return (
    <>
      {parts.map((part, i) => (
        <mesh
          key={i}
          position={part.pos}
          scale={part.round ? [part.size[0], 1, part.size[2]] : undefined}
          material={materials[part.tone ?? base] ?? materials.metal}
          castShadow={!flat}
          receiveShadow={!flat}
        >
          {part.round
            ? <cylinderGeometry args={[0.5, 0.5, part.size[1], 20]} />
            : <boxGeometry args={part.size} />}
        </mesh>
      ))}
    </>
  );
}

/**
 * Материалы обстановки — по одному на тон, а не на предмет: их семь на три
 * десятка предметов, и общий материал позволяет three складывать меши в один
 * вызов отрисовки.
 */
export function usePropMaterials(palette: Palette): Record<string, THREE.Material> {
  const materials = useMemo(() => {
    const made: Record<string, THREE.Material> = {};
    for (const [tone, color] of Object.entries(palette.prop)) {
      made[tone] = new THREE.MeshLambertMaterial({ color });
    }
    return made;
  }, [palette.prop]);
  useEffect(() => () => { for (const m of Object.values(materials)) m.dispose(); }, [materials]);
  return materials;
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
    <group position={[item.cx, item.base, item.cy]} rotation={[0, -item.rot, 0]} {...grab}>
      <PropShape item={item} materials={materials} />

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
export function Props3D({ items, palette, offset, size }: {
  items: Placed3[];
  palette: Palette;
  /** сдвиг комнаты в мир — тот же, что у пола и стен */
  offset: [number, number];
  /** размер раскладки в тайлах — по нему рисуется сетка расстановки */
  size: [number, number];
}) {
  const materials = usePropMaterials(palette);

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
      {dragItem && <EditGrid size={size} />}
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

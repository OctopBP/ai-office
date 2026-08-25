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
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Palette } from './palette';
import type { Placed3, Prop3 } from './props';

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
function Prop({ item, materials }: {
  item: Placed3;
  materials: Record<string, THREE.Material>;
}) {
  const parts = useMemo(() => partsOf(item), [item]);
  const flat = item.def.shape === 'slab';
  const base = item.def.tone ?? 'metal';

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
        >
          {part.round
            // Цилиндр строится по радиусу, поэтому неравные ширина и глубина
            // задаются масштабом меша, а не геометрией.
            ? <cylinderGeometry args={[0.5, 0.5, part.size[1], 20]} />
            : <boxGeometry args={part.size} />}
        </mesh>
      ))}
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

  return (
    <group position={[offset[0], 0, offset[1]]}>
      {items.map((item) => (
        <Prop key={item.key} item={item} materials={materials} />
      ))}
    </group>
  );
}

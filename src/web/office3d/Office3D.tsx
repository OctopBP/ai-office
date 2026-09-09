/**
 * Трёхмерный рендер офиса — шаг 1: комната, свет и камера. Мебели, агентов и
 * ассетов здесь пока нет: задача этапа — увидеть настоящую планировку в
 * объёме, с тенями и облётом, и решить, тот ли это офис, — до того как в 3D
 * вложено что-то серьёзное.
 *
 * Плоского рендера больше нет (2026-09-02): комната рисуется только здесь,
 * спрайты из `design/sprites` остались меню старта и запасным аватаркам.
 *
 * Гашение ближних стен сделано сразу, хотя по плану это следующий шаг: без
 * него облёт бессмысленен — комната закрыта стеной, обращённой к камере
 * наружной стороной, и оценить сцену нельзя. Камера с тех пор выросла в
 * отдельный модуль (`Camera3D.tsx`): фокус на комнате и на агенте, свободное
 * перемещение по офису.
 */
import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { propKeys, spriteOf } from '../../shared/layout';
import type { LayoutProp } from '../../shared/layout';
import { useStore } from '../store';
import { catalog, type HotspotPanel } from '../layoutData';
import { paletteOf, type Palette } from './palette';
import { WALL_H, scene3, type Box3, type Floor3, type Scene3, type Wall3 } from './geometry';
import { place3 } from './props';
import { FurnitureModels, Props3D } from './Props3D';
import { Hotspots3D, type Spot3, type SpotKind, type SpotTarget } from './Hotspots3D';
import { CeilingLamps, Lights } from './Lights3D';
import { Agents3D } from './Agents3D';
import { Pixelation } from './Pixelation';
import { Camera3D, CameraChips, FOV, startPose } from './Camera3D';
import { DevBadge, DevOverlay } from './Dev3D';
import { t } from '../i18n';

/** Насколько прозрачной становится погашенная стена. Не ноль: контур комнаты
 *  должен читаться, иначе теряется, где она кончается. */
const FADED = 0.12;

/** Центр коробки в мире: геометрия задана в тайлах плана, `[x, y]` плана —
 *  это `[x, z]` мира, а высота — ось Y, которой в плане нет. */
function centerOf(b: Box3): [number, number, number] {
  return [b.cx, b.base + b.h / 2, b.cy];
}

function sizeOf(b: Box3): [number, number, number] {
  return [b.w, b.h, b.d];
}

/**
 * Текстуры стен: `inner` — грань, смотрящая в комнату, `outer` — наружная,
 * `top` — торец сверху. Каждая необязательна: без файла грань рисуется
 * цветом из палитры. Наружная и внутренняя разведены нарочно — снаружи
 * офис может быть кирпичным, а внутри оштукатуренным.
 */
type WallFace = 'inner' | 'outer' | 'top';
const wallModules = import.meta.glob('../../../design/textures/wall/*.{png,jpg,jpeg}', {
  eager: true, query: '?url', import: 'default',
}) as Record<string, string>;
const WALL_TEXTURE_URLS: Partial<Record<WallFace, string>> = {};
for (const [path, url] of Object.entries(wallModules)) {
  const name = path.split('/').pop()!.replace(/\.(png|jpe?g)$/, '');
  if (name === 'inner' || name === 'outer' || name === 'top') WALL_TEXTURE_URLS[name] = url;
}
const WALL_FACES = Object.keys(WALL_TEXTURE_URLS) as WallFace[];

/** Сколько тайлов покрывает одна картинка текстуры стены, по обеим осям. */
const WALL_TEXTURE_TILES = 2;

type WallTextures = Partial<Record<WallFace, THREE.Texture>>;

/**
 * Коробка стены с развёрткой по координатам плана, а не по своим граням.
 *
 * У `BoxGeometry` каждая грань растянута на текстуру целиком от 0 до 1, и
 * стена из трёх коробок получила бы три растянутых по-разному картинки со
 * швами на стыках. Здесь `uv` каждой вершины считается из её положения в
 * плане: у боковых граней — вдоль стены и по высоте, у торца — по плану.
 * Тогда все коробки всех стен режут одну и ту же картинку, и на стыке
 * узор просто продолжается. Текстуре при этом ни повтор, ни сдвиг не нужны.
 */
function wallGeometry(b: Box3): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(b.w, b.h, b.d);
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  const [cx, cy, cz] = centerOf(b);
  const k = 1 / WALL_TEXTURE_TILES;
  for (let i = 0; i < pos.count; i++) {
    const x = (pos.getX(i) + cx) * k;
    const y = (pos.getY(i) + cy) * k;
    const z = (pos.getZ(i) + cz) * k;
    // Порядок граней BoxGeometry: +X, −X, +Y, −Y, +Z, −Z — по четыре вершины.
    const face = i >> 2;
    if (face < 2) uv.setXY(i, z, y);
    else if (face < 4) uv.setXY(i, x, z);
    else uv.setXY(i, x, y);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Меш одной коробки стены — со своей развёрткой (`wallGeometry`). */
function WallBox({ box, material, userData, castShadow, receiveShadow }: {
  box: Box3;
  material: THREE.Material | THREE.Material[];
  userData: Record<string, unknown>;
  castShadow: boolean;
  receiveShadow: boolean;
}) {
  const geometry = useMemo(() => wallGeometry(box), [box]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh
      position={centerOf(box)}
      geometry={geometry}
      material={material}
      userData={userData}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    />
  );
}

/**
 * Один отрезок стены. Гасится целиком, а не по коробкам: если считать
 * видимость покоробочно, длинная стена при облёте растворяется кусками.
 *
 * Материалов два — боковой и торцевой сверху. Срез стены другим цветом даёт
 * тот самый «кукольный» вид разрезанного домика и заодно показывает толщину
 * стены, которой на плоском рендере не было видно вовсе.
 */
function WallSegment({ wall, offset, palette, textures }: {
  wall: Wall3;
  /** сдвиг комнаты в мир (её центр лежит в начале координат) */
  offset: [number, number];
  palette: Palette;
  textures: WallTextures;
}) {
  const group = useRef<THREE.Group>(null);
  const opacity = useRef(1);

  /** Материал грани: с текстурой — её тон из палитры, без — цвет грани. */
  const faceMaterial = (map: THREE.Texture | undefined, color: string, tint: string) =>
    new THREE.MeshLambertMaterial({ map, color: map ? tint : color, transparent: true });
  const inner = useMemo(
    () => faceMaterial(textures.inner, palette.wall, palette.wallTint),
    [textures.inner, palette.wall, palette.wallTint],
  );
  const outer = useMemo(
    () => faceMaterial(textures.outer, palette.wall, palette.wallTint),
    [textures.outer, palette.wall, palette.wallTint],
  );
  const top = useMemo(
    () => faceMaterial(textures.top, palette.wallTop, palette.wallTint),
    [textures.top, palette.wallTop, palette.wallTint],
  );
  const glass = useMemo(
    () => new THREE.MeshLambertMaterial({
      color: palette.glass, transparent: true, opacity: palette.glassOpacity, depthWrite: false,
    }),
    [palette.glass, palette.glassOpacity],
  );
  useEffect(
    () => () => { inner.dispose(); outer.dispose(); top.dispose(); glass.dispose(); },
    [inner, outer, top, glass],
  );
  const solids = useMemo(() => [inner, outer, top], [inner, outer, top]);

  /**
   * Материалы по граням коробки — в порядке BoxGeometry: +X, −X, +Y, −Y, +Z,
   * −Z. Бока стены — те две грани, что поперёк её оси; какая из них смотрит
   * в комнату, записано в `sides`. Торцы и низ — внутренние: свободный торец
   * стены виден из дверного проёма, то есть из комнаты.
   */
  const materialsOf = (b: Box3): THREE.Material[] => {
    const pick = (inside: boolean | undefined) => (inside === false ? outer : inner);
    const pos = pick(b.sides?.pos);
    const neg = pick(b.sides?.neg);
    return wall.axis === 'x'
      ? [inner, inner, top, inner, pos, neg]
      : [pos, neg, top, inner, inner, inner];
  };

  /** Центр отрезка и его нормаль сразу в мировых координатах: считать их
   *  каждый кадр через матрицу группы незачем, комната неподвижна. */
  const center = useMemo(
    () => new THREE.Vector3(wall.center[0] + offset[0], WALL_H / 2, wall.center[1] + offset[1]),
    [wall.center, offset],
  );
  const normal = useMemo(
    () => new THREE.Vector3(wall.normal[0], 0, wall.normal[1]),
    [wall.normal],
  );

  const toWall = useRef(new THREE.Vector3());
  const view = useRef(new THREE.Vector3());

  useFrame(({ camera, controls }, dt) => {
    const g = group.current;
    if (!g) return;

    // Куда смотрит камера: до появления фокуса (`Camera3D.tsx`) цель облёта
    // всегда лежала в начале координат, и направление взгляда считалось как
    // минус позиция камеры. Теперь цель ездит по офису, и брать её надо у
    // контроллера: иначе при наезде на кухню гаснут стены не той комнаты.
    const at = (controls as { target?: THREE.Vector3 } | null)?.target;
    if (at) view.current.copy(at).sub(camera.position);
    else view.current.copy(camera.position).negate();
    toWall.current.copy(center).sub(camera.position);

    // Насколько стена ближе камеры к цели: <1 — перед целью, >1 — за ней.
    // Загораживать может только ближняя.
    const depth = toWall.current.dot(view.current) / view.current.lengthSq();
    // И только если она к камере боком, а не ребром: стена вдоль взгляда
    // ничего не закрывает, гасить её — терять ориентир.
    const facing = Math.abs(toWall.current.normalize().dot(normal));
    const want = depth < 0.98 && facing > 0.35 ? FADED : 1;

    if (Math.abs(opacity.current - want) < 0.001) return;
    opacity.current += (want - opacity.current) * Math.min(1, dt * 9);

    const solid = opacity.current > 0.95;
    for (const m of solids) {
      m.opacity = opacity.current;
      m.depthWrite = solid;
    }
    glass.opacity = palette.glassOpacity * opacity.current;
    // Погашенная стена не должна оставлять на полу свою тень целой.
    for (const child of g.children) {
      if (child instanceof THREE.Mesh && child.userData.glass !== true) {
        child.castShadow = opacity.current > 0.5;
      }
    }
  });

  return (
    <group ref={group}>
      {wall.boxes.map((b, i) => (
        <WallBox
          key={i}
          box={b}
          material={b.glass ? glass : materialsOf(b)}
          userData={{ glass: b.glass === true }}
          castShadow={!b.glass}
          receiveShadow={!b.glass}
        />
      ))}
    </group>
  );
}

/** Все стены раскладки одним набором текстур. */
function WallSegments({ scene, offset, palette, textures }: {
  scene: Scene3; offset: [number, number]; palette: Palette; textures: WallTextures;
}) {
  return (
    <>
      {scene.walls.map((wall, i) => (
        <WallSegment key={i} wall={wall} offset={offset} palette={palette} textures={textures} />
      ))}
    </>
  );
}

/** Стены с текстурами из `design/textures/wall`, когда те доехали. */
function TexturedWalls(props: { scene: Scene3; offset: [number, number]; palette: Palette }) {
  const loaded = useLoader(
    THREE.TextureLoader, WALL_FACES.map((f) => WALL_TEXTURE_URLS[f]!),
  ) as THREE.Texture[];
  const textures = useMemo(() => {
    const byFace: WallTextures = {};
    loaded.forEach((tex, i) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.needsUpdate = true;
      byFace[WALL_FACES[i]] = tex;
    });
    return byFace;
  }, [loaded]);
  return <WallSegments {...props} textures={textures} />;
}

/**
 * Стены раскладки. Пока текстуры едут, стены стоят цветными — как и без
 * текстур вовсе: комната без стен на секунду хуже комнаты с ровными стенами.
 */
function Walls(props: { scene: Scene3; offset: [number, number]; palette: Palette }) {
  if (WALL_FACES.length === 0) return <WallSegments {...props} textures={{}} />;
  return (
    <Suspense fallback={<WallSegments {...props} textures={{}} />}>
      <TexturedWalls {...props} />
    </Suspense>
  );
}

/**
 * Текстуры пола по имени материала: `design/textures/floor/parquet.jpg`
 * ложится на все комнаты с полом `parquet`. Материала без файла это не
 * касается — он остаётся цветом из палитры, как и было.
 */
const floorModules = import.meta.glob('../../../design/textures/floor/*.{png,jpg,jpeg}', {
  eager: true, query: '?url', import: 'default',
}) as Record<string, string>;
const FLOOR_TEXTURE_URLS: Partial<Record<Floor3['material'], string>> = {};
for (const [path, url] of Object.entries(floorModules)) {
  const name = path.split('/').pop()!.replace(/\.(png|jpe?g)$/, '') as Floor3['material'];
  FLOOR_TEXTURE_URLS[name] = url;
}

/**
 * Сколько тайлов пола покрывает одна картинка текстуры. Картинка бесшовная,
 * дальше повторяется. Два тайла — при тайле в метр доски паркета получаются
 * в натуральную величину, а не в ладонь и не в дверь.
 */
const FLOOR_TEXTURE_TILES = 2;

/** Пол одной комнаты — цветом из палитры. */
function PlainFloor({ floor, palette }: { floor: Floor3; palette: Palette }) {
  return (
    <mesh position={centerOf(floor)} receiveShadow>
      <boxGeometry args={sizeOf(floor)} />
      <meshLambertMaterial color={palette.floor[floor.material] ?? palette.ground} />
    </mesh>
  );
}

/**
 * Пол одной комнаты — текстурой.
 *
 * Повтор и сдвиг считаются от координат комнаты в мире, а не от её угла:
 * тогда у двух соседних комнат с одним материалом узор продолжается через
 * порог, а не начинается заново со швом. У верхней грани коробки `u` идёт
 * вдоль X, `v` — вдоль Z, поэтому сдвиг — это просто угол комнаты в тайлах,
 * делённый на размер картинки.
 *
 * Текстура клонируется на комнату: повтор и сдвиг живут в самой текстуре,
 * а картинка у клонов общая, так что памяти это не стоит.
 */
function TexturedFloor({ floor, url, palette }: { floor: Floor3; url: string; palette: Palette }) {
  const base = useLoader(THREE.TextureLoader, url) as THREE.Texture;
  const map = useMemo(() => {
    const tex = base.clone();
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(floor.w / FLOOR_TEXTURE_TILES, floor.d / FLOOR_TEXTURE_TILES);
    tex.offset.set(
      (floor.cx - floor.w / 2) / FLOOR_TEXTURE_TILES,
      (floor.cy - floor.d / 2) / FLOOR_TEXTURE_TILES,
    );
    tex.needsUpdate = true;
    return tex;
  }, [base, floor.w, floor.d, floor.cx, floor.cy]);
  useEffect(() => () => map.dispose(), [map]);
  return (
    <mesh position={centerOf(floor)} receiveShadow>
      <boxGeometry args={sizeOf(floor)} />
      <meshLambertMaterial map={map} color={palette.floorTint} />
    </mesh>
  );
}

/**
 * Пол комнат и общая плита под всей раскладкой — иначе под стенами дыра.
 *
 * Пока текстура едет, комната стоит на цветном полу — том же, что и без
 * текстуры: лучше секунду видеть ровный цвет, чем дыру до плиты.
 */
function Floors({ scene, palette }: { scene: Scene3; palette: Palette }) {
  const [w, d] = scene.size;
  return (
    <>
      <mesh position={[w / 2, -0.35, d / 2]} receiveShadow>
        <boxGeometry args={[w, 0.5, d]} />
        <meshLambertMaterial color={palette.ground} />
      </mesh>
      {scene.floors.map((f) => {
        const url = FLOOR_TEXTURE_URLS[f.material];
        return url ? (
          <Suspense key={f.id} fallback={<PlainFloor floor={f} palette={palette} />}>
            <TexturedFloor floor={f} url={url} palette={palette} />
          </Suspense>
        ) : <PlainFloor key={f.id} floor={f} palette={palette} />;
      })}
    </>
  );
}

/**
 * Сетка тайлов по всему полу раскладки.
 *
 * Рисуется линиями, а не текстурой пола: пол собран из комнат разного
 * материала плюс общая плита под ними, и класть на каждую свою текстуру
 * значило бы совмещать их по швам. Линии же кладутся поверх всего разом, и
 * сетка получается сплошной — она про раскладку, а не про комнату.
 *
 * Каждая пятая линия толще и темнее: без опоры глаз не считает больше трёх
 * клеток подряд, а вопрос к сетке обычно «на сколько тайлов лёг диван».
 *
 * Высота — сантиметр над нулём. Ноль здесь не «низ сцены», а отметка, на
 * которой стоит мебель: пол комнаты кончается ровно на ней. Точно на уровне
 * линию класть нельзя — она мерцает з-файтингом, а под уровнем её съедает пол.
 *
 * `bright` — вариант для режима разработчика: одним ярким цветом и без
 * прозрачности. Обычная сетка полупрозрачная и серая, чтобы не спорить с
 * комнатой, но поверх красной заливки занятых клеток и текстуры паркета
 * она пропадает, а в этом режиме именно она — главное.
 */
function FloorGrid({ scene, palette, bright }: { scene: Scene3; palette: Palette; bright?: boolean }) {
  const [cols, rows] = scene.size;
  const y = 0.01;
  const [minor, major] = useMemo(() => {
    const thin: number[] = [];
    const thick: number[] = [];
    for (let x = 0; x <= cols; x++) {
      (x % 5 === 0 ? thick : thin).push(x, 0, 0, x, 0, rows);
    }
    for (let z = 0; z <= rows; z++) {
      (z % 5 === 0 ? thick : thin).push(0, 0, z, cols, 0, z);
    }
    return [new Float32Array(thin), new Float32Array(thick)];
  }, [cols, rows]);

  return (
    <group position={[0, y, 0]}>
      {([
        [minor, bright ? palette.dev.grid : palette.grid, bright ? 0.9 : 0.35],
        [major, bright ? palette.dev.grid : palette.gridMajor, bright ? 1 : 0.7],
      ] as const).map(
        ([points, color, opacity], i) => (
          <lineSegments key={i}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" args={[points, 3]} />
            </bufferGeometry>
            <lineBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
          </lineSegments>
        ),
      )}
    </group>
  );
}

export function Office3D({ onOpen, onDoor, active }: {
  onOpen: (target: SpotTarget) => void;
  onDoor: () => void;
  /** Вид «Офис» сейчас показан. Пока он не активен, сцена остаётся
   *  смонтированной (камера и позы агентов не должны слетать при
   *  возврате), но прячется через CSS и держит рендер-цикл выключенным. */
  active: boolean;
}) {
  const layout = useStore((s) => s.layout);
  const theme = useStore((s) => s.theme);
  const graphics = useStore((s) => s.graphics);
  const palette = paletteOf(theme);
  const scene = useMemo(() => scene3(layout), [layout]);
  /**
   * Обстановка комнаты и отдельно — предметы, которые нажимаются.
   *
   * Геометрически доска, экран лога и дверь — такая же мебель, и считаются
   * они тем же `place3`: у них тот же след, та же привязка к стене, тот же
   * поворот. Расходятся они только поведением, поэтому и рисуются разными
   * компонентами: обстановку можно таскать в редакторе, а нажимаемое —
   * нажимать.
   */
  const { placed, spots, meetingTable, deskItems } = useMemo(() => {
    const keys = propKeys(layout);
    const list: (LayoutProp & { key: string })[] = layout.props.map((p, i) => ({
      ...p, key: keys[i],
    }));

    /** Что за чем стоит и что на чём — считается по всей комнате разом,
     *  поэтому нажимаемое едет в `place3` вместе с обычной мебелью. */
    const meta = new Map<string, { kind: SpotKind; title: string; hotkey?: string }>();

    for (const zone of layout.zones ?? []) {
      if (zone.kind === 'entrance' && zone.sprite && zone.at) {
        const key = 'spot-door';
        list.push({ sprite: zone.sprite, at: zone.at, key });
        meta.set(key, { kind: 'door', title: zone.title ?? t('offices.title') });
      }
    }
    const hotspots = (layout.hotspots ?? []) as {
      sprite?: string; at?: [number, number]; panel?: HotspotPanel; key?: string; title?: string;
    }[];
    for (const spot of hotspots) {
      if (!spot.sprite || !spot.at || !spot.panel) continue;
      const key = `spot-${spot.panel}`;
      list.push({ sprite: spot.sprite, at: spot.at, key });
      meta.set(key, { kind: spot.panel, title: spot.title ?? '', hotkey: spot.key });
    }

    const all = place3(layout, catalog, list);
    const spotList: Spot3[] = [];
    const propList = all.filter((item) => {
      const m = meta.get(item.key);
      if (!m) return true;
      spotList.push({ item, ...m });
      return false;
    });
    // Стол переговорки остаётся обычной мебелью — его находят по зоне
    // `meeting`, той же, по которой рассаживают участников.
    const tableKey = (layout.zones ?? []).find((z) => z.kind === 'meeting')?.prop;
    const table = tableKey ? all.find((item) => item.key === tableKey) : undefined;
    // Рабочие столы — предметы с work-слотом в порядке раскладки: ровно так
    // `desks()` нумерует места, и `Desk.index` сотрудника указывает сюда.
    const workDesks = all.filter((item) => spriteOf(catalog, item.sprite)?.slots?.some((s) => s.kind === 'work'));
    return { placed: propList, spots: spotList, meetingTable: table, deskItems: workDesks };
  }, [layout]);
  const [w, d] = scene.size;
  const offset = useMemo<[number, number]>(() => [-w / 2, -d / 2], [w, d]);

  // Откуда смотреть на первом кадре — грубая прикидка по размеру комнаты:
  // вписыванием займётся риг камеры, здесь важно лишь направление и чтобы
  // камера не оказалась внутри стен.
  const start = useMemo(() => startPose(scene.size), [scene.size]);

  return (
    <div className={`office-box office3d${active ? '' : ' office3d-hidden'}`}>
      {/* `flat` выключает кинематографический тонмаппинг, который R3F ставит
          по умолчанию: он сжимает светлые тона и уводит всю палитру в серое.
          Минималистичной сцене из плоских цветов он не нужен — цвет на экране
          должен быть ровно тот, что записан в палитре. */}
      {/* `shadows="percentage"` вместо булева: булево включает PCFSoft,
          объявленный в three устаревшим, — рендерер ругается в консоль и
          молча откатывается ровно на этот же PCF. */}
      {/* Пока вид не активен, `frameloop="never"` полностью останавливает
          рендер-цикл R3F (включая все `useFrame`: ходьбу, мимику стен,
          риг камеры) — сцена не жжёт кадры за кулисами. Камера и позиции
          агентов при этом никуда не деваются: дерево не размонтировано. */}
      <Canvas
        flat
        shadows="percentage"
        frameloop={active ? 'always' : 'never'}
        camera={{ position: start, fov: FOV, near: 1, far: 1200 }}
        style={{ background: palette.backdrop }}
      >
        {/* Камера: облёт, наезд и фокус — на комнате, на выбранном агенте
            или там, куда её увели руками. */}
        <Camera3D layout={layout} size={scene.size} active={active} />
        <Lights scene={scene} palette={palette} />
        {/* Светильники комнат — отдельно от общего света сцены: солнце светит
            на всю раскладку разом, а лампа принадлежит комнате, в которой
            висит. */}
        <CeilingLamps scene={scene} palette={palette} offset={offset} />
        {/* Комната сдвинута так, чтобы её центр лёг в начало координат: тогда
            цель облёта, цель направленного света и центр вписывания — одна и
            та же точка, и ни одну из них не приходится возить за раскладкой. */}
        <group position={[offset[0], 0, offset[1]]}>
          <Floors scene={scene} palette={palette} />
          {/* В режиме разработчика сетка — обязательная часть картинки: без неё
              занятые клетки и маршруты не к чему привязать глазом. */}
          {(graphics.grid || graphics.dev) && (
            <FloorGrid scene={scene} palette={palette} bright={graphics.dev} />
          )}
          {graphics.dev && <DevOverlay layout={layout} palette={palette} />}
          <Walls scene={scene} offset={offset} palette={palette} />
        </group>
        {/* Мебель ждёт своих моделей одним общим `Suspense`: пока набор не
            приехал, комната стоит пустой, но стены и пол уже нарисованы. */}
        <Suspense fallback={null}>
          <FurnitureModels>
            <Props3D items={placed} palette={palette} offset={offset} size={scene.size} />
            <Hotspots3D
              spots={spots} meetingTable={meetingTable} deskItems={deskItems}
              layout={layout} palette={palette} offset={offset}
              onOpen={onOpen} onDoor={onDoor}
            />
          </FurnitureModels>
        </Suspense>
        <Agents3D offset={offset} />
        {/* Пикселизация — последней: пока она в дереве, кадр рисует она, а не
            R3F. Выключенная в настройках, она просто не монтируется, и офис
            рисуется обычным рендером. */}
        {graphics.pixelate && (
          <Pixelation
            pixelSize={graphics.pixelSize}
            normalEdge={graphics.normalEdge}
            depthEdge={graphics.depthEdge}
          />
        )}
      </Canvas>
      {/* Чипы фокуса — поверх канваса, обычным DOM: это интерфейс, а не
          часть сцены. */}
      <CameraChips layout={layout} />
      {graphics.dev && <DevBadge />}
    </div>
  );
}

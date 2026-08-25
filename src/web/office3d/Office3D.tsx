/**
 * Трёхмерный рендер офиса — шаг 1: комната, свет и камера. Мебели, агентов и
 * ассетов здесь пока нет: задача этапа — увидеть настоящую планировку в
 * объёме, с тенями и облётом, и решить, тот ли это офис, — до того как в 3D
 * вложено что-то серьёзное.
 *
 * Плоский рендер (`Office.tsx`) не тронут и работает как раньше; какой из двух
 * показывать, решает флаг `render3d` в сторе (клавиша 0).
 *
 * Гашение ближних стен сделано сразу, хотя по плану это следующий шаг: без
 * него облёт бессмысленен — комната закрыта стеной, обращённой к камере
 * наружной стороной, и оценить сцену нельзя. Полноценный контроллер камеры
 * (снап на 45°, границы) остаётся на потом, здесь ровно столько, чтобы было
 * на что смотреть.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { propKeys } from '../../shared/layout';
import type { LayoutProp } from '../../shared/layout';
import { useStore } from '../store';
import { catalog } from '../layoutData';
import { paletteOf, type Palette } from './palette';
import { WALL_H, scene3, type Box3, type Scene3, type Wall3 } from './geometry';
import { place3 } from './props';
import { Props3D } from './Props3D';

/**
 * Наклон и поворот камеры при первом показе. Полярный угол считается от
 * вертикали: 0 — вид строго сверху (нынешний плоский офис), π/2 — сбоку.
 */
const START_POLAR = 0.72;
const START_AZIMUTH = Math.PI / 4;

/**
 * Пределы облёта. Совсем сбоку смотреть нельзя — комната превращается в
 * фасад; сверху упираемся в плоский вид, ради ухода от которого всё и
 * затевалось, но подойти к нему близко разрешаем: это привычный ракурс.
 */
const MIN_POLAR = 0.15;
const MAX_POLAR = 1.28;

/** Насколько прозрачной становится погашенная стена. Не ноль: контур комнаты
 *  должен читаться, иначе теряется, где она кончается. */
const FADED = 0.12;

/** Радиус орбиты. Для ортографической камеры на масштаб не влияет (его задаёт
 *  `zoom`) — только на то, что попадает между near и far. */
const ORBIT_R = 80;

/** Центр коробки в мире: геометрия задана в тайлах плана, `[x, y]` плана —
 *  это `[x, z]` мира, а высота — ось Y, которой в плане нет. */
function centerOf(b: Box3): [number, number, number] {
  return [b.cx, b.base + b.h / 2, b.cy];
}

function sizeOf(b: Box3): [number, number, number] {
  return [b.w, b.h, b.d];
}

/**
 * Один отрезок стены. Гасится целиком, а не по коробкам: если считать
 * видимость покоробочно, длинная стена при облёте растворяется кусками.
 *
 * Материалов два — боковой и торцевой сверху. Срез стены другим цветом даёт
 * тот самый «кукольный» вид разрезанного домика и заодно показывает толщину
 * стены, которой на плоском рендере не было видно вовсе.
 */
function WallSegment({ wall, offset, palette }: {
  wall: Wall3;
  /** сдвиг комнаты в мир (её центр лежит в начале координат) */
  offset: [number, number];
  palette: Palette;
}) {
  const group = useRef<THREE.Group>(null);
  const opacity = useRef(1);

  const side = useMemo(
    () => new THREE.MeshLambertMaterial({ color: palette.wall, transparent: true }),
    [palette.wall],
  );
  const top = useMemo(
    () => new THREE.MeshLambertMaterial({ color: palette.wallTop, transparent: true }),
    [palette.wallTop],
  );
  const glass = useMemo(
    () => new THREE.MeshLambertMaterial({
      color: palette.glass, transparent: true, opacity: palette.glassOpacity, depthWrite: false,
    }),
    [palette.glass, palette.glassOpacity],
  );
  useEffect(() => () => { side.dispose(); top.dispose(); glass.dispose(); }, [side, top, glass]);

  /** Порядок граней BoxGeometry: +X, −X, +Y, −Y, +Z, −Z — торец сверху третий. */
  const materials = useMemo(() => [side, side, top, side, side, side], [side, top]);

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

  useFrame(({ camera }, dt) => {
    const g = group.current;
    if (!g) return;

    // Куда смотрит камера: цель облёта — начало координат, поэтому направление
    // взгляда есть минус её позиция.
    view.current.copy(camera.position).negate();
    toWall.current.copy(center).sub(camera.position);

    // Насколько стена ближе камеры к цели: <1 — в ближней половине комнаты,
    // >1 — за целью. Загораживать может только ближняя.
    const depth = toWall.current.dot(view.current) / view.current.lengthSq();
    // И только если она к камере боком, а не ребром: стена вдоль взгляда
    // ничего не закрывает, гасить её — терять ориентир.
    const facing = Math.abs(toWall.current.normalize().dot(normal));
    const want = depth < 0.98 && facing > 0.35 ? FADED : 1;

    if (Math.abs(opacity.current - want) < 0.001) return;
    opacity.current += (want - opacity.current) * Math.min(1, dt * 9);

    const solid = opacity.current > 0.95;
    side.opacity = opacity.current;
    top.opacity = opacity.current;
    side.depthWrite = solid;
    top.depthWrite = solid;
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
        <mesh
          key={i}
          position={centerOf(b)}
          material={b.glass ? glass : materials}
          userData={{ glass: b.glass === true }}
          castShadow={!b.glass}
          receiveShadow={!b.glass}
        >
          <boxGeometry args={sizeOf(b)} />
        </mesh>
      ))}
    </group>
  );
}

/** Пол комнат и общая плита под всей раскладкой — иначе под стенами дыра. */
function Floors({ scene, palette }: { scene: Scene3; palette: Palette }) {
  const [w, d] = scene.size;
  return (
    <>
      <mesh position={[w / 2, -0.35, d / 2]} receiveShadow>
        <boxGeometry args={[w, 0.5, d]} />
        <meshLambertMaterial color={palette.ground} />
      </mesh>
      {scene.floors.map((f) => (
        <mesh key={f.id} position={centerOf(f)} receiveShadow>
          <boxGeometry args={sizeOf(f)} />
          <meshLambertMaterial color={palette.floor[f.material]} />
        </mesh>
      ))}
    </>
  );
}

/**
 * Подгонка масштаба под размер канваса. Ортографическая камера меряет мир не
 * расстоянием, а `zoom` — сколько экранных пикселей приходится на тайл, —
 * поэтому «вписать комнату» здесь означает посчитать это число.
 *
 * Считается один раз на раскладку, а не каждый кадр: пересчёт при повороте
 * дёргал бы масштаб под рукой пользователя, а при изменении размера окна
 * постоянный `zoom` как раз и есть правильное поведение — комната не
 * резиновая, просто в окно видно больший её кусок.
 */
function FitCamera({ size }: { size: [number, number] }) {
  const camera = useThree((s) => s.camera);
  const viewport = useThree((s) => s.size);
  const width = viewport.width;
  const height = viewport.height;
  /** Вписались ли уже в этот размер комнаты. Ровно один раз на раскладку: на
   *  первом проходе канвас ещё не измерен (0×0), и считать по нему нельзя, —
   *  поэтому ждём настоящий размер, а дальше в перерасчёт не лезем. */
  const fitted = useRef(false);
  useLayoutEffect(() => { fitted.current = false; }, [size]);

  useLayoutEffect(() => {
    if (fitted.current || width < 1 || height < 1) return;
    const [w, d] = size;
    // Ориентация камеры берётся не из неё самой: на первом кадре её ещё не
    // выставил OrbitControls, и матрица мира была бы от позиции без поворота.
    const probe = new THREE.Object3D();
    probe.position.copy(camera.position);
    probe.lookAt(0, 0, 0);
    probe.updateMatrixWorld();
    const inv = probe.matrixWorld.clone().invert();

    // Габарит комнаты в экранных осях при этом повороте: восемь углов её
    // коробки переводятся в систему координат камеры, берётся размах.
    const half = [w / 2, WALL_H / 2, d / 2];
    const projected = new THREE.Box3();
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(
        (i & 1 ? 1 : -1) * half[0],
        (i & 2 ? 1 : -1) * half[1],
        (i & 4 ? 1 : -1) * half[2],
      ).applyMatrix4(inv);
      projected.expandByPoint(corner);
    }

    const spanX = projected.max.x - projected.min.x;
    const spanY = projected.max.y - projected.min.y;
    camera.zoom = Math.min(width / spanX, height / spanY) * 0.92;
    camera.updateProjectionMatrix();
    fitted.current = true;
  }, [camera, size, width, height]);

  return null;
}

/**
 * Свет: заполняющий (небо сверху, отражение от пола снизу) плюс единственный
 * направленный — он же и источник теней. Рамка теневой камеры сжата по
 * комнате: растянутая на всю сцену дала бы мыло вместо теней.
 */
function Lights({ scene, palette }: { scene: Scene3; palette: Palette }) {
  const [w, d] = scene.size;
  const [ox, oy, oz] = palette.light.keyOffset;
  /**
   * Рамка теневой камеры. Комната в неё попадает целиком по диагонали — при
   * низком солнце она ложится в карту глубины наискось, и запаса по стороне
   * `max(w, d)` не хватает: углы обрезаются, и тень там просто пропадает.
   */
  const reach = Math.hypot(w, d) * 0.75;
  /** Дальняя плоскость: расстояние до источника плюс размер комнаты. */
  const far = Math.hypot(ox, oy, oz) + Math.max(w, d) * 1.5;

  /**
   * Рамку теневой камеры мало задать — её надо пересчитать. Границы
   * `shadow-camera-*` попадают в объект напрямую, а матрицу проекции three
   * сам не обновляет: без этого вызова свет продолжает светить в рамку по
   * умолчанию (±5), и тени есть только у центра комнаты.
   */
  const key = useRef<THREE.DirectionalLight>(null);
  useLayoutEffect(() => {
    key.current?.shadow.camera.updateProjectionMatrix();
  }, [reach, far]);

  return (
    <>
      <hemisphereLight
        args={[palette.light.skyColor, palette.light.groundColor, palette.light.ambient]}
      />
      {/* Цель направленного света по умолчанию — начало координат, а комната
          сдвинута ровно так, чтобы её центр там и оказался. */}
      <directionalLight
        ref={key}
        position={[ox, oy, oz]}
        color={palette.light.keyColor}
        intensity={palette.light.keyIntensity}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0015}
        shadow-normalBias={0.02}
        shadow-camera-left={-reach}
        shadow-camera-right={reach}
        shadow-camera-top={reach}
        shadow-camera-bottom={-reach}
        shadow-camera-near={1}
        shadow-camera-far={far}
      />
      <directionalLight
        position={palette.light.fillOffset}
        color={palette.light.fillColor}
        intensity={palette.light.fillIntensity}
      />
    </>
  );
}

export function Office3D() {
  const layout = useStore((s) => s.layout);
  const theme = useStore((s) => s.theme);
  const palette = paletteOf(theme);
  const scene = useMemo(() => scene3(layout), [layout]);
  /**
   * Обстановка — это `props` раскладки плюс предметы, которые в плоском
   * рендере живут отдельными сущностями: дверь входной зоны и спрайты
   * хотспотов (доска, экран лога). Геометрически они такая же мебель, и
   * разделять их в 3D незачем — интерактивность им вернёт шаг 5.
   */
  const placed = useMemo(() => {
    const keys = propKeys(layout);
    const list: (LayoutProp & { key: string })[] = layout.props.map((p, i) => ({
      ...p, key: keys[i],
    }));
    for (const zone of layout.zones ?? []) {
      if (zone.sprite && zone.at) {
        list.push({ sprite: zone.sprite, at: zone.at, key: `zone-${zone.kind}` });
      }
    }
    for (const spot of (layout.hotspots ?? []) as { sprite?: string; at?: [number, number]; panel?: string }[]) {
      if (spot.sprite && spot.at) {
        list.push({ sprite: spot.sprite, at: spot.at, key: `hotspot-${spot.panel ?? spot.sprite}` });
      }
    }
    return place3(layout, catalog, list);
  }, [layout]);
  const [w, d] = scene.size;
  const offset = useMemo<[number, number]>(() => [-w / 2, -d / 2], [w, d]);

  const start: [number, number, number] = [
    Math.sin(START_POLAR) * Math.sin(START_AZIMUTH) * ORBIT_R,
    Math.cos(START_POLAR) * ORBIT_R,
    Math.sin(START_POLAR) * Math.cos(START_AZIMUTH) * ORBIT_R,
  ];

  return (
    <div className="office-box office3d">
      {/* `flat` выключает кинематографический тонмаппинг, который R3F ставит
          по умолчанию: он сжимает светлые тона и уводит всю палитру в серое.
          Минималистичной сцене из плоских цветов он не нужен — цвет на экране
          должен быть ровно тот, что записан в палитре. */}
      {/* `shadows="percentage"` вместо булева: булево включает PCFSoft,
          объявленный в three устаревшим, — рендерер ругается в консоль и
          молча откатывается ровно на этот же PCF. */}
      <Canvas
        flat
        shadows="percentage"
        orthographic
        camera={{ position: start, near: -400, far: 800, zoom: 20 }}
        style={{ background: palette.backdrop }}
      >
        <FitCamera size={scene.size} />
        <OrbitControls
          makeDefault
          target={[0, 0, 0]}
          enablePan={false}
          minPolarAngle={MIN_POLAR}
          maxPolarAngle={MAX_POLAR}
          minZoom={6}
          maxZoom={160}
          dampingFactor={0.12}
        />
        <Lights scene={scene} palette={palette} />
        {/* Комната сдвинута так, чтобы её центр лёг в начало координат: тогда
            цель облёта, цель направленного света и центр вписывания — одна и
            та же точка, и ни одну из них не приходится возить за раскладкой. */}
        <group position={[offset[0], 0, offset[1]]}>
          <Floors scene={scene} palette={palette} />
          {scene.walls.map((wall, i) => (
            <WallSegment key={i} wall={wall} offset={offset} palette={palette} />
          ))}
        </group>
        <Props3D items={placed} palette={palette} offset={offset} />
      </Canvas>
    </div>
  );
}

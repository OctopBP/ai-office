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
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { propKeys } from '../../shared/layout';
import type { LayoutProp } from '../../shared/layout';
import { useStore } from '../store';
import { catalog, type HotspotPanel } from '../layoutData';
import { paletteOf, type Palette } from './palette';
import { WALL_H, scene3, type Box3, type Scene3, type Wall3 } from './geometry';
import { place3 } from './props';
import { FurnitureModels, Props3D } from './Props3D';
import { Hotspots3D, type Spot3, type SpotKind } from './Hotspots3D';
import { CeilingLamps, Lights } from './Lights3D';
import { Agents3D } from './Agents3D';
import { Pixelation } from './Pixelation';
import { Camera3D, CameraChips, FOV, startPose } from './Camera3D';
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
 */
function FloorGrid({ scene, palette }: { scene: Scene3; palette: Palette }) {
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
      {([[minor, palette.grid, 0.35], [major, palette.gridMajor, 0.7]] as const).map(
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
  onOpen: (panel: HotspotPanel) => void;
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
  const { placed, spots } = useMemo(() => {
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
    return { placed: propList, spots: spotList };
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
          {graphics.grid && <FloorGrid scene={scene} palette={palette} />}
          {scene.walls.map((wall, i) => (
            <WallSegment key={i} wall={wall} offset={offset} palette={palette} />
          ))}
        </group>
        {/* Мебель ждёт своих моделей одним общим `Suspense`: пока набор не
            приехал, комната стоит пустой, но стены и пол уже нарисованы. */}
        <Suspense fallback={null}>
          <FurnitureModels>
            <Props3D items={placed} palette={palette} offset={offset} size={scene.size} />
            <Hotspots3D
              spots={spots} layout={layout} palette={palette} offset={offset}
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
    </div>
  );
}

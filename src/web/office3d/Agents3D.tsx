/**
 * Человечки в трёхмерном офисе — шаг 4.
 *
 * Фигура взята готовая: Kenney «Animated Characters Protagonists» (CC0,
 * `design/models/characters/LICENSE.txt`) — скелет с анимациями. Это прототип,
 * как и мебель из примитивов: важно проверить не то, как нарисован человек, а
 * ходит ли он по настоящим путям, садится ли на настоящие места и читается ли
 * сцена, когда по ней движутся восемь фигур.
 *
 * Логика ходьбы не тронута вовсе. Стор как считал путь по `findPath` и слал
 * `pos[id] = { x, y, ms }` — «иди в эту точку за столько миллисекунд», — так и
 * шлёт; плоский рендер проигрывает это WAAPI-анимацией, здесь то же самое
 * делает `useFrame`. Офис остаётся визуализацией событий, а не их источником
 * (CONCEPT.md §2).
 */
import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import charUrl from '../../../design/models/characters/characterMedium.fbx?url';
import idleUrl from '../../../design/models/characters/animations/idle.fbx?url';
import runUrl from '../../../design/models/characters/animations/run.fbx?url';
import { deskPoint } from '../../shared/layout';
import type { Layout } from '../../shared/layout';
import { catalog } from '../layoutData';
import { useStore } from '../store';
import type { InstanceView } from '../../shared/types';

const skinModules = import.meta.glob('../../../design/models/characters/skins/*.png', {
  eager: true, query: '?url', import: 'default',
}) as Record<string, string>;
const SKINS = Object.entries(skinModules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url);

/**
 * Рост фигуры в тайлах. Тайл — примерно 0.75 м (столешница шириной два тайла
 * это 1.5 м), человек — 1.75 м, отсюда 2.3. Плоский спрайт человечка был
 * ростом в полтора тайла, то есть заметно ниже стола: в виде сверху это не
 * мешало, а в объёме сразу бы бросилось в глаза.
 */
const AGENT_TALL = 2.3;

/**
 * Спрайт человечка в раскладке ставится левым верхним углом (`pos` и слоты
 * `work` — это его координаты), а модель стоит ногами: по горизонтали ноги
 * приходятся на середину спрайта шириной в тайл.
 *
 * По вертикали смещение меньше высоты спрайта (1.5), и намеренно. В виде
 * сверху нижняя часть фигуры честно заезжала на стол — так и рисуют человека
 * за рабочим местом, стол просто закрывает его снизу. В объёме такой наезд
 * превращается в тело внутри столешницы, поэтому ноги ставятся туда, где у
 * плоского спрайта примерно пояс: фигура оказывается вплотную к столу, но
 * снаружи него.
 */
const FOOT_DX = 0.5;
const FOOT_DY = 1.05;

/**
 * В наборе нет анимации шага — только `idle`, `run` и прыжок. Бег,
 * замедленный до этой доли скорости, читается как деловой шаг; настоящую
 * ходьбу принесут финальные модели.
 */
const WALK_TIMESCALE = 0.6;

/** Ниже этого расстояния до цели (тайлы) считаем, что агент стоит. */
const MOVING_EPS = 0.02;

/** Скорость доворота фигуры, радиан в секунду. */
const TURN_SPEED = 9;

/**
 * Модель смотрит вдоль своей оси Z; в какую сторону — свойство конкретного
 * набора, а не общее правило, поэтому вынесено сюда: с другим набором
 * поменяется одно это число.
 */
const MODEL_YAW = Math.PI;

/** Куда повёрнут агент, когда стоит: столы в раскладке не повёрнуты, и место
 *  `work` у них с северной стороны — значит, сидящий смотрит на юг. */
const REST_YAW = 0;

interface Loaded {
  model: THREE.Group;
  idle: THREE.AnimationClip;
  walk: THREE.AnimationClip;
}

function useCharacter(): Loaded {
  const [model, idleFbx, runFbx] = useLoader(FBXLoader, [charUrl, idleUrl, runUrl]);
  return useMemo(() => ({
    model: model as unknown as THREE.Group,
    idle: (idleFbx as unknown as THREE.Group).animations[0],
    walk: (runFbx as unknown as THREE.Group).animations[0],
  }), [model, idleFbx, runFbx]);
}

/**
 * Материалы по скинам — один на скин, а не на агента: скинов четыре, агентов
 * может быть вдвое больше, а текстура у них общая.
 */
function useSkinMaterials(): THREE.Material[] {
  const textures = useLoader(THREE.TextureLoader, SKINS);
  return useMemo(() => (textures as THREE.Texture[]).map((map) => {
    map.colorSpace = THREE.SRGBColorSpace;
    // Текстуры Kenney — плашки плоского цвета без градиентов: сглаживание
    // при уменьшении только мылит их и перемешивает соседние плашки.
    map.magFilter = THREE.NearestFilter;
    map.flipY = false;
    return new THREE.MeshLambertMaterial({ map });
  }), [textures]);
}

/**
 * Один человечек.
 *
 * Позиция интерполируется от **текущей видимой** точки к новой цели, а не от
 * прежней цели: путь перебивается на середине отрезка (агент шёл на кухню, а
 * его позвали на совещание), и отсчёт от старой цели дёрнул бы фигуру назад.
 * Это ровно то же соображение, что у WAAPI-анимации в плоском рендере
 * (`Office.tsx`), только там текущую точку приходится вычитывать из
 * `getComputedStyle`, а здесь она просто лежит в объекте сцены.
 */
function Agent({ inst, loaded, material, layout, offset }: {
  inst: InstanceView;
  loaded: Loaded;
  material: THREE.Material;
  layout: Layout;
  offset: [number, number];
}) {
  const pos = useStore((s) => s.pos[inst.id]);
  const group = useRef<THREE.Group>(null);

  const figure = useMemo(() => {
    // Клонировать скелет обычным `clone()` нельзя: у копий остались бы кости
    // оригинала и все агенты двигались бы как один.
    const copy = cloneSkinned(loaded.model);
    const box = new THREE.Box3().setFromObject(copy);
    const scale = AGENT_TALL / Math.max(box.max.y - box.min.y, 1e-6);
    copy.scale.setScalar(scale);
    copy.rotation.y = MODEL_YAW;
    copy.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.material = material;
        o.castShadow = true;
        // Принимать тени фигуре незачем: сама на себя она их почти не
        // отбрасывает, а лишний проход по скиннингу не бесплатный.
        o.receiveShadow = false;
      }
    });
    return copy;
  }, [loaded.model, material]);

  const mixer = useMemo(() => new THREE.AnimationMixer(figure), [figure]);
  const actions = useMemo(() => {
    const idle = mixer.clipAction(loaded.idle);
    const walk = mixer.clipAction(loaded.walk);
    walk.timeScale = WALK_TIMESCALE;
    idle.play();
    return { idle, walk };
  }, [mixer, loaded.idle, loaded.walk]);

  useEffect(() => () => {
    mixer.stopAllAction();
    mixer.uncacheRoot(figure);
  }, [mixer, figure]);

  /** Цель в мировых координатах и сколько секунд на неё отведено. */
  const target = useRef(new THREE.Vector3());
  const remain = useRef(0);
  const walking = useRef(false);
  const yaw = useRef(REST_YAW);

  /**
   * Где агент на самом деле стоит. Пока он «дома» за своим столом, стор
   * держит в `pos` координату самого стола, а не место человека: нужный
   * отступ внутри клетки задан слотом `work` в каталоге. Плоский рендер
   * делает ровно ту же подстановку (`workPointOf` в Office.tsx).
   */
  const raw = pos ?? { x: inst.desk.x, y: inst.desk.y, ms: 0 };
  const atDesk = raw.x === inst.desk.x && raw.y === inst.desk.y;
  const point = atDesk ? deskPoint(layout, catalog, inst.desk.index, 'work') : raw;
  const px = point.x + FOOT_DX + offset[0];
  const pz = point.y + FOOT_DY + offset[1];
  const ms = pos?.ms ?? 0;

  useEffect(() => {
    target.current.set(px, 0, pz);
    remain.current = ms / 1000;
    const g = group.current;
    if (!g) return;
    // Первое появление и телепорт (ms = 0) — без анимации: агента ещё нигде
    // не было, вести его через всю комнату было бы неправдой.
    if (ms === 0 || g.position.lengthSq() === 0) g.position.copy(target.current);
  }, [px, pz, ms]);

  useFrame((_, dt) => {
    mixer.update(dt);
    const g = group.current;
    if (!g) return;

    const dist = g.position.distanceTo(target.current);
    if (remain.current > 0 && dist > MOVING_EPS) {
      // Доля пути, которую надо пройти за этот кадр, чтобы уложиться в
      // оставшееся время. Пересчёт от остатка, а не от общей длительности,
      // сам справляется с просевшим кадром и со сменой цели на ходу.
      g.position.lerp(target.current, Math.min(1, dt / remain.current));
      const dx = target.current.x - g.position.x;
      const dz = target.current.z - g.position.z;
      if (dx * dx + dz * dz > 1e-6) yaw.current = Math.atan2(dx, dz);
      remain.current -= dt;
      if (!walking.current) {
        walking.current = true;
        actions.walk.reset().crossFadeFrom(actions.idle, 0.2, false).play();
      }
    } else {
      g.position.copy(target.current);
      remain.current = 0;
      yaw.current = REST_YAW;
      if (walking.current) {
        walking.current = false;
        actions.idle.reset().crossFadeFrom(actions.walk, 0.25, false).play();
      }
    }

    // Доворот по кратчайшей дуге: без нормализации разницы фигура на переходе
    // через π крутанулась бы вокруг себя.
    let delta = yaw.current - g.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    g.rotation.y += delta * Math.min(1, dt * TURN_SPEED);
  });

  return (
    <group ref={group}>
      <primitive object={figure} />
    </group>
  );
}

function Crowd({ offset }: { offset: [number, number] }) {
  const instances = useStore((s) => s.instances);
  const layout = useStore((s) => s.layout);
  const loaded = useCharacter();
  const materials = useSkinMaterials();
  const list = Object.values(instances);

  return (
    <>
      {list.map((inst, i) => (
        <Agent
          key={inst.id}
          inst={inst}
          loaded={loaded}
          material={materials[i % materials.length]}
          layout={layout}
          offset={offset}
        />
      ))}
    </>
  );
}

/**
 * Модели грузятся асинхронно, поэтому вся толпа висит на Suspense: пока файлы
 * не пришли, комната уже нарисована и просто стоит пустой — это честнее, чем
 * держать сцену чёрной до последнего килобайта.
 */
export function Agents3D({ offset }: { offset: [number, number] }) {
  return (
    <Suspense fallback={null}>
      <Crowd offset={offset} />
    </Suspense>
  );
}

/**
 * Окно в проёме стены — модель `design/models/furniture/window.glb` вместо
 * плоского «стекла» (`Box3.glass` из `geometry.ts`). Проём и его размеры
 * по-прежнему считает `geometry.ts`, этот модуль только вписывает в него
 * готовую модель или, если та не загрузилась, прежний плоский вариант,
 * который вызывающий код (`Office3D.tsx`) передаёт сюда через `fallback`.
 *
 * Модель садится в проём один к одному: дырка в стене вырезана по внешнему
 * контуру окна (габариты всей модели вместе с рамой, `WINDOW_MODEL_SIZE` в
 * `geometry.ts`), поэтому раму больше не нужно рисовать крупнее проёма с
 * нахлёстом на стену (T-97).
 */
import { Component, Suspense, useMemo, useState, type ReactNode } from 'react';
import { useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WINDOW_ASPECT } from './geometry';
import windowUrl from '../../../design/models/furniture/window.glb?url';

/**
 * Насколько замеренная модель может разойтись с числами в `geometry.ts`,
 * прежде чем ругаться: 2% — это уже другая модель, а не погрешность замера.
 */
const ASPECT_TOLERANCE = 0.02;

/** Окон в офисе много, а модель у них одна: ругаться стоит один раз. */
let aspectWarned = false;

/**
 * Падение при загрузке модели не должно ронять всю сцену — только это
 * окно откатывается к прежнему стеклу. Тот же приём, что и у `AgentAvatar`
 * (класс-обёртка: `Suspense` ловит ожидание, `componentDidCatch` — саму
 * ошибку загрузки).
 */
class Boundary extends Component<{ onError: () => void; children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError() { return { crashed: true }; }
  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error('окно: window.glb не загрузилось, показываю прежнее стекло', error);
    this.props.onError();
  }
  render() { return this.state.crashed ? null : this.props.children; }
}

function WindowModel({ width, height, depth, position, rotationY }: {
  width: number;
  height: number;
  depth: number;
  position: [number, number, number];
  rotationY: number;
}) {
  const gltf = useLoader(GLTFLoader, windowUrl);
  // Клон на каждое окно: сцена одна на файл, а окон в офисе может быть
  // сколько угодно — общий объект держал бы одну матрицу на всех разом
  // (тот же приём, что у мебели в `Props3D.tsx`).
  const object = useMemo(() => {
    const scene = gltf.scene.clone(true);
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    // Центр модели — в начало координат, чтобы дальше сажать её в проём по
    // его собственному центру, не гадая, как автор модели её разместил.
    scene.position.sub(center);
    // Проём в стене вырезан по этому самому габариту (`WINDOW_MODEL_SIZE` в
    // geometry.ts), поэтому модель садится в него один к одному: рама видна
    // целиком и никуда не утопает. Если файл модели подменят, числа в
    // geometry.ts протухнут молча — поэтому замер тут же и сверяется.
    if (!aspectWarned
      && Math.abs(size.y / (size.x || 1) - WINDOW_ASPECT) > WINDOW_ASPECT * ASPECT_TOLERANCE) {
      aspectWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        `окно: пропорция модели ${(size.y / (size.x || 1)).toFixed(3)} разошлась с ` +
        `WINDOW_ASPECT ${WINDOW_ASPECT.toFixed(3)} из geometry.ts — перемерьте проём`,
      );
    }
    const group = new THREE.Group();
    group.userData.window = true;
    group.add(scene);
    group.scale.set(
      width / (size.x || 1),
      height / (size.y || 1),
      depth / (size.z || 1),
    );
    return group;
  }, [gltf]);
  return <primitive object={object} position={position} rotation={[0, rotationY, 0]} />;
}

export interface Window3DProps {
  /** ширина проёма вдоль стены, тайлы — она же ширина модели вместе с рамой */
  width: number;
  /** высота проёма, тайлы — она же высота модели вместе с рамой */
  height: number;
  /** сколько модель занимает по толщине стены, тайлы — чуть меньше
   *  `WALL_THICK`, чтобы не спорить гранями с соседними коробками стены */
  depth: number;
  position: [number, number, number];
  /** доворот модели по оси Y: у вертикальной стены проём тянется по Z
   *  плана, у горизонтальной — по X, ширина модели по умолчанию идёт по X */
  rotationY: number;
  /** прежнее плоское стекло — показывается, пока модель грузится, и
   *  остаётся насовсем, если загрузка упала */
  fallback: ReactNode;
}

export function Window3D({ width, height, depth, position, rotationY, fallback }: Window3DProps) {
  const [broken, setBroken] = useState(false);
  if (broken) return <>{fallback}</>;
  return (
    <Boundary onError={() => setBroken(true)}>
      <Suspense fallback={fallback}>
        <WindowModel width={width} height={height} depth={depth} position={position} rotationY={rotationY} />
      </Suspense>
    </Boundary>
  );
}

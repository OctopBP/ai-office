/**
 * Окно в проёме стены — модель `design/models/furniture/window.glb` вместо
 * плоского «стекла» (`Box3.glass` из `geometry.ts`). Проём и его размеры
 * по-прежнему считает `geometry.ts`, этот модуль только вписывает в него
 * готовую модель или, если та не загрузилась, прежний плоский вариант,
 * который вызывающий код (`Office3D.tsx`) передаёт сюда через `fallback`.
 */
import { Component, Suspense, useMemo, useState, type ReactNode } from 'react';
import { useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import windowUrl from '../../../design/models/furniture/window.glb?url';

/**
 * Насколько рама модели шире и выше самого проёма. Больше единицы: у
 * настоящего окна рама (откос) перекрывает край проёма, а не подрезана
 * впритык к дырке в стене. Кладётся на соседние коробки стены (подоконник,
 * перемычка), а не в пустоту — те того же цвета, что и рама, поэтому
 * нахлёст не виден.
 */
const FRAME_OVERHANG = 1.12;

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
    const group = new THREE.Group();
    group.userData.window = true;
    group.add(scene);
    group.scale.set(
      (width * FRAME_OVERHANG) / (size.x || 1),
      (height * FRAME_OVERHANG) / (size.y || 1),
      depth / (size.z || 1),
    );
    return group;
  }, [gltf]);
  return <primitive object={object} position={position} rotation={[0, rotationY, 0]} />;
}

export interface Window3DProps {
  /** ширина проёма вдоль стены, тайлы */
  width: number;
  /** высота проёма, тайлы */
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

/**
 * Просмотр 3D-моделей (.glb, .gltf) в разделе «Результат».
 *
 * Грузится лениво — `React.lazy` в `viewers.tsx` подключает этот файл только
 * когда открыт файл вида `model3d`: three.js и его загрузчик тяжелее любого
 * другого просмотрщика, и тащить их в первый экран ради файла, который
 * открывают редко, незачем.
 *
 * Сцена — не через `useLoader`/`Suspense`, как мебель офиса (`Props3D.tsx`):
 * там набор моделей известен заранее и грузится один раз на всё время жизни
 * приложения, а здесь модель произвольная и меняется файл за файлом, и нужен
 * собственный цикл «загрузка → готово → ошибка» с явным освобождением
 * ресурсов предыдущей модели — тем же приёмом, что и `useFileText` в
 * `viewers.tsx`.
 */
import { useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { locale, t } from '../i18n';
import { DownloadViewer, type ViewerProps } from './viewers';

/** Поле обзора камеры — угол, под который вписывается модель. */
const FOV = 45;
/** Запас вокруг габаритов модели, чтобы она не упиралась в край кадра. */
const FIT_MARGIN = 1.6;

/**
 * Сервер помечает видом `model3d` не только `.glb`/`.gltf`, но и более редкие
 * форматы (`.obj`, `.stl`, `.3mf`, `.usdz`, `.fbx`, `.ply` — taskfiles.ts):
 * `GLTFLoader` их не разберёт. Для них честнее сразу отдать «скачать», чем
 * запускать заведомо неудачную загрузку ради состояния ошибки.
 */
function isGltfPath(path: string): boolean {
  return /\.(glb|gltf)$/i.test(path);
}

interface ModelView {
  size: THREE.Vector3;
  center: THREE.Vector3;
  triangles: number;
  cameraPos: [number, number, number];
  near: number;
  far: number;
  target: [number, number, number];
  gridY: number;
  gridSize: number;
}

/**
 * Освобождает геометрию, материалы и их текстуры.
 *
 * Без этого они остаются в памяти видеокарты и после того, как модель ушла
 * с экрана — сцена React исчезает, а буферы WebGL сами не знают, что стали
 * не нужны.
 */
function disposeScene(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) {
      for (const key of Object.keys(mat)) {
        const value = (mat as unknown as Record<string, unknown>)[key];
        if (value instanceof THREE.Texture) value.dispose();
      }
      mat.dispose();
    }
  });
}

/** Габариты, число треугольников и параметры камеры, вписывающей модель в кадр. */
function analyze(root: THREE.Object3D): ModelView {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const distance = (maxDim / (2 * Math.tan((FOV * Math.PI) / 360))) * FIT_MARGIN;
  const dir = new THREE.Vector3(1, 0.7, 1).normalize();
  const cameraPos = center.clone().addScaledVector(dir, distance);

  let triangles = 0;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geo = obj.geometry;
    const count = geo.index ? geo.index.count : (geo.attributes.position?.count ?? 0);
    triangles += count / 3;
  });

  return {
    size,
    center,
    triangles: Math.round(triangles),
    cameraPos: cameraPos.toArray() as [number, number, number],
    near: Math.max(distance / 100, 0.01),
    far: distance * 100,
    target: center.toArray() as [number, number, number],
    gridY: box.min.y,
    gridSize: maxDim * 4,
  };
}

/**
 * Загрузка одного файла модели. Своё состояние, а не `useLoader`: адрес
 * файла меняется от клика к клику, и у каждой загрузки должен быть явный
 * момент «предыдущая модель точно не нужна» для `disposeScene`.
 */
function useModel(url: string, skip: boolean) {
  const [state, setState] = useState<{ scene: THREE.Object3D | null; error: string | null }>({
    scene: null,
    error: null,
  });

  useEffect(() => {
    if (skip) return;
    let alive = true;
    setState({ scene: null, error: null });
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf: GLTF) => {
        // Пока файл грузился, окно просмотра переключилось на другой — эта
        // модель никогда не попадёт на экран, и держать её незачем.
        if (!alive) { disposeScene(gltf.scene); return; }
        setState({ scene: gltf.scene, error: null });
      },
      undefined,
      (err: unknown) => {
        if (alive) setState({ scene: null, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => { alive = false; };
  }, [url, skip]);

  // Смена файла и уход со страницы освобождают именно ту модель, что была
  // на экране: зависимость от `state.scene`, а не от `url`, ловит оба случая.
  useEffect(() => {
    const scene = state.scene;
    if (!scene) return;
    return () => disposeScene(scene);
  }, [state.scene]);

  return state;
}

function formatDims(size: THREE.Vector3): string {
  const fmt = (v: number) => v.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}`;
}

/** Полоска под просмотром: габариты и число треугольников. */
function ModelInfo({ view }: { view: ModelView }) {
  return (
    <div className="result-3d-info">
      <span>{t('result.model3d.dimsLabel')}: {formatDims(view.size)} {t('result.model3d.unit')}</span>
      <span>{t('result.model3d.triangles', { n: view.triangles })}</span>
    </div>
  );
}

/** Сцена в кадре: нейтральный свет, сетка пола под моделью и облёт мышью. */
function ModelScene({ scene, view }: { scene: THREE.Object3D; view: ModelView }) {
  return (
    <Canvas
      className="result-3d-canvas"
      flat
      camera={{ position: view.cameraPos, fov: FOV, near: view.near, far: view.far }}
      style={{ background: 'var(--canvas)' }}
    >
      <ambientLight intensity={1} />
      <directionalLight
        position={[view.center.x + view.size.x, view.center.y + view.size.y * 2 + 2, view.center.z + view.size.z]}
        intensity={1.3}
      />
      <directionalLight
        position={[view.center.x - view.size.x, view.center.y + 1, view.center.z - view.size.z]}
        intensity={0.5}
      />
      {/* Цвета сетки — те же нейтральные тона, что и `--hairline`/`--ink-4` в
          tokens.css: материалы three.js не читают CSS-переменные, поэтому
          значения продублированы числом. */}
      <gridHelper args={[view.gridSize, 20, '#b9bcc4', '#dcdee3']} position={[view.target[0], view.gridY, view.target[2]]} />
      <primitive object={scene} />
      <OrbitControls makeDefault target={view.target} enableDamping dampingFactor={0.12} />
    </Canvas>
  );
}

export default function Model3dViewer({ taskId, file, url }: ViewerProps) {
  const supported = isGltfPath(file.path);
  const { scene, error } = useModel(url, !supported);
  const view = useMemo(() => (scene ? analyze(scene) : null), [scene]);

  if (!supported) {
    return <DownloadViewer taskId={taskId} file={file} url={url} />;
  }
  if (error) {
    return <DownloadViewer taskId={taskId} file={file} url={url} note={t('result.model3d.error')} />;
  }
  if (!scene || !view) {
    return <p className="muted result-note">{t('result.loading')}</p>;
  }
  return (
    <div className="result-3d">
      <ModelScene scene={scene} view={view} />
      <ModelInfo view={view} />
    </div>
  );
}

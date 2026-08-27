/**
 * Выбор внешности агента в форме роли — теми же моделями, что стоят в комнате.
 *
 * Раньше здесь лежали плоские спрайты, и выбор ими врал: комната
 * трёхмерная, скинов у персонажа четыре, а спрайтов в наборе десять — восемь
 * вариантов из десяти показывали в офисе совсем не того человечка, которого
 * выбрали в форме. Поэтому вариантов ровно столько, сколько скинов, и
 * показаны они самой моделью.
 *
 * Каждая карточка — отдельный маленький холст. Один холст с четырьмя
 * фигурами был бы дешевле по памяти, но тогда подпись и рамку выбранного
 * варианта пришлось бы совмещать с фигурой наложением поверх сцены — то
 * есть держать разметку на совпадении координат с трёхмерной камерой.
 *
 * Фигуры живые, а не замершие на кадре покоя. Кадр по требованию был бы
 * дешевле, но заказанный один раз кадр приходит пустым: холст успевает
 * появиться раньше, чем модель попадает в сцену, — а гоняться за нужным
 * моментом ради экономии на четырёх фигурах размером с ноготь не стоит того.
 */
import { Suspense, useMemo } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import charUrl from '../../../design/models/characters/character.fbx?url';
import idleUrl from '../../../design/models/characters/animations/idle.fbx?url';
import { LOOKS } from '../../shared/looks';
import { has, t } from '../i18n';
import { useStore } from '../store';
import { useSkinMaterials } from './Agents3D';
import { paletteOf } from './palette';

/** Рост фигуры в превью. Единица — чтобы камера считалась от неё, а не наоборот. */
const TALL = 1;

/** Одна фигура: клон скелета с текстурой скина, переминающийся с ноги на ногу. */
function Figure({ look, phase }: { look: string; phase: number }) {
  const [model, idle] = useLoader(FBXLoader, [charUrl, idleUrl]) as unknown as THREE.Group[];
  const materials = useSkinMaterials();

  const { figure, mixer } = useMemo(() => {
    // Клон скелета, а не сама модель: она одна на все четыре холста и на
    // комнату заодно — общий микшер сдвинул бы позу всем сразу.
    const object = cloneSkinned(model);
    const box = new THREE.Box3().setFromObject(object);
    object.scale.setScalar(TALL / Math.max(box.max.y - box.min.y, 1e-6));
    object.traverse((o) => {
      if (o instanceof THREE.Mesh) o.material = materials[look];
    });
    const anim = new THREE.AnimationMixer(object);
    const action = anim.clipAction(idle.animations[0]);
    action.play();
    // Своя секунда цикла у каждой карточки: четыре фигуры, дышащие в такт,
    // читаются как одна анимация, размноженная копированием.
    anim.setTime(phase * action.getClip().duration);
    return { figure: object, mixer: anim };
  }, [model, idle, materials, look, phase]);

  useFrame((_, dt) => mixer.update(dt));

  // Фигура стоит ногами в нуле, а смотреть на неё удобно в пояс — камера
  // глядит в начало координат, поэтому опускаем её на половину роста.
  return <primitive object={figure} position={[0, -TALL / 2, 0]} />;
}

/** Свет превью — тот же, что общий свет комнаты, чтобы скин не выглядел иначе. */
function Light() {
  const theme = useStore((s) => s.theme);
  const light = paletteOf(theme).light;
  return (
    <>
      <hemisphereLight args={[light.skyColor, light.groundColor, light.ambient]} />
      <directionalLight
        position={[-2, 3, 4]} color={light.keyColor} intensity={light.keyIntensity * 0.6}
      />
      <directionalLight
        position={[3, 1, 2]} color={light.fillColor} intensity={light.fillIntensity * 2}
      />
    </>
  );
}

/**
 * Сетка внешностей. `value` — то, что выбрано у роли; пусто или старое
 * значение из сохранённого офиса означает «не выбрано ничего», и тогда
 * внешность подбирается по id роли.
 */
export function LookPicker({ value, onPick }: {
  value: string | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <div className="look-grid">
      {LOOKS.map((look, i) => {
        const key = `look.${look.id}`;
        const label = has(key) ? t(key) : look.id;
        return (
          <button
            key={look.id} type="button"
            className={`look-swatch ${value === look.id ? 'on' : ''}`}
            title={label} onClick={() => onPick(look.id)}
          >
            <span className="look-figure">
              <Canvas
                dpr={[1, 2]}
                // Персонаж смотрит в +Z, поэтому камера стоит перед ним и
                // немного сбоку: анфас плоский, а три четверти показывают и
                // лицо, и одежду на боку.
                camera={{ position: [0.5, 0.18, 2.15], fov: 32 }}
              >
                <Light />
                <Suspense fallback={null}>
                  <Figure look={look.id} phase={i / LOOKS.length} />
                </Suspense>
              </Canvas>
            </span>
            <span className="look-name">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

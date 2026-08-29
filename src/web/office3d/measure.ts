/**
 * Замеры ассетов — то, что раньше подбиралось руками, а на самом деле
 * считается.
 *
 * Два вопроса, на которые здесь отвечают числами:
 *
 * — **где у позы части тела**. Клипы Mixamo нарисованы под человека обычного
 *   сложения, а перенесены на мультяшный скелет с короткими ногами; сколько
 *   от этого потерял таз и куда уехали кисти — видно только замером. Меряется
 *   в долях роста, а не в тайлах: рост — ручка подгонки, и от её движения
 *   замер меняться не должен;
 *
 * — **где у мебели поверхности**. Высота сиденья и высота столешницы берутся
 *   лучом по самой модели, а не из каталога: в каталоге написан габарит
 *   предмета, а сесть надо на подушку.
 *
 * Всё считается один раз при загрузке — не в кадре. Заменили модель стула или
 * перезалили клип — числа приедут новые сами, без единой правки в коде.
 */
import { useMemo } from 'react';
import { useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MODEL_SCALE } from './props';
import { MODEL_KEYS, MODEL_LIST, PARTS } from './presets';

/**
 * Имена костей — свойство конкретного набора, а не общее правило, поэтому
 * собраны в одном месте: с другим персонажем поменяется эта таблица, а не
 * логика замера. Скелет здесь миксамовский, но без приставки `mixamorig` —
 * Kenney её срезали.
 */
export const BONES = {
  hips: 'Hips',
  hands: ['LeftHand', 'RightHand'] as const,
  feet: ['LeftFoot', 'RightFoot'] as const,
  arms: [
    { upper: 'LeftArm', lower: 'LeftForeArm', hand: 'LeftHand' },
    { upper: 'RightArm', lower: 'RightForeArm', hand: 'RightHand' },
  ],
} as const;

/** Сколько кадров клипа опрашивать. Тридцати хватает: меряем не форму
 *  движения, а где оно происходит. */
const SAMPLES = 30;

/**
 * Замер позы. Все длины — в долях роста фигуры: 0 это пол, 1 — макушка.
 */
export interface PoseMeasure {
  /** Таз, усреднённый по клипу. */
  hips: [number, number, number];
  /** Середина между кистями, усреднённая по клипу. */
  hands: [number, number, number];
  /** Нижняя точка кости стопы за клип — она же «стопа стоит на полу». */
  footY: number;
  /**
   * Сколько ростов проходит корпус за один цикл клипа. Считается по ходу
   * стопы вдоль тела: в цикле два шага, а шаг — это путь опорной стопы
   * назад. У клипов, где никто никуда не идёт, число бессмысленно и равно
   * почти нулю.
   */
  cycle: number;
}

/**
 * Померить клипы на копии фигуры.
 *
 * Копия обязательна: замер проигрывает клипы один за другим и крутит кости,
 * а та же самая фигура в это время стоит в комнате. Копия живёт только
 * внутри вызова.
 */
export function measurePoses<K extends string>(
  model: THREE.Object3D, clips: Record<K, THREE.AnimationClip>,
): Record<K, PoseMeasure> {
  const figure = cloneSkinned(model);
  figure.position.set(0, 0, 0);
  figure.rotation.set(0, 0, 0);
  const box = new THREE.Box3().setFromObject(figure);
  // Приводим к единичному росту — тогда замер не зависит от ручки роста.
  figure.scale.setScalar(1 / Math.max(box.max.y - box.min.y, 1e-6));

  const mixer = new THREE.AnimationMixer(figure);
  const bone = (name: string) => figure.getObjectByName(name);
  const world = new THREE.Vector3();
  const at = (name: string): THREE.Vector3 => {
    const b = bone(name);
    return b ? b.getWorldPosition(world.clone()) : new THREE.Vector3();
  };

  const out = {} as Record<K, PoseMeasure>;
  for (const key of Object.keys(clips) as K[]) {
    const clip = clips[key];
    const action = mixer.clipAction(clip);
    mixer.stopAllAction();
    action.reset().setEffectiveWeight(1).play();

    const hips = new THREE.Vector3();
    const hands = new THREE.Vector3();
    let footY = Infinity;
    let footMin = Infinity;
    let footMax = -Infinity;

    for (let i = 0; i < SAMPLES; i++) {
      mixer.setTime((clip.duration * i) / SAMPLES);
      figure.updateMatrixWorld(true);
      hips.add(at(BONES.hips));
      hands.add(at(BONES.hands[0])).add(at(BONES.hands[1]));
      for (const name of BONES.feet) {
        const p = at(name);
        footY = Math.min(footY, p.y);
        footMin = Math.min(footMin, p.z);
        footMax = Math.max(footMax, p.z);
      }
    }
    mixer.stopAllAction();
    mixer.uncacheClip(clip);

    hips.divideScalar(SAMPLES);
    hands.divideScalar(SAMPLES * 2);
    out[key] = {
      hips: [hips.x, hips.y, hips.z],
      hands: [hands.x, hands.y, hands.z],
      footY: Number.isFinite(footY) ? footY : 0,
      // Два шага в цикле: пока одна стопа едет назад, вторая переносится.
      cycle: 2 * (footMax - footMin),
    };
  }
  return out;
}

/**
 * Куда ронять луч, чтобы найти поверхность у модели набора.
 *
 * Точка — в системе выровненной модели (середина по горизонтали, низ на
 * полу; так их ставит `PropModels`), в тайлах, минус — к спинке. Это знание о
 * модели, а не настройка: подушка у дивана там, где она нарисована, и
 * ползунком её не двигают. Высоту при этом не пишем — её и меряем.
 */
/** Высоты поверхностей модели в тайлах при масштабе набора «единица». */
export interface ModelMeasure {
  seat?: number;
  surface?: number;
  /** Габарит модели — стенду показать, что вообще приехало. */
  size: [number, number, number];
}

/**
 * Померить модель лучом сверху вниз. Луч — потому что габаритом высоту
 * сиденья не узнать: у стула габарит — это спинка, а сидят не на ней.
 */
export function measureModel(source: THREE.Object3D): ModelMeasure {
  const object = source.clone(true);
  object.position.set(0, 0, 0);
  object.rotation.set(0, 0, 0);
  object.scale.setScalar(MODEL_SCALE);
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  // Та же выкладка, что в `PropModels`: середина по горизонтали, низ на полу.
  object.position.set(
    -(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2,
  );
  object.updateMatrixWorld(true);

  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const from = new THREE.Vector3();
  const probe = (at: [number, number] | undefined): number | undefined => {
    if (!at) return undefined;
    ray.set(from.set(at[0], box.max.y - box.min.y + 1, at[1]), down);
    return ray.intersectObject(object, true)[0]?.point.y;
  };

  // Куда целиться — свойство модели, и лежит оно при части пресета. Раньше
  // здесь была таблица по имени файла: то же знание, но в другом файле, чем
  // всё остальное про эту модель.
  const p = PARTS[source.name]?.probe ?? {};
  return {
    seat: probe(p.seat),
    surface: probe(p.surface),
    size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
  };
}

/**
 * Замеры всего набора мебели.
 *
 * Модели грузятся тем же `useLoader`, что и в комнате, — а он кеширует по
 * ссылке, так что второй загрузки не происходит: те же самые сцены, только
 * померенные.
 */
/**
 * Померенное — по одному разу на набор, а не на того, кто спросил.
 *
 * Спрашивают многие: каждый агент в комнате и стенд. Замер не бесплатный
 * (клон модели плюс лучи), а ответ у всех один и тот же — модели-то те же.
 * Ключ — сам массив загруженных сцен: пока `useLoader` отдаёт его из кеша,
 * это одна и та же ссылка, а новая загрузка честно даст новый замер.
 */
const measured = new WeakMap<object, Record<string, ModelMeasure>>();

export function useModelMeasures(): Record<string, ModelMeasure> {
  const loaded = useLoader(GLTFLoader, MODEL_LIST) as unknown as { scene: THREE.Object3D }[];
  return useMemo(() => {
    const hit = measured.get(loaded);
    if (hit) return hit;
    const made: Record<string, ModelMeasure> = {};
    MODEL_KEYS.forEach((name, i) => {
      const scene = loaded[i].scene;
      // `measureModel` ищет точку луча по имени — у загруженной сцены оно
      // своё, из файла, и совпадать с нашим не обязано.
      scene.name = name;
      made[name] = measureModel(scene);
    });
    measured.set(loaded, made);
    return made;
  }, [loaded]);
}

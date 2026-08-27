/**
 * Обратная кинематика на две кости — как кисть достаёт до столешницы.
 *
 * Нужна она из-за пропорций. Клип печати нарисован под человека, у которого
 * от таза до кисти столько, сколько нужно столу высотой 77 сантиметров; у
 * нашего персонажа руки короче, и посадив его тазом на стул, кистями до
 * столешницы уже не дотянуться — разница около двадцати сантиметров.
 * Подобрать её сдвигом всей фигуры нельзя: подняв кисти на стол, поднимешь и
 * таз над стулом, и ступни над полом.
 *
 * Поэтому тело ставится тазом, а руки дотягиваются. Считается это не
 * итерациями, а один раз по теореме косинусов: две кости, известная цель —
 * дальше школьная тригонометрия. Плоскость сгиба берётся из клипа, поэтому
 * локоть остаётся там, куда его развернул аниматор, и рука не выворачивается.
 *
 * Решатель из `three/examples` (CCDIKSolver) не взят намеренно: он итеративный,
 * требует описания цепочки в самой модели и тянет заодно всё, что окажется в
 * цепи. Здесь достаточно пятидесяти строк, которые видно насквозь.
 */
import * as THREE from 'three';

/** Кости одной руки. */
export interface Arm {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
}

const A = new THREE.Vector3();
const B = new THREE.Vector3();
const C = new THREE.Vector3();
const T = new THREE.Vector3();
const u = new THREE.Vector3();
const v = new THREE.Vector3();
const axis = new THREE.Vector3();
const q = new THREE.Quaternion();
const swing = new THREE.Quaternion();
const parentQ = new THREE.Quaternion();
const worldQ = new THREE.Quaternion();

/**
 * Повернуть кость на заданный поворот в мировых координатах.
 *
 * Локальный поворот кости — это её положение относительно родителя, и просто
 * домножить его на мировой нельзя: у плеча родитель сам повёрнут. Поэтому
 * мировой поворот применяется к мировому же, а потом возвращается в местную
 * систему.
 */
function turn(bone: THREE.Object3D, rot: THREE.Quaternion): void {
  bone.getWorldQuaternion(worldQ);
  worldQ.premultiply(rot);
  bone.parent?.getWorldQuaternion(parentQ);
  bone.quaternion.copy(parentQ.invert().multiply(worldQ));
  bone.updateMatrixWorld(true);
}

/** Поворот, переводящий направление `from` в направление `to`. */
function between(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  return q.setFromUnitVectors(
    u.copy(from).normalize(),
    v.copy(to).normalize(),
  );
}

/**
 * Дотянуть кисть до точки `target` (мировые координаты).
 *
 * `weight` — насколько слушаться цели: 0 оставляет руку как в клипе, 1 кладёт
 * кисть точно в цель. Промежуточные значения нужны не для красоты, а для
 * переходов: включать IK рывком на первом кадре позы «печатает» — это
 * дёрнувшаяся рука.
 *
 * Возвращает false, если решать нечего или нечем: рука выпрямлена в струну
 * (плоскость сгиба неопределена) или цель совпала с кистью.
 */
export function reach(arm: Arm, target: THREE.Vector3, weight = 1): boolean {
  if (weight <= 0) return false;
  arm.upper.getWorldPosition(A);
  arm.lower.getWorldPosition(B);
  arm.hand.getWorldPosition(C);

  // Цель, ослабленная весом: тянем кисть от того места, где она сейчас.
  T.copy(C).lerp(target, Math.min(1, weight));

  const l1 = A.distanceTo(B);
  const l2 = B.distanceTo(C);
  if (l1 < 1e-6 || l2 < 1e-6) return false;

  // Ось сгиба — нормаль к плоскости, в которой рука лежит сейчас. Считается
  // до всех поворотов: после первого разворота плечо унесёт её с собой.
  axis.copy(u.copy(A).sub(B)).cross(v.copy(C).sub(B));
  if (axis.lengthSq() < 1e-12) return false;
  axis.normalize();

  // 1. Развернуть плечо так, чтобы кисть смотрела ровно на цель. Тем же
  //    поворотом уезжает и плоскость руки — иначе локоть согнётся в старой.
  swing.copy(between(u.copy(C).sub(A), v.copy(T).sub(A)));
  turn(arm.upper, swing);
  axis.applyQuaternion(swing);

  // 2. Согнуть локоть под нужный угол. Дистанция ограничена длиной руки:
  //    до цели дальше вытянутой руки не достать, и притворяться нечем —
  //    рука просто выпрямляется до предела.
  arm.lower.getWorldPosition(B);
  arm.hand.getWorldPosition(C);
  const d = THREE.MathUtils.clamp(
    A.distanceTo(T), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4,
  );
  const want = Math.acos(
    THREE.MathUtils.clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1),
  );
  const now = u.copy(A).sub(B).normalize().angleTo(v.copy(C).sub(B).normalize());
  turn(arm.lower, q.setFromAxisAngle(axis, want - now));

  // 3. Доводка: сгиб локтя увёл кисть в сторону, доворачиваем плечо ещё раз.
  arm.hand.getWorldPosition(C);
  turn(arm.upper, between(u.copy(C).sub(A), v.copy(T).sub(A)));
  return true;
}

/**
 * Камера трёхмерного офиса: облёт, наезд, фокус.
 *
 * Раньше камера была одной строкой `OrbitControls` с целью в начале
 * координат и выключенным панорамированием. Для «макета на столе» этого
 * хватало, но офис перестал быть макетом: в нём есть комнаты, в которых
 * что-то происходит, и человек, за которым хочется проследить. Смотреть на
 * всё это можно было только целиком — приблизившись, упираешься в центр
 * опенспейса, и дальше камеру не сдвинуть.
 *
 * Теперь цель камеры подвижна, а кто ею распоряжается — решает фокус
 * (`camera.ts`). Устройство одно на все режимы:
 *
 *  - **фокус даёт точку**, к которой цель едет с демпфированием. Обзор — центр
 *    раскладки, комната — её центр, агент — сам агент (и тогда цель едет за
 *    ним, пока он идёт);
 *  - **расстояние камера трогает только на перелёте** — когда фокус
 *    сменился. Долетев, она отдаёт наезд пользователю и больше в него не
 *    вмешивается: спорить с колесом мыши нельзя, это всегда проигрыш;
 *  - **угол облёта не трогает никогда**. Фокус отвечает на вопрос «куда
 *    смотрим», а не «откуда» — вращать сцену можно в любом режиме, и
 *    перелёт углы сохраняет.
 *
 * Ручное вмешательство сильнее фокуса: увёл камеру панорамированием или
 * стрелками — фокус становится `free`, и она стоит там, где поставили.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Layout } from '../../shared/layout';
import { useStore } from '../store';
import { WALL_H } from './geometry';
import { anchorOf } from './anchors';
import { focusRooms, roomTitle, useCamera, type Focus } from './camera';
import { t } from '../i18n';

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

/**
 * Угол обзора камеры, градусы. Камера перспективная, но с длиннофокусным
 * объективом: узкий угол с большого расстояния почти не искажает планировку —
 * дальняя стена лишь чуть заметно сходится к ближней, комната по-прежнему
 * читается как модель на столе. Широкий угол превратил бы её в фотографию
 * изнутри: план поплыл бы, а прямые ряды столов разъехались веером.
 *
 * Ноль здесь означал бы ортографию — ровно то, с чего начинали.
 */
export const FOV = 25;

/**
 * Пределы наезда колесом, тайлы. Нижний предел — не «сколько влезает в
 * кадр», а «насколько близко пускаем»: при узком угле обзора десять тайлов
 * до цели дают кадр высотой чуть больше четырёх — крупный план человека за
 * столом. Ближе начинается разглядывание полигонов.
 */
const MIN_DIST = 10;
const MAX_DIST = 400;

/** Высота кадра при фокусе на агенте, тайлы: человек ростом 2.3 занимает
 *  примерно четверть экрана — видно и его, и что вокруг него происходит. */
const AGENT_FRAME = 9;

/** Куда смотреть на агенте: не в ноги, а примерно в грудь. */
const AGENT_EYE = 1.2;

/** Запас по краю кадра при вписывании: 8% на то, чтобы стены не упирались
 *  в рамку, а подписи над крайними столами не обрезались. */
const FIT_MARGIN = 0.92;

/** Скорость подъезда цели к фокусу и расстояния к перелётному, 1/с.
 *  Демпфирование, а не линейное движение: перелёт должен затухать. */
const FOLLOW = 4.5;
const ZOOM = 3.5;

/**
 * Мёртвая зона слежения, тайлы. Без неё камера ловила бы каждое покачивание
 * фигуры в анимации простоя — цель дрожала бы на месте.
 */
const DEAD = 0.35;

/** Скорость панорамирования клавишами — доля расстояния до цели в секунду.
 *  Пропорционально наезду: вблизи шаг мелкий, издалека крупный. */
const PAN_RATE = 0.55;

/** Насколько далеко за габарит раскладки отпускаем цель. Немного — чтобы
 *  можно было заглянуть на крайний стол сбоку, но не потерять офис. */
const PAN_MARGIN = 4;

/** Клавиши панорамирования. Читаются по `code`, а не по `key`: раскладка
 *  клавиатуры на движение камеры влиять не должна. */
const PAN_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1], ArrowUp: [0, 1],
  KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

/** Расстояние, с которого коробка заданных полугабаритов заполняет кадр. */
function fitDist(
  half: [number, number, number],
  dir: THREE.Vector3,
  fov: number,
  aspect: number,
): number {
  // Ориентация камеры берётся не из неё самой: на первом кадре её ещё не
  // выставил OrbitControls, и матрица мира была бы от позиции без поворота.
  const probe = new THREE.Object3D();
  probe.position.copy(dir);
  probe.lookAt(0, 0, 0);
  probe.updateMatrixWorld();
  const inv = probe.matrixWorld.clone().invert();

  // Габарит коробки в экранных осях при этом повороте: восемь её углов
  // переводятся в систему координат камеры, берётся размах.
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

  // Размах берётся поперёк взгляда, а у комнаты есть и глубина вдоль него:
  // ближний край окажется чуть крупнее расчётного. При узком угле разница
  // мелкая, и её съедает тот же запас по краю.
  const halfFov = (fov * Math.PI) / 360;
  return Math.max(
    spanY / 2 / Math.tan(halfFov),
    spanX / 2 / (Math.tan(halfFov) * aspect),
  ) / FIT_MARGIN;
}

/**
 * Стартовая позиция камеры до первого вписывания. Точное расстояние сейчас
 * же посчитает риг, здесь важно лишь направление и чтобы камера не оказалась
 * внутри стен на первом кадре.
 */
export function startPose(size: [number, number]): [number, number, number] {
  const dist = Math.hypot(size[0], size[1]) * 3;
  return [
    Math.sin(START_POLAR) * Math.sin(START_AZIMUTH) * dist,
    Math.cos(START_POLAR) * dist,
    Math.sin(START_POLAR) * Math.cos(START_AZIMUTH) * dist,
  ];
}

/** Минимальный интерфейс OrbitControls — тот кусок, которым пользуется риг.
 *  Свой тип вместо импорта из three-stdlib: зависимость там транзитивная. */
interface Orbit {
  target: THREE.Vector3;
  zoomToCursor: boolean;
  update: () => void;
}

/** Габариты раскладки и комнат в мировых координатах (комната сдвинута так,
 *  чтобы её центр лежал в начале координат). */
function boxOf(
  focus: Focus,
  layout: Layout,
  size: [number, number],
  out: THREE.Vector3,
): [number, number, number] | null {
  const [w, d] = size;
  if (focus.kind === 'overview') {
    out.set(0, 0, 0);
    return [w / 2, WALL_H / 2, d / 2];
  }
  if (focus.kind === 'room') {
    const room = focusRooms(layout).find((r) => r.id === focus.id);
    if (!room) return null;
    const [x0, y0, x1, y1] = room.rect;
    out.set((x0 + x1) / 2 - w / 2, 0, (y0 + y1) / 2 - d / 2);
    return [(x1 - x0) / 2, WALL_H / 2, (y1 - y0) / 2];
  }
  if (focus.kind === 'agent') {
    const at = anchorOf(focus.id);
    if (!at) return null;
    out.set(at.x, AGENT_EYE, at.z);
    // Габарит фокуса на человеке не считается по комнате: расстояние до него
    // задано кадром (AGENT_FRAME), а не размером того, что вокруг.
    return [0, 0, 0];
  }
  return null;
}

function Rig({ layout, size, active }: {
  layout: Layout; size: [number, number];
  /** Вид «Офис» сейчас показан. Клавиши камеры (WASD, Shift+цифра) не
   *  должны перехватывать нажатия, пока пользователь смотрит доску или чат:
   *  слушатель висит на `window` и не выключается сам вместе с холстом. */
  active: boolean;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as unknown as Orbit | null;
  const gl = useThree((s) => s.gl);
  const viewport = useThree((s) => s.size);
  const focus = useCamera((s) => s.focus);
  const setFocus = useCamera((s) => s.setFocus);
  const selected = useStore((s) => s.selected);
  const rooms = useMemo(() => focusRooms(layout), [layout]);

  /** Точка, к которой едет цель. Отдельно от самой цели: между ними
   *  мёртвая зона слежения. */
  const goal = useRef(new THREE.Vector3());
  /** Перелёт: расстояние, к которому едем, и надо ли встать в него сразу
   *  (первый показ и вписывание при ресайзе — без анимации). */
  const fly = useRef<{ dist: number; snap: boolean } | null>(null);
  const keys = useRef(new Set<string>());
  const first = useRef(true);

  const want = useRef(new THREE.Vector3());
  const dir = useRef(new THREE.Vector3());
  const pan = useRef(new THREE.Vector3());

  /** Куда смотреть при этом фокусе; `false` — фокус ничего не говорит
   *  (свободный режим) или ещё не может сказать (агент не смонтирован). */
  const targetOf = useCallback((f: Focus, out: THREE.Vector3) => (
    boxOf(f, layout, size, out) !== null
  ), [layout, size]);

  // Выделение агента и есть фокус на нём: отдельной кнопки «следить» не
  // нужно — выбрали человека, значит смотрим на него. Снятие выделения
  // (Escape, повторный клик) возвращает обзор, но только если камера
  // действительно следила: уведённую руками камеру дёргать назад нельзя.
  useEffect(() => {
    const kind = useCamera.getState().focus.kind;
    if (selected) setFocus({ kind: 'agent', id: selected });
    else if (kind === 'agent') setFocus({ kind: 'overview' });
  }, [selected, setFocus]);

  // Смена фокуса — это перелёт: новая точка и новое расстояние. Размер
  // канваса в зависимостях, потому что вписывание считается от него: окно
  // растянули — офис должен снова заполнить кадр, ровно как в плоском
  // рендере (`Office.tsx`, ResizeObserver).
  useEffect(() => {
    if (focus.kind === 'free') return;
    const at = new THREE.Vector3();
    const half = boxOf(focus, layout, size, at);
    if (!half) return;
    if (viewport.width < 1 || viewport.height < 1) return;

    // Направление на камеру — то, что есть сейчас: перелёт сохраняет угол
    // облёта, меняются только точка и расстояние.
    const from = new THREE.Vector3().copy(camera.position).sub(controls?.target ?? at);
    if (from.lengthSq() < 1e-6) from.copy(camera.position);
    from.normalize();

    const dist = focus.kind === 'agent'
      ? AGENT_FRAME / 2 / Math.tan((FOV * Math.PI) / 360)
      : fitDist(half, from, FOV, viewport.width / viewport.height);

    fly.current = {
      dist: THREE.MathUtils.clamp(dist, MIN_DIST, MAX_DIST),
      // Первый показ — без анимации: комната должна открыться уже вписанной,
      // а не подъезжать к зрителю. Флаг снимается в кадре, который его
      // израсходовал: до появления OrbitControls риг вообще не работает.
      snap: first.current,
    };
  }, [focus, layout, size, camera, controls, viewport.width, viewport.height]);

  // Отсечение — по пределам наезда, а не по расстоянию до цели: расстояние
  // теперь меняется всё время, и пересчитывать матрицу проекции на каждый
  // щелчок колеса незачем.
  useEffect(() => {
    camera.near = 1;
    camera.far = MAX_DIST * 3;
    camera.updateProjectionMatrix();
  }, [camera]);

  // Наезд «в точку под курсором» — пока цель не ведёт риг. В слежении за
  // агентом он бы с ним дрался: колесо тянет цель к курсору, риг возвращает
  // её на агента.
  useEffect(() => {
    if (controls) controls.zoomToCursor = focus.kind !== 'agent';
  }, [controls, focus.kind]);

  // Что делает пользователь, то сильнее фокуса. Панорамирование (правая и
  // средняя кнопки) уводит цель — режим становится свободным; колесо
  // отменяет перелёт, чтобы камера не доезжала «сама» поверх наезда рукой.
  // При слежении за агентом колесо фокус не снимает: приблизиться к тому, за
  // кем следишь, — это не «уйти от него».
  useEffect(() => {
    const el = gl.domElement;
    const onWheel = () => {
      fly.current = null;
      if (focus.kind !== 'agent' && focus.kind !== 'free') setFocus({ kind: 'free' });
    };
    const onDown = (e: PointerEvent) => {
      // Правая кнопка — панорамирование: цель уезжает, и фокус её отпускает.
      // Средняя — наезд, как колесо: цель на месте, снимать фокус не за что.
      if (e.button === 1) { fly.current = null; return; }
      if (e.button !== 2) return;
      fly.current = null;
      if (focus.kind !== 'free') setFocus({ kind: 'free' });
    };
    // Двумя пальцами OrbitControls панорамирует и наезжает разом — считаем
    // это тем же уводом цели, что и правой кнопкой.
    const onTouch = (e: TouchEvent) => {
      if (e.touches.length < 2) return;
      fly.current = null;
      if (focus.kind !== 'free') setFocus({ kind: 'free' });
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('touchstart', onTouch, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('touchstart', onTouch);
    };
  }, [gl, focus.kind, setFocus]);

  // Клавиши: стрелки и WASD ведут камеру по полу, Shift+цифра — фокус на
  // комнате (Shift+0 — весь офис). Цифры без Shift заняты выбором агента
  // (`App.tsx`), поэтому Shift.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!active) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.shiftKey && /^Digit[0-9]$/.test(e.code)) {
        const n = Number(e.code.slice(5));
        if (n === 0) { useStore.getState().select(null); setFocus({ kind: 'overview' }); return; }
        const room = rooms[n - 1];
        if (!room) return;
        useStore.getState().select(null);
        setFocus({ kind: 'room', id: room.id });
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!PAN_KEYS[e.code]) return;
      // Стрелки иначе прокручивают страницу, а пробел-подобных клавиш здесь
      // нет, так что перехватываем только своё.
      e.preventDefault();
      keys.current.add(e.code);
      if (useCamera.getState().focus.kind !== 'free') setFocus({ kind: 'free' });
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => keys.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [rooms, setFocus, active]);

  useFrame((_, delta) => {
    if (!controls) return;
    // Вкладка была в фоне — кадр «длиной» в минуту не должен телепортировать
    // камеру: демпфирование от такого шага доезжает мгновенно.
    const dt = Math.min(delta, 0.1);
    let touched = false;

    // Угол облёта — то, что есть; риг двигает только точку и расстояние,
    // поэтому направление на камеру снимается до всех правок и возвращается
    // после них неизменным.
    dir.current.copy(camera.position).sub(controls.target);
    let dist = dir.current.length();
    if (dist < 1e-6) { dir.current.set(0, 1, 1).normalize(); dist = MIN_DIST; }
    else dir.current.divideScalar(dist);

    if (targetOf(focus, want.current)) {
      if (goal.current.distanceToSquared(want.current) > DEAD * DEAD) {
        goal.current.copy(want.current);
      }
      controls.target.lerp(goal.current, 1 - Math.exp(-FOLLOW * dt));
      touched = true;
    }

    if (keys.current.size) {
      // Вперёд — туда, куда смотрит камера, спроецировано на пол: «вверх»
      // по экрану должно вести вглубь комнаты при любом повороте.
      pan.current.set(-dir.current.x, 0, -dir.current.z);
      if (pan.current.lengthSq() < 1e-6) pan.current.set(0, 0, -1);
      pan.current.normalize();
      const speed = dist * PAN_RATE * dt;
      for (const code of keys.current) {
        const [rx, ry] = PAN_KEYS[code];
        controls.target.x += (pan.current.x * ry - pan.current.z * rx) * speed;
        controls.target.z += (pan.current.z * ry + pan.current.x * rx) * speed;
      }
      touched = true;
    }

    if (fly.current) {
      const to = fly.current.dist;
      if (fly.current.snap) { dist = to; fly.current.snap = false; first.current = false; }
      else dist = THREE.MathUtils.damp(dist, to, ZOOM, dt);
      if (Math.abs(dist - to) < to * 0.004) { dist = to; fly.current = null; }
      touched = true;
    }

    if (!touched) return;

    // Цель не выпускаем за раскладку: улететь в пустоту легко, а вернуться
    // оттуда, не видя офиса, нечем.
    const [w, d] = size;
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, -w / 2 - PAN_MARGIN, w / 2 + PAN_MARGIN);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -d / 2 - PAN_MARGIN, d / 2 + PAN_MARGIN);
    controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0, WALL_H);

    camera.position.copy(controls.target).addScaledVector(dir.current, dist);
    controls.update();
  });

  return null;
}

/** Камера сцены целиком: облёт с пределами и риг, который им управляет. */
export function Camera3D({ layout, size, active }: {
  layout: Layout; size: [number, number]; active: boolean;
}) {
  return (
    <>
      <OrbitControls
        makeDefault
        enablePan
        // Панорамирование по полу, а не по экрану: офис — план, и уводить
        // цель вверх при взгляде сверху бессмысленно.
        screenSpacePanning={false}
        minPolarAngle={MIN_POLAR}
        maxPolarAngle={MAX_POLAR}
        minDistance={MIN_DIST}
        maxDistance={MAX_DIST}
        dampingFactor={0.12}
      />
      <Rig layout={layout} size={size} active={active} />
    </>
  );
}

/**
 * Чипы фокуса поверх сцены — обычный DOM, а не объекты сцены: это элемент
 * интерфейса, и вести он себя должен как интерфейс (не поворачивается с
 * камерой, не заслоняется мебелью, читается при любом наезде).
 */
export function CameraChips({ layout }: { layout: Layout }) {
  const focus = useCamera((s) => s.focus);
  const setFocus = useCamera((s) => s.setFocus);
  const select = useStore((s) => s.select);
  const selected = useStore((s) => s.selected);
  const instances = useStore((s) => s.instances);
  const rooms = focusRooms(layout);
  const agent = selected ? instances[selected] : null;

  // Раскладке без комнат (`classic`) наводиться не на что: остаётся обзор,
  // а ради одной кнопки «весь офис» строку рисовать незачем.
  if (!rooms.length && !agent) return null;

  return (
    <div className="cam-chips">
      <button
        className={`cam-chip${focus.kind === 'overview' ? ' on' : ''}`}
        title={t('cam.wholeOffice.hint')}
        onClick={() => { select(null); setFocus({ kind: 'overview' }); }}
      >
        {t('cam.wholeOffice')}
      </button>
      {rooms.map((room, i) => (
        <button
          key={room.id}
          className={`cam-chip${focus.kind === 'room' && focus.id === room.id ? ' on' : ''}`}
          title={t('cam.room.hint', { n: i + 1 })}
          onClick={() => { select(null); setFocus({ kind: 'room', id: room.id }); }}
        >
          {roomTitle(room)}
        </button>
      ))}
      {agent && (
        <button
          className={`cam-chip agent${focus.kind === 'agent' ? ' on' : ''}`}
          title={t(focus.kind === 'agent' ? 'cam.following' : 'cam.backToAgent')}
          onClick={() => setFocus({ kind: 'agent', id: agent.id })}
        >
          ◎ {agent.label}
        </button>
      )}
    </div>
  );
}

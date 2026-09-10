/**
 * Человечки в трёхмерном офисе — шаг 4.
 *
 * Фигура взята готовая: Kenney «Animated Characters Protagonists» (CC0,
 * `design/models/characters/LICENSE.txt`) — скелет с анимациями. Это прототип,
 * как и мебель из примитивов: важно проверить не то, как нарисован человек, а
 * ходит ли он по настоящим путям, садится ли на настоящие места и читается ли
 * сцена, когда по ней движутся восемь фигур.
 *
 * Путь считает стор — A* по карте проходимости (`findPath`, §7 спеки
 * раскладки), — и отдаёт сюда ломаную целиком вместе со скоростью. Здесь её
 * только проходят: `useFrame` везёт фигуру от точки к точке на «скорость ×
 * время кадра». Разделено так потому, что маршрут — это решение (его
 * перебивают события офиса), а прохождение — картинка (её рисуют кадры), и
 * мерить второе часами первого значит получать рывки на каждой заминке.
 * Офис остаётся визуализацией событий, а не их источником (CONCEPT.md §2).
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import charUrl from '../../../design/models/characters/character.fbx?url';
import idleUrl from '../../../design/models/characters/animations/idle.fbx?url';
import walkUrl from '../../../design/models/characters/animations/walk.fbx?url';
import typeUrl from '../../../design/models/characters/animations/type.fbx?url';
import sitIdleUrl from '../../../design/models/characters/animations/sit-idle.fbx?url';
import sitTalkUrl from '../../../design/models/characters/animations/sit-talk.fbx?url';
import talkUrl from '../../../design/models/characters/animations/talk.fbx?url';
import gameUrl from '../../../design/models/characters/animations/game.fbx?url';
import sitDownUrl from '../../../design/models/characters/animations/sit-down.fbx?url';
import standUpUrl from '../../../design/models/characters/animations/stand-up.fbx?url';
import sitToTypeUrl from '../../../design/models/characters/animations/sit-to-type.fbx?url';
import typeToSitUrl from '../../../design/models/characters/animations/type-to-sit.fbx?url';
import { deskPoint, deskSprite, desks, FOOT_DX, FOOT_DY } from '../../shared/layout';
import type { Layout } from '../../shared/layout';
import { catalog } from '../layoutData';
import { poseFit, useFit } from './fit';
import { seatingFor } from './seating';
import { measurePoses, useModelMeasures, BONES, type PoseMeasure } from './measure';
import { reach, type Arm } from './ik';
import { markArrived, reportPosition, useStore } from '../store';
import { interestsFor, type Interest } from '../interests';
import { stateText } from '../agentState';
import { dropAnchor, setAnchor } from './anchors';
import type { AgentState, InstanceView, RoleView, TaskView } from '../../shared/types';
import { LOOKS } from '../../shared/looks';
import { NO_ROLE_COLOR, shortCode } from '../Avatar';

/**
 * Текстуры персонажей по имени скина — оно же идентификатор внешности
 * (`shared/looks.ts`), поэтому выбранная в форме роли внешность попадает
 * в комнату без промежуточной таблицы соответствий.
 */
const skinModules = import.meta.glob('../../../design/models/characters/skins/*.png', {
  eager: true, query: '?url', import: 'default',
}) as Record<string, string>;
const SKIN_URLS: Record<string, string> = {};
for (const [path, url] of Object.entries(skinModules)) {
  SKIN_URLS[path.split('/').pop()!.replace('.png', '')] = url;
}
const SKIN_NAMES = Object.keys(SKIN_URLS).sort();

/**
 * Рост фигуры, скорость ходьбы, высоты посадки и прочие числа подгонки живут
 * в `design/fit.json` и правятся стендом (`?fit=1`), а не здесь. Тайл —
 * примерно 0.75 м (столешница шириной два тайла это 1.5 м), человек — 1.75 м,
 * отсюда стоящий по умолчанию рост 2.3.
 */

/**
 * Где у фигуры ноги относительно якоря — из раскладки: там же считается
 * обратное, якорь по клетке (`standingAt`). Реэкспорт — для стендов и
 * отладочного слоя, которые рисуют ровно под ногами.
 */
export { FOOT_DX, FOOT_DY };

/**
 * Позы, в которых бывает агент. Сидячие и стоячие разделены не для красоты:
 * переход между группами нельзя проиграть кроссфейдом — человек должен встать
 * или сесть, и на это есть отдельные клипы.
 */
export type Pose = 'walk' | 'idle' | 'talk' | 'type' | 'sitIdle' | 'sitTalk' | 'game';

export const SEATED: Record<Pose, boolean> = {
  walk: false, idle: false, talk: false,
  type: true, sitIdle: true, sitTalk: true, game: true,
};

/** Переходы между позами — играются один раз и замирают на последнем кадре. */
export type Move = 'sitDown' | 'standUp' | 'sitToType' | 'typeToSit';

/** Длительность кроссфейда между зацикленными позами, секунды. */
const FADE = 0.25;

/**
 * Пределы, в которых разрешено растягивать клип шага.
 *
 * Скорость проигрывания не константа: она считается каждый кадр из того, с
 * какой скоростью агент на самом деле едет, и из длины шага, измеренной по
 * самому клипу (`measure.ts`). Раньше здесь стояла единица, подобранная на
 * глаз, — при нынешней скорости офиса это означало, что ноги перебирают
 * впятеро медленнее, чем движется тело.
 *
 * Пределы нужны на случай телепорта и микросдвигов: делить на почти нулевое
 * оставшееся время — верный способ получить мельтешение вместо шага.
 */
const WALK_RATE = { min: 0.25, max: 6 };

/**
 * За сколько секунд фигура переезжает между «стоит» и «сидит».
 *
 * Это не длительность клипа посадки, а время, за которое подъём на сиденье
 * доезжает до конца. Совпадать они не обязаны: клип рисует, как человек
 * сгибается, а подъём — где в этот момент его таз. Взято близко к длине
 * клипов `sitDown`/`standUp` (2.2 с), чуть быстрее — чтобы фигура успевала
 * сесть, а не досаживалась уже сидя.
 */
const POSTURE_TIME = 1.8;

/** За сколько секунд кисти дотягиваются до столешницы и отпускают её. */
const REACH_TIME = 0.35;

/** Общая мишень для кистей: считается каждый кадр, но новая на каждого агента
 *  и каждый кадр была бы мусором на ровном месте. */
const hand = new THREE.Vector3();

/** Ниже этого расстояния до цели (тайлы) считаем, что агент стоит. */
const MOVING_EPS = 0.02;

/** Скорость доворота фигуры, радиан в секунду. */
const TURN_SPEED = 9;

/**
 * Провезти фигуру вдоль ломаной на заданное расстояние, перешагивая через
 * точки, которые уложились в этот кадр.
 *
 * Расстояние приходит как «скорость × время кадра», поэтому темп ходьбы
 * задан только скоростью и не зависит ни от длины отрезка, ни от того,
 * сколько кадров браузер успел нарисовать. Кадры, пропущенные фоновой
 * вкладкой, не «догоняются» рывком: их просто не было, и путь не пройден.
 */
function advance(
  g: THREE.Object3D, route: THREE.Vector3[], leg: { current: number }, budget: number,
): void {
  let left = budget;
  while (left > 0 && leg.current < route.length) {
    const to = route[leg.current];
    const dist = g.position.distanceTo(to);
    if (dist <= left) {
      g.position.copy(to);
      left -= dist;
      leg.current += 1;
    } else {
      g.position.lerp(to, left / dist);
      left = 0;
    }
  }
}

/**
 * Сколько секунд говорит один собеседник, прежде чем передать слово.
 *
 * Очередь считается от общих часов сцены, а не от таймера у каждой пары:
 * общие часы сами держат собеседников в противофазе, и разговор не
 * превращается в двух людей, говорящих одновременно.
 */
const TALK_TURN = 4;

/**
 * Модель смотрит вдоль своей оси Z; в какую сторону — свойство конкретного
 * набора, а не общее правило, поэтому вынесено сюда: с другим набором
 * поменяется одно это число. Персонажи Mixamo смотрят в +Z, поэтому ноль.
 */
const MODEL_YAW = 0;

/** Куда повёрнут агент, когда стоит: столы в раскладке не повёрнуты, и место
 *  `work` у них с северной стороны — значит, сидящий смотрит на юг. */
const REST_YAW = 0;

/**
 * Кольцо под ногами — как состояние агента читается в объёме.
 *
 * В плоском офисе состояние показывали свечением вокруг спрайта
 * (`drop-shadow` по классу состояния в styles/office-sprites.css). В 3D тот же приём не
 * работает: фигура объёмная, свет на неё уже падает свой, и подкрашивать её
 * целиком значит спорить с освещением сцены. Кольцо на полу вместо этого
 * читается с любого ракурса, не мешает материалу фигуры и заодно показывает,
 * где именно агент стоит, — при взгляде сверху сбоку это не всегда очевидно.
 *
 * Состояния, у которых кольца нет, ничем не помечены и в плоском офисе.
 */
const STATE_RING: Partial<Record<AgentState, string>> = {
  waiting_approval: '#ff6b57',
  failed: '#ff6b57',
  blocked: '#ff6b57',
  done: '#5fd35a',
  talking: '#f0b429',
};

/** Кольцо выделения и участия в совещании — тем же акцентным цветом, что в HUD. */
const ACCENT = '#f0b429';

/** Радиус кольца в тайлах: чуть шире плеч, чтобы не срезалось ступнями. */
const RING_R = 0.45;

/** Высота столешницы — та же, что у формы `desk` в props.ts. Табличка с кодом
 *  задачи лежит на столе, а не проваливается сквозь него. */
const DESK_TOP = 1.05;

/**
 * Делитель размера подписей: чем дальше камера, тем мельче карточка. Ноль
 * (постоянный экранный размер) читался бы лучше вблизи, но при отдалении
 * восемь карточек закрывают комнату целиком — а отдалённый вид как раз и
 * нужен, чтобы видеть офис, а не читать в нём таблички.
 */
const TAG_SCALE = 15;

/**
 * Модификатор точки состояния в бейдже (`.agent-badge-dot`): свободен и
 * закончил — зелёная, занят разговором или работой — жёлтая, застрял или
 * сломался — красная. `walking` и `paused` остаются без модификатора: это
 * переходные состояния, для них хватает нейтрально-серой точки по умолчанию.
 */
const STATE_DOT: Partial<Record<AgentState, 'live' | 'warn' | 'danger'>> = {
  idle: 'live', done: 'live',
  thinking: 'warn', working: 'warn', talking: 'warn',
  waiting_approval: 'danger', blocked: 'danger', failed: 'danger',
};

/**
 * Тёмный или светлый текст поверх цвета роли — по яркости самого цвета.
 *
 * Цвета ролей задаёт пользователь, и среди них есть и жёлтый, и тёмно-синий.
 * Одна фиксированная краска текста на половине из них была бы нечитаема,
 * поэтому берём ту, что контрастнее: формула — стандартная относительная
 * яркость (доли по восприятию: зелёный весит больше красного, красный —
 * больше синего). Цвета фиксированные, а не из темы: значок залит своим
 * цветом независимо от того, дневная сейчас тема или ночная.
 */
function inkOn(hex: string): string {
  const v = hex.replace('#', '');
  if (v.length !== 6) return '#181320';
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? '#181320' : '#ffffff';
}

/** Порядок загрузки: модель, потом клипы поз, потом клипы переходов. */
const POSE_URLS: Record<Pose, string> = {
  walk: walkUrl, idle: idleUrl, talk: talkUrl, type: typeUrl,
  sitIdle: sitIdleUrl, sitTalk: sitTalkUrl, game: gameUrl,
};
const MOVE_URLS: Record<Move, string> = {
  sitDown: sitDownUrl, standUp: standUpUrl,
  sitToType: sitToTypeUrl, typeToSit: typeToSitUrl,
};
export const POSE_KEYS = Object.keys(POSE_URLS) as Pose[];
export const MOVE_KEYS = Object.keys(MOVE_URLS) as Move[];
const CLIP_URLS = [charUrl, ...POSE_KEYS.map((k) => POSE_URLS[k]), ...MOVE_KEYS.map((k) => MOVE_URLS[k])];

export interface Loaded {
  model: THREE.Group;
  clips: Record<Pose | Move, THREE.AnimationClip>;
  /** Замеры поз: где в каждой из них таз, кисти и ступни (доли роста). */
  measure: Record<Pose, PoseMeasure>;
}

/**
 * Персонаж и его клипы.
 *
 * Горизонтальное перемещение корня из клипов не вычищается: у всех
 * одиннадцати его нет — Mixamo отдал их «в месте», и трогать нечего. Раньше
 * тут стояла функция, которая это делала, но искала дорожку `Hips.position`,
 * а корень в этих файлах лежит на `HipsCtrl.position`: она не совпадала ни с
 * одним клипом и не делала ровно ничего. Если однажды приедет клип с
 * движением корня, это станет видно сразу — фигура поедет сама.
 */
export function useCharacter(): Loaded {
  const loaded = useLoader(FBXLoader, CLIP_URLS) as unknown as THREE.Group[];
  return useMemo(() => {
    const clips = {} as Record<Pose | Move, THREE.AnimationClip>;
    POSE_KEYS.forEach((k, i) => { clips[k] = loaded[1 + i].animations[0]; });
    MOVE_KEYS.forEach((k, i) => { clips[k] = loaded[1 + POSE_KEYS.length + i].animations[0]; });
    const poses = {} as Record<Pose, THREE.AnimationClip>;
    for (const k of POSE_KEYS) poses[k] = clips[k];
    return { model: loaded[0], clips, measure: measurePoses(loaded[0], poses) };
  }, [loaded]);
}

/**
 * Материал по текстуре скина. Один рецепт на комнату, аватарки и стенд
 * скинов — иначе стенд показывал бы не то, что встанет в комнате.
 */
export function skinMaterialOf(map: THREE.Texture): THREE.Material {
  map.colorSpace = THREE.SRGBColorSpace;
  // Текстуры Kenney — плашки плоского цвета без градиентов: сглаживание
  // при уменьшении только мылит их и перемешивает соседние плашки.
  map.magFilter = THREE.NearestFilter;
  return new THREE.MeshLambertMaterial({ map });
}

/**
 * Материалы по скинам — один на скин, а не на агента: скинов четыре, агентов
 * может быть вдвое больше, а текстура у них общая.
 */
export function useSkinMaterials(): Record<string, THREE.Material> {
  const textures = useLoader(THREE.TextureLoader, SKIN_NAMES.map((n) => SKIN_URLS[n]));
  return useMemo(() => {
    const byName: Record<string, THREE.Material> = {};
    (textures as THREE.Texture[]).forEach((map, i) => { byName[SKIN_NAMES[i]] = skinMaterialOf(map); });
    return byName;
  }, [textures]);
}

/**
 * Материал агента: выбранная у роли внешность, а если роль её не выбирала —
 * по кругу от номера агента, чтобы соседи за столами отличались друг от друга.
 * Порядок круга — от списка внешностей, а не от порядка файлов: список — то,
 * что человек видит в форме роли.
 */
export function skinMaterial(
  materials: Record<string, THREE.Material>, look: string | undefined, i: number,
): THREE.Material {
  return (look ? materials[look] : undefined)
    ?? materials[LOOKS[i % LOOKS.length].id]
    ?? materials[SKIN_NAMES[i % SKIN_NAMES.length]];
}

/**
 * Кольцо на полу. Нарисовано плоским, тени не бросает и не принимает: это
 * пометка интерфейса, а не предмет обстановки, и вести себя как предмет она
 * не должна.
 */
function Ring({ color }: { color: string }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
      <ringGeometry args={[RING_R, RING_R + 0.09, 32]} />
      <meshBasicMaterial color={color} transparent opacity={0.85} side={THREE.DoubleSide} />
    </mesh>
  );
}

/**
 * Подпись над головой: кто это, что делает и над чем. Бейдж — тот же, что в
 * новой оболочке (`.agent-badge` из kit.css); плоский офис рисует ту же
 * информацию по-своему, старым пиксельным стилем — переносить его на этот
 * рендер не входило в задачу.
 *
 * Сделана обычным DOM поверх канваса (`Html` из drei), а не текстурой с
 * текстом: текст остаётся настоящим текстом — чётким на любом зуме, с теми же
 * шрифтом и цветами темы, что во всём остальном интерфейсе. Мышь она не
 * ловит, иначе карточки перехватывали бы вращение камеры.
 */
function AgentTag({ inst, role, task, expanded }: {
  inst: InstanceView;
  role?: RoleView;
  task?: TaskView | null;
  /** Показывать табличку задачи, а не только бейдж. */
  expanded: boolean;
}) {
  const chipColor = role?.color || NO_ROLE_COLOR;
  // Подпись висит над макушкой стоящего — и остаётся там же, когда агент
  // сядет: карточки восьми агентов и так липнут друг к другу, а прыгающая
  // вслед за посадкой подпись читалась бы ещё хуже.
  const tall = useFit((s) => s.fit.figure.tall);
  return (
    <Html
      center
      position={[0, tall + 0.55, 0]}
      distanceFactor={TAG_SCALE}
      zIndexRange={[100, 0]}
      style={{ pointerEvents: 'none', userSelect: 'none' }}
    >
      <div className="tag3d">
        {inst.note && inst.state !== 'idle' && <div className="tag3d-bubble">{inst.note}</div>}
        {/* Тот же бейдж, что в макете: белая пилюля, значок роли цветом
            роли из её настроек и точка состояния. Название должности сюда
            не помещается — в макете у бейджа его нет, он остаётся в
            карточке агента и в панели команды. */}
        <div className="agent-badge" title={role?.title ?? inst.label}>
          <span
            className="agent-badge-role"
            style={{ background: chipColor, color: inkOn(chipColor) }}
          >
            {shortCode(inst.roleId, inst.id)}
          </span>
          <span
            className={`agent-badge-dot${STATE_DOT[inst.state] ? ` ${STATE_DOT[inst.state]}` : ''}`}
            title={stateText(inst.state)}
          />
        </div>
        {/* Задача — отдельной табличкой под бейджем. */}
        {expanded && task && <div className="tag3d-task">{task.id} · {task.title}</div>}
      </div>
    </Html>
  );
}

/**
 * Собрать фигуру: клон скелета, микшер, действия и кости рук.
 *
 * Отдельной функцией, а не прямо в компоненте, потому что тем же занят стенд
 * подгонки: он показывает ту же фигуру с теми же клипами, и собирать её
 * вторым способом значило бы проверять на стенде не то, что в комнате.
 *
 * `phase` — доля цикла, с которой начинаются анимации: 0…1.
 */
export function buildRig(
  loaded: Loaded, material: THREE.Material, tall: number, phase: number,
): Rig {
  // Клонировать скелет обычным `clone()` нельзя: у копий остались бы кости
  // оригинала и все агенты двигались бы как один.
  const figure = cloneSkinned(loaded.model);
  const box = new THREE.Box3().setFromObject(figure);
  figure.scale.setScalar(tall / Math.max(box.max.y - box.min.y, 1e-6));
  figure.rotation.y = MODEL_YAW;
  figure.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.material = material;
      o.castShadow = true;
      // Принимать тени фигуре незачем: сама на себя она их почти не
      // отбрасывает, а лишний проход по скиннингу не бесплатный.
      o.receiveShadow = false;
    }
  });

  const mixer = new THREE.AnimationMixer(figure);
  const actions = {} as Record<Pose | Move, THREE.AnimationAction>;
  for (const key of POSE_KEYS) actions[key] = mixer.clipAction(loaded.clips[key]);
  for (const key of MOVE_KEYS) {
    const a = mixer.clipAction(loaded.clips[key]);
    // Переход играется один раз и замирает на последнем кадре: иначе на
    // стыке с зацикленной позой человек успевал бы вскочить обратно.
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    actions[key] = a;
  }

  /**
   * Сдвиг фазы: каждая фигура начинает свой цикл со своей секунды.
   *
   * Без него восемь агентов дышат, переминаются и печатают синхронно —
   * комната превращается в кордебалет, и это первое, что бросается в
   * глаза. Сдвиг детерминированный, от номера агента: случайный менялся бы
   * при каждой перерисовке и дёргал бы позу.
   */
  for (const key of POSE_KEYS) {
    const a = actions[key];
    a.time = (phase * a.getClip().duration) % a.getClip().duration;
  }
  /**
   * Кости рук — для дотягивания кистей до столешницы. Ищутся один раз
   * здесь, а не в кадре: `getObjectByName` обходит всё поддерево, а костей
   * в скелете под шесть десятков.
   */
  const arms = BONES.arms
    .map((a) => ({
      upper: figure.getObjectByName(a.upper),
      lower: figure.getObjectByName(a.lower),
      hand: figure.getObjectByName(a.hand),
    }))
    .filter((a): a is Arm => !!(a.upper && a.lower && a.hand));

  return { figure, mixer, actions, arms };
}

export interface Rig {
  figure: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<Pose | Move, THREE.AnimationAction>;
  arms: Arm[];
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
function Agent({
  inst, loaded, material, layout, offset, role, task, selected, inMeeting, interest, phase,
}: {
  inst: InstanceView;
  loaded: Loaded;
  material: THREE.Material;
  layout: Layout;
  offset: [number, number];
  role?: RoleView;
  task?: TaskView | null;
  selected: boolean;
  inMeeting: boolean;
  /** Чем агент занят, пока свободен: разговор, приставка, место, ничего. */
  interest?: Interest;
  /** Доля цикла, с которой начинаются его анимации: 0…1. */
  phase: number;
}) {
  const pos = useStore((s) => s.pos[inst.id]);
  const select = useStore((s) => s.select);
  const group = useRef<THREE.Group>(null);
  /**
   * Вторая группа, внутри первой, — поправка позы.
   *
   * Внешняя везёт агента по комнате и разворачивает; внутренняя поднимает его
   * на сиденье. Разделены они потому, что живут по разным законам: путь
   * задан стором в секундах и тайлах, а подъём — тем, сидит человек или
   * стоит. Слитые в одну, они дрались бы за одну и ту же позицию, и агент
   * подъезжал бы к столу уже сидя, по воздуху.
   */
  const seat = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);

  /** Числа подгонки: рост фигуры, высоты посадки, скорость, IK. */
  const fit = useFit((s) => s.fit);
  const tall = fit.figure.tall;
  /** Высоты поверхностей у моделей набора — сиденья и столешницы. */
  const models = useModelMeasures();

  /**
   * Табличка задачи под бейджем — только там, где её есть смысл читать.
   *
   * Бейдж (значок должности с номером и точка состояния) виден всегда, как
   * в макете. Табличка с кодом и названием задачи под ним — нет: восемь
   * табличек превращаются в кашу, стоит агентам собраться рядом в зоне
   * отдыха. Она появляется тогда, когда там правда есть что прочесть: агент
   * выбран, под курсором, или занят делом. Свободный агент, стоящий в
   * лаунже, ничего интересного ею не сообщает.
   */
  const idle = inst.state === 'idle' || inst.state === 'walking';
  const expanded = selected || hovered || !idle;

  /**
   * Фигура, микшер и действия создаются одним куском.
   *
   * Порознь их разносит StrictMode: в разработке он вызывает фабрики `useMemo`
   * по два раза, и три отдельных мемо легко оставляют компонент с микшером от
   * одного клона и действиями от другого. Разъехавшись, они роняют внутреннюю
   * бухгалтерию three (`_cacheIndex` у несуществующего действия). Один мемо —
   * один согласованный набор, и разъезжаться нечему.
   */
  const rig = useMemo(
    () => buildRig(loaded, material, tall, phase), [loaded, material, phase, tall],
  );

  /** Поза, которая играет сейчас, и поза, к которой ведёт текущий переход. */
  const pose = useRef<Pose>('idle');
  const pending = useRef<Pose | null>(null);
  /** Клип перехода, который играет прямо сейчас. Нужен отдельно от `pending`:
   *  прерванный переход надо погасить, а по целевой позе не понять, каким
   *  клипом в неё шли. */
  const transition = useRef<Move | null>(null);

  /**
   * Запуск анимации живёт в эффекте, а не рядом с созданием действий. React в
   * StrictMode монтирует компонент, тут же пробно размонтирует и монтирует
   * снова: `useMemo` при этом не пересчитывается, а эффект отрабатывает
   * заново. Запусти анимацию в мемо — и после пробного цикла её уже никто не
   * перезапустит, все фигуры так и застынут в T-позе.
   *
   * Очистки у эффекта нет намеренно. Останавливать анимацию не нужно: микшер
   * живёт вместе с компонентом и уезжает в сборку мусора следом за ним, а
   * `stopAllAction` в пробном размонтировании только путал бы бухгалтерию
   * действий.
   */
  useEffect(() => {
    pose.current = 'idle';
    pending.current = null;
    transition.current = null;
    rig.actions.idle.reset().play();

    /**
     * Доиграл переход — включаем позу, ради которой он игрался. Отдельным
     * событием, а не таймером на длину клипа: длины у клипов разные, а
     * промахнувшийся таймер даёт либо рывок, либо застывшую фигуру.
     */
    const onFinished = (e: { action: THREE.AnimationAction }) => {
      const next = pending.current;
      // Доиграть может и прерванный переход: погашенный клип догорает до
      // конца и присылает то же событие. Позу двигает только тот, который
      // играется сейчас, — иначе агент принимал бы позу, от которой уже
      // отказались.
      if (!next || !transition.current || e.action !== rig.actions[transition.current]) return;
      pending.current = null;
      transition.current = null;
      const action = rig.actions[next];
      action.reset().setEffectiveWeight(1).fadeIn(FADE).play();
      pose.current = next;
    };
    rig.mixer.addEventListener('finished', onFinished);
    return () => { rig.mixer.removeEventListener('finished', onFinished); };
  }, [rig]);

  /**
   * Перевести агента в позу `next`.
   *
   * Между позами одной группы — обычный кроссфейд. Между сидячей и стоячей
   * кроссфейд не годится: человек не может перетечь из положения стоя в
   * положение сидя, для этого есть отдельный клип. Он играется один раз, и
   * только после него включается целевая поза.
   */
  const goTo = (next: Pose) => {
    if (next === pose.current || next === pending.current) return;
    /**
     * Незаконченный переход гасим. Без этого он доигрывал сам по себе и
     * досрочно объявлял позу, в которую вёл: агента звали в путь, пока он
     * садился, — он вставал и шёл, а на середине комнаты клип «сесть»
     * досчитывал до конца и усаживал его на ходу. Чаще всех в это попадал
     * менеджер: он единственный ходит к своему столу и обратно на каждый
     * ход разговора, то есть постоянно срывается с полпути посадки.
     *
     * Исходной позой остаётся прежняя, а не та, к которой переход вёл: до
     * неё тело не доехало. Встал наполовину — значит, идти можно сразу, без
     * отдельного подъёма.
     */
    if (transition.current) {
      rig.actions[transition.current].fadeOut(FADE);
      transition.current = null;
      pending.current = null;
    }
    const from = pose.current;
    const move: Move | null = SEATED[from] === SEATED[next]
      ? (from === 'sitIdle' && next === 'type' ? 'sitToType'
        : from === 'type' && next === 'sitIdle' ? 'typeToSit' : null)
      : (SEATED[next] ? 'sitDown' : 'standUp');

    rig.actions[from].fadeOut(FADE);
    if (!move) {
      rig.actions[next].reset().setEffectiveWeight(1).fadeIn(FADE).play();
      pose.current = next;
      return;
    }
    pending.current = next;
    transition.current = move;
    rig.actions[move].reset().setEffectiveWeight(1).fadeIn(FADE).play();
  };

  /**
   * Насколько агент сейчас сидит: 0 — стоит, 1 — сидит. Не «сидит ли», а
   * именно доля: между двумя состояниями играется клип посадки, и подъём
   * таза едет вместе с ним.
   */
  const posture = useRef(0);
  /** Насколько сейчас слушаются кисти: та же плавность, что у посадки. */
  const reachW = useRef(0);

  /**
   * Маршрут, по которому рендер сейчас ведёт фигуру: точки в мировых
   * координатах и номер той, к которой идём. Стор отдаёт ломаную целиком
   * (§7), а расстояние по ней проходится в кадре — по времени кадра, а не по
   * часам. Из-за этого фигура не может «догнать» пропущенные кадры прыжком:
   * пока вкладка в фоне и кадров нет, агент просто стоит там, где стоял.
   */
  const route = useRef<THREE.Vector3[]>([]);
  const legIdx = useRef(0);
  const routeSeq = useRef(-1);
  const yaw = useRef(REST_YAW);

  /**
   * Где агент стоит или куда идёт. Стор держит здесь точную точку места —
   * слот `work` у стола, сиденье, точка встречи, — а не якорь предмета:
   * логика ходьбы и картинка обязаны смотреть в одну точку, иначе фигура в
   * последний момент перескакивает туда, куда маршрут не вёл.
   */
  const fallbackDesk = !inst.deskless && desks(layout, catalog).length > inst.desk.index;
  const home = fallbackDesk
    ? deskPoint(layout, catalog, inst.desk.index, 'work')
    : { x: inst.desk.x, y: inst.desk.y };
  const point = pos ?? home;
  const atDesk = pos ? pos.atDesk : fallbackDesk;
  /** Дошёл ли: сидеть, печатать и светить монитором можно только на месте. */
  const arrived = pos ? pos.arrived : true;
  const px = point.x + FOOT_DX + offset[0];
  const pz = point.y + FOOT_DY + offset[1];
  const walkPath = pos?.path;
  const walkSeq = pos?.seq ?? -1;
  const tilesPerSec = pos?.speed ?? fit.walk.tilesPerSec;

  /**
   * Чем агент занят, когда стоит на месте.
   *
   * Сесть можно не везде: за своим столом и на диване — местам, которые
   * объявлены слотами в каталоге. В остальных точках (свободных мест на
   * диване всего три, а отдыхающих бывает больше) агент остаётся стоять.
   * Проверка — по совпадению с посадочным местом, а не по «он в комнате
   * отдыха»: комната большая, а подушек три.
   */
  const busy = inst.state === 'working' || inst.state === 'thinking';

  /**
   * Поза, в которой агент стоит на месте.
   *
   * За столом решает занятость, на совещании — совещание, а во всём
   * остальном — его занятие: разговор, приставка, посидеть или просто
   * постоять. Разговор особый: в паре говорит один, второй слушает, и кто
   * сейчас чей — считается ниже по общим часам.
   */
  const restPose: Pose = inMeeting ? 'sitTalk'
    : atDesk ? (busy ? 'type' : 'sitIdle')
      : interest?.kind === 'game' ? 'game'
        : interest?.kind === 'sit' ? 'sitIdle'
          : interest?.kind === 'talk' ? 'talk'
            : 'idle';

  /** Куда смотреть стоя: занятие может попросить свой разворот — собеседники
   *  разворачиваются друг к другу, — иначе как обычно, на юг. */
  const restYaw = interest?.yaw ?? REST_YAW;

  /** Первый в паре по алфавиту начинает говорить: правило одинаково у обоих,
   *  поэтому договариваться им не о чем. */
  const speaksFirst = !!interest?.partner && inst.id < interest.partner;

  /**
   * Посадка: куда поднять фигуру относительно точки места и тянуть ли кисти
   * к столешнице. Правило целиком — в `seating.ts`, тем же пользуется стенд.
   */
  const placeSprite = atDesk
    ? deskSprite(layout, catalog, inst.desk.index)
    : interest?.sprite;
  const { lift, handsY } = seatingFor(
    fit, models, loaded.measure[restPose], restPose, placeSprite, tall,
    // Которое место занято: подушки дивана доводятся каждая своей поправкой.
    atDesk ? undefined : interest?.seat,
  );

  /**
   * Честная скорость клипа шага, тайлов в секунду: длина цикла в ростах,
   * умноженная на рост и делённая на длительность. По ней в кадре считается
   * растяжение — чтобы ноги перебирали ровно с той скоростью, с какой едет
   * тело.
   */
  const clipSpeed = fit.walk.clipSpeed
    ?? (loaded.measure.walk.cycle * tall) / Math.max(loaded.clips.walk.duration, 1e-6);

  /**
   * Новый маршрут из стора превращается в список точек в мировых координатах.
   * Первая точка ломаной — место, откуда стор считал путь; фигура может быть
   * не ровно там (её ведёт кадр, а не стор), поэтому в маршрут она не
   * попадает: агент идёт из того места, где он есть, к следующей точке.
   */
  useEffect(() => {
    const g = group.current;
    if (!g) return;
    routeSeq.current = walkSeq;
    const pts = (walkPath ?? [{ x: point.x, y: point.y }])
      .map((pt) => new THREE.Vector3(pt.x + FOOT_DX + offset[0], 0, pt.y + FOOT_DY + offset[1]));
    // Маршрут из одной точки — это «стой здесь»: первое появление, снапшот,
    // смена раскладки. Вести фигуру через всю комнату тут было бы неправдой.
    if (pts.length < 2 || g.position.lengthSq() === 0) {
      g.position.copy(pts[pts.length - 1]);
      route.current = [];
      legIdx.current = 0;
      return;
    }
    route.current = pts.slice(1);
    legIdx.current = 0;
  }, [walkSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Цель сдвинулась, а маршрут остался прежним — так бывает при правке
   * расстановки и подгонке стенда. Стоящую фигуру переставляем сразу; идущей
   * стор пришлёт новый маршрут сам.
   */
  useEffect(() => {
    const g = group.current;
    if (!g || route.current.length > 0) return;
    g.position.set(px, 0, pz);
  }, [px, pz]);

  useFrame((state, dt) => {
    rig.mixer.update(dt);
    const g = group.current;
    if (!g) return;

    // В разговоре говорят по очереди: пока один жестикулирует, второй просто
    // стоит и слушает. Без этого пара выглядит как два человека, говорящих
    // одновременно и мимо друг друга.
    const speaking = speaksFirst === (Math.floor(state.clock.elapsedTime / TALK_TURN) % 2 === 0);
    const still: Pose = restPose === 'talk' && !speaking ? 'idle' : restPose;

    if (legIdx.current < route.current.length) {
      goTo('walk');
      /**
       * Пока играет подъём со стула, агент ещё встаёт, а не идёт: везти его
       * в это время — это и есть «поехал сидя». Маршрут при этом никуда не
       * девается: подъём просто задерживает выход на длину клипа — ровно на
       * то время, которое человек и тратит, чтобы подняться.
       */
      if (pending.current !== 'walk') advance(g, route.current, legIdx, tilesPerSec * dt);

      const leg = route.current[Math.min(legIdx.current, route.current.length - 1)];
      const dx = leg.x - g.position.x;
      const dz = leg.z - g.position.z;
      if (dx * dx + dz * dz > 1e-6) yaw.current = Math.atan2(dx, dz);

      /**
       * Растяжение клипа шага под настоящую скорость: она теперь одна на весь
       * маршрут и известна заранее (тайлов в секунду из `fit.json`), поэтому
       * считать её по остатку пути больше не нужно. Ноги перебирают ровно с
       * той скоростью, с какой едет тело.
       */
      rig.actions.walk.timeScale = THREE.MathUtils.clamp(
        tilesPerSec / clipSpeed, WALK_RATE.min, WALK_RATE.max,
      );
      // Дошёл — сказать об этом стору: только рендер знает, где фигура.
      if (legIdx.current >= route.current.length) markArrived(inst.id, routeSeq.current);
    } else {
      if (route.current.length > 0) {
        // Маршрут пройден: дальше фигуру держит точная точка места, а не
        // последняя точка ломаной, — они совпадают, но источник должен быть
        // один.
        route.current = [];
      }
      const dx = px - g.position.x;
      const dz = pz - g.position.z;
      if (dx * dx + dz * dz > MOVING_EPS * MOVING_EPS) g.position.set(px, 0, pz);
      yaw.current = restYaw;
      goTo(still);
    }

    // Где фигура на самом деле — обратно в координаты раскладки. По ней стор
    // строит следующий маршрут: перебитый на полпути путь обязан начинаться
    // здесь, а не там, откуда человек вышел.
    reportPosition(inst.id, g.position.x - FOOT_DX - offset[0], g.position.z - FOOT_DY - offset[1]);

    // Доворот по кратчайшей дуге: без нормализации разницы фигура на переходе
    // через π крутанулась бы вокруг себя.
    let delta = yaw.current - g.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    g.rotation.y += delta * Math.min(1, dt * TURN_SPEED);

    /**
     * Подъём на сиденье. Едет он не мгновенно: между «стоит» и «сидит»
     * играется клип посадки, и всё это время таз должен опускаться, а не
     * прыгать на подушку в первом же кадре.
     *
     * Цель берётся по той позе, к которой ведёт переход, а не по нынешней:
     * пока играет `sitDown`, поза формально ещё стоячая, а человек уже
     * садится.
     */
    const wants = SEATED[pending.current ?? pose.current] ? 1 : 0;
    const step = dt / POSTURE_TIME;
    posture.current += THREE.MathUtils.clamp(wants - posture.current, -step, step);
    const s = seat.current;
    if (s) {
      s.position.set(
        lift[0] * posture.current,
        lift[1] * posture.current,
        lift[2] * posture.current,
      );
    }

    /**
     * Дотягивание кистей до столешницы.
     *
     * Вес нарастает и спадает, а не включается щелчком: рука, мгновенно
     * поднятая на стол в момент смены позы, — это дёрганье, которое видно
     * даже мельком. Кости считаются от уже поставленной фигуры, поэтому
     * матрицы приходится обновить вручную: рендер сделает это позже, а нам
     * нужны мировые координаты кистей прямо сейчас.
     */
    const pull = handsY !== null && !pending.current
      && poseFit(fit, pose.current).reach ? 1 : 0;
    const rstep = dt / REACH_TIME;
    reachW.current += THREE.MathUtils.clamp(pull - reachW.current, -rstep, rstep);
    if (reachW.current > 1e-3 && handsY !== null) {
      g.updateMatrixWorld(true);
      for (const arm of rig.arms) {
        arm.hand.getWorldPosition(hand);
        hand.y = handsY;
        reach(arm, hand, reachW.current * fit.seated.ikWeight);
      }
    }

    // Где агент оказался в этом кадре — для камеры (`anchors.ts`). Не через
    // стор: она следит за идущим человеком, и запись в стор перерисовывала
    // бы офис шестьдесят раз в секунду.
    setAnchor(inst.id, g.position);
  });

  useEffect(() => () => dropAnchor(inst.id), [inst.id]);

  const ring = selected || inMeeting ? ACCENT : STATE_RING[inst.state];

  return (
    <group ref={group}>
      {/* Фигура — во второй группе: её поднимает посадка, пока внешняя везёт
          агента по комнате. Кольцо, мишень и подпись остаются на внешней,
          то есть на полу и над макушкой стоящего. */}
      <group ref={seat}>
        <primitive object={rig.figure} />
      </group>

      {/*
        Клик ловит не сама фигура, а невидимый цилиндр вокруг неё.
        Луч по скелетной модели проверяется по позе покоя, а не по текущему
        кадру анимации: попасть по идущему человеку почти невозможно, а
        по стоящему — только если целиться в ту руку, где она была в T-позе.
        Простая мишень заодно делает попадание предсказуемым, когда камера
        отъехала и фигура в пару десятков пикселей.

        `stopPropagation` нужен, чтобы клик не уходил дальше по лучу и не
        выбирал заодно того, кто стоит позади.
      */}
      <mesh
        position={[0, tall / 2, 0]}
        onClick={(e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          select(selected ? null : inst.id);
        }}
        onPointerOver={(e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = '';
        }}
      >
        <cylinderGeometry args={[0.45, 0.45, tall, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {ring && <Ring color={ring} />}
      <AgentTag inst={inst} role={role} task={task} expanded={expanded} />
    </group>
  );
}

function Crowd({ offset }: { offset: [number, number] }) {
  const instances = useStore((s) => s.instances);
  const layout = useStore((s) => s.layout);
  const roles = useStore((s) => s.roles);
  const tasks = useStore((s) => s.tasks);
  const selected = useStore((s) => s.selected);
  const meeting = useStore((s) => s.meeting);
  const loaded = useCharacter();
  const materials = useSkinMaterials();
  const list = Object.values(instances);
  const inMeeting = new Set(meeting?.status === 'running' ? meeting.participants : []);

  /** Кто чем занят. Считается тем же модулем, что раздаёт свободным агентам
   *  места в сторе, — иначе поза разъехалась бы с координатой. */
  const interests = useMemo(
    () => interestsFor(layout, catalog, instances, roles),
    [layout, instances, roles],
  );

  return (
    <>
      {list.map((inst, i) => {
        const role = roles.find((r) => r.id === inst.roleId);
        return (
          <Agent
            key={inst.id}
            inst={inst}
            loaded={loaded}
            material={skinMaterial(materials, role?.sprite, i)}
            layout={layout}
            offset={offset}
            role={role}
            task={inst.currentTaskId ? tasks[inst.currentTaskId] : null}
            selected={selected === inst.id}
            inMeeting={inMeeting.has(inst.id)}
            interest={interests.get(inst.id)}
            // Золотое сечение вместо равномерного шага: при равномерном
            // восемь агентов раскладываются по циклу правильным узором, и
            // синхронность возвращается — просто со сдвигом.
            phase={(i * 0.618) % 1}
          />
        );
      })}
      <DeskPlates offset={offset} />
    </>
  );
}

/**
 * Таблички с кодом задачи на столах — те же, что в плоском офисе. Точка
 * `plate` объявлена слотом в каталоге рядом со столом, поэтому табличка
 * переезжает вместе с ним и в 3D её не приходится ставить заново; поднимаем
 * её только на высоту столешницы, которой в плоском рендере не было.
 *
 * У безместного сотрудника стола нет — вешать табличку не на что.
 */
function DeskPlates({ offset }: { offset: [number, number] }) {
  const instances = useStore((s) => s.instances);
  const layout = useStore((s) => s.layout);
  const list = Object.values(instances).filter((i) => i.currentTaskId && !i.deskless);

  return (
    <>
      {list.map((inst) => {
        const plate = deskPoint(layout, catalog, inst.desk.index, 'plate');
        return (
          <Html
            key={`plate-${inst.id}`}
            center
            position={[plate.x + offset[0], DESK_TOP, plate.y + offset[1]]}
            distanceFactor={TAG_SCALE}
            zIndexRange={[90, 0]}
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            <div className="tag3d-plate">{inst.currentTaskId}</div>
          </Html>
        );
      })}
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

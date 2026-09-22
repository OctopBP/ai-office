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
import { type CSSProperties, type RefObject, Suspense, useEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
import pushUpUrl from '../../../design/models/characters/animations/push-up.fbx?url';
import pushUpToIdleUrl from '../../../design/models/characters/animations/push-up-to-idle.fbx?url';
import drinkUrl from '../../../design/models/characters/animations/drink.fbx?url';
import danceUrl from '../../../design/models/characters/animations/dance.fbx?url';
import {
  deskFacing, deskPoint, deskSprite, desks, FOOT_DX, FOOT_DY, yawOfSide,
} from '../../shared/layout';
import type { Layout } from '../../shared/layout';
import { catalog } from '../layoutData';
import { poseFit, useFit } from './fit';
import { seatingFor } from './seating';
import {
  measurePoses, measureTravel, useModelMeasures, BONES, type HipsTravel, type PoseMeasure,
} from './measure';
import { reach, type Arm } from './ik';
import { markArrived, reportPosition, useStore } from '../store';
import { interestsFor, type Interest } from '../interests';
import { dropAnchor, setAnchor } from './anchors';
import { MAX_DT, sceneOnScreen, sceneTime } from './clock';
import type { AgentState, InstanceView, RoleView, TaskView } from '../../shared/types';
import { LOOKS, lookFor, type Look } from '../../shared/looks';
import { NO_ROLE_COLOR } from '../Avatar';
import { useInstanceName } from '../instanceName';

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
 * Детализированные внешности — те, у которых в реестре есть `model`: свой
 * меш и свои материалы вместо текстуры на общем теле (§`Look.model` в
 * `shared/look.ts`). Список моделей собирается из реестра, а не перечислен
 * здесь, — новая детализированная модель попадает в комнату без правки
 * этого файла. Ни одной такой внешности (и ни одного `.glb` в папке) —
 * законное состояние: весь офис рисуется общим телом со скинами.
 */
const modelModules = import.meta.glob('../../../design/models/characters/*.glb', {
  eager: true, query: '?url', import: 'default',
}) as Record<string, string>;
const MODEL_URLS: Record<string, string> = {};
for (const [path, url] of Object.entries(modelModules)) {
  MODEL_URLS[path.split('/').pop()!] = url;
}
// Запись с моделью, которой нет в папке, пропускаем: загрузчику досталось бы
// `undefined` вместо адреса и комната не отрисовалась бы целиком из-за одной
// внешности. Такая внешность просто красится скином, как обычная.
const DETAILED_LOOKS = LOOKS.filter((l): l is Look & { model: string } => {
  if (!l.model) return false;
  if (MODEL_URLS[l.model]) return true;
  console.warn(`внешность «${l.id}»: нет файла модели ${l.model}, рисую скином`);
  return false;
});
const DETAILED_MODEL_URLS = DETAILED_LOOKS.map((l) => MODEL_URLS[l.model]);

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
 * Позы, в которых бывает агент. Стоячие, сидячие и лежачие разделены не для
 * красоты: переход между группами нельзя проиграть кроссфейдом — человек
 * должен встать, сесть или лечь, и на это есть отдельные клипы.
 */
export type Pose = 'walk' | 'idle' | 'talk' | 'type' | 'sitIdle' | 'sitTalk' | 'game'
  | 'pushup' | 'drink' | 'dance';

/** Стойка: на ногах, на сиденье или на полу. */
export type Stance = 'stand' | 'sit' | 'floor';

export const STANCE: Record<Pose, Stance> = {
  walk: 'stand', idle: 'stand', talk: 'stand', drink: 'stand', dance: 'stand',
  type: 'sit', sitIdle: 'sit', sitTalk: 'sit', game: 'sit',
  pushup: 'floor',
};

export const SEATED: Record<Pose, boolean> = Object.fromEntries(
  (Object.keys(STANCE) as Pose[]).map((p) => [p, STANCE[p] === 'sit']),
) as Record<Pose, boolean>;

/** Переходы между позами — играются один раз и замирают на последнем кадре. */
export type Move = 'sitDown' | 'standUp' | 'sitToType' | 'typeToSit' | 'getDown' | 'getUp';

/**
 * Чем переходят между стойками. Пары без клипа (с сиденья на пол и обратно)
 * в таблице нет: такой переход `goTo` собирает из двух, через стойку «стоя».
 */
const STANCE_MOVES: Record<Stance, Partial<Record<Stance, Move>>> = {
  stand: { sit: 'sitDown', floor: 'getDown' },
  sit: { stand: 'standUp' },
  floor: { stand: 'getUp' },
};

/**
 * Переходы, которые играются задом наперёд. У Mixamo есть клип «встать после
 * отжиманий», а «лечь на отжимания» нет; тот же клип с конца — это и есть
 * «лечь»: человек приседает, ставит руки и опускается. Отдельного файла для
 * этого не заводим — клип один, действия два (`useCharacter`).
 */
const REVERSED: Partial<Record<Move, true>> = { getDown: true };

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
 * Переходы, во время которых подъём на сиденье едет вместе с клипом.
 *
 * Своего таймера у подъёма нет. Раньше он ехал линейно за 1,8 с, а клип
 * усаживал человека по своей кривой — быстро в начале, медленно в конце, —
 * и они друг о друге не знали: агент садился в диван на месте, где стоял, и
 * уже сидя подтягивался на подушку. Теперь доля посадки читается из самого
 * клипа — насколько он уже опустил таз, — и на ту же долю фигуру подвозят к
 * месту. Клип кончился — таз ровно на подушке, дотягивать нечего.
 */
export type PostureMove = 'sitDown' | 'standUp';
const isPostureMove = (move: Move): move is PostureMove => move === 'sitDown' || move === 'standUp';

/** За сколько секунд кисти дотягиваются до столешницы и отпускают её. */
const REACH_TIME = 0.35;

/** Общая мишень для кистей: считается каждый кадр, но новая на каждого агента
 *  и каждый кадр была бы мусором на ровном месте. */
const hand = new THREE.Vector3();

/** Тот же приём — общий скретч под мировую позицию головы (высота бейджа). */
const headWorld = new THREE.Vector3();

/**
 * Отступ бейджа над костью головы, в тех же единицах, что рост фигуры
 * (`fit.figure.tall`). Кость сидит примерно на уровне глаз, а не макушки, —
 * отступ подобран так, чтобы бейдж стоял стоящему агенту так же, как раньше
 * фиксированное `tall + 0.55`. Число на глаз, правится тут же.
 */
const HEAD_TAG_MARGIN = 0.8;

/** Тот же отступ, но от подошв — на случай, если кости головы вдруг нет. */
const FALLBACK_TAG_MARGIN = 0.55;

/**
 * Скорость, с которой высота бейджа догоняет голову, — параметр
 * `THREE.MathUtils.damp` (экспоненциальное сглаживание, не зависящее от
 * частоты кадров). Больше число — быстрее догоняет и заметнее дрожание от
 * шага; меньше — дольше запаздывает за резкими движениями. Подобрано так,
 * чтобы шаг при ходьбе не дрожал, а поклон или посадка не выглядели вязкими.
 */
const TAG_DAMP = 12;

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

/**
 * Делитель размера подписей: чем дальше камера, тем мельче карточка. Ноль
 * (постоянный экранный размер) читался бы лучше вблизи, но при отдалении
 * восемь карточек закрывают комнату целиком — а отдалённый вид как раз и
 * нужен, чтобы видеть офис, а не читать в нём таблички.
 */
const TAG_SCALE = 15;

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
  pushup: pushUpUrl, drink: drinkUrl, dance: danceUrl,
};
/** У `getDown` файла нет: это `getUp` наоборот, см. `REVERSED`. */
const MOVE_URLS: Record<Exclude<Move, 'getDown'>, string> = {
  sitDown: sitDownUrl, standUp: standUpUrl,
  sitToType: sitToTypeUrl, typeToSit: typeToSitUrl,
  getUp: pushUpToIdleUrl,
};
export const POSE_KEYS = Object.keys(POSE_URLS) as Pose[];
const MOVE_FILE_KEYS = Object.keys(MOVE_URLS) as (keyof typeof MOVE_URLS)[];
export const MOVE_KEYS: Move[] = [...MOVE_FILE_KEYS, 'getDown'];
const CLIP_URLS = [
  charUrl, ...POSE_KEYS.map((k) => POSE_URLS[k]), ...MOVE_FILE_KEYS.map((k) => MOVE_URLS[k]),
];

export interface Loaded {
  model: THREE.Group;
  clips: Record<Pose | Move, THREE.AnimationClip>;
  /** Замеры поз: где в каждой из них таз, кисти и ступни (доли роста). */
  measure: Record<Pose, PoseMeasure>;
  /** Ход таза в клипах посадки и подъёма: откуда и куда он едет (доли роста). */
  travel: Record<PostureMove, HipsTravel>;
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
    MOVE_FILE_KEYS.forEach((k, i) => { clips[k] = loaded[1 + POSE_KEYS.length + i].animations[0]; });
    // Копия, а не тот же объект: микшер выдаёт на один клип одно действие, и
    // «лечь» с «встать» иначе делили бы одно время и одно направление.
    clips.getDown = clips.getUp.clone();
    clips.getDown.name = 'getDown';
    const poses = {} as Record<Pose, THREE.AnimationClip>;
    for (const k of POSE_KEYS) poses[k] = clips[k];
    return {
      model: loaded[0],
      clips,
      measure: measurePoses(loaded[0], poses),
      travel: measureTravel(loaded[0], { sitDown: clips.sitDown, standUp: clips.standUp }),
    };
  }, [loaded]);
}

/**
 * Детализированные фигуры: свой меш вместо общего тела, но те же клипы, что
 * у него (`useCharacter`) — они завязаны на имена костей, а не на геометрию,
 * а у детализированной модели имена костей те же, что у общей фигуры
 * (см. `Look.model`). Замеры (`measure`, `travel`) считаются заново на этой
 * геометрии: пропорции у неё свои, и высота таза или кистей в долях роста —
 * не те же числа, что у общего тела.
 *
 * Ключ — идентификатор внешности, тот же, что в `shared/looks.ts`. Нет ни
 * одной детализированной внешности — список адресов пуст, `useLoader`
 * отдаёт пустой массив, и хук возвращает пустую таблицу: все рисуются общим
 * телом. Хук вызывается всё равно, безусловно, — иначе он то есть, то нет.
 */
export function useDetailedLooks(clips: Record<Pose | Move, THREE.AnimationClip>): Record<string, Loaded> {
  const gltfs = useLoader(GLTFLoader, DETAILED_MODEL_URLS) as unknown as { scene: THREE.Group }[];
  return useMemo(() => {
    const poses = {} as Record<Pose, THREE.AnimationClip>;
    for (const k of POSE_KEYS) poses[k] = clips[k];
    const out: Record<string, Loaded> = {};
    DETAILED_LOOKS.forEach((look, i) => {
      const model = gltfs[i].scene;
      out[look.id] = {
        model,
        clips,
        measure: measurePoses(model, poses),
        travel: measureTravel(model, { sitDown: clips.sitDown, standUp: clips.standUp }),
      };
    });
    return out;
  }, [gltfs, clips]);
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
  const id = lookFor(look, i);
  return (look ? materials[look] : undefined)
    ?? (id ? materials[id] : undefined)
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
 * Подпись над головой: кто это, над чем работает и что делает прямо сейчас —
 * всё в одном бейдже на одной подложке (`.agent-badge` из kit.css, раскладка
 * для сцены — в scene.css). Раньше над агентом висели три отдельные плашки
 * (пузырь с командой, бейдж и табличка задачи); над восемью агентами это
 * превращалось в три этажа карточек, перекрывающих друг друга.
 *
 * Рядов ровно три, и появляются они все вместе: подпись сотрудника (та же, что
 * в окне «Команда»: имя или профессия с номером), задача (номер плашкой и
 * название), текущая команда. Без задачи остаётся один верхний ряд —
 * пустых строк в бейдже нет. Точки состояния здесь больше нет: по сцене и так
 * видно, идёт человек, сидит за столом или стоит без дела. Плоский офис рисует
 * ту же информацию по-своему, старым пиксельным стилем — переносить его на
 * этот рендер не входило в задачу.
 *
 * Сделана обычным DOM поверх канваса (`Html` из drei), а не текстурой с
 * текстом: текст остаётся настоящим текстом — чётким на любом зуме, с теми же
 * шрифтом и цветами темы, что во всём остальном интерфейсе. Мышь она не
 * ловит, иначе карточки перехватывали бы вращение камеры.
 *
 * Высоту держит не сама подпись, а группа-якорь снаружи (`tagAnchor` в
 * `Agent`): её `position.y` каждый кадр подтягивается к мировой высоте кости
 * головы — см. `useFrame` там же. Здесь она не читается, чтобы не заводить
 * второй источник той же высоты.
 */
function AgentTag({ anchorRef, inst, role, task }: {
  anchorRef: RefObject<THREE.Group | null>;
  inst: InstanceView;
  role?: RoleView;
  task?: TaskView | null;
}) {
  const chipColor = role?.color || NO_ROLE_COLOR;
  /**
   * Подпись сотрудника — ровно та, что в карточке окна «Команда» и в шапке
   * дровера: общая `displayInstance`. Номер она ставит только когда роль
   * нанята не в одном экземпляре, — у трёх бэкендеров голое название
   * должности одинаковое, и различить их над головой стало бы нельзя.
   * `role.title` остаётся запасным на случай, когда роль в веб не доехала.
   * Своей строки здесь не собираем: короткий код остался на аватарках, где он
   * и нужен, а переводить название нечего — его пишет сам владелец.
   */
  const title = useInstanceName(inst.id) || role?.title || '';
  // Свободному агенту показывать нечего: команда у него осталась от прошлой
  // задачи, и висела бы над головой до самой следующей.
  const note = inst.state === 'idle' ? null : inst.note;
  // Начальная высота — только для первого рендера, до первого кадра, где
  // `useFrame` в `Agent` поставит настоящую, от головы: без неё группа была
  // бы на секунду видна на полу.
  const tall = useFit((s) => s.fit.figure.tall);
  return (
    <group ref={anchorRef} position={[0, tall + FALLBACK_TAG_MARGIN, 0]}>
      <Html
        center
        distanceFactor={TAG_SCALE}
        zIndexRange={[100, 0]}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {/* `.tag3d` — точка привязки нулевого размера, бейдж растёт от неё
            вверх (см. scene.css). Иначе `center` у `Html` держал бы по центру
            середину бейджа, и каждое появление нижних рядов сдвигало бы
            верхний — над неподвижным агентом подпись дёргалась бы сама. */}
        <div className="tag3d">
          <div
            className="agent-badge"
            // Цвет роли уезжает в CSS переменной: им красится обводка всей
            // подложки — см. `.tag3d .agent-badge` в scene.css.
            style={{ '--role': chipColor } as CSSProperties}
            // У названного сотрудника `label` — это его имя, профессии в нём
            // нет; подсказка дописывает её, чтобы «Вася» не оставался без
            // должности. У безымянного подсказка равна самой подписи.
            title={inst.name && role ? `${inst.name} · ${role.title}` : title}
          >
            {/* Верхний ряд — цветом роли: значка с кодом больше нет, и краска
                роли держится на самой шапке. Чернила по её яркости, иначе
                тёмно-синяя роль съела бы чёрный текст. */}
            <div
              className="agent-badge-head"
              style={{ background: chipColor, color: inkOn(chipColor) }}
            >
              {title}
            </div>
            {task && (
              <>
                <div className="agent-badge-task-row">
                  <span className="agent-badge-task">{task.id}</span>
                  <span className="agent-badge-title" title={task.title}>{task.title}</span>
                </div>
                {note && <div className="agent-badge-note">{note}</div>}
              </>
            )}
          </div>
        </div>
      </Html>
    </group>
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
 *
 * `material` — `null` у детализированных внешностей: у них уже двадцать
 * мешей со своими материалами (шевелюра, глаза, одежда), и красить их одной
 * плашкой скина значило бы стереть всю раскраску модели.
 */
export function buildRig(
  loaded: Loaded, material: THREE.Material | null, tall: number, phase: number,
): Rig {
  // Клонировать скелет обычным `clone()` нельзя: у копий остались бы кости
  // оригинала и все агенты двигались бы как один.
  const figure = cloneSkinned(loaded.model);
  const box = new THREE.Box3().setFromObject(figure);
  figure.scale.setScalar(tall / Math.max(box.max.y - box.min.y, 1e-6));
  figure.rotation.y = MODEL_YAW;
  figure.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      if (material) o.material = material;
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
  const start = (key: Pose | Move): THREE.AnimationAction => {
    const a = actions[key].reset();
    // Переходы играются с начала: посадка с середины — это прыжок на подушку.
    if ((POSE_KEYS as readonly string[]).includes(key)) {
      a.time = (phase * a.getClip().duration) % a.getClip().duration;
    } else if (REVERSED[key as Move]) {
      // Обратный переход: с конца к началу. `reset` время обнуляет, а
      // направление не трогает — ставим оба сами.
      a.timeScale = -1;
      a.time = a.getClip().duration;
    }
    return a;
  };
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

  /** Таз — по нему в кадре читается, насколько клип посадки уже усадил. */
  const hips = figure.getObjectByName(BONES.hips);

  /**
   * Голова — по ней в кадре читается высота бейджа: ищется один раз здесь,
   * тем же приёмом, что кости рук и таз, а не обходом сцены в каждом кадре.
   */
  const head = figure.getObjectByName('Head') ?? null;

  /**
   * Высота таза в долях роста, как в замерах (`measure.ts`): считается от
   * самой фигуры, поэтому ни подъём на сиденье, ни поездка по комнате на
   * число не влияют. Матрицы обновляются здесь же: рендер сделает это позже,
   * а таз нужен сейчас.
   */
  const local = new THREE.Vector3();
  const hipsY = (): number => {
    if (!hips) return 0;
    figure.updateMatrixWorld(true);
    hips.getWorldPosition(local);
    figure.worldToLocal(local);
    return local.y * figure.scale.y / tall;
  };

  return { figure, mixer, actions, arms, start, hipsY, head };
}

export interface Rig {
  figure: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<Pose | Move, THREE.AnimationAction>;
  /**
   * Запустить клип заново. Не голым `reset()`: он обнуляет время, и сдвиг
   * фазы жил только до первой смены позы — пришедшие на диван в одном кадре
   * дальше играли синхронно.
   */
  start: (key: Pose | Move) => THREE.AnimationAction;
  arms: Arm[];
  /** Высота таза в текущем кадре, доли роста — та же шкала, что у замеров. */
  hipsY: () => number;
  /** Кость головы — нет её, только если модель пришла без скелета. */
  head: THREE.Object3D | null;
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
  /** `null` у детализированных внешностей — своя раскраска, поверх её не кладут. */
  material: THREE.Material | null;
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

  /**
   * Якорь бейджа — третья группа на внешней, рядом с кольцом и мишенью, но
   * с собственной высотой: в кадре её `position.y` подтягивается к мировой
   * высоте головы (см. useFrame), пока `group` и `seat` едут и поднимаются
   * каждая по своему закону.
   */
  const tagAnchor = useRef<THREE.Group>(null);
  /** Текущая высота бейджа со сглаживанием; `null` — ещё не было кадра. */
  const tagY = useRef<number | null>(null);

  /** Числа подгонки: рост фигуры, высоты посадки, скорость, IK. */
  const fit = useFit((s) => s.fit);
  const tall = fit.figure.tall;
  /** Высоты поверхностей у моделей набора — сиденья и столешницы. */
  const models = useModelMeasures();

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
  /** Куда ведём через промежуточную стойку: с сиденья на пол прямого клипа
   *  нет, и `pending` держит «встать», а сюда записана конечная поза. */
  const via = useRef<Pose | null>(null);

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
    via.current = null;
    rig.start('idle').play();

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
      const move = rig.actions[transition.current];
      pending.current = null;
      transition.current = null;
      /**
       * Доигравший переход надо погасить, а не просто оставить: клип с
       * `clampWhenFinished` замирает на последнем кадре, но из микшера не
       * уходит и весит по-прежнему единицу. Поза, включённая поверх него с
       * тем же весом, смешивалась с ним поровну, и сидящий навсегда оставался
       * на полпути между «садится» и «сидит» — таз на ладонь глубже в диване,
       * чем у той же позы на стенде, где переходов нет.
       */
      rig.start(next).setEffectiveWeight(1).crossFadeFrom(move, FADE, false).play();
      pose.current = next;
      // Промежуточная стойка достигнута: конечную позу запросит следующий кадр.
      via.current = null;
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
    if (next === pose.current || next === pending.current || next === via.current) return;
    via.current = null;
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
    let target = next;
    let move: Move | null;
    if (STANCE[from] === STANCE[next]) {
      move = from === 'sitIdle' && next === 'type' ? 'sitToType'
        : from === 'type' && next === 'sitIdle' ? 'typeToSit' : null;
    } else {
      move = STANCE_MOVES[STANCE[from]][STANCE[next]] ?? null;
      /**
       * Прямого клипа нет — с сиденья на пол и обратно. Кроссфейд тут не
       * замена: подъём на подушку уезжает в ноль за четверть секунды, и
       * человек проваливается с дивана на пол. Идём через стойку: сначала
       * встаём, а когда поза станет стоячей, `goTo` из кадра дошлёт до цели
       * вторым переходом.
       */
      if (!move) {
        move = STANCE_MOVES[STANCE[from]].stand ?? null;
        target = 'idle';
        via.current = next;
      }
    }

    rig.actions[from].fadeOut(FADE);
    if (!move) {
      rig.start(next).setEffectiveWeight(1).fadeIn(FADE).play();
      pose.current = next;
      via.current = null;
      return;
    }
    pending.current = target;
    transition.current = move;
    rig.start(move).setEffectiveWeight(1).fadeIn(FADE).play();
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
   * часам, и шаг ограничен сверху (`MAX_DT`): пропущенные кадры фигура не
   * «догоняет» прыжком через полкомнаты.
   *
   * Пока кадров нет вовсе — вкладка в фоне, вид офиса скрыт, — агент стоит
   * там, где стоял. Новые маршруты в это время не откладываются на потом, а
   * применяются сразу концом (см. эффект ниже): иначе к возврату набирается
   * очередь переходов, и возврат выглядит как сбой анимации.
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
            : interest?.kind === 'pushup' ? 'pushup'
              : interest?.kind === 'drink' ? 'drink'
                : interest?.kind === 'dance' ? 'dance'
                  : 'idle';

  /**
   * Куда смотреть стоя: за своим столом — в стол, с учётом его поворота
   * (`deskFacing`); занятие может попросить свой разворот — собеседники
   * разворачиваются друг к другу, места отдыха разворачивают от спинки
   * (`interest.yaw` из `restSeats`); иначе как обычно, на юг.
   */
  const restYaw = atDesk && fallbackDesk
    ? yawOfSide(deskFacing(layout, catalog, inst.desk.index))
    : interest?.yaw ?? REST_YAW;

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
    //
    // Скрытый вид офиса — то же самое «стой здесь», только в конце маршрута:
    // кадров нет, вести фигуру некому, и к возврату у агента накопилась бы
    // очередь чужих переходов. Проиграть её при возврате — и есть то самое
    // дёрганье: человечки идут туда, где по событиям давно стоят. Поэтому
    // агент оказывается в конце маршрута сразу, никем не увиденный, а на
    // экране анимация продолжается с места, а не догоняет прошлое.
    if (!sceneOnScreen() || pts.length < 2 || g.position.lengthSq() === 0) {
      g.position.copy(pts[pts.length - 1]);
      route.current = [];
      legIdx.current = 0;
      // Обычно это говорит кадр — только он знает, где фигура и дошла ли она.
      // Пока кадров нет, сказать некому: без этого стор считал бы следующий
      // маршрут от покинутой точки, а монитор на столе не загорелся бы.
      reportPosition(inst.id, g.position.x - FOOT_DX - offset[0], g.position.z - FOOT_DY - offset[1]);
      markArrived(inst.id, walkSeq);
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

  useFrame((_, frameDt) => {
    // Длина кадра, но не больше разумной: часы браузера идут и в фоне, и
    // первый кадр после возврата к вкладке иначе прошёл бы за фигуру
    // полкомнаты одним шагом (`MAX_DT` в `clock.ts`).
    const dt = Math.min(frameDt, MAX_DT);
    rig.mixer.update(dt);
    const g = group.current;
    if (!g) return;

    // В разговоре говорят по очереди: пока один жестикулирует, второй просто
    // стоит и слушает. Без этого пара выглядит как два человека, говорящих
    // одновременно и мимо друг друга.
    //
    // Часы — свои, сцены: часы R3F обнуляются на каждом переключении
    // `frameloop`, то есть на каждом уходе с вида офиса и возврате, и очередь
    // начиналась заново — собеседники разом менялись ролями (`clock.ts`).
    const speaking = speaksFirst === (Math.floor(sceneTime() / TALK_TURN) % 2 === 0);
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
     * Подъём на сиденье — вместе с клипом посадки, а не по своим часам.
     *
     * Пока играет `sitDown` или `standUp`, доля посадки читается из самой
     * фигуры: где сейчас таз между «стоял» и «сел» по замеру этого клипа
     * (`travel`). Клип опустил таз на треть — фигура на треть пути к подушке;
     * клип доиграл — таз ровно на подушке. Так посадка происходит на месте,
     * а не «сел, где стоял, и подтянулся».
     *
     * Вне этих клипов доля просто доезжает до цели за время кроссфейда: так
     * прерванная посадка возвращается назад ровно с той скоростью, с какой
     * гаснет её клип, а после доигравшего `sitDown` доводится остаток, если
     * замер конца клипа и первый кадр сидячей позы чуть разошлись.
     *
     * Цель берётся по той позе, к которой ведёт переход, а не по нынешней:
     * пока играет `sitDown`, поза формально ещё стоячая, а человек уже
     * садится.
     */
    const move = transition.current;
    if (move && isPostureMove(move)) {
      const { from, to } = loaded.travel[move];
      const done = Math.abs(from - to) > 1e-6 ? (rig.hipsY() - from) / (to - from) : 1;
      const sitting = move === 'sitDown';
      posture.current = THREE.MathUtils.clamp(sitting ? done : 1 - done, 0, 1);
    } else {
      const wants = SEATED[pending.current ?? pose.current] ? 1 : 0;
      const step = dt / FADE;
      posture.current += THREE.MathUtils.clamp(wants - posture.current, -step, step);
    }
    const s = seat.current;
    if (s) {
      s.position.set(
        lift[0] * posture.current,
        lift[1] * posture.current,
        lift[2] * posture.current,
      );
    }

    /**
     * Мировые матрицы обновляются здесь один раз за кадр: и голове для
     * бейджа, и рукам для дотягивания ниже нужны мировые координаты уже
     * поставленной фигуры, а не той, что рендер посчитает только на выходе.
     */
    g.updateMatrixWorld(true);

    /**
     * Высота бейджа — мировая высота кости головы, переведённая в систему
     * координат внешней группы (`g`): так из неё вычитаются положение агента
     * в комнате и его разворот, но остаётся всё, что меняет рост фигуры на
     * месте — присед в шаге, посадка, наклон анимации. Дальше — сглаживание
     * `damp`, чтобы шум по кадрам не превращался в дрожание таблички.
     */
    let targetTagY = tall + FALLBACK_TAG_MARGIN;
    if (rig.head) {
      rig.head.getWorldPosition(headWorld);
      targetTagY = g.worldToLocal(headWorld).y + HEAD_TAG_MARGIN;
    }
    tagY.current = tagY.current === null
      ? targetTagY
      : THREE.MathUtils.damp(tagY.current, targetTagY, TAG_DAMP, dt);
    if (tagAnchor.current) tagAnchor.current.position.y = tagY.current;

    /**
     * Дотягивание кистей до столешницы.
     *
     * Вес нарастает и спадает, а не включается щелчком: рука, мгновенно
     * поднятая на стол в момент смены позы, — это дёрганье, которое видно
     * даже мельком.
     */
    const pull = handsY !== null && !pending.current
      && poseFit(fit, pose.current).reach ? 1 : 0;
    const rstep = dt / REACH_TIME;
    reachW.current += THREE.MathUtils.clamp(pull - reachW.current, -rstep, rstep);
    if (reachW.current > 1e-3 && handsY !== null) {
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
          агента по комнате. Кольцо и мишень остаются на внешней, то есть на
          полу; у подписи своя, третья группа — `tagAnchor` в `AgentTag`,
          её высота в кадре подтягивается к голове (см. useFrame выше). */}
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
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
        }}
      >
        <cylinderGeometry args={[0.45, 0.45, tall, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {ring && <Ring color={ring} />}
      <AgentTag anchorRef={tagAnchor} inst={inst} role={role} task={task} />
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
  const detailed = useDetailedLooks(loaded.clips);
  const list = Object.values(instances);
  const inMeeting = new Set(meeting?.status === 'running' ? meeting.participants : []);

  /** Кто чем занят. Считается тем же модулем, что раздаёт свободным агентам
   *  места в сторе, — иначе поза разъехалась бы с координатой. */
  // Ротация занятий (`restRev`) меняет раздачу, не меняя ни одного агента:
  // без неё в зависимостях человек шёл бы на новое место со старой позой.
  const restRev = useStore((s) => s.restRev);
  const interests = useMemo(
    () => interestsFor(layout, catalog, instances, roles),
    [layout, instances, roles, restRev],  // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <>
      {list.map((inst, i) => {
        const role = roles.find((r) => r.id === inst.roleId);
        // Детализированная внешность приносит свою фигуру и свою раскраску
        // (`Look.model`): скиновую текстуру на неё не кладут — `material`
        // остаётся `null`, а `buildRig` оставляет меши как есть.
        const lookId = lookFor(role?.sprite, i);
        const detail = lookId ? detailed[lookId] : undefined;
        return (
          <Agent
            key={inst.id}
            inst={inst}
            loaded={detail ?? loaded}
            material={detail ? null : skinMaterial(materials, role?.sprite, i)}
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

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
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import charUrl from '../../../design/models/characters/character.fbx?url';
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
import { deskPoint, kitchenSeats } from '../../shared/layout';
import type { Layout } from '../../shared/layout';
import { catalog } from '../layoutData';
import { useStore } from '../store';
import { STATE_ICON, STATE_TEXT } from '../agentState';
import type { AgentState, InstanceView, RoleView, TaskView } from '../../shared/types';

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
 * Позы, в которых бывает агент. Сидячие и стоячие разделены не для красоты:
 * переход между группами нельзя проиграть кроссфейдом — человек должен встать
 * или сесть, и на это есть отдельные клипы.
 */
type Pose = 'walk' | 'talk' | 'type' | 'sitIdle' | 'sitTalk' | 'game';

const SEATED: Record<Pose, boolean> = {
  walk: false, talk: false, type: true, sitIdle: true, sitTalk: true, game: true,
};

/** Переходы между позами — играются один раз и замирают на последнем кадре. */
type Move = 'sitDown' | 'standUp' | 'sitToType' | 'typeToSit';

/** Длительность кроссфейда между зацикленными позами, секунды. */
const FADE = 0.25;

/**
 * Скорость проигрывания шага. Наш агент идёт со скоростью, которую задаёт
 * `legDurationMs` в сторе, а клип нарисован со своей: разойдясь, они дают
 * скольжение ног по полу. Число подобрано на глаз под нынешнюю скорость
 * ходьбы; вернее было бы считать его из длины шага, но для этого нужна
 * длина шага, а её в клипе не написано.
 */
const WALK_TIMESCALE = 1.0;

/** Ниже этого расстояния до цели (тайлы) считаем, что агент стоит. */
const MOVING_EPS = 0.02;

/** Скорость доворота фигуры, радиан в секунду. */
const TURN_SPEED = 9;

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
 * (`drop-shadow` по классу состояния в styles.css). В 3D тот же приём не
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
 * Цвет кружка состояния. Цветом помечены все состояния, а не только
 * безыконные: кружок в подписи залит целиком, и оставлять его бесцветным
 * там, где есть эмодзи, значило бы терять единственную метку, которую видно
 * у свёрнутой подписи с другого конца комнаты.
 */
const STATE_COLOR: Record<AgentState, string> = {
  idle: '#5fd35a', walking: '#8a93a8', thinking: '#f0b429', working: '#f0b429',
  talking: '#f0b429', waiting_approval: '#ff6b57', paused: '#8a93a8',
  blocked: '#ff6b57', done: '#5fd35a', failed: '#ff6b57',
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

/** Цвет значка, если роль неизвестна — например, её удалили из офиса. */
const NO_ROLE_COLOR = '#94a3b8';

/**
 * Короткое обозначение должности с номером: `backend#1` → `B1`, `pm#1` → `PM1`.
 *
 * Считается по идентификатору роли, а не по её названию: идентификатор
 * латинский, без пробелов и не меняется при переименовании должности, —
 * значок остаётся тем же, как бы роль ни назвали в интерфейсе. Двухбуквенные
 * идентификаторы (`pm`) берутся целиком: «P» вместо «PM» узнаётся хуже.
 */
function shortTag(inst: InstanceView): string {
  const n = inst.id.split('#')[1] ?? '';
  const id = inst.roleId || '?';
  const abbr = id.length <= 2 ? id.toUpperCase() : id[0].toUpperCase();
  return `${abbr}${n}`;
}

/** Порядок загрузки: модель, потом клипы поз, потом клипы переходов. */
const POSE_URLS: Record<Pose, string> = {
  walk: walkUrl, talk: talkUrl, type: typeUrl,
  sitIdle: sitIdleUrl, sitTalk: sitTalkUrl, game: gameUrl,
};
const MOVE_URLS: Record<Move, string> = {
  sitDown: sitDownUrl, standUp: standUpUrl,
  sitToType: sitToTypeUrl, typeToSit: typeToSitUrl,
};
const POSE_KEYS = Object.keys(POSE_URLS) as Pose[];
const MOVE_KEYS = Object.keys(MOVE_URLS) as Move[];
const CLIP_URLS = [charUrl, ...POSE_KEYS.map((k) => POSE_URLS[k]), ...MOVE_KEYS.map((k) => MOVE_URLS[k])];

interface Loaded {
  model: THREE.Group;
  clips: Record<Pose | Move, THREE.AnimationClip>;
}

/**
 * Убирает из клипа горизонтальное перемещение корня.
 *
 * У Mixamo есть галочка «In Place», но полагаться на то, что её не забыли
 * нажать, нельзя: с движением корня фигура уедет сама — а её ещё и наш код
 * везёт по пути, — и ноги разъедутся с телом. Вертикальную составляющую
 * оставляем: это покачивание при шаге, оно на месте и должно остаться.
 */
function inPlace(clip: THREE.AnimationClip): THREE.AnimationClip {
  for (const track of clip.tracks) {
    if (!/Hips\.position$/.test(track.name)) continue;
    for (let i = 0; i < track.values.length; i += 3) {
      track.values[i] = 0;
      track.values[i + 2] = 0;
    }
  }
  return clip;
}

function useCharacter(): Loaded {
  const loaded = useLoader(FBXLoader, CLIP_URLS) as unknown as THREE.Group[];
  return useMemo(() => {
    const clips = {} as Record<Pose | Move, THREE.AnimationClip>;
    POSE_KEYS.forEach((k, i) => { clips[k] = loaded[1 + i].animations[0]; });
    MOVE_KEYS.forEach((k, i) => { clips[k] = loaded[1 + POSE_KEYS.length + i].animations[0]; });
    inPlace(clips.walk);
    return { model: loaded[0], clips };
  }, [loaded]);
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
    return new THREE.MeshLambertMaterial({ map });
  }), [textures]);
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
 * Подпись над головой: кто это, что делает и над чем. Повторяет карточку
 * плоского офиса вплоть до порядка строк — это один и тот же интерфейс,
 * просто нарисованный в другой проекции.
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
  /** Показывать название должности и задачу, а не только значок с состоянием. */
  expanded: boolean;
}) {
  const icon = STATE_ICON[inst.state];
  const chipColor = role?.color || NO_ROLE_COLOR;
  return (
    <Html
      center
      position={[0, AGENT_TALL + 0.55, 0]}
      distanceFactor={TAG_SCALE}
      zIndexRange={[100, 0]}
      style={{ pointerEvents: 'none', userSelect: 'none' }}
    >
      <div className="tag3d">
        {inst.note && inst.state !== 'idle' && <div className="tag3d-bubble">{inst.note}</div>}
        <div className="tag3d-card">
          <div className={`tag3d-row${expanded ? '' : ' compact'}`}>
            {/* Цвет значка — цвет роли из её настроек, тот же, что у неё в
                панели команды: раскрашивать должности заново значило бы
                завести второй набор цветов для тех же ролей. */}
            <span
              className="tag3d-chip"
              style={{ background: chipColor, color: inkOn(chipColor) }}
            >
              {shortTag(inst)}
            </span>
            {expanded && (
              <span className="tag3d-name">
                {inst.deskless && <span title="Без рабочего места — не хватило столов в раскладке">🪑 </span>}
                {role?.title ?? inst.label}
              </span>
            )}
            {/* Состояние — иконкой: у большинства состояний она своя, у
                «свободен» и «идёт» её нет, и там кружок берёт цвет. Круг
                фиксированного размера, чтобы строка не прыгала при смене
                состояния. */}
            <span
              className="tag3d-state"
              style={{ background: STATE_COLOR[inst.state] }}
              title={STATE_TEXT[inst.state]}
            >
              {icon}
            </span>
          </div>
        </div>
        {/* Задача — отдельной табличкой под капсулой, а не второй строкой
            внутри неё: строка растянула бы капсулу по высоте, и залитые
            концы повисли бы в пустоте посреди неё. */}
        {expanded && task && <div className="tag3d-task">{task.id} · {task.title}</div>}
      </div>
    </Html>
  );
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
  inst, loaded, material, layout, offset, role, task, selected, inMeeting, seats, seatPose,
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
  /** Настоящие посадочные места отдыха — те, что объявлены слотами предмета. */
  seats: { x: number; y: number }[];
  /** Чем этот агент занимает себя, сидя на диване. */
  seatPose: Pose;
}) {
  const pos = useStore((s) => s.pos[inst.id]);
  const select = useStore((s) => s.select);
  const group = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);

  /**
   * Развёрнутая подпись — только там, где её есть смысл читать.
   *
   * Восемь карточек с названиями должностей превращаются в кашу, стоит
   * агентам собраться рядом: в зоне отдыха они стоят плечом к плечу и почти
   * всегда все сразу. Уменьшать шрифт бесполезно — каша станет мельче, но
   * читаться не начнёт. Поэтому подпись сворачивается до значка с номером и
   * кружка состояния: у восьми узких значков фиксированной ширины шансов
   * налезть друг на друга несравнимо меньше, чем у восьми названий.
   *
   * Разворачивается она тогда, когда там правда есть что прочесть: агент
   * выбран, под курсором, или занят делом. Свободный агент, стоящий в
   * лаунже, ничего интересного подписью не сообщает — его должность видна по
   * значку.
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
  const rig = useMemo(() => {
    // Клонировать скелет обычным `clone()` нельзя: у копий остались бы кости
    // оригинала и все агенты двигались бы как один.
    const figure = cloneSkinned(loaded.model);
    const box = new THREE.Box3().setFromObject(figure);
    figure.scale.setScalar(AGENT_TALL / Math.max(box.max.y - box.min.y, 1e-6));
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
    actions.walk.timeScale = WALK_TIMESCALE;
    return { figure, mixer, actions };
  }, [loaded, material]);

  /** Поза, которая играет сейчас, и поза, к которой ведёт текущий переход. */
  const pose = useRef<Pose>('talk');
  const pending = useRef<Pose | null>(null);

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
    pose.current = 'talk';
    pending.current = null;
    rig.actions.talk.reset().play();

    /**
     * Доиграл переход — включаем позу, ради которой он игрался. Отдельным
     * событием, а не таймером на длину клипа: длины у клипов разные, а
     * промахнувшийся таймер даёт либо рывок, либо застывшую фигуру.
     */
    const onFinished = () => {
      const next = pending.current;
      if (!next) return;
      pending.current = null;
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
    rig.actions[move].reset().setEffectiveWeight(1).fadeIn(FADE).play();
  };

  /** Цель в мировых координатах и сколько секунд на неё отведено. */
  const target = useRef(new THREE.Vector3());
  const remain = useRef(0);
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

  /**
   * Чем агент занят, когда стоит на месте.
   *
   * Сесть можно не везде: за своим столом и на диване — местам, которые
   * объявлены слотами в каталоге. В остальных точках (свободных мест на
   * диване всего три, а отдыхающих бывает больше) агент остаётся стоять.
   * Проверка — по совпадению с посадочным местом, а не по «он в комнате
   * отдыха»: комната большая, а подушек три.
   */
  const onSeat = seats.some((s) => Math.abs(s.x - point.x) < 0.01 && Math.abs(s.y - point.y) < 0.01);
  const busy = inst.state === 'working' || inst.state === 'thinking';
  const chatting = inst.state === 'talking';
  const restPose: Pose = inMeeting ? 'sitTalk'
    : atDesk ? (busy ? 'type' : 'sitIdle')
      : onSeat ? (chatting ? 'sitTalk' : seatPose)
        : 'talk';

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
    rig.mixer.update(dt);
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
      goTo('walk');
    } else {
      g.position.copy(target.current);
      remain.current = 0;
      yaw.current = REST_YAW;
      goTo(restPose);
    }

    // Доворот по кратчайшей дуге: без нормализации разницы фигура на переходе
    // через π крутанулась бы вокруг себя.
    let delta = yaw.current - g.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    g.rotation.y += delta * Math.min(1, dt * TURN_SPEED);
  });

  const ring = selected || inMeeting ? ACCENT : STATE_RING[inst.state];

  return (
    <group ref={group}>
      <primitive object={rig.figure} />

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
        position={[0, AGENT_TALL / 2, 0]}
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
        <cylinderGeometry args={[0.45, 0.45, AGENT_TALL, 8]} />
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

  /** Места, на которых действительно можно сидеть, — из слотов предмета, без
   *  добранных `extendSeats` рядов: те ряды стоят на голом полу. */
  const seats = useMemo(() => kitchenSeats(layout, catalog), [layout]);

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
          role={roles.find((r) => r.id === inst.roleId)}
          task={inst.currentTaskId ? tasks[inst.currentTaskId] : null}
          selected={selected === inst.id}
          inMeeting={inMeeting.has(inst.id)}
          seats={seats}
          // Один из трёх на диване играет, остальные сидят просто так: без
          // этого зона отдыха выглядит рядом одинаковых манекенов. Выбор по
          // номеру, а не случайный, — иначе поза менялась бы при каждой
          // перерисовке.
          seatPose={i % 3 === 0 ? 'game' : 'sitIdle'}
        />
      ))}
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

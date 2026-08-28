/**
 * Аватарка агента: та же 3D-модель, что стоит в комнате, но кадром на
 * голову вместо фигуры целиком — крупный план с покоем-анимацией, как на
 * витрине персонажа, а не в офисе сверху.
 *
 * Первое место подключения — список ролей в окне «Команда». Компонент
 * написан безотносительно к нему: принимает роль/внешность и размер через
 * `className`, так что следующая задача сможет расставить его по остальным
 * местам, где сейчас висит плоский спрайт (`sprites.ts`), не меняя саму
 * аватарку.
 *
 * **Один холст на все аватарки.** Пятнадцать `<canvas>` на экране — это
 * пятнадцать контекстов WebGL, а у браузера их в районе восьми-шестнадцати
 * на страницу; упереться в лимит в списке ролей более чем реально. Вместо
 * этого используется `View` из `@react-three/drei` — общий приём «один
 * рендерер, много вьюпортов»: единственный `<Canvas>` растянут поверх всей
 * страницы (`AvatarStage`, `pointer-events: none`, сам ничего не ловит), а
 * каждая аватарка заводит только обычный `<div>` в потоке разметки. Этот
 * `<div>` не рисует ничего сам — он лишь размечает на странице прямоугольник
 * (`getBoundingClientRect`), в который холст рисует свою фигуру через
 * scissor-тест. Снаружи это неотличимо от канваса внутри `<div>`.
 *
 * `AvatarStage` — сама сцена — монтируется ровно один раз тем местом,
 * которое показывает аватарки (сейчас — `TeamWindow`). Монтировать её
 * дважды нельзя: `View.Port` — это выход общего тоннеля (`tunnel-rat`), и
 * второй выход просто продублирует рисунок первого. Когда аватарки
 * появятся во втором месте интерфейса, сцену придётся поднять туда, откуда
 * видны оба (скорее всего в `App.tsx`), — это оставлено следующей задаче,
 * которая и решит, где остальные места на самом деле находятся.
 *
 * **Экономия на невидимых.** У каждой аватарки есть `IntersectionObserver`
 * за собственным `<div>`: пока она ни разу не попала в кадр, 3D-фигура для
 * неё вовсе не строится (ни клона скелета, ни микшера — просто нечего
 * обновлять). Как только она попала в кадр — фигура остаётся построенной
 * (переоткрывать её каждый раз, когда список прокрутили туда-обратно, дороже,
 * чем один раз подержать в памяти простаивающий скелет), но покой-анимация
 * останавливается, стоит аватарке снова уйти с экрана: `mixer.update` не
 * вызывается, счётчик кадров стоит. Ту же экономию даёт закрытая панель —
 * `TeamWindow` размонтируется целиком, вместе с ней исчезают все аватарки и
 * общий холст.
 *
 * **Камера.** Персонаж смотрит в +Z (см. `Agents3D.tsx`, `MODEL_YAW`),
 * поэтому камера стоит перед ним на той же оси, глядя точно назад — без
 * наклона и разворота. Высота цели — не догадка на глаз, а измеренное
 * положение кости `Head` в T-позе модели (`headFractionOf`): для мультяшной
 * фигуры с непропорционально крупной головой доля роста, на которой
 * находится лицо, не совпадает с той, что у обычного человека.
 *
 * **Фолбэк.** Нет WebGL, холст ни разу не создался или модель не
 * загрузилась — аватарка показывает тот же пиксельный спрайт, что раньше
 * рисовался всегда (`sprites.ts`), тем же размером: разметка не дёргается,
 * какая бы причина ни сработала.
 */
import {
  Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { PerspectiveCamera, View } from '@react-three/drei';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import charUrl from '../../../design/models/characters/character.fbx?url';
import idleUrl from '../../../design/models/characters/animations/idle.fbx?url';
import { skinMaterial, useSkinMaterials } from './Agents3D';
import { paletteOf } from './palette';
import { useStore } from '../store';
import { agentSpriteName, spriteOf } from '../sprites';
import { useAvatarStage } from './avatarStage';

/** Рост фигуры в сцене-портрете. Произвольная единица: от неё же считается
 *  кадрирование, поэтому пересчитывать его при смене роста не нужно. */
const TALL = 1;

/**
 * Кадрирование: доля роста по вертикали, которая должна попасть в кадр —
 * голова, шея и намёк на плечи. Угол обзора взят узким (в духе портретного
 * объектива) — так лицо не тянет перспективой, а расстояние досчитано из
 * угла и желаемой высоты кадра, а не подобрано отдельно.
 */
const FOV = 28;
const FRAME_H = 0.34;
const DIST = FRAME_H / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));

/** Есть ли в браузере WebGL. Проверяется один раз и кэшируется: создавать
 *  пробный канвas на каждую аватарку незачем. */
let webglOk: boolean | null = null;
function webglSupported(): boolean {
  if (webglOk !== null) return webglOk;
  try {
    const probe = document.createElement('canvas');
    webglOk = !!(probe.getContext('webgl2') || probe.getContext('webgl'));
  } catch {
    webglOk = false;
  }
  return webglOk;
}

/**
 * Доля роста, на которой у фигуры кость `Head`, — мерится по T-позе модели,
 * один раз на неё (модель одна на все аватарки — из кеша `useLoader`), а не
 * на каждую фигуру.
 *
 * Тот же приём, что в `measure.ts`: клон нормируется к единичному росту, и
 * дальше число — это доля, а не мировая координата, поэтому не зависит от
 * `TALL`.
 */
const headFraction = new WeakMap<THREE.Object3D, number>();
function headFractionOf(model: THREE.Object3D): number {
  const cached = headFraction.get(model);
  if (cached !== undefined) return cached;
  const figure = cloneSkinned(model);
  figure.position.set(0, 0, 0);
  figure.rotation.set(0, 0, 0);
  const box = new THREE.Box3().setFromObject(figure);
  figure.scale.setScalar(1 / Math.max(box.max.y - box.min.y, 1e-6));
  figure.updateMatrixWorld(true);
  const head = figure.getObjectByName('Head');
  // Кости не нашлось — маловероятно, но фигура без головы хуже, чем фигура
  // чуть не в фокусе: подставляем разумное умолчание вместо падения.
  const y = head ? head.getWorldPosition(new THREE.Vector3()).y : 0.88;
  headFraction.set(model, y);
  return y;
}

/** Простой хэш строки — стабильный, но не крутящийся при каждой перерисовке
 *  индекс внешности по умолчанию для роли, у которой её никто не выбирал. */
function hashIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Свет портрета — тот же рецепт, что у общего света комнаты и у карточек
 *  выбора внешности (`LookPicker.tsx`), только без второго заполняющего
 *  источника: фигура тут одна и крупная, тени от второго источника на лице
 *  только мешали бы. */
function Light() {
  const theme = useStore((s) => s.theme);
  const light = paletteOf(theme).light;
  return (
    <>
      <hemisphereLight args={[light.skyColor, light.groundColor, light.ambient]} />
      <directionalLight
        position={[-1, 2, 3]} color={light.keyColor} intensity={light.keyIntensity * 0.7}
      />
    </>
  );
}

/**
 * Фигура и её покой-анимация. Загрузка — минимальная: только модель и клип
 * покоя (те же файлы, что грузит `LookPicker.tsx`), а не весь набор поз, что
 * держит комната, — портрету остальные позы не нужны.
 */
function Portrait({ look, index, phase, active }: {
  look: string | undefined;
  index: number;
  /** Доля цикла анимации, с которой стартует эта фигура — иначе все
   *  аватарки дышат в такт (см. тот же приём в `Agents3D.tsx`). */
  phase: number;
  /** Копится ли анимация: аватарка сейчас видна на экране. */
  active: boolean;
}) {
  const [model, idle] = useLoader(FBXLoader, [charUrl, idleUrl]) as unknown as THREE.Group[];
  const materials = useSkinMaterials();
  const material = skinMaterial(materials, look, index);

  // Фигура, микшер и действие — одним мемо: тот же довод, что у `buildRig`
  // в `Agents3D.tsx` — порознь их разносит двойной вызов фабрик в StrictMode.
  const { figure, mixer, action } = useMemo(() => {
    const object = cloneSkinned(model);
    const box = new THREE.Box3().setFromObject(object);
    object.scale.setScalar(TALL / Math.max(box.max.y - box.min.y, 1e-6));
    object.traverse((o) => { if (o instanceof THREE.Mesh) o.material = material; });
    const anim = new THREE.AnimationMixer(object);
    const act = anim.clipAction(idle.animations[0]);
    return { figure: object, mixer: anim, action: act };
  }, [model, idle, material]);

  // Запуск — в эффекте, не в мемо: тот же довод про StrictMode, что и выше.
  useEffect(() => {
    action.time = phase * action.getClip().duration;
    action.reset().play();
  }, [action, phase]);

  useFrame((_, dt) => { if (active) mixer.update(dt); });

  const headY = headFractionOf(model) * TALL;
  return (
    <>
      <PerspectiveCamera makeDefault position={[0, headY, DIST]} fov={FOV} near={0.05} far={5} />
      <primitive object={figure} />
    </>
  );
}

/** Падение внутри сцены (не загрузился ассет, не собрался шейдер и т. п.) —
 *  сообщает наружу и больше ничего не рисует, чтобы React не пытался
 *  примонтировать ту же упавшую фигуру ещё раз. */
class Boundary extends Component<{ onError: () => void; children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError() { return { crashed: true }; }
  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error('аватарка агента: 3D не отрисовался, показываю спрайт', error);
    this.props.onError();
  }
  render() { return this.state.crashed ? null : this.props.children; }
}

/**
 * Общий холст — сцена-портрет на всю страницу.
 *
 * `pointer-events: none` на обёртке: сама она ничего не ловит, клики и
 * наведение остаются за тем, что показано под ней, — вьюпорты `View`
 * рисуют пиксели, но не должны перехватывать вход, аватарка не кнопка.
 *
 * Монтируется ровно один раз тем местом, что показывает аватарки, — см.
 * предупреждение в шапке файла про повторный `View.Port`.
 */
export function AvatarStage() {
  const broken = useAvatarStage((s) => s.broken);
  const setBroken = useAvatarStage((s) => s.setBroken);
  if (broken || !webglSupported()) return null;
  return (
    <div className="avatar-stage" aria-hidden>
      <Boundary onError={setBroken}>
        <Canvas gl={{ alpha: true, antialias: true }} dpr={[1, 1.5]}>
          <View.Port />
        </Canvas>
      </Boundary>
    </div>
  );
}

export interface AgentAvatarProps {
  roleId: string;
  instanceId: string;
  /** Выбранная внешность роли (`RoleEditable.sprite`); пусто — подбирается
   *  по роли, как и в комнате. */
  look?: string;
  className?: string;
}

/**
 * Одна аватарка. Публичный компонент: снаружи он либо рисует голову моделью,
 * либо — если что-то из перечисленного в шапке файла не сложилось —
 * показывает тот же пиксельный спрайт, что был до него.
 */
export function AgentAvatar({ roleId, instanceId, look, className }: AgentAvatarProps) {
  const theme = useStore((s) => s.theme);
  const stageBroken = useAvatarStage((s) => s.broken);
  const [ownBroken, setOwnBroken] = useState(false);
  const [everVisible, setEverVisible] = useState(false);
  const [visible, setVisible] = useState(false);
  const hostRef = useRef<HTMLElement | null>(null);
  // `View` отдаёт в ref `HTMLElement | THREE.Group` (второе — когда он
  // смонтирован внутри канваса, у нас не тот случай): колбэк вместо
  // `useRef<HTMLDivElement>`, чтобы не спорить с этим объединением типов.
  const setHost = (node: HTMLElement | THREE.Group | null) => {
    hostRef.current = node instanceof HTMLElement ? node : null;
  };

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting);
      if (entry.isIntersecting) setEverVisible(true);
    }, { threshold: 0.01 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const fallbackSrc = spriteOf(theme, agentSpriteName(roleId, instanceId, look));
  if (ownBroken || stageBroken || !webglSupported()) {
    return <img className={className} src={fallbackSrc} alt="" />;
  }

  const phase = (hashIndex(instanceId) % 1000) / 1000;
  const index = hashIndex(roleId);

  return (
    <View ref={setHost} as="div" className={className} visible={visible}>
      <Boundary onError={() => setOwnBroken(true)}>
        {everVisible && (
          <Suspense fallback={null}>
            <Light />
            <Portrait look={look} index={index} phase={phase} active={visible} />
          </Suspense>
        )}
      </Boundary>
    </View>
  );
}

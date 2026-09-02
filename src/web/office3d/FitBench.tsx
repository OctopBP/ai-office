/**
 * Стенд пресетов — dev-экран, на котором предмет обстановки разбирают по
 * частям: `?fit=1`, только в разработке (см. `main.tsx`).
 *
 * Зачем отдельный экран, а не ползунки в самом офисе: в офисе агенты
 * разбредаются, позы меняются сами по себе, камера ближе своего предела не
 * подъезжает, а пикселизация замыливает ровно ту деталь, которую подбираешь.
 * Здесь один предмет, и он никуда не денется, пока его крутят.
 *
 * Стенд начинался подгонкой одной фигуры под одно место и десятью случаями,
 * выписанными руками. Теперь он показывает **пресет целиком**: любой предмет
 * из `design/presets/`, человек на каждом его месте, части модели, след,
 * точки замера. Причина проста — руками выписанный список случаев отвечал на
 * вопрос «сходится ли посадка», а спрашивают у стенда другое: «правильно ли
 * описан вот этот предмет». У дивана три подушки, и увидеть надо все три
 * сразу, а не первую.
 *
 * Главное правило стенда прежнее: он не рисует «похоже». Места, посадка,
 * замеры и клипы берутся ровно те же, что в комнате, — и берутся тем же
 * кодом. Каталог для этого собирается из живого пресета прямо здесь
 * (`entryOf`), а места по нему раскладывают `restSeats`, `deskPoint` и
 * `meetingSeat` — те самые, которыми комната рассаживает агентов.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { catalog } from '../layoutData';
import { deskPoint, meetingSeat, restSeats } from '../../shared/layout';
import type { Catalog, Layout, LayoutProp } from '../../shared/layout';
import { useStore } from '../store';
import { paletteOf } from './palette';
import { FurnitureModels, Props3D, useFurnitureModels } from './Props3D';
import { place3, type Placed3 } from './props';
import { measureModel, useModelMeasures, type ModelMeasure } from './measure';
import { seatingFor } from './seating';
import { reach } from './ik';
import {
  buildRig, FOOT_DX, FOOT_DY, POSE_KEYS, skinMaterial, useCharacter, useSkinMaterials, type Pose,
} from './Agents3D';
import { FIT_RANGE, poseFit, saveFit, useFit } from './fit';
import { FILE_PRESETS, keyOf, savePreset, usePresets } from './presets';
import {
  componentOf, componentsOf, entryOf, partName, splitRef, TONES,
  type Component, type Part, type Preset,
} from '../../shared/preset';

/** Тайл в сантиметрах — весь стенд говорит числами, понятными человеку. */
const CM = 75;
const cm = (t: number | undefined): string => (t === undefined ? '—' : `${Math.round(t * CM)} см`);

/** Где на стенде стоит предмет: с запасом от края сетки со всех сторон. */
const AT: [number, number] = [2.5, 3];
/** Сколько тайлов у стендовой комнаты — только чтобы `place3` было от чего считать. */
const ROOM = 8;

/** Подписи поз: в панели они стоят рядом и должны читаться словами. */
const POSE_TITLE: Record<Pose, string> = {
  walk: 'идёт', idle: 'стоит', talk: 'говорит', type: 'печатает',
  sitIdle: 'сидит', sitTalk: 'сидит и говорит', game: 'играет',
};

/**
 * Пределы ползунков пресета.
 *
 * Отдельно от `FIT_RANGE`: те числа — про фигуру и живут в `fit.json`, эти —
 * про предмет и живут в его пресете. Общего у них только вид ползунка.
 */
const RANGE = {
  /** Точка места в плане предмета, тайлы. */
  at: { min: -2, max: 6, step: 0.01 },
  /** Мест в ряду вдоль стороны. */
  count: { min: 1, max: 8, step: 1 },
  /** Мест по кольцу и его полуоси. */
  ring: { min: 2, max: 12, step: 1 },
  radius: { min: 0.5, max: 5, step: 0.05 },
  /** Часть модели относительно центра следа. */
  partAt: { min: -2, max: 3, step: 0.005 },
  rot: { min: -180, max: 180, step: 5 },
  /** Куда бить лучом — точка в плане выровненной модели. */
  probe: { min: -1.5, max: 1.5, step: 0.01 },
  /** Перебив измеренной высоты сиденья или столешницы. */
  height: { min: 0, max: 2, step: 0.005 },
  /** Высота предмета и его след. */
  h: { min: 0, max: 4, step: 0.05 },
  foot: { min: -1, max: 8, step: 0.01 },
} as const;

// ---------------------------------------------------------------------------
// Сцена стенда
// ---------------------------------------------------------------------------

/**
 * Одно место предмета: точка, поза по умолчанию и компонент, который его
 * описывает.
 *
 * `seat` — номер места среди `seat`-компонентов, ровно тот, что приезжает из
 * раскладки вместе с местом отдыха (`RestSeat.seat`). Им же посадка находит
 * поправку: у дивана три подушки, и они не обязаны быть одинаковыми.
 */
interface Place {
  key: string;
  title: string;
  /** Индекс компонента в `preset.components` — его правят ползунки. */
  ci: number;
  /** Номер seat-компонента; у рабочего места его нет. */
  seat?: number;
  /** Точка места в тайлах, как её видит комната (до сдвига на ступни). */
  at: [number, number];
  pose: Pose;
}

/** Всё, что стенду нужно нарисовать и посчитать по выбранному предмету. */
interface Scene {
  /** Пресет предмета; пусто — «пол», человек посреди пустой комнаты. */
  preset?: Preset;
  /** Предметы сцены: сам предмет и его спутники (стул у стола). */
  props: (LayoutProp & { key: string })[];
  layout: Layout;
  catalog: Catalog;
  places: Place[];
  /** Чьи пресеты стенд правит и сохраняет: предмет плюс спутники. */
  edited: Preset[];
}

/**
 * Каталог из живых пресетов.
 *
 * Не из `catalog.json`: он собирается сборкой и отстаёт от папки пресета ровно
 * до `npm run presets:catalog`. Стенд же показывает то, что записано в пресете
 * **сейчас**, — иначе подвинутая подушка появлялась бы на экране только после
 * пересборки, и это была бы худшая из возможных лжи: числа новые, картинка
 * старая. Записи не-предметов (тайлы, агенты) берутся из файла как есть.
 */
function catalogOf(presets: Record<string, Preset>): Catalog {
  const sprites = { ...catalog.sprites };
  for (const [id, preset] of Object.entries(presets)) sprites[id] = entryOf(preset);
  return { ...catalog, sprites };
}

/**
 * Спутник места — чужая модель, по которой это место меряется.
 *
 * За столом сидят на стуле: `work.on = "chair/chairDesk"`. Стул — отдельный
 * предмет раскладки, стол его только меряет, и чтобы стенд не показывал
 * человека, сидящего в воздухе, стул надо поставить. Куда именно — считается,
 * а не выписывается: стул стоит там, где сидит человек, то есть серединой
 * своего габарита в точке его ступней. В `studio` он поставлен руками, и
 * расхождение с этим расчётом — девять сантиметров.
 */
function companionsOf(
  preset: Preset, places: Place[], presets: Record<string, Preset>,
): { sprite: string; at: [number, number] }[] {
  const out: { sprite: string; at: [number, number] }[] = [];
  for (const place of places) {
    const c = preset.components[place.ci];
    const on = c && 'on' in c ? c.on : undefined;
    if (!on) continue;
    const owner = splitRef(on).preset;
    if (!owner || owner === preset.id) continue;
    const mate = presets[owner];
    if (!mate) continue;
    const [w, h] = mate.size;
    out.push({ sprite: owner, at: [place.at[0] + FOOT_DX - w / 2, place.at[1] + FOOT_DY - h / 2] });
  }
  return out;
}

/**
 * Места предмета — теми же формулами, которыми их считает комната.
 *
 * Три источника, потому что три формы места, и каждая живёт в раскладке своей
 * жизнью: точка и ряд вдоль стороны приезжают из `restSeats`, кольцо
 * переговорки раскладывает `meetingSeat`, рабочее место находит `deskPoint`.
 * Второй способ разложить их здесь означал бы, что стенд рисует похожее.
 */
function placesOf(preset: Preset, layout: Layout, cat: Catalog): Place[] {
  const seats = restSeats(layout, cat);
  const order = componentsOf(preset, 'seat');
  const out: Place[] = [];

  preset.components.forEach((c, ci) => {
    if (c.type === 'work') {
      const at = deskPoint(layout, cat, 0, 'work');
      out.push({ key: `w${ci}`, title: 'рабочее место', ci, at: [at.x, at.y], pose: 'type' });
      return;
    }
    if (c.type !== 'seat') return;
    const seat = order.indexOf(c);
    const pose: Pose = c.use === 'game' ? 'game' : 'sitIdle';
    if (c.shape === 'ring') {
      const total = c.ring ?? 1;
      for (let i = 0; i < total; i++) {
        const at = meetingSeat(layout, cat, i, total);
        out.push({ key: `r${ci}-${i}`, title: '', ci, seat, at: [at.x, at.y], pose: 'sitTalk' });
      }
      return;
    }
    seats.filter((s) => s.seat === seat).forEach((s, i) => {
      out.push({ key: `s${ci}-${i}`, title: '', ci, seat, at: [s.at.x, s.at.y], pose });
    });
  });

  // Нумерация сквозная и человеческая: в панели место зовут «место 2», а не
  // «компонент 3, точка 0».
  let n = 0;
  for (const place of out) if (!place.title) place.title = `место ${++n}`;
  return out;
}

/** Пустой пол: человеку тоже надо где-то стоять, и это тоже случай стенда. */
const FLOOR_PLACE: Place = {
  key: 'floor', title: 'пол', ci: -1, at: [AT[0] + 1, AT[1] + 1], pose: 'idle',
};

function sceneOf(id: string, presets: Record<string, Preset>): Scene {
  const cat = catalogOf(presets);
  const preset = presets[id];
  if (!preset) {
    return {
      props: [],
      layout: { id: 'bench', size: [ROOM, ROOM], props: [] } as unknown as Layout,
      catalog: cat,
      places: [FLOOR_PLACE],
      edited: [],
    };
  }

  /**
   * Раскладка на один предмет — настоящая, а не подделанная под нужный ответ:
   * `place3`, `restSeats` и `deskPoint` читают из неё ровно `size` и `props`.
   */
  const layout = {
    id: 'bench', size: [ROOM, ROOM], props: [{ sprite: id, at: AT }],
  } as unknown as Layout;

  const places = placesOf(preset, layout, cat);
  const mates = companionsOf(preset, places, presets);
  const props = [
    { sprite: id, at: AT, key: 'bench-0' },
    ...mates.map((m, i) => ({ sprite: m.sprite, at: m.at, key: `bench-mate-${i}` })),
  ] as (LayoutProp & { key: string })[];

  return {
    preset,
    props,
    layout,
    catalog: cat,
    places: places.length ? places : [FLOOR_PLACE],
    edited: [preset, ...mates.map((m) => presets[m.sprite]).filter((p): p is Preset => !!p)],
  };
}

// ---------------------------------------------------------------------------
// Фигура
// ---------------------------------------------------------------------------

/** Что стенд показывает в цифрах — снимается с живой сцены, а не считается заново. */
interface Readout {
  seatY?: number;
  surfaceY?: number;
  hipsY: number;
  handsY: number;
  feetY: number;
}

/**
 * Фигура на стенде. Никакого стора и никаких занятий: поза задана снаружи и
 * не меняется, а посадка считается тем же `seatingFor`, что и в комнате, —
 * вместе с номером места, потому что подушки у дивана разные.
 */
function BenchFigure({ place, pose, sprite, models, marks, onRead }: {
  place: Place;
  pose: Pose;
  sprite?: string;
  /** Замеры моделей — живые, с точками луча из правящегося пресета. */
  models: Record<string, ModelMeasure>;
  /** Показывать шарики на костях: только у выбранного места, иначе рябит. */
  marks: boolean;
  onRead?: (r: Readout) => void;
}) {
  const loaded = useCharacter();
  const materials = useSkinMaterials();
  const fit = useFit((s) => s.fit);
  const tall = fit.figure.tall;
  const group = useRef<THREE.Group>(null);

  const rig = useMemo(
    () => buildRig(loaded, skinMaterial(materials, undefined, 0), tall, 0),
    [loaded, materials, tall],
  );
  useEffect(() => {
    const action = rig.actions[pose];
    action.reset().setEffectiveWeight(1).play();
    return () => { action.stop(); };
  }, [rig, pose]);

  const seat = seatingFor(fit, models, loaded.measure[pose], pose, sprite, tall, place.seat);

  const mark = useRef<THREE.Group>(null);
  const tick = useRef(0);
  const v = new THREE.Vector3();

  useFrame((state, dt) => {
    rig.mixer.update(dt);
    const g = group.current;
    if (!g) return;
    g.updateMatrixWorld(true);

    if (seat.handsY !== null) {
      for (const arm of rig.arms) {
        arm.hand.getWorldPosition(v);
        v.y = seat.handsY;
        reach(arm, v, fit.seated.ikWeight);
      }
      g.updateMatrixWorld(true);
    }

    // Шарики на костях — видно, что именно к чему привязано.
    const bones = mark.current;
    if (bones) {
      const hips = rig.figure.getObjectByName('Hips');
      const hand = rig.figure.getObjectByName('LeftHand');
      const foot = rig.figure.getObjectByName('LeftFoot');
      if (hips) bones.children[0].position.copy(hips.getWorldPosition(v));
      if (hand) bones.children[1].position.copy(hand.getWorldPosition(v));
      if (foot) bones.children[2].position.copy(foot.getWorldPosition(v));
    }

    // Цифры обновляются не каждый кадр: панель — это текст, а не анимация.
    if (!onRead) return;
    tick.current += dt;
    if (tick.current > 0.2) {
      tick.current = 0;
      const hips = rig.figure.getObjectByName('Hips')?.getWorldPosition(v.clone());
      const hand = rig.figure.getObjectByName('LeftHand')?.getWorldPosition(v.clone());
      const foot = rig.figure.getObjectByName('LeftFoot')?.getWorldPosition(v.clone());
      onRead({
        seatY: seat.seatY === undefined ? undefined : seat.seatY * fit.figure.furniture,
        surfaceY: seat.surfaceY === undefined ? undefined : seat.surfaceY * fit.figure.furniture,
        hipsY: hips?.y ?? 0,
        handsY: hand?.y ?? 0,
        feetY: foot?.y ?? 0,
      });
    }
  });

  return (
    <>
      <group
        ref={group}
        position={[place.at[0] + FOOT_DX + seat.lift[0], seat.lift[1], place.at[1] + FOOT_DY + seat.lift[2]]}
      >
        <primitive object={rig.figure} />
      </group>
      {marks && (
        <group ref={mark}>
          {['#ff6b57', '#f0b429', '#5fd35a'].map((color) => (
            <mesh key={color}>
              <sphereGeometry args={[0.05, 8, 8]} />
              <meshBasicMaterial color={color} depthTest={false} />
            </mesh>
          ))}
        </group>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Подсказки на сцене
// ---------------------------------------------------------------------------

/** Линия на высоте поверхности — видно, куда фигура должна попасть. */
function Level({ y, color, at }: { y: number; color: string; at: [number, number] }) {
  return (
    <mesh position={[at[0], y, at[1]]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[4, 4]} />
      <meshBasicMaterial
        color={color} transparent opacity={0.18} side={THREE.DoubleSide} depthWrite={false}
      />
    </mesh>
  );
}

/** Контур на полу — след предмета так же виден, как его габарит. */
function Outline({ rect, color }: { rect: [number, number, number, number]; color: string }) {
  const [x, y, w, d] = rect;
  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x, 0.01, y),
    new THREE.Vector3(x + w, 0.01, y),
    new THREE.Vector3(x + w, 0.01, y + d),
    new THREE.Vector3(x, 0.01, y + d),
  ]), [x, y, w, d]);
  return (
    <lineLoop geometry={geometry}>
      <lineBasicMaterial color={color} depthTest={false} />
    </lineLoop>
  );
}

/**
 * Куда бьёт луч замера и куда он попал.
 *
 * Точка луча — единственное число пресета, которое не видно вообще никак:
 * ошибись на десять сантиметров, и высота сиденья приедет со спинки, а
 * человек сядет на полметра выше. Столбик с шариком отвечает на это глазами.
 */
function Probe({ at, hit, color }: { at: [number, number, number]; hit?: number; color: string }) {
  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(at[0], 0, at[2]),
    new THREE.Vector3(at[0], at[1], at[2]),
  ]), [at]);
  return (
    <>
      <lineSegments geometry={geometry}>
        <lineBasicMaterial color={color} depthTest={false} />
      </lineSegments>
      {hit !== undefined && (
        <mesh position={[at[0], hit, at[2]]}>
          <sphereGeometry args={[0.04, 8, 8]} />
          <meshBasicMaterial color={color} depthTest={false} />
        </mesh>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Сцена
// ---------------------------------------------------------------------------

/**
 * Замеры моделей, где точки луча взяты из правящегося пресета.
 *
 * Общий замер набора (`useModelMeasures`) считается один раз на загруженные
 * файлы и живёт до перезагрузки — он и должен так жить, его спрашивает вся
 * комната. Но точку луча на стенде двигают ползунком, и ждать перезагрузки,
 * чтобы увидеть результат, — это ровно тот подбор вслепую, ради ухода от
 * которого стенд и написан. Поэтому части правящихся пресетов меряются здесь
 * заново, поверх общего.
 */
function useLiveMeasures(edited: Preset[]): Record<string, ModelMeasure> {
  const shared = useModelMeasures();
  const scenes = useFurnitureModels();
  return useMemo(() => {
    const made = { ...shared };
    for (const preset of edited) {
      for (const part of preset.parts ?? []) {
        const key = keyOf(preset.id, part);
        const source = scenes[key];
        // `?? {}`, а не `part.probe`: пустая точка должна значить «не мерить»,
        // а не «взять то, что записано в файле» — иначе стёртый ползунком
        // замер продолжал бы приезжать со старым числом.
        if (source) made[key] = measureModel(source, part.probe ?? {});
      }
    }
    return made;
  }, [shared, scenes, edited]);
}

/** Куда бьёт луч этой части в мировых координатах и что он там нашёл. */
function probesOf(
  scene: Scene, items: Placed3[], models: Record<string, ModelMeasure>, scale: number,
) {
  const out: { key: string; at: [number, number, number]; hit?: number; color: string }[] = [];
  for (const preset of scene.edited) {
    const item = items.find((i) => i.sprite === preset.id);
    if (!item) continue;
    for (const part of preset.parts ?? []) {
      const measure = models[keyOf(preset.id, part)];
      const [dx, dy, dz] = part.at ?? [0, 0, 0];
      const spin = ((part.rot ?? 0) * Math.PI) / 180;
      for (const kind of ['seat', 'surface'] as const) {
        const aim = part.probe?.[kind];
        if (!aim) continue;
        const p = new THREE.Vector3(aim[0] * scale, 0, aim[1] * scale).applyAxisAngle(
          new THREE.Vector3(0, 1, 0), spin,
        );
        const hit = measure?.[kind];
        out.push({
          key: `${preset.id}/${partName(part)}/${kind}`,
          at: [item.cx + dx + p.x, item.base + dy + (item.h || 1) + 0.4, item.cy + dz + p.z],
          hit: hit === undefined ? undefined : item.base + dy + hit * scale,
          color: kind === 'seat' ? '#ff6b57' : '#f0b429',
        });
      }
    }
  }
  return out;
}

/**
 * Пол, свет и подсказки — то, что рисуется сразу.
 *
 * Разделено на две части не для красоты: всё, что ждёт моделей, живёт внутри
 * `Suspense`, а сетка, пол и камера — снаружи. Стенд, целиком завешенный
 * ожиданием, показывал бы белый экран до последнего приехавшего файла — а
 * пустая комната с сеткой уже отвечает на вопрос «стенд жив».
 */
function BenchScene({ scene, sel, poses, crowd, onRead }: {
  scene: Scene;
  sel: Place;
  /** Поза каждого места — стенд помнит её отдельно от пресета. */
  poses: Record<string, Pose>;
  /** Сажать всех сразу или одного на выбранном месте. */
  crowd: boolean;
  onRead: (r: Readout) => void;
}) {
  const theme = useStore((s) => s.theme);
  const palette = paletteOf(theme);

  return (
    <>
      <ambientLight intensity={1.1} />
      <directionalLight position={[4, 8, 6]} intensity={1.6} />
      <gridHelper args={[16, 16, '#8a93a8', '#d5d8e0']} position={[4, 0.002, 4]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[4, 0, 4]} receiveShadow>
        <planeGeometry args={[16, 16]} />
        <meshLambertMaterial color={palette.floor.tile} />
      </mesh>

      <Suspense fallback={null}>
        <FurnitureModels>
          <BenchBody
            scene={scene} sel={sel} poses={poses} crowd={crowd}
            palette={palette} onRead={onRead}
          />
        </FurnitureModels>
      </Suspense>

      <OrbitControls target={[sel.at[0], 0.8, sel.at[1]]} />
    </>
  );
}

/** Всё, чему нужны загруженные модели: предметы, люди, замеры и их отметки. */
function BenchBody({ scene, sel, poses, crowd, palette, onRead }: {
  scene: Scene;
  sel: Place;
  poses: Record<string, Pose>;
  crowd: boolean;
  palette: ReturnType<typeof paletteOf>;
  onRead: (r: Readout) => void;
}) {
  const scale = useFit((s) => s.fit.figure.furniture);
  const [read, setRead] = useState<Readout | null>(null);
  const models = useLiveMeasures(scene.edited);

  /**
   * Расстановка считается настоящим `place3` по стендовой раскладке: собирать
   * предметы вторым способом значило бы проверять не то, что в комнате.
   */
  const items = useMemo(
    () => place3(scene.layout, scene.catalog, scene.props),
    [scene],
  );
  const probes = probesOf(scene, items, models, scale);
  const shown = crowd ? scene.places : [sel];
  const host = scene.preset?.id;

  return (
    <>
      <Props3D items={items} palette={palette} offset={[0, 0]} size={[ROOM, ROOM]} />
      {shown.map((place) => (
        <BenchFigure
          key={place.key}
          place={place}
          pose={poses[place.key] ?? place.pose}
          sprite={place.ci < 0 ? undefined : host}
          models={models}
          marks={place.key === sel.key}
          onRead={place.key === sel.key ? (r) => { setRead(r); onRead(r); } : undefined}
        />
      ))}

      {items.map((item) => (
        <Outline
          key={item.key}
          rect={[item.cx - item.w / 2, item.cy - item.d / 2, item.w, item.d]}
          color={item.sprite === host ? '#4c6ef5' : '#8a93a8'}
        />
      ))}
      {probes.map((p) => <Probe key={p.key} at={p.at} hit={p.hit} color={p.color} />)}

      {read?.seatY !== undefined && <Level y={read.seatY} color="#ff6b57" at={sel.at} />}
      {read?.surfaceY !== undefined && <Level y={read.surfaceY} color="#f0b429" at={sel.at} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Панель
// ---------------------------------------------------------------------------

/** Один ползунок с подписью и числом. */
function Slide({ label, value, range, unit, onChange }: {
  label: string;
  value: number;
  range: { min: number; max: number; step: number };
  /** В чём показывать число: сантиметры, целое или доля. */
  unit?: 'cm' | 'int' | 'raw';
  onChange: (v: number) => void;
}) {
  return (
    <label className="fit-slide">
      <span className="fit-slide-name">{label}</span>
      <input
        type="range" min={range.min} max={range.max} step={range.step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="fit-slide-value mono">
        {unit === 'cm' ? cm(value) : unit === 'int' ? String(value) : value.toFixed(2)}
      </span>
    </label>
  );
}

/**
 * Число, которое можно либо мерить по модели, либо задать руками.
 *
 * `null` в пресете значит «мерить», и это не то же самое, что «ноль»:
 * галочка здесь переключает не значение, а источник ответа.
 */
function Override({ label, value, measured, onChange }: {
  label: string;
  value: number | null | undefined;
  /** Что намерено по модели — его и показываем, пока перебив не включён. */
  measured?: number;
  onChange: (v: number | null) => void;
}) {
  const on = value !== null && value !== undefined;
  return (
    <>
      <label className="fit-check">
        <input
          type="checkbox" checked={on}
          onChange={(e) => onChange(e.target.checked ? (measured ?? 0.6) : null)}
        />
        {label}: {on ? 'задан руками' : `по модели, ${cm(measured)}`}
      </label>
      {on && (
        <Slide
          label="высота" value={value} range={RANGE.height} unit="cm"
          onChange={(v) => onChange(v)}
        />
      )}
    </>
  );
}

/** Где стенд помнит выбранный предмет между перезагрузками. */
const ITEM_KEY = 'office-fit-item';

export function FitBench() {
  const fit = useFit((s) => s.fit);
  const patch = useFit((s) => s.patch);
  const revert = useFit((s) => s.revert);
  // Подписка на пресеты нужна именно здесь: почти всё, что крутит стенд,
  // живёт теперь в пресете предмета, и без подписки ползунок двигался бы, а
  // сцена — нет.
  const presets = usePresets((s) => s.presets);
  const patchPreset = usePresets((s) => s.patch);
  const revertPresets = usePresets((s) => s.revert);

  /**
   * Выбранный предмет переживает перезагрузку: сохранение пишет файл, vite
   * замечает правку и перезагружает страницу — без этого стенд каждый раз
   * возвращался бы к первому предмету, а подбирают обычно один и тот же.
   */
  const [id, setId] = useState(() => localStorage.getItem(ITEM_KEY) ?? 'sofa');
  useEffect(() => { localStorage.setItem(ITEM_KEY, id); }, [id]);

  const [selKey, setSelKey] = useState<string | null>(null);
  const [poses, setPoses] = useState<Record<string, Pose>>({});
  const [crowd, setCrowd] = useState(true);
  const [read, setRead] = useState<Readout | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const scene = useMemo(() => sceneOf(id, presets), [id, presets]);
  const sel = scene.places.find((p) => p.key === selKey) ?? scene.places[0];
  const pose = poses[sel.key] ?? sel.pose;

  useEffect(() => { document.documentElement.dataset.theme = 'day'; }, []);

  /** Есть ли у сцены размер — см. комментарий у канваса ниже. */
  const stage = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setReady(el.clientWidth > 0 && el.clientHeight > 0);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      watch.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const preset = scene.preset;
  const pid = preset?.id ?? '';
  const comp: Component | undefined = preset && sel.ci >= 0 ? preset.components[sel.ci] : undefined;

  /** Правка пресета: клонирование и подписку берёт на себя стор. */
  const edit = (target: string, apply: (p: Preset) => void) => {
    patchPreset(target, (p) => { apply(p); return p; });
  };
  /** Правка компонента выбранного места. */
  const editComp = (apply: (c: Component) => void) => {
    if (!preset || sel.ci < 0) return;
    edit(pid, (p) => apply(p.components[sel.ci]));
  };
  /** Правка одной координаты у вектора компонента места. */
  const editSeatVec = (key: 'at' | 'offset', i: number, v: number) => {
    editComp((c) => {
      if (c.type !== 'seat' && c.type !== 'work') return;
      if (key === 'offset') {
        const next: [number, number, number] = [...(c.offset ?? [0, 0, 0])];
        next[i] = v;
        c.offset = next;
        return;
      }
      const next: [number, number] = [...(c.at ?? [0, 0])] as [number, number];
      next[i] = v;
      c.at = next;
    });
  };

  const save = () => {
    // Два сорта чисел — два файла: общее для фигуры в `fit.json`, всё про
    // предмет в его пресете. Пишем разом: разделять кнопки значило бы
    // заставить помнить, что где лежит. Спутники (стул у стола) сохраняются
    // тоже, но только если их и правда трогали.
    const dirty = scene.edited.filter(
      (p) => JSON.stringify(p) !== JSON.stringify(FILE_PRESETS[p.id]),
    );
    Promise.all([saveFit(fit), ...dirty.map(savePreset)]).then(
      () => setSaved(dirty.length
        ? `записано в design/fit.json и ${dirty.map((p) => `design/presets/${p.id}/`).join(', ')}`
        : 'записано в design/fit.json'),
      (e: Error) => setSaved(e.message),
    );
  };

  /** Разница между тем, куда фигура попала, и тем, куда должна была. */
  const gap = (was: number | undefined, is: number): string => (was === undefined
    ? '—'
    : `${is - was >= 0 ? '+' : ''}${Math.round((is - was) * CM)} см`);

  /** Предметы в выпадающем списке — по названию, как их зовёт человек. */
  const menu = useMemo(
    () => Object.values(presets).sort((a, b) => a.title.localeCompare(b.title, 'ru')),
    [presets],
  );

  return (
    <div className="fit">
      <div className="fit-stage" ref={stage}>
        {/* Канвас не рисуется, пока контейнер не измерен.
            r3f снимает размер с контейнера при монтировании и дальше следит
            за ним наблюдателем. Смонтировавшись в контейнер нулевой ширины —
            а так бывает, если раскладка ещё не посчитана, — он остаётся
            300×150 и не показывает вообще ничего: ни ошибки, ни сцены.
            Дождаться размера дешевле, чем потом ловить пустой экран. */}
        {ready && (
          <Canvas flat shadows="percentage" camera={{ position: [7, 4, 8], fov: 30 }}>
            <BenchScene scene={scene} sel={sel} poses={poses} crowd={crowd} onRead={setRead} />
          </Canvas>
        )}
      </div>

      <aside className="fit-panel">
        <h1>Стенд пресетов</h1>
        <p className="fit-note">
          Предмет описан одним файлом <code className="mono">design/presets/&lt;id&gt;/preset.json</code>,
          числа фигуры — <code className="mono">design/fit.json</code>. Сохранение пишет
          файлы, и страница перезагружается — так видно, что в комнату уедет ровно
          то, что записано. Правка файлов руками работает так же.
        </p>

        <select className="fit-item" value={id} onChange={(e) => { setId(e.target.value); setSelKey(null); }}>
          <option value="">— пол, без предмета —</option>
          {menu.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} · {p.id}
            </option>
          ))}
        </select>

        <h2>Места · {scene.places.length}</h2>
        <div className="fit-cases">
          {scene.places.map((place) => (
            <button
              key={place.key}
              className={place.key === sel.key ? 'on' : ''}
              onClick={() => setSelKey(place.key)}
            >
              {place.title}
            </button>
          ))}
        </div>
        <label className="fit-check">
          <input type="checkbox" checked={crowd} onChange={(e) => setCrowd(e.target.checked)} />
          посадить всех сразу
        </label>

        <h2>Поза места «{sel.title}»</h2>
        <div className="fit-cases">
          {POSE_KEYS.map((p) => (
            <button
              key={p}
              className={p === pose ? 'on' : ''}
              onClick={() => setPoses((was) => ({ ...was, [sel.key]: p }))}
            >
              {POSE_TITLE[p]}
            </button>
          ))}
        </div>

        <div className="fit-read">
          <div><b>Сиденье</b><span className="mono">{cm(read?.seatY)}</span></div>
          <div><b>Таз</b><span className="mono">{cm(read?.hipsY)} <i>{gap(read?.seatY, read?.hipsY ?? 0)}</i></span></div>
          <div><b>Столешница</b><span className="mono">{cm(read?.surfaceY)}</span></div>
          <div><b>Кисти</b><span className="mono">{cm(read?.handsY)} <i>{gap(read?.surfaceY, read?.handsY ?? 0)}</i></span></div>
          <div><b>Стопа</b><span className="mono">{cm(read?.feetY)}</span></div>
        </div>

        {comp && (comp.type === 'seat' || comp.type === 'work') && (
          <details open>
            <summary>Место «{sel.title}»{comp.type === 'seat' ? ` · ${comp.shape}` : ''}</summary>

            {comp.type === 'work' && (
              <>
                <Slide
                  label="вдоль" value={comp.at[0]} range={RANGE.at} unit="cm"
                  onChange={(v) => editSeatVec('at', 0, v)}
                />
                <Slide
                  label="поперёк" value={comp.at[1]} range={RANGE.at} unit="cm"
                  onChange={(v) => editSeatVec('at', 1, v)}
                />
              </>
            )}

            {comp.type === 'seat' && comp.shape === 'point' && (
              <>
                <Slide
                  label="вдоль" value={comp.at?.[0] ?? 0} range={RANGE.at} unit="cm"
                  onChange={(v) => editSeatVec('at', 0, v)}
                />
                <Slide
                  label="поперёк" value={comp.at?.[1] ?? 0} range={RANGE.at} unit="cm"
                  onChange={(v) => editSeatVec('at', 1, v)}
                />
                <div className="fit-cases">
                  {(['sit', 'game'] as const).map((use) => (
                    <button
                      key={use}
                      className={(comp.use ?? 'sit') === use ? 'on' : ''}
                      onClick={() => editComp((c) => { if (c.type === 'seat') c.use = use; })}
                    >
                      {use === 'sit' ? 'просто сидят' : 'играют'}
                    </button>
                  ))}
                </div>
              </>
            )}

            {comp.type === 'seat' && comp.shape === 'side' && (
              <>
                <div className="fit-cases">
                  {(['n', 's', 'w', 'e'] as const).map((side) => (
                    <button
                      key={side}
                      className={comp.side === side ? 'on' : ''}
                      onClick={() => editComp((c) => { if (c.type === 'seat') c.side = side; })}
                    >
                      {{ n: 'север', s: 'юг', w: 'запад', e: 'восток' }[side]}
                    </button>
                  ))}
                </div>
                <Slide
                  label="мест в ряду" value={comp.count ?? 1} range={RANGE.count} unit="int"
                  onChange={(v) => editComp((c) => { if (c.type === 'seat') c.count = v; })}
                />
              </>
            )}

            {comp.type === 'seat' && comp.shape === 'ring' && (
              <>
                <Slide
                  label="мест по кругу" value={comp.ring ?? 2} range={RANGE.ring} unit="int"
                  onChange={(v) => editComp((c) => { if (c.type === 'seat') c.ring = v; })}
                />
                <Slide
                  label="радиус вдоль" value={comp.rx ?? 1} range={RANGE.radius} unit="cm"
                  onChange={(v) => editComp((c) => { if (c.type === 'seat') c.rx = v; })}
                />
                <Slide
                  label="радиус поперёк" value={comp.ry ?? 1} range={RANGE.radius} unit="cm"
                  onChange={(v) => editComp((c) => { if (c.type === 'seat') c.ry = v; })}
                />
                <label className="fit-check">
                  <input
                    type="checkbox" checked={!!comp.grow}
                    onChange={(e) => editComp((c) => {
                      if (c.type === 'seat') c.grow = e.target.checked ? true : undefined;
                    })}
                  />
                  раздвигать круг под лишних участников
                </label>
              </>
            )}

            {(['вправо', 'вверх', 'вперёд'] as const).map((name, i) => (
              <Slide
                key={name} label={name} value={(comp.offset ?? [0, 0, 0])[i]}
                range={FIT_RANGE.offset} unit="cm"
                onChange={(v) => editSeatVec('offset', i, v)}
              />
            ))}

            <Override
              label="высота сиденья" value={comp.height}
              measured={read?.seatY === undefined ? undefined : read.seatY / fit.figure.furniture}
              onChange={(v) => editComp((c) => {
                if (c.type === 'seat' || c.type === 'work') c.height = v;
              })}
            />
          </details>
        )}

        {preset && (
          <PresetSections
            preset={preset} read={read} scale={fit.figure.furniture}
            edit={(apply) => edit(preset.id, apply)}
          />
        )}

        <details open>
          <summary>Фигура и набор</summary>
          <Slide
            label="рост" value={fit.figure.tall} range={FIT_RANGE.tall} unit="cm"
            onChange={(v) => patch((f) => { f.figure.tall = v; return f; })}
          />
          <Slide
            label="масштаб мебели" value={fit.figure.furniture} range={FIT_RANGE.furniture}
            onChange={(v) => patch((f) => { f.figure.furniture = v; return f; })}
          />
          <Slide
            label="скорость, тайлов/с" value={fit.walk.tilesPerSec} range={FIT_RANGE.tilesPerSec}
            onChange={(v) => patch((f) => { f.walk.tilesPerSec = v; return f; })}
          />
        </details>

        <details>
          <summary>Посадка — общая для всех предметов</summary>
          <Slide
            label="таз над сиденьем" value={fit.seated.hipsOverSeat} range={FIT_RANGE.hipsOverSeat}
            unit="cm" onChange={(v) => patch((f) => { f.seated.hipsOverSeat = v; return f; })}
          />
          <Slide
            label="кисти над столом" value={fit.seated.handsOverSurface}
            range={FIT_RANGE.handsOverSurface} unit="cm"
            onChange={(v) => patch((f) => { f.seated.handsOverSurface = v; return f; })}
          />
          <Slide
            label="сила IK" value={fit.seated.ikWeight} range={FIT_RANGE.ikWeight}
            onChange={(v) => patch((f) => { f.seated.ikWeight = v; return f; })}
          />
          <label className="fit-check">
            <input
              type="checkbox" checked={fit.seated.ik}
              onChange={(e) => patch((f) => { f.seated.ik = e.target.checked; return f; })}
            />
            дотягивать кисти до столешницы
          </label>
        </details>

        <div className="fit-actions">
          <button className="fit-save" onClick={save}>Сохранить</button>
          <button onClick={() => { revert(); revertPresets(); setSaved(null); }}>Вернуть из файла</button>
        </div>
        {saved && <p className="fit-note">{saved}</p>}
        <p className="fit-note">
          Поза {pose}: якорь <b>{poseFit(fit, pose).anchor === 'hips' ? 'таз' : 'ступни'}</b>
          {poseFit(fit, pose).reach ? ', кисти тянутся к поверхности' : ''}.
        </p>
      </aside>
    </div>
  );
}

/**
 * Всё остальное про предмет: поверхность, части модели, габарит.
 *
 * Вынесено в свой компонент не ради красоты, а ради длины: разделов много,
 * и в одной функции они начинают наезжать друг на друга. Правка приходит
 * одной функцией — стор всё равно клонирует пресет целиком.
 */
function PresetSections({ preset, read, scale, edit }: {
  preset: Preset;
  read: Readout | null;
  /** Видимый масштаб набора: замеры в панели приведены к нему. */
  scale: number;
  edit: (apply: (p: Preset) => void) => void;
}) {
  const surface = componentOf(preset, 'surface');
  const si = surface ? preset.components.indexOf(surface) : -1;

  /** Правка одной координаты у вектора части. */
  const editPart = (i: number, apply: (part: Part) => void) => {
    edit((p) => { const part = p.parts?.[i]; if (part) apply(part); });
  };

  return (
    <>
      {surface && (
        <details>
          <summary>Рабочая поверхность</summary>
          <p className="fit-note">
            Меряется по части <b>{surface.on}</b> — к ней тянутся кисти.
          </p>
          <Override
            label="высота столешницы" value={surface.height}
            measured={read?.surfaceY === undefined ? undefined : read.surfaceY / scale}
            onChange={(v) => edit((p) => {
              const c = p.components[si];
              if (c?.type === 'surface') c.height = v;
            })}
          />
        </details>
      )}

      {(preset.parts ?? []).map((part, i) => (
        <details key={partName(part)}>
          <summary>Часть «{partName(part)}»</summary>
          <p className="fit-note mono">{part.file}</p>
          {(['вправо', 'вверх', 'вперёд'] as const).map((name, k) => (
            <Slide
              key={name} label={name} value={(part.at ?? [0, 0, 0])[k]}
              range={RANGE.partAt} unit="cm"
              onChange={(v) => editPart(i, (p) => {
                const next: [number, number, number] = [...(p.at ?? [0, 0, 0])];
                next[k] = v;
                p.at = next;
              })}
            />
          ))}
          <Slide
            label="доворот, °" value={part.rot ?? 0} range={RANGE.rot} unit="int"
            onChange={(v) => editPart(i, (p) => { p.rot = v; })}
          />

          {/* Точка луча — единственное число пресета, которое иначе не видно
              вообще никак: ошибись на ладонь, и высота сиденья приедет со
              спинки. На сцене она нарисована столбиком с шариком. */}
          {(['seat', 'surface'] as const).map((kind) => {
            const aim = part.probe?.[kind];
            const name = kind === 'seat' ? 'сиденье' : 'столешница';
            return (
              <div key={kind}>
                <label className="fit-check">
                  <input
                    type="checkbox" checked={!!aim}
                    onChange={(e) => editPart(i, (p) => {
                      const probe = { ...(p.probe ?? {}) };
                      if (e.target.checked) probe[kind] = [0, 0];
                      else delete probe[kind];
                      p.probe = Object.keys(probe).length ? probe : undefined;
                    })}
                  />
                  мерить {name} лучом
                </label>
                {aim && (['вдоль', 'поперёк'] as const).map((axis, k) => (
                  <Slide
                    key={axis} label={`луч ${axis}`} value={aim[k]} range={RANGE.probe} unit="cm"
                    onChange={(v) => editPart(i, (p) => {
                      const next: [number, number] = [...(p.probe?.[kind] ?? [0, 0])] as [number, number];
                      next[k] = v;
                      p.probe = { ...(p.probe ?? {}), [kind]: next };
                    })}
                  />
                ))}
              </div>
            );
          })}
        </details>
      ))}

      <details>
        <summary>Габарит и след</summary>
        <p className="fit-note">
          След нарисован на полу синим. По нему считается и отрисовка, и
          проходимость — предмет с непроходимым следом обойти нельзя.
        </p>
        <Slide
          label="высота" value={preset.h} range={RANGE.h} unit="cm"
          onChange={(v) => edit((p) => { p.h = v; })}
        />
        {(['слева', 'сверху', 'ширина', 'глубина'] as const).map((name, i) => (
          <Slide
            key={name} label={name} value={preset.footprint[i]} range={RANGE.foot} unit="cm"
            onChange={(v) => edit((p) => {
              const next: [number, number, number, number] = [...p.footprint];
              next[i] = v;
              p.footprint = next;
            })}
          />
        ))}
        <label className="fit-check">
          <input
            type="checkbox" checked={!!preset.blocks}
            onChange={(e) => edit((p) => { p.blocks = e.target.checked ? true : undefined; })}
          />
          след непроходим
        </label>
        <label className="fit-check">
          материал
          <select
            value={preset.tone ?? ''}
            onChange={(e) => edit((p) => {
              p.tone = (e.target.value || undefined) as Preset['tone'];
            })}
          >
            <option value="">— нет —</option>
            {TONES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </details>
    </>
  );
}

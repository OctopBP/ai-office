/**
 * Стенд подгонки — dev-экран, на котором фигуру сажают за мебель.
 *
 * Зачем отдельный экран, а не ползунки в самом офисе: в офисе агенты
 * разбредаются, позы меняются сами по себе, камера ближе своего предела не
 * подъезжает, а пикселизация замыливает ровно ту деталь, которую подбираешь.
 * Здесь один предмет, один человек, одна поза — и она никуда не денется, пока
 * её крутят.
 *
 * Открывается по `?fit=1` и живёт только в разработке: в собранный офис он не
 * попадает (см. `main.tsx`).
 *
 * Главное правило стенда: он не рисует «похоже». Место, посадка, замеры и
 * клипы берутся ровно те же, что в комнате (`seating.ts`, `measure.ts`,
 * `buildRig`), иначе подобранное здесь не сошлось бы там.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { catalog } from '../layoutData';
import type { Layout, LayoutProp } from '../../shared/layout';
import { useStore } from '../store';
import { paletteOf } from './palette';
import { FurnitureModels, Props3D } from './Props3D';
import { place3 } from './props';
import { useModelMeasures } from './measure';
import { seatingFor } from './seating';
import { reach } from './ik';
import {
  buildRig, FOOT_DX, FOOT_DY, skinMaterial, useCharacter, useSkinMaterials, type Pose,
} from './Agents3D';
import { FIT_RANGE, saveFit, useFit, type Fit } from './fit';

/** Тайл в сантиметрах — весь стенд говорит числами, понятными человеку. */
const CM = 75;
const cm = (t: number | undefined): string => (t === undefined ? '—' : `${Math.round(t * CM)} см`);

/**
 * Случаи, которые вообще бывают: место плюс поза.
 *
 * Список руками, а не собранный из раскладки: это перечень того, что надо
 * проверить глазами, и он короче, чем «все предметы × все позы». Предметы
 * рядом (стул у стола) перечислены отдельно — в раскладке они и стоят
 * отдельными предметами.
 */
interface Case {
  id: string;
  title: string;
  /** Предмет места — по нему считается посадка. */
  sprite?: string;
  pose: Pose;
  /** Что поставить в сцену: якорь каждого предмета в тайлах. */
  props: { sprite: string; at: [number, number] }[];
}

const DESK_SET: Case['props'] = [
  { sprite: 'desk', at: [2, 3] },
  // Тот же сдвиг стула относительно стола, что в раскладке studio.
  { sprite: 'chair', at: [2.6, 2.8] },
];
const SOFA_SET: Case['props'] = [{ sprite: 'sofa', at: [2, 3] }];

const CASES: Case[] = [
  { id: 'desk-type', title: 'стол · печатает', sprite: 'desk', pose: 'type', props: DESK_SET },
  { id: 'desk-sit', title: 'стол · сидит', sprite: 'desk', pose: 'sitIdle', props: DESK_SET },
  { id: 'desk-talk', title: 'стол · совещание', sprite: 'desk', pose: 'sitTalk', props: DESK_SET },
  { id: 'sofa-sit', title: 'диван · сидит', sprite: 'sofa', pose: 'sitIdle', props: SOFA_SET },
  { id: 'sofa-game', title: 'диван · играет', sprite: 'sofa', pose: 'game', props: SOFA_SET },
  { id: 'armchair', title: 'кресло · сидит', sprite: 'armchair', pose: 'sitIdle', props: [{ sprite: 'armchair', at: [2, 3] }] },
  { id: 'floor-idle', title: 'пол · стоит', pose: 'idle', props: [] },
  { id: 'floor-talk', title: 'пол · говорит', pose: 'talk', props: [] },
  { id: 'floor-walk', title: 'пол · идёт', pose: 'walk', props: [] },
];

/**
 * Точка места в тайлах: якорь предмета плюс его слот из каталога плюс
 * перевод «угол спрайта → человек». Ровно та же цепочка, что в комнате.
 */
function pointOf(c: Case): [number, number] {
  const host = c.sprite ? c.props.find((p) => p.sprite === c.sprite) : undefined;
  if (!host) return [3, 3];
  const slots = catalog.sprites[host.sprite]?.slots ?? [];
  const slot = slots.find((s) => s.kind === 'work') ?? slots.find((s) => s.kind === 'seat');
  const x = host.at[0] + (slot && 'x' in slot ? slot.x : 0);
  const y = host.at[1] + (slot && 'y' in slot ? slot.y : 0);
  return [x + FOOT_DX, y + FOOT_DY];
}

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
 * не меняется, а посадка считается тем же `seatingFor`, что и в комнате.
 */
function BenchFigure({ scene, onRead }: { scene: Case; onRead: (r: Readout) => void }) {
  const loaded = useCharacter();
  const materials = useSkinMaterials();
  const models = useModelMeasures();
  const fit = useFit((s) => s.fit);
  const tall = fit.figure.tall;
  const group = useRef<THREE.Group>(null);

  const rig = useMemo(
    () => buildRig(loaded, skinMaterial(materials, undefined, 0), tall, 0),
    [loaded, materials, tall],
  );
  useEffect(() => {
    const action = rig.actions[scene.pose];
    action.reset().setEffectiveWeight(1).play();
    return () => { action.stop(); };
  }, [rig, scene.pose]);

  const seat = seatingFor(fit, models, loaded.measure[scene.pose], scene.pose, scene.sprite, tall);
  const point = pointOf(scene);

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
        position={[point[0] + seat.lift[0], seat.lift[1], point[1] + seat.lift[2]]}
      >
        <primitive object={rig.figure} />
      </group>
      <group ref={mark}>
        {['#ff6b57', '#f0b429', '#5fd35a'].map((color) => (
          <mesh key={color}>
            <sphereGeometry args={[0.05, 8, 8]} />
            <meshBasicMaterial color={color} depthTest={false} />
          </mesh>
        ))}
      </group>
    </>
  );
}

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

/** Сцена стенда: пол в клетку, предметы случая и фигура. */
function BenchScene({ scene, onRead }: { scene: Case; onRead: (r: Readout) => void }) {
  const theme = useStore((s) => s.theme);
  const palette = paletteOf(theme);
  const [read, setRead] = useState<Readout | null>(null);
  const point = pointOf(scene);

  /**
   * Расстановка считается настоящим `place3` — по фальшивой раскладке из
   * одного поля `size`: больше ему от неё ничего не нужно, а собирать
   * предметы вторым способом значило бы проверять не то, что в комнате.
   */
  const items = useMemo(() => place3(
    { size: [8, 8] } as Layout,
    catalog,
    scene.props.map((p, i) => ({ sprite: p.sprite, at: p.at, key: `bench-${i}` } as LayoutProp & { key: string })),
  ), [scene]);

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
          <Props3D items={items} palette={palette} offset={[0, 0]} size={[8, 8]} />
          <BenchFigure
            scene={scene}
            onRead={(r) => { setRead(r); onRead(r); }}
          />
        </FurnitureModels>
      </Suspense>

      {read?.seatY !== undefined && <Level y={read.seatY} color="#ff6b57" at={point} />}
      {read?.surfaceY !== undefined && <Level y={read.surfaceY} color="#f0b429" at={point} />}
      <OrbitControls target={[point[0], 0.8, point[1]]} />
    </>
  );
}

/** Один ползунок с подписью и числом в сантиметрах. */
function Slide({ label, value, range, unit, onChange }: {
  label: string;
  value: number;
  range: { min: number; max: number; step: number };
  /** В чём показывать число: сантиметры, доля или своё. */
  unit?: 'cm' | 'raw';
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
        {unit === 'cm' ? cm(value) : value.toFixed(2)}
      </span>
    </label>
  );
}

/** Где стенд помнит выбранный случай между перезагрузками. */
const CASE_KEY = 'office-fit-case';

export function FitBench() {
  const fit = useFit((s) => s.fit);
  const patch = useFit((s) => s.patch);
  const revert = useFit((s) => s.revert);
  /**
   * Выбранный случай переживает перезагрузку: сохранение пишет файл, vite
   * замечает правку и перезагружает страницу — без этого стенд каждый раз
   * возвращался бы к первому случаю, а подбирают обычно один и тот же.
   */
  const [id, setId] = useState(() => localStorage.getItem(CASE_KEY) ?? CASES[0].id);
  useEffect(() => { localStorage.setItem(CASE_KEY, id); }, [id]);
  const [read, setRead] = useState<Readout | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const scene = CASES.find((c) => c.id === id) ?? CASES[0];

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

  const place = fit.places[scene.sprite ?? ''] ?? { seat: [0, 0, 0] as [number, number, number] };
  const pose = fit.poses[scene.pose] ?? { anchor: 'feet', offset: [0, 0, 0] as [number, number, number] };

  const setPlace = (i: number, v: number) => patch((f) => {
    const key = scene.sprite;
    if (!key) return f;
    const row = f.places[key] ?? { seat: [0, 0, 0] };
    row.seat[i] = v;
    f.places[key] = row;
    return f;
  });

  const save = () => {
    saveFit(fit).then(
      () => setSaved('записано в design/fit.json'),
      (e: Error) => setSaved(e.message),
    );
  };

  /** Разница между тем, куда фигура попала, и тем, куда должна была. */
  const gap = (was: number | undefined, is: number): string => (was === undefined
    ? '—'
    : `${is - was >= 0 ? '+' : ''}${Math.round((is - was) * CM)} см`);

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
            <BenchScene scene={scene} onRead={setRead} />
          </Canvas>
        )}
      </div>

      <aside className="fit-panel">
        <h1>Стенд подгонки</h1>
        <p className="fit-note">
          Числа живут в <code className="mono">design/fit.json</code>. Сохранение пишет
          файл, и страница перезагружается — так видно, что в комнату уедет ровно
          то, что записано. Правка файла руками работает так же.
        </p>

        <div className="fit-cases">
          {CASES.map((c) => (
            <button
              key={c.id}
              className={c.id === id ? 'on' : ''}
              onClick={() => setId(c.id)}
            >
              {c.title}
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

        <h2>Фигура и набор</h2>
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

        <h2>Посадка</h2>
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

        {scene.sprite && (
          <>
            <h2>Место: {scene.sprite}</h2>
            {(['вправо', 'вверх', 'вперёд'] as const).map((name, i) => (
              <Slide
                key={name} label={name} value={place.seat[i]} range={FIT_RANGE.offset}
                unit="cm" onChange={(v) => setPlace(i, v)}
              />
            ))}
          </>
        )}

        <div className="fit-actions">
          <button className="fit-save" onClick={save}>Сохранить</button>
          <button onClick={() => { revert(); setSaved(null); }}>Вернуть из файла</button>
        </div>
        {saved && <p className="fit-note">{saved}</p>}
        <p className="fit-note">
          Поза {scene.pose}: якорь <b>{pose.anchor === 'hips' ? 'таз' : 'ступни'}</b>
          {pose.reach ? ', кисти тянутся к поверхности' : ''}.
        </p>
      </aside>
    </div>
  );
}

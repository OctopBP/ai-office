/**
 * Стенд скинов — dev-экран, на котором все скины персонажа стоят рядом в
 * одной позе: `?skins=1`, только в разработке (см. `main.tsx`).
 *
 * Зачем он: скин — развёртка на 1024 пикселя, и по самой картинке не видно,
 * куда лёг рукав и не съехал ли воротник; видно только на модели, и не в
 * T-позе, а когда фигура сидит и печатает. В комнате же скин показывают
 * агенты, а они ходят, отворачиваются и садятся спиной — сравнить два скина
 * бок о бок там нельзя. Здесь стоят все сразу, поза общая и переключается
 * кнопкой, камера свободная.
 *
 * Стенд ещё и единственная ручка списка внешностей: файл кладётся,
 * заменяется и удаляется отсюда, подписи и спрайт плоского офиса правятся
 * тут же, и запись уходит в `looks.json` — тот же файл, из которого форма
 * роли берёт карточки. Файлы — сразу (файл либо есть, либо нет), список —
 * кнопкой «Сохранить»: он один на все скины, и писать его после каждой буквы
 * в подписи значило бы перезагружать страницу на каждую букву.
 *
 * Правило то же, что у стенда пресетов: не «похоже», а то же самое. Фигура,
 * клипы и материал собираются тем же кодом, что в комнате (`buildRig`,
 * `skinMaterialOf`), рост — из `fit.json`.
 *
 * Черновик списка лежит в sessionStorage: загрузка файла заставляет vite
 * перезагрузить страницу (папка скинов глобом входит в модуль комнаты), и
 * без этого несохранённые подписи пропадали бы вместе с перезагрузкой.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { catalog } from '../layoutData';
import { LOOK_ID, lookTitle, parseLooks, type Look } from '../../shared/look';
import { useFit } from './fit';
import {
  buildRig, MOVE_KEYS, POSE_KEYS, skinMaterialOf, useCharacter, type Move, type Pose,
} from './Agents3D';

/** Файл скина, как его видит дев-сервер (`/__skins`). */
interface SkinFile { id: string; size: number; mtime: number; width: number; height: number }
interface Snapshot { files: SkinFile[]; registry: unknown }

type Clip = Pose | Move;
const CLIP_TITLE: Record<Clip, string> = {
  idle: 'стоит', walk: 'идёт', talk: 'говорит', type: 'печатает',
  sitIdle: 'сидит', sitTalk: 'сидит и говорит', game: 'играет',
  sitDown: 'садится', standUp: 'встаёт', sitToType: 'к клавиатуре', typeToSit: 'от клавиатуры',
};
const CLIPS: Clip[] = [...POSE_KEYS, ...MOVE_KEYS];

/** Ключ черновика списка в sessionStorage. */
const DRAFT_KEY = 'office-skin-bench-draft';

/** Адрес файла — с временем правки, чтобы замена не упёрлась в кеш загрузчика. */
const fileUrl = (f: SkinFile) => `/__skins/file/${encodeURIComponent(f.id)}.png?v=${f.mtime}`;

/** Человечки плоского офиса, между которыми выбирают спрайт: по номеру, с подписью из каталога. */
const SPRITES = Object.keys(catalog.sprites)
  .filter((k) => /^agent_p\d+$/.test(k))
  .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)))
  .map((id) => ({ id, label: catalog.sprites[id].label ?? '' }));

/** Файлы в ряд по шесть; следующий ряд — глубже, чтобы камере было видно всех. */
const PER_ROW = 6;
const STEP = 1.4;
const ROW = 2.8;
function placeOf(i: number, n: number): [number, number] {
  const cols = Math.min(n, PER_ROW);
  return [((i % PER_ROW) - (cols - 1) / 2) * STEP, -Math.floor(i / PER_ROW) * ROW];
}

/** Выбор png через системный диалог; отмена — null. */
function pickPng(): Promise<File | null> {
  return new Promise((ok) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,.png';
    input.onchange = () => ok(input.files?.[0] ?? null);
    input.oncancel = () => ok(null);
    input.click();
  });
}

async function call(method: string, path: string, body?: BodyInit): Promise<void> {
  const res = await fetch(path, { method, body });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
}

function Figure({ file, at, clip, label, listed, selected, onSelect }: {
  file: SkinFile;
  at: [number, number];
  clip: Clip;
  label: string;
  listed: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const loaded = useCharacter();
  const tall = useFit((s) => s.fit).figure.tall;
  const texture = useLoader(THREE.TextureLoader, fileUrl(file));
  const material = useMemo(() => skinMaterialOf(texture), [texture]);
  const rig = useMemo(() => buildRig(loaded, material, tall, 0), [loaded, material, tall]);

  useEffect(() => {
    const action = rig.actions[clip];
    action.reset().setEffectiveWeight(1).play();
    return () => { action.stop(); };
  }, [rig, clip]);
  useFrame((_, dt) => { rig.mixer.update(dt); });

  return (
    <group position={[at[0], 0, at[1]]}>
      <primitive object={rig.figure} />
      {/* Невидимая коробка для клика: луч по скиннингу дорог и капризен. */}
      <mesh position={[0, tall / 2, 0]} onClick={(e) => { e.stopPropagation(); onSelect(); }}>
        <boxGeometry args={[0.8, tall, 0.6]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={[0.45, 0.55, 32]} />
          <meshBasicMaterial color="#4f7cff" side={THREE.DoubleSide} />
        </mesh>
      )}
      <Html center position={[0, tall + 0.35, 0]} zIndexRange={[10, 0]} style={{ pointerEvents: 'none', userSelect: 'none' }}>
        <div className={`skin-tag${selected ? ' on' : ''}${listed ? '' : ' off'}`}>{label}</div>
      </Html>
    </group>
  );
}

function Stage({ files, looks, clip, selected, onSelect }: {
  files: SkinFile[];
  looks: Look[];
  clip: Clip;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <>
      <ambientLight intensity={1.1} />
      <directionalLight position={[4, 8, 6]} intensity={1.6} />
      <gridHelper args={[16, 16, '#8a93a8', '#d5d8e0']} position={[0, 0.002, -2]} />
      <mesh position={[0, -0.01, -2]} rotation={[-Math.PI / 2, 0, 0]} onClick={() => onSelect(null)}>
        <planeGeometry args={[16, 16]} />
        <meshBasicMaterial color="#eef0f4" />
      </mesh>
      {files.map((f, i) => {
        const look = looks.find((l) => l.id === f.id);
        return (
          <Suspense key={f.id} fallback={null}>
            <Figure
              file={f} at={placeOf(i, files.length)} clip={clip}
              label={look ? lookTitle(look, 'ru') : f.id} listed={!!look}
              selected={selected === f.id} onSelect={() => onSelect(f.id)}
            />
          </Suspense>
        );
      })}
      <OrbitControls target={[0, 1.1, -1]} />
    </>
  );
}

export function SkinBench() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [disk, setDisk] = useState<Look[]>([]);
  const [draft, setDraft] = useState<Look[]>([]);
  const [dirty, setDirty] = useState(false);
  const [clip, setClip] = useState<Clip>('idle');
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const stage = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (el.clientWidth > 0) setReady(true); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Черновик переживает перезагрузку страницы, которую устраивает vite после правки файлов. */
  const persist = useCallback((looks: Look[] | null) => {
    if (looks) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ looks }));
    else sessionStorage.removeItem(DRAFT_KEY);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/__skins', { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const s = (await res.json()) as Snapshot;
      const onDisk = parseLooks(s.registry);
      setSnap(s);
      setDisk(onDisk);
      const saved = sessionStorage.getItem(DRAFT_KEY);
      if (saved) {
        const ids = new Set(s.files.map((f) => f.id));
        setDraft(parseLooks(JSON.parse(saved)).filter((l) => ids.has(l.id)));
        setDirty(true);
      } else {
        setDraft(onDisk);
        setDirty(false);
      }
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const edit = (next: Look[]) => {
    setDraft(next);
    setDirty(true);
    persist(next);
  };
  const patch = (id: string, p: Partial<Look>) => edit(draft.map((l) => (l.id === id ? { ...l, ...p } : l)));
  const move = (id: string, by: -1 | 1) => {
    const i = draft.findIndex((l) => l.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= draft.length) return;
    const next = draft.slice();
    [next[i], next[j]] = [next[j], next[i]];
    edit(next);
  };
  const list = (id: string) => edit([...draft, { id, sprite: SPRITES[0]?.id ?? 'agent_p1', title: {} }]);
  const unlist = (id: string) => edit(draft.filter((l) => l.id !== id));

  const run = async (what: string, job: () => Promise<void>) => {
    setError('');
    setNote('');
    try {
      await job();
      setNote(what);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const upload = async (id: string, file: File, fresh: boolean) => {
    // Черновик пишется до запроса: vite может перезагрузить страницу
    // раньше, чем ответ дойдёт до обработчика.
    if (fresh && !draft.some((l) => l.id === id)) {
      const next = [...draft, { id, sprite: SPRITES[0]?.id ?? 'agent_p1', title: {} }];
      setDraft(next);
      setDirty(true);
      persist(next);
    }
    await call('PUT', `/__skins/file/${encodeURIComponent(id)}.png`, file);
    setSel(id);
  };

  const add = () => void run('Файл добавлен — заполните подпись и сохраните список', async () => {
    const file = await pickPng();
    if (!file) return;
    const base = file.name.replace(/\.png$/i, '').replace(/[^A-Za-z0-9_-]+/g, '');
    const id = window.prompt('Имя скина — латиница, цифры, _ и -', base)?.trim();
    if (!id) return;
    if (!LOOK_ID.test(id)) throw new Error(`недопустимое имя «${id}»`);
    if (snap?.files.some((f) => f.id === id) && !window.confirm(`Файл ${id}.png уже есть. Заменить?`)) return;
    await upload(id, file, true);
  });

  const replace = (id: string) => void run(`Файл ${id}.png заменён`, async () => {
    const file = await pickPng();
    if (file) await upload(id, file, false);
  });

  const remove = (id: string) => void run(`Файл ${id}.png удалён`, async () => {
    if (!window.confirm(`Удалить файл ${id}.png с диска? Это не отменить.`)) return;
    const next = draft.filter((l) => l.id !== id);
    if (next.length !== draft.length) { setDraft(next); persist(next); }
    await call('DELETE', `/__skins/file/${encodeURIComponent(id)}.png`);
    if (sel === id) setSel(null);
  });

  const save = () => void run('Список записан', async () => {
    const looks = parseLooks({ looks: draft });
    await call('PUT', '/__skins/registry', JSON.stringify({ looks }));
    persist(null);
    setDirty(false);
  });

  const discard = () => { persist(null); setDraft(disk); setDirty(false); };

  const files = snap?.files ?? [];
  const byId = new Map(files.map((f) => [f.id, f]));
  const orphans = draft.filter((l) => !byId.has(l.id));
  /** Порядок карточек — как в списке (это порядок карточек в форме роли); файлы вне списка — в конце. */
  const cards: Array<{ file: SkinFile; look: Look | undefined }> = [
    ...draft.filter((l) => byId.has(l.id)).map((l) => ({ file: byId.get(l.id)!, look: l })),
    ...files.filter((f) => !draft.some((l) => l.id === f.id)).map((f) => ({ file: f, look: undefined })),
  ];
  const selected = sel ? byId.get(sel) : undefined;

  return (
    <div className="fit">
      <div className="fit-stage" ref={stage}>
        {ready && snap && (
          <Canvas flat camera={{ position: [0, 3.8, 11], fov: 30 }}>
            <Stage files={files} looks={draft} clip={clip} selected={sel} onSelect={setSel} />
          </Canvas>
        )}
      </div>

      <aside className="fit-panel">
        <h1>Стенд скинов</h1>
        <p className="fit-note">
          Скин — png в <code className="mono">design/models/characters/skins/</code>, список
          внешностей — <code className="mono">looks.json</code> рядом. Файлы пишутся сразу,
          список — кнопкой «Сохранить». Порядок карточек здесь — порядок в форме роли.
        </p>
        {error && <p className="fit-note skin-error">{error}</p>}
        {note && !error && <p className="fit-note">{note}</p>}

        <h2>Поза</h2>
        <div className="fit-cases">
          {CLIPS.map((c) => (
            <button key={c} className={c === clip ? 'on' : ''} onClick={() => setClip(c)}>{CLIP_TITLE[c]}</button>
          ))}
        </div>

        {selected && (
          <>
            <h2>Развёртка · {selected.id}</h2>
            <img className="skin-preview" src={fileUrl(selected)} alt="" />
          </>
        )}

        <h2>Скины · {files.length}{dirty ? ' · не сохранено' : ''}</h2>
        <div className="fit-actions">
          <button onClick={add}>+ Добавить файл</button>
          <button className="fit-save" onClick={save} disabled={!dirty}>Сохранить список</button>
          {dirty && <button onClick={discard}>Отменить</button>}
        </div>
        <div className="skin-list">
          {cards.map(({ file, look }) => (
            <div
              key={file.id} className={`skin-card${sel === file.id ? ' on' : ''}${look ? '' : ' off'}`}
              onClick={() => setSel(file.id)}
            >
              <img src={fileUrl(file)} alt="" />
              <div className="skin-card-head">
                <b>{file.id}</b>
                <span className="muted">
                  {file.width}×{file.height} · {Math.round(file.size / 1024)} КБ
                  {file.width !== file.height && <span className="fit-warn"> · не квадрат</span>}
                </span>
              </div>
              {look ? (
                <div className="skin-card-fields" onClick={(e) => e.stopPropagation()}>
                  <input
                    placeholder="подпись, ру" value={look.title.ru ?? ''}
                    onChange={(e) => patch(look.id, { title: { ...look.title, ru: e.target.value } })}
                  />
                  <input
                    placeholder="label, en" value={look.title.en ?? ''}
                    onChange={(e) => patch(look.id, { title: { ...look.title, en: e.target.value } })}
                  />
                  <select value={look.sprite} onChange={(e) => patch(look.id, { sprite: e.target.value })}>
                    {SPRITES.map((s) => <option key={s.id} value={s.id}>{s.id} · {s.label}</option>)}
                  </select>
                  <span className="muted">спрайт в плоском офисе</span>
                </div>
              ) : (
                <div className="muted">файл есть, в списке внешностей нет — в форме роли не показывается</div>
              )}
              <div className="skin-card-actions" onClick={(e) => e.stopPropagation()}>
                {look ? (
                  <>
                    <button onClick={() => move(look.id, -1)} title="выше">↑</button>
                    <button onClick={() => move(look.id, 1)} title="ниже">↓</button>
                    <button onClick={() => unlist(look.id)}>Убрать из списка</button>
                  </>
                ) : (
                  LOOK_ID.test(file.id)
                    ? <button onClick={() => list(file.id)}>В список</button>
                    : <span className="muted">имя не годится для списка</span>
                )}
                <button onClick={() => replace(file.id)}>Заменить файл</button>
                <button className="danger" onClick={() => remove(file.id)}>Удалить файл</button>
              </div>
            </div>
          ))}
        </div>

        {orphans.length > 0 && (
          <>
            <h2>Записи без файла · {orphans.length}</h2>
            <p className="fit-note">В комнате такой агент останется без текстуры. Список с ними не запишется.</p>
            <div className="skin-list">
              {orphans.map((l) => (
                <div key={l.id} className="skin-card off">
                  <div className="skin-card-head"><b>{l.id}</b><span className="muted">нет файла {l.id}.png</span></div>
                  <div className="skin-card-actions"><button onClick={() => unlist(l.id)}>Убрать из списка</button></div>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

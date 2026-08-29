/**
 * Пресеты предметов, загруженные в приложение (спека §8).
 *
 * Заменяет собой три прежних места: таблицу `PROPS`, поимённый список
 * `models.ts` и раздел `places` в `fit.json`. Предмет теперь описан одной
 * папкой, и всё, что про него знает сцена, приходит отсюда.
 *
 * Два глоба, и разница между ними существенная. Дескрипторы — это несколько
 * килобайт текста на весь офис, их берём жадно и разбираем сразу: без них
 * нечего рисовать. Модели берём тоже жадно, но `?url` — это строка, а не
 * содержимое файла: сам `.glb` браузер запросит только тогда, когда его
 * загрузит `GLTFLoader`.
 *
 * Именно поэтому `models.ts` был рукописным списком: глоб по набору Kenney
 * поднимал 140 модулей ради четырёх нужных. Теперь глоб идёт по папкам
 * пресетов, где лежит ровно то, что комната использует, — и список не нужен.
 */
import { create } from 'zustand';
import {
  componentOf, parsePreset, partName, splitRef,
  type Part, type Preset,
} from '../../shared/preset';

const DESC = import.meta.glob('../../../design/presets/*/preset.json', {
  eager: true,
}) as Record<string, { default: unknown }>;

const URLS = import.meta.glob('../../../design/presets/*/*.glb', {
  query: '?url', import: 'default', eager: true,
}) as Record<string, string>;

/** `.../design/presets/sofa/preset.json` → `sofa`. */
function folderOf(path: string): string {
  return path.split('/').slice(-2)[0];
}

function load(): Record<string, Preset> {
  const made: Record<string, Preset> = {};
  for (const [path, mod] of Object.entries(DESC)) {
    const id = folderOf(path);
    try {
      const { preset, warnings } = parsePreset(mod.default, `presets/${id}`);
      for (const w of warnings) console.warn(w);
      made[id] = preset;
    } catch (e) {
      // Один кривой пресет не должен уносить комнату целиком: остальные
      // сорок один предмет ни в чём не виноваты, а сломанный будет виден
      // кубиком на своём месте — ровно там, куда надо смотреть.
      console.error(`presets/${id}: не разобрался`, e);
    }
  }
  return made;
}

/** Пресеты как они лежат на диске — умолчания и то, к чему возвращает стенд. */
export const FILE_PRESETS: Record<string, Preset> = load();

/**
 * Живые пресеты.
 *
 * Отдельный стор по тем же причинам, что и у подгонки: пресет — свойство
 * ассетов, а не состояния офиса. Он не едет на сервер, не пишется в
 * стейт-файл и меняется только стендом. Правка файла руками перезагружает
 * страницу через HMR — стор при этом собирается заново.
 */
interface PresetState {
  presets: Record<string, Preset>;
  /** Правка одного пресета: стенд двигает поправку посадки. */
  patch: (id: string, edit: (preset: Preset) => Preset) => void;
  /** Вернуться к тому, что лежит на диске. */
  revert: () => void;
}

export const usePresets = create<PresetState>((set) => ({
  presets: FILE_PRESETS,
  patch: (id, edit) => set((s) => {
    const was = s.presets[id];
    if (!was) return s;
    return { presets: { ...s.presets, [id]: edit(structuredClone(was)) } };
  }),
  revert: () => set({ presets: FILE_PRESETS }),
}));

/**
 * Предмет, которого в пресетах нет: коробка размером с клетку.
 *
 * Кубик не на своём месте лучше дырки в комнате: новый спрайт в раскладке
 * должен быть виден сразу, а не через полчаса поисков, почему ничего не
 * появилось.
 */
export const FALLBACK: Preset = {
  id: 'unknown', title: 'Неизвестный предмет',
  size: [1, 1], footprint: [0, 0, 1, 1], h: 1, fallback: 'box', components: [],
};

/**
 * Пресет предмета — вне React, как и `fitNow()`: его спрашивают размещение,
 * посадка и замеры, которым хук не нужен и не положен.
 */
export function presetOf(sprite: string): Preset {
  return usePresets.getState().presets[sprite] ?? FALLBACK;
}

/**
 * Канонический ключ модели — `<пресет>/<часть>`.
 *
 * Ключом было имя файла, но с папками этого мало: `loungeSofa.glb` лежит и у
 * дивана, и у двухместного — это два разных ассета с одинаковым именем.
 * Пресет в ключе снимает совпадение, а заодно делает ссылку `on` и ключ
 * замера одним и тем же словом.
 */
export function keyOf(presetId: string, part: Part): string {
  return `${presetId}/${partName(part)}`;
}

/** Ссылка `on` пресета → канонический ключ. Своя часть дополняется хозяином. */
export function resolveRef(preset: Preset, ref: string): string {
  const { preset: owner, part } = splitRef(ref);
  return `${owner ?? preset.id}/${part}`;
}

/** Части всех пресетов по каноническому ключу — замерам нужен `probe`. */
export const PARTS: Record<string, Part> = {};
/** Ссылки на файлы моделей по тому же ключу. */
export const MODEL_URLS: Record<string, string> = {};

for (const [id, preset] of Object.entries(FILE_PRESETS)) {
  for (const part of preset.parts ?? []) {
    const key = keyOf(id, part);
    PARTS[key] = part;
    const url = URLS[`../../../design/presets/${id}/${part.file}`];
    if (url) MODEL_URLS[key] = url;
    else console.error(`presets/${id}: нет файла ${part.file}`);
  }
}

/** Порядок ключей фиксируем один раз: по нему грузятся и меряются модели. */
export const MODEL_KEYS = Object.keys(MODEL_URLS).sort();
export const MODEL_LIST = MODEL_KEYS.map((k) => MODEL_URLS[k]);

/**
 * Плоское на полу — ковёр, плитка, коврик у двери.
 *
 * Признак пока читается по запасной форме, как читался и раньше
 * (`def.shape === 'slab'`): такой предмет не поднимается на другие и сам
 * никого не держит. Связь с запасной формой — наследство; когда у плоского
 * появится свой компонент, менять придётся только это место.
 */
export function isFlat(preset: Preset): boolean {
  return preset.fallback === 'slab';
}

/** Висит ли предмет на стене, и на какой высоте. */
export function wallMount(preset: Preset) {
  return componentOf(preset, 'wall_mounted');
}

/**
 * Записать пресет в `design/presets/<id>/preset.json`.
 *
 * Пишет дев-сервер (плагин в `vite.config.ts`), потому что писать в `design/`
 * из браузера больше некому. В сборке этого маршрута нет — и не нужно: стенд
 * тоже только в деве.
 */
export async function savePreset(preset: Preset): Promise<void> {
  const res = await fetch(`/__preset/${preset.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(preset, null, 2),
  });
  if (!res.ok) throw new Error(`не записалось: ${res.status} ${await res.text()}`);
}

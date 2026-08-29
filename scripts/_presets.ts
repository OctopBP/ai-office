/**
 * Чтение пресетов и сборка записи каталога — общее для сверки и для тех, кто
 * захочет посчитать по пресетам что-то своё (проходимость, диф раскладки).
 *
 * Отдельный модуль, потому что скрипты запускаются как программы: импорт
 * `presets-catalog.ts` ради одной функции выполнил бы заодно и всю сверку.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parsePreset, type Preset } from '../src/shared/preset';
import type { CatalogSlot, CatalogSprite } from '../src/shared/layout';

export const ROOT = process.cwd();
export const PRESETS = path.join(ROOT, 'design/presets');
export const CATALOG = path.join(ROOT, 'design/sprites/out/catalog.json');
/** Что генератор посчитал по пикселям: размеры плюс спрайты без пресета. */
export const ART = path.join(ROOT, 'design/sprites/out/art.json');
export const DAY = path.join(ROOT, 'design/sprites/out/day');

/** Прочитать все пресеты, разобрать схемой, проверить имя папки. */
export function readPresets(): Map<string, Preset> {
  const out = new Map<string, Preset>();
  for (const dir of fs.readdirSync(PRESETS).sort()) {
    const file = path.join(PRESETS, dir, 'preset.json');
    if (!fs.existsSync(file)) continue;
    const { preset, warnings } = parsePreset(JSON.parse(fs.readFileSync(file, 'utf8')), `presets/${dir}`);
    for (const w of warnings) console.log(`  предупреждение: ${w}`);
    if (preset.id !== dir) throw new Error(`presets/${dir}: id внутри файла — «${preset.id}»`);
    out.set(dir, preset);
  }
  return out;
}

/**
 * Слоты каталога из компонентов — обратный ход переноса.
 *
 * Порядок сохраняется: слоты каталога и компоненты пресета идут в одном
 * порядке, и сверка сравнивает списки целиком, а не как множества. Это
 * намеренно строго — переставленные слоты у стола означали бы, что рабочее
 * место и табличка поменялись местами.
 */
export function slotsOf(preset: Preset): CatalogSlot[] {
  const slots: CatalogSlot[] = [];
  for (const c of preset.components) {
    if (c.type === 'work') slots.push({ kind: 'work', x: c.at[0], y: c.at[1] });
    else if (c.type === 'plate') slots.push({ kind: 'plate', x: c.at[0], y: c.at[1] });
    else if (c.type === 'seat') {
      if (c.shape === 'point') {
        slots.push({ kind: 'seat', x: c.at![0], y: c.at![1], ...(c.use ? { use: c.use } : {}) });
      } else if (c.shape === 'side') {
        slots.push({ kind: 'seat', side: c.side!, count: c.count! });
      } else {
        slots.push({ kind: 'seat', ring: c.ring!, rx: c.rx!, ry: c.ry!, ...(c.grow ? { grow: true } : {}) });
      }
    }
  }
  return slots;
}

/** Запись каталога. Порядок ключей — как у `gen.py:dump_catalog`, ради чистого дифа. */
export function entryOf(preset: Preset): CatalogSprite {
  return {
    size: preset.size,
    ...(preset.modelOnly ? { modelOnly: true as const } : {}),
    footprint: preset.footprint,
    ...(preset.layer ? { layer: preset.layer } : {}),
    ...(slotsOf(preset).length ? { slots: slotsOf(preset) } : {}),
    ...(preset.blocks ? { blocks: true } : {}),
    label: preset.title,
  };
}


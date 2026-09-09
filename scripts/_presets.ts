/**
 * Чтение пресетов с диска и пути к ассетам — общее для сверки и для тех, кто
 * захочет посчитать по пресетам что-то своё (проходимость, диф раскладки).
 *
 * Отдельный модуль, потому что скрипты запускаются как программы: импорт
 * `presets-catalog.ts` ради одной функции выполнил бы заодно и всю сверку.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parsePreset, type Preset } from '../src/shared/preset';

/**
 * Запись каталога собирается не здесь, а в `src/shared/preset.ts`: тот же
 * перевод нужен стенду в браузере, а сюда нельзя импортировать ничего из
 * `scripts/` — здесь `node:fs`. Реэкспорт оставлен, чтобы читатель скрипта
 * сборки не искал, где считается его главный результат.
 */
export { entryOf, slotsOf } from '../src/shared/preset';

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

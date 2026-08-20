#!/usr/bin/env node
/**
 * Сборка спрайт-листа персонажа из out/characters/{role}/{pose}.png по characters.json → rows.
 *
 *   node sheet.mjs --role backend            → out/characters/backend.sheet.png + backend.sheet.json (атлас)
 *   node sheet.mjs --role backend,frontend
 *
 * Пустые ячейки (поза ещё не сгенерирована) остаются прозрачными и помечаются в атласе как missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { DIRS, parseArgs, style, charsDb, listCsv } from './lib/common.mjs';

const args = parseArgs();
const PX = style.tile_px * style.scale;
const [cw, ch] = charsDb.cell;
const CW = Math.round(cw * PX), CH = Math.round(ch * PX);

async function buildSheet(roleId) {
  const dir = path.join(DIRS.out, 'characters', roleId);
  if (!fs.existsSync(dir)) { console.log(`нет out/characters/${roleId} — сначала post chars`); return; }
  const rows = charsDb.rows;
  const cols = Math.max(...rows.map(r => r.length));
  const comps = [];
  const atlas = { role: roleId, cell: [CW, CH], cell_tiles: charsDb.cell, cols, rows: rows.length, frames: {}, missing: [] };
  rows.forEach((row, ry) => row.forEach((poseId, cx) => {
    const f = path.join(dir, `${poseId}.png`);
    const frame = { x: cx * CW, y: ry * CH, w: CW, h: CH, row: ry, col: cx };
    atlas.frames[poseId] = frame;
    if (fs.existsSync(f)) comps.push({ input: f, left: frame.x, top: frame.y });
    else atlas.missing.push(poseId);
  }));
  // анимации — удобные группы для движка
  atlas.animations = {
    idle_south: ['idle_south', 'idle_south_2'], idle_north: ['idle_north'], idle_east: ['idle_east'],
    walk_south: ['walk_south_1', 'walk_south_2'], walk_north: ['walk_north_1', 'walk_north_2'], walk_east: ['walk_east_1', 'walk_east_2'],
    walk_west: ['walk_east_1', 'walk_east_2'], // зеркалить по X в движке
    sit_south: ['sit_south'], sit_type: ['sit_type_1', 'sit_type_2'], sit_north: ['sit_north'],
    talk: ['talk_1', 'talk_2'], alert: ['alert'], think: ['think'], celebrate: ['celebrate'], error: ['error_dizzy'],
  };
  const out = path.join(DIRS.out, 'characters', `${roleId}.sheet.png`);
  await sharp({ create: { width: cols * CW, height: rows.length * CH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(comps).png({ palette: true, colours: style.palette_colors }).toFile(out);
  fs.writeFileSync(out.replace('.png', '.json'), JSON.stringify(atlas, null, 2));
  console.log(`  → ${path.relative(process.cwd(), out)}  ${cols}×${rows.length} ячеек по ${CW}×${CH}${atlas.missing.length ? `, нет поз: ${atlas.missing.join(', ')}` : ''}`);
}

(async () => {
  for (const r of listCsv(args.role) || ['backend']) await buildSheet(r);
})().catch(e => { console.error(e); process.exit(1); });

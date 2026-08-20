#!/usr/bin/env node
/**
 * Контакт-листы для ревью: raw-варианты каждого пропса → хромакей → превью на шахматке 32px-сетки, с подписями.
 *
 *   node board.mjs --theme A [--cat desk,object] [--only ...]   → board/A/{cat}.png (по категориям)
 *   node board.mjs chars --role backend                        → board/characters/backend.png
 *   node board.mjs room --theme A                              → board/A/room.png — принятые out/ ассеты, собранные в кусок комнаты
 *
 * Картинки удобно закинуть в Figma (frame «10 · Ревью пропсов») и отметить выбранные варианты в picks.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { DIRS, parseArgs, selectProps, style, charsDb, ensureDir, listCsv } from './lib/common.mjs';
import { chromaKey, finalizeProp, finalizeTile, checker, labelSvg } from './lib/image.mjs';

const args = parseArgs();
const PX = style.tile_px * style.scale;
const CELL_PAD = 12;

async function previewOf(rawPng, prop, box) {
  const boxW = Math.round(box[0] * PX), boxH = Math.round(box[1] * PX);
  if (prop && prop.kind === 'tile') return (await finalizeTile(rawPng, { w: boxW, h: boxH })).toBuffer();
  let bg = style.key_color;
  const j = rawPng.replace('.png', '.json');
  if (fs.existsSync(j)) { try { bg = JSON.parse(fs.readFileSync(j, 'utf8')).bg || bg; } catch {} }
  const keyed = await chromaKey(rawPng, bg);
  return (await finalizeProp(keyed, { boxW, boxH })).toBuffer();
}

/** Строка: подпись + N вариантов (raw уменьшенный | превью после обработки) */
async function buildRow(label, variants, box, prop) {
  const boxW = Math.round(box[0] * PX), boxH = Math.round(box[1] * PX);
  const rawH = boxH, rawW = Math.round(rawH); // raw показываем квадратом высотой с превью
  const cellW = rawW + 8 + boxW + CELL_PAD;
  const rowW = 40 + variants.length * cellW;
  const rowH = boxH + 48;
  const bg = await checker(rowW, rowH, style.tile_px * style.scale / 4);
  const comps = [{ input: labelSvg(label, rowW), left: 0, top: 0 }];
  let x = 40;
  for (let i = 0; i < variants.length; i++) {
    const rawPng = variants[i];
    const rawSmall = await sharp(rawPng).resize(rawW, rawH, { fit: 'inside' }).png().toBuffer();
    comps.push({ input: rawSmall, left: x, top: 24 });
    try {
      const prev = await previewOf(rawPng, prop, box);
      comps.push({ input: prev, left: x + rawW + 8, top: 24 });
    } catch (e) {
      comps.push({ input: labelSvg('✗ ' + e.message.slice(0, 30), boxW, 22, 11, '#ff7a7a'), left: x + rawW + 8, top: 24 });
    }
    comps.push({ input: labelSvg(`#${i + 1}`, 60, 18, 12, '#ff9a4d'), left: x + rawW + 8, top: 24 + boxH + 4 });
    x += cellW;
  }
  return { buf: await sharp(bg).composite(comps).png().toBuffer(), w: rowW, h: rowH };
}

async function stackRows(rows, outFile, title) {
  const w = Math.max(...rows.map(r => r.w), 400);
  const h = rows.reduce((s, r) => s + r.h + 8, 40);
  const canvas = sharp({ create: { width: w, height: h, channels: 4, background: '#1b1c28' } });
  const comps = [{ input: labelSvg(title, w, 32, 18, '#ffffff'), left: 8, top: 4 }];
  let y = 40;
  for (const r of rows) { comps.push({ input: r.buf, left: 0, top: y }); y += r.h + 8; }
  await canvas.composite(comps).png().toFile(outFile);
  console.log(`  → ${path.relative(process.cwd(), outFile)} (${rows.length} строк)`);
}

async function boardProps() {
  const theme = args.theme || 'A';
  const sel = selectProps(args).filter(p => p.themes.includes(theme));
  const byCat = {};
  for (const p of sel) (byCat[p.cat] ??= []).push(p);
  const outDir = ensureDir(path.join(DIRS.board, theme));
  for (const [cat, props] of Object.entries(byCat)) {
    const rows = [];
    for (const prop of props) {
      const dir = path.join(DIRS.raw, theme, prop.id);
      if (!fs.existsSync(dir)) continue;
      const variants = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort().map(f => path.join(dir, f));
      if (!variants.length) continue;
      rows.push(await buildRow(`${prop.id}  (${(prop.box || prop.tiles).join('×')} тайлов)`, variants, prop.box || prop.tiles, prop));
    }
    if (rows.length) await stackRows(rows, path.join(outDir, `${cat}.png`), `Тема ${theme} · ${cat} — слева raw, справа после обработки; выбор → picks.json { "${theme}/<id>": N }`);
  }
}

async function boardChars() {
  const roles = listCsv(args.role) || ['backend'];
  const outDir = ensureDir(path.join(DIRS.board, 'characters'));
  for (const roleId of roles) {
    const rawRole = path.join(DIRS.raw, 'characters', roleId);
    if (!fs.existsSync(rawRole)) continue;
    const rows = [];
    for (const poseId of Object.keys(charsDb.poses)) {
      const dir = path.join(rawRole, poseId);
      if (!fs.existsSync(dir)) continue;
      const variants = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort().map(f => path.join(dir, f));
      if (variants.length) rows.push(await buildRow(poseId, variants, charsDb.cell, null));
    }
    if (rows.length) await stackRows(rows, path.join(outDir, `${roleId}.png`), `Персонаж ${roleId} — выбор → picks.json { "characters/${roleId}/<pose>": N }`);
  }
}

/** Собрать кусок комнаты из принятых ассетов: пол 8×5, стена сверху, стол+стул+монитор, растение, доска */
async function boardRoom() {
  const theme = args.theme || 'A';
  const outDir = path.join(DIRS.out, theme);
  const m = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(m)) { console.log('нет out/manifest — сначала post'); return; }
  const manifest = JSON.parse(fs.readFileSync(m, 'utf8'));
  const has = id => manifest.props[id] && fs.existsSync(path.join(outDir, `${id}.png`));
  const W = 8, H = 5;
  const canvasW = W * PX, canvasH = (H + 1.25) * PX;
  const comps = [];
  const floorId = ['floor_wood_light', 'floor_tile_grey', 'floor_wood_dark', 'floor_carpet', 'floor_dark_indigo'].find(has);
  if (floorId) {
    const tile = await sharp(path.join(outDir, `${floorId}.png`)).png().toBuffer();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) comps.push({ input: tile, left: x * PX, top: Math.round(1.25 * PX + y * PX) });
  }
  const put = (id, tx, ty) => { if (has(id)) comps.push({ input: path.join(outDir, `${id}.png`), left: Math.round(tx * PX), top: Math.round(ty * PX) }); };
  // стена сверху (wall_top 2×1.25 в ряд), окно, доска, постер
  for (let x = 0; x < W; x += 2) put('wall_top', x, 0);
  put('wall_window', 0, 0); put('task_board', 3, 0); put('poster_a', 7, 0);
  // рабочие места: стол+монитор+стул+табличка (персонаж сидит лицом к камере: стол ниже стула)
  const desk = (tx, ty) => { put('chair_north', tx + 0.5, ty - 0.5); put('desk_south', tx, ty); put('monitor_north', tx + 0.5, ty - 0.35); put('placard_blank', tx + 0.5, ty + 0.55); };
  desk(1, 2.4); desk(4, 2.4);
  put('plant_floor_large', 7, 1.75); put('water_cooler', 7, 4); put('bookshelf', 0, 4.4);
  // якорь: у пропсов box прижат к низу, поэтому top = (ty + box_h) - box_h … упрощённо кладём top-left по тайлам, для ревью достаточно
  const outFile = path.join(ensureDir(path.join(DIRS.board, theme)), 'room.png');
  const bgBuf = await checker(canvasW, Math.round(canvasH), 32);
  await sharp(bgBuf).composite(comps).png().toFile(outFile);
  console.log(`  → ${path.relative(process.cwd(), outFile)} — проверьте: толщина обводки, наклон, высота стола/стула, масштаб растения`);
}

(async () => {
  if (args._[0] === 'chars' || args._[0] === 'characters') await boardChars();
  else if (args._[0] === 'room') await boardRoom();
  else await boardProps();
})().catch(e => { console.error(e); process.exit(1); });

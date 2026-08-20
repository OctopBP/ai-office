#!/usr/bin/env node
/**
 * Постобработка raw → out: хромакей → обрезка → вписать в box (nearest) → якорь снизу → палитра ≤ N цветов.
 *
 *   node post.mjs --theme A                    все пропсы темы A, вариант из picks.json (по умолчанию #1)
 *   node post.mjs --theme A --only desk_south --variant 2
 *   node post.mjs chars --role backend         позы персонажа → out/characters/backend/{pose}.png
 *
 * picks.json (в корне tools/props): { "A/desk_south": 2, "characters/backend/idle_south": 3 }
 * Результат: out/{theme}/{id}.png + out/{theme}/manifest.json ; out/characters/{role}/{pose}.png
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { DIRS, ROOT, parseArgs, selectProps, style, charsDb, ensureDir, listCsv } from './lib/common.mjs';
import { chromaKey, finalizeProp, finalizeTile } from './lib/image.mjs';

const args = parseArgs();
const PX = style.tile_px * style.scale; // 128 px на тайл
const picksPath = path.join(ROOT, 'picks.json');
const picks = fs.existsSync(picksPath) ? JSON.parse(fs.readFileSync(picksPath, 'utf8')) : {};

function pickVariant(key) {
  if (args.variant) return Number(args.variant);
  return Number(picks[key] || 1);
}
function rawFile(dir, n) {
  const f = path.join(dir, `${n}.png`);
  return fs.existsSync(f) ? f : null;
}
function bgOf(rawPng, fallback) {
  const j = rawPng.replace('.png', '.json');
  if (fs.existsSync(j)) { try { return JSON.parse(fs.readFileSync(j, 'utf8')).bg || fallback; } catch {} }
  return fallback;
}

async function main() {
  if (args._[0] === 'chars' || args._[0] === 'characters') return postChars();
  return postProps();
}

async function postProps() {
  const theme = args.theme || 'A';
  const sel = selectProps(args).filter(p => p.themes.includes(theme));
  const outDir = ensureDir(path.join(DIRS.out, theme));
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { theme, tile_px: style.tile_px, scale: style.scale, props: {} };
  let ok = 0, skipped = 0;
  for (const prop of sel) {
    const key = `${theme}/${prop.id}`;
    const n = pickVariant(key);
    const raw = rawFile(path.join(DIRS.raw, theme, prop.id), n);
    if (!raw) { skipped++; continue; }
    const box = prop.box || prop.tiles;
    const boxW = Math.round(box[0] * PX), boxH = Math.round(box[1] * PX);
    const outFile = path.join(outDir, `${prop.id}.png`);
    try {
      let img;
      if (prop.kind === 'tile') {
        img = await finalizeTile(raw, { w: boxW, h: boxH });
      } else {
        const keyed = await chromaKey(raw, bgOf(raw, prop.bg || style.key_color));
        img = await finalizeProp(keyed, { boxW, boxH, anchor: 'bottom' });
      }
      await img.toFile(outFile);
      manifest.props[prop.id] = { file: `${prop.id}.png`, kind: prop.kind, cat: prop.cat, tiles: prop.tiles, box, px: [boxW, boxH], anchor: prop.kind === 'tile' ? 'none' : 'bottom', variant: n };
      ok++;
      console.log(`  ✓ ${prop.id} (#${n}) → ${boxW}×${boxH}`);
    } catch (e) {
      console.error(`  ✗ ${prop.id}: ${e.message}`);
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n${ok} готово, ${skipped} без raw → out/${theme}/ (manifest.json обновлён)`);
}

async function postChars() {
  const roles = listCsv(args.role) || ['backend'];
  const [cw, ch] = charsDb.cell;
  const boxW = Math.round(cw * PX), boxH = Math.round(ch * PX);
  for (const roleId of roles) {
    const rawRole = path.join(DIRS.raw, 'characters', roleId);
    if (!fs.existsSync(rawRole)) { console.log(`нет raw для ${roleId}`); continue; }
    const outDir = ensureDir(path.join(DIRS.out, 'characters', roleId));
    const poses = listCsv(args.poses) || fs.readdirSync(rawRole).filter(d => fs.statSync(path.join(rawRole, d)).isDirectory());
    let ok = 0;
    for (const poseId of poses) {
      const key = `characters/${roleId}/${poseId}`;
      const raw = rawFile(path.join(rawRole, poseId), pickVariant(key));
      if (!raw) continue;
      try {
        const bg = bgOf(raw, style.roles[roleId]?.bg || style.key_color);
        const keyed = await chromaKey(raw, bg);
        const img = await finalizeProp(keyed, { boxW, boxH, anchor: 'bottom' });
        await img.toFile(path.join(outDir, `${poseId}.png`));
        ok++;
        console.log(`  ✓ ${roleId}/${poseId} (#${pickVariant(key)})`);
      } catch (e) {
        console.error(`  ✗ ${roleId}/${poseId}: ${e.message}`);
      }
    }
    console.log(`[${roleId}] ${ok} поз → out/characters/${roleId}/ (ячейка ${boxW}×${boxH})`);
  }
}

// небольшой sanity-check: sharp загружен
void sharp;
main().catch(e => { console.error(e); process.exit(1); });

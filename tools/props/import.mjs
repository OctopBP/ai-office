#!/usr/bin/env node
/**
 * Импорт скачанных вручную картинок (T3 Chat и т.п.) в raw/ по пакету промптов.
 *
 *   node import.mjs --pack A_floor-wall --from ~/Downloads               по времени скачивания, 1 картинка на промпт
 *   node import.mjs --pack A_floor-wall --from ~/Downloads --per 3       по 3 картинки на промпт подряд
 *   node import.mjs --pack A_floor-wall --from ~/Downloads --since 30m   брать только файлы новее 30 минут (или 2h, 1d)
 *   node import.mjs --pack A_floor-wall --from ~/Downloads --dry         показать раскладку без копирования
 *   node import.mjs --file ~/Downloads/img.png --id desk_south --theme A [--variant 2]   одну картинку вручную
 *
 * Если файл в --from назван как id пропса (например desk_south.png, desk_south_2.png) — он привязывается по имени, а не по порядку.
 * Каждый импорт пишет sidecar .json (промпт, bg, источник) — post/board используют bg оттуда.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT, DIRS, parseArgs, ensureDir, style, propsDb } from './lib/common.mjs';

const args = parseArgs();
const dry = !!args.dry;
const IMG = /\.(png|jpe?g|webp)$/i;

function expand(p) { return p.replace(/^~(?=$|\/)/, os.homedir()); }
function parseSince(s) {
  if (!s) return 0;
  const m = String(s).match(/^(\d+)([mhd])$/); if (!m) return 0;
  const mult = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
  return Date.now() - Number(m[1]) * mult;
}
function nextVariant(dir) {
  if (!fs.existsSync(dir)) return 1;
  const nums = fs.readdirSync(dir).filter(f => /^\d+\.png$/.test(f)).map(f => Number(f.replace('.png', '')));
  return nums.length ? Math.max(...nums) + 1 : 1;
}
async function place(src, targetDir, meta, variant) {
  ensureDir(targetDir);
  const n = variant || nextVariant(targetDir);
  const dst = path.join(targetDir, `${n}.png`);
  if (dry) { console.log(`  ${path.basename(src)}  →  ${path.relative(ROOT, dst)}`); return; }
  await sharp(src).png().toFile(dst);
  fs.writeFileSync(dst.replace('.png', '.json'), JSON.stringify({ ...meta, variant: n, source: src, at: new Date().toISOString() }, null, 2));
  console.log(`  ✓ ${path.basename(src)}  →  ${path.relative(ROOT, dst)}`);
}

async function main() {
  // одиночный файл
  if (args.file) {
    const prop = propsDb.props.find(p => p.id === args.id);
    if (!prop) throw new Error(`--id ${args.id} не найден в props.json`);
    const theme = args.theme || 'A';
    await place(expand(args.file), path.join(DIRS.raw, theme, prop.id), { id: prop.id, theme, bg: prop.bg || style.key_color, imported: true }, args.variant && Number(args.variant));
    return;
  }
  if (!args.pack) throw new Error('Укажите --pack <имя из prompts/> или --file');
  const packPath = path.join(ROOT, 'prompts', `${args.pack}.json`);
  if (!fs.existsSync(packPath)) throw new Error(`Нет prompts/${args.pack}.json — сначала node prompts.mjs`);
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  const from = expand(args.from || '~/Downloads');
  const since = parseSince(args.since);
  const per = Number(args.per || 1);

  const files = fs.readdirSync(from).filter(f => IMG.test(f)).map(f => ({ f, p: path.join(from, f), t: fs.statSync(path.join(from, f)).mtimeMs }))
    .filter(x => x.t >= since).sort((a, b) => a.t - b.t);
  if (!files.length) { console.log('Нет подходящих картинок в', from); return; }

  const targetOf = it => it.kind === 'char' ? path.join(DIRS.raw, 'characters', it.role, it.pose) : path.join(DIRS.raw, it.theme, it.id);
  const metaOf = it => it.kind === 'char' ? { role: it.role, pose: it.pose, bg: it.bg, prompt: it.prompt, imported: true, pack: pack.name } : { id: it.id, theme: it.theme, bg: it.bg, prompt: it.prompt, imported: true, pack: pack.name };

  // 1) по имени файла: <key>[_N].ext
  const byName = new Map(pack.items.map(it => [it.key.replace('/', '_'), it]));
  const rest = [];
  for (const x of files) {
    const base = x.f.replace(IMG, '').replace(/[ -]?\(\d+\)$/, '');
    const m = base.match(/^(.*?)(?:_(\d+))?$/);
    const it = byName.get(m[1]) || byName.get(base);
    if (it) await place(x.p, targetOf(it), metaOf(it), m[2] ? Number(m[2]) : undefined);
    else rest.push(x);
  }
  // 2) остальные — по порядку пакета
  const need = pack.items.length * per;
  if (rest.length && rest.length !== need) console.warn(`⚠ по порядку: файлов ${rest.length}, ожидалось ${need} (${pack.items.length} промптов × ${per}). Раскладываю первые ${Math.min(rest.length, need)}; проверьте --since / --per.`);
  let k = 0;
  for (const it of pack.items) for (let v = 0; v < per && k < rest.length; v++, k++) await place(rest[k].p, targetOf(it), metaOf(it));
  console.log(`\n${dry ? '(dry) ' : ''}готово. Дальше: npm run board -- --theme <T>  →  picks.json  →  npm run post`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });

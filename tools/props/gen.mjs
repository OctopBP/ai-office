#!/usr/bin/env node
/**
 * Генерация пропсов и персонажей через Nano Banana (Gemini image models).
 *
 *   node gen.mjs --list                                   список пропсов с фильтрами
 *   node gen.mjs --theme A --priority 1                   все ★-пропсы темы A, 3 варианта
 *   node gen.mjs --cat desk,object --theme A --variants 2
 *   node gen.mjs --only desk_south,chair_south --theme A --model pro
 *   node gen.mjs chars --role backend                     персонаж: anchor + все позы p=1
 *   node gen.mjs chars --role backend --poses walk_east_1,walk_east_2 --variants 2
 *   --dry            только показать промпты, без запросов
 *   --no-refs        не прикладывать референсы
 *   --force          перегенерировать, даже если варианты уже есть
 *   --seed 100       воспроизводимость (seed+номер варианта; поддержка зависит от модели)
 *
 * Референсы: refs/style_ref.png (якорь стиля, делается руками) + принятые ассеты той же категории из out/{theme}/
 * (для персонажей — принятая/первая anchor-поза роли). Результаты: raw/{theme}/{id}/{n}.png + .json (промпт, модель, refы).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DIRS, loadEnv, parseArgs, selectProps, buildPropPrompt, buildCharPrompt,
  aspectFor, style, charsDb, ensureDir, listCsv, nowStamp,
} from './lib/common.mjs';
import { generateImage } from './lib/gemini.mjs';

loadEnv();
const args = parseArgs();
const dry = !!args.dry;
const useRefs = !args['no-refs'];
const variants = Number(args.variants || style.variants || 3);
const concurrency = Number(args.concurrency || style.concurrency || 2);
const force = !!args.force;

const styleRef = path.join(DIRS.refs, 'style_ref.png');
const haveStyleRef = fs.existsSync(styleRef);

async function main() {
  if (args._[0] === 'chars' || args._[0] === 'characters') return genCharacters();
  if (args.list) return listProps();
  return genProps();
}

function listProps() {
  const sel = selectProps(args);
  for (const p of sel) console.log(`${'★'.repeat(Math.max(0, 2 - p.p)).padEnd(2)} ${p.id.padEnd(22)} ${p.cat.padEnd(7)} ${p.kind.padEnd(5)} ${p.themes.join('/')}  box=${(p.box || p.tiles).join('×')}`);
  console.log(`\n${sel.length} пропсов`);
}

/** Очередь с ограничением параллелизма */
async function runQueue(jobs, limit) {
  let i = 0, done = 0, failed = 0, stop = null;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (i < jobs.length && !stop) {
      const job = jobs[i++];
      try { await job(); done++; }
      catch (e) {
        failed++;
        if (e?.fatal) { stop = e; break; }        // квота/ключ — дальше бессмысленно
        console.error(`  ✗ ${e.message || e}`);
      }
    }
  });
  await Promise.all(workers);
  if (stop) console.error(`\n✗ ${stop.message}`);
  return { done, failed, stopped: !!stop };
}

/** Референсы для пропса: style_ref + до 2 принятых ассетов той же категории/темы */
function refsForProp(prop, theme) {
  if (!useRefs) return [];
  const refs = [];
  if (haveStyleRef) refs.push(styleRef);
  const outDir = path.join(DIRS.out, theme);
  if (fs.existsSync(outDir)) {
    const sameCat = fs.readdirSync(outDir)
      .filter(f => f.endsWith('.png') && f !== `${prop.id}.png`)
      .filter(f => (findProp(f.replace('.png', ''))?.cat) === prop.cat)
      .slice(0, 2)
      .map(f => path.join(outDir, f));
    refs.push(...sameCat);
  }
  return refs;
}
function findProp(id) { return selectProps({}).find(p => p.id === id); }

async function genProps() {
  const theme = args.theme || 'A';
  const sel = selectProps(args).filter(p => p.themes.includes(theme));
  if (!sel.length) { console.log('Ничего не выбрано (проверьте --theme/--cat/--only/--priority)'); return; }
  console.log(`Тема ${theme} · ${sel.length} пропсов × ${variants} вариантов · модель по умолчанию ${style.models.flash}${haveStyleRef ? ' · style_ref ✓' : ' · style_ref ✗ (положите refs/style_ref.png)'}`);

  const jobs = [];
  for (const prop of sel) {
    const outDir = ensureDir(path.join(DIRS.raw, theme, prop.id));
    const refs = refsForProp(prop, theme);
    const { prompt, bg } = buildPropPrompt(prop, theme, { hasRefs: refs.length > 0 });
    const box = prop.box || prop.tiles;
    const aspect = prop.kind === 'tile' ? '1:1' : aspectFor(box[0], box[1]);
    const model = args.model || prop.model || 'flash';
    for (let n = 1; n <= variants; n++) {
      const file = path.join(outDir, `${n}.png`);
      if (fs.existsSync(file) && !force) continue;
      jobs.push(async () => {
        if (dry) { console.log(`\n[${prop.id} #${n}] ${model} ${aspect} refs=${refs.length}\n${prompt}`); return; }
        const t0 = Date.now();
        const seed = args.seed !== undefined ? Number(args.seed) + n : undefined;
        const res = await generateImage({ prompt, refPaths: refs, model, aspect, seed });
        fs.writeFileSync(file, res.png);
        fs.writeFileSync(file.replace('.png', '.json'), JSON.stringify({
          id: prop.id, seed, theme, variant: n, model: res.model, api: res.api, aspect, bg,
          refs: refs.map(r => path.relative(DIRS.refs, r)), prompt, at: nowStamp(),
        }, null, 2));
        console.log(`  ✓ ${prop.id} #${n} (${((Date.now() - t0) / 1000).toFixed(1)}s, ${res.model})`);
      });
    }
  }
  if (!jobs.length) { console.log('Все варианты уже есть (используйте --force для перегенерации)'); return; }
  console.log(`${jobs.length} запросов, параллельно ${concurrency}${dry ? ' (dry-run)' : ''}`);
  const r = await runQueue(jobs, dry ? 1 : concurrency);
  console.log(`\nГотово: ${r.done} ок, ${r.failed} ошибок → raw/${theme}/. Дальше: npm run board -- --theme ${theme}  → выбрать варианты в picks.json → npm run post`);
}

async function genCharacters() {
  const roles = listCsv(args.role) || ['backend'];
  const maxP = Number(args.priority || 1);
  const poseFilter = listCsv(args.poses);
  const anchorId = charsDb.anchor;

  for (const roleId of roles) {
    if (!style.roles[roleId]) { console.error(`Роль ${roleId} не описана в style.json`); continue; }
    const rawDir = ensureDir(path.join(DIRS.raw, 'characters', roleId));
    const outDir = path.join(DIRS.out, 'characters', roleId);
    const poses = Object.entries(charsDb.poses)
      .filter(([id, p]) => (poseFilter ? poseFilter.includes(id) : p.p <= maxP))
      .map(([id]) => id);

    // 1) anchor — сначала и отдельно (остальные позы ссылаются на него)
    const anchorOut = path.join(outDir, `${anchorId}.png`);
    let anchorRef = fs.existsSync(anchorOut) ? anchorOut : firstRaw(path.join(rawDir, anchorId));
    if (!anchorRef || force) {
      if (poses.includes(anchorId) || !anchorRef) {
        console.log(`[${roleId}] anchor ${anchorId}`);
        anchorRef = await genPose(roleId, anchorId, rawDir, { refs: haveStyleRef && useRefs ? [styleRef] : [], isAnchor: true });
        if (!dry) console.log(`  → выберите лучший вариант anchor в raw/characters/${roleId}/${anchorId}/, запишите в picks.json и запустите post — иначе для остальных поз возьмётся вариант #1`);
      }
    }
    // 2) остальные позы с anchor как референсом
    const rest = poses.filter(p => p !== anchorId);
    const jobs = rest.map(poseId => async () => {
      const refs = [];
      if (useRefs && anchorRef) refs.push(anchorRef);
      if (useRefs && haveStyleRef) refs.push(styleRef);
      await genPose(roleId, poseId, rawDir, { refs, isAnchor: false });
    });
    console.log(`[${roleId}] ${rest.length} поз × ${variants} вариантов`);
    const r = await runQueue(jobs, dry ? 1 : concurrency);
    console.log(`[${roleId}] готово: ${r.done} ок, ${r.failed} ошибок → raw/characters/${roleId}/`);
  }
  console.log('\nДальше: npm run board -- chars --role <role> → picks.json → npm run post -- chars → npm run sheet -- --role <role>');
}

function firstRaw(dir) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter(x => x.endsWith('.png')).sort()[0];
  return f ? path.join(dir, f) : null;
}

async function genPose(roleId, poseId, rawDir, { refs, isAnchor }) {
  const dir = ensureDir(path.join(rawDir, poseId));
  const { prompt, bg } = buildCharPrompt(roleId, poseId, { hasRefs: refs.length > 0, isAnchor });
  const cell = charsDb.cell;
  const aspect = aspectFor(cell[0], cell[1]);
  const model = args.model || (isAnchor ? 'pro' : 'flash');
  let first = null;
  for (let n = 1; n <= variants; n++) {
    const file = path.join(dir, `${n}.png`);
    if (fs.existsSync(file) && !force) { first ??= file; continue; }
    if (dry) { console.log(`\n[${roleId}/${poseId} #${n}] ${model} ${aspect} refs=${refs.length}\n${prompt}`); continue; }
    const t0 = Date.now();
    const seed = args.seed !== undefined ? Number(args.seed) + n : undefined;
    const res = await generateImage({ prompt, refPaths: refs, model, aspect, seed });
    fs.writeFileSync(file, res.png);
    fs.writeFileSync(file.replace('.png', '.json'), JSON.stringify({
      role: roleId, seed, pose: poseId, variant: n, model: res.model, api: res.api, aspect, bg,
      refs: refs.map(r => path.relative(DIRS.refs, r)), prompt, at: nowStamp(),
    }, null, 2));
    console.log(`  ✓ ${roleId}/${poseId} #${n} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    first ??= file;
  }
  return first;
}

main().catch(e => { console.error(e); process.exit(1); });

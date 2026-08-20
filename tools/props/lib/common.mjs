import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DIRS = {
  raw: path.join(ROOT, 'raw'),
  out: path.join(ROOT, 'out'),
  board: path.join(ROOT, 'board'),
  refs: path.join(ROOT, 'refs'),
};

export function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

export function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
}

export const style = loadJson('style.json');
export const propsDb = loadJson('props.json');
export const charsDb = loadJson('characters.json');

/** Разбор argv вида --key value / --flag / позиционные */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

export function listCsv(v) { return v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : null; }

/** Отбор пропсов по фильтрам CLI */
export function selectProps({ only, cat, theme, priority }) {
  const onlyList = listCsv(only);
  const catList = listCsv(cat);
  const maxP = priority ? Number(priority) : 3;
  return propsDb.props.filter(p =>
    (!onlyList || onlyList.includes(p.id)) &&
    (!catList || catList.includes(p.cat)) &&
    (!theme || p.themes.includes(theme)) &&
    p.p <= maxP
  );
}

/** Ближайший допустимый aspect ratio по визуальному bbox */
export function aspectFor(w, h) {
  const allowed = { '1:1': 1, '4:3': 4/3, '3:2': 1.5, '16:9': 16/9, '21:9': 21/9, '3:4': 3/4, '2:3': 2/3, '4:5': 0.8, '5:4': 1.25, '9:16': 9/16 };
  const r = w / h;
  let best = '1:1', d = Infinity;
  for (const [k, v] of Object.entries(allowed)) { const dd = Math.abs(Math.log(v / r)); if (dd < d) { d = dd; best = k; } }
  return best;
}

export function themePalette(themeId) {
  const t = style.themes[themeId];
  if (!t) throw new Error(`Неизвестная тема ${themeId}`);
  return t.palette;
}

/** Собрать полный промпт для пропса */
export function buildPropPrompt(prop, themeId, { hasRefs }) {
  const palette = themePalette(themeId);
  const body = ((prop.promptByTheme && prop.promptByTheme[themeId]) || prop.prompt).replace(/\{PALETTE\}/g, palette);
  const bg = prop.bg || style.key_color;
  const parts = [];
  if (prop.kind === 'tile') {
    parts.push(style.tile_prefix, body);
  } else if (prop.kind === 'wall') {
    parts.push(style.wall_prefix, body, style.bg_hint.replace('{BG}', bg));
  } else {
    parts.push(style.style_prefix, body, style.bg_hint.replace('{BG}', bg));
  }
  if (hasRefs) parts.push(style.ref_hint);
  parts.push(style.avoid);
  return { prompt: parts.join('. ').replace(/\.\./g, '.'), bg };
}

/** Собрать промпт для позы персонажа */
export function buildCharPrompt(roleId, poseId, { hasRefs, isAnchor }) {
  const role = style.roles[roleId];
  if (!role) throw new Error(`Неизвестная роль ${roleId}`);
  const pose = charsDb.poses[poseId];
  if (!pose) throw new Error(`Неизвестная поза ${poseId}`);
  const bg = role.bg || style.key_color;
  const parts = [
    style.style_prefix,
    `pixel-art character: ${role.desc}`,
    style.char_rules.replace('{ROLE_COLOR}', role.color),
    `Pose: ${pose.prompt}`,
    style.bg_hint.replace('{BG}', bg),
  ];
  if (hasRefs && !isAnchor) parts.push('This must be the SAME character as in the reference image (identical face, hair, clothes, colors, proportions and outline); only the pose changes.');
  else if (hasRefs) parts.push(style.ref_hint);
  parts.push('No props except what the character holds, no floor, no shadow.');
  parts.push(style.avoid);
  return { prompt: parts.join('. ').replace(/\.\./g, '.'), bg };
}

export function nowStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

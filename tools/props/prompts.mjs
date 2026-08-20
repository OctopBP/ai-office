#!/usr/bin/env node
/**
 * Пакет промптов для ручной генерации (T3 Chat / Gemini / любой чат с картинками).
 *
 *   node prompts.mjs --theme A --cat floor,wall            → prompts/A_floor-wall.md + .json (порядок для import.mjs)
 *   node prompts.mjs --theme A --priority 1
 *   node prompts.mjs chars --role backend [--poses ...]     → prompts/chars_backend.md + .json
 *
 * В .md каждый промпт — отдельный блок с номером и ожидаемым именем файла; в чат вставляйте блок целиком.
 * Прикрепляйте refs/style_ref.png к каждому сообщению (или держите его в одном треде) — это даёт консистентность.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, parseArgs, selectProps, buildPropPrompt, buildCharPrompt, aspectFor, style, charsDb, ensureDir, listCsv } from './lib/common.mjs';

const args = parseArgs();
const outDir = ensureDir(path.join(ROOT, 'prompts'));

function writePack(name, items, header) {
  const md = [`# ${header}`, '',
    'Как пользоваться: прикрепите refs/style_ref.png, вставьте блок промпта, дождитесь картинки, скачайте.',
    'Скачивайте В ТОМ ЖЕ ПОРЯДКЕ, что и промпты (import.mjs раскладывает файлы по времени скачивания),',
    'либо переименуйте файл в указанное имя (тогда порядок не важен). Соотношение сторон — если чат позволяет его задать.', ''];
  items.forEach((it, i) => {
    md.push(`## ${i + 1}. ${it.key}   →   файл: ${it.file}   ·   aspect ${it.aspect}   ·   фон ${it.bg}`, '', '```', it.prompt, '```', '');
  });
  fs.writeFileSync(path.join(outDir, `${name}.md`), md.join('\n'));
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ name, items }, null, 2));
  console.log(`→ prompts/${name}.md  (${items.length} промптов)   ·   после скачивания: node import.mjs --pack ${name} --from ~/Downloads`);
}

if (args._[0] === 'chars' || args._[0] === 'characters') {
  const roles = listCsv(args.role) || ['backend'];
  for (const roleId of roles) {
    const poseFilter = listCsv(args.poses);
    const maxP = Number(args.priority || 1);
    const poses = Object.entries(charsDb.poses).filter(([id, p]) => poseFilter ? poseFilter.includes(id) : p.p <= maxP).map(([id]) => id);
    // anchor первым
    poses.sort((a, b) => (a === charsDb.anchor ? -1 : b === charsDb.anchor ? 1 : 0));
    const items = poses.map(poseId => {
      const isAnchor = poseId === charsDb.anchor;
      const { prompt, bg } = buildCharPrompt(roleId, poseId, { hasRefs: true, isAnchor });
      const aspect = aspectFor(...charsDb.cell);
      return { key: `${roleId}/${poseId}`, kind: 'char', role: roleId, pose: poseId, file: `raw/characters/${roleId}/${poseId}/N.png`, aspect, bg, prompt: `${prompt} Output aspect ratio ${aspect}.` + (isAnchor ? '' : ' (Attach the accepted idle_south image of this character as the reference.)') };
    });
    writePack(`chars_${roleId}`, items, `Персонаж ${roleId} — сначала anchor (${charsDb.anchor}), выберите лучший, затем остальные позы с ним в референсе`);
  }
} else {
  const theme = args.theme || 'A';
  const sel = selectProps(args).filter(p => p.themes.includes(theme));
  const items = sel.map(prop => {
    const { prompt, bg } = buildPropPrompt(prop, theme, { hasRefs: true });
    const box = prop.box || prop.tiles;
    const aspect = prop.kind === 'tile' ? '1:1' : aspectFor(box[0], box[1]);
    return { key: prop.id, kind: 'prop', theme, id: prop.id, file: `raw/${theme}/${prop.id}/N.png`, aspect, bg: prop.kind === 'tile' ? '—' : bg, prompt: `${prompt} Output aspect ratio ${aspect}.` };
  });
  const tag = [args.cat && String(args.cat).replace(/,/g, '-'), args.only && 'only', args.priority && `p${args.priority}`].filter(Boolean).join('_') || 'all';
  writePack(`${theme}_${tag}`, items, `Тема ${theme} (${style.themes[theme].name}) · ${tag} · ${items.length} пропсов`);
}

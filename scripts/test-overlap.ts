/**
 * Предупреждение о дублирующих правках — на настоящем репозитории и без единого
 * токена. Стенд повторяет форму T-138: и основная ветка, и ветка задачи чинят
 * одни и те же функции `entryOf` и `slotsOf` в `shared/preset.ts`, правки лежат
 * в разных строках, git сливает их молча — и ровно это надо назвать вслух.
 *
 * Проверяем три вещи из критериев задачи:
 *  1. файл из кейса T-138 попадает в список, с именами обеих функций;
 *  2. предупреждение не блокирует слияние и печатается в отчёте гейта;
 *  3. файлы, которые правила только одна сторона, в список не попадают.
 *
 * Запуск: npm run test:overlap
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { duplicateEdits } from '../src/server/overlap';
import { defaultIntegrationDir, formatReport, preMergeGate } from '../src/server/premerge';

// Отчёт сверяем дословно, а он написан по-русски.
process.env.OFFICE_LANG = 'ru';

/** Общий предок: две функции, каждая в несколько строк, — есть где разойтись. */
const PRESET_BASE = `export function entryOf(place, layout) {
  const cell = layout.cells[place.id];
  const dx = cell.x - place.x;
  const dy = cell.y - place.y;
  const dist = Math.abs(dx) + Math.abs(dy);
  return { cell, dist };
}

export function slotsOf(desk, layout) {
  const seats = layout.seats[desk.id] ?? [];
  const free = seats.filter((s) => !s.taken);
  const order = free.sort((a, b) => a.index - b.index);
  return order;
}

export function titleOf(place) {
  return place.title ?? place.id;
}
`;

/** Основная ветка чинит ранние строки обеих функций. */
const PRESET_MAIN = PRESET_BASE
  .replace('  const dx = cell.x - place.x;', '  const dx = (cell.x ?? 0) - place.x;')
  .replace('  const seats = layout.seats[desk.id] ?? [];',
    '  const seats = layout.seats[desk.id] ?? layout.seats.default ?? [];');

/** Ветка задачи чинит поздние строки тех же функций — конфликта не будет. */
const PRESET_BRANCH = PRESET_BASE
  .replace('  return { cell, dist };', '  return { cell, dist, id: place.id };')
  .replace('  return order;', '  return order.slice(0, desk.capacity ?? order.length);');

const CHECK = "console.log('сборка чиста');\n";

function fixture(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'office-overlap-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (name: string, body: string) => {
    mkdirSync(dirname(resolve(dir, name)), { recursive: true });
    writeFileSync(resolve(dir, name), body);
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'office@local');
  git('config', 'user.name', 'AI Office');
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { typecheck: 'node check.js' } }));
  write('check.js', CHECK);
  write('shared/preset.ts', PRESET_BASE);
  write('shared/looks.ts', 'export const skins = ["day"];\n');
  git('add', '-A');
  git('commit', '-qm', 'Начало: preset с entryOf и slotsOf');

  // Ветка задачи: чинит обе функции и заводит свой файл.
  git('checkout', '-q', '-b', 'task/T-138', 'main');
  write('shared/preset.ts', PRESET_BRANCH);
  write('web/card.ts', 'export const card = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'T-138: entryOf отдаёт id, slotsOf режет по вместимости');

  // Ветка, которая ни с кем не пересекается: только свой файл.
  git('checkout', '-q', '-b', 'task/T-clean', 'main');
  write('web/panel.ts', 'export const panel = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'T-clean: своя панель');

  // Основная ветка тем временем чинит те же две функции — и свой файл.
  git('checkout', '-q', 'main');
  write('shared/preset.ts', PRESET_MAIN);
  write('shared/looks.ts', 'export const skins = ["day", "night"];\n');
  git('add', '-A');
  git('commit', '-qm', 'main: entryOf терпит пустой x, slotsOf знает про умолчание');
  return dir;
}

async function main(): Promise<void> {
  const dir = fixture();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const results: string[] = [];
  const check = (name: string, ok: boolean) => results.push(`${name}: ${ok}`);

  // 1. Кейс T-138: файл в списке, названы обе функции.
  const edits = await duplicateEdits(dir, 'main', 'task/T-138');
  const preset = edits.find((e) => e.file === 'shared/preset.ts');
  check('файл кейса T-138 попал в список предупреждений', Boolean(preset));
  check('названы обе функции, задетые обеими сторонами',
    Boolean(preset?.symbols.includes('entryOf') && preset?.symbols.includes('slotsOf')));
  check('чужих символов в списке нет', preset?.symbols.includes('titleOf') === false);

  // 3. Односторонние правки шума не создают.
  check('файл только из ветки в список не попал',
    !edits.some((e) => e.file === 'web/card.ts'));
  check('файл только из main в список не попал',
    !edits.some((e) => e.file === 'shared/looks.ts'));
  const clean = await duplicateEdits(dir, 'main', 'task/T-clean');
  check('обычная ветка не даёт ни одного предупреждения', clean.length === 0);

  // 1б. Та же ветка после подтягивания базы (так делает конвейер ревью перед
  //     ревью): git сливает молча, общий предок уезжает — предупреждение
  //     обязано остаться, иначе весь кейс T-138 и пропускается.
  git('checkout', '-q', 'task/T-138');
  const merged = execFileSync('git', ['merge', '--no-edit', 'main'], { cwd: dir, encoding: 'utf8' });
  check('база влилась в ветку без конфликта', !merged.includes('CONFLICT'));
  git('checkout', '-q', 'main');
  const afterSync = await duplicateEdits(dir, 'main', 'task/T-138');
  const presetAfter = afterSync.find((e) => e.file === 'shared/preset.ts');
  check('после подтягивания базы предупреждение осталось', Boolean(presetAfter));
  check('и функции по-прежнему названы',
    Boolean(presetAfter?.symbols.includes('entryOf') && presetAfter?.symbols.includes('slotsOf')));
  check('подтянутая база сама по себе шума не добавила',
    !afterSync.some((e) => e.file === 'shared/looks.ts'));

  // 2. Гейт предупреждает, но сливает.
  const head = git('rev-parse', 'main');
  const gate = await preMergeGate({ repoDir: dir, branch: 'task/T-138', base: 'main' });
  check('гейт зелёный и ветка влита', gate.ok === true && gate.merged === true);
  check('слияние правда произошло', git('rev-parse', 'main') !== head);
  check('предупреждение попало в отчёт гейта',
    gate.overlaps.some((e) => e.file === 'shared/preset.ts'));
  const printed = formatReport(gate, 'ru');
  check('печатный отчёт называет дубль правки и функции',
    printed.includes('Проверь дубль правки')
    && printed.includes('shared/preset.ts')
    && printed.includes('entryOf'));
  check('печатный отчёт всё равно говорит, что слияние прошло', printed.startsWith('✅'));

  // Обычная ветка через гейт: ни одного предупреждения в отчёте.
  const quiet = await preMergeGate({ repoDir: dir, branch: 'task/T-clean', base: 'main', merge: false });
  check('у обычной ветки отчёт молчит про дубли', quiet.overlaps.length === 0
    && !formatReport(quiet, 'ru').includes('дубль'));

  rmSync(defaultIntegrationDir(dir), { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.endsWith('true'));
  for (const r of results) console.log(`  ${r.endsWith('true') ? '✅' : '❌'} ${r}`);
  if (!results.length) {
    console.error('не выполнено ни одной проверки — прогону верить нельзя');
    process.exit(2);
  }
  console.log(failed.length
    ? `ПРОВАЛЕНО: ${failed.length} из ${results.length}`
    : `Все проверки прошли: ${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

void main().catch((err) => {
  console.error(`прогон сорвался: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(2);
});

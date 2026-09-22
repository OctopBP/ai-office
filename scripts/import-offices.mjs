/**
 * Перенос офисов из запуска-из-исходников в приложение.
 *
 * Офис из исходников держит состояние в `.office` рядом с репозиторием, а
 * приложение — в папке данных пользователя. Это две независимые установки, и
 * список офисов у каждой свой; скрипт переносит список из первой во вторую.
 *
 * Копируем, а не подставляем путь на старое место. Два сервера, пишущих в один
 * файл состояния, затирали бы правки друг друга: каждый держит офис в памяти и
 * сбрасывает его целиком. После переноса это две независимые копии одних и тех
 * же офисов — работать надо в одной, иначе разойдутся и доски, и ветки задач.
 *
 *   node scripts/import-offices.mjs             # из ./.office в папку приложения
 *   node scripts/import-offices.mjs --from <dir> --to <dir>
 *   node scripts/import-offices.mjs --dry-run   # только показать, что будет
 *
 * Приложение перед переносом надо закрыть: открытое, оно держит свой список в
 * памяти и перепишет реестр при первом же сохранении.
 *
 * Офис узнаётся по папке проекта. Тот, что в приложении уже есть, скрипт не
 * трогает — повторный запуск ничего не портит и дублей не заводит.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const root = resolve(import.meta.dirname, '..');

/** Папка данных приложения — та же, что у Electron (`app.getPath('userData')`). */
function appOfficeDir() {
  if (process.platform === 'darwin') {
    return resolve(homedir(), 'Library/Application Support/AI Office/office');
  }
  if (process.platform === 'win32') {
    return resolve(process.env.APPDATA ?? resolve(homedir(), 'AppData/Roaming'), 'AI Office/office');
  }
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'), 'AI Office/office');
}

const from = resolve(flag('--from', resolve(root, '.office')));
const to = resolve(flag('--to', appOfficeDir()));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

if (!existsSync(resolve(from, 'offices.json'))) {
  console.error(`Нечего переносить: в ${from} нет offices.json`);
  process.exit(1);
}

const source = readJson(resolve(from, 'offices.json'));
const target = existsSync(resolve(to, 'offices.json'))
  ? readJson(resolve(to, 'offices.json'))
  : { version: 1, currentId: '', seq: 0, offices: [] };

const here = new Set(target.offices.map((o) => resolve(o.projectDir)));
const usedIds = new Set(target.offices.map((o) => o.id));
let seq = Math.max(source.seq ?? 0, target.seq ?? 0);
const freeId = () => {
  do { seq += 1; } while (usedIds.has(`o-${seq}`));
  usedIds.add(`o-${seq}`);
  return `o-${seq}`;
};

const plan = [];
const skipped = [];
for (const office of source.offices) {
  if (here.has(resolve(office.projectDir))) { skipped.push(office); continue; }
  const id = usedIds.has(office.id) ? freeId() : (usedIds.add(office.id), office.id);
  const stateFile = resolve(to, `offices/${id}.json`);
  plan.push({ what: `офис «${office.name}»`, from: resolve(office.stateFile), to: stateFile });
  const icon = resolve(from, `icons/${office.id}.png`);
  if (existsSync(icon)) plan.push({ what: 'иконка офиса', from: icon, to: resolve(to, `icons/${id}.png`) });
  target.offices.push({ ...office, id, stateFile });
}

// Лимиты плана — кеш, а не данные офиса: кладём, только если своего ещё нет.
for (const name of readdirSync(from).filter((f) => /^limits.*\.json$/.test(f))) {
  if (!existsSync(resolve(to, name))) plan.push({ what: 'лимиты плана', from: resolve(from, name), to: resolve(to, name) });
}

target.seq = seq;
if (!target.currentId && target.offices.length) target.currentId = source.currentId || target.offices[0].id;

for (const office of skipped) console.log(`уже есть, пропущен: ${office.name} (${office.projectDir})`);
for (const step of plan) console.log(`${step.what}: ${step.from} → ${step.to}`);
if (!plan.length) {
  console.log('\nпереносить нечего: все офисы уже в приложении');
  process.exit(0);
}
console.log(`\nофисов после переноса: ${target.offices.length}`);
for (const o of target.offices) console.log(`  ${o.id} | ${o.name} | ${o.projectDir}`);

if (dryRun) {
  console.log('\n--dry-run: ничего не скопировано');
  process.exit(0);
}

// Резервная копия — до первой записи: перенос правит реестр, и вернуться к
// тому, что было, человек должен уметь без нас.
if (existsSync(to)) {
  const backup = `${to}.backup-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;
  cpSync(to, backup, { recursive: true });
  console.log(`\nрезервная копия: ${backup}`);
}
for (const step of plan) {
  mkdirSync(dirname(step.to), { recursive: true });
  copyFileSync(step.from, step.to);
}
mkdirSync(to, { recursive: true });
writeFileSync(resolve(to, 'offices.json'), `${JSON.stringify(target, null, 2)}\n`, 'utf8');
console.log('готово. Откройте приложение — офисы будут в списке.');

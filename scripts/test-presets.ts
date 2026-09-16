/**
 * Проверка схемы пресетов и переноса. npm run test:presets
 *
 * Схема — единственное, что стоит между рукописным JSON и сценой, поэтому
 * проверяется не только «правильное принимается», но и «неправильное
 * отвергается»: пропущенная опечатка находится через неделю глазами, а
 * молчаливо проглоченный лишний ключ — не находится вовсе.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  COMPONENT_TYPES, MULTIPLICITY, componentOf, componentsOf, entryOf,
  parsePreset, partName, splitRef,
} from '../src/shared/preset';
import { restSeats, type Catalog, type Layout } from '../src/shared/layout';

const OK = { id: 'thing', title: 'Штука', size: [1, 1], footprint: [0, 0, 1, 1], h: 1, fallback: 'box' };
const preset = (extra: object) => ({ ...OK, components: [], ...extra });

type Case = [what: string, run: () => unknown, expect: 'ok' | 'throw'];

const cases: Case[] = [
  ['пресет без компонентов', () => parsePreset(preset({})), 'ok'],
  ['неизвестный верхний ключ', () => parsePreset(preset({ colour: 'red' })), 'throw'],
  ['id с заглавными', () => parsePreset(preset({ id: 'Thing' })), 'throw'],
  ['пустая подпись', () => parsePreset(preset({ title: '' })), 'throw'],
  ['след из трёх чисел', () => parsePreset(preset({ footprint: [0, 0, 1] })), 'throw'],
  ['чужой fallback', () => parsePreset(preset({ fallback: 'sofa' })), 'throw'],

  ['место-точка', () => parsePreset(preset({
    components: [{ type: 'seat', shape: 'point', at: [0.5, 0.45], use: 'game' }],
  })), 'ok'],
  ['место-точка без координаты', () => parsePreset(preset({
    components: [{ type: 'seat', shape: 'point' }],
  })), 'throw'],
  // Слот-точка с `count` — не безобидный мусор, а признак того, что автор имел
  // в виду ряд вдоль стороны и написал не ту форму.
  ['место-точка с полем ряда', () => parsePreset(preset({
    components: [{ type: 'seat', shape: 'point', at: [0, 0], count: 4 }],
  })), 'throw'],
  ['ряд вдоль стороны', () => parsePreset(preset({
    components: [{ type: 'seat', shape: 'side', side: 'n', count: 4 }],
  })), 'ok'],
  ['кольцо мест', () => parsePreset(preset({
    components: [{ type: 'seat', shape: 'ring', ring: 8, rx: 2.6, ry: 1.5, grow: true }],
  })), 'ok'],
  ['кольцо без радиусов', () => parsePreset(preset({
    components: [{ type: 'seat', shape: 'ring', ring: 8 }],
  })), 'throw'],

  ['две лампы — повторяемый', () => parsePreset(preset({
    components: [{ type: 'lamp', lamp: 'neon' }, { type: 'lamp', lamp: 'warm' }],
  })), 'ok'],
  ['две поверхности — одиночный', () => parsePreset(preset({
    components: [{ type: 'surface', on: 'a' }, { type: 'surface', on: 'b' }],
  })), 'throw'],
  ['два рабочих места — одиночный', () => parsePreset(preset({
    components: [{ type: 'work', at: [0, 0] }, { type: 'work', at: [1, 1] }],
  })), 'throw'],
  // Цвет и сила света принадлежат теме: записанный в пресете цвет означал бы
  // лампу, которая не отличает день от ночи.
  ['абсолютный цвет у лампы', () => parsePreset(preset({
    components: [{ type: 'lamp', lamp: 'warm', color: '#ffffff' }],
  })), 'throw'],
  ['относительная поправка к палитре', () => parsePreset(preset({
    components: [{ type: 'lamp', lamp: 'warm', gain: 1.2 }],
  })), 'ok'],
  ['конус света в пол', () => parsePreset(preset({
    components: [{ type: 'lamp', lamp: 'warm', cone: 50 }],
  })), 'ok'],
  // Половинный угол шире прямого — это уже не конус вниз, а точка.
  ['конус шире прямого угла', () => parsePreset(preset({
    components: [{ type: 'lamp', lamp: 'warm', cone: 120 }],
  })), 'throw'],
];

if (cases.length === 0) {
  console.error('кейсов схемы не найдено — прогону верить нельзя');
  process.exit(2);
}

let failed = 0;
for (const [what, run, expect] of cases) {
  let got: 'ok' | 'throw' = 'ok';
  let note = '';
  try { run(); } catch (e) { got = 'throw'; note = e instanceof Error ? e.message.split('\n')[0] : ''; }
  const ok = got === expect;
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(36)} ${got}${ok ? '' : ` (ждали ${expect}) ${note}`}`);
}

// Незнакомый тип компонента — предупреждение, а не падение: пресет с дверью
// обязан открываться клиентом, который про двери ещё не знает.
const unknown = parsePreset(preset({
  components: [{ type: 'door', swing: 'left' }, { type: 'lamp', lamp: 'warm' }],
}));
const unknownOk = unknown.warnings.length === 1
  && unknown.warnings[0].includes('door')
  && unknown.preset.components.length === 1;
if (!unknownOk) failed += 1;
console.log(`${unknownOk ? '  ok  ' : '  FAIL'} незнакомый тип пропускается: ${JSON.stringify(unknown.warnings)}`);

// Кратность объявлена для каждого типа: тип без строки в реестре разберётся,
// но проверен не будет — а это ровно та молчаливая дыра, ради которой реестр.
const covered = COMPONENT_TYPES.every((t) => MULTIPLICITY[t] === 'one' || MULTIPLICITY[t] === 'many');
if (!covered) failed += 1;
console.log(`${covered ? '  ok  ' : '  FAIL'} кратность объявлена у всех ${COMPONENT_TYPES.length} типов`);

const refs: [string, string | undefined, string][] = [
  ['desk', undefined, 'desk'],
  ['chair/chairDesk', 'chair', 'chairDesk'],
];
for (const [ref, owner, part] of refs) {
  const got = splitRef(ref);
  const ok = got.preset === owner && got.part === part;
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ссылка «${ref}» → ${JSON.stringify(got)}`);
}

const nameOk = partName({ file: 'loungeSofa.glb' }) === 'loungeSofa'
  && partName({ file: 'a.glb', name: 'seat' }) === 'seat';
if (!nameOk) failed += 1;
console.log(`${nameOk ? '  ok  ' : '  FAIL'} имя части: по файлу и явное`);

// Перенос: все настоящие пресеты обязаны разбираться той же схемой. Без этого
// тесты проверяли бы схему на выдуманных данных, а данные — ничем.
const DIR = path.join(process.cwd(), 'design/presets');
const dirs = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((d) => fs.existsSync(path.join(DIR, d, 'preset.json'))) : [];
if (dirs.length === 0) {
  console.error('\nпресетов на диске нет — запустите npm run presets:migrate');
  process.exit(2);
}
let bad = 0;
for (const dir of dirs) {
  try {
    const { preset: p } = parsePreset(JSON.parse(fs.readFileSync(path.join(DIR, dir, 'preset.json'), 'utf8')), dir);
    if (p.id !== dir) throw new Error(`id «${p.id}» ≠ папке`);
  } catch (e) {
    bad += 1;
    console.log(`  FAIL ${dir}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}
if (bad) failed += bad;
console.log(`${bad === 0 ? '  ok  ' : '  FAIL'} разбор ${dirs.length} пресетов с диска`);

// Выборка компонентов: одиночный отдаёт один, повторяемый — все, в порядке
// объявления. Порядок важен: места дивана не взаимозаменяемы — по номеру
// места посадка находит поправку именно этой подушки. Сколько их у дивана,
// проверка не знает нарочно: подушку могут дописать, и это не поломка.
const sofa = parsePreset(JSON.parse(fs.readFileSync(path.join(DIR, 'sofa/preset.json'), 'utf8'))).preset;
const seats = componentsOf(sofa, 'seat');
const declared = sofa.components.filter((c) => c.type === 'seat');
const pickOk = seats.length > 1
  && seats.every((c, i) => c === declared[i])
  && componentOf(sofa, 'seat') === seats[0]
  && componentOf(sofa, 'surface') === undefined;
if (!pickOk) failed += 1;
console.log(`${pickOk ? '  ok  ' : '  FAIL'} выборка компонентов у дивана: мест ${seats.length}`);

/**
 * Номер места переживает дорогу до раскладки.
 *
 * `entryOf` кладёт слоты в порядке компонентов, `restSeats` возвращает места с
 * этим же номером, а по нему посадка (`seatingFor`) берёт поправку занятой
 * подушки. Разъедься эти два порядка — и все сидели бы по поправке первого
 * места, причём молча: картинка осталась бы правдоподобной.
 */
const cat: Catalog = { version: 1, tile: 16, scale: 1, sprites: { sofa: entryOf(sofa) } };
const room = { id: 'test', size: [8, 8], props: [{ sprite: 'sofa', at: [2, 3] }] } as unknown as Layout;
const numbers = restSeats(room, cat).map((s) => s.seat).join(',');
const wanted = seats.map((_, i) => i).join(',');
const seatOk = numbers === wanted;
if (!seatOk) failed += 1;
console.log(`${seatOk ? '  ok  ' : '  FAIL'} номера мест дивана в раскладке: ${numbers || '—'}`);

const total = cases.length + 7 + dirs.length;
console.log(failed === 0 ? `\nвсе ${total} кейсов прошли` : `\nПРОВАЛЕНО: ${failed} из ${total}`);
process.exit(failed === 0 ? 0 : 1);

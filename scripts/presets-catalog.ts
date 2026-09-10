/**
 * Сборка каталога из пресетов и сверка со старым (спека §8, §9 шаг 3).
 *
 * `catalog.json` не исчезает вместе с переносом: его читают и сервер, и
 * плоский рендер через общий `shared/layout.ts`, и переучивать их на папки —
 * отдельная работа, которую незачем мешать с переносом. Но писать в него
 * больше никто не пишет: он собирается здесь из двух источников и только.
 *
 *  - **пресеты** — всё авторское про предмет: след, слоты, проходимость,
 *    подпись (`design/presets/<id>/preset.json`);
 *  - **`art.json`** — всё, что генератор посчитал по пикселям, плюс спрайты,
 *    у которых пресета нет и не будет: тайлы стен и пола, внешности агентов,
 *    служебное (`design/sprites/gen.py`).
 *
 * Границу между ними видно по одному признаку: `art.json` нельзя написать
 * руками — он посчитан; пресет нельзя посчитать — он решён.
 *
 * Без аргументов скрипт не пишет, а сверяет. Во время переноса сверка
 * доказывала, что из старого каталога ничего не потерялось; теперь, когда
 * каталог собран, она отвечает на другой вопрос — не устарел ли он: правку в
 * пресете, забытую пересборку, разъехавшийся размер, пропавший файл модели.
 * Заодно показывает, как от этого поехала сетка проходимости.
 *
 *   npm run presets:catalog          сверить
 *   npm run presets:catalog -- --write   собрать и записать
 */
import fs from 'node:fs';
import path from 'node:path';
import { partName, splitRef } from '../src/shared/preset';
import { isBlocked, passability, type Catalog, type CatalogSprite, type Layout } from '../src/shared/layout';
import { ART, CATALOG, DAY, PRESETS, entryOf, readPresets } from './_presets';
import { writeJson } from './_json';

const LAYOUTS = path.join(process.cwd(), 'design/layouts');

/** Сравнение по значению, независимо от порядка ключей. */
function same(a: unknown, b: unknown): boolean {
  return canon(a) === canon(b);
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object).sort();
    return `{${keys.map((k) => `${k}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Расхождения, которые перенос обязан был внести, и никакие другие.
 *
 * `footprint` раньше был не у всех: у кого его не было, след достраивался по
 * формуле из глубины `d`. Теперь он записан у всех — значение то же самое, но
 * появилось там, где поля не было. `label` был у пяти предметов из сорока
 * двух: остальные подписи дописаны при переносе.
 *
 * Входы (`approach` у слота) — то же самое, только позже: поля не было ни у
 * кого, пока ходьба не научилась спрашивать, с какой стороны заходят на
 * место. Дописанный вход — добавление; пропавший или изменившийся вход —
 * потеря, как и любое другое расхождение слотов.
 *
 * Всё прочее — потеря. Именно на это сверка и смотрит.
 */
function expected(field: string, was: unknown, now: unknown): boolean {
  if ((field === 'footprint' || field === 'label') && was === undefined) return true;
  return field === 'slots' && same(was, stripApproach(now));
}

/** Те же слоты без входов — чем они были до появления поля. */
function stripApproach(slots: unknown): unknown {
  if (!Array.isArray(slots)) return slots;
  return slots.map((slot) => {
    const { approach: _approach, ...rest } = slot as Record<string, unknown>;
    return rest;
  });
}

/**
 * Сетка проходимости до и после.
 *
 * Чистый диф каталога эту поломку не поймал бы, а она самая опасная из
 * возможных. `footprint` читает не только трёхмерная отрисовка, но и
 * `passability`, причём **по другому правилу**: у предмета без `footprint`
 * отрисовка строила след от нижней кромки арта на глубину `d`, а проходимость
 * занимала всю площадь арта. Два правила для одного числа расходились молча —
 * диван рисовался глубиной 1.25 тайла, а перегораживал 1.75.
 *
 * Перенос это расхождение снимает: `footprint` теперь один и записан. Но
 * «снимает расхождение» на языке пользователя значит «мебель стала иначе
 * перегораживать проход», и такое надо показывать числом, а не подразумевать.
 */
function walkDiff(catalog: Catalog, rebuilt: Record<string, CatalogSprite>): string[] {
  const out: string[] = [];
  const merged: Catalog = { ...catalog, sprites: { ...catalog.sprites, ...rebuilt } };
  for (const file of fs.readdirSync(LAYOUTS).sort()) {
    if (!file.endsWith('.json')) continue;
    const layout: Layout = JSON.parse(fs.readFileSync(path.join(LAYOUTS, file), 'utf8'));
    const was = passability(layout, catalog);
    const now = passability(layout, merged);
    let freed = 0;
    let taken = 0;
    for (let y = 0; y < was.rows; y++) {
      for (let x = 0; x < was.cols; x++) {
        const a = isBlocked(was, x, y);
        const b = isBlocked(now, x, y);
        if (a && !b) freed += 1;
        if (!a && b) taken += 1;
      }
    }
    if (freed || taken) out.push(`${file}: освободилось ${freed}, занято ${taken}`);
  }
  return out;
}

function main(): void {
  const write = process.argv.includes('--write');
  const presets = readPresets();
  const catalog: Catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const art: Catalog = JSON.parse(fs.readFileSync(ART, 'utf8'));

  const added: string[] = [];
  const lost: string[] = [];

  for (const [id, preset] of presets) {
    const was = catalog.sprites[id] as unknown as Record<string, unknown> | undefined;
    const now = entryOf(preset) as unknown as Record<string, unknown>;
    if (!was) { lost.push(`${id}: пресет есть, записи в каталоге нет`); continue; }

    for (const field of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (same(was[field], now[field])) continue;
      const line = `${id}.${field}: было ${JSON.stringify(was[field])}, стало ${JSON.stringify(now[field])}`;
      (expected(field, was[field], now[field]) ? added : lost).push(line);
    }
  }

  // Размер — единственное число пресета, посчитанное по пикселям. Проверяем
  // его, а не переписываем: пресет читают руками, и половина рукописного,
  // половина подставленного — файл, которому нельзя верить на глаз.
  for (const [id, preset] of presets) {
    const drawn = art.sprites[id];
    if (drawn && !same(drawn.size, preset.size)) {
      lost.push(`${id}.size: арт даёт ${JSON.stringify(drawn.size)}, в пресете ${JSON.stringify(preset.size)}`);
    }
  }

  // Модели и ссылки на части. Схема их проверить не может: она видит строку
  // «chair/chairDesk», но не знает, есть ли такой пресет и лежит ли в нём файл.
  for (const [id, preset] of presets) {
    for (const part of preset.parts ?? []) {
      if (!fs.existsSync(path.join(PRESETS, id, part.file))) {
        lost.push(`${id}: в папке нет модели ${part.file}`);
      }
    }
    for (const c of preset.components) {
      const ref = c.type === 'seat' || c.type === 'work' || c.type === 'surface' ? c.on : undefined;
      if (!ref) continue;
      const { preset: owner, part } = splitRef(ref);
      const host = owner ? presets.get(owner) : preset;
      if (!host) { lost.push(`${id}: ссылка «${ref}» — нет пресета «${owner}»`); continue; }
      if (!(host.parts ?? []).some((p) => partName(p) === part)) {
        lost.push(`${id}: ссылка «${ref}» — у «${host.id}» нет части «${part}»`);
      }
    }
    // `modelOnly` — утверждение о том, что арта нет и не будет. Проверяемое.
    const hasArt = fs.existsSync(path.join(DAY, `${id}.png`));
    if (!!preset.modelOnly === hasArt) {
      lost.push(preset.modelOnly
        ? `${id}: modelOnly, но арт есть (${id}.png)`
        : `${id}: арта нет, а modelOnly не проставлен`);
    }
  }

  const rebuilt: Record<string, CatalogSprite> = {};
  for (const [id, preset] of presets) rebuilt[id] = entryOf(preset);
  const walk = lost.length ? [] : walkDiff(catalog, rebuilt);

  for (const line of added) console.log(`  + ${line}`);
  for (const line of lost) console.log(`  ПОТЕРЯ ${line}`);
  for (const line of walk) console.log(`  проходимость ${line}`);

  if (write && lost.length === 0) {
    // Не-предметы (тайлы стен и пола, агенты, служебное) берутся из `art.json`
    // как есть: пресетами они не становятся, и всё, что про них известно,
    // генератор посчитал сам.
    //
    // Собирается **с нуля**, а не поверх прежнего каталога: иначе запись,
    // которую перестали производить оба источника, осталась бы в файле
    // навсегда и её никто бы не заметил.
    const sprites: Record<string, CatalogSprite> = {};
    for (const [id, entry] of Object.entries(art.sprites)) {
      if (!presets.has(id)) sprites[id] = entry;
    }
    Object.assign(sprites, rebuilt);
    const sorted = Object.fromEntries(Object.entries(sprites).sort(([a], [b]) => (a < b ? -1 : 1)));
    // Формат теперь свой: у файла один автор, и войны диффов с `gen.py`
    // больше не будет.
    fs.writeFileSync(CATALOG, writeJson({
      version: art.version, tile: art.tile, scale: art.scale, sprites: sorted,
    }));
    console.log(`\nзаписано: ${CATALOG}`);
  }

  console.log(
    `\nпресетов: ${presets.size}, ожидаемых добавлений: ${added.length}, потерь: ${lost.length}`,
  );
  if (walk.length) {
    console.log(
      'сетка проходимости изменилась — это следствие того, что footprint стал\n'
      + 'единым для отрисовки и для проходимости (см. walkDiff). Не потеря, но и\n'
      + 'не пустяк: решение принимается глазами, по офису.',
    );
  }
  if (lost.length) {
    console.log('перенос что-то потерял — смотрите строки «ПОТЕРЯ» выше');
    process.exit(1);
  }
  console.log(write ? 'каталог собран' : 'сверка пройдена');
}

main();

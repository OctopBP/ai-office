/**
 * Сверка списка внешностей с папкой скинов. npm run test:looks
 *
 * Список (`looks.json`) и файлы (`*.png`) лежат рядом, но связаны только
 * именем, и разойтись им ничего не мешает: удалённый руками файл оставляет
 * запись, а положенный руками файл — нет. Запись без файла — агент без
 * текстуры, поэтому это ошибка; файл без записи — просто не предлагается в
 * форме роли, поэтому это предупреждение.
 *
 * Детализированная внешность (`look.model`) текстуры не носит — вместо неё
 * своя модель уровнем выше, в `design/models/characters`; для неё проверяем
 * файл модели, а не png в папке скинов.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseLooks } from '../src/shared/look';

const dir = path.resolve('design/models/characters/skins');
const modelsDir = path.resolve('design/models/characters');
const catalog = JSON.parse(fs.readFileSync('design/sprites/out/catalog.json', 'utf8')) as {
  sprites: Record<string, unknown>;
};

let failed = 0;
const fail = (msg: string) => { failed++; console.log(`✗ ${msg}`); };

let looks;
try {
  looks = parseLooks(JSON.parse(fs.readFileSync(path.join(dir, 'looks.json'), 'utf8')));
} catch (e) {
  fail(String(e));
  process.exit(1);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4));
for (const look of looks) {
  if (look.model) {
    if (!fs.existsSync(path.join(modelsDir, look.model))) fail(`«${look.id}»: нет файла модели ${look.model}`);
  } else if (!files.includes(look.id)) {
    fail(`«${look.id}»: нет файла ${look.id}.png`);
  }
  if (!catalog.sprites[look.sprite]) fail(`«${look.id}»: спрайта ${look.sprite} нет в каталоге`);
  for (const lang of ['ru', 'en'] as const) {
    if (!look.title[lang]) console.log(`! «${look.id}»: нет подписи ${lang} — покажется имя файла`);
  }
}
for (const f of files) {
  if (!looks.some((l) => l.id === f)) console.log(`! ${f}.png есть в папке, но не в списке — в форме роли не показывается`);
}

console.log(failed ? `\n${failed} ошибок` : `\nвнешностей: ${looks.length}, файлов: ${files.length} — ок`);
process.exit(failed ? 1 : 0);

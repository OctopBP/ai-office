/* Проверка контраста токенов: читает src/web/styles/tokens.css, собирает обе темы
   (светлую day и тёмную night) и считает контраст по формуле WCAG 2.2 для пар
   «цвет текста на фоне», которые реально используются как текст.
   Обычный текст — не ниже 4.5:1, крупный текст и элементы интерфейса — не ниже 3:1.
   Падает с ненулевым кодом и перечнем нарушителей. Запуск: npm run test:contrast.

   Новая текстовая пара в вёрстке — добавьте её в PAIRS, иначе проверка о ней не узнает. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(ROOT, 'src/web/styles/tokens.css');

type Rgba = { r: number; g: number; b: number; a: number };
type Theme = 'day' | 'night';

/* ---------- разбор CSS ---------- */

/** Тело блока по селектору — от `{` до парной `}` (вложенности в токенах нет). */
function block(css: string, selector: string): string {
  const at = css.indexOf(selector + ' {');
  if (at < 0) throw new Error(`В tokens.css нет блока «${selector}»`);
  const start = css.indexOf('{', at) + 1;
  return css.slice(start, css.indexOf('}', start));
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim().replace(/\s+/g, ' '));
  return out;
}

const css = readFileSync(TOKENS, 'utf8');
const shared = declarations(block(css, ':root'));
const themes: Record<Theme, Map<string, string>> = {
  day: new Map([...shared, ...declarations(block(css, ":root, [data-theme='day']"))]),
  night: new Map(),
};
themes.night = new Map([...themes.day, ...declarations(block(css, "[data-theme='night']"))]);

/* ---------- цвет ---------- */

function parseColor(raw: string): Rgba {
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const fn = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const p = fn[1].split(',').map((s) => parseFloat(s));
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  }
  throw new Error(`Не умею разбирать цвет «${raw}»`);
}

/** Значение токена в теме с раскрытием var(--другой-токен). */
function resolve(theme: Theme, name: string, depth = 0): Rgba {
  if (depth > 8) throw new Error(`Цикл в токенах у ${name}`);
  const raw = themes[theme].get(name);
  if (raw === undefined) throw new Error(`Токена ${name} нет в теме ${theme}`);
  const ref = raw.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(theme, ref[1], depth + 1) : parseColor(raw);
}

/** Полупрозрачный верхний слой поверх непрозрачного нижнего. */
function over(top: Rgba, under: Rgba): Rgba {
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: Rgba, bg: Rgba): number {
  const a = luminance(over(fg, bg));
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ---------- пары ---------- */

/** Фон: токен или «плёнка поверх токена» (`film-2@surface`). */
type Bg = string;

interface Pair {
  fg: string;
  bgs: Bg[];
  /** 4.5 — обычный текст, 3 — крупный текст и элементы интерфейса. */
  min: 4.5 | 3;
  /** Где используется — для сообщения об ошибке. */
  where: string;
  themes?: Theme[];
}

const PAGE: Bg[] = ['surface', 'canvas', 'film@surface', 'film-2@surface'];
const ACCENTS = [1, 2, 3, 4, 5, 6, 7, 8];

const PAIRS: Pair[] = [
  { fg: '--ink', bgs: PAGE, min: 4.5, where: 'заголовки и названия' },
  { fg: '--ink-2', bgs: PAGE, min: 4.5, where: 'основной текст' },
  { fg: '--ink-3', bgs: PAGE, min: 4.5, where: 'второстепенный текст' },
  { fg: '--ink-4', bgs: ['surface', 'canvas', 'film-2@surface'], min: 4.5, where: 'подписи, хлебные крошки, номера строк' },
  { fg: '--warn-ink', bgs: ['surface', 'canvas', 'film@surface'], min: 4.5, where: 'предупреждающие слова и чипы' },
  { fg: '--ok-ink', bgs: ['surface', 'canvas', 'film@surface'], min: 4.5, where: 'слова «готово», «в сети»' },
  { fg: '--danger', bgs: ['surface', 'canvas'], min: 3, where: 'ошибки (значок и крупная подпись)' },
  { fg: '--danger-ink', bgs: ['danger'], min: 4.5, where: 'счётчик на красной заливке' },
  { fg: '--accent-ink', bgs: ['accent'], min: 4.5, where: 'текст на акцентной кнопке' },
  { fg: '--accent', bgs: ['surface', 'canvas'], min: 3, where: 'акцент как элемент интерфейса' },
  // Код роли на бейдже — две жирные заглавные буквы в значке, а не строка текста:
  // для них порог крупного текста и элементов интерфейса, 3:1.
  ...ACCENTS.map((n): Pair => ({
    fg: `--accent-${n}-ink`, bgs: [`accent-${n}`], min: 3, where: `код роли на бейдже цвета ${n}`,
  })),
  { fg: '--accent-muted-ink', bgs: ['accent-muted'], min: 3, where: 'бейдж без цвета роли' },

  // Доска задач: шапка, колонка и чип у неё свои фоны.
  { fg: '--board-title', bgs: ['board-plate', 'board-col', 'board-chip'], min: 4.5, where: 'название фичи и задачи' },
  { fg: '--board-col-name', bgs: ['board-col', 'board-plate'], min: 4.5, where: 'имя колонки' },
  { fg: '--board-drop', bgs: ['board-plate', 'board-col'], min: 4.5, where: 'счётчик снятых задач' },
  { fg: '--board-money', bgs: ['board-plate', 'board-col'], min: 4.5, where: 'деньги фичи' },
];

/** Подставляет в имя токена-фона `--`, считает цвет в теме. */
function bgColor(theme: Theme, spec: Bg): Rgba {
  const [top, under] = spec.split('@');
  const topColor = resolve(theme, '--' + top);
  return under ? over(topColor, resolve(theme, '--' + under)) : over(topColor, resolve(theme, '--surface'));
}

/* ---------- прогон ---------- */

let checked = 0;
const failures: string[] = [];
for (const theme of ['day', 'night'] as Theme[]) {
  for (const p of PAIRS) {
    if (p.themes && !p.themes.includes(theme)) continue;
    const fg = resolve(theme, p.fg);
    for (const bg of p.bgs) {
      checked++;
      const ratio = contrast(fg, bgColor(theme, bg));
      if (ratio < p.min) {
        failures.push(
          `  [${theme}] ${p.fg} на ${bg}: ${ratio.toFixed(2)}:1, нужно ≥ ${p.min}:1  (${p.where})`,
        );
      }
    }
  }
}

if (failures.length) {
  console.error(`Контраст ниже порога WCAG AA в ${failures.length} парах из ${checked}:\n`);
  console.error(failures.join('\n'));
  console.error('\nПоправьте значение токена в src/web/styles/tokens.css или смените токен у места использования.');
  process.exit(1);
}
console.log(`Контраст: ${checked} пар в двух темах (day, night) проходят WCAG AA.`);

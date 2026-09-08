/**
 * Дублирующие правки: что после точки ветвления правили И основная ветка, И
 * ветка задачи.
 *
 * Урок T-138 (журнал офиса): main и ветка независимо чинили одно и то же место
 * в `shared/preset.ts` — функции `entryOf` и `slotsOf`. Конфликта не было:
 * правки лежали в разных строках, git слил их молча, а слитое дерево оказалось
 * красным. Конфликт git видит по строкам; здесь мы смотрим шире — по файлам и
 * по символам внутри них.
 *
 * Это предупреждение, а не запрет: две правки одного места чаще всего
 * законны (кто-то подтянул базу), но именно они разъезжаются тихо. Поэтому
 * список печатается, ничего не блокируя.
 *
 * Символы достаём сами, а не через `git diff --function-context`: заголовки
 * ханков git берёт из своих драйверов языков, а для TypeScript такого драйвера
 * нет — эвристика «строка без отступа» назвала бы `export function` целиком,
 * вместе с сигнатурой, и не увидела бы методов класса.
 */
import type { Lang } from '../shared/i18n';
import { t } from './i18n';
import { git } from './git';

/** Один файл, который правили обе стороны. */
export interface DuplicateEdit {
  file: string;
  /**
   * Символы (функции, классы, константы), которые задели и там, и там.
   * Пусто — совпал только файл: правки в разных его местах.
   */
  symbols: string[];
}

/** Файл длиннее этого разбирать на символы не будем: это данные, а не код. */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Файлы, которые после точки ветвления правили обе стороны, — и символы,
 * задетые обеими. Пусто — пересечения нет: обычная ветка шума не создаёт.
 *
 * Сравниваются не «база и ветка целиком», а своё каждой стороны: иначе в
 * список попали бы файлы, которые ветка всего лишь получила вместе с
 * подтянутой базой.
 */
export async function duplicateEdits(
  repoDir: string, base: string, branch: string,
): Promise<DuplicateEdit[]> {
  // Своё ветки — всё, что она добавила к общему предку. Общий предок берётся
  // текущий: если базу уже подтянули в ветку (так делает конвейер ревью перед
  // ревью), он равен вершине базы, и в дифф попадает ровно работа ветки, без
  // чужих коммитов, которые она в себя влила.
  const mergeBase = await git(repoDir, ['merge-base', base, branch]);
  if (!mergeBase.ok || !mergeBase.stdout) return [];
  const branchFrom = mergeBase.stdout;
  // Своё базы считаем от НАСТОЯЩЕЙ точки ветвления — той, где ветка началась.
  // После подтягивания базы общий предок уезжает на её вершину, и «что успела
  // сделать основная ветка» по нему уже не увидеть: ровно этот случай и был
  // в T-138.
  const baseFrom = (await forkPoint(repoDir, base, branch)) ?? branchFrom;

  const baseFiles = await changedFiles(repoDir, baseFrom, base);
  if (!baseFiles.length) return [];
  const branchFiles = await changedFiles(repoDir, branchFrom, branch);
  const common = branchFiles.filter((f) => baseFiles.includes(f));
  if (!common.length) return [];

  const found: DuplicateEdit[] = [];
  for (const file of common) {
    const onBase = await touchedSymbols(repoDir, baseFrom, base, file);
    const onBranch = await touchedSymbols(repoDir, branchFrom, branch, file);
    found.push({ file, symbols: onBase.filter((s) => onBranch.includes(s)) });
  }
  return found;
}

/**
 * Коммит, от которого ветка отошла: родитель её самого раннего собственного
 * коммита. Именно он, а не общий предок, отделяет «что успела сделать основная
 * ветка» от «что ветка влила в себя из основной».
 * null — понять не удалось (ветка без своих коммитов, корневой коммит,
 * найденный родитель уже не в истории базы).
 */
async function forkPoint(repoDir: string, base: string, branch: string): Promise<string | null> {
  const own = await git(repoDir, [
    'rev-list', '--topo-order', '--reverse', '--no-merges', `${base}..${branch}`,
  ]);
  const first = own.ok ? own.stdout.split('\n')[0]?.trim() : '';
  if (!first) return null;
  const parent = await git(repoDir, ['rev-parse', '--verify', `${first}^`]);
  if (!parent.ok || !parent.stdout) return null;
  const inBase = await git(repoDir, ['merge-base', '--is-ancestor', parent.stdout, base]);
  return inBase.ok ? parent.stdout : null;
}

/** Что изменилось между двумя ревизиями. Удалённые файлы тоже считаются правкой. */
async function changedFiles(repoDir: string, from: string, to: string): Promise<string[]> {
  const r = await git(repoDir, [
    '-c', 'core.quotepath=false', 'diff', '--name-only', from, to,
  ]);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Контекста берём столько, что в дифф уезжает файл целиком. Так одним вызовом
 * git получаем и правленые строки, и содержимое стороны, — а заодно обходим
 * подрезку краёв, которую делает `git()`: у строк диффа есть служебный первый
 * символ, и пустая строка в начале файла не пропадает вместе с нумерацией.
 */
const WHOLE_FILE = 1_000_000;

/**
 * Какие символы файла задела правка одной стороны. Строки двух сторон между
 * собой несравнимы (одна и та же функция лежит на разных номерах) — поэтому
 * номера сразу переводятся в имена по содержимому этой стороны.
 */
async function touchedSymbols(
  repoDir: string, from: string, to: string, file: string,
): Promise<string[]> {
  const diff = await git(repoDir, [
    'diff', `-U${WHOLE_FILE}`, '--no-color', from, to, '--', file,
  ]);
  // Двоичный файл или слишком большой — символов не назвать, но файл в списке
  // останется: правка-то была.
  if (!diff.ok || !diff.stdout || diff.stdout.length > MAX_FILE_BYTES) return [];

  const lines: string[] = [];
  const changed: number[] = [];
  let lineNo = 0;
  for (const raw of diff.stdout.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) { lineNo = Number(header[1]); continue; }
    if (!lineNo) continue;                      // шапка диффа до первого ханка
    if (raw.startsWith('\\')) continue;         // «\ No newline at end of file»
    // Удалённая строка на этой стороне не существует: её место — стык, то есть
    // ближайшая следующая строка.
    if (raw.startsWith('-')) { changed.push(lineNo); continue; }
    if (!raw.startsWith('+') && !raw.startsWith(' ')) continue;
    if (raw.startsWith('+')) changed.push(lineNo);
    while (lines.length < lineNo - 1) lines.push('');
    lines.push(raw.slice(1));
    lineNo += 1;
  }
  if (!changed.length) return [];

  const regions = symbolRegions(lines.join('\n'));
  if (!regions.length) return [];
  const names: string[] = [];
  for (const line of changed) {
    const name = symbolAt(regions, line);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Символ файла и строки, которые ему принадлежат (обе границы включительно). */
export interface SymbolRegion {
  name: string;
  /** Отступ объявления: по нему считается вложенность. */
  indent: number;
  start: number;
  end: number;
}

/** Объявление: функция, класс, тип, константа, `def` питона. */
const DECLARATION =
  /^(\s*)(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\s*\*?|class|interface|type|enum|const|let|var|def)\s+([A-Za-z_$][\w$]*)/;

/**
 * Объявления, внутри которых лежат другие символы: у класса есть методы,
 * у типа — поля. У функции внутри лежит её собственная кухня — локальные
 * `const`, и символами они не считаются: иначе «обе стороны правили entryOf»
 * распалось бы на «одна правила dx, другая dist», и общего не нашлось бы.
 */
const CONTAINERS = new Set(['class', 'interface', 'enum', 'type']);

/**
 * Метод класса или объекта: `run(ctx) {`, `async merge(a, b): Promise<void> {`,
 * а также многострочная сигнатура, у которой строка кончается открытой скобкой.
 * Требование «строка кончается `{` или `(`» отсекает обычные вызовы функций.
 */
const METHOD =
  /^(\s*)(?:(?:public|private|protected|static|readonly|abstract|async|get|set|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\(/;

/** Слова, за которыми идёт скобка, но методами они не являются. */
const NOT_A_NAME = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new',
  'delete', 'void', 'yield', 'throw', 'do', 'else', 'with', 'super', 'import',
  'export', 'function', 'constructor', 'require', 'print', 'assert',
]);

const indentOf = (line: string): number => (/^(\s*)/.exec(line)?.[1].length ?? 0);

/**
 * Разбор файла на символы. Не парсер языка, а та же эвристика, которой git
 * подписывает ханки, только аккуратнее: имя берётся из объявления, а конец
 * области — по первому, что случится раньше: следующее объявление того же или
 * меньшего уровня либо закрывающая скобка на уровне объявления.
 */
export function symbolRegions(text: string): SymbolRegion[] {
  const lines = text.split('\n');
  const regions: SymbolRegion[] = [];
  // Что сейчас открыто вокруг строки: по стопке видно, лежим ли мы в теле
  // функции (там объявления не в счёт) или в классе (там — в счёт).
  const open: Array<{ indent: number; container: boolean }> = [];
  const record = (name: string, indent: number, line: number, container: boolean): void => {
    while (open.length && open[open.length - 1].indent >= indent) open.pop();
    if (open.length && !open[open.length - 1].container) return;
    regions.push({ name, indent, start: line, end: lines.length });
    open.push({ indent, container });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s*(?:\/\/|\*|\/\*|#)/.test(line)) continue;
    const decl = DECLARATION.exec(line);
    if (decl) {
      record(decl[3], decl[1].length, i + 1, CONTAINERS.has(decl[2]));
      continue;
    }
    const method = METHOD.exec(line);
    if (method && !NOT_A_NAME.has(method[2]) && /(?:\{|\()\s*$/.test(line)) {
      record(method[2], method[1].length, i + 1, false);
    }
  }

  // Комментарий над объявлением принадлежит объявлению. Правка одного только
  // описания функции — это правка её места: в кейсе T-138 ветка правила ровно
  // комментарии над `entryOf` и `slotsOf`, которые основная ветка перед этим
  // завела целиком, и без этого правила общего у сторон бы не нашлось.
  for (const region of regions) {
    let line = region.start - 1;
    while (line >= 1 && /^\s*(?:\/\/|\*|\/\*|#)/.test(lines[line - 1])) line -= 1;
    region.start = line + 1;
  }

  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i];
    const next = regions.slice(i + 1).find((r) => r.indent <= region.indent);
    if (next) region.end = next.start - 1;
    // Закрывающая скобка на уровне объявления — конец тела; сама строка
    // ещё принадлежит символу.
    for (let line = region.start; line <= Math.min(region.end, lines.length); line += 1) {
      const raw = lines[line - 1];
      if (line > region.start && /^\s*[)}\]]/.test(raw) && indentOf(raw) <= region.indent) {
        region.end = line;
        break;
      }
    }
  }
  return regions;
}

/** Самый внутренний символ, которому принадлежит строка. null — вне символов. */
export function symbolAt(regions: SymbolRegion[], line: number): string | null {
  let found: SymbolRegion | null = null;
  for (const region of regions) {
    if (region.start > line) break;
    if (line <= region.end && (!found || region.start >= found.start)) found = region;
  }
  return found ? found.name : null;
}

/** Сколько символов одного файла называем вслух: остальное только считаем. */
const MAX_SYMBOLS = 6;
/** И сколько файлов. Список на сто строк в ленте офиса читать всё равно никто не станет. */
const MAX_FILES = 12;

/** Файл со списком общих символов: `src/shared/preset.ts (entryOf, slotsOf)`. */
export function formatOverlapFile(edit: DuplicateEdit, lang: Lang): string {
  if (!edit.symbols.length) return edit.file;
  const shown = edit.symbols.slice(0, MAX_SYMBOLS);
  const rest = edit.symbols.length - shown.length;
  return t(lang, 'overlap.file', {
    file: edit.file,
    symbols: shown.join(', ') + (rest ? t(lang, 'overlap.more', { n: String(rest) }) : ''),
  });
}

/** Весь список файлов одной строкой, с ограничением по длине. */
export function formatOverlapFiles(edits: DuplicateEdit[], lang: Lang): string {
  const shown = edits.slice(0, MAX_FILES);
  const rest = edits.length - shown.length;
  return shown.map((e) => formatOverlapFile(e, lang)).join('; ')
    + (rest ? t(lang, 'overlap.moreFiles', { n: String(rest) }) : '');
}

/**
 * Предупреждение целиком — одной фразой для отчёта, ленты офиса и лога.
 * Пустой список — пустая строка: молчание тоже сообщение.
 */
export function formatOverlaps(
  edits: DuplicateEdit[], base: string, branch: string, lang: Lang,
): string {
  if (!edits.length) return '';
  return t(lang, 'overlap.warning', {
    base, branch, files: formatOverlapFiles(edits, lang),
  });
}

/** Строка построчного сравнения: общая, удалённая из старого текста или добавленная в новый. */
export interface DiffLine {
  kind: 'same' | 'del' | 'add';
  text: string;
}

/**
 * Предел таблицы LCS (строк старого × строк нового в изменённой середине).
 * Выше — середина считается заменённой целиком: сравнение грубее, зато окно
 * не встаёт на огромном документе.
 */
const LCS_LIMIT = 4_000_000;

const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n'));

/**
 * Построчный дифф `before` → `after` по наибольшей общей подпоследовательности.
 * Общие начало и конец отрезаются заранее — обычная правка трогает несколько
 * строк, и таблица остаётся маленькой.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ kind: 'same', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  return [...head, ...diffMiddle(midA, midB), ...tail];
}

function diffMiddle(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n * m > LCS_LIMIT) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'del', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text })),
    ];
  }
  // lcs[i][j] — длина общей подпоследовательности хвостов a[i..] и b[j..].
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j]
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({ kind: 'del', text: a[i++] });
    else out.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

/** Сколько строк добавлено и удалено — для подписи «+12 −3». */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}

/**
 * Запись JSON, пригодная для чтения человеком и для дифа в гите.
 *
 * `JSON.stringify` с отступом разносит `[0, 0, 0]` на пять строк, и пресет из
 * двадцати содержательных чисел растягивается на полторы сотни строк, в
 * которых ничего не видно. Короткие массивы простых значений — координата,
 * габарит, след — пишутся в строку; всё остальное разносится как обычно.
 */
export function writeJson(value: unknown, indent = 2): string {
  return `${fmt(value, indent, 0)}\n`;
}

function inline(v: unknown): boolean {
  return Array.isArray(v)
    && v.length <= 4
    && v.every((x) => typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean');
}

function fmt(v: unknown, indent: number, depth: number): string {
  const pad = ' '.repeat(indent * depth);
  const inner = ' '.repeat(indent * (depth + 1));
  if (inline(v)) return `[${(v as unknown[]).map((x) => JSON.stringify(x)).join(', ')}]`;
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[\n${v.map((x) => inner + fmt(x, indent, depth + 1)).join(',\n')}\n${pad}]`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object);
    if (keys.length === 0) return '{}';
    const body = keys
      .map((k) => `${inner}${JSON.stringify(k)}: ${fmt((v as Record<string, unknown>)[k], indent, depth + 1)}`)
      .join(',\n');
    return `{\n${body}\n${pad}}`;
  }
  return JSON.stringify(v);
}

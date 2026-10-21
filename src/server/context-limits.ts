/**
 * Пороги постоянного контекста роли и разбор описания скила — без офиса и
 * без ролей. Отдельно от context-budget.ts, чтобы валидатор пакета
 * (packages.ts) мог мерить пакет, не втягивая журнал, правила и состояние
 * офиса: те сами зависят от пакетов, и вышел бы круг импортов.
 */

/** Порог по умолчанию — как `always_on_max` в harness2. */
export const DEFAULT_ALWAYS_ON_MAX = 24_000;

/**
 * Описание скила короче этого — «слишком общее»: по нему модель не поймёт,
 * когда скил открывать, и либо не откроет его вовсе, либо будет открывать зря.
 */
export const MIN_SKILL_DESCRIPTION = 40;

/**
 * Действующий порог: переменная `OFFICE_ALWAYS_ON_MAX`, затем настройка офиса
 * `alwaysOnMax`, затем 24 000. Негодное значение (не целое, ноль, меньше
 * нуля) пропускается, а не обнуляет порог.
 */
export function alwaysOnMax(setting?: number | null, env = process.env.OFFICE_ALWAYS_ON_MAX): number {
  for (const raw of [env, setting]) {
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_ALWAYS_ON_MAX;
}

/**
 * Описание скила из заголовка SKILL.md: `description:` одной строкой, в
 * кавычках или блоком YAML (`|`, `>`) с отступом. Нет заголовка или поля —
 * пустая строка: такой скил модель видит без пояснения, и это тоже находка.
 */
export function skillDescription(text: string): string {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.slice(0, 8000))?.[1];
  if (!head) return '';
  const lines = head.split(/\r?\n/);
  const at = lines.findIndex((line) => /^description:/.test(line));
  if (at < 0) return '';
  const first = lines[at].slice('description:'.length).trim();
  if (first && !/^[|>][-+]?$/.test(first)) return first.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  // Блок: строки с отступом под полем, до первой без отступа.
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    body.push(line.trim());
  }
  return body.join(first.startsWith('|') ? '\n' : ' ').trim();
}

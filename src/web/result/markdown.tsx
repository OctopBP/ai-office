/**
 * Markdown → элементы React.
 *
 * Свой разбор, а не библиотека и не `dangerouslySetInnerHTML`: файл написал
 * агент, и любой сырой HTML из него — это чужой код в окне офиса. Здесь
 * текст всегда остаётся текстом: React сам экранирует строки, а теги из
 * документа показываются буквами. Покрыт обычный для docs/ набор —
 * заголовки, абзацы, списки (с вложенностью и галочками), цитаты, код,
 * таблицы, черта, ссылки и выделение. Чего нет — остаётся как написано,
 * исходник всегда под переключателем.
 */
import type { ReactNode } from 'react';

// ------------------------------------------------------------ строчная разметка

/** Ссылку делаем ссылкой только на внешний адрес: `javascript:` и относительные пути в окне офиса ни к чему. */
const safeHref = (url: string): string | null => (/^(https?:|mailto:)/i.test(url.trim()) ? url.trim() : null);

/**
 * Первое совпадение любой строчной конструкции. Порядок альтернатив важен:
 * код раньше всего (внутри него разметки нет), картинка раньше ссылки,
 * двойные звёздочки раньше одинарных.
 */
const INLINE = new RegExp([
  '(`+)([\\s\\S]*?[^`])\\1(?!`)', // 1,2 — код
  '!\\[([^\\]]*)\\]\\(([^)\\s]*)(?:\\s+"[^"]*")?\\)', // 3,4 — картинка
  '\\[([^\\]]+)\\]\\(([^)\\s]*)(?:\\s+"[^"]*")?\\)', // 5,6 — ссылка
  '<((?:https?:|mailto:)[^>\\s]+)>', // 7 — автоссылка
  '\\*\\*([\\s\\S]+?)\\*\\*|__([\\s\\S]+?)__', // 8,9 — жирный
  '~~([\\s\\S]+?)~~', // 10 — зачёркнутый
  '\\*([^*\\s](?:[\\s\\S]*?[^*\\s])?)\\*|\\b_([^_\\s](?:[\\s\\S]*?[^_\\s])?)_\\b', // 11,12 — курсив
  '(https?://[^\\s<>()]+[^\\s<>().,;:!?\'"])', // 13 — голый адрес
].join('|'));

function link(href: string | null, children: ReactNode, key: string): ReactNode {
  if (!href) return <span key={key}>{children}</span>;
  return <a key={key} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}

export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const k = `${key}.${n++}`;
    if (m[2] !== undefined) out.push(<code key={k}>{m[2].replace(/^ (.+) $/, '$1')}</code>);
    // Картинку из документа не грузим: внешний адрес — утечка того, что
    // владелец открыл файл, а относительный путь из окна офиса не сработает.
    else if (m[4] !== undefined) out.push(link(safeHref(m[4]), `🖼 ${m[3] || m[4]}`, k));
    else if (m[6] !== undefined) out.push(link(safeHref(m[6]), inline(m[5], k), k));
    else if (m[7] !== undefined) out.push(link(safeHref(m[7]), m[7], k));
    else if (m[8] !== undefined || m[9] !== undefined) out.push(<strong key={k}>{inline(m[8] ?? m[9], k)}</strong>);
    else if (m[10] !== undefined) out.push(<del key={k}>{inline(m[10], k)}</del>);
    else if (m[11] !== undefined || m[12] !== undefined) out.push(<em key={k}>{inline(m[11] ?? m[12], k)}</em>);
    else if (m[13] !== undefined) out.push(link(safeHref(m[13]), m[13], k));
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Абзац: одиночный перевод строки — пробел, два пробела или `\` в конце — разрыв. */
function paragraphInline(lines: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    const hard = / {2,}$|\\$/.test(line);
    const clean = line.replace(/ {2,}$|\\$/, '').trim();
    out.push(...inline(clean, `${key}.${i}`));
    if (i < lines.length - 1) out.push(hard ? <br key={`${key}.br${i}`} /> : ' ');
  });
  return out;
}

// ------------------------------------------------------------ блоки

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.match(/^\s*/)![0].replace(/\t/g, '    ').length;

function cells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Начинает ли строка другой блок — тогда абзац на ней кончается. */
function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line)
    || (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'));
}

function list(lines: string[], start: number, key: string): { node: ReactNode; end: number } {
  const first = ITEM.exec(lines[start])!;
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const m = ITEM.exec(line);
    if (m && indentOf(m[1]) === base && /\d/.test(m[2]) === ordered) {
      items.push([m[3]]);
      continue;
    }
    if (!line.trim()) {
      // Пустая строка внутри списка: список продолжается, если дальше снова
      // отступ или пункт того же уровня.
      const next = lines[i + 1];
      if (next !== undefined && (indentOf(next) > base || ITEM.test(next) && indentOf(ITEM.exec(next)![1]) === base)) {
        items[items.length - 1].push('');
        continue;
      }
      break;
    }
    // Продолжение пункта — строка с отступом глубже маркера или ленивое
    // продолжение абзаца без отступа.
    if (indentOf(line) > base || !startsBlock(line, lines[i + 1])) {
      items[items.length - 1].push(line.slice(Math.min(indentOf(line), base + 2)));
      continue;
    }
    break;
  }
  const start0 = ordered ? Number.parseInt(first[2], 10) : undefined;
  const children = items.map((body, j) => {
    const task = /^\[([ xX])\]\s+/.exec(body[0]);
    if (task) body[0] = body[0].slice(task[0].length);
    const inner = blocks(body, `${key}.${j}`, true);
    return (
      <li key={j} className={task ? 'md-task' : undefined}>
        {task && <input type="checkbox" checked={task[1] !== ' '} readOnly disabled />}
        {inner}
      </li>
    );
  });
  const node = ordered
    ? <ol key={key} start={start0 !== 1 ? start0 : undefined}>{children}</ol>
    : <ul key={key}>{children}</ul>;
  return { node, end: i };
}

/**
 * Разобрать строки в блоки. `tight` — содержимое пункта списка: одиночный
 * абзац там идёт без `<p>`, чтобы между пунктами не было лишних отступов.
 */
function blocks(lines: string[], key: string, tight = false): ReactNode[] {
  const out: ReactNode[] = [];
  let paragraphs = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const k = `${key}.${out.length}`;
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(<pre key={k} className="md-code"><code>{body.join('\n')}</code></pre>);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const H = `h${heading[1].length}` as 'h1';
      out.push(<H key={k}>{inline(heading[2], k)}</H>);
      i++;
      continue;
    }

    if (HR.test(line)) { out.push(<hr key={k} />); i++; continue; }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1]))) {
        body.push(lines[i++].replace(QUOTE, ''));
      }
      out.push(<blockquote key={k}>{blocks(body, k)}</blockquote>);
      continue;
    }

    if (ITEM.test(line)) {
      const { node, end } = list(lines, i, k);
      out.push(node);
      i = end;
      continue;
    }

    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-')) {
      const head = cells(line);
      const align = cells(next).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : c.startsWith(':') ? 'left' : undefined));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      out.push(
        <div key={k} className="md-table">
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j} style={{ textAlign: align[j] }}>{inline(c, `${k}.h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] }}>{inline(row[j] ?? '', `${k}.${r}.${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && (body.length === 0 || !startsBlock(lines[i], lines[i + 1]))) {
      body.push(lines[i++]);
    }
    paragraphs++;
    out.push(<p key={k}>{paragraphInline(body, k)}</p>);
  }
  // Пункт списка из одного абзаца — просто строка.
  if (tight && paragraphs === 1 && out.length >= 1) {
    const first = out[0] as { type?: unknown; props?: { children?: ReactNode } };
    if (first?.type === 'p') out[0] = <span key={`${key}.t`}>{first.props?.children}</span>;
  }
  return out;
}

/** Отрисованный документ. Шапку YAML (`---` … `---` в начале) не показываем — это служебное. */
export function Markdown({ source }: { source: string }) {
  let text = source.replace(/\r\n?/g, '\n');
  const front = /^---\n[\s\S]*?\n---\n/.exec(text);
  if (front) text = text.slice(front[0].length);
  return <div className="md">{blocks(text.split('\n'), 'md')}</div>;
}

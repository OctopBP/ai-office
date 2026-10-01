/**
 * Markdown → элементы React. Общий для просмотра документов, заметок к
 * выпуску и ленты чата.
 *
 * Свой разбор, а не библиотека и не `dangerouslySetInnerHTML`: текст написал
 * агент, и любой сырой HTML из него — это чужой код в окне офиса. Здесь
 * текст всегда остаётся текстом: React сам экранирует строки, а теги из
 * документа показываются буквами. Покрыт обычный для docs/ набор —
 * заголовки, абзацы, списки (с вложенностью и галочками), цитаты, код,
 * таблицы, черта, ссылки и выделение. Чего нет — остаётся как написано,
 * исходник всегда под переключателем.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { highlight } from './codeHighlight';
import { t } from './i18n';
import { Icon } from './icons';
import { useStore } from './store';

// ------------------------------------------------------------ строчная разметка

/** Ссылка на другой чат с менеджером: `[Название](chat:<id>)`. */
const CHAT_HREF = /^chat:(\S+)$/i;

/**
 * Чип ссылки на чат. Не `<a href>`: схема `chat:` — адрес внутри офиса, и
 * браузер переходить по ней не должен. Название берём из стора, а не из
 * текста ссылки: чат могли переименовать после того, как реплику написали.
 * Удалённый чат остаётся на месте приглушённым — текст реплики не должен
 * «проседать» оттого, что цели больше нет.
 */
function ChatLink({ id, label }: { id: string; label: ReactNode }) {
  const title = useStore((s) => s.pmChats[id]?.title);
  const found = title !== undefined;
  const go = (e: MouseEvent | KeyboardEvent) => {
    // Реплика и карточка вокруг могут сами ловить клик — переход только наш.
    e.preventDefault();
    e.stopPropagation();
    if (!found) return;
    const s = useStore.getState();
    s.openPmChat(id);
    s.setView('chat');
  };
  return (
    <span
      className={found ? 'md-chat' : 'md-chat md-chat-missing'}
      role="button"
      tabIndex={found ? 0 : -1}
      aria-disabled={!found}
      title={found ? t('md.chat.open') : t('md.chat.missing')}
      onClick={go}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') go(e); }}
    >
      <Icon name="message" size={14} className="md-chat-icon" />
      <span className="md-chat-title">{found ? (title || label) : label}</span>
    </span>
  );
}

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
    else if (m[6] !== undefined && CHAT_HREF.test(m[6])) out.push(<ChatLink key={k} id={CHAT_HREF.exec(m[6])![1]} label={inline(m[5], k)} />);
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

/**
 * Абзац: одиночный перевод строки — пробел, два пробела или `\` в конце — разрыв.
 * С `breaks` разрыв — любой перевод строки: в чате Enter значит «с новой
 * строки», а не «продолжение абзаца».
 */
function paragraphInline(lines: string[], key: string, breaks: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    const hard = breaks || / {2,}$|\\$/.test(line);
    const clean = line.replace(/ {2,}$|\\$/, '').trim();
    out.push(...inline(clean, `${key}.${i}`));
    if (i < lines.length - 1) out.push(hard ? <br key={`${key}.br${i}`} /> : ' ');
  });
  return out;
}

// ------------------------------------------------------------ блок кода

/** Сколько держится «Скопировано» на кнопке. */
const COPIED_MS = 1500;

/**
 * Копирование в буфер. `navigator.clipboard` есть только в защищённом
 * контексте: офис, открытый по адресу в локальной сети, его не получит —
 * тогда старый путь через выделение в скрытом поле.
 */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* ниже старый путь */ }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}

/**
 * Огороженный блок кода: шапка с языком и кнопкой «Копировать», под ней код.
 * Прокручивается только `<pre>`, а шапка лежит над ним, поэтому кнопка
 * остаётся на месте при горизонтальной прокрутке длинных строк. Куски
 * подсветки — обычные `<span>` с текстом: `<script>` из блока так и останется
 * буквами.
 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const tokens = useMemo(() => highlight(code, lang), [code, lang]);
  const copy = (e: MouseEvent) => {
    // Карточка или реплика вокруг могут сами ловить клик.
    e.stopPropagation();
    const done = (next: 'copied' | 'failed') => {
      setState(next);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState('idle'), COPIED_MS);
    };
    copyText(code).then(() => done('copied'), () => done('failed'));
  };
  const label = state === 'copied' ? t('md.code.copied') : state === 'failed' ? t('md.code.copyFailed') : t('md.code.copy');
  const icon = state === 'copied' ? 'check' : state === 'failed' ? 'alert-circle' : 'copy';
  return (
    <div className="md-code">
      <div className="md-code-head">
        {lang && <span className="md-code-lang">{lang.toLowerCase()}</span>}
        <button
          type="button"
          className={`md-code-copy${state === 'copied' ? ' is-done' : state === 'failed' ? ' is-failed' : ''}`}
          onClick={copy}
          aria-label={label}
          title={label}
        >
          <Icon name={icon} size={14} />
        </button>
        {/* Иконка смену состояния голосом не передаёт — объявляем её отдельно. */}
        <span className="md-code-status" role="status">{state === 'idle' ? '' : label}</span>
      </div>
      <pre>
        <code>
          {tokens.map((tok, j) => (tok.kind ? <span key={j} className={`hl-${tok.kind}`}>{tok.text}</span> : tok.text))}
        </code>
      </pre>
    </div>
  );
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

function list(lines: string[], start: number, key: string, breaks: boolean): { node: ReactNode; end: number } {
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
    const inner = blocks(body, `${key}.${j}`, breaks, true);
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
function blocks(lines: string[], key: string, breaks: boolean, tight = false): ReactNode[] {
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
      out.push(<CodeBlock key={k} code={body.join('\n')} lang={fence[2]} />);
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
      out.push(<blockquote key={k}>{blocks(body, k, breaks)}</blockquote>);
      continue;
    }

    if (ITEM.test(line)) {
      const { node, end } = list(lines, i, k, breaks);
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
    out.push(<p key={k}>{paragraphInline(body, k, breaks)}</p>);
  }
  // Пункт списка из одного абзаца — просто строка.
  if (tight && paragraphs === 1 && out.length >= 1) {
    const first = out[0] as { type?: unknown; props?: { children?: ReactNode } };
    if (first?.type === 'p') out[0] = <span key={`${key}.t`}>{first.props?.children}</span>;
  }
  return out;
}

/**
 * Отрисованный Markdown. Шапку YAML (`---` … `---` в начале) документа не
 * показываем — это служебное. `compact` — реплика чата: мелкие заголовки, плотные отступы
 * и перевод строки как разрыв. Фон, рамку и отступы даёт обёртка места показа, а не
 * корень: у `.md.md-compact` специфичность выше, и он перебил бы их классы.
 */
export function Markdown({ source, compact = false }: { source: string; compact?: boolean }) {
  let text = source.replace(/\r\n?/g, '\n');
  // В реплике чата `---` в начале — черта или разделитель, а не шапка файла.
  const front = compact ? null : /^---\n[\s\S]*?\n---\n/.exec(text);
  if (front) text = text.slice(front[0].length);
  const cls = compact ? 'md md-compact' : 'md';
  return <div className={cls}>{blocks(text.split('\n'), 'md', compact)}</div>;
}

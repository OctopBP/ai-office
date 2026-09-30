/**
 * Заметки к выпуску — документом, а не сырыми тегами.
 *
 * electron-updater отдаёт тело релиза с GitHub уже HTML-ом (desktop/updater.js
 * склеивает его в одну строку). Вставлять эту строку через
 * `dangerouslySetInnerHTML` нельзя: релиз — внешний текст, и любой `<script>`
 * или `onerror` из него исполнился бы в окне с мостом к приложению. Поэтому
 * HTML разбирается DOMParser-ом (он скрипты не запускает и картинки не грузит)
 * и пересобирается в элементы React по белому списку тегов. Остальное
 * разворачивается в свой текст, а атрибуты не переносятся вовсе — кроме
 * проверенного `href` у ссылки. Пришёл markdown — рисуем его тем же
 * рендером, что и документы в результате задачи.
 */
import { createElement, Fragment, type ReactNode } from 'react';
import { Markdown } from '../Markdown';

/** Теги, которые переносятся как есть (без атрибутов). */
const ALLOWED = new Set([
  'h1', 'h2', 'h3', 'h4', 'p', 'strong', 'b', 'em', 'i',
  'ul', 'ol', 'li', 'code', 'pre', 'br', 'blockquote', 'a',
]);

/** Теги, содержимое которых — не текст для чтения: выбрасываем целиком. */
const DROPPED = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'title']);

/** Ссылка — только на внешний адрес; во внешнем окне её открывает setWindowOpenHandler приложения. */
function safeHref(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function convert(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROPPED.has(tag)) return null;
  const children = Array.from(el.childNodes, (child, i) => convert(child, `${key}.${i}`));
  // Чужой тег разворачиваем фрагментом: `<div>` с абзацами внутри не должен стать `<span>` с блоками.
  if (!ALLOWED.has(tag)) return children.length ? <Fragment key={key}>{children}</Fragment> : null;
  if (tag === 'br') return <br key={key} />;
  if (tag === 'a') {
    const href = safeHref(el.getAttribute('href'));
    if (!href) return <span key={key}>{children}</span>;
    return <a key={key} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
  }
  return createElement(tag, { key }, ...children);
}

/** Похоже ли на HTML: есть хотя бы один тег из тех, что GitHub ставит в тело релиза. */
const looksLikeHtml = (text: string) => /<\/?(h[1-6]|p|ul|ol|li|strong|b|em|i|a|br|code|pre|blockquote|div|span)\b[^>]*>/i.test(text);

/** Разметка заметок: HTML — по белому списку, иначе — markdown. */
export function ReleaseNotes({ source }: { source: string }) {
  if (!looksLikeHtml(source) || typeof DOMParser === 'undefined') return <Markdown source={source} />;
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const nodes = Array.from(doc.body.childNodes, (child, i) => convert(child, `n${i}`));
  return <div className="md">{nodes}</div>;
}

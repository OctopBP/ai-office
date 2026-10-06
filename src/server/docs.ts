/**
 * Библиотека документов офиса: основа (видение, GDD, персонажи, бренд),
 * документация (как устроено сейчас) и рабочие материалы к задачам.
 *
 * Это хранилище офиса, как журнал (journal.ts), а не файлы `docs/` в git:
 * документ правится без коммита, без ветки и без согласия владельца — ни для
 * какого типа. Каждая правка видна в ленте событием `doc.*` и строкой лога.
 *
 * Формат на диске — папка рядом с файлом состояния офиса
 * (`OfficeState.docsDir()`, например `.office/offices/o-2.docs/`):
 *
 *   index.json            { seq, docs: DocMeta[] } — оглавление; точка фиксации
 *   D-3.md                текущий текст документа — для глаз и grep
 *   history/D-3/v1.json   DocVersion — каждая версия целиком, включая текущую
 *   history/D-3/v2.json
 *
 * Каждый файл пишется атомарно: во временный рядом и rename поверх. Порядок
 * записи при правке — сначала версия в историю, потом .md, последним
 * index.json. Индекс — точка фиксации: пока он не переписан, документ для всех
 * читателей прежний, а оборванная на полпути правка оставляет лишь лишний
 * файл версии, который следующая правка перезапишет. Поэтому readDoc берёт
 * текст из файла версии, на которую указывает индекс, а .md — зеркало.
 *
 * Всё синхронно: сервер один процесс, и синхронная запись исключает гонку
 * двух правок одного документа без всяких блокировок.
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { DocKind, DocMeta, DocVersion, OfficeDoc } from '../shared/types';
import { getOffice, type OfficeState } from './state';

export const DOC_KINDS: readonly DocKind[] = ['foundation', 'documentation', 'working'];

/** Сколько символов оглавления едет в промпт по умолчанию. */
export const PROMPT_INDEX_CHARS = 3000;

/** Предел длины описания: это одна строка оглавления, а не аннотация. */
export const SUMMARY_MAX = 200;

const ID_RE = /^D-\d+$/;

interface DocIndex {
  /** Последний выданный номер: id не переиспользуются. */
  seq: number;
  docs: DocMeta[];
}

/** Офис — состоянием или его id: так зовут и из state, и из agents. */
type Office = OfficeState | string;

function officeOf(office: Office): OfficeState {
  return typeof office === 'string' ? getOffice(office) : office;
}

// ---------------------------------------------------------------- диск

function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

function indexFile(dir: string): string {
  return join(dir, 'index.json');
}

function bodyFile(dir: string, id: string): string {
  return join(dir, `${id}.md`);
}

function versionFile(dir: string, id: string, version: number): string {
  return join(dir, 'history', id, `v${version}.json`);
}

function loadIndex(dir: string): DocIndex {
  try {
    const raw = JSON.parse(readFileSync(indexFile(dir), 'utf8')) as Partial<DocIndex>;
    const docs = Array.isArray(raw.docs) ? raw.docs : [];
    // seq берём не меньше наибольшего id: индекс правят и руками.
    const top = docs.reduce((m, d) => Math.max(m, Number(d.id.slice(2)) || 0), 0);
    return { seq: Math.max(Number(raw.seq) || 0, top), docs };
  } catch {
    return { seq: 0, docs: [] };
  }
}

function saveIndex(dir: string, index: DocIndex): void {
  writeAtomic(indexFile(dir), JSON.stringify(index, null, 2));
}

function readVersion(dir: string, id: string, version: number): DocVersion | null {
  try {
    return JSON.parse(readFileSync(versionFile(dir, id, version), 'utf8')) as DocVersion;
  } catch {
    return null;
  }
}

/** Текст текущей версии: из истории, а если её нет (правили руками) — из .md. */
function currentBody(dir: string, meta: DocMeta): string {
  const v = readVersion(dir, meta.id, meta.version);
  if (v) return v.body;
  try {
    return readFileSync(bodyFile(dir, meta.id), 'utf8');
  } catch {
    return '';
  }
}

/** Записать новую версию: история → .md → индекс (см. шапку модуля). */
function commit(dir: string, index: DocIndex, meta: DocMeta, body: string): void {
  const version: DocVersion = {
    version: meta.version, body, title: meta.title, summary: meta.summary,
    kind: meta.kind, author: meta.updatedBy, at: meta.updatedAt,
  };
  writeAtomic(versionFile(dir, meta.id, meta.version), JSON.stringify(version, null, 2));
  writeAtomic(bodyFile(dir, meta.id), body);
  const at = index.docs.findIndex((d) => d.id === meta.id);
  if (at >= 0) index.docs[at] = meta;
  else index.docs.push(meta);
  saveIndex(dir, index);
}

// ---------------------------------------------------------------- чистка ввода

function isKind(v: unknown): v is DocKind {
  return typeof v === 'string' && (DOC_KINDS as readonly string[]).includes(v);
}

function cleanTitle(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Описание — одна строка: переводы строк схлопываем, длину режем. */
function cleanSummary(v: unknown): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
}

function cleanTaskId(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

// ---------------------------------------------------------------- события

function announce(state: OfficeState, t: 'doc.created' | 'doc.updated' | 'doc.archived', doc: DocMeta): void {
  state.emit({ t, doc: { ...doc } });
  const vars = { id: doc.id, title: doc.title, author: doc.updatedBy, version: doc.version };
  const key = t === 'doc.created' ? 'docs.createdLog' : t === 'doc.updated' ? 'docs.updatedLog' : 'docs.archivedLog';
  state.addLog(null, 'system', state.say(key, vars));
}

// ---------------------------------------------------------------- чтение

export interface ListDocsQuery {
  kind?: DocKind;
  includeArchived?: boolean;
  /** Поиск по названию, описанию и тексту: все слова, без учёта регистра. */
  query?: string;
}

/**
 * Оглавление документов. Без запроса — свежие правки сверху; с запросом —
 * сначала совпавшие в названии, потом в описании, потом только в тексте.
 */
export function listDocs(office: Office, q: ListDocsQuery = {}): DocMeta[] {
  const dir = officeOf(office).docsDir();
  let docs = loadIndex(dir).docs.filter((d) =>
    (q.includeArchived || !d.archived) && (!q.kind || d.kind === q.kind));
  const words = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return docs.sort((a, b) => b.updatedAt - a.updatedAt);

  const has = (text: string) => words.every((w) => text.includes(w));
  const rank = (d: DocMeta): number => {
    const title = d.title.toLowerCase();
    const head = `${title}\n${d.summary.toLowerCase()}`;
    if (has(title)) return 0;
    if (has(head)) return 1;
    return has(`${head}\n${currentBody(dir, d).toLowerCase()}`) ? 2 : -1;
  };
  docs = docs
    .map((d) => ({ d, r: rank(d) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || b.d.updatedAt - a.d.updatedAt)
    .map((x) => x.d);
  return docs;
}

/** Документ целиком; с `version` — каким он был в той версии. null — нет такого. */
export function readDoc(office: Office, id: string, version?: number): OfficeDoc | null {
  if (!ID_RE.test(id)) return null;
  const dir = officeOf(office).docsDir();
  const meta = loadIndex(dir).docs.find((d) => d.id === id);
  if (!meta) return null;
  if (version === undefined || version === meta.version) return { ...meta, body: currentBody(dir, meta) };
  const v = readVersion(dir, id, version);
  if (!v || version > meta.version) return null;
  return {
    ...meta, title: v.title, summary: v.summary, kind: v.kind, body: v.body,
    version: v.version, updatedBy: v.author, updatedAt: v.at,
  };
}

/** История версий документа, от первой к последней. */
export function docHistory(office: Office, id: string): DocVersion[] {
  if (!ID_RE.test(id)) return [];
  const dir = officeOf(office).docsDir();
  const meta = loadIndex(dir).docs.find((d) => d.id === id);
  if (!meta) return [];
  const out: DocVersion[] = [];
  for (let v = 1; v <= meta.version; v++) {
    const found = readVersion(dir, id, v);
    if (found) out.push(found);
  }
  return out;
}

// ---------------------------------------------------------------- запись

export interface CreateDocInput {
  title: string;
  summary?: string;
  body?: string;
  /** По умолчанию — рабочий материал. */
  kind?: DocKind;
  taskId?: string;
  author: string;
}

export function createDoc(office: Office, input: CreateDocInput, now = Date.now()): OfficeDoc {
  const state = officeOf(office);
  const title = cleanTitle(input.title);
  if (!title) throw new Error('Документу нужно название');
  if (input.kind !== undefined && !isKind(input.kind)) throw new Error(`Неизвестный тип документа: ${String(input.kind)}`);
  const dir = state.docsDir();
  const index = loadIndex(dir);
  index.seq += 1;
  const author = cleanTitle(input.author) || 'office';
  const meta: DocMeta = {
    id: `D-${index.seq}`,
    title,
    summary: cleanSummary(input.summary),
    kind: input.kind ?? 'working',
    archived: false,
    version: 1,
    createdBy: author,
    updatedBy: author,
    createdAt: now,
    updatedAt: now,
  };
  const taskId = cleanTaskId(input.taskId);
  if (taskId) meta.taskId = taskId;
  const body = String(input.body ?? '');
  commit(dir, index, meta, body);
  announce(state, 'doc.created', meta);
  return { ...meta, body };
}

export interface DocPatch {
  title?: string;
  summary?: string;
  body?: string;
  kind?: DocKind;
  /** Пустая строка или null — отвязать от задачи. */
  taskId?: string | null;
  /** false — вернуть из архива; true — убрать в архив новой версией. */
  archived?: boolean;
}

/**
 * Правка документа. Каждая правка, которая что-то меняет, поднимает версию и
 * пишет её в историю; правка без изменений — не правка, версия та же и
 * событий нет. null — документа нет.
 */
export function updateDoc(office: Office, id: string, patch: DocPatch, author: string, now = Date.now()): OfficeDoc | null {
  const state = officeOf(office);
  if (!ID_RE.test(id)) return null;
  if (patch.kind !== undefined && !isKind(patch.kind)) throw new Error(`Неизвестный тип документа: ${String(patch.kind)}`);
  const dir = state.docsDir();
  const index = loadIndex(dir);
  const prev = index.docs.find((d) => d.id === id);
  if (!prev) return null;
  const prevBody = currentBody(dir, prev);

  const next: DocMeta = { ...prev };
  if (patch.title !== undefined) {
    const title = cleanTitle(patch.title);
    if (!title) throw new Error('Документу нужно название');
    next.title = title;
  }
  if (patch.summary !== undefined) next.summary = cleanSummary(patch.summary);
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.taskId !== undefined) {
    const taskId = cleanTaskId(patch.taskId);
    if (taskId) next.taskId = taskId;
    else delete next.taskId;
  }
  if (patch.archived !== undefined) next.archived = patch.archived;
  const body = patch.body !== undefined ? String(patch.body) : prevBody;

  const changed = body !== prevBody || next.title !== prev.title || next.summary !== prev.summary
    || next.kind !== prev.kind || next.taskId !== prev.taskId || next.archived !== prev.archived;
  if (!changed) return { ...prev, body: prevBody };

  next.version = prev.version + 1;
  next.updatedBy = cleanTitle(author) || 'office';
  next.updatedAt = now;
  commit(dir, index, next, body);
  announce(state, next.archived && !prev.archived ? 'doc.archived' : 'doc.updated', next);
  return { ...next, body };
}

/** Сменить тип документа — обычная правка: новая версия и событие. */
export function setKind(office: Office, id: string, kind: DocKind, author: string, now = Date.now()): OfficeDoc | null {
  return updateDoc(office, id, { kind }, author, now);
}

/**
 * Убрать в архив рабочие материалы задачи — когда задача закрыта, её спеки и
 * исследования больше не нужны в оглавлении. Основа и документация, даже
 * привязанные к задаче, остаются: они переживают задачу.
 *
 * Архивирование здесь — пометка, а не правка содержимого: версия не растёт,
 * история не пополняется, меняется только индекс (одной записью на все
 * документы). Возвращает id убранных.
 */
export function archiveWorkingDocsOfTask(office: Office, taskId: string, now = Date.now()): string[] {
  const state = officeOf(office);
  const dir = state.docsDir();
  const index = loadIndex(dir);
  const hit = index.docs.filter((d) => d.taskId === taskId && d.kind === 'working' && !d.archived);
  if (!hit.length) return [];
  for (const d of hit) {
    d.archived = true;
    d.updatedAt = now;
  }
  saveIndex(dir, index);
  for (const d of hit) announce(state, 'doc.archived', d);
  return hit.map((d) => d.id);
}

// ---------------------------------------------------------------- промпт

/**
 * Короткое оглавление для системного промпта: id, тип, название и описание.
 * Архивных нет; основа идёт первой, рабочие материалы последними, внутри —
 * свежие сверху. Длина ограничена `maxChars`: что не влезло, сводится к
 * строке «…и ещё N». Пустая строка — документов нет.
 */
export function docIndexForPrompt(office: Office, maxChars = PROMPT_INDEX_CHARS): string {
  const state = officeOf(office);
  const docs = listDocs(state).sort((a, b) =>
    DOC_KINDS.indexOf(a.kind) - DOC_KINDS.indexOf(b.kind) || b.updatedAt - a.updatedAt);
  if (!docs.length) return '';
  const lines = [state.say('docs.indexHead')];
  let used = lines[0].length;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const task = d.taskId ? `, ${d.taskId}` : '';
    const line = `- ${d.id} [${state.say(`docs.kind.${d.kind}`)}${task}] ${d.title}${d.summary ? ` — ${d.summary}` : ''}`;
    const rest = docs.length - i;
    // Место под хвост «…и ещё N» держим всегда, если после этой строки что-то останется.
    const tail = rest > 1 ? state.say('docs.indexMore', { n: rest - 1 }).length + 1 : 0;
    if (used + 1 + line.length + tail > maxChars) {
      lines.push(state.say('docs.indexMore', { n: rest }));
      break;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- импорт

export interface ImportResult {
  created: string[];
  /** Файлы, документ с таким названием и типом у которых уже есть. */
  skipped: string[];
}

/** Название и описание из markdown: первый заголовок и первый абзац текста. */
function describeMarkdown(text: string, fallback: string): { title: string; summary: string } {
  const lines = text.split(/\r?\n/);
  let title = '';
  let summary = '';
  let fence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) { fence = !fence; continue; }
    if (fence || !line || line.startsWith('<!--')) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      if (!title) title = heading[1];
      continue;
    }
    if (/^[-*_]{3,}$/.test(line) || line.startsWith('|')) continue;
    summary = line.replace(/^[>*\-+]\s+/, '');
    break;
  }
  return { title: title || fallback, summary };
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...markdownFiles(full));
    else if (/\.md$/i.test(name)) out.push(full);
  }
  return out;
}

/**
 * Разовый импорт markdown-файлов папки (с подпапками) в библиотеку одним
 * типом. Повторный запуск не плодит дубли: файл, документ с чьим названием и
 * типом уже есть, пропускается.
 */
export function importFromDir(office: Office, dir: string, kind: DocKind, author = 'import'): ImportResult {
  const state = officeOf(office);
  if (!isKind(kind)) throw new Error(`Неизвестный тип документа: ${String(kind)}`);
  const root = resolve(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Нет папки ${root}`);
  const seen = new Set(listDocs(state, { includeArchived: true, kind }).map((d) => d.title));
  const result: ImportResult = { created: [], skipped: [] };
  for (const file of markdownFiles(root)) {
    const body = readFileSync(file, 'utf8');
    const { title, summary } = describeMarkdown(body, basename(file).replace(/\.md$/i, ''));
    const clean = cleanTitle(title);
    if (seen.has(clean)) {
      result.skipped.push(file);
      continue;
    }
    seen.add(clean);
    result.created.push(createDoc(state, { title: clean, summary, body, kind, author }).id);
  }
  return result;
}

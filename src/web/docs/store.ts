import { create } from 'zustand';
import { onServerEvent } from '../store';
import type { DocKind, DocListResponse, DocMeta, DocResponse, DocUpdateBody, OfficeDoc } from '../../shared/types';

export const DOC_KINDS: readonly DocKind[] = ['foundation', 'documentation', 'working'];

/** Что делает последний запрос: грузится, упал или отдал список. */
export type DocsLoad = 'idle' | 'loading' | 'error' | 'ready';

interface DocsState {
  officeId: string | null;
  /** Все документы офиса, включая архивные: вкладки и счётчики считаются на клиенте. */
  docs: DocMeta[];
  load: DocsLoad;
  tab: DocKind;
  query: string;
  /** Запрос, который уже ушёл на сервер (после задержки ввода). */
  appliedQuery: string;
  /** Совпавшие с запросом id; null — запроса нет. */
  matches: Set<string> | null;
  showArchived: boolean;
  /** Показывать результаты поиска по всем типам, а не по текущей вкладке. */
  allKinds: boolean;
  selectedId: string | null;

  setOffice: (id: string | null) => void;
  reload: () => Promise<void>;
  setTab: (k: DocKind) => void;
  setQuery: (q: string) => void;
  setShowArchived: (v: boolean) => void;
  setAllKinds: (v: boolean) => void;
  select: (id: string | null) => void;
  resetSearch: () => void;
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** Номер запроса: ответ устаревшего запроса не должен перетереть свежий. */
let seq = 0;

const url = (officeId: string, extra = ''): string =>
  `/api/docs?office=${encodeURIComponent(officeId)}&archived=1${extra}`;

const upsert = (docs: DocMeta[], doc: DocMeta): DocMeta[] =>
  docs.some((d) => d.id === doc.id) ? docs.map((d) => (d.id === doc.id ? doc : d)) : [...docs, doc];

export const useDocs = create<DocsState>((set, get) => ({
  officeId: null,
  docs: [],
  load: 'idle',
  tab: 'foundation',
  query: '',
  appliedQuery: '',
  matches: null,
  showArchived: false,
  allKinds: false,
  selectedId: null,

  setOffice: (id) => {
    if (get().officeId === id) return;
    set({ officeId: id, docs: [], load: 'idle', matches: null, appliedQuery: '', query: '', selectedId: null });
    if (id) void get().reload();
  },

  reload: async () => {
    const { officeId, appliedQuery } = get();
    if (!officeId) return;
    const mine = ++seq;
    if (get().load !== 'ready') set({ load: 'loading' });
    try {
      // Полный список нужен всегда (счётчики вкладок), поиск — вторым запросом.
      const [all, found] = await Promise.all([
        fetch(url(officeId)).then((r) => (r.ok ? (r.json() as Promise<DocListResponse>) : Promise.reject(new Error(String(r.status))))),
        appliedQuery
          ? fetch(url(officeId, `&query=${encodeURIComponent(appliedQuery)}`))
            .then((r) => (r.ok ? (r.json() as Promise<DocListResponse>) : Promise.reject(new Error(String(r.status)))))
          : Promise.resolve(null),
      ]);
      if (mine !== seq) return;
      set({
        docs: all.docs,
        matches: found ? new Set(found.docs.map((d) => d.id)) : null,
        load: 'ready',
      });
    } catch {
      if (mine !== seq) return;
      set({ load: 'error' });
    }
  },

  setTab: (tab) => set({ tab }),

  setQuery: (query) => {
    set({ query });
    clearTimeout(searchTimer);
    // Пустой запрос применяется сразу, непустой — после паузы в 200 мс.
    const apply = () => {
      set({ appliedQuery: query.trim(), allKinds: query.trim() ? get().allKinds : false });
      if (!query.trim()) set({ matches: null });
      void get().reload();
    };
    if (!query.trim()) apply();
    else searchTimer = setTimeout(apply, 200);
  },

  setShowArchived: (showArchived) => set({ showArchived }),
  setAllKinds: (allKinds) => set({ allKinds }),
  select: (selectedId) => set({ selectedId }),

  resetSearch: () => {
    clearTimeout(searchTimer);
    set({ query: '', appliedQuery: '', matches: null, allKinds: false });
  },
}));

// События doc.* приходят с метаданными документа: строку списка обновляем на месте.
// Поиск по тексту пересчитывает сервер, поэтому при активном запросе — перезапрос.
onServerEvent((e) => {
  if (e.t !== 'doc.created' && e.t !== 'doc.updated' && e.t !== 'doc.archived') return;
  const s = useDocs.getState();
  if (s.load === 'idle') return;
  useDocs.setState({ docs: upsert(s.docs, e.doc) });
  if (s.appliedQuery) void s.reload();
});

/** Документы вкладки по текущему поиску и режиму архива, свежие сверху, архив в конце. */
export function visibleDocs(s: Pick<DocsState, 'docs' | 'tab' | 'matches' | 'showArchived' | 'allKinds'>): DocMeta[] {
  return s.docs
    .filter((d) => (s.showArchived || !d.archived)
      && (s.matches ? s.matches.has(d.id) : true)
      && (s.matches && s.allKinds ? true : d.kind === s.tab))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || b.updatedAt - a.updatedAt);
}

/** Счётчик вкладки: без архива, при поиске — число совпадений. */
export const countKind = (s: Pick<DocsState, 'docs' | 'matches'>, k: DocKind): number =>
  s.docs.filter((d) => d.kind === k && !d.archived && (s.matches ? s.matches.has(d.id) : true)).length;

/** Создать документ владельцем; новый документ сразу выделяется в списке. */
export async function createDoc(title: string, kind: DocKind): Promise<boolean> {
  const { officeId } = useDocs.getState();
  if (!officeId) return false;
  try {
    const res = await fetch(`/api/docs?office=${encodeURIComponent(officeId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, kind }),
    });
    if (!res.ok) return false;
    const { doc } = (await res.json()) as { doc: DocMeta };
    useDocs.setState((s) => ({
      docs: upsert(s.docs, doc), tab: doc.kind, selectedId: doc.id,
    }));
    return true;
  } catch {
    return false;
  }
}

const docUrl = (id: string, officeId: string, extra = ''): string =>
  `/api/docs/${encodeURIComponent(id)}${extra}?office=${encodeURIComponent(officeId)}`;

/** Исход запроса к одному документу: сам документ или текст отказа. */
export type DocResult = { ok: true; doc: OfficeDoc } | { ok: false; error: string };

async function docRequest(path: string, init?: RequestInit): Promise<DocResult> {
  try {
    const res = await fetch(path, init && {
      ...init, headers: { 'Content-Type': 'application/json' },
    });
    const data = (await res.json().catch(() => ({}))) as Partial<DocResponse> & { error?: string };
    if (!res.ok || !data.doc) return { ok: false, error: data.error ?? String(res.status) };
    const { body: _body, ...meta } = data.doc;
    useDocs.setState((s) => ({ docs: upsert(s.docs, meta) }));
    return { ok: true, doc: data.doc };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Документ целиком, с текстом. */
export function fetchDoc(id: string): Promise<DocResult> {
  const { officeId } = useDocs.getState();
  return officeId ? docRequest(docUrl(id, officeId)) : Promise.resolve({ ok: false, error: 'no office' });
}

/** Правка владельцем: название, описание, текст или тип. */
export function updateDoc(id: string, patch: DocUpdateBody): Promise<DocResult> {
  const { officeId } = useDocs.getState();
  if (!officeId) return Promise.resolve({ ok: false, error: 'no office' });
  return docRequest(docUrl(id, officeId), { method: 'PUT', body: JSON.stringify(patch) });
}

/** В архив (`archived: true`) или обратно. */
export function archiveDoc(id: string, archived: boolean): Promise<DocResult> {
  const { officeId } = useDocs.getState();
  if (!officeId) return Promise.resolve({ ok: false, error: 'no office' });
  return docRequest(docUrl(id, officeId, '/archive'), { method: 'POST', body: JSON.stringify({ archived }) });
}

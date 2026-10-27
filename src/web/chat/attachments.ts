/**
 * Вложения в поле ввода чата с менеджером (T-700): очередь файлов до
 * отправки, загрузка на сервер и снятие.
 *
 * Сервер (src/server/attachments.ts) принимает файл сырым телом
 * `POST /api/chat/attachment` и отвечает { id, name, size, mime, url };
 * с репликой уходят только id. Очередь живёт в своём сторе, а не в локальном
 * состоянии композера: на разных видах композер — разные экземпляры, и
 * недозагруженное не должно теряться при смене вида.
 */
import { create } from 'zustand';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_MESSAGE, type ChatAttachment } from '../../shared/types';
import { t } from '../i18n';
import { useStore } from '../store';
import { formatSize, officeQuery } from '../result/api';

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  mime: string;
  status: 'uploading' | 'done' | 'error';
  /** Ответ сервера — есть у загруженных. */
  saved?: ChatAttachment;
  /** Что случилось и что делать — для ошибки. */
  error?: string;
  /** Можно ли повторить: лимиты повтором не лечатся. */
  retry?: boolean;
  /** Миниатюра картинки, пока файл не ушёл на сервер и после. */
  preview?: string;
}

interface AttachState {
  items: PendingFile[];
}

export const useAttachments = create<AttachState>(() => ({ items: [] }));

// Файлы и отмены держим вне стора: сериализуемому состоянию они ни к чему.
const files = new Map<string, File>();
const aborts = new Map<string, AbortController>();
let seq = 0;

const patch = (key: string, p: Partial<PendingFile>) =>
  useAttachments.setState((s) => ({ items: s.items.map((i) => (i.key === key ? { ...i, ...p } : i)) }));

/** Чат, в папку которого кладём файл: открытый или `inbox` для ещё не заведённого. */
function chatFolder(): string {
  const { thread, pmChatId, pmChatDraft } = useStore.getState();
  return thread === 'pm#1' && pmChatId && !pmChatDraft && /^[A-Za-z0-9_-]{1,64}$/.test(pmChatId) ? pmChatId : '';
}

const isImage = (mime: string): boolean => /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i.test(mime);

async function upload(key: string): Promise<void> {
  const file = files.get(key);
  if (!file) return;
  const ctl = new AbortController();
  aborts.set(key, ctl);
  patch(key, { status: 'uploading', error: undefined });
  try {
    const q = `${officeQuery()}chat=${encodeURIComponent(chatFolder())}&name=${encodeURIComponent(file.name)}`;
    const res = await fetch(`/api/chat/attachment?${q}`, {
      method: 'POST', body: file, signal: ctl.signal,
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    });
    const body = await res.json().catch(() => null) as (ChatAttachment & { error?: string }) | null;
    if (!res.ok || !body || body.error) {
      // Сервер говорит по-человечески про лимиты и закрытый офис — показываем его слова.
      patch(key, {
        status: 'error', retry: res.status !== 413,
        error: body?.error ?? t('attach.failed', { name: file.name, reason: `HTTP ${res.status}` }),
      });
      return;
    }
    patch(key, { status: 'done', saved: body });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    patch(key, { status: 'error', retry: true, error: t('attach.failed', { name: file.name, reason: t('attach.noConnection') }) });
  } finally {
    aborts.delete(key);
  }
}

/** Добавить файлы в очередь: лимиты проверяются сразу, загрузка идёт в фоне. */
export function addFiles(list: Iterable<File>): void {
  for (const file of list) {
    const key = `a${++seq}`;
    const base = { key, name: file.name, size: file.size, mime: file.type };
    const live = useAttachments.getState().items.filter((i) => i.status !== 'error').length;
    if (file.size > ATTACHMENT_MAX_BYTES) {
      useAttachments.setState((s) => ({
        items: [...s.items, { ...base, status: 'error', error: t('attach.tooBig', { name: file.name, max: formatSize(ATTACHMENT_MAX_BYTES) }) }],
      }));
      continue;
    }
    if (live >= ATTACHMENTS_PER_MESSAGE) {
      useAttachments.setState((s) => ({
        items: [...s.items, { ...base, status: 'error', error: t('attach.tooMany', { name: file.name, max: ATTACHMENTS_PER_MESSAGE }) }],
      }));
      continue;
    }
    files.set(key, file);
    useAttachments.setState((s) => ({
      items: [...s.items, { ...base, status: 'uploading', preview: isImage(file.type) ? URL.createObjectURL(file) : undefined }],
    }));
    void upload(key);
  }
}

export function retryFile(key: string): void {
  void upload(key);
}

function forget(key: string): void {
  const item = useAttachments.getState().items.find((i) => i.key === key);
  if (item?.preview) URL.revokeObjectURL(item.preview);
  files.delete(key);
  aborts.delete(key);
  useAttachments.setState((s) => ({ items: s.items.filter((i) => i.key !== key) }));
}

/** Убрать чип; загруженный файл заодно снимается с сервера, чтобы не копить мусор. */
export function removeFile(key: string): void {
  const item = useAttachments.getState().items.find((i) => i.key === key);
  if (!item) return;
  aborts.get(key)?.abort();
  if (item.saved) {
    const { id } = item.saved;
    const q = `${officeQuery()}chat=${encodeURIComponent(new URL(item.saved.url, location.href).searchParams.get('chat') ?? '')}&id=${id}`;
    void fetch(`/api/chat/attachment?${q}`, { method: 'DELETE' }).catch(() => {});
  }
  forget(key);
}

/** Реплика ушла — очередь пуста (файлы теперь принадлежат сообщению). */
export function clearSent(): void {
  for (const i of useAttachments.getState().items) if (i.preview) URL.revokeObjectURL(i.preview);
  files.clear();
  aborts.clear();
  useAttachments.setState({ items: [] });
}

/** Идёт ли загрузка — отправка заперта. */
export const isUploading = (items: PendingFile[]): boolean => items.some((i) => i.status === 'uploading');

/** id загруженных файлов — то, что уходит с репликой. */
export const readyIds = (items: PendingFile[]): string[] =>
  items.flatMap((i) => (i.status === 'done' && i.saved ? [i.saved.id] : []));

/** Файлы из буфера или переноса; пустой список — там не файлы. */
export function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files && data.files.length) return [...data.files];
  return [...(data.items ?? [])].flatMap((it) => (it.kind === 'file' ? [it.getAsFile()].filter((f): f is File => !!f) : []));
}

/** У вставленной картинки браузер дает имя «image.png» — делаем его различимым. */
export function namedPaste(file: File): File {
  if (file.name && file.name !== 'image.png') return file;
  const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace(/\+.*/, '');
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return new File([file], `${t('attach.pastedName')}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`, { type: file.type });
}

import { create } from 'zustand';
import { useStore } from './store';
import type { FieldError } from '../shared/types';
import type { MyAgentDraft, MyAgentView } from '../shared/myagent';

/**
 * Свои агенты этого офиса: список с сервера и запросы к `/api/my-agents`.
 * Сервер ведёт хранение и проверку; здесь только транспорт и срез для
 * окна «Команда». Офис сервер берёт текущий.
 */

interface MyAgentsState {
  agents: MyAgentView[];
  loaded: boolean;
}

export const useMyAgents = create<MyAgentsState>(() => ({ agents: [], loaded: false }));

/** Итог записи: агент и итог найма либо ошибки по полям. */
export type HireOutcome = { roleId: string | null; problem: string | null };
export type SaveResult =
  | { ok: true; agent: MyAgentView; warnings: FieldError[]; hired: HireOutcome | null; roleIds: string[] }
  | { ok: false; errors: FieldError[] };

/** `?office=` текущего офиса вкладки: без него сервер возьмёт глобальный текущий. */
function officeQuery(extra = ''): string {
  const id = useStore.getState().offices.find((o) => o.current)?.id;
  const parts = [extra, id ? `office=${encodeURIComponent(id)}` : ''].filter(Boolean);
  return parts.length ? `?${parts.join('&')}` : '';
}

const networkError = (err: unknown): SaveResult => ({
  ok: false, errors: [{ field: '', message: (err as Error).message }],
});

async function send(method: string, url: string, body?: unknown): Promise<{ code: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { code: res.status, data };
}

/** Ответ сервера в `SaveResult`: ошибки приходят как `errors` или одиночным `error`. */
function toResult(code: number, data: Record<string, unknown>): SaveResult {
  if (code >= 200 && code < 300 && data.agent) {
    return {
      ok: true,
      agent: data.agent as MyAgentView,
      warnings: (data.warnings as FieldError[] | undefined) ?? [],
      hired: (data.hired as HireOutcome | null | undefined) ?? null,
      roleIds: (data.roleIds as string[] | undefined)
        ?? ((data.hired as HireOutcome | null | undefined)?.roleId ? [(data.hired as HireOutcome).roleId!] : []),
    };
  }
  const errors = data.errors as FieldError[] | undefined;
  if (errors?.length) return { ok: false, errors };
  return { ok: false, errors: [{ field: '', message: String(data.error ?? `HTTP ${code}`) }] };
}

/** Перечитать список своих агентов. */
export async function loadMyAgents(): Promise<void> {
  try {
    const { data } = await send('GET', `/api/my-agents${officeQuery()}`);
    useMyAgents.setState({ agents: (data.agents as MyAgentView[] | undefined) ?? [], loaded: true });
  } catch {
    useMyAgents.setState({ loaded: true });
  }
}

/** Создать агента с нуля и сразу нанять. */
export async function createMyAgent(draft: MyAgentDraft): Promise<SaveResult> {
  try {
    const { code, data } = await send('POST', `/api/my-agents${officeQuery()}`, { draft, hire: true });
    const res = toResult(code, data);
    if (res.ok) void loadMyAgents();
    return res;
  } catch (err) {
    return networkError(err);
  }
}

/** «Создать на основе» роли: настройки роли плюс правки формы. */
export async function createFromRole(roleId: string, patch: MyAgentDraft): Promise<SaveResult> {
  try {
    const { code, data } = await send('POST', `/api/my-agents/from-role${officeQuery()}`, { roleId, patch, hire: true });
    const res = toResult(code, data);
    if (res.ok) void loadMyAgents();
    return res;
  } catch (err) {
    return networkError(err);
  }
}

/** Правка: сервер сам доведёт её до нанятых копий в этом офисе. */
export async function updateMyAgent(name: string, patch: Partial<MyAgentDraft>): Promise<SaveResult> {
  try {
    const { code, data } = await send('PUT', `/api/my-agents/${encodeURIComponent(name)}${officeQuery()}`, { patch });
    const res = toResult(code, data);
    if (res.ok) void loadMyAgents();
    return res;
  } catch (err) {
    return networkError(err);
  }
}

/** Заготовка формы из роли офиса — для «Создать на основе». Вернёт черновик или текст отказа. */
export async function draftFromRole(roleId: string): Promise<{ draft: MyAgentDraft } | { error: string }> {
  try {
    const { code, data } = await send('GET', `/api/my-agents/draft${officeQuery(`roleId=${encodeURIComponent(roleId)}`)}`);
    if (code === 200 && data.draft) return { draft: data.draft as MyAgentDraft };
    const errors = data.errors as FieldError[] | undefined;
    return { error: errors?.[0]?.message ?? String(data.error ?? `HTTP ${code}`) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Удалить своего агента из офиса. Вернёт текст отказа или null. */
export async function deleteMyAgent(name: string): Promise<FieldError[] | null> {
  try {
    const { code, data } = await send('DELETE', `/api/my-agents/${encodeURIComponent(name)}${officeQuery()}`);
    if (code >= 200 && code < 300) { void loadMyAgents(); return null; }
    const errors = data.errors as FieldError[] | undefined;
    return errors?.length ? errors : [{ field: '', message: String(data.error ?? `HTTP ${code}`) }];
  } catch (err) {
    return networkError(err).ok ? null : (networkError(err) as { errors: FieldError[] }).errors;
  }
}

/** Роль — копия своего агента: пакет в области `@local`. */
export const isLocalPackage = (name: string | undefined): boolean => Boolean(name?.startsWith('@local/'));

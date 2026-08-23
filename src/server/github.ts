/**
 * Пулл-реквесты на GitHub. Нужны ровно там, где у офиса есть и origin на
 * github.com, и токен с правом записи: тогда конвейер ревью виден снаружи —
 * ветка уезжает в репозиторий, PR открывается и мержится по-настоящему.
 *
 * Без токена или без такой удалёнки конвейер работает целиком локально
 * (см. review.ts): пулл-реквест остаётся сущностью офиса, а слияние идёт
 * обычным git merge. Это не запасной путь «на случай поломки», а полноправный
 * режим: офис умеет работать в репозитории, которого нет ни на каком сервере.
 */
import { githubToken } from './cloud';
import { remoteUrl } from './git';

export interface GithubRepo {
  owner: string;
  repo: string;
  token: string;
}

/** owner/repo из URL origin. Понимает и https, и ssh-форму. */
export function parseRepo(url: string): { owner: string; repo: string } | null {
  const clean = url.trim().replace(/\.git$/, '');
  const m = /^(?:https:\/\/(?:[^@/]*@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+)$/
    .exec(clean);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Готов ли репозиторий к настоящим пулл-реквестам. null — нет: значит,
 * конвейер поедет локально, и это нормальный исход, а не ошибка.
 */
export async function githubFor(repoDir: string): Promise<GithubRepo | null> {
  const token = githubToken();
  if (!token) return null;
  const url = await remoteUrl(repoDir);
  if (!url) return null;
  const parsed = parseRepo(url);
  return parsed ? { ...parsed, token } : null;
}

interface ApiResult<T> {
  ok: boolean;
  data: T | null;
  /** Готовая к показу причина отказа. Пусто, когда всё прошло. */
  error: string;
}

async function api<T>(
  gh: GithubRepo, method: string, path: string, body?: unknown,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${gh.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'ai-office',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) as T & { message?: string } : null;
    if (!res.ok) {
      const message = (data as { message?: string } | null)?.message ?? res.statusText;
      return { ok: false, data: null, error: `GitHub ${res.status}: ${message}` };
    }
    return { ok: true, data, error: '' };
  } catch (err) {
    return { ok: false, data: null, error: `GitHub недоступен: ${(err as Error).message}` };
  }
}

export interface PrRef {
  number: number;
  url: string;
}

/**
 * Открыть пулл-реквест. Если для этой ветки он уже открыт (повторный заход
 * конвейера после перезапуска), возвращаем существующий, а не плодим второй.
 */
export async function createPullRequest(
  gh: GithubRepo, input: { head: string; base: string; title: string; body: string },
): Promise<ApiResult<PrRef>> {
  const open = await api<Array<{ number: number; html_url: string }>>(
    gh, 'GET', `/pulls?state=open&head=${encodeURIComponent(`${gh.owner}:${input.head}`)}`,
  );
  const found = open.data?.[0];
  if (found) return { ok: true, data: { number: found.number, url: found.html_url }, error: '' };

  const created = await api<{ number: number; html_url: string }>(gh, 'POST', '/pulls', {
    head: input.head, base: input.base, title: input.title, body: input.body,
  });
  if (!created.ok || !created.data) return { ok: false, data: null, error: created.error };
  return { ok: true, data: { number: created.data.number, url: created.data.html_url }, error: '' };
}

/** Отзыв ревьюера — обычным комментарием: он виден в обсуждении PR. */
export async function commentOnPr(
  gh: GithubRepo, number: number, text: string,
): Promise<ApiResult<unknown>> {
  return api(gh, 'POST', `/issues/${number}/comments`, { body: text });
}

/**
 * Влить пулл-реквест. Слияние merge-коммитом, а не squash: история офиса
 * и так устроена merge-коммитами на задачу, и терять её незачем.
 */
export async function mergePullRequest(
  gh: GithubRepo, number: number, title: string,
): Promise<ApiResult<{ sha: string }>> {
  return api<{ sha: string }>(gh, 'PUT', `/pulls/${number}/merge`, {
    merge_method: 'merge', commit_title: title,
  });
}

/** Закрыть пулл-реквест, не вливая: задачу отменили или переделывают с нуля. */
export async function closePullRequest(
  gh: GithubRepo, number: number,
): Promise<ApiResult<unknown>> {
  return api(gh, 'PATCH', `/pulls/${number}`, { state: 'closed' });
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { КаталогCodex, МодельCodex } from '../../shared/codex';
import { codexBinary, runtimeEnv } from './codex';
import { CodexRpc } from './rpc';

type Соединение = Pick<CodexRpc, 'request' | 'send' | 'close'>;
const объект = (значение: unknown): значение is Record<string, unknown> =>
  значение !== null && typeof значение === 'object' && !Array.isArray(значение);
const строка = (значение: unknown): значение is string => typeof значение === 'string' && значение.length > 0;

function разобратьМодель(значение: unknown): МодельCodex {
  if (!объект(значение) || !строка(значение.model) || !строка(значение.displayName)
    || typeof значение.hidden !== 'boolean' || typeof значение.isDefault !== 'boolean'
    || !строка(значение.defaultReasoningEffort) || !Array.isArray(значение.supportedReasoningEfforts)
    || !значение.supportedReasoningEfforts.every(усилие => объект(усилие)
      && строка(усилие.reasoningEffort) && typeof усилие.description === 'string')) {
    throw new Error('Некорректная модель Codex');
  }
  const усилия = значение.supportedReasoningEfforts as МодельCodex['supportedReasoningEfforts'];
  if (!усилия.some(усилие => усилие.reasoningEffort === значение.defaultReasoningEffort)) {
    throw new Error('Умолчание усилий отсутствует в каталоге Codex');
  }
  return {
    id: значение.model, label: значение.displayName,
    supportedReasoningEfforts: усилия.map(({ reasoningEffort, description }) => ({ reasoningEffort, description })),
    defaultReasoningEffort: значение.defaultReasoningEffort, isDefault: значение.isDefault,
  };
}

/** Только метаданные app-server: без thread/start, хода модели и резервных списков. */
export async function каталогCodex(
  соединиться: () => Соединение = () => new CodexRpc(codexBinary(), process.cwd(), runtimeEnv()),
): Promise<КаталогCodex> {
  let соединение: Соединение | undefined;
  try {
    соединение = соединиться();
    await соединение.request('initialize', {
      clientInfo: { name: 'ai-office', version: '1.0.0' }, capabilities: { experimentalApi: true },
    }, 10_000);
    соединение.send({ method: 'initialized' });
    const models: МодельCodex[] = [];
    const курсоры = new Set<string>();
    let cursor: string | undefined;
    do {
      if (курсоры.size >= 100) throw new Error('Слишком много страниц каталога Codex');
      const страница: unknown = await соединение.request('model/list', { cursor, limit: 100, includeHidden: false }, 10_000);
      if (!объект(страница) || !Array.isArray(страница.data)
        || !(страница.nextCursor === null || строка(страница.nextCursor))) {
        throw new Error('Некорректная страница каталога Codex');
      }
      for (const запись of страница.data) {
        const модель = разобратьМодель(запись);
        if (!(запись as Record<string, unknown>).hidden) models.push(модель);
      }
      cursor = страница.nextCursor ?? undefined;
      if (cursor && курсоры.has(cursor)) throw new Error('Повтор курсора каталога Codex');
      if (cursor) курсоры.add(cursor);
    } while (cursor);
    return { ok: true, models };
  } catch {
    // Ошибки процесса могут содержать окружение и пути владельца.
    return { ok: false, code: 'catalog-unavailable', message: 'Не удалось получить каталог установленного Codex. Проверьте установку, вход и доступ к сервису.' };
  } finally { соединение?.close(); }
}

/** Отдельная фабрика для адресной проверки HTTP без порта и живого движка. */
export function создатьHttpКаталогаCodex(получить: () => Promise<КаталогCodex> = каталогCodex) {
  return (запрос: IncomingMessage, ответ: ServerResponse, путь: string): boolean => {
    if (путь !== '/api/providers/codex/models') return false;
    const json = (статус: number, тело: КаталогCodex | { error: string }) => {
      ответ.writeHead(статус, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      ответ.end(JSON.stringify(тело));
    };
    if ((запрос.method ?? 'GET') !== 'GET') {
      ответ.setHeader('Allow', 'GET');
      json(405, { error: 'Используйте GET' });
      return true;
    }
    void получить().then(каталог => json(каталог.ok ? 200 : 502, каталог));
    return true;
  };
}

export const обработатьHttpКаталогаCodex = создатьHttpКаталогаCodex();

/** HTTP-доступ к каталогу T-797; не сохраняет настройки и не запускает сессии. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ModelChoice, ProviderStatus } from '../../shared/providers';
import { engineFor } from '../engines';
import { каталогOpenCode, моделиКаталога, проверитьВыбор, ОшибкаOpenCode } from './подключение-opencode';

type Зависимости = {
  найти: () => Promise<{ version: string } | null>;
  каталог: typeof каталогOpenCode;
};
const ошибкаФормы = (сообщение: string, поле?: string): never => {
  throw new ОшибкаOpenCode(400, 'invalid-choice', сообщение, поле);
};
const объект = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Строгое тело: сообщения не включают присланные значения и неизвестные имена. */
async function прочитатьВыбор(req: IncomingMessage): Promise<{ выбор: ModelChoice; ревизия: string }> {
  const части: Buffer[] = [];
  let размер = 0;
  for await (const часть of req) {
    const буфер = Buffer.isBuffer(часть) ? часть : Buffer.from(часть);
    размер += буфер.length;
    if (размер > 64 * 1024) ошибкаФормы('Тело запроса превышает 64 КиБ');
    части.push(буфер);
  }
  // Символ UTF-8 может пересекать границу сетевых чанков.
  const текст = Buffer.concat(части, размер).toString('utf8');
  let тело: unknown;
  try { тело = JSON.parse(текст); } catch { ошибкаФормы('Ожидается корректный JSON'); }
  if (!объект(тело) || Object.keys(тело).some(k => !['выбор', 'ревизия'].includes(k))) ошибкаФормы('Ожидаются выбор и ревизия');
  const { выбор, ревизия } = тело as Record<string, unknown>;
  if (typeof ревизия !== 'string' || !ревизия || ревизия.length > 200) ошибкаФормы('Укажите ревизию каталога', 'ревизия');
  if (!объект(выбор) || Object.keys(выбор).some(k => !['provider', 'model', 'opencode'].includes(k))) ошибкаФормы('Ожидается объект выбора модели', 'выбор');
  const v = выбор as Record<string, unknown>;
  if (v.provider !== 'opencode') ошибкаФормы('Ожидается провайдер opencode', 'provider');
  if (typeof v.model !== 'string' || !v.model || v.model.length > 1000) ошибкаФормы('Укажите полную модель провайдер/модель', 'model');
  if ('opencode' in v && (!объект(v.opencode) || Object.keys(v.opencode).some(k => !['температура', 'пределОтвета', 'вариант'].includes(k)))) {
    ошибкаФормы('Ожидается объект поддерживаемых параметров', 'opencode');
  }
  return { выбор: v as unknown as ModelChoice, ревизия: ревизия as string };
}

/** Фабрика позволяет проверять HTTP без живого процесса и локального порта. */
export function создатьHttpOpenCode(зависимости: Зависимости) {
  return (req: IncomingMessage, res: ServerResponse, url: string, query: string): boolean => {
    if (url !== '/api/providers/opencode' && url !== '/api/providers/opencode/validate') return false;
    const json = (статус: number, тело: unknown) => {
      res.writeHead(статус, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(тело));
    };
    const проверка = url.endsWith('/validate');
    if ((req.method ?? 'GET') !== (проверка ? 'POST' : 'GET')) {
      json(405, { код: 'method-not-allowed', сообщение: проверка ? 'Используйте POST' : 'Используйте GET' });
      return true;
    }
    void (async () => {
      const тело = проверка ? await прочитатьВыбор(req) : undefined;
      const движок = await зависимости.найти();
      if (!движок) throw new ОшибкаOpenCode(503, 'not-installed', 'Движок OpenCode не установлен');
      const снимок = await зависимости.каталог(движок.version, new URLSearchParams(query).get('force') === '1');
      if (!снимок.dto.совместима) throw new ОшибкаOpenCode(503, 'incompatible-version', 'Версия OpenCode не проверена офисом');
      if (тело) {
        const выбор = проверитьВыбор(тело.выбор, снимок, тело.ревизия);
        json(200, { выбор, предупреждения: [], ревизия: снимок.dto.ревизия });
        return;
      }
      const models = моделиКаталога(снимок);
      const status: ProviderStatus = снимок.dto.устарел
        ? { state: 'unreachable', detail: 'Каталог устарел; обновите модели' }
        : models.length ? { state: 'ready', auth: models.some(m => снимок.dto.провайдеры.some(p =>
          p.id === m.opencode?.провайдер && p.авторизация.состояние === 'ключ')) ? 'api-key' : 'none' }
        : { state: 'needs-login', auth: ['api-key'] };
      json(200, { status, models, opencode: снимок.dto });
    })().catch((ошибка: unknown) => {
      // Только ошибки контролируемого слоя каталога; произвольный upstream не раскрываем.
      if (ошибка instanceof ОшибкаOpenCode) {
        json(ошибка.статус, { код: ошибка.код, ...(ошибка.поле ? { поле: ошибка.поле } : {}), сообщение: ошибка.message });
      } else json(502, { код: 'upstream', сообщение: 'Не удалось получить метаданные OpenCode' });
    });
    return true;
  };
}

export const handleOpenCodeHttp = создатьHttpOpenCode({
  найти: () => engineFor('opencode').locate(),
  каталог: каталогOpenCode,
});

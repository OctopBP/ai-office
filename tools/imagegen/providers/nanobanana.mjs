/**
 * Провайдер nanobananaapi.ai — сторонний перепродавец моделей Nano Banana.
 * Документация: https://docs.nanobananaapi.ai/
 *
 * Почему он первый. Прямой путь к тем же моделям у проекта уже есть
 * (`tools/props/lib/gemini.mjs`), но он упирается в биллинг Google: на free
 * tier квота image-моделей равна нулю. Здесь ключ покупается отдельно и
 * работает сразу — то есть это не «ещё один такой же», а тот же результат
 * без чужого биллинга.
 *
 * Работа асинхронная: запрос заводит задачу и отдаёт `taskId`, готовые
 * картинки забираются опросом. Колбэк API тоже умеет, но офис за адресом в
 * интернете не стоит и слушать его некому.
 */

const BASE = () => (process.env.NANOBANANA_BASE_URL || 'https://api.nanobananaapi.ai').replace(/\/+$/, '');

/**
 * Куда провайдер обещает постучаться, когда картинка готова. Поле в API
 * обязательное, а ждать колбэк нам негде — поэтому по умолчанию адрес в
 * зарезервированной зоне `.invalid` (RFC 2606): он не резолвится ни у кого и
 * никогда, то есть уведомление гарантированно уходит в никуда, а не чужому
 * хосту. Свой адрес задаётся `NANOBANANA_CALLBACK_URL`, если однажды будет
 * кому его слушать.
 */
const callbackUrl = () => process.env.NANOBANANA_CALLBACK_URL || 'https://example.invalid/nanobanana';

/**
 * Значения `type` записаны с опечаткой в самом API: `TEXTTOIAMGE` вместо
 * `TEXTTOIMAGE`. Это не наша описка — так в документации и так принимает
 * сервер; исправив её «по-хорошему», мы получили бы 400.
 */
const TYPE = { text: 'TEXTTOIAMGE', edit: 'IMAGETOIAMGE' };

/** Статусы задачи из документации: числом, а не строкой. */
const FLAG = { working: 0, done: 1, createFailed: 2, generateFailed: 3 };

function key() {
  const value = (process.env.NANOBANANA_API_KEY || '').trim();
  if (!value) {
    throw new Error(
      'NANOBANANA_API_KEY не задан. Ключ берётся с https://nanobananaapi.ai/api-key '
      + 'и кладётся в окружение сервера офиса, а не в настройки офиса: настройки уезжают на фронт.');
  }
  return value;
}

/** Запрос к API с разбором двух слоёв ошибок: HTTP и `code` в теле. */
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path}: ответ не JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  // Сервис отвечает 200 с кодом ошибки внутри тела не реже, чем честным
  // статусом, поэтому смотрим и то, и другое.
  const code = Number(json?.code ?? res.status);
  if (!res.ok || code !== 200) {
    throw new Error(`${path}: ${code} ${json?.msg || res.statusText || 'ошибка'}`);
  }
  return json.data;
}

/**
 * Ссылки на картинки из ответа. Документация показывает одну
 * (`resultImageUrl`), но при `numImages > 1` их должно быть несколько —
 * поэтому собираем и одиночное поле, и всё, что похоже на список.
 * `originImageUrl` не берём: он живёт десять минут и умрёт раньше, чем
 * человек посмотрит на результат.
 */
function urlsOf(response) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && /^https?:\/\//.test(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(push);
  };
  push(response?.resultImageUrl);
  push(response?.resultImageUrls);
  push(response?.resultUrls);
  push(response?.images);
  return [...new Set(out)];
}

/** @type {import('./index.mjs').Provider} */
export const nanobanana = {
  id: 'nanobanana',
  title: 'NanoBanana API',
  keyEnv: 'NANOBANANA_API_KEY',
  aspects: ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'],
  maxCount: 4,
  // Исходники для правки принимаются только ссылками: эндпоинта загрузки
  // файла у сервиса нет вовсе. Значит, «поправь вот этот локальный png»
  // этим провайдером не делается, и врать об этом в описании инструмента
  // дороже, чем отказать сразу.
  refs: 'url',

  async start({ prompt, aspect, count = 1, refUrls = [] }) {
    const edit = refUrls.length > 0;
    const data = await call('/api/v1/nanobanana/generate', {
      method: 'POST',
      body: {
        prompt,
        type: edit ? TYPE.edit : TYPE.text,
        callBackUrl: callbackUrl(),
        numImages: Math.max(1, Math.min(4, Math.round(count))),
        ...(aspect ? { image_size: aspect } : {}),
        ...(edit ? { imageUrls: refUrls } : {}),
      },
    });
    const taskId = String(data?.taskId ?? '');
    if (!taskId) throw new Error('API не вернул taskId');
    return { taskId };
  },

  async poll(taskId) {
    const data = await call(`/api/v1/nanobanana/record-info?taskId=${encodeURIComponent(taskId)}`);
    const flag = Number(data?.successFlag ?? FLAG.working);
    if (flag === FLAG.done) {
      const urls = urlsOf(data?.response);
      if (!urls.length) return { state: 'failed', error: 'задача успешна, но ссылок на картинки в ответе нет' };
      return { state: 'done', images: urls.map((url) => ({ url })) };
    }
    if (flag === FLAG.createFailed || flag === FLAG.generateFailed) {
      const why = data?.errorMessage || data?.response?.errorMessage || `код ${data?.errorCode ?? flag}`;
      return { state: 'failed', error: String(why) };
    }
    return { state: 'working' };
  },

  async credits() {
    const data = await call('/api/v1/common/credit');
    return `${data} кредитов`;
  },
};

/**
 * Провайдер Gemini — image-модели Google напрямую, по HTTP.
 *
 * Он здесь не «на всякий случай», а чтобы контракт провайдера был проверен
 * двумя непохожими API, а не подогнан под одно. Различий ровно два, и оба
 * важные: Gemini отвечает синхронно (картинка приходит байтами в том же
 * ответе, опрашивать нечего) и принимает исходники для правки файлами, а не
 * ссылками. Абстракция, которая этого не выдерживает, — не абстракция.
 *
 * Пакет `@google/genai` не берётся намеренно: `tools/props` тянет его ради
 * своего пайплайна, а серверу офиса нужен один запрос, и лишняя зависимость
 * в процессе, который поднимается на каждую сессию, стоит дороже, чем
 * тридцать строк fetch.
 *
 * Ключ тот же, что у `tools/props` (GEMINI_API_KEY), и ограничение то же:
 * на free tier квота image-моделей равна нулю, нужен проект с биллингом.
 */
import { readFile } from 'node:fs/promises';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const model = () => process.env.IMAGEGEN_GEMINI_MODEL || 'gemini-3.1-flash-image';

/**
 * Синхронный ответ в асинхронном контракте: результат кладётся сюда под
 * выданным номером, и `poll` его просто забирает. Карта живёт в памяти
 * процесса — сервер поднимается на сессию и умирает вместе с ней, так что
 * пережить его результату всё равно нечем.
 */
const ready = new Map();
let counter = 0;

function key() {
  const value = (process.env.GEMINI_API_KEY || '').trim();
  if (!value) {
    throw new Error(
      'GEMINI_API_KEY не задан. Ключ берётся с https://aistudio.google.com/apikey '
      + 'и кладётся в окружение сервера офиса.');
  }
  return value;
}

const mimeOf = (path) => (/\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png');

/** @type {import('./index.mjs').Provider} */
export const gemini = {
  id: 'gemini',
  title: 'Google Gemini',
  keyEnv: 'GEMINI_API_KEY',
  aspects: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  // За один запрос модель отдаёт одну картинку: несколько вариантов — это
  // несколько запросов, и делает их вызывающий, а не провайдер.
  maxCount: 1,
  refs: 'file',

  async start({ prompt, aspect, refPaths = [] }) {
    const parts = [{ text: prompt }];
    for (const path of refPaths) {
      parts.push({ inline_data: { mime_type: mimeOf(path), data: (await readFile(path)).toString('base64') } });
    }
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model())}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          ...(aspect ? { imageConfig: { aspectRatio: aspect } } : {}),
        },
      }),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Gemini: ответ не JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const why = json?.error?.message || res.statusText;
      // Нулевая квота — не «попробуйте позже», а «включите биллинг»: без
      // этой подсказки роль будет повторять запрос до конца лимита ходов.
      const hint = /free_tier[a-z_]*.*limit: 0|limit: 0.*free_tier/is.test(String(why))
        ? ' Квота image-моделей на free tier равна нулю: нужен проект с биллингом (https://aistudio.google.com/apikey → Set up billing).'
        : '';
      throw new Error(`Gemini: ${res.status} ${why}.${hint}`);
    }

    const found = (json?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.inlineData ?? p.inline_data)
      .find((d) => d?.data);
    counter += 1;
    const taskId = `gemini-${counter}`;
    if (!found) {
      const said = (json?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join(' ');
      ready.set(taskId, { state: 'failed', error: `в ответе нет изображения${said ? `: ${said.slice(0, 200)}` : ''}` });
    } else {
      ready.set(taskId, {
        state: 'done',
        images: [{ data: Buffer.from(found.data, 'base64'), mime: found.mimeType ?? found.mime_type ?? 'image/png' }],
      });
    }
    // Отдаём результат сразу вместе с номером: опрос синхронного провайдера
    // был бы лишним ходом на ровном месте.
    return { taskId, done: ready.get(taskId) };
  },

  async poll(taskId) {
    return ready.get(taskId) ?? { state: 'failed', error: `задачи ${taskId} нет: у Gemini результат живёт только в этой сессии` };
  },
};

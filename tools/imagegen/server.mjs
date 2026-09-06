#!/usr/bin/env node
/**
 * MCP-сервер «Генератор картинок»: то, чего нет у самого Claude Code, —
 * умение нарисовать картинку. Подключается ролям каталогом офиса
 * (`src/server/mcp.ts`), по умолчанию — иллюстратору.
 *
 * Три инструмента, и деление между ними не случайное:
 *
 *   generate_image      завести задачу, дождаться и сохранить файлы
 *   get_image_task      забрать задачу, которая не успела за отведённое время
 *   get_image_providers что вообще подключено и с каким ключом
 *
 * Ожидание внутри одного вызова ограничено: у MCP свой потолок на вызов
 * инструмента, и упереться в него значит потерять уже оплаченную картинку.
 * Поэтому, не дождавшись, инструмент отдаёт `task_id` и просит забрать
 * результат отдельно — а не молчит, пока его не оборвут.
 *
 * Читающие имена (`get_*`) выбраны не для красоты: разбор рисков офиса
 * (`src/server/permissions.ts`) считает их безопасными по префиксу, и
 * спрашивать человека про «сколько осталось кредитов» было бы издевательством.
 *
 * Запускается обычным node без сборки и загрузчиков — сервер поднимается на
 * каждую сессию, и лишний слой здесь стоит секунд старта на пустом месте.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PROVIDERS, hasKey, providerBy } from './providers/index.mjs';
import { saveImages, workdir } from './save.mjs';

/** Сколько ждать картинку внутри одного вызова и как часто спрашивать. */
const WAIT_MS = Number(process.env.IMAGEGEN_WAIT_MS || 55_000);
const STEP_MS = Number(process.env.IMAGEGEN_POLL_MS || 3_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

/** Ждать задачу до потолка. Не дождались — это не ошибка, а «ещё рисуется». */
async function waitFor(provider, taskId, done) {
  let progress = done ?? { state: 'working' };
  const until = Date.now() + WAIT_MS;
  while (progress.state === 'working' && Date.now() < until) {
    await sleep(STEP_MS);
    progress = await provider.poll(taskId);
  }
  return progress;
}

/** Итог задачи в ответ инструмента: одинаковый и у generate_image, и у get_image_task. */
async function report(provider, taskId, progress, path) {
  if (progress.state === 'failed') return fail(`Провайдер ${provider.id} не нарисовал: ${progress.error}`);
  if (progress.state === 'working') {
    return text(`Ещё рисуется. Задача ${taskId} у провайдера ${provider.id}: забери её вызовом `
      + `get_image_task({ task_id: "${taskId}", provider: "${provider.id}", path: "${path}" }).`);
  }
  const saved = await saveImages(progress.images, path);
  return text(`Готово: ${saved.join(', ')}. Пути от корня рабочей копии. `
    + 'Посмотреть, что вышло, можно инструментом Read — он открывает картинки.');
}

const TOOLS = [
  {
    name: 'generate_image',
    description:
      'Нарисовать картинку по описанию и сохранить её файлом в рабочей копии. '
      + 'Возвращает пути сохранённых файлов. Если провайдер не успел за отведённое время, '
      + 'возвращает task_id для get_image_task.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Что нарисовать. Чем конкретнее, тем ближе к задуманному.' },
        path: {
          type: 'string',
          description: 'Куда сохранить, от корня рабочей копии, например design/images/hero.png. '
            + 'Несколько вариантов лягут как hero.png, hero-2.png. Писать можно только внутри рабочей копии.',
        },
        aspect: { type: 'string', description: 'Соотношение сторон, например 1:1, 16:9, 3:4. Список — в get_image_providers.' },
        count: { type: 'number', description: 'Сколько вариантов (по умолчанию 1).' },
        ref_urls: {
          type: 'array', items: { type: 'string' },
          description: 'Ссылки на исходные картинки — режим правки. Работает у провайдеров с refs: url.',
        },
        ref_paths: {
          type: 'array', items: { type: 'string' },
          description: 'Локальные исходные картинки — режим правки. Работает у провайдеров с refs: file.',
        },
        provider: { type: 'string', description: 'Каким провайдером рисовать. Пусто — тем, что настроен по умолчанию.' },
      },
      required: ['prompt', 'path'],
    },
  },
  {
    name: 'get_image_task',
    description: 'Забрать картинку по задаче, заведённой раньше: дождаться и сохранить файлом.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Номер задачи из ответа generate_image.' },
        path: { type: 'string', description: 'Куда сохранить, от корня рабочей копии.' },
        provider: { type: 'string', description: 'Тот же провайдер, что заводил задачу.' },
      },
      required: ['task_id', 'path'],
    },
  },
  {
    name: 'get_image_providers',
    description: 'Какие генераторы картинок подключены: есть ли ключ, какие соотношения сторон и сколько вариантов за запрос.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new Server({ name: 'imagegen', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  try {
    if (req.params.name === 'get_image_providers') {
      const lines = PROVIDERS.map((p) => {
        const key = hasKey(p) ? `ключ ${p.keyEnv} есть` : `КЛЮЧА НЕТ (${p.keyEnv})`;
        return `${p.id} — ${p.title}: ${key}; до ${p.maxCount} за запрос; `
          + `исходники ${p.refs === 'url' ? 'ссылками' : p.refs === 'file' ? 'файлами' : 'не принимает'}; `
          + `стороны ${p.aspects.join(' ')}`;
      });
      const active = providerBy();
      return text(`Рабочая копия: ${workdir()}\nПо умолчанию: ${active.id}\n${lines.join('\n')}`);
    }

    if (req.params.name === 'generate_image') {
      const provider = providerBy(args.provider);
      if (!hasKey(provider)) {
        return fail(`У провайдера ${provider.id} нет ключа: переменная ${provider.keyEnv} не задана в окружении сервера офиса. `
          + 'Это чинит человек, а не роль — так и напиши в отчёте.');
      }
      const refUrls = args.ref_urls ?? [];
      const refPaths = args.ref_paths ?? [];
      // Отказываем сразу, а не после оплаченного запроса: провайдер, который
      // не умеет исходники, просто нарисует не то, и понять это будет не по чем.
      if (refUrls.length && provider.refs !== 'url') {
        return fail(`Провайдер ${provider.id} не принимает исходники ссылками (refs: ${provider.refs}).`);
      }
      if (refPaths.length && provider.refs !== 'file') {
        return fail(`Провайдер ${provider.id} не принимает исходники файлами (refs: ${provider.refs}). `
          + 'Ему нужна ссылка на картинку в интернете.');
      }
      const count = Math.max(1, Math.min(provider.maxCount, Math.round(Number(args.count) || 1)));
      const { taskId, done } = await provider.start({
        prompt: String(args.prompt), aspect: args.aspect, count, refUrls, refPaths,
      });
      return await report(provider, taskId, await waitFor(provider, taskId, done), String(args.path));
    }

    if (req.params.name === 'get_image_task') {
      const provider = providerBy(args.provider);
      const taskId = String(args.task_id);
      return await report(provider, taskId, await waitFor(provider, taskId), String(args.path));
    }

    return fail(`Нет такого инструмента: ${req.params.name}`);
  } catch (err) {
    // Отказ инструмента — обычное событие для роли: она прочитает причину и
    // решит, что делать. Падение процесса оставило бы её без сервера до конца
    // сессии, а причину — в чужом логе.
    return fail(String(err?.message ?? err));
  }
});

await server.connect(new StdioServerTransport());

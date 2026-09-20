import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { entryOf, parsePreset } from './src/shared/preset';
import { LOOK_ID, parseLooks } from './src/shared/look';
import { writeJson } from './scripts/_json';

/**
 * Запись чисел подгонки из стенда (`?fit=1`) в `design/fit.json`.
 *
 * Только в деве: стенд — инструмент разработки, в собранном офисе его нет, и
 * маршрута для записи в ассеты там быть не должно. Путь захардкожен один —
 * плагин не «пиши куда скажут», а «сохрани подгонку».
 *
 * После записи vite сам заметит изменившийся файл и перезагрузит страницу с
 * новыми умолчаниями — отдельного уведомления клиенту не нужно.
 */
/**
 * Разложить числа в читаемый JSON — и подгонку, и пресеты.
 *
 * Обычный `JSON.stringify` с отступом ставит каждый элемент массива на свою
 * строку, и координата `[0, 0.1, 0]` занимает пять строк вместо одной. Файл
 * этот читают и правят руками не реже, чем ползунком, поэтому короткие
 * числовые массивы схлопываются обратно в строку.
 */
function format(data: unknown): string {
  const text = JSON.stringify(data, null, 2);
  return `${text.replace(/\[[\s\d.,+-]*?\]/g, (m) => m.replace(/\s+/g, ' ').replace('[ ', '[').replace(' ]', ']'))}\n`;
}

function fitWriter(): Plugin {
  const file = resolve(import.meta.dirname, 'design/fit.json');
  return {
    name: 'office-fit-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__fit', (req, res, next) => {
        if (req.method !== 'POST') return next();
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let text: string;
          try {
            // Разбираем перед записью: испорченный JSON на диске уронил бы
            // приложение при следующей загрузке, а ошибку видно только тут.
            text = format(JSON.parse(body) as unknown);
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
            return;
          }
          writeFile(file, text, 'utf8').then(
            () => { res.statusCode = 204; res.end(); },
            (e: unknown) => { res.statusCode = 500; res.end(String(e)); },
          );
        });
      });
    },
  };
}

/**
 * Пересобрать запись предмета в каталоге.
 *
 * `catalog.json` — сборка из пресетов (спека §8), и обычно её пересобирают
 * скриптом `npm run presets:catalog -- --write`. Но стенд обещает, что в
 * комнату уедет ровно то, что он показал, а комната берёт места, след и
 * проходимость как раз из каталога: записав пресет и не тронув каталог, стенд
 * оставил бы диван с тремя подушками, а комнату — с двумя. Пересборка одной
 * записи эту ложь снимает; полная сверка остаётся за скриптом.
 *
 * Пресет здесь заодно разбирается схемой — не ради каталога, а ради самого
 * файла: испорченное описание на диске уронило бы офис при следующей загрузке.
 * Формат каталога тот же, которым пишет скрипт (`writeJson`), поэтому диф в
 * гите получается ровно на изменившиеся строки.
 */
async function syncCatalog(file: string, id: string, data: unknown): Promise<void> {
  const { preset } = parsePreset(data, `presets/${id}`);
  const catalog = JSON.parse(await readFile(file, 'utf8')) as { sprites: Record<string, unknown> };
  catalog.sprites[id] = entryOf(preset);
  catalog.sprites = Object.fromEntries(
    Object.entries(catalog.sprites).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  await writeFile(file, writeJson(catalog), 'utf8');
}

/**
 * Запись пресета предмета из стенда в `design/presets/<id>/preset.json`.
 *
 * Отдельный маршрут от `/__fit`, потому что и файлы разные: подгонка фигуры
 * общая, а всё про предмет принадлежит предмету. Разделять их обратно в один
 * файл значило бы вернуть то, ради ухода от чего пресеты и заводились.
 *
 * `id` берётся из адреса и проверяется тем же образцом, что и схема
 * (`^[a-z0-9_]+$`): в путь к файлу он попадает напрямую, и «пиши куда скажут»
 * из браузера — не то, что должен уметь дев-сервер.
 */
function presetWriter(): Plugin {
  const dir = resolve(import.meta.dirname, 'design/presets');
  const catalog = resolve(import.meta.dirname, 'design/sprites/out/catalog.json');
  return {
    name: 'office-preset-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__preset', (req, res, next) => {
        if (req.method !== 'POST') return next();
        const id = (req.url ?? '').replace(/^\//, '').split('?')[0];
        if (!/^[a-z0-9_]+$/.test(id)) {
          res.statusCode = 400;
          res.end(`недопустимый id: ${id}`);
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let data: unknown;
          let text: string;
          try {
            data = JSON.parse(body) as { id?: unknown };
            // Пресет, записанный не в свою папку, ловится потом сверкой, но
            // ловить его лучше здесь: диагноз понятнее, а файла ещё нет.
            if ((data as { id?: unknown }).id !== id) {
              throw new Error(`id внутри — «${String((data as { id?: unknown }).id)}»`);
            }
            text = format(data);
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
            return;
          }
          // Каталог пересобирается после файла, а не вместо него: пресет —
          // источник, каталог — его сборка, и порядок между ними такой же.
          writeFile(resolve(dir, id, 'preset.json'), text, 'utf8')
            .then(() => syncCatalog(catalog, id, data))
            .then(
              () => { res.statusCode = 204; res.end(); },
              (e: unknown) => { res.statusCode = 500; res.end(String(e)); },
            );
        });
      });
    },
  };
}

/**
 * Стенд скинов (`?skins=1`): файлы персонажа и список внешностей.
 *
 * Скин — это png в `design/models/characters/skins/`, список — `looks.json`
 * рядом. Стенд читает и то и другое живьём, а не через импорт: после
 * загрузки нового файла или замены старого картинка нужна сразу, не дожидаясь,
 * пока vite заметит файл и перезагрузит страницу (он заметит и перезагрузит —
 * но стенд не должен от этого зависеть, чтобы правку списка не терять).
 *
 * Маршруты — под одним префиксом, и каждый делает одно:
 *   GET    /__skins                 — снимок: файлы (размер, габарит, время) и список как есть;
 *   GET    /__skins/file/<id>.png   — сам файл, без кеша;
 *   PUT    /__skins/file/<id>.png   — положить или заменить файл (тело — png целиком);
 *   DELETE /__skins/file/<id>.png   — удалить файл и вычеркнуть из списка;
 *   PUT    /__skins/registry        — записать список.
 *
 * Список перед записью разбирается схемой (`parseLooks`) и сверяется с
 * папкой: запись без файла в комнате — это агент без текстуры. Имя файла
 * проверяется тем же образцом, что и схема: оно попадает в путь.
 */
function skinsBench(): Plugin {
  const dir = resolve(import.meta.dirname, 'design/models/characters/skins');
  const registryFile = resolve(dir, 'looks.json');
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  class Reject extends Error { constructor(public status: number, message: string) { super(message); } }
  const body = (req: IncomingMessage): Promise<Buffer> => new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
  const pngNames = async () => (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
  const readRegistry = async () => JSON.parse(await readFile(registryFile, 'utf8')) as unknown;

  async function snapshot() {
    const files = await Promise.all((await pngNames()).map(async (name) => {
      const [buf, s] = await Promise.all([readFile(resolve(dir, name)), stat(resolve(dir, name))]);
      const png = buf.subarray(0, 8).equals(PNG);
      return {
        id: name.slice(0, -4), size: s.size, mtime: Math.round(s.mtimeMs),
        width: png ? buf.readUInt32BE(16) : 0, height: png ? buf.readUInt32BE(20) : 0,
      };
    }));
    return { files, registry: await readRegistry() };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
    const method = req.method ?? 'GET';
    if (path === '' && method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(await snapshot()));
      return true;
    }
    if (path === 'registry' && method === 'PUT') {
      let looks;
      try { looks = parseLooks(JSON.parse((await body(req)).toString('utf8'))); } catch (e) { throw new Reject(400, String(e)); }
      const names = await pngNames();
      const orphan = looks.find((l) => !names.includes(`${l.id}.png`));
      if (orphan) throw new Reject(400, `у «${orphan.id}» нет файла ${orphan.id}.png`);
      await writeFile(registryFile, writeJson({ looks }), 'utf8');
      res.statusCode = 204; res.end();
      return true;
    }
    if (!path.startsWith('file/')) return false;
    const name = path.slice(5);
    // Имя — из адреса, поэтому в путь оно идёт только после проверки.
    if (!name.endsWith('.png') || !LOOK_ID.test(name.slice(0, -4)) && !/^[\w -]+$/.test(name.slice(0, -4))) {
      throw new Reject(400, `недопустимое имя файла: ${name}`);
    }
    const id = name.slice(0, -4);
    const file = resolve(dir, name);
    if (method === 'GET') {
      let buf: Buffer;
      try { buf = await readFile(file); } catch { throw new Reject(404, `нет файла ${name}`); }
      res.setHeader('content-type', 'image/png');
      res.setHeader('cache-control', 'no-store');
      res.end(buf);
      return true;
    }
    if (method === 'PUT') {
      if (!LOOK_ID.test(id)) throw new Reject(400, `имя скина — буквы, цифры, _ и -: «${id}»`);
      const buf = await body(req);
      if (!buf.subarray(0, 8).equals(PNG)) throw new Reject(400, 'это не PNG');
      await writeFile(file, buf);
      res.statusCode = 204; res.end();
      return true;
    }
    if (method === 'DELETE') {
      await rm(file, { force: true });
      // Список чистится вместе с файлом: запись без файла — агент без текстуры.
      const registry = await readRegistry();
      const looks = parseLooks(registry).filter((l) => l.id !== id);
      if (looks.length !== parseLooks(registry).length) await writeFile(registryFile, writeJson({ looks }), 'utf8');
      res.statusCode = 204; res.end();
      return true;
    }
    return false;
  }

  return {
    name: 'office-skins-bench',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__skins', (req, res, next) => {
        handle(req, res).then(
          (done) => { if (!done) next(); },
          (e: unknown) => {
            res.statusCode = e instanceof Reject ? e.status : 500;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end(e instanceof Error ? e.message : String(e));
          },
        );
      });
    },
  };
}

export default defineConfig({
  root: 'src/web',
  // Собранный веб кладём в dist/ в корне проекта — оттуда его раздаёт сервер
  // офиса. По умолчанию vite положил бы его внутрь src/web/.
  build: { outDir: '../../dist', emptyOutDir: true },
  /**
   * `three` должен быть в сборке ровно один. Загрузчики из
   * `three/examples/jsm` vite оптимизирует отдельным пакетом, и без dedupe в
   * приложении оказываются две копии библиотеки: рендерер из одной, а
   * `instanceof THREE.Mesh` — из другой, и такие проверки молча перестают
   * срабатывать. Симптом — модели грузятся, но остаются без материалов.
   */
  resolve: { dedupe: ['three'] },
  server: {
    port: 5173,
    /**
     * В деве страницу отдаёт vite, а данные живут на сервере офиса. Сокет веб
     * открывает сам по имени хоста и порту (`store.ts`), а вот адреса вроде
     * `/api/office-icon` он вставляет в `<img src>` как есть — угадывать там
     * хост неоткуда, да и сервер, который собирает этот адрес, не знает, с
     * какой машины на него смотрят. Поэтому `/api` в деве проксируется: один
     * и тот же относительный адрес работает и здесь, и в собранном офисе на
     * :3001, где страница и сервер — вообще один адрес.
     */
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.VITE_OFFICE_PORT ?? process.env.OFFICE_PORT ?? 3001}`,
      },
    },
  },
  plugins: [react(), fitWriter(), presetWriter(), skinsBench()],
});

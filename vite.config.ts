import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

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
 * Запись пресета предмета из стенда в `design/presets/<id>/preset.json`.
 *
 * Отдельный маршрут от `/__fit`, потому что и файлы разные: подгонка фигуры
 * общая, а поправка посадки принадлежит предмету. Разделять их обратно в один
 * файл значило бы вернуть то, ради ухода от чего пресеты и заводились.
 *
 * `id` берётся из адреса и проверяется тем же образцом, что и схема
 * (`^[a-z0-9_]+$`): в путь к файлу он попадает напрямую, и «пиши куда скажут»
 * из браузера — не то, что должен уметь дев-сервер.
 */
function presetWriter(): Plugin {
  const dir = resolve(import.meta.dirname, 'design/presets');
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
          let text: string;
          try {
            const data = JSON.parse(body) as { id?: unknown };
            // Пресет, записанный не в свою папку, ловится потом сверкой, но
            // ловить его лучше здесь: диагноз понятнее, а файла ещё нет.
            if (data.id !== id) throw new Error(`id внутри — «${String(data.id)}»`);
            text = format(data);
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
            return;
          }
          writeFile(resolve(dir, id, 'preset.json'), text, 'utf8').then(
            () => { res.statusCode = 204; res.end(); },
            (e: unknown) => { res.statusCode = 500; res.end(String(e)); },
          );
        });
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
  server: { port: 5173 },
  plugins: [react(), fitWriter(), presetWriter()],
});

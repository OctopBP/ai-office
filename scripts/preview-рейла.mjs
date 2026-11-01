#!/usr/bin/env node
// Изолированный dev-only preview: без сервера офиса, прокси и записи состояния.
import { build, createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const корень = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.includes('--check')) {
  const результат = await build({
    configFile: false, root: resolve(корень, 'src/web'), plugins: [react()],
    define: { 'import.meta.env.DEV': 'true' },
    build: { write: false, rollupOptions: { input: resolve(корень, 'src/web/rail-preview.html') } },
  });
  console.log('Модули preview и CSS собраны в памяти; HTTP/browser этим не проверяются.');
  process.exit(0);
}
const сервер = await createServer({
  configFile: false,
  root: resolve(корень, 'src/web'),
  cacheDir: resolve(корень, '.tmp/preview-рейла/vite'),
  plugins: [react(), {
    name: 'изолировать-preview',
    configureServer(стенд) {
      стенд.middlewares.use((запрос, ответ, дальше) => {
        if (запрос.url?.startsWith('/api') || запрос.url?.startsWith('/ws')
          || запрос.url?.split('?')[0] === '/' || запрос.url?.split('?')[0] === '/index.html') {
          ответ.statusCode = 404;
          ответ.end('Изолированный preview: откройте /rail-preview.html');
          return;
        }
        дальше();
      });
    },
  }],
  server: { host: '127.0.0.1', port: 5188, strictPort: true, open: false },
});
await сервер.listen();
console.log('Preview рейла: http://127.0.0.1:5188/rail-preview.html');
console.log('Остановить: Ctrl+C');
for (const сигнал of ['SIGINT', 'SIGTERM']) {
  process.once(сигнал, async () => { await сервер.close(); process.exit(0); });
}

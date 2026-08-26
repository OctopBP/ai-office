import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  plugins: [react()],
});

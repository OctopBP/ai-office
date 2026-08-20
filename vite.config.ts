import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  // Собранный веб кладём в dist/ в корне проекта — оттуда его раздаёт сервер
  // офиса. По умолчанию vite положил бы его внутрь src/web/.
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { port: 5173 },
  plugins: [react()],
});

/**
 * Запуск сервиса индекса. `npm run registry -- --port 8787 --data ./registry-data [--seed registry/registry.json] [--base https://…]`
 *
 * Админский токен — OFFICE_REGISTRY_ADMIN_TOKEN; адрес API GitHub —
 * OFFICE_REGISTRY_GITHUB_API (по умолчанию https://api.github.com).
 */
import { resolve } from 'node:path';
import { RegistryService } from './service';

const argv = process.argv.slice(2);
const flag = (name: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
};

const service = new RegistryService({
  dataDir: resolve(flag('data') || 'registry-data'),
  baseUrl: flag('base') || undefined,
  adminToken: process.env.OFFICE_REGISTRY_ADMIN_TOKEN || undefined,
  githubApi: process.env.OFFICE_REGISTRY_GITHUB_API || undefined,
  log: (line) => console.log(`[registry] ${line}`),
});

const seed = flag('seed');
if (seed) {
  const { added, problems } = await service.seed(resolve(seed));
  console.log(`[registry] seeded from ${seed}: ${added} version(s) added${problems.length ? `, ${problems.length} problem(s)` : ''}`);
  for (const p of problems) console.log(`[registry]   ${p}`);
}

const port = await service.listen(Number(flag('port') || 8787), flag('host') || '127.0.0.1');
console.log(`[registry] listening on http://127.0.0.1:${port}/v1/registry.json`);

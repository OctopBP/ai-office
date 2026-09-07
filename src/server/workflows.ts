/**
 * Процессы, которые приезжают вместе с офисом: папка `workflows/` в корне
 * репозитория (docs/design/workflows/spec.md §7.1). Читаются один раз на
 * процесс сервера и проверяются целиком: сломанный встроенный процесс — это
 * сломанная сборка, а не тихий отказ на первой задаче.
 *
 * Свои процессы проекта и процессы из пакетов — фазы 1 и 3 спеки; здесь
 * пока только встроенные.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflow, type Workflow } from '../shared/workflow';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = resolve(ROOT, 'workflows');

let cache: Map<string, Workflow> | null = null;

/** Все встроенные процессы по id. */
export function builtinWorkflows(): Map<string, Workflow> {
  if (cache) return cache;
  const found = new Map<string, Workflow>();
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
    const where = `workflows/${file}`;
    const workflow = parseWorkflow(JSON.parse(readFileSync(resolve(DIR, file), 'utf8')), where);
    if (workflow.id !== basename(file, '.json')) {
      throw new Error(`${where}: id «${workflow.id}» не совпадает с именем файла`);
    }
    found.set(workflow.id, workflow);
  }
  cache = found;
  return found;
}

/** Встроенный процесс по id. Отсутствие — ошибка программы, а не данных. */
export function builtinWorkflow(id: string): Workflow {
  const workflow = builtinWorkflows().get(id);
  if (!workflow) throw new Error(`workflows/${id}.json: такого процесса нет`);
  return workflow;
}

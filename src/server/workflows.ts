/**
 * Процессы: встроенные и свои у проекта (docs/design/workflows/spec.md §7.1).
 *
 * Встроенные приезжают вместе с офисом — папка `workflows/` в корне этого
 * репозитория. Читаются один раз на процесс сервера и проверяются целиком:
 * сломанный встроенный процесс — это сломанная сборка, а не тихий отказ на
 * первой задаче.
 *
 * Свои лежат в `workflows/` в корне проекта и перекрывают встроенные по id
 * (§14.16). Сломанный файл проекта — не сломанный офис: он показывается с
 * ошибкой, а задачи едут по встроенному. Перечитываются по времени правки:
 * человек редактирует файл и ждёт, что офис увидит его без перезапуска.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseWorkflow, type Workflow, type WorkflowEntry } from '../shared/workflow';
import type { OfficeState } from './state';
import { ROOT } from './root';

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

/** Папка своих процессов проекта. У самого офиса совпадает со встроенными. */
export const projectWorkflowsDir = (projectDir: string): string => resolve(projectDir, 'workflows');

interface ProjectFile { text: string; workflow: Workflow | null; problem: string | null }

const projectCache = new Map<string, { stamp: string; files: Map<string, ProjectFile> }>();

/** Файлы проекта по id — с ошибками разбора, если есть. */
function projectFiles(projectDir: string): Map<string, ProjectFile> {
  const dir = projectWorkflowsDir(projectDir);
  // Свои файлы у офиса — те же встроенные; читать их дважды незачем.
  if (dir === DIR) return new Map();
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    projectCache.delete(projectDir);
    return new Map();
  }
  const stamp = names.map((f) => {
    try { return `${f}:${statSync(resolve(dir, f)).mtimeMs}`; } catch { return f; }
  }).join('|');
  const cached = projectCache.get(projectDir);
  if (cached && cached.stamp === stamp) return cached.files;

  const files = new Map<string, ProjectFile>();
  for (const file of names) {
    const id = basename(file, '.json');
    let text = '';
    try {
      text = readFileSync(resolve(dir, file), 'utf8');
      const workflow = parseWorkflow(JSON.parse(text), `workflows/${file}`);
      if (workflow.id !== id) throw new Error(`workflows/${file}: id «${workflow.id}» не совпадает с именем файла`);
      files.set(id, { text, workflow, problem: null });
    } catch (err) {
      files.set(id, { text, workflow: null, problem: (err as Error).message });
    }
  }
  projectCache.set(projectDir, { stamp, files });
  return files;
}

const builtinText = new Map<string, string>();
const textOf = (id: string): string => {
  let text = builtinText.get(id);
  if (text === undefined) {
    text = readFileSync(resolve(DIR, `${id}.json`), 'utf8');
    builtinText.set(id, text);
  }
  return text;
};

/** Все процессы офиса: свои перекрывают встроенные, сломанные свои — нет. */
export function workflowCatalog(state: Pick<OfficeState, 'projectDir'>): WorkflowEntry[] {
  const own = projectFiles(state.projectDir);
  const entries: WorkflowEntry[] = [];
  for (const [id, builtin] of builtinWorkflows()) {
    const mine = own.get(id);
    if (mine?.workflow) {
      entries.push({ id, source: 'project', overrides: true, workflow: mine.workflow, text: mine.text, problem: null });
    } else {
      entries.push({ id, source: 'builtin', overrides: false, workflow: builtin, text: textOf(id), problem: mine?.problem ?? null });
    }
  }
  for (const [id, mine] of own) {
    if (builtinWorkflows().has(id) || !mine.workflow) {
      if (!builtinWorkflows().has(id) && mine.problem) {
        entries.push({ id, source: 'project', overrides: false, workflow: builtinWorkflows().get('feature') as Workflow, text: mine.text, problem: mine.problem });
      }
      continue;
    }
    entries.push({ id, source: 'project', overrides: false, workflow: mine.workflow, text: mine.text, problem: null });
  }
  return entries;
}

/** Процесс, по которому офис едет: свой, если он есть и цел, иначе встроенный. */
export function workflowFor(state: Pick<OfficeState, 'projectDir'>, id: string): Workflow | null {
  const mine = projectFiles(state.projectDir).get(id);
  return mine?.workflow ?? builtinWorkflows().get(id) ?? null;
}

/**
 * Сохранить свой процесс проекта. Текст разбирается до записи: сломанный файл
 * на диск не попадает, человек видит, что именно не так. null — сохранено.
 */
export function saveProjectWorkflow(state: Pick<OfficeState, 'projectDir'>, id: string, text: string): string | null {
  try {
    const workflow = parseWorkflow(JSON.parse(text), `workflows/${id}.json`);
    if (workflow.id !== id) return `workflows/${id}.json: id «${workflow.id}» не совпадает с именем файла`;
  } catch (err) {
    return (err as Error).message;
  }
  const dir = projectWorkflowsDir(state.projectDir);
  if (dir === DIR) return 'у самого офиса свои процессы и есть встроенные — правьте их в репозитории';
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${id}.json`), text.endsWith('\n') ? text : `${text}\n`);
  projectCache.delete(state.projectDir);
  return null;
}

/** Убрать свой процесс: офис вернётся к встроенному. null — убрано. */
export function resetProjectWorkflow(state: Pick<OfficeState, 'projectDir'>, id: string): string | null {
  const dir = projectWorkflowsDir(state.projectDir);
  if (dir === DIR) return 'у самого офиса свои процессы и есть встроенные';
  const file = resolve(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  rmSync(file);
  projectCache.delete(state.projectDir);
  return null;
}

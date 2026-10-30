import type { Role } from './roles';
import type { WorkflowNode } from '../shared/workflow';

/** Только встроенный шаг проверки по веб-источникам: другим шагам нужны MCP роли. */
export function проверкаИсследования(процесс: string, узел: WorkflowNode): boolean {
  return процесс === 'research' && узел.id === 'verify'
    && узел.needs?.length === 1 && узел.needs[0] === 'research.web';
}

/** Схемы редакторов дизайнера не должны оплачиваться на каждом ходе веб-проверки. */
export function рольДляПроверки(роль: Role, проверка: boolean): Role {
  return проверка ? { ...роль, mcp: [] } : роль;
}

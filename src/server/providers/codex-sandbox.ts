import { resolve } from 'node:path';
import { cleanAllowedHosts } from '../../shared/sandbox';
import type { SessionOptions } from '../engines/types';

/**
 * command/exec — отдельный от треда исполнитель. Его legacy sandboxPolicy
 * умеет только включать всю сеть. Профиль Codex сохраняет файловую песочницу
 * :workspace и открывает сеть через штатный прокси с фильтром доменов.
 */
export function песочницаКомандCodex(options: SessionOptions) {
  const cwd = resolve(options.cwd ?? process.cwd());
  // sandboxFor уже развернул одобренные пути; сохраняем их в обоих режимах сети.
  const корниЗаписи = [...new Set([cwd, ...(options.sandbox?.filesystem?.allowWrite ?? [])])];
  const хосты = cleanAllowedHosts(options.sandbox?.network?.allowedDomains);
  if (!хосты.length) return {
    аргументы: [] as string[],
    политика: { sandboxPolicy: { type: 'workspaceWrite', writableRoots: корниЗаписи, networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
    профиль: null,
  };
  const профиль = 'office-command';
  const домены = хосты.map(хост => `${JSON.stringify(хост)}="allow"`).join(',');
  return {
    // У модели остаётся read-only; расширенный профиль выбирают только руки.
    аргументы: ['-c', 'default_permissions=":read-only"', '-c',
      `permissions.${профиль}={extends=":workspace",workspace_roots=${JSON.stringify(корниЗаписи)},network={mode="limited",domains={${домены}}}}`],
    политика: { permissionProfile: профиль },
    профиль,
  };
}

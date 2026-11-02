/** Одноразовый профиль управления каталогом, без личного HOME/XDG и ключей. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer } from './opencode';

export function окружениеКаталогаOpenCode(дом: string, источник: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const имя of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ']) {
    if (источник[имя]) env[имя] = источник[имя];
  }
  env.HOME = env.USERPROFILE = дом;
  env.TMPDIR = env.TMP = env.TEMP = дом;
  for (const имя of ['DATA', 'CONFIG', 'CACHE', 'STATE']) {
    const путь = resolve(дом, имя.toLowerCase());
    mkdirSync(путь, { recursive: true, mode: 0o700 });
    env['XDG_' + имя + '_HOME'] = путь;
  }
  Object.assign(env, {
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_PURE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      autoupdate: false, share: 'disabled', snapshot: false,
      plugin: [], mcp: {}, instructions: [], tools: { '*': false }, permission: { '*': 'deny' },
    }),
  });
  return env;
}

export async function получитьКаталогOpenCode(): Promise<Record<string, any>> {
  const дом = mkdtempSync(resolve(tmpdir(), 'office-opencode-catalog-'));
  const отмена = new AbortController();
  let сервер: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    сервер = await startServer(дом, окружениеКаталогаOpenCode(дом), отмена.signal);
    const конфиг = await сервер.request<Record<string, any>>('GET', '/config');
    if (!конфиг || Object.keys(конфиг.mcp ?? {}).length || (конфиг.plugin ?? []).length
      || (конфиг.instructions ?? []).length || конфиг.permission?.['*'] !== 'deny'
      || (конфиг.enabled_providers ?? []).length || Object.keys(конфиг.provider ?? {}).length) {
      throw new Error('Неподтверждённый профиль каталога');
    }
    return await сервер.request('GET', '/provider');
  } finally {
    сервер?.close();
    отмена.abort();
    // Дожидаемся остановки, чтобы процесс не пересоздал профиль после удаления.
    if (сервер && сервер.child.exitCode === null && сервер.child.signalCode === null) {
      await new Promise<void>(готово => сервер!.child.once('close', () => готово()));
    }
    rmSync(дом, { recursive: true, force: true });
  }
}

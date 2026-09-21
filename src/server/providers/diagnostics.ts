import { codexBinary, runtimeEnv } from './codex';
import { CodexRpc } from './rpc';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CodexStatus {
  available: boolean;
  authenticated: boolean;
  models: Array<{ id: string; label: string }>;
  error?: string;
}
let cached: { at: number; value: Promise<CodexStatus> } | undefined;
/** Metadata only: never starts a paid model turn. */
export function codexStatus(force = false): Promise<CodexStatus> {
  if (!force && cached && Date.now() - cached.at < 30_000) return cached.value;
  const value = (async (): Promise<CodexStatus> => {
    let rpc: CodexRpc | undefined;
    try {
      const env = runtimeEnv();
      rpc = new CodexRpc(codexBinary(), process.cwd(), env);
      await rpc.request('initialize', { clientInfo: { name: 'ai-office', version: '1.0.0' }, capabilities: { experimentalApi: true } }, 10_000);
      rpc.send({ method: 'initialized' });
      // Some Desktop builds can serve models and turns while account/read fails
      // during workspace routing discovery. Keep that optional metadata failure
      // from making the installed App Server look unavailable.
      let authenticated = Boolean(env.OPENAI_API_KEY || (env.CODEX_HOME && existsSync(resolve(env.CODEX_HOME, 'auth.json'))));
      try {
        const account = await rpc.request('account/read', { refreshToken: false }, 10_000);
        authenticated = Boolean(account.account);
      } catch { /* the local auth file is the conservative fallback */ }
      const models: CodexStatus['models'] = [];
      let cursor: string | undefined;
      try {
        do {
          const page = await rpc.request('model/list', { cursor, limit: 100 }, 10_000);
          for (const model of page.data ?? []) models.push({ id: model.model, label: model.displayName });
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      } catch { /* `default` and an exact manually entered model still work */ }
      return { available: true, authenticated, models };
    } catch (e) {
      return { available: false, authenticated: false, models: [],
        error: `Codex App Server is unavailable. Install a current Codex CLI or set OFFICE_CODEX_PATH. ${String(e)}` };
    } finally { rpc?.close(); }
  })();
  cached = { at: Date.now(), value };
  return value;
}

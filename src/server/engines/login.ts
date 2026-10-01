/**
 * Вход по подписке штатной командой движка: `claude auth login`,
 * `codex login`. Офис запускает установленный бинарь как есть, вынимает из его
 * вывода адрес страницы входа и ждёт, пока команда закончится, — сам токен
 * пишет движок в своё хранилище, офис его не видит и не хранит.
 *
 * Сценарий один на провайдера: повторное «Войти по подписке» во время входа
 * отдаёт идущий, а не запускает второй процесс, который поспорил бы с первым
 * за порт обратного вызова.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ProviderId } from '../../shared/providers';
import type { ProviderLoginFlow } from '../../shared/types';

/** Столько ждём вход в браузере — как в макете (docs/design/T-189/ui.md, карточка «нужен вход»). */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface CliLogin {
  provider: ProviderId;
  bin: string;
  args: string[];
  /** Окружение команды. Ключей провайдеров в нём быть не должно: вход идёт подпиской. */
  env: NodeJS.ProcessEnv;
  /** Движок читает со входа код со страницы входа (Claude Code: `код#состояние`). */
  acceptsCode: boolean;
  /** После успешного входа: сбросить кеши статуса движка. */
  after?: () => unknown;
}

interface Running {
  flow: ProviderLoginFlow;
  child: ChildProcess;
  timer: NodeJS.Timeout;
  output: string;
  stopping?: 'cancelled' | 'expired';
}

const running = new Map<ProviderId, Running>();
const listeners = new Set<(provider: ProviderId, flow: ProviderLoginFlow) => void>();

/** Подписаться на смену фаз. Возвращает отписку. */
export function onLoginFlow(fn: (provider: ProviderId, flow: ProviderLoginFlow) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Идущие входы — для только что подключившегося клиента. */
export function activeLogins(): Array<{ provider: ProviderId; flow: ProviderLoginFlow }> {
  return [...running].map(([provider, run]) => ({ provider, flow: { ...run.flow } }));
}

function emit(provider: ProviderId, flow: ProviderLoginFlow): void {
  for (const fn of listeners) {
    try { fn(provider, { ...flow }); } catch (err) { console.warn(`[login] ${(err as Error).message}`); }
  }
}

// Claude Code печатает адрес гиперссылкой терминала (OSC 8): без снятия
// управляющих последовательностей адрес склеился бы с ними.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;

/**
 * Адрес страницы входа из вывода. Адрес локального сервера обратного вызова
 * (`http://localhost:1455`, его печатает Codex) — не страница входа.
 */
export function loginUrl(output: string): string | null {
  for (const match of output.replace(ESCAPES, '').match(URL_RE) ?? []) {
    const url = match.replace(/[.,;)]+$/, '');
    try {
      const host = new URL(url).hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') continue;
    } catch { continue; }
    return url;
  }
  return null;
}

/** Последние строки вывода — причина отказа для карточки. */
const tail = (output: string): string =>
  output.replace(ESCAPES, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join('\n');

/** Запустить вход. Если по этому провайдеру вход уже идёт — отдать его. */
export function startCliLogin(spec: CliLogin): ProviderLoginFlow {
  const busy = running.get(spec.provider);
  if (busy) return { ...busy.flow };

  const flow: ProviderLoginFlow = { flowId: randomUUID(), phase: 'starting' };
  const child = spawn(spec.bin, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const run: Running = { flow, child, output: '', timer: setTimeout(() => stop(spec.provider, 'expired'), LOGIN_TIMEOUT_MS) };
  run.timer.unref?.();
  running.set(spec.provider, run);

  const finish = (phase: ProviderLoginFlow['phase'], error?: string) => {
    if (running.get(spec.provider) !== run) return;
    clearTimeout(run.timer);
    running.delete(spec.provider);
    run.flow = { flowId: flow.flowId, phase, ...(run.flow.interaction ? { interaction: run.flow.interaction } : {}), ...(error ? { error } : {}) };
    if (phase === 'succeeded') {
      try { spec.after?.(); } catch { /* кеш статуса сбросится по сроку */ }
    }
    emit(spec.provider, run.flow);
  };

  const read = (chunk: Buffer) => {
    // Вывод входа — несколько строк; держим хвост, чтобы не копить мусор.
    run.output = (run.output + chunk.toString('utf8')).slice(-16_384);
    if (run.flow.phase !== 'starting') return;
    const url = loginUrl(run.output);
    if (!url) return;
    run.flow = { ...run.flow, phase: 'waiting', interaction: { kind: 'browser', url, code: spec.acceptsCode } };
    emit(spec.provider, run.flow);
  };
  child.stdout?.on('data', read);
  child.stderr?.on('data', read);
  // Вход ввод ждёт только ради кода; закрытый вход процесса не роняет офис.
  child.stdin?.on('error', () => {});
  child.on('error', (err) => finish('failed', err.message));
  child.on('exit', (code, signal) => {
    if (run.stopping) return finish(run.stopping);
    if (code === 0) return finish('succeeded');
    finish('failed', tail(run.output) || `exit ${code ?? signal}`);
  });

  emit(spec.provider, flow);
  return { ...flow };
}

/** Остановить вход: отмена человеком или истёкшее ожидание. */
function stop(provider: ProviderId, why: 'cancelled' | 'expired'): boolean {
  const run = running.get(provider);
  if (!run) return false;
  run.stopping = why;
  run.child.kill();
  // Не вышел по-хорошему — добиваем, иначе порт обратного вызова так и висел бы.
  setTimeout(() => { if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL'); }, 3000).unref?.();
  return true;
}

export function cancelCliLogin(provider: ProviderId): boolean {
  return stop(provider, 'cancelled');
}

/**
 * Код со страницы входа — движку на вход. Код одноразовый и в логи не пишется;
 * false — входа нет или этот движок код не принимает.
 */
export function sendLoginCode(provider: ProviderId, code: string): boolean {
  const run = running.get(provider);
  const clean = code.trim();
  if (!run || !run.flow.interaction?.code || !clean || /\s/.test(clean) || !run.child.stdin?.writable) return false;
  run.child.stdin.write(`${clean}\n`);
  return true;
}

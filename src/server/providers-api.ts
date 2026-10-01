/**
 * Экран «Провайдеры» на стороне сервера (docs/design/providers/spec.md, этап 4;
 * docs/design/T-189/ui.md): список провайдеров со статусом и возможностями,
 * установка движка с прогрессом, вход по ключу API, по подписке и выход.
 *
 * Провайдеры одни на процесс, а не на офис: движок стоит на машине, ключ
 * лежит в связке ключей пользователя. Поэтому события уходят всем клиентам,
 * а команды принимаются до выбора офиса — экран первого запуска открывается
 * раньше, чем офису есть чем работать.
 *
 * Сервер ничего не решает за веб: карточка рисуется из `ProviderView`, а
 * «нет ни одного готового провайдера» (`noneReady`) — признак для экрана
 * первого запуска.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROVIDER_IDS, PROVIDERS, isConnected, isProviderId, type ProviderId } from '../shared/providers';
import type { ClientCommand, ProviderLoginFlow, ProviderLoginResult, ProviderView, ProvidersView, ServerEvent } from '../shared/types';
import { engineFor, LoginError, type EngineId, type ModelInfo, type ProviderStatus } from './engines';
import { keychainAvailable, providerKey } from './engines/keys';
import { activeLogins, cancelCliLogin, onLoginFlow, sendLoginCode } from './engines/login';
import { broadcastAll, send } from './office-api';
import { openedOffices } from './state';
import { refreshEnvChecks } from './envcheck';

type Sink = Parameters<typeof send>[0];

/** Подпись движка — мелкой строкой под названием провайдера. */
const ENGINE_LABEL: Record<EngineId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** Идущие установки — по движку: движок общий для всех его провайдеров. */
const installs = new Map<EngineId, { share: number; bytes?: number; totalBytes?: number; abort: AbortController }>();
/** Чем кончилась последняя неудачная установка: показывается до следующей попытки. */
const installErrors = new Map<EngineId, string>();

async function providerView(id: ProviderId, force: boolean): Promise<ProviderView> {
  const engine = engineFor(id);
  const running = installs.get(engine.id);
  const status: ProviderStatus = running
    ? { state: 'installing', engine: engine.id, share: running.share, bytes: running.bytes, totalBytes: running.totalBytes }
    : await engine.status(id, { force }).catch((err: Error): ProviderStatus => ({ state: 'error', detail: err.message }));
  const caps = engine.capabilities(process.platform);
  const key = providerKey(id);
  const error = installErrors.get(engine.id);
  return {
    id,
    label: PROVIDERS[id].label,
    engine: engine.id,
    engineLabel: ENGINE_LABEL[engine.id],
    auth: [
      ...(caps.apiKeyLogin ? ['api-key' as const] : []),
      ...(caps.subscriptionLogin ? ['subscription' as const] : []),
    ],
    status,
    capabilities: caps,
    key: key ? { tail: key.key.slice(-4), source: key.source } : null,
    ...(error ? { installError: error } : {}),
  };
}

/** Все провайдеры и признак первого запуска. `force` — мимо кешей движков. */
export async function providersView(force = false): Promise<ProvidersView> {
  const providers = await Promise.all(PROVIDER_IDS.map((id) => providerView(id, force)));
  return {
    providers,
    noneReady: !providers.some((p) => isConnected(p.status)),
    keychain: await keychainAvailable(),
  };
}

/** Есть ли хоть один подключённый провайдер — для тех, кому не нужен весь список. */
export async function noneReady(): Promise<boolean> {
  return (await providersView()).noneReady;
}

let pending: Promise<void> | null = null;
let again = false;

/**
 * Разослать список всем. Статусы считаются не мгновенно (Codex поднимает
 * свой процесс), поэтому вызовы, пришедшие во время подсчёта, сливаются в
 * один следующий.
 */
export function broadcastProviders(force = false): Promise<void> {
  if (pending) { again = true; return pending; }
  pending = (async () => {
    try {
      const view = await providersView(force);
      broadcastAll({ t: 'providers', providers: view } satisfies ServerEvent);
    } finally {
      pending = null;
      if (again) { again = false; void broadcastProviders(); }
    }
  })();
  return pending;
}

/** Статус провайдера поменялся — проверки окружения открытых офисов тоже. */
function refreshOffices(): void {
  for (const state of openedOffices()) void refreshEnvChecks(state).catch(() => {});
}

/**
 * Поставить движок провайдера. Прогресс — тем же списком провайдеров, не
 * чаще четырёх раз в секунду: архив в сотню мегабайт иначе дал бы тысячи
 * событий. Повторная команда во время установки ничего не запускает.
 */
export function startInstall(provider: ProviderId): boolean {
  const engine = engineFor(provider);
  if (installs.has(engine.id)) return false;
  const abort = new AbortController();
  const run = { share: 0, abort } as { share: number; bytes?: number; totalBytes?: number; abort: AbortController };
  installs.set(engine.id, run);
  installErrors.delete(engine.id);
  let last = 0;
  void broadcastProviders();
  void engine.install((p) => {
    Object.assign(run, p);
    const now = Date.now();
    if (now - last >= 250) { last = now; void broadcastProviders(); }
  }, abort.signal)
    .then(({ path }) => console.log(`[providers] движок ${engine.id} поставлен: ${path}`))
    .catch((err: Error) => {
      if (abort.signal.aborted) return;
      console.warn(`[providers] движок ${engine.id} не поставился: ${err.message}`);
      installErrors.set(engine.id, err.message);
    })
    .finally(() => {
      installs.delete(engine.id);
      void broadcastProviders(true);
      refreshOffices();
    });
  return true;
}

/** Отменить установку. Недокачанное удаляет сама установка. */
export function cancelInstall(provider: ProviderId): void {
  installs.get(engineFor(provider).id)?.abort.abort();
}

/** Войти по ключу API: проверить, положить в связку, разослать новый статус. */
export async function loginProvider(provider: ProviderId, apiKey: string): Promise<ProviderLoginResult> {
  const key = apiKey.trim();
  if (!key || /\s/.test(key)) return { ok: false, code: 'rejected', message: 'empty or malformed key' };
  try {
    await engineFor(provider).login({ provider, kind: 'api-key', apiKey: key });
  } catch (err) {
    const code = err instanceof LoginError ? err.code : 'network';
    return { ok: false, code, message: (err as Error).message };
  }
  void broadcastProviders(true);
  refreshOffices();
  return { ok: true };
}

/**
 * Войти по подписке: запустить штатный вход движка. Ход входа уходит всем
 * клиентам (`onLoginFlow` ниже) — провайдеры общие, и вторая вкладка тоже
 * должна видеть, что вход идёт. Отказ на старте — итогом тому, кто просил.
 */
export async function loginBySubscription(provider: ProviderId): Promise<
  { ok: true; flow: ProviderLoginFlow } | Extract<ProviderLoginResult, { ok: false }>
> {
  try {
    const start = await engineFor(provider).login({ provider, kind: 'subscription' });
    if (!start.done) return { ok: true, flow: start.flow };
    void broadcastProviders(true);
    refreshOffices();
    return { ok: true, flow: { flowId: '', phase: 'succeeded' } };
  } catch (err) {
    const code = err instanceof LoginError ? err.code : 'unsupported';
    return { ok: false, code, message: (err as Error).message };
  }
}

// Вход закончился — чем бы ни кончился, статус провайдера мог смениться:
// успех даёт `ready`, а отмена возвращает карточку в «нужен вход».
onLoginFlow((provider, flow) => {
  broadcastAll({ t: 'provider.login', provider, flow } satisfies ServerEvent);
  if (flow.phase === 'starting' || flow.phase === 'waiting') return;
  if (flow.phase === 'succeeded') console.log(`[providers] вход по подписке в ${provider} выполнен`);
  void broadcastProviders(true);
  refreshOffices();
});

export async function logoutProvider(provider: ProviderId): Promise<ProviderLoginResult> {
  try {
    await engineFor(provider).logout(provider);
  } catch (err) {
    return { ok: false, code: 'keychain', message: (err as Error).message };
  }
  void broadcastProviders(true);
  refreshOffices();
  return { ok: true };
}

/** Команды экрана «Провайдеры». true — команда разобрана здесь. */
export function handleProviderCommand(cmd: ClientCommand, ws: Sink): boolean {
  switch (cmd.c) {
    case 'providers_refresh':
      void providersView(cmd.force === true).then((view) => send(ws, { t: 'providers', providers: view }));
      if (cmd.force) refreshOffices();
      return true;
    case 'provider_install':
      if (isProviderId(cmd.provider)) startInstall(cmd.provider);
      return true;
    case 'provider_install_cancel':
      if (isProviderId(cmd.provider)) cancelInstall(cmd.provider);
      return true;
    case 'provider_login': {
      if (!isProviderId(cmd.provider)) return true;
      const provider = cmd.provider;
      if ('kind' in cmd && cmd.kind === 'subscription') {
        // Новый сценарий уже ушёл всем, но повтор во время входа отдаёт идущий
        // молча — просившему шлём его текущее состояние.
        void loginBySubscription(provider).then((r) => send(ws, r.ok
          ? { t: 'provider.login', provider, flow: activeLogins().find((a) => a.provider === provider)?.flow ?? r.flow }
          : { t: 'provider.login', provider, result: r }));
        return true;
      }
      if (!('apiKey' in cmd) || typeof cmd.apiKey !== 'string') return true;
      void loginProvider(provider, cmd.apiKey).then((result) => send(ws, { t: 'provider.login', provider, result }));
      return true;
    }
    case 'provider_login_cancel':
      if (isProviderId(cmd.provider)) cancelCliLogin(cmd.provider);
      return true;
    case 'provider_login_code':
      if (isProviderId(cmd.provider) && typeof cmd.code === 'string') sendLoginCode(cmd.provider, cmd.code);
      return true;
    case 'provider_logout':
      if (!isProviderId(cmd.provider)) return true;
      void logoutProvider(cmd.provider).then((result) => send(ws, { t: 'provider.login', provider: cmd.provider, result }));
      return true;
    default:
      return false;
  }
}

/** Первое, что узнаёт подключившийся клиент о провайдерах, — до снапшота офиса. */
export function greetProviders(ws: Sink): void {
  void providersView().then((view) => {
    send(ws, { t: 'providers', providers: view });
    // Вход идёт с другой вкладки — эта должна увидеть ссылку и «Отмена».
    for (const { provider, flow } of activeLogins()) send(ws, { t: 'provider.login', provider, flow });
  });
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((done) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // Ключ API — десятки байт; мегабайт тела — не к нам.
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { done(JSON.parse(body || '{}')); } catch { done({}); }
    });
    req.on('error', () => done({}));
  });
}

/**
 * HTTP-ручки того же экрана — для веба до сокета и для скриптов:
 *   GET    /api/providers               список и noneReady (`?force=1` — мимо кешей)
 *   GET    /api/providers/:id           статус и модели (форма роли)
 *   POST   /api/providers/:id/install   начать установку движка
 *   DELETE /api/providers/:id/install   отменить установку
 *   POST   /api/providers/:id/login     { apiKey } — вход по ключу; { kind: 'subscription' } — штатный вход движка
 *   DELETE /api/providers/:id/login     удалить ключ
 * Возвращает false, если адрес не про провайдеров.
 */
export function handleProvidersHttp(req: IncomingMessage, res: ServerResponse, url: string, query: string): boolean {
  if (url !== '/api/providers' && !url.startsWith('/api/providers/')) return false;
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const method = req.method ?? 'GET';

  if (url === '/api/providers') {
    if (method !== 'GET') { json(405, { error: 'GET only' }); return true; }
    const force = new URLSearchParams(query).get('force') === '1';
    void providersView(force).then((view) => json(200, view), (err: Error) => json(500, { error: err.message }));
    return true;
  }

  const match = /^\/api\/providers\/([^/]+)(?:\/(install|login))?$/.exec(url);
  const provider = match ? decodeURIComponent(match[1]!) : '';
  if (!match || !isProviderId(provider)) { json(404, { error: 'unknown provider' }); return true; }
  const action = match[2];

  if (!action) {
    if (method !== 'GET') { json(405, { error: 'GET only' }); return true; }
    // Состояние и модели — только через адаптер движка: форма роли читает
    // отсюда `models`, а `status` тот же, что у проверки provider:<id>.
    const engine = engineFor(provider);
    void (async () => {
      const [view, models] = await Promise.all([
        providerView(provider, false),
        engine.models(provider).catch((): ModelInfo[] => []),
      ]);
      json(200, { status: view.status, models });
    })();
    return true;
  }
  if (action === 'install') {
    if (method === 'POST') {
      const started = startInstall(provider);
      json(started ? 202 : 409, { started });
      return true;
    }
    if (method === 'DELETE') { cancelInstall(provider); json(200, { cancelled: true }); return true; }
    json(405, { error: 'POST or DELETE' });
    return true;
  }
  if (method === 'POST') {
    void readJson(req).then(async (body) => {
      if (body.kind === 'subscription') {
        const started = await loginBySubscription(provider);
        json(started.ok ? 202 : 501, started);
        return;
      }
      const result = await loginProvider(provider, typeof body.apiKey === 'string' ? body.apiKey : '');
      json(result.ok ? 200 : result.code === 'rejected' ? 401 : 502, result);
    });
    return true;
  }
  if (method === 'DELETE') {
    void logoutProvider(provider).then((result) => json(result.ok ? 200 : 502, result));
    return true;
  }
  json(405, { error: 'POST or DELETE' });
  return true;
}

/**
 * Адаптер универсального движка OpenCode (spec провайдеров §3.5): провайдеры
 * с API в формате OpenAI — xAI, DeepSeek, OpenRouter, Google (Gemini),
 * Alibaba (Qwen), Ollama и свой адрес.
 * Сессия — `providers/opencode.ts`, инструменты офиса — через мост MCP.
 *
 * Провайдер здесь — пресет: адрес, ключ и модель. Ключ лежит в связке ключей
 * (`keys.ts`), адрес Ollama и своего сервера — в `endpoints.ts`.
 */
import { execFile } from 'node:child_process';
import { providerSpec, type ProviderId } from '../../shared/providers';
import { limitBlock } from '../limits';
import {
  OPENCODE_BIN, OPENCODE_PKG, OPENCODE_VERSION, fetchModels, opencodeBinary, opencodeEnv, opencodeQuery,
  providerHeaders, sandboxAvailable,
} from '../providers/opencode';
import { catalogModel, modelPrice, priceCatalog } from '../providers/model-prices';
import {
  baseUrlOf, forgetBaseUrl, forgetCustomApi, normalizeBaseUrl, probeModels, saveBaseUrl, saveCustomApi,
} from './endpoints';
import { installFromNpm } from './install';
import { deleteKey, providerKey, saveKey, verifyKey } from './keys';
import { LoginError, type EngineAdapter, type EngineCapabilities, type ModelInfo, type ProviderStatus } from './types';

const OPENCODE_PROVIDERS: ProviderId[] = ['xai', 'deepseek', 'openrouter', 'google', 'alibaba', 'ollama', 'custom'];

/** Найденный движок: запуск `--version` — сотни миллисекунд, а статус спрашивают часто. */
let located: { at: number; value: { path: string; version: string } | null } | null = null;
const LOCATE_TTL = 60_000;

/** Доступность сервера провайдера со своим адресом — тоже не на каждый запрос. */
const reach = new Map<ProviderId, { at: number; url: string; error: string | null }>();
const REACH_TTL = 30_000;

function locate(force = false): Promise<{ path: string; version: string } | null> {
  if (!force && located && Date.now() - located.at < LOCATE_TTL) return Promise.resolve(located.value);
  const bin = opencodeBinary();
  return new Promise((done) => {
    execFile(bin, ['--version'], { timeout: 10_000, env: opencodeEnv() }, (err, stdout) => {
      const value = err ? null
        : { path: bin, version: String(stdout).match(/\d+\.\d+\.\d+/)?.[0] ?? String(stdout).trim() };
      located = { at: Date.now(), value };
      done(value);
    });
  });
}

/** Отвечает ли сервер провайдера со своим адресом. Текст ошибки — для карточки. */
async function reachable(provider: ProviderId, url: string, force: boolean): Promise<string | null> {
  const cached = reach.get(provider);
  if (!force && cached && cached.url === url && Date.now() - cached.at < REACH_TTL) return cached.error;
  let error: string | null = null;
  try { await fetchModels(provider, 4000); } catch (err) { error = (err as Error).message; }
  reach.set(provider, { at: Date.now(), url, error });
  return error;
}

export const opencodeEngine: EngineAdapter = {
  id: 'opencode',
  providers: OPENCODE_PROVIDERS,

  capabilities(platform: NodeJS.Platform = process.platform): EngineCapabilities {
    return {
      // Подписок у API по ключу нет: только ключ, а у локальных — и без него.
      subscriptionLogin: false,
      apiKeyLogin: true,
      resume: true,
      streamingInput: true,
      partialText: true,
      officeTools: 'mcp-bridge',
      // Свои руки OpenCode выключены: файлы и команды — руками офиса через мост.
      nativeHands: false,
      // Команды рук офиса идут под Seatbelt — только на macOS и если он запускается.
      sandbox: sandboxAvailable(platform),
      compaction: 'auto',
      costUsd: 'computed',
      planLimits: false,
      balance: false,
      skills: 'tool',
      webSearch: false,
      cloud: false,
    };
  },

  locate: () => locate(),

  async status(provider, opts): Promise<ProviderStatus> {
    const force = opts?.force === true;
    if (!await locate(force)) {
      return { state: 'not-installed', engine: 'opencode', sizeMb: opencodeEngine.sizeMb,
        ...(OPENCODE_PKG ? {} : { detail: `OpenCode is not built for ${process.platform}-${process.arch}` }) };
    }
    const spec = providerSpec(provider);
    const url = baseUrlOf(provider);
    const key = providerKey(provider);
    // Адреса нет — веб видит это по пустому `baseUrl` и просит его в форме входа.
    if (!url) return { state: 'needs-login', auth: ['api-key'] };
    if (!key && !spec.keyOptional) return { state: 'needs-login', auth: ['api-key'] };
    // Свой адрес и Ollama могут просто не работать сейчас — это видно сразу,
    // а не на первой задаче. Облачные пресеты проверены ключом при входе.
    if (spec.editableUrl) {
      const error = await reachable(provider, url, force);
      if (error) return { state: 'unreachable', detail: error };
    }
    const block = limitBlock(Date.now(), provider);
    if (block) return { state: 'limited', kind: 'rate', resetsAt: block.resetsAt ?? undefined };
    return { state: 'ready', auth: key ? 'api-key' : 'none' };
  },

  // Сжатый пакет платформы.
  sizeMb: 45,

  async install(onProgress, signal) {
    if (!OPENCODE_PKG) throw new Error(`OpenCode не собирается под ${process.platform}-${process.arch}`);
    // Ровно проверенная версия: протокол сервера меняется между выпусками.
    const done = await installFromNpm(
      { engine: 'opencode', pkg: OPENCODE_PKG, version: OPENCODE_VERSION, bin: OPENCODE_BIN },
      onProgress, signal);
    await locate(true);
    return done;
  },

  async login(req) {
    const { provider } = req;
    // Подписки у OpenAI-совместимых провайдеров нет: без отказа запрос входа
    // по подписке ушёл бы проверкой ключа и вернул «нужен ключ» вместо «не умею».
    if (req.kind !== 'api-key') throw new LoginError('unsupported', `login kind ${req.kind} is not supported`);
    const spec = providerSpec(provider);
    let url = baseUrlOf(provider);
    if (spec.editableUrl && req.baseUrl !== undefined && req.baseUrl.trim()) {
      const normalized = normalizeBaseUrl(req.baseUrl, provider);
      if (!normalized) throw new LoginError('address', 'expected an http(s) address without credentials');
      url = normalized;
    }
    if (!url) throw new LoginError('address', 'address is required');
    const key = req.apiKey?.trim();
    if (!key && !spec.keyOptional) throw new LoginError('rejected', 'API key is required');
    // Проверка — список моделей: метаданные, ход модели не оплачивается.
    // Без ключа — тот же запрос, он же проверка, что сервер отвечает. При
    // правке своего адреса пустое поле ключа значит «не менять»: проверяем
    // сохранённым, а не голым запросом, который сервер с ключом отвергнет.
    const checkKey = key || (spec.editableUrl ? providerKey(provider)?.key : undefined);
    if (provider === 'custom') {
      const models = await probeModels(url, providerHeaders(provider, checkKey));
      const model = req.custom?.model;
      if (model && models?.length && !models.includes(model)) throw new LoginError('model', `model ${model} is not listed`);
    } else {
      await verifyKey(`${url}/models`, providerHeaders(provider, checkKey));
    }
    if (spec.editableUrl) {
      try { saveBaseUrl(provider, url); } catch (err) { throw new LoginError('address', (err as Error).message); }
    }
    if (provider === 'custom' && req.custom) {
      try { saveCustomApi(req.custom); } catch (err) { throw new LoginError('address', (err as Error).message); }
    }
    if (key) {
      try { await saveKey(provider, key); } catch (err) { throw new LoginError('keychain', (err as Error).message); }
    }
    reach.delete(provider);
    return { done: true, status: await opencodeEngine.status(provider, { force: true }) };
  },

  async logout(provider) {
    await deleteKey(provider);
    forgetBaseUrl(provider);
    if (provider === 'custom') forgetCustomApi();
    reach.delete(provider);
  },

  async models(provider): Promise<ModelInfo[]> {
    // Ключа нет или сервер молчит — хотя бы модели из каталога цен: форма
    // роли покажет их подсказкой, а ввести свою модель можно всё равно.
    const ids = await fetchModels(provider).catch(async () =>
      Object.keys((await priceCatalog())[provider] ?? {}));
    return Promise.all(ids.map(async (id): Promise<ModelInfo> => {
      const known = await catalogModel(provider, id);
      const price = await modelPrice(provider, id);
      return {
        id, label: known?.name ?? id,
        ...(known?.contextWindow ? { contextWindow: known.contextWindow } : {}),
        ...(price ? { price } : {}),
      };
    }));
  },

  start: opencodeQuery,
};

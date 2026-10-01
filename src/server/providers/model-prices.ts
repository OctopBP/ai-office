/**
 * Цены моделей OpenAI-совместимых провайдеров (spec провайдеров §3.5).
 *
 * Источник — каталог models.dev, тот же, что у самого OpenCode. Стоимость
 * считает офис по токенам, а не берёт у движка: у OpenCode цены своих
 * провайдеров нет вовсе, а чтение кеша в его подсчёт не входит.
 *
 * Каталог качается не чаще раза в сутки и лежит копией на диске. Сбой
 * загрузки работу не останавливает: цены нет — на доске видны токены, а
 * бюджет в долларах такой роли не принимается.
 *
 * Поверх каталога — цены владельца: `OFFICE_MODEL_PRICING` = JSON
 * `{ "<провайдер>/<модель>" | "<модель>": { input, output, cachedInput? } }`,
 * доллары за миллион токенов. Так задаётся цена своей модели или модели,
 * которой в каталоге нет.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ProviderId } from '../../shared/providers';
import { DEFAULT_STATE_FILE } from '../store';
import { customApi } from '../engines/endpoints';
import type { TokenPrice } from './pricing';

const CATALOG_URL = 'https://models.dev/api.json';
const DAY = 24 * 60 * 60 * 1000;

/** Сколько про модель нужно офису: цена, окно контекста и умеет ли она инструменты. */
export interface CatalogModel {
  id: string;
  name: string;
  price: (TokenPrice & { cacheWrite?: number }) | null;
  contextWindow?: number;
  toolCall?: boolean;
}

/** Каталог по провайдеру — ровно те провайдеры, что есть у офиса. */
type Catalog = Partial<Record<ProviderId, Record<string, CatalogModel>>>;

const file = (): string => resolve(dirname(DEFAULT_STATE_FILE), 'model-prices.json');

interface RawModel {
  id?: string; name?: string; tool_call?: boolean;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number };
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Из полного каталога (5 МБ) оставить только наших провайдеров и нужные поля. */
function shrink(raw: Record<string, { models?: Record<string, RawModel> }>): Catalog {
  const out: Catalog = {};
  for (const provider of ['xai', 'deepseek', 'openrouter'] as const) {
    const models = raw[provider]?.models;
    if (!models) continue;
    const list: Record<string, CatalogModel> = {};
    for (const [id, m] of Object.entries(models)) {
      const c = m.cost;
      list[id] = {
        id, name: m.name ?? id,
        price: c && num(c.input) && num(c.output)
          ? { input: c.input, output: c.output, cachedInput: num(c.cache_read) ? c.cache_read : c.input,
            ...(num(c.cache_write) ? { cacheWrite: c.cache_write } : {}) }
          : null,
        ...(num(m.limit?.context) && m.limit.context > 0 ? { contextWindow: m.limit.context } : {}),
        ...(typeof m.tool_call === 'boolean' ? { toolCall: m.tool_call } : {}),
      };
    }
    out[provider] = list;
  }
  return out;
}

let memory: Catalog | null = null;
let loading: Promise<Catalog> | null = null;

function fromDisk(): { catalog: Catalog; fresh: boolean } | null {
  try {
    const at = statSync(file()).mtimeMs;
    return { catalog: JSON.parse(readFileSync(file(), 'utf8')) as Catalog, fresh: Date.now() - at < DAY };
  } catch {
    return null;
  }
}

/** Каталог: свежая копия с диска, иначе загрузка; сеть упала — старая копия или пусто. */
export function priceCatalog(): Promise<Catalog> {
  if (memory) return Promise.resolve(memory);
  loading ??= (async () => {
    const disk = fromDisk();
    if (disk?.fresh) return (memory = disk.catalog);
    try {
      const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const catalog = shrink(await res.json() as Record<string, { models?: Record<string, RawModel> }>);
      mkdirSync(dirname(file()), { recursive: true });
      writeFileSync(file(), JSON.stringify(catalog));
      return (memory = catalog);
    } catch (err) {
      console.warn(`[prices] каталог моделей не загрузился: ${(err as Error).message}`);
      // Старая копия лучше, чем никакой; через сутки попробуем снова.
      memory = disk?.catalog ?? {};
      setTimeout(() => { memory = null; loading = null; }, DAY).unref();
      return memory;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Цена владельца из `OFFICE_MODEL_PRICING`; кривая запись не роняет сессию. */
function ownerPrice(provider: ProviderId, model: string): TokenPrice | null {
  const raw = process.env.OFFICE_MODEL_PRICING;
  if (!raw) return null;
  try {
    const table = JSON.parse(raw) as Record<string, Partial<TokenPrice>>;
    const p = table[`${provider}/${model}`] ?? table[model];
    if (!p || !num(p.input) || !num(p.output)) return null;
    return { input: p.input, output: p.output, cachedInput: num(p.cachedInput) ? p.cachedInput : p.input };
  } catch {
    return null;
  }
}

/**
 * Цена модели. У своего адреса и Ollama каталога нет: там цена только от
 * владельца, а без неё — токены без долларов (локальная модель денег не стоит,
 * но и «0 $» писать было бы враньём про чужой сервер).
 */
export async function modelPrice(provider: ProviderId, model: string): Promise<TokenPrice | null> {
  const own = ownerPrice(provider, model) ?? customPrice(provider, model);
  if (own) return own;
  const catalog = await priceCatalog();
  return catalog[provider]?.[model]?.price ?? null;
}

/** Что каталог знает о модели — для списка моделей на форме роли. */
export async function catalogModel(provider: ProviderId, model: string): Promise<CatalogModel | null> {
  return customModel(provider, model) ?? (await priceCatalog())[provider]?.[model] ?? null;
}

/**
 * Свой API: цену и окно контекста владелец пишет в форме — для той модели,
 * которую там же назвал. Другие модели того же сервера остаются без цены.
 */
function customModel(provider: ProviderId, model: string): CatalogModel | null {
  if (provider !== 'custom') return null;
  const meta = customApi();
  if (!meta.model || meta.model !== model) return null;
  return {
    id: model, name: model,
    price: meta.price ? { ...meta.price, cachedInput: meta.price.input } : null,
    ...(meta.contextWindow ? { contextWindow: meta.contextWindow } : {}),
  };
}

function customPrice(provider: ProviderId, model: string): TokenPrice | null {
  const price = customModel(provider, model)?.price;
  return price ? { input: price.input, output: price.output, cachedInput: price.cachedInput } : null;
}

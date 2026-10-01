import { useEffect, useState } from 'react';
import { PROVIDERS, isConnected, type ProviderId } from '../shared/providers';
import type { ProviderView } from '../shared/types';
import { byLabel } from './FirstLaunch';
import { has, t } from './i18n';

/**
 * Выбор провайдера и модели — общие детали для офиса (вкладка «Провайдеры»)
 * и роли (вкладка «Модель» в «Команде»), docs/design/T-189/ui.md §2.1, §5.
 * Список моделей просим у сервера: он знает его через адаптер движка, а
 * зашитый в веб список разошёлся бы с ним при первом же новом провайдере.
 */

export interface ModelOption { id: string; label: string }

// Список моделей провайдера живёт, пока открыта вкладка: переключение между
// ролями не должно дёргать сервер заново на каждую карточку.
const modelCache = new Map<ProviderId, Promise<ModelOption[]>>();

function loadModels(provider: ProviderId): Promise<ModelOption[]> {
  let pending = modelCache.get(provider);
  if (!pending) {
    pending = fetch(`/api/providers/${encodeURIComponent(provider)}`)
      .then((r) => r.json())
      .then((data: { models?: ModelOption[] }) => (data.models ?? []).map(({ id, label }) => ({ id, label })))
      // Сбой не кешируем: со следующим открытием спросим снова.
      .catch(() => { modelCache.delete(provider); return []; });
    modelCache.set(provider, pending);
  }
  return pending;
}

/** Модели провайдера с сервера; пока не пришли — пустой список. */
export function useProviderModels(provider: ProviderId): ModelOption[] {
  const [models, setModels] = useState<{ provider: ProviderId; list: ModelOption[] }>({ provider, list: [] });
  useEffect(() => {
    let alive = true;
    void loadModels(provider).then((list) => { if (alive) setModels({ provider, list }); });
    return () => { alive = false; };
  }, [provider]);
  return models.provider === provider ? models.list : [];
}

/** Подпись модели: у Claude есть свои строки с ценой в словаре, у остальных — что прислал сервер. */
const modelLabel = (m: ModelOption): string => {
  const key = `role.model.${m.id}`;
  return has(key) ? t(key) : m.label || m.id;
};

/**
 * Пункты списка моделей: умолчание провайдера первым и с пометкой, потом
 * остальное с сервера. Незнакомый текущий id — отдельной строкой, чтобы
 * не подменить его молча первым пунктом.
 */
export function modelOptions(provider: ProviderId, models: ModelOption[], current: string): Array<[string, string]> {
  const fallback = PROVIDERS[provider].defaultModel;
  const known = models.find((m) => m.id === fallback);
  const first: [string, string] = [fallback, t('providers.model.default', {
    name: known ? modelLabel(known) : provider === 'codex' ? t('role.model.codexDefault') : fallback,
  })];
  const rest = models.filter((m) => m.id !== fallback).map((m): [string, string] => [m.id, modelLabel(m)]);
  const list = [first, ...rest];
  return current && !list.some(([id]) => id === current) ? [...list, [current, current]] : list;
}

/** Модель, которую можно вписать руками: у Codex список неполный, точный id знает только владелец. */
export const freeModel = (provider: ProviderId): boolean => provider === 'codex';

/**
 * Почему провайдера нельзя выбрать — короткая причина для серого пункта
 * списка; `null` — выбрать можно. Серые пункты не прячем: иначе непонятно,
 * куда делся провайдер.
 */
export function providerBlock(p: ProviderView, opts: { manager?: boolean; cloud?: boolean } = {}): string | null {
  if (!isConnected(p.status)) return statusText(p);
  if (opts.manager && !p.capabilities.streamingInput) return t('providers.role.optNoManager');
  if (opts.cloud && !p.capabilities.cloud) return t('providers.role.optNoCloud');
  return null;
}

/** Состояние строчными буквами — для причины в скобках у пункта списка. */
function statusText(p: ProviderView): string {
  const key = {
    'not-installed': 'providers.status.notInstalled',
    installing: 'providers.status.installing',
    'needs-login': 'providers.status.needsLogin',
    unreachable: 'providers.status.unreachable',
    ready: 'providers.status.ready',
    limited: 'providers.status.limited',
    error: 'providers.status.error',
  }[p.status.state];
  return has(key) ? t(key).toLocaleLowerCase() : p.status.state;
}

/** Пункты провайдеров по алфавиту, как на вкладке; неготовые — серые с причиной. */
export function ProviderOptions({ providers, opts }: {
  providers: ProviderView[];
  opts?: { manager?: boolean; cloud?: boolean };
}) {
  return (
    <>
      {[...providers].sort(byLabel).map((p) => {
        const reason = providerBlock(p, opts);
        return (
          <option key={p.id} value={p.id} disabled={reason !== null}>
            {reason ? t('providers.option.notReady', { name: p.label, reason }) : p.label}
          </option>
        );
      })}
    </>
  );
}

/** Название провайдера: из статуса сервера, пока его нет — из общего списка. */
export const providerLabel = (providers: ProviderView[], id: ProviderId): string =>
  providers.find((p) => p.id === id)?.label ?? PROVIDERS[id].label;

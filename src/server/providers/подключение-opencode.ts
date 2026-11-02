/** Каталог нативных моделей OpenCode. Секреты и рабочие сессии сюда не передаются. */
import { createHash } from 'node:crypto';
import type { КаталогOpenCode, ModelChoice } from '../../shared/providers';
import { проверитьФормуOpenCode } from '../../shared/providers';
import type { ModelInfo } from '../engines/types';
import { OPENCODE_VERSION } from './opencode';
import { сведенияКлючейOpenCode, ревизияКлючейOpenCode } from './ключи-opencode';
import { кешКаталогаOpenCode } from './кеш-каталога-opencode';
import { получитьКаталогOpenCode } from './каталог-процесс-opencode';
const SDK: Record<string, string> = {
  opencode: '@ai-sdk/openai-compatible', openai: '@ai-sdk/openai', anthropic: '@ai-sdk/anthropic',
  google: '@ai-sdk/google', deepseek: '@ai-sdk/deepseek', openrouter: '@openrouter/ai-sdk-provider', xai: '@ai-sdk/xai',
};
export class ОшибкаOpenCode extends Error {
  constructor(readonly статус: number, readonly код: string, сообщение: string, readonly поле?: string) { super(сообщение); }
}
const ошибка = (сообщение: string, поле?: string): never => { throw new ОшибкаOpenCode(400, 'invalid-choice', сообщение, поле); };
type Сырой = Record<string, any>;
export interface Снимок { dto: КаталогOpenCode; модели: Map<string, Сырой> }
const число = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const имя = (v: unknown, fallback: string): string => typeof v === 'string' && !/[\r\n\x00]/.test(v) ? v.slice(0, 200) : fallback;
/** Преобразование не переносит options, headers, npm, auth и содержимое variants в браузер. */
export function каталогDTO(raw: Сырой, версия: string, авторизации: Record<string, { хвост: string }> = {}, ревизияКлючей = 0): Снимок {
  const совместима = версия === OPENCODE_VERSION;
  const модели = new Map<string, Сырой>();
  const провайдеры: КаталогOpenCode['провайдеры'] = [];
  for (const p of Array.isArray(raw?.all) ? raw.all : []) {
    if (!p || typeof p.id !== 'string' || !/^[a-z0-9-]+$/.test(p.id)) continue;
    const поддержан = Object.hasOwn(SDK, p.id) && p.npm === SDK[p.id];
    const key = авторизации[p.id];
    const список = Object.entries(p.models ?? {}).flatMap(([id, m]: [string, any]) => {
      if (!id || /[\x00-\x20]/.test(id)) return [];
      if (!m || typeof m !== 'object' || Array.isArray(m)) return [];
      const cap = m.capabilities ?? {};
      const limit = m.limit ?? {};
      const sdk = m.api?.npm ?? p.npm;
      const пригодна = cap.toolcall === true && cap.input?.text === true && cap.output?.text === true && m.status !== 'deprecated' && sdk === SDK[p.id];
      // Только явно нулевые цены подтверждают публичную модель Zen без ключа.
      const бесплатна = p.id === 'opencode' && Array.isArray(raw.connected) && raw.connected.includes(p.id) && m.cost?.input === 0 && m.cost?.output === 0;
      const доступна = совместима && поддержан && пригодна && Boolean(key || бесплатна);
      const причина = !совместима ? 'Версия движка не проверена офисом' : !поддержан ? 'Пока не поддерживается офисом'
        : !пригодна ? 'Не подтверждены текст, инструменты или проверенный SDK' : !key && !бесплатна ? 'Нужен отдельный ключ API' : undefined;
      const температура = cap.temperature === true && cap.reasoning === false && поддержан && пригодна
        ? { мин: 0, макс: p.id === 'anthropic' ? 1 : 2 } : undefined;
      const пределОтвета = пригодна && поддержан && cap.reasoning === false && число(limit.output) && limit.output >= 1
        ? { мин: 1, макс: Math.min(Math.floor(limit.output), 32000) } : undefined;
      const full = p.id + '/' + id;
      модели.set(full, m);
      return [{ id: full, label: имя(m.name, id),
        ...(число(limit.context) ? { contextWindow: limit.context } : {}),
        ...(число(m.cost?.input) && число(m.cost?.output) ? { price: { input: m.cost.input, output: m.cost.output,
          ...(число(m.cost?.cache?.read) ? { cachedInput: m.cost.cache.read } : {}) } } : {}),
        opencode: { провайдер: p.id, модель: id, статус: имя(m.status, 'active'), инструменты: cap.toolcall === true,
          рассуждение: cap.reasoning === true, варианты: Object.keys(m.variants ?? {}).filter(v => v && v.length <= 100),
          ...(температура ? { температура } : {}), ...(пределОтвета ? { пределОтвета } : {}),
          ...(число(limit.context) ? { контекст: limit.context } : {}), ...(число(limit.input) ? { вход: limit.input } : {}),
          ...(число(limit.output) ? { выход: limit.output } : {}), доступна, ...(причина ? { причина } : {}),
          причиныПараметров: { ...(!температура ? { температура: 'Поддержка температуры для этой модели не подтверждена' } : {}),
            ...(!пределОтвета ? { пределОтвета: 'Неизвестен предел или модель использует рассуждение' } : {}) },
        } }];
    });
    провайдеры.push({ id: p.id, название: имя(p.name, p.id), доступен: совместима && поддержан,
      ...(!поддержан ? { причина: 'Пока не поддерживается офисом' } : {}),
      авторизация: { состояние: !поддержан ? 'не-поддерживается' : key ? 'ключ'
        : список.some(m => m.opencode.доступна) ? 'без-входа' : 'нет', ...(key ? { хвост: key.хвост } : {}) },
      модели: список });
  }
  const dto: КаталогOpenCode = { версия, совместима, проверенныеВерсии: [OPENCODE_VERSION], ревизия: '',
    обновлёнВ: Date.now(), устарел: false, провайдеры };
  dto.ревизия = createHash('sha256').update(JSON.stringify({ версия, провайдеры, авторизации, ревизияКлючей })).digest('hex').slice(0, 24);
  return { dto, модели };
}
export function проверитьВыбор(выбор: ModelChoice, snapshot: Снимок, ревизия?: string): ModelChoice {
  if (snapshot.dto.устарел) throw new ОшибкаOpenCode(409, 'stale-catalog', 'Каталог устарел; обновите модели');
  if (ревизия !== undefined && ревизия !== snapshot.dto.ревизия) throw new ОшибкаOpenCode(409, 'catalog-changed', 'Каталог изменился; обновите описание модели');
  if (выбор.provider !== 'opencode') ошибка('Ожидается провайдер opencode', 'provider');
  const m = snapshot.dto.провайдеры.flatMap(p => p.модели).find(m => m.id === выбор.model);
  if (!m || !m.opencode.доступна) ошибка(m?.opencode.причина ?? 'Сохранённая модель отсутствует в каталоге', 'model');
  let параметры;
  try { параметры = проверитьФормуOpenCode(выбор.opencode ?? {}); } catch (e) { ошибка((e as Error).message, 'opencode'); }
  const meta = m!.opencode;
  if (параметры!.вариант !== undefined && !meta.варианты.includes(параметры!.вариант)) ошибка('Вариант не поддерживается моделью', 'opencode.вариант');
  if (параметры!.температура !== undefined && (!meta.температура || параметры!.температура > meta.температура.макс)) ошибка('Температура не поддерживается моделью', 'opencode.температура');
  if (параметры!.пределОтвета !== undefined && (!meta.пределОтвета || параметры!.пределОтвета > meta.пределОтвета.макс)) ошибка('Предел ответа не поддерживается моделью', 'opencode.пределОтвета');
  return { provider: 'opencode', model: m!.id, opencode: параметры };
}

const получить = кешКаталогаOpenCode(async (версия, ревизия) => {
  // Ключи читаются только связкой; процессу каталога передаётся пустой профиль.
  const сведения = await сведенияКлючейOpenCode();
  try {
    return каталогDTO(await получитьКаталогOpenCode(), версия, сведения, ревизия);
  } catch {
    throw new ОшибкаOpenCode(502, 'upstream', 'Не удалось получить метаданные OpenCode');
  }
});

export async function каталогOpenCode(версия: string, обновить = false): Promise<Снимок> {
  // Непроверенную версию не запускаем даже ради метаданных.
  if (версия !== OPENCODE_VERSION) return каталогDTO({}, версия);
  const ревизия = ревизияКлючейOpenCode();
  const снимок = await получить(версия, ревизия, обновить);
  if (ревизия !== ревизияКлючейOpenCode()) throw new ОшибкаOpenCode(409, 'catalog-changed', 'Подключения изменились; обновите каталог');
  return снимок;
}

export function моделиКаталога(снимок: Снимок): ModelInfo[] {
  return снимок.dto.провайдеры.flatMap(p => p.модели).filter(m => m.opencode.доступна);
}

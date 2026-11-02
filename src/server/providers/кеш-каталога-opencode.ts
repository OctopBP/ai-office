/** Изолированный кеш: версия движка и ревизия ключей не смешиваются. */
import type { Снимок } from './подключение-opencode';

export const СРОК_КАТАЛОГА_OPENCODE = 15 * 60_000;

export function кешКаталогаOpenCode(
  получить: (версия: string, ревизия: number) => Promise<Снимок>,
  часы: () => number = Date.now,
) {
  const снимки = new Map<string, Снимок>();
  const загрузки = new Map<string, Promise<Снимок>>();
  return async (версия: string, ревизия: number, обновить = false): Promise<Снимок> => {
    const ключ = JSON.stringify([версия, ревизия]);
    const прежний = снимки.get(ключ);
    if (!обновить && прежний && !прежний.dto.устарел && часы() - прежний.dto.обновлёнВ < СРОК_КАТАЛОГА_OPENCODE) {
      return structuredClone(прежний);
    }
    let загрузка = загрузки.get(ключ);
    if (!загрузка) {
      загрузка = (async () => {
        try {
          const новый = await получить(версия, ревизия);
          новый.dto.обновлёнВ = часы();
          снимки.set(ключ, новый);
          // Не удерживаем старые ревизии с метаданными удалённых ключей.
          for (const k of снимки.keys()) if (k !== ключ) снимки.delete(k);
          return новый;
        } catch (ошибка) {
          if (!прежний) throw ошибка;
          return { ...прежний, dto: { ...прежний.dto, устарел: true } };
        }
      })();
      загрузки.set(ключ, загрузка);
    }
    try { return structuredClone(await загрузка); }
    finally { if (загрузки.get(ключ) === загрузка) загрузки.delete(ключ); }
  };
}

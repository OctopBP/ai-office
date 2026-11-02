/** Независимые ключи нативных поставщиков: без окружения и файлов JSON. */
import { keychain, type Keychain } from '../engines/keys';

export const ПОСТАВЩИКИ_OPENCODE = ['opencode', 'openai', 'anthropic', 'google', 'deepseek', 'openrouter', 'xai'] as const;

export class ОшибкаКлючаOpenCode extends Error {
  constructor() { super('Системная связка ключей OpenCode недоступна'); }
}

function учётка(id: string): string {
  if (!(ПОСТАВЩИКИ_OPENCODE as readonly string[]).includes(id)) throw new Error('Неподдерживаемый поставщик OpenCode');
  return 'provider:opencode:' + id;
}

/** Зависимость подменяется в проверках; ошибки системной программы никогда не выходят наружу. */
export function хранилищеКлючейOpenCode(связка: Keychain) {
  async function выполнить<T>(действие: () => Promise<T>): Promise<T> {
    try {
      if (!await связка.available()) throw new ОшибкаКлючаOpenCode();
      return await действие();
    } catch { throw new ОшибкаКлючаOpenCode(); }
  }
  return {
    async сведения(): Promise<Record<string, { хвост: string }>> {
      return выполнить(async () => {
        const результат: Record<string, { хвост: string }> = {};
        for (const id of ПОСТАВЩИКИ_OPENCODE) {
          const ключ = await связка.get(учётка(id));
          if (ключ) результат[id] = { хвост: ключ.slice(-4) };
        }
        return результат;
      });
    },
    async сохранить(id: string, ключ: unknown): Promise<void> {
      const имя = учётка(id);
      if (typeof ключ !== 'string' || !ключ || ключ.length > 1500 || /\s|[\x00-\x1f\x7f]/.test(ключ)) {
        throw new Error('Ожидается непустой ключ API до 1500 знаков без пробелов');
      }
      await выполнить(() => связка.set(имя, ключ));
      ревизия++;
    },
    /** Вызывается будущим адаптером запуска только для выбранного поставщика. */
    async прочитать(id: string): Promise<string | null> {
      const имя = учётка(id);
      return выполнить(() => связка.get(имя));
    },
    /** Остановка активных сессий перед удалением — обязанность будущего API. */
    async удалить(id: string): Promise<void> {
      const имя = учётка(id);
      await выполнить(() => связка.delete(имя));
      ревизия++;
    },
  };
}

let ревизия = 0;
export const ревизияКлючейOpenCode = () => ревизия;
export const ключиOpenCode = хранилищеКлючейOpenCode(keychain);
export const сведенияКлючейOpenCode = () => ключиOpenCode.сведения();

import { modelPrice } from './model-prices';

/** Цена за миллион токенов: обычный ввод, чтение кеша и вывод. */
export interface TokenPrice { input: number; cachedInput: number; output: number }
/** Переопределение владельца имеет приоритет над каталогом OpenAI. */
export async function codexPrice(model: string): Promise<TokenPrice | null> {
  const raw = process.env.OFFICE_CODEX_PRICING;
  if (raw) {
    try {
      const price = JSON.parse(raw)[model] as TokenPrice | undefined;
      if (price && [price.input, price.cachedInput, price.output].every(v => Number.isFinite(v) && v >= 0)) return price;
    } catch { /* Некорректная настройка не должна останавливать сессию. */ }
  }
  return modelPrice('codex', model);
}
export function tokenCost(price: TokenPrice, input: number, cached: number, output: number): number {
  return (input * price.input + cached * price.cachedInput + output * price.output) / 1_000_000;
}

/** Optional deployment-specific USD prices per million tokens, keyed by exact model id. */
export interface TokenPrice { input: number; cachedInput: number; output: number }
export function codexPrice(model: string): TokenPrice | null {
  const raw = process.env.OFFICE_CODEX_PRICING;
  if (!raw) return null;
  const price = JSON.parse(raw)[model] as TokenPrice | undefined;
  if (!price) return null;
  if (![price.input, price.cachedInput, price.output].every(v => Number.isFinite(v) && v >= 0)) {
    throw new Error(`Invalid OFFICE_CODEX_PRICING for ${model}`);
  }
  return price;
}
export function tokenCost(price: TokenPrice, input: number, cached: number, output: number): number {
  return (input * price.input + cached * price.cachedInput + output * price.output) / 1_000_000;
}

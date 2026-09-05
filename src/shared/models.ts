/**
 * Модели, которые офис предлагает на выбор, и их короткие имена.
 *
 * Пакет агента называет модель алиасом (`opus`, `sonnet`, `haiku`), а не
 * полным id: полные id меняются с каждым поколением моделей, и пакет,
 * прибитый к `claude-sonnet-4-5`, через год не запустился бы вовсе. Алиас
 * разрешает офис — в тот id, который актуален у него сейчас. Кому нужна
 * именно та модель, пишет полный id: он проходит как есть.
 *
 * Список общий с вебом: форма роли предлагает ровно эти модели.
 */
export const MODEL_ALIASES = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
} as const;

export type ModelAlias = keyof typeof MODEL_ALIASES;

/** Полные id известных офису моделей, в порядке от сильной к дешёвой. */
export const MODEL_IDS: readonly string[] = Object.values(MODEL_ALIASES);

/**
 * Форма id модели. Точного списка на сервере нет и быть не должно: модели
 * появляются чаще, чем выходит офис, а выбор из знакомых предлагает UI. Здесь
 * отсекается мусор — пустое поле и строки, которые SDK не примет.
 */
export const MODEL_RE = /^[a-z0-9][a-z0-9._-]*$/;

export const isModelAlias = (value: string): value is ModelAlias => value in MODEL_ALIASES;

/** Алиас — в полный id; полный id — как есть. */
export const resolveModel = (value: string): string =>
  (isModelAlias(value) ? MODEL_ALIASES[value] : value);

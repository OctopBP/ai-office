/**
 * Модели, которые офис предлагает на выбор, и их короткие имена.
 *
 * Пакет агента называет модель алиасом (`fable`, `opus`, `sonnet`, `haiku`), а
 * не полным id: полные id меняются с каждым поколением моделей, и пакет,
 * прибитый к `claude-sonnet-4-5`, через год не запустился бы вовсе. Алиас
 * разрешает офис — в тот id, который актуален у него сейчас. Кому нужна
 * именно та модель, пишет полный id: он проходит как есть.
 *
 * Набор алиасов повторяет алиасы самого движка (`claude-agent-sdk`: `fable`,
 * `opus`, `sonnet`, `haiku`), чтобы офис и движок понимали одно и то же слово
 * одинаково.
 *
 * Список общий с вебом: форма роли предлагает ровно эти модели.
 */
export const MODEL_ALIASES = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
} as const;

export type ModelAlias = keyof typeof MODEL_ALIASES;

/**
 * Полные id моделей, которые форма роли предлагает списком, от сильной к
 * дешёвой. Список сверен с типом `Model` установленного `@anthropic-ai/sdk`
 * (`resources/messages/messages.d.ts`) — это то, что API принимает сегодня.
 *
 * Чего здесь намеренно нет: моделей по приглашению (`claude-mythos-5`,
 * `claude-mythos-preview` — их не выдать обычным ключом) и id с датой
 * (`claude-haiku-4-5-20251001` и подобные) — это те же модели, закреплённые за
 * снимком, и в списке они были бы дублями. Поле ввода свободное: кому нужен
 * именно такой id, вписывает его руками, проверка пропустит.
 */
export const MODEL_IDS: readonly string[] = [
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

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

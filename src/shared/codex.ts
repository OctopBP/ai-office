/** Модель из model/list установленного Codex; id — имя для выбора модели (model). */
export interface МодельCodex {
  id: string;
  label: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
}

/** Успешный пустой каталог отличается от ошибки получения. */
export type КаталогCodex =
  | { ok: true; models: МодельCodex[] }
  | { ok: false; code: 'catalog-unavailable'; message: string };

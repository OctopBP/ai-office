import type { ModelChoice } from './providers.js';

/** Модель из model/list установленного Codex; id — имя для выбора модели (model). */
export interface МодельCodex {
  id: string;
  label: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
}

/** Параметры существующего ModelChoice; отсутствие усилия допустимо в старых данных. */
export interface ПараметрыCodex {
  reasoningEffort?: string;
}

/** Тот же выбор провайдера и модели, суженный до Codex; второго поля модели нет. */
export type ВыборCodex = Omit<ModelChoice, 'provider' | 'opencode'> & { provider: 'codex' };

/** Успешный пустой каталог отличается от ошибки получения. */
export type КаталогCodex =
  | { ok: true; models: МодельCodex[] }
  | { ok: false; code: 'catalog-unavailable'; message: string };

/** Причина отказа пригодна для формы настроек без разбора текста сообщения. */
export class ОшибкаНастроекCodex extends Error {
  constructor(
    public readonly code: 'invalid-settings' | 'catalog-unavailable' | 'invalid-model' | 'invalid-effort',
    сообщение: string,
  ) {
    super(сообщение);
    this.name = 'ОшибкаНастроекCodex';
  }
}

/**
 * Чистая проверка входных данных по переданному каталогу, без сети и мутаций.
 * Старое model="default" разрешается в единственную isDefault модель каталога.
 * Отсутствующее усилие остаётся отсутствующим: применяется умолчание самой модели.
 * Несовместимое усилие (в том числе после смены модели) — явная ошибка.
 * Вызывающий код должен удалить codex.reasoningEffort или выбрать поддерживаемое;
 * молчаливой подмены и наследования усилия от другой модели нет.
 */
export function проверитьВыборCodex(значение: unknown, каталог: КаталогCodex): ВыборCodex {
  const объект = (вход: unknown): вход is Record<string, unknown> =>
    вход !== null && typeof вход === 'object' && !Array.isArray(вход);
  if (!объект(значение) || значение.provider !== 'codex' || typeof значение.model !== 'string' || !значение.model) {
    throw new ОшибкаНастроекCodex('invalid-settings', 'Codex: ожидается выбор provider=codex и непустая модель');
  }
  const параметры = значение.codex;
  if (параметры !== undefined && (!объект(параметры)
    || Object.keys(параметры).some(ключ => ключ !== 'reasoningEffort')
    || (параметры.reasoningEffort !== undefined
      && (typeof параметры.reasoningEffort !== 'string' || !параметры.reasoningEffort)))) {
    throw new ОшибкаНастроекCodex('invalid-settings', 'Codex: ожидается объект с необязательным reasoningEffort');
  }
  if (!каталог.ok) throw new ОшибкаНастроекCodex('catalog-unavailable', каталог.message);
  const кандидаты = каталог.models.filter(модель =>
    значение.model === 'default' ? модель.isDefault : модель.id === значение.model);
  if (кандидаты.length !== 1) {
    throw new ОшибкаНастроекCodex('invalid-model', 'Codex: модель отсутствует в каталоге или определена неоднозначно');
  }
  const модель = кандидаты[0];
  const усилие = параметры === undefined ? undefined : (параметры as Record<string, unknown>).reasoningEffort;
  if (усилие !== undefined && !модель.supportedReasoningEfforts.some(вариант => вариант.reasoningEffort === усилие)) {
    throw new ОшибкаНастроекCodex('invalid-effort', `Codex: усилие ${усилие} не поддерживается моделью ${модель.id}`);
  }
  return {
    provider: 'codex',
    model: модель.id,
    ...(усилие === undefined ? {} : { codex: { reasoningEffort: усилие as string } }),
  };
}

/**
 * Весь ModelChoice агента переопределяет весь офисный выбор.
 * undefined/null у агента — наследование; удаление override возвращает его.
 * Пустого офисного выбора достаточно, если у агента есть собственный.
 * Проверяется только итоговый выбор: неиспользуемая настройка офиса не блокирует агента.
 * Для других провайдеров каталог Codex не нужен. Входы не изменяются.
 */
export function эффективныйВыборМодели(
  офис: ModelChoice | null,
  агент: ModelChoice | null | undefined,
  каталог: КаталогCodex,
): ModelChoice | null {
  const выбор = агент ?? офис;
  return выбор?.provider === 'codex' ? проверитьВыборCodex(выбор, каталог) : выбор;
}

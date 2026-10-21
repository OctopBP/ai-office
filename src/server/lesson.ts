/**
 * Поля урока в журнале (T-665, D-8 §3, идея B): `cue` — в какой ситуации урок
 * применять, `evidence` — на чём он основан (задачи T-N, записи J-N, отзывы
 * ревью, коммиты). Урок без основания не отклоняется — агенты, которые про
 * поля не знают, пишут как раньше, — но получает пометку `unfounded`.
 *
 * Модуль без зависимостей: им пользуются и состояние (запись, загрузка
 * state.json), и журнал, и ритуалы.
 */
import type { FactKind } from '../shared/types';

/** Сколько ссылок основания храним у одной записи. */
export const EVIDENCE_MAX = 10;
/** Длина подсказки «когда применять» и одной ссылки основания. */
export const CUE_MAX = 300;
export const EVIDENCE_ITEM_MAX = 200;

export interface LessonFields {
  cue?: string;
  evidence?: string[];
  unfounded?: true;
}

const line = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * Привести поля к виду записи. Вход — что угодно: параметры инструмента или
 * старый state.json, где полей нет или они испорчены, — падать на нём нельзя.
 * `fallback` — основание по умолчанию (задача, из которой урок родился).
 */
export function lessonFields(
  kind: FactKind, input: { cue?: unknown; evidence?: unknown }, fallback: string[] = [],
): LessonFields {
  const out: LessonFields = {};
  if (typeof input.cue === 'string' && input.cue.trim()) out.cue = line(input.cue, CUE_MAX);
  const raw = Array.isArray(input.evidence) ? input.evidence
    : typeof input.evidence === 'string' ? [input.evidence] : [];
  const evidence: string[] = [];
  for (const item of [...raw, ...(raw.length ? [] : fallback)]) {
    if (typeof item !== 'string') continue;
    const ref = line(item, EVIDENCE_ITEM_MAX);
    if (ref && !evidence.includes(ref)) evidence.push(ref);
    if (evidence.length >= EVIDENCE_MAX) break;
  }
  if (evidence.length) out.evidence = evidence;
  else if (kind === 'lesson') out.unfounded = true;
  return out;
}

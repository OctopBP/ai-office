import type { CSSProperties } from 'react';
import type { OfficeView } from '../shared/types';

/** Размер общей палитры акцентов — токены --accent-1..8 в tokens.css. */
const ACCENT_COUNT = 8;

/** Устойчивый хеш строки (FNV-1a) — не криптографический, только для распределения по палитре. */
function hashOfficeId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Номер цвета палитры для офиса — детерминированно из id офиса, а не из
 * имени или позиции в списке: не меняется при переименовании и между
 * перезапусками.
 */
function accentIndex(officeId: string): number {
  return (hashOfficeId(officeId) % ACCENT_COUNT) + 1;
}

/**
 * Цвет подложки аватарки офиса. Берётся из общей палитры акцентов
 * (tokens.css, --accent-1..8) — той же, которой красятся значки ролей в
 * бейджах агентов над головой.
 */
export function officeAvatarColor(officeId: string): string {
  return `var(--accent-${accentIndex(officeId)})`;
}

/**
 * Краска инициала и эмодзи поверх этой подложки. Одной белой на всю палитру
 * мало: на янтарном и лаймовом белый текст не читается — у каждого цвета
 * свои чернила (--accent-N-ink).
 */
export function officeAvatarInk(officeId: string): string {
  return `var(--accent-${accentIndex(officeId)}-ink)`;
}

/**
 * Подложка аватарки офиса целиком: заливка, чернила и — для картинки с
 * выбранным цветом — рамка.
 *
 * Выбранный цвет (`office.color`, ключ палитры) сильнее цвета из хеша id.
 * Картинка закрывает подложку полностью (object-fit: cover), поэтому для неё
 * цвет виден только кольцом вокруг; без выбранного цвета кольца нет — всё как
 * было до появления цвета.
 */
export function officeAvatarStyle(office: OfficeView): CSSProperties {
  if (!office.color) {
    return { background: officeAvatarColor(office.id), color: officeAvatarInk(office.id) };
  }
  const style: CSSProperties = {
    background: `var(--${office.color})`,
    color: `var(--${office.color}-ink)`,
  };
  if (office.icon?.kind === 'image') style.boxShadow = `0 0 0 2px var(--${office.color})`;
  return style;
}

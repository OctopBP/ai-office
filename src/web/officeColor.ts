/** Число цветов подложки аватарки офиса — см. --office-color-1..8 в tokens.css. */
const OFFICE_COLOR_COUNT = 8;

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
 * Цвет подложки аватарки офиса — детерминированно из id офиса, а не из имени
 * или позиции в списке: не меняется при переименовании и между перезапусками.
 * Палитра — токены --office-color-1..8 в tokens.css.
 */
export function officeAvatarColor(officeId: string): string {
  const index = hashOfficeId(officeId) % OFFICE_COLOR_COUNT;
  return `var(--office-color-${index + 1})`;
}

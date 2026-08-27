/**
 * Спрайты офиса из design/sprites/out, генерируются design/sprites/gen.py:
 * 1 арт-пиксель = 3 экранных, тайл = 48px. Две темы — day и night,
 * наборы имён в них одинаковые.
 */
import { has, t } from './i18n';

const modules = import.meta.glob('../../design/sprites/out/*/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export type Theme = 'day' | 'night';

const byTheme: Record<string, Record<string, string>> = {};
for (const [path, url] of Object.entries(modules)) {
  const parts = path.split('/');
  const name = parts.pop()!.replace('.png', '');
  const theme = parts.pop()!;
  (byTheme[theme] ??= {})[name] = url;
}

export const THEMES = Object.keys(byTheme).sort() as Theme[];

/** Спрайт по имени в выбранной теме; если его там нет — берём из day. */
export function spriteOf(theme: Theme, name: string): string {
  return byTheme[theme]?.[name] ?? byTheme.day?.[name] ?? '';
}

/** Какой человечек рисуется для роли. Спрайтов пока меньше, чем ролей. */
export const AGENT_SPRITE: Record<string, string> = {
  pm: 'agent_pm',
  backend: 'agent_backend1',
  frontend: 'agent_frontend1',
  design: 'agent_uiux',
  smm: 'agent_backend2',
  reviewer: 'agent_backend2',
  artist: 'agent_uiux',
  artist3d: 'agent_uiux',
  legal: 'agent_frontend1',
};

/** Второй и последующие клоны роли — другим спрайтом, чтобы различались. */
const CLONE_SPRITE: Record<string, string> = { backend: 'agent_backend2' };

/**
 * Внешность агента: если у роли выбран пресет (`RoleEditable.sprite`) — он
 * главнее подбора по id роли, иначе действует прежнее правило (§ RoleEditable.sprite).
 */
export function agentSpriteName(roleId: string, instanceId: string, roleSprite?: string): string {
  if (roleSprite) return roleSprite;
  const n = Number(instanceId.split('#')[1] ?? '1');
  if (n > 1 && CLONE_SPRITE[roleId]) return CLONE_SPRITE[roleId];
  return AGENT_SPRITE[roleId] ?? 'agent_backend1';
}

/**
 * Пресеты внешности для выбора в форме роли — id и подпись.
 *
 * Подпись берётся из словаря, а не из каталога: каталог собирает генератор
 * спрайтов, и подпись там записана на одном языке навсегда. У пресета, до
 * которого словарь ещё не дошёл (художник нарисовал новый), остаётся подпись
 * из каталога — это лучше, чем голый `agent_p11`.
 */
export function spritePresets(catalogSprites: Record<string, { label?: string }>): Array<{ id: string; label: string }> {
  return Object.entries(catalogSprites)
    .filter(([id]) => /^agent_p\d+$/.test(id))
    .sort(([a], [b]) => Number(a.slice(8)) - Number(b.slice(8)))
    .map(([id, sprite]) => {
      const key = `sprite.${id}`;
      return { id, label: has(key) ? t(key) : (sprite.label ?? id) };
    });
}

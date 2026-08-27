/**
 * Спрайты офиса из design/sprites/out, генерируются design/sprites/gen.py:
 * 1 арт-пиксель = 3 экранных, тайл = 48px. Две темы — day и night,
 * наборы имён в них одинаковые.
 */
import { lookById } from '../shared/looks';

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
 * Спрайт агента в плоском офисе.
 *
 * Внешность роли (`RoleEditable.sprite`) — это скин трёхмерной модели, и
 * плоскому офису он ни о чём не говорит: у каждой внешности прописан свой
 * пиксельный человечек (`Look.sprite`). Старые сохранённые значения — это
 * имена спрайтов, а не внешностей; их и берём как есть, иначе роль, заведённая
 * до появления скинов, потеряла бы выбранный когда-то вид.
 *
 * Ничего не выбрано — действует прежнее правило подбора по id роли
 * (§ RoleEditable.sprite).
 */
export function agentSpriteName(roleId: string, instanceId: string, roleSprite?: string): string {
  const look = lookById(roleSprite);
  if (look) return look.sprite;
  if (roleSprite) return roleSprite;
  const n = Number(instanceId.split('#')[1] ?? '1');
  if (n > 1 && CLONE_SPRITE[roleId]) return CLONE_SPRITE[roleId];
  return AGENT_SPRITE[roleId] ?? 'agent_backend1';
}

/**
 * Спрайты офиса. Файлы лежат в design/sprites/out и генерируются
 * design/sprites/gen.py: 1 арт-пиксель = 3 экранных, тайл = 48px.
 */
const modules = import.meta.glob('../../design/sprites/out/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

export const sprite: Record<string, string> = Object.fromEntries(
  Object.entries(modules).map(([path, url]) => [
    path.split('/').pop()!.replace('.png', ''),
    url,
  ]),
);

/** Какой человечек рисуется для роли. Спрайтов пока меньше, чем ролей. */
export const AGENT_SPRITE: Record<string, string> = {
  pm: 'agent_pm',
  backend: 'agent_backend1',
  frontend: 'agent_frontend1',
  design: 'agent_uiux',
  smm: 'agent_backend2',
  legal: 'agent_frontend1',
};

/** Второй и последующие клоны роли — другим спрайтом, чтобы различались. */
export const CLONE_SPRITE: Record<string, string> = {
  backend: 'agent_backend2',
};

export function agentSprite(roleId: string, instanceId: string): string {
  const n = Number(instanceId.split('#')[1] ?? '1');
  if (n > 1 && CLONE_SPRITE[roleId]) return CLONE_SPRITE[roleId];
  return AGENT_SPRITE[roleId] ?? 'agent_backend1';
}

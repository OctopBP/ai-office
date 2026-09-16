/**
 * Портреты агентов — иконки для аватарок в интерфейсе.
 *
 * Портрет привязан к внешности, а не к роли: `portraits/<id>.png`, где `id` —
 * то же имя, что у скина в `design/models/characters/skins` и у записи в
 * `looks.json`. Сменил роли внешность — сменилась и аватарка, и она всегда
 * показывает того человечка, что сидит в комнате.
 *
 * Портрет необязателен: пока художник не нарисовал его для внешности,
 * аватарка остаётся квадратом цвета роли с кодом (`Avatar.tsx`).
 *
 * Как добавить: png с прозрачным фоном, бюст по центру, квадрат 256×256 —
 * положить в `design/models/characters/portraits/` под именем внешности.
 * Больше ничего не нужно: список собирается из папки при сборке.
 */
import { lookById, lookFor } from '../shared/looks';
import { useStore } from './store';

const modules = import.meta.glob('../../design/models/characters/portraits/*.png', {
  eager: true, query: '?url', import: 'default',
}) as Record<string, string>;

const PORTRAITS: Record<string, string> = {};
for (const [path, url] of Object.entries(modules)) {
  PORTRAITS[path.split('/').pop()!.replace('.png', '')] = url;
}

/** Портрет внешности; не нарисован — undefined. */
export function portraitOf(lookId: string | undefined): string | undefined {
  return lookId ? PORTRAITS[lookId] : undefined;
}

/**
 * Внешность, которую показывать на аватарке.
 *
 * У сотрудника — ровно та, что в комнате: номер по кругу считается от
 * порядка сотрудников так же, как в `Agents3D.tsx`. У самой роли (без
 * сотрудника) — только явно выбранная: подбирать по кругу там не от чего, и
 * случайное лицо на карточке роли врало бы.
 */
export function useLookOf(roleId: string, instanceId?: string): string | undefined {
  return useStore((s) => {
    const sprite = s.roles.find((r) => r.id === roleId)?.sprite;
    const index = instanceId ? Object.keys(s.instances).indexOf(instanceId) : -1;
    return index < 0 ? lookById(sprite)?.id : lookFor(sprite, index);
  });
}

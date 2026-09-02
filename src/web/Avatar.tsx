import { useStore } from './store';

/** Цвет значка, если роль неизвестна — например, её удалили из офиса. */
export const NO_ROLE_COLOR = '#94a3b8';

/**
 * Короткое обозначение должности с номером: `backend#1` → `B1`, `pm#1` → `PM1`.
 *
 * Считается по идентификатору роли, а не по её названию: идентификатор
 * латинский, без пробелов и не меняется при переименовании должности, —
 * значок остаётся тем же, как бы роль ни назвали в интерфейсе. Двухбуквенные
 * идентификаторы (`pm`) берутся целиком: «P» вместо «PM» узнаётся хуже.
 * Без номера (у самой роли, не у сотрудника) — только буквы.
 */
export function shortCode(roleId: string, instanceId?: string): string {
  const n = instanceId?.split('#')[1] ?? '';
  const id = roleId || '?';
  const abbr = id.length <= 2 ? id.toUpperCase() : id[0].toUpperCase();
  return `${abbr}${n}`;
}

/**
 * Аватарка-заглушка: квадрат цвета роли с её кодом — тот же значок, что в
 * бейдже над головой в сцене и у офисов в рейле. Портреты трёхмерной
 * моделью (`office3d/AgentAvatar.tsx`) отложены: общий холст ломался при
 * монтировании превью, и до починки честнее показывать код, чем пустой
 * квадрат.
 */
export function Avatar({ roleId, instanceId, size = 'md', className }: {
  roleId: string;
  instanceId?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const color = useStore((s) => s.roles.find((r) => r.id === roleId)?.color) || NO_ROLE_COLOR;
  return (
    <span className={`avatar-ph ${size}${className ? ` ${className}` : ''}`} style={{ background: color }}>
      {shortCode(roleId, instanceId)}
    </span>
  );
}

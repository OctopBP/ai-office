/**
 * Как сотрудник называется на экране.
 *
 * Внутри офиса сотрудник адресуется идентификатором экземпляра (`backend#2`):
 * по нему идут назначение задачи, ветка и сессия. Владельцу этот код не
 * говорит ничего, а решётка в подписи читается как поломка, поэтому в видимый
 * текст он не попадает — ни над головой в комнате, ни в окне «Команда», ни на
 * карточке задачи, ни в чате.
 *
 * Правило одно на весь интерфейс:
 * — дано имя — зовём по имени;
 * — роль нанята в одном экземпляре — только название должности;
 * — экземпляров несколько — название с номером по-человечески
 *   («Backend разработчик 2»), иначе трёх бэкендеров в комнате не различить.
 *
 * Номер берётся из идентификатора, а не из порядка в списке: он у сотрудника
 * не меняется, пока тот работает, и подпись не скачет при увольнении соседа.
 */
import { useStore } from './store';
import type { InstanceView, RoleView } from '../shared/types';

/** Роль из идентификатора экземпляра: `backend#2` → `backend`. */
export const roleOfInstance = (id: string): string => id.split('#')[0] ?? id;

/** Номер экземпляра в роли: `backend#2` → 2; без номера — 1. */
const numberOfInstance = (id: string): number => Number(id.split('#')[1] ?? '1') || 1;

/**
 * Подпись сотрудника для показа. `id` — идентификатор экземпляра; сотрудника
 * может уже не быть в офисе (уволен, а его реплики и задачи остались) — тогда
 * подпись собирается из того, что есть: названия роли, а без роли — её
 * идентификатора из самого `id`.
 */
export function displayInstance(
  id: string,
  instances: Record<string, InstanceView>,
  roles: RoleView[],
): string {
  const inst = instances[id];
  if (inst?.name) return inst.name;
  const roleId = inst?.roleId ?? roleOfInstance(id);
  const title = roles.find((r) => r.id === roleId)?.title || roleId;
  // Номер нужен только там, где без него подписи сливаются: считаем живые
  // экземпляры роли, а не смотрим на номер в id. Уволили первого из двух —
  // оставшийся снова зовётся просто должностью.
  const copies = Object.values(instances).filter((i) => i.roleId === roleId).length;
  return copies > 1 ? `${title} ${numberOfInstance(id)}` : title;
}

/** То же для компонентов: подпись пересчитывается на переименование и найм. */
export function useInstanceName(id: string): string {
  return useStore((s) => displayInstance(id, s.instances, s.roles));
}

import { useEffect } from 'react';
import { clearRoleFeedback, updateRole, useStore } from './store';
import { t } from './i18n';
import type { RoleView, SubprojectView } from '../shared/types';

/** Сколько чипов зон показывает строка сотрудника; остальное — «+N». */
const MAX_CHIPS = 3;

/** Цвет зоны хранится именем токена (`accent-3`), в стиле он — переменная. */
const zoneColor = (z: SubprojectView | undefined): string => (z ? `var(--${z.color})` : 'var(--ink-3)');

function ZoneChip({ id, zone }: { id: string; zone: SubprojectView | undefined }) {
  const lost = !zone;
  const title = lost ? t('team.zones.lostHint') : zone.problem ? zone.problem : zone.name;
  return (
    <span className={`team-zone-chip${lost ? ' lost' : ''}`} title={title}>
      <span className="team-zone-dot" style={{ background: zoneColor(zone) }} aria-hidden="true" />
      {zone?.name ?? id}{(lost || zone.problem) && <span aria-hidden="true"> ⚠</span>}
    </span>
  );
}

/** Ряд чипов зон в строке сотрудника. В офисе без зон и у менеджера, где нечего показать, — ничего. */
export function ZoneChips({ role }: { role: RoleView }) {
  const zones = useStore((s) => s.subprojects);
  if (!zones.length) return null;
  if (role.isManager) return <span className="team-zones muted small">{t('team.zones.manager')}</span>;
  const ids = role.subprojects ?? [];
  if (!ids.length) return <span className="team-zones"><span className="team-zone-chip all">{t('team.zones.all')}</span></span>;
  const shown = ids.slice(0, MAX_CHIPS);
  const rest = ids.slice(MAX_CHIPS);
  const names = ids.map((id) => zones.find((z) => z.id === id)?.name ?? id).join(', ');
  return (
    <span className="team-zones">
      {shown.map((id) => <ZoneChip key={id} id={id} zone={zones.find((z) => z.id === id)} />)}
      {rest.length > 0 && <span className="team-zone-chip all" title={names}>+{rest.length}</span>}
    </span>
  );
}

/** Закрепление роли за зонами: кнопки-переключатели; пусто — «Весь проект». */
export function ZonePinning({ role }: { role: RoleView }) {
  // Все хуки — до раннего возврата: их число не должно зависеть от зон и роли.
  const zones = useStore((s) => s.subprojects);
  // Состояние чипов — только из ролей с сервера; отказ приходит событием role.error.
  const fb = useStore((s) => s.roleFeedback);
  // Смена выбранной роли сбрасывает старый отказ, чтобы он не висел под чужими чипами.
  useEffect(() => { clearRoleFeedback(); }, [role.id]);
  if (!zones.length || role.isManager) return null;
  const ids = role.subprojects ?? [];
  const lost = ids.filter((id) => !zones.some((z) => z.id === id));
  const refusal = fb && fb.roleId === role.id && fb.op === 'update'
    ? fb.errors.find((e) => e.field === 'subprojects' || e.field === '')?.message
    : undefined;
  const set = (next: string[]) => updateRole(role.id, { subprojects: next });
  const toggle = (id: string) => set(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  return (
    <div className="team-pin" role="group" aria-label={t('team.zones.title')}>
      <span className="group-title">{t('team.zones.title')}</span>
      <div className="team-pin-list">
        <button
          type="button" className={`team-pin-opt${ids.length === 0 ? ' on' : ''}`}
          aria-pressed={ids.length === 0} onClick={() => set([])}
        >
          {ids.length === 0 && '✓ '}{t('team.zones.all')}
        </button>
        {zones.map((z) => {
          const on = ids.includes(z.id);
          const blocked = !!z.problem && !on;
          return (
            <button
              type="button" key={z.id} className={`team-pin-opt${on ? ' on' : ''}`} aria-pressed={on}
              disabled={blocked} title={z.problem ?? undefined} onClick={() => toggle(z.id)}
            >
              <span className="team-zone-dot" style={{ background: zoneColor(z) }} aria-hidden="true" />
              {on && '✓ '}{z.name}{z.problem && ' ⚠'}
            </button>
          );
        })}
        {lost.map((id) => (
          <button type="button" key={id} className="team-pin-opt on lost" aria-pressed title={t('team.zones.lostHint')} onClick={() => toggle(id)}>
            ✓ {id} ⚠
          </button>
        ))}
      </div>
      {refusal && <span className="menu-error" role="alert"><span aria-hidden="true">⚠ </span>{refusal}</span>}
      <span className="hint">{lost.length ? t('team.zones.lost') : t('team.zones.hint')}</span>
    </div>
  );
}

import { useEffect } from 'react';
import { create } from 'zustand';
import type { SubprojectView } from '../shared/types';
import { pushToast, useStore } from './store';
import { t } from './i18n';

/** Экраны, у которых свой фильтр: доска и документы отвечают на разные вопросы. */
export type ZoneScreen = 'board' | 'docs' | 'log' | 'money';

/** `all` — без фильтра, `none` — «весь проект» (без зоны), иначе id зоны. */
export const ZONE_ALL = 'all';
export const ZONE_NONE = 'none';

const KEY = 'office-zone-filter';
type Saved = Record<string, Partial<Record<ZoneScreen, string>>>;

const load = (): Saved => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved; } catch { return {}; }
};

interface ZoneFilterState {
  /** office → экран → значение. Хранится как размеры окон: только клиент. */
  saved: Saved;
  set: (office: string, screen: ZoneScreen, value: string) => void;
}

export const useZoneFilter = create<ZoneFilterState>((set, get) => ({
  saved: load(),
  set: (office, screen, value) => {
    const saved = { ...get().saved, [office]: { ...get().saved[office], [screen]: value } };
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* нет места — фильтр живёт до перезагрузки */ }
    set({ saved });
  },
}));

/** Зоны текущего офиса; пока их нет (или не пришли) — пусто, и фильтра нет. */
export const useZones = (): SubprojectView[] => useStore((s) => s.subprojects);

/**
 * Значение фильтра экрана. Зону удалили в другом клиенте — значение
 * сбрасывается на «Все» и об этом говорит тост (docs/design/subprojects/ui.md §3.4).
 */
export function useZoneValue(screen: ZoneScreen): [string, (v: string) => void] {
  const office = useStore((s) => s.offices.find((o) => o.current)?.id ?? '');
  const zones = useZones();
  const raw = useZoneFilter((s) => s.saved[office]?.[screen]) ?? ZONE_ALL;
  const write = useZoneFilter((s) => s.set);
  const known = raw === ZONE_ALL || raw === ZONE_NONE || zones.some((z) => z.id === raw);
  // Пока зон нет, экран работает как без них, а выбор не трогаем: снимок мог ещё не прийти.
  const stale = !known && zones.length > 0;
  useEffect(() => {
    if (!stale) return;
    write(office, screen, ZONE_ALL);
    pushToast({ id: `zone-gone-${screen}-${Date.now()}`, kind: 'info', title: t('zone.gone', { name: raw }) });
  }, [stale]); // eslint-disable-line react-hooks/exhaustive-deps
  return [zones.length === 0 || stale ? ZONE_ALL : raw, (v) => write(office, screen, v)];
}

/** Подходит ли зона `id` (null/undefined — без зоны) под значение фильтра. */
export const zoneMatches = (value: string, id: string | null | undefined): boolean =>
  value === ZONE_ALL || (value === ZONE_NONE ? !id : id === value);

/** Название зоны для подписей; удалённую показывает её id. */
export const zoneName = (value: string, zones: SubprojectView[]): string =>
  value === ZONE_NONE ? t('zone.none') : zones.find((z) => z.id === value)?.name ?? value;

/**
 * Ряд чипов над содержимым: «Все», зоны, «Весь проект». Один выбор.
 * Нет зон — ничего не рисует.
 */
export function ZoneFilter({ screen }: { screen: ZoneScreen }) {
  const zones = useZones();
  const [value, setValue] = useZoneValue(screen);
  if (zones.length === 0) return null;
  const chip = (id: string, label: string, color?: string) => (
    <button key={id} type="button" className={`zone-chip${value === id ? ' on' : ''}`}
      aria-pressed={value === id} onClick={() => setValue(id)}>
      <span className="zone-chip-dot" style={color ? { background: `var(--${color})` } : undefined} aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <div className="zone-filter" role="group" aria-label={t('zone.filter')}>
      <button type="button" className={`zone-chip${value === ZONE_ALL ? ' on' : ''}`}
        aria-pressed={value === ZONE_ALL} onClick={() => setValue(ZONE_ALL)}>{t('zone.all')}</button>
      {zones.map((z) => chip(z.id, z.name, z.color))}
      {chip(ZONE_NONE, t('zone.none'))}
    </div>
  );
}

/** Метка зоны на карточке и в строке: цветной квадрат и имя. Нет зон в офисе — нет метки. */
export function ZoneBadge({ id }: { id: string | null | undefined }) {
  const zones = useZones();
  if (zones.length === 0) return null;
  const zone = id ? zones.find((z) => z.id === id) : undefined;
  const label = !id ? t('zone.none') : zone?.name ?? t('zone.deleted');
  return (
    <span className="chip zone-badge" title={label}>
      <span className="zone-chip-dot" style={zone ? { background: `var(--${zone.color})` } : undefined} aria-hidden="true" />
      {label}
    </span>
  );
}

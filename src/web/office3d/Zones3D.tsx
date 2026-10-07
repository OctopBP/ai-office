/**
 * Зоны подпроектов на полу 3D-офиса (docs/design/subprojects/ui.md §5).
 *
 * Только визуализация: участок считается из состояния — списка зон и
 * закреплений ролей (`Role.subprojects`) — и ничего не решает. Столы не
 * двигаются: участок строится рамкой вокруг фактических столов закреплённых
 * сотрудников (§5.2, п. 5), поэтому они всегда сидят внутри своей зоны.
 * Сотрудник с несколькими зонами сидит в первой из них, остальные его
 * участка не тянут. Нет зон или нет столов у закреплённых — не рисуется ничего.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { desks } from '../../shared/layout';
import { useStore } from '../store';
import { catalog } from '../layoutData';
import { t } from '../i18n';
import { ZONE_ALL, useZoneFilter } from '../zoneFilter';

/** Над полом комнаты и под сеткой `FloorGrid` (0.01): без мерцания. */
const FLOOR_Y = 0.008;
/** Поля участка вокруг столов, в тайлах; у южного края — место под табличку. */
const PAD = 0.5;
const PAD_SOUTH = 1;

/** Чужие участки при фильтре зоны гаснут до 35 % (ui.md §5.3). */
const DIM = 0.35;

/** Диагональная штриховка из цвета зоны; кладётся на участок с неисправностью. */
function hatchTexture(color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.strokeStyle = color;
  g.lineWidth = 5;
  for (const k of [-32, 0, 32]) {
    g.beginPath(); g.moveTo(k, 32); g.lineTo(k + 32, 0); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Plot { id: string; name: string; color: string; problem: string | null; x0: number; z0: number; x1: number; z1: number }

/** Штриховка участка с неисправностью: полосы цвета зоны, один тайл текстуры = 1 тайл пола. */
function Hatch({ w, d, x, z, color, opacity }: { w: number; d: number; x: number; z: number; color: string; opacity: number }) {
  const tex = useMemo(() => {
    const m = hatchTexture(color);
    m.repeat.set(w, d);
    return m;
  }, [color, w, d]);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.002, z]}>
      <planeGeometry args={[w, d]} />
      <meshBasicMaterial map={tex} transparent opacity={0.55 * opacity} depthWrite={false} />
    </mesh>
  );
}

export function Zones3D({ offset, size }: { offset: [number, number]; size: [number, number] }) {
  const layout = useStore((s) => s.layout);
  const subprojects = useStore((s) => s.subprojects);
  const roles = useStore((s) => s.roles);
  const instances = useStore((s) => s.instances);
  const theme = useStore((s) => s.theme);
  const office = useStore((s) => s.offices.find((o) => o.current)?.id ?? '');
  const filter = useZoneFilter((s) => s.saved[office]?.board) ?? ZONE_ALL;

  const plots = useMemo<Plot[]>(() => {
    if (subprojects.length === 0) return [];
    const all = desks(layout, catalog);
    const firstZone = new Map<string, string>();
    for (const r of roles) {
      const first = r.subprojects?.find((id) => subprojects.some((z) => z.id === id));
      if (first) firstZone.set(r.id, first);
    }
    const rects = new Map<string, Plot>();
    for (const inst of Object.values(instances)) {
      const zone = firstZone.get(inst.roleId);
      const desk = inst.deskless ? undefined : all[inst.desk.index];
      const sub = subprojects.find((z) => z.id === zone);
      if (!sub || !desk) continue;
      const cur = rects.get(sub.id) ?? {
        id: sub.id, name: sub.name, color: sub.color, problem: sub.problem,
        x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity,
      };
      cur.x0 = Math.min(cur.x0, desk.x);
      cur.z0 = Math.min(cur.z0, desk.y);
      cur.x1 = Math.max(cur.x1, desk.x + desk.w);
      cur.z1 = Math.max(cur.z1, desk.y + desk.h);
      rects.set(sub.id, cur);
    }
    return [...rects.values()].map((p) => ({
      ...p,
      x0: Math.max(0, p.x0 - PAD), z0: Math.max(0, p.z0 - PAD),
      x1: Math.min(size[0], p.x1 + PAD), z1: Math.min(size[1], p.z1 + PAD_SOUTH),
    }));
  }, [layout, subprojects, roles, instances, size]);

  /** Цвет зоны — из той же палитры `--accent-N`, что бейджи и иконки офисов. */
  const css = useMemo(() => getComputedStyle(document.documentElement), [theme]);
  if (plots.length === 0) return null;
  const opacity = theme === 'night' ? 0.3 : 0.22;
  // Фильтр на зону, которой уже нет, экран доски сам сбросит: тут не гасим.
  const active = subprojects.some((z) => z.id === filter) || filter === 'none';
  const dimmed = (id: string) => active && id !== filter;

  return (
    <>
    <Html fullscreen zIndexRange={[60, 0]} style={{ pointerEvents: 'none', userSelect: 'none' }}>
      <ul className="zone3d-legend" aria-label={t('zone3d.legend')}>
        {subprojects.map((z) => (
          <li key={z.id} className={z.members.length === 0 ? 'empty' : undefined} title={z.name}>
            <span className="zone3d-swatch" aria-hidden="true"
              style={z.members.length === 0 ? undefined : { background: `var(--${z.color})` }} />
            <span className="zone3d-legend-name">{z.name}</span>
            <span className="zone3d-legend-n">{z.members.length}</span>
          </li>
        ))}
      </ul>
    </Html>
    <group position={[offset[0], FLOOR_Y, offset[1]]}>
      {plots.map((p) => {
        const color = css.getPropertyValue(`--${p.color}`).trim() || '#808080';
        const w = p.x1 - p.x0;
        const d = p.z1 - p.z0;
        const dim = dimmed(p.id);
        return (
          <group key={p.id}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[p.x0 + w / 2, 0, p.z0 + d / 2]}>
              <planeGeometry args={[w, d]} />
              <meshBasicMaterial color={color} transparent opacity={dim ? opacity * DIM : opacity} depthWrite={false} />
            </mesh>
            {p.problem && <Hatch w={w} d={d} x={p.x0 + w / 2} z={p.z0 + d / 2} color={color} opacity={dim ? DIM : 1} />}
            <Html
              center
              position={[p.x0 + w / 2, 0.02, p.z1 - 0.5]}
              distanceFactor={15}
              zIndexRange={[60, 0]}
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              <div
                className="zone3d-label"
                title={p.problem ? `${p.name} — ${p.problem}` : p.name}
                style={{ opacity: dim ? DIM : 1, background: `var(--${p.color})`, color: `var(--${p.color}-ink)` }}
              >
                {p.name}{p.problem ? ' ⚠' : ''}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
    </>
  );
}

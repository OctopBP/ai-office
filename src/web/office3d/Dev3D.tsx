/**
 * Режим разработчика трёхмерного офиса: карта проходимости и маршруты.
 *
 * Отвечает на вопрос, на который обычная картинка не отвечает: «почему агент
 * пошёл в обход и где он не смог дойти». Ходьба считается по тайловой сетке
 * (`passability`, `findPath` в `src/shared/layout.ts`), а на глаз в комнате
 * ни сетки, ни занятых клеток не видно: диван, лёгший на ряд больше, чем
 * записано, просто выглядит диваном — пока агент не начнёт огибать пустое
 * место рядом с ним.
 *
 * Три слоя, все на полу:
 *
 *  - занятые клетки карты проходимости — красная заливка тайла. Это то, что
 *    видит `findPath`: стены и след мебели с `blocks` из каталога, и ничего
 *    больше;
 *  - маршруты — ломаная из стора (`pos[id].path`) ровно в тех точках, по
 *    которым рендер ведёт фигуру, с меткой у цели. Пройденный маршрут
 *    остаётся бледным: видно, откуда агент пришёл;
 *  - номера тайлов вдоль двух краёв, через пять, — чтобы клетку с картинки
 *    можно было найти в раскладке, не считая линии.
 *
 * Сама сетка линий рисуется в `Office3D.tsx` (`FloorGrid`) — она есть и без
 * режима разработчика, как линейка при расстановке мебели; режим лишь
 * включает её принудительно.
 *
 * Компонент монтируется внутри группы, сдвинутой на `offset`, поэтому
 * считает в координатах раскладки: тайл `[x, y]` — квадрат `[x, x+1) ×
 * [y, y+1)` на плоскости XZ.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { Html, Line } from '@react-three/drei';
import type { Layout } from '../../shared/layout';
import { isBlocked } from '../../shared/layout';
import { passabilityFor } from '../layoutData';
import { useStore } from '../store';
import type { Palette } from './palette';
import { FOOT_DX, FOOT_DY } from './Agents3D';

/**
 * Высоты слоёв над нулём пола. Ноль — отметка, на которой стоит мебель, и
 * класть на неё нельзя: з-файтинг с плитой пола. Сетка лежит на 0.01
 * (`FloorGrid`), заливка клеток — под ней, чтобы линии делили красное поле
 * на клетки; маршруты — над всем, они тоньше и должны читаться поверх.
 */
const BLOCKED_Y = 0.006;
const ROUTE_Y = 0.02;

/** Через сколько тайлов подписывать номер — в такт толстым линиям сетки. */
const LABEL_STEP = 5;

/** Толщина линии маршрута, экранных пикселей. */
const ROUTE_WIDTH = 2.5;

/** Насколько бледнеет уже пройденный маршрут. */
const DONE_OPACITY = 0.22;

/** Радиус метки цели, тайлов. */
const TARGET_R = 0.18;

/**
 * Заливка занятых клеток — одна геометрия на всю карту, а не меш на клетку:
 * стен и мебели в раскладке набирается на несколько сотен тайлов, и
 * столько же отдельных мешей — это столько же вызовов отрисовки в кадре.
 * Два треугольника на клетку, без индексов: клеток немного, а проще.
 */
function BlockedCells({ layout, palette }: { layout: Layout; palette: Palette }) {
  const geometry = useMemo(() => {
    const grid = passabilityFor(layout);
    const verts: number[] = [];
    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.cols; x++) {
        if (!isBlocked(grid, x, y)) continue;
        // Клетка заливается целиком, до линий сетки: границу между соседними
        // занятыми клетками проводит сама сетка, она лежит поверх заливки.
        const x0 = x, x1 = x + 1, z0 = y, z1 = y + 1;
        verts.push(
          x0, 0, z0, x0, 0, z1, x1, 0, z1,
          x0, 0, z0, x1, 0, z1, x1, 0, z0,
        );
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    return g;
  }, [layout]);

  return (
    <mesh geometry={geometry} position={[0, BLOCKED_Y, 0]}>
      <meshBasicMaterial
        color={palette.dev.blocked} transparent opacity={0.5} depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/**
 * Маршруты всех агентов из стора. Точки сдвинуты на те же `FOOT_*`, что и
 * фигура в `Agents3D.tsx`: линия должна проходить под ногами, а не по углу
 * тайла, — иначе кажется, что агент идёт не по своему пути.
 */
function Routes({ palette }: { palette: Palette }) {
  const pos = useStore((s) => s.pos);

  return (
    <>
      {Object.entries(pos).map(([id, walk]) => {
        if (walk.path.length < 2) return null;
        const points = walk.path.map(
          (pt) => new THREE.Vector3(pt.x + FOOT_DX, ROUTE_Y, pt.y + FOOT_DY),
        );
        const end = points[points.length - 1];
        return (
          <group key={`${id}-${walk.seq}`}>
            <Line
              points={points}
              color={palette.dev.route}
              lineWidth={ROUTE_WIDTH}
              transparent
              opacity={walk.arrived ? DONE_OPACITY : 1}
              depthWrite={false}
            />
            {!walk.arrived && (
              <mesh position={end} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[TARGET_R * 0.55, TARGET_R, 24]} />
                <meshBasicMaterial color={palette.dev.target} depthWrite={false} />
              </mesh>
            )}
          </group>
        );
      })}
    </>
  );
}

/**
 * Номера тайлов вдоль верхнего и левого краёв раскладки. Обычный DOM поверх
 * канваса, как подписи агентов: текст, который пикселизация не трогает.
 * Размер экранный, а не сценический — цифры нужны, чтобы прочитать, и с
 * любого расстояния должны оставаться цифрами.
 */
function TileLabels({ layout }: { layout: Layout }) {
  const [cols, rows] = layout.size;
  const labels = useMemo(() => {
    const list: { key: string; text: string; at: [number, number, number] }[] = [];
    for (let x = 0; x <= cols; x += LABEL_STEP) {
      list.push({ key: `x${x}`, text: String(x), at: [x, 0, -0.6] });
    }
    for (let y = 0; y <= rows; y += LABEL_STEP) {
      list.push({ key: `y${y}`, text: String(y), at: [-0.6, 0, y] });
    }
    return list;
  }, [cols, rows]);

  return (
    <>
      {labels.map((l) => (
        <Html
          key={l.key} center position={l.at} zIndexRange={[90, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="dev3d-label">{l.text}</div>
        </Html>
      ))}
    </>
  );
}

/** Все слои режима разработчика. Монтируется в группе, сдвинутой на `offset`. */
export function DevOverlay({ layout, palette }: { layout: Layout; palette: Palette }) {
  return (
    <>
      <BlockedCells layout={layout} palette={palette} />
      <Routes palette={palette} />
      <TileLabels layout={layout} />
    </>
  );
}

/** Бейдж в углу сцены: объясняет, откуда на полу красные клетки. */
export function DevBadge() {
  return <div className="dev3d-badge">dev · G</div>;
}

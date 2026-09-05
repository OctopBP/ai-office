/**
 * Освещение трёхмерного офиса — всё, что светит, в одном месте.
 *
 * До сих пор свет в сцене был один на всю раскладку: солнце с заполняющим
 * источником плюс полусферический. Это правильный свет для макета — он ровно
 * показывает объём, — но офисом от него не пахнет: макет под солнцем
 * одинаково освещён в переговорке, в лаунже и на кухне, и ни одно место в нём
 * не выглядит обжитым.
 *
 * Уют начинается там, где у света есть источник. Здесь их три сорта:
 *
 *  - **потолочные светильники** — по одному-двум на комнату, ровно они и
 *    делают комнату комнатой, а не сектором плана; сами по себе они
 *    невидимы: потолка в сцене нет, и вешать плафон не на что;
 *  - **лампы предметов** — торшер в лаунже, вывеска, экран автомата: пятна
 *    своего цвета там, где стоит предмет (компонент `lamp` пресета);
 *  - **мониторы** — зажигаются, только пока за столом кто-то работает.
 *
 * Тени по-прежнему бросает одно солнце. Точечный источник с тенями — это
 * шесть проходов рендера на кубическую карту, и десяток ламп в комнате
 * стоил бы дороже всей остальной сцены; без теней же лампа обходится в
 * несколько строк шейдера на пиксель.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useStore } from '../store';
import type { Palette } from './palette';
import { WALL_H, type Scene3 } from './geometry';
import { componentsOf } from '../../shared/preset';
import type { Placed3 } from './props';

/**
 * Через сколько тайлов ставится следующий потолочный светильник. Число
 * взято от комнаты, а не от лампы: при шаге в десять тайлов (семь с
 * половиной метров) переговорка получает один светильник, открытое
 * пространство — четыре, и это ровно та плотность, при которой видно, что
 * свет исходит из точек, а не залит равномерно.
 */
const CEILING_STEP = 10;

/** Высота, на которой горит потолочный источник, тайлы. */
const CEILING_Y = WALL_H - 0.25;

/**
 * Свет, общий для всей сцены: заполняющий (небо сверху, отражение от пола
 * снизу) плюс направленный — он же единственный источник теней. Рамка
 * теневой камеры сжата по комнате: растянутая на всю сцену дала бы мыло
 * вместо теней.
 */
export function Lights({ scene, palette }: { scene: Scene3; palette: Palette }) {
  const [w, d] = scene.size;
  const [ox, oy, oz] = palette.light.keyOffset;
  /**
   * Рамка теневой камеры. Комната в неё попадает целиком по диагонали — при
   * низком солнце она ложится в карту глубины наискось, и запаса по стороне
   * `max(w, d)` не хватает: углы обрезаются, и тень там просто пропадает.
   */
  const reach = Math.hypot(w, d) * 0.75;
  /** Дальняя плоскость: расстояние до источника плюс размер комнаты. */
  const far = Math.hypot(ox, oy, oz) + Math.max(w, d) * 1.5;

  /**
   * Рамку теневой камеры мало задать — её надо пересчитать. Границы
   * `shadow-camera-*` попадают в объект напрямую, а матрицу проекции three
   * сам не обновляет: без этого вызова свет продолжает светить в рамку по
   * умолчанию (±5), и тени есть только у центра комнаты.
   */
  const key = useRef<THREE.DirectionalLight>(null);
  useLayoutEffect(() => {
    key.current?.shadow.camera.updateProjectionMatrix();
  }, [reach, far]);

  return (
    <>
      <hemisphereLight
        args={[palette.light.skyColor, palette.light.groundColor, palette.light.ambient]}
      />
      {/* Цель направленного света по умолчанию — начало координат, а комната
          сдвинута ровно так, чтобы её центр там и оказался. */}
      <directionalLight
        ref={key}
        position={[ox, oy, oz]}
        color={palette.light.keyColor}
        intensity={palette.light.keyIntensity}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0015}
        shadow-normalBias={0.02}
        shadow-camera-left={-reach}
        shadow-camera-right={reach}
        shadow-camera-top={reach}
        shadow-camera-bottom={-reach}
        shadow-camera-near={1}
        shadow-camera-far={far}
      />
      <directionalLight
        position={palette.light.fillOffset}
        color={palette.light.fillColor}
        intensity={palette.light.fillIntensity}
      />
    </>
  );
}

/**
 * Один потолочный светильник — только свет, без самого светильника.
 *
 * Плафон был и оказался лишним. Потолка в сцене нет вовсе — комната смотрится
 * сверху и в разрезе, — и висящая под несуществующим потолком люстра ни на
 * чём не держится: с высокого ракурса это просто светлое пятно поверх
 * комнаты, которое загораживает то, ради чего сверху и смотрят. Свет от неё
 * при этом не зависел никак: пятно на полу рисует источник, а не плафон.
 */
function CeilingLamp({ at, palette }: { at: [number, number]; palette: Palette }) {
  const lamp = palette.lamp.ceiling;
  return (
    <pointLight
      position={[at[0], CEILING_Y, at[1]]}
      color={lamp.color}
      intensity={lamp.intensity}
      distance={lamp.distance}
      decay={lamp.decay}
    />
  );
}

/**
 * Светильники под потолком — по комнатам раскладки.
 *
 * Раскладка может комнат и не объявлять (`classic` их не знает вовсе, там
 * один общий этаж), поэтому запасной вариант — сетка по всей раскладке: без
 * неё старые пресеты остались бы вовсе без потолочного света, то есть
 * заметно темнее новых.
 */
export function CeilingLamps({ scene, palette, offset }: {
  scene: Scene3;
  palette: Palette;
  /** сдвиг комнаты в мир — тот же, что у пола, стен и обстановки */
  offset: [number, number];
}) {
  const spots = useMemo(() => {
    const rooms = scene.floors.length > 0
      ? scene.floors.map((f) => ({ cx: f.cx, cy: f.cy, w: f.w, d: f.d }))
      : [{ cx: scene.size[0] / 2, cy: scene.size[1] / 2, w: scene.size[0], d: scene.size[1] }];

    const made: [number, number][] = [];
    for (const room of rooms) {
      // Ламп по стороне — сколько раз в неё укладывается шаг, но не меньше
      // одной: даже у чулана должен быть свой свет.
      const nx = Math.max(1, Math.round(room.w / CEILING_STEP));
      const nz = Math.max(1, Math.round(room.d / CEILING_STEP));
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          made.push([
            room.cx - room.w / 2 + ((i + 0.5) * room.w) / nx,
            room.cy - room.d / 2 + ((j + 0.5) * room.d) / nz,
          ]);
        }
      }
    }
    return made;
  }, [scene]);

  return (
    <group position={[offset[0], 0, offset[1]]}>
      {spots.map((at, i) => <CeilingLamp key={i} at={at} palette={palette} />)}
    </group>
  );
}

/**
 * Лампа предмета — рисуется внутри его группы, поэтому едет вместе с ним и
 * поворачивается с ним же: у предмета «вперёд» это +Z его собственной
 * системы координат, и настенная панель повёрнута лицом в комнату (`place3`).
 *
 * Светящаяся лицевая сторона (`face`) — плоскость поверх предмета, а не
 * подмена его материала: у экрана светится стекло, а корпус вокруг остаётся
 * обычным тёмным пластиком, и разделить их можно только отдельной плашкой.
 */
export function PropLamp({ item, palette, lit }: {
  item: Placed3;
  palette: Palette;
  /** Работают ли за предметом — от этого зависят лампы с пометкой `busy`. */
  lit: boolean;
}) {
  // Ламп у предмета может быть несколько: у автомата светится неоновая панель
  // и подсвечен корпус. Прежнее одиночное поле `lamp` этого не позволяло, и
  // вторую лампу негде было объявить.
  const lamps = componentsOf(item.def, 'lamp').filter((l) => !l.busy || lit);
  if (lamps.length === 0) return null;

  return (
    <>
      {lamps.map((lamp, i) => {
        const cfg = palette.lamp[lamp.lamp];
        const [x, y, z] = lamp.at ?? [0, item.h / 2, item.d / 2 + 0.2];
        // `gain` — поправка к палитре, а не замена ей: цвет и радиус остаются
        // за темой, которая различает день и ночь.
        const intensity = cfg.intensity * (lamp.gain ?? 1);
        return (
          <group key={i}>
            {lamp.face && (
              <mesh position={[0, item.h / 2, item.d / 2 + 0.015]}>
                <planeGeometry args={[item.w * 0.86, item.h * 0.82]} />
                <meshBasicMaterial color={cfg.glow ?? cfg.color} />
              </mesh>
            )}
            <pointLight
              position={[x, y, z]}
              color={cfg.color}
              intensity={intensity}
              distance={cfg.distance}
              decay={cfg.decay}
            />
          </group>
        );
      })}
    </>
  );
}

/**
 * Столы, за которыми прямо сейчас работают.
 *
 * Отвечает на вопрос «горит ли монитор» — а он горит тогда же, когда человек
 * за столом печатает: те же два состояния, что включают позу `type` в
 * `Agents3D`, и та же проверка, что агент действительно дома, а не идёт
 * куда-то по своим делам (пока он в пути, стор держит в `pos` не координату
 * стола).
 *
 * Ключ — якорь стола в раскладке, а не индекс рабочего места: у предмета в
 * сцене есть `ax/ay`, и это ровно `prop.at`, из которого сервер собрал
 * `inst.desk`. Считать порядок столов заново значило бы завести второй ответ
 * на вопрос, на который уже отвечает `desks()`.
 */
export function useLitDesks(): Set<string> {
  const instances = useStore((s) => s.instances);
  const pos = useStore((s) => s.pos);
  return useMemo(() => {
    const lit = new Set<string>();
    for (const inst of Object.values(instances)) {
      if (inst.deskless) continue;
      if (inst.state !== 'working' && inst.state !== 'thinking') continue;
      // Не «стоит ли он на клетке стола», а «его цель — его стол, и он до
      // неё дошёл». Сравнивать координаты больше нельзя и не нужно: стор
      // держит в `pos` точку слота `work`, а не якорь предмета.
      const at = pos[inst.id];
      if (at && !(at.atDesk && at.arrived)) continue;
      lit.add(deskKey(inst.desk.x, inst.desk.y));
    }
    return lit;
  }, [instances, pos]);
}

/** Ключ стола для `useLitDesks` — тот же и у предмета сцены, и у агента. */
export function deskKey(x: number, y: number): string {
  return `${x},${y}`;
}

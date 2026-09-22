/**
 * Что нарисовано на трёх настенных досках комнаты.
 *
 * Доски висят на стене со времён первой сцены и до сих пор были тремя
 * одинаковыми светящимися прямоугольниками: издалека не отличить, где лента
 * событий, а где расходы. Здесь они получают лицо — схематичную картинку
 * своих данных.
 *
 * Два правила, от которых тут всё остальное:
 *
 * 1. **Никакого настоящего текста.** В масштабе комнаты буквы не читаются, а
 *    мусорят обязательно. Рисуем абстракцию: полоски, карточки, столбики.
 * 2. **Абстракция живая.** Каждая полоска и каждый столбик посчитаны из
 *    настоящих чисел стора, поэтому доска меняется вместе с офисом. Своего
 *    состояния тут нет и логики нет: только чтение уже существующих полей —
 *    выключи сцену, и офис не заметит.
 *
 * Перерисовка идёт по изменению данных, а не по кадрам: ни одного
 * `useFrame`, всё считается в `useMemo` и живёт до следующей правки стора.
 * Поэтому каждая доска — свой компонент со своей подпиской: лента событий
 * капает часто, а расходы за день — редко, и держать их на одной подписке
 * значило бы перерисовывать канбан на каждую строчку лога.
 *
 * Размеры самих панелей (ширина, высота, отметка на стене) здесь не задаются:
 * они в `design/presets/<board|moneyboard|logscreen>/preset.json` — поля
 * `footprint` (ширина в тайлах), `h` и `wall_mounted.at`. Тут только то, как
 * разложено содержимое внутри лицевой стороны.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { LogEntry, TaskPriority, TaskStatus, TaskView } from '../../shared/types';
import type { HotspotPanel } from '../layoutData';
import { NO_ROLE_COLOR } from '../Avatar';
import { useStore } from '../store';
import type { Palette } from './palette';
import type { Placed3 } from './props';

/**
 * Толщина рамки доски — в мировых единицах сцены (1 = тайл пола). Одна на все
 * три доски: правится здесь одним числом.
 *
 * Рамкой раньше служила кромка панели вокруг лицевой стороны, а лицевая
 * сторона задавалась долей габарита (0.86 × 0.82 от панели). Доля от размера —
 * это разная рамка у разных досок: у ленты событий шириной в тайл выходило
 * 0.07, у доски задач шириной в три — 0.21, а по вертикали ещё третье число.
 * Теперь рамка рисуется здесь же и всегда одинаковой ширины, а лицо доски —
 * это габарит минус две толщины.
 */
const FRAME = 0.1;

/** Насколько лицевая сторона выступает вперёд из панели. Лицо предмета — его
 *  +Z (`place3` разворачивает настенное в комнату), плашка подсветки в
 *  `PropLamp` стоит на 0.015, поэтому картинка впереди неё. */
const FRONT = 0.03;

/**
 * Порядок отрисовки слоёв доски: рамка, подложка, поле, содержимое, отметки
 * поверх содержимого, подсветка наведения.
 *
 * Все слои лежат в ОДНОЙ плоскости и ни один не пишет глубину — кто кого
 * закрывает, решает только этот порядок. Так сделано из-за мерцания:
 * прозрачные меши three сортирует по глубине центра меша, а центр полоски
 * лежит не там, где центр подложки. При косом взгляде на стену полоска слева
 * оказывается ДАЛЬШЕ от камеры, чем центр доски, и уезжает в сортировке за
 * подложку — та рисуется поверх и стирает её. Развернули камеру — порядок
 * другой, и содержимое моргает. Явный `renderOrder` сравнивается раньше
 * глубины, поэтому от ракурса он не зависит вовсе.
 *
 * Числа начинаются с единицы, а не с нуля: нулевой порядок у всего остального
 * прозрачного в сцене, и доска должна ложиться поверх, а не вперемешку.
 */
const ORDER = {
  /** Рамка: единственный слой во весь габарит панели. */
  frame: 1,
  /** Подложка лицевой стороны. */
  back: 2,
  /** Разметка под содержимым: поле колонки, ось диаграммы. */
  plot: 3,
  /** Само содержимое: полоски ленты, карточки, столбики. */
  item: 4,
  /** Отметки поверх содержимого: акцент карточки, линия лимита. */
  mark: 5,
  /** Засветка под курсором. */
  hover: 6,
} as const;

/**
 * Цвета взяты из `styles/tokens.css` — новых тут не заводится. Скопированы
 * числами по той же причине, что и вся палитра сцены (`palette.ts`): three
 * не читает CSS-переменные, а тянуть их через `getComputedStyle` на каждый
 * кадр дороже, чем держать список.
 */
const INK = {
  /** --accent-1, синий */ blue: '#2f7bf6',
  /** --accent-3, фиолетовый */ violet: '#a855f7',
  /** --accent-6, янтарный */ amber: '#f0b429',
  /** --accent-8, бирюзовый */ teal: '#0d9488',
  /** --danger */ danger: '#dc4b3f',
} as const;

/**
 * Простая плашка: прямоугольник заданного цвета в плоскости доски.
 *
 * Материал помечен прозрачным, даже когда непрозрачен, и не пишет глубину:
 * глубину за всю доску держит её панель, а внутри лицевой стороны порядок
 * задаёт `order` и только он. Поэтому слой — обязательный параметр, а не
 * умолчание: плашка без него встала бы в общую кучу.
 */
function Bar({ x, y, w, h, color, opacity, order }: {
  x: number; y: number; w: number; h: number; color: string; opacity?: number;
  /** Слой из `ORDER`. */
  order: number;
}) {
  if (!(w > 0) || !(h > 0)) return null;
  return (
    <mesh position={[x, y, 0]} renderOrder={order}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial color={color} transparent opacity={opacity ?? 1} depthWrite={false} />
    </mesh>
  );
}

/**
 * Прямоугольник со скруглёнными углами — геометрия карточки канбана.
 * Строится один раз на размер и раздаётся всем карточкам доски: их до трёх
 * десятков, и своя геометрия у каждой была бы тридцатью буферами на ровном
 * месте.
 */
function useRoundedRect(w: number, h: number, r: number): THREE.ShapeGeometry {
  const geo = useMemo(() => {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    const shape = new THREE.Shape();
    const x = -w / 2;
    const y = -h / 2;
    shape.moveTo(x + radius, y);
    shape.lineTo(x + w - radius, y);
    shape.quadraticCurveTo(x + w, y, x + w, y + radius);
    shape.lineTo(x + w, y + h - radius);
    shape.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    shape.lineTo(x + radius, y + h);
    shape.quadraticCurveTo(x, y + h, x, y + h - radius);
    shape.lineTo(x, y + radius);
    shape.quadraticCurveTo(x, y, x + radius, y);
    return new THREE.ShapeGeometry(shape, 3);
  }, [w, h, r]);
  // Геометрию, созданную руками, three сам не освобождает: у неё нет владельца
  // в дереве, она приходит в меш пропом.
  useEffect(() => () => geo.dispose(), [geo]);
  return geo;
}

// ——— 1. Лента событий ———————————————————————————————————————————————

/** Сколько строк помещается на ленте. Больше строк — мельче полоски; меняете
 *  высоту `logscreen` в пресете — имеет смысл поправить и это число. */
const FEED_ROWS = 18;

/** Цвет полоски по роду события — тот же смысл, что у цвета строки в панели
 *  лога (`styles/chat-log.css`). */
const FEED_COLOR: Record<LogEntry['kind'], string> = {
  text: INK.blue,
  tool: INK.violet,
  system: INK.amber,
  error: INK.danger,
};

/**
 * Лента событий: узкий вертикальный экран, на нём строки сверху вниз.
 * Свежее событие приходит наверх, остальные съезжают ниже и гаснут — так же,
 * как лента в панели, только вместо слов длина полоски.
 */
function FeedArt({ w, h }: { w: number; h: number }) {
  const log = useStore((s) => s.log);

  const rows = useMemo(() => {
    // Свежие сверху: в сторе лента дописывается в конец.
    const last = log.slice(-FEED_ROWS).reverse();
    return last.map((e) => ({
      id: e.id,
      color: FEED_COLOR[e.kind] ?? FEED_COLOR.system,
      // Длина полоски — от длины самой строки события. Это настоящее число, а
      // не случайное: одна и та же лента между перерисовками выглядит
      // одинаково, и глаз видит именно движение, а не мерцание.
      len: 0.3 + (Math.min(e.text.length, 160) / 160) * 0.7,
    }));
  }, [log]);

  const padX = w * 0.12;
  const padY = h * 0.035;
  const usableW = w - padX * 2;
  const rowH = (h - padY * 2) / FEED_ROWS;
  const barH = rowH * 0.42;
  const top = h / 2 - padY;
  const left = -w / 2 + padX;

  return (
    <>
      {/* Тёмная подложка: лента — единственная из трёх досок, которая читается
          как экран, а не как бумага, и полоски на тёмном видно издалека. */}
      <Bar x={0} y={0} w={w} h={h} color="#12161f" order={ORDER.back} />
      {rows.map((row, i) => (
        <Bar
          key={row.id}
          x={left + (usableW * row.len) / 2}
          y={top - rowH * (i + 0.5)}
          w={usableW * row.len}
          h={barH}
          color={row.color}
          // Чем ниже строка, тем она старше и тусклее.
          opacity={1 - (i / FEED_ROWS) * 0.7}
          order={ORDER.item}
        />
      ))}
    </>
  );
}

// ——— 2. Доска задач ————————————————————————————————————————————————

/** Важность → вес для сортировки: наверху колонки то, что важнее. */
const PRIORITY_WEIGHT: Record<TaskPriority, number> = { high: 2, normal: 1, low: 0 };

/**
 * Колонки канбана. Группировка та же, по которой человек читает доску:
 * очередь, работа, ревью, готово. Провалившиеся и снятые задачи на стену не
 * попадают — это не «состояние офиса сейчас», а его история.
 */
const COLUMNS: TaskStatus[][] = [
  ['planned', 'backlog'],
  ['assigned', 'in_progress', 'blocked'],
  ['review'],
  ['done'],
];

/** Сколько карточек влезает в колонку. Остальные сворачиваются в одну тусклую
 *  полоску внизу — «тут ещё есть». */
const MAX_CARDS = 6;

/**
 * Доска задач: четыре колонки, в них карточки по числу задач в статусе.
 * Текста нет, но у карточки есть полоска цветом роли — по ней видно, что в
 * работе у бэкенда, а что у дизайнера.
 */
function TasksArt({ w, h }: { w: number; h: number }) {
  const tasks = useStore((s) => s.tasks);
  const roles = useStore((s) => s.roles);

  const columns = useMemo(() => {
    const colorOf = new Map(roles.map((r) => [r.id, r.color]));
    const all = Object.values(tasks) as TaskView[];
    return COLUMNS.map((statuses) => {
      const inColumn = all.filter((t) => statuses.includes(t.status));
      inColumn.sort((a, b) => (PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority])
        // При равной важности сверху свежая задача.
        || (b.createdAt - a.createdAt));
      return {
        cards: inColumn.slice(0, MAX_CARDS).map((t) => ({
          id: t.id,
          accent: (t.roleId ? colorOf.get(t.roleId) : undefined) ?? NO_ROLE_COLOR,
        })),
        more: Math.max(0, inColumn.length - MAX_CARDS),
      };
    });
  }, [tasks, roles]);

  const padX = w * 0.03;
  const padY = h * 0.06;
  const colW = (w - padX * 2) / COLUMNS.length;
  const plotH = h - padY * 2;
  const rowH = plotH / (MAX_CARDS + 0.4);
  const cardW = colW * 0.62;
  const cardH = rowH * 0.74;
  const cardGeo = useRoundedRect(cardW, cardH, cardH * 0.28);
  const top = h / 2 - padY;

  return (
    <>
      {/* Светлая подложка: доска задач — это белая маркерная доска. */}
      <Bar x={0} y={0} w={w} h={h} color="#f2f5fa" order={ORDER.back} />
      {columns.map((col, c) => {
        const cx = -w / 2 + padX + colW * (c + 0.5);
        return (
          <group key={c}>
            {/* Колонка — чуть притопленное поле, чтобы канбан читался как
                канбан даже у пустой доски. */}
            <Bar x={cx} y={0} w={colW * 0.78} h={plotH} color="#d9e1ef" order={ORDER.plot} />
            {col.cards.map((card, i) => {
              const cy = top - rowH * (i + 0.6);
              return (
                <group key={card.id} position={[cx, cy, 0]}>
                  <mesh geometry={cardGeo} renderOrder={ORDER.item}>
                    <meshBasicMaterial color="#ffffff" transparent depthWrite={false} />
                  </mesh>
                  {/* Акцент слева — цвет роли, за которой задача. */}
                  <Bar
                    x={-cardW / 2 + cardW * 0.07}
                    y={0}
                    w={cardW * 0.09}
                    h={cardH * 0.62}
                    color={card.accent}
                    order={ORDER.mark}
                  />
                </group>
              );
            })}
            {col.more > 0 && (
              <Bar
                x={cx}
                y={top - rowH * (col.cards.length + 0.45)}
                w={cardW * 0.5}
                h={cardH * 0.3}
                color="#94a3b8"
                order={ORDER.item}
              />
            )}
          </group>
        );
      })}
    </>
  );
}

// ——— 3. Доска расходов ——————————————————————————————————————————————

/** Сколько дней показывает диаграмма — столько же, сколько недельная шкала в
 *  `MoneyBoard.tsx`: числа берутся оттуда же, расходиться им незачем. */
const MONEY_DAYS = 7;

/**
 * Доска расходов: столбики по дням и горизонтальная линия лимита.
 *
 * Числа те же, что в панели расходов: `usageDays` — сколько стоил каждый
 * день, `settings.globalBudgetUsd` — денежный потолок офиса. Потолок задан на
 * весь офис, а столбик — дневной, поэтому линия стоит на дневной доле
 * потолка: «столько можно тратить в день, чтобы за неделю уложиться». Потолка
 * нет — линия встаёт на уровень самого дорогого дня и работает просто
 * верхней отсечкой.
 */
function MoneyArt({ w, h }: { w: number; h: number }) {
  const days = useStore((s) => s.usageDays);
  const cap = useStore((s) => s.settings.globalBudgetUsd);

  const chart = useMemo(() => {
    const week = days.slice(-MONEY_DAYS);
    const peak = Math.max(0, ...week.map((d) => d.usage.costUsd));
    const limit = cap !== null && cap > 0 ? cap / MONEY_DAYS : peak;
    // Запас сверху, чтобы самый высокий столбик не упирался в край доски.
    const scale = Math.max(peak, limit, 1e-4) * 1.15;
    return {
      bars: week.map((d) => ({
        day: d.day,
        v: d.usage.costUsd / scale,
        over: limit > 0 && d.usage.costUsd > limit,
      })),
      limit: limit / scale,
    };
  }, [days, cap]);

  const padX = w * 0.07;
  const padY = h * 0.1;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;
  const base = -h / 2 + padY;
  const slot = plotW / MONEY_DAYS;
  const barW = slot * 0.56;

  return (
    <>
      {/* Подложка светлее подсветки, но не белая: диаграмма — не бумага. */}
      <Bar x={0} y={0} w={w} h={h} color="#e7eef8" order={ORDER.back} />
      {/* Ось: по ней стоят столбики. */}
      <Bar x={0} y={base} w={plotW} h={h * 0.018} color="#8fa3bd" order={ORDER.plot} />
      {chart.bars.map((bar, i) => (
        <Bar
          key={bar.day}
          x={-w / 2 + padX + slot * (i + 0.5)}
          y={base + (plotH * bar.v) / 2}
          w={barW}
          h={Math.max(plotH * bar.v, 0)}
          color={bar.over ? INK.danger : INK.teal}
          order={ORDER.item}
        />
      ))}
      {/* Линия лимита поверх столбиков: важно видеть, какой из них её пробил. */}
      <Bar
        x={0}
        y={base + plotH * chart.limit}
        w={plotW}
        h={h * 0.022}
        color={INK.danger}
        opacity={0.85}
        order={ORDER.mark}
      />
    </>
  );
}

// ——— Сборка ————————————————————————————————————————————————————————

/**
 * Картинка на лицевой стороне доски плюс рамка и подсветка наведения.
 *
 * Рисуется внутри группы предмета (`Hotspots3D`), поэтому едет и
 * поворачивается вместе с ним и ничего не знает о том, где доска висит.
 */
export function BoardArt({ kind, item, palette, hovered }: {
  kind: HotspotPanel;
  item: Placed3;
  /** Палитра сцены: рамка берёт из неё тон панели и вместе с ней темнеет к ночи. */
  palette: Palette;
  /** Курсор над доской: к картинке добавляется лёгкая засветка. */
  hovered: boolean;
}) {
  const w = item.w - FRAME * 2;
  const h = item.h - FRAME * 2;

  return (
    <>
      {/* Полочка для маркеров под доской задач. Чистая форма, данных в ней
          нет, — но именно она не даёт доске задач и доске расходов остаться
          двумя одинаковыми светлыми прямоугольниками. */}
      {kind === 'board' && (
        <mesh position={[0, item.h * 0.07, item.d * 0.9]}>
          <boxGeometry args={[item.w * 0.42, item.h * 0.035, item.d * 1.5]} />
          <meshBasicMaterial color="#8c93a3" />
        </mesh>
      )}
      <group position={[0, item.h / 2, item.d / 2 + FRONT]}>
        {/* Рамка — во весь габарит панели, содержимое ложится поверх и
            оставляет от неё ровно `FRAME` с каждой стороны. Тон тот же, что у
            самой панели (`PropShape`, тон `screen`), и материал тоже
            освещаемый: у плоскости и у передней грани коробки нормаль одна, так
            что светом они закрашиваются одинаково и стыка не видно. Заодно
            рамка закрывает светящуюся плашку `PropLamp`, которая задана долей
            габарита и иначе выглядывала бы из-под содержимого у узких досок. */}
        <mesh renderOrder={ORDER.frame}>
          <planeGeometry args={[item.w, item.h]} />
          <meshLambertMaterial color={palette.prop.screen} transparent depthWrite={false} />
        </mesh>
        {kind === 'log' && <FeedArt w={w} h={h} />}
        {kind === 'board' && <TasksArt w={w} h={h} />}
        {kind === 'money' && <MoneyArt w={w} h={h} />}
        {hovered && (
          <mesh renderOrder={ORDER.hover}>
            <planeGeometry args={[w * 1.04, h * 1.04]} />
            <meshBasicMaterial
              color="#ffffff"
              transparent
              opacity={0.16}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
            />
          </mesh>
        )}
      </group>
    </>
  );
}

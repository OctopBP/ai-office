import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AUTHOR, END, STUCK, type Run, type Workflow, type WorkflowNode } from '../shared/workflow';
import { Icon, type IconName } from './icons';
import { t } from './i18n';
import { Tooltip } from './Tooltip';

/**
 * Граф процесса (docs/design/workflows/spec.md §3, §8.5): узлы — карточки,
 * исходы — порты на правом краю карточки, переходы — стрелки. Главная линия
 * идёт слева направо в верхнем ряду, обходные узлы (починка, доработка) —
 * рядами ниже. Возвраты и прыжки через столбец идут по дорожкам над или под
 * графом, чтобы не резать карточки.
 *
 * Исход в `stuck` стрелкой не рисуется: он есть почти у каждого узла, и
 * десяток линий в одну точку превращает граф в клубок. Вместо этого порт
 * помечен красным — «здесь прогон встаёт».
 *
 * Раскладка считается по структуре, а размеры берутся с DOM: карточки
 * разной высоты кладёт CSS-сетка, а стрелки дорисовываются по измеренным
 * координатам портов.
 */

interface Port {
  to: string;
  /** Подписи исходов, ведущих в `to`: `risky ×2`. */
  labels: string[];
  stuck: boolean;
}

interface Placed {
  id: string;
  node: WorkflowNode | null;
  col: number;
  row: number;
  ports: Port[];
}

interface Edge {
  from: string;
  to: string;
  /** Переход назад — в узел, из которого сюда пришли. */
  back: boolean;
}

export interface FlowLayout {
  nodes: Placed[];
  edges: Edge[];
  cols: number;
  rows: number;
}

const portsOf = (node: WorkflowNode): Port[] => {
  const byTarget = new Map<string, Port>();
  for (const [outcome, tr] of Object.entries(node.next)) {
    const port = byTarget.get(tr.to) ?? { to: tr.to, labels: [], stuck: tr.to === STUCK };
    port.labels.push(tr.max !== undefined ? `${outcome} ×${tr.max}` : outcome);
    byTarget.set(tr.to, port);
  }
  return [...byTarget.values()];
};

const edgeKey = (from: string, to: string) => `${from}>${to}`;

/** Разложить узлы по столбцам и рядам; стрелки — по портам. */
export function layoutWorkflow(workflow: Workflow): FlowLayout {
  const ports = new Map<string, Port[]>();
  for (const n of workflow.nodes) ports.set(n.id, portsOf(n));
  ports.set(END, []);
  const start = workflow.nodes[0].id;

  // Обход в глубину от первого узла в порядке файла: переход в узел, который
  // ещё на стеке, — возврат. Без возвратов граф ацикличен, по нему считаются
  // столбцы.
  const back = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const p of ports.get(id) ?? []) {
      if (p.stuck) continue;
      const s = state.get(p.to);
      if (s === 1) back.add(edgeKey(id, p.to));
      else if (s === undefined) visit(p.to);
    }
    state.set(id, 2);
  };
  visit(start);
  for (const n of workflow.nodes) if (!state.has(n.id)) visit(n.id);

  const edges: Edge[] = [];
  for (const n of workflow.nodes) {
    for (const p of ports.get(n.id) ?? []) {
      if (!p.stuck) edges.push({ from: n.id, to: p.to, back: back.has(edgeKey(n.id, p.to)) });
    }
  }

  // Столбец — длиннейший путь от начала по прямым переходам.
  const cols = new Map<string, number>();
  const colOf = (id: string): number => {
    const known = cols.get(id);
    if (known !== undefined) return known;
    cols.set(id, 0);
    const preds = edges.filter((e) => !e.back && e.to === id);
    const col = preds.length ? Math.max(...preds.map((e) => colOf(e.from) + 1)) : 0;
    cols.set(id, col);
    return col;
  };
  const ids = [...workflow.nodes.map((n) => n.id), END];
  for (const id of ids) colOf(id);

  // Главная линия — верхний ряд: с начала по самой длинной прямой цепочке.
  // Не по первому исходу: у узла решения первым может стоять «нечего делать
  // → конец», а счастливый путь — через совещание. Остальные узлы — рядами
  // ниже в порядке файла.
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    depth.set(id, 0);
    const outs = edges.filter((e) => !e.back && e.from === id);
    const d = outs.length ? Math.max(...outs.map((e) => depthOf(e.to) + 1)) : 0;
    depth.set(id, d);
    return d;
  };
  const rows = new Map<string, number>();
  let cur: string | null = start;
  while (cur && !rows.has(cur)) {
    rows.set(cur, 0);
    const from: string = cur;
    const options: Port[] = (ports.get(from) ?? []).filter((p: Port) =>
      !p.stuck && !back.has(edgeKey(from, p.to)) && !rows.has(p.to));
    let next: Port | null = null;
    for (const p of options) if (!next || depthOf(p.to) > depthOf(next.to)) next = p;
    cur = next ? next.to : null;
  }
  const used = new Map<number, number>();
  for (const id of ids) {
    if (rows.has(id)) continue;
    const col = colOf(id);
    const row = (used.get(col) ?? 0) + 1;
    used.set(col, row);
    rows.set(id, row);
  }

  const nodes: Placed[] = ids.map((id) => ({
    id,
    node: workflow.nodes.find((n) => n.id === id) ?? null,
    col: colOf(id),
    row: rows.get(id) ?? 0,
    ports: ports.get(id) ?? [],
  }));
  const reachable = edges.filter((e) => e.to === END).length > 0;
  const shown = reachable ? nodes : nodes.filter((n) => n.id !== END);
  return {
    nodes: shown,
    edges,
    cols: Math.max(...shown.map((n) => n.col)) + 1,
    rows: Math.max(...shown.map((n) => n.row)) + 1,
  };
}

// ---------------------------------------------------------------- маршруты

interface Box { x: number; y: number; w: number; h: number }
interface Pt { x: number; y: number }

/** Прямоугольник элемента относительно холста, без учёта transform. */
function relBox(el: HTMLElement, root: HTMLElement): Box {
  let x = 0; let y = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== root) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

/** Ломаная со скруглёнными углами. */
function roundedPath(pts: Pt[], r = 8): string {
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]; const b = pts[i]; const c = pts[i + 1];
    const inLen = Math.hypot(b.x - a.x, b.y - a.y);
    const outLen = Math.hypot(c.x - b.x, c.y - b.y);
    const rr = Math.min(r, inLen / 2, outLen / 2);
    const p1 = { x: b.x - ((b.x - a.x) / inLen) * rr, y: b.y - ((b.y - a.y) / inLen) * rr };
    const p2 = { x: b.x + ((c.x - b.x) / outLen) * rr, y: b.y + ((c.y - b.y) / outLen) * rr };
    d += ` L ${p1.x} ${p1.y} Q ${b.x} ${b.y} ${p2.x} ${p2.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

const LANE_STEP = 12;
const LANE_PAD = 14;
const GUTTER_IN = 6;
const LANE_X_STEP = 5;

interface Routed extends Edge { d: string; side: 'top' | 'bottom' | null; lane: number }

/**
 * Какие стрелки идут напрямую, а какие — по дорожкам; и на какой дорожке.
 * Дорожки раздаются как интервалы по столбцам: пересекающиеся — на разных.
 */
function planLanes(layout: FlowLayout): Map<string, { side: 'top' | 'bottom'; lane: number }> {
  const at = new Map(layout.nodes.map((n) => [n.id, n]));
  const occupied = new Set(layout.nodes.map((n) => `${n.col},${n.row}`));
  const direct = (e: Edge): boolean => {
    const s = at.get(e.from); const d = at.get(e.to);
    if (!s || !d || e.back || d.col <= s.col) return false;
    if (d.col === s.col + 1) return true;
    for (let c = s.col + 1; c < d.col; c++) {
      if (occupied.has(`${c},${s.row}`) || occupied.has(`${c},${d.row}`)) return false;
    }
    return true;
  };
  const plan = new Map<string, { side: 'top' | 'bottom'; lane: number }>();
  const routed = layout.edges.filter((e) => !direct(e)).map((e) => {
    const s = at.get(e.from) as Placed; const d = at.get(e.to) as Placed;
    const lo = Math.min(s.col + 1, d.col); const hi = Math.max(s.col + 1, d.col);
    return { e, side: (s.row === 0 ? 'top' : 'bottom') as 'top' | 'bottom', lo, hi };
  }).sort((a, b) => (a.hi - a.lo) - (b.hi - b.lo) || a.lo - b.lo);
  for (const side of ['top', 'bottom'] as const) {
    const taken: Array<Array<{ lo: number; hi: number }>> = [];
    for (const r of routed.filter((x) => x.side === side)) {
      let lane = 0;
      while ((taken[lane] ?? []).some((iv) => iv.lo <= r.hi && r.lo <= iv.hi)) lane++;
      (taken[lane] ??= []).push({ lo: r.lo, hi: r.hi });
      plan.set(edgeKey(r.e.from, r.e.to), { side, lane });
    }
  }
  return plan;
}

const lanesOn = (plan: Map<string, { side: string; lane: number }>, side: string): number =>
  Math.max(0, ...[...plan.values()].filter((p) => p.side === side).map((p) => p.lane + 1));

// ---------------------------------------------------------------- вид

const KIND_ICON: Record<string, IconName> = {
  step: 'pencil', check: 'list-check', gate: 'hand-stop', decide: 'help', fanout: 'users', meeting: 'message',
};

export function FlowGraph({ workflow, runs = [], taskTitle, selected = null, onSelect }: {
  workflow: Workflow;
  /** Прогоны, которые надо показать на узлах. */
  runs?: Run[];
  taskTitle?: (taskId: string) => string;
  selected?: string | null;
  onSelect?: (id: string) => void;
}) {
  const uid = useId().replace(/:/g, '');
  const layout = useMemo(() => layoutWorkflow(workflow), [workflow]);
  const plan = useMemo(() => planLanes(layout), [layout]);
  const topLanes = lanesOn(plan, 'top');
  const bottomLanes = lanesOn(plan, 'bottom');

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState<{ boxes: Map<string, Box>; ports: Map<string, Pt>; w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const canvas = canvasRef.current; const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const measure = () => {
      const boxes = new Map<string, Box>();
      const ports = new Map<string, Pt>();
      canvas.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => {
        boxes.set(el.dataset.node as string, relBox(el, canvas));
      });
      canvas.querySelectorAll<HTMLElement>('[data-port]').forEach((el) => {
        const b = relBox(el, canvas);
        ports.set(el.dataset.port as string, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
      });
      const w = canvas.offsetWidth; const h = canvas.offsetHeight;
      setGeom((prev) => {
        if (prev && prev.w === w && prev.h === h
          && [...boxes].every(([k, b]) => { const p = prev.boxes.get(k); return p && p.x === b.x && p.y === b.y && p.w === b.w && p.h === b.h; })
          && [...ports].every(([k, p]) => { const q = prev.ports.get(k); return q && q.x === p.x && q.y === p.y; })
          && prev.boxes.size === boxes.size && prev.ports.size === ports.size) return prev;
        return { boxes, ports, w, h };
      });
      // Граф шире окна — ужимаем до 0.72, дальше пусть скроллится. Размеры
      // выше сняты в единицах самого холста: zoom на offset* не влияет.
      const avail = wrap.clientWidth;
      const s = avail > 0 && w > avail ? Math.max(0.72, avail / w) : 1;
      setScale((prev) => (Math.abs(prev - s) < 0.005 ? prev : s));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas); ro.observe(wrap);
    canvas.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [layout, runs, selected]);

  const runsAt = useMemo(() => {
    const m = new Map<string, Run[]>();
    for (const r of runs) m.set(r.nodeId, [...(m.get(r.nodeId) ?? []), r]);
    return m;
  }, [runs]);

  const paths: Routed[] = useMemo(() => {
    if (!geom) return [];
    const out: Routed[] = [];
    for (const e of layout.edges) {
      const from = geom.ports.get(edgeKey(e.from, e.to));
      const to = geom.boxes.get(e.to);
      if (!from || !to) continue;
      const target = { x: to.x, y: to.y + to.h / 2 };
      const p = plan.get(edgeKey(e.from, e.to));
      if (!p) {
        // Прямая стрелка: по горизонтали до середины промежутка, вниз или
        // вверх до строки цели, и в её левый край. Ветки одного узла делят
        // вертикаль — так граф читается как дерево, а не как пучок кривых.
        const mid = (from.x + target.x) / 2;
        const d = Math.abs(target.y - from.y) < 1
          ? `M ${from.x} ${from.y} L ${target.x} ${target.y}`
          : roundedPath([from, { x: mid, y: from.y }, { x: mid, y: target.y }, target]);
        out.push({ ...e, d, side: null, lane: 0 });
        continue;
      }
      const src = geom.boxes.get(e.from) as Box;
      const gx = src.x + src.w + GUTTER_IN + p.lane * LANE_X_STEP;
      const ex = to.x - GUTTER_IN - p.lane * LANE_X_STEP;
      const laneY = p.side === 'top'
        ? LANE_PAD + (topLanes - 1 - p.lane) * LANE_STEP
        : geom.h - LANE_PAD - (bottomLanes - 1 - p.lane) * LANE_STEP;
      out.push({
        ...e, side: p.side, lane: p.lane,
        d: roundedPath([from, { x: gx, y: from.y }, { x: gx, y: laneY }, { x: ex, y: laneY }, { x: ex, y: target.y }, target]),
      });
    }
    return out;
  }, [geom, layout, plan, topLanes, bottomLanes]);

  const padTop = LANE_PAD + Math.max(1, topLanes) * LANE_STEP;
  const padBottom = LANE_PAD + Math.max(1, bottomLanes) * LANE_STEP;
  const padSide = GUTTER_IN + 4 * LANE_X_STEP + 6;

  return (
    <div ref={wrapRef} className="flow-graph">
      <div
        ref={canvasRef}
        className="flow-canvas"
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, var(--flow-node-w))`,
          padding: `${padTop}px ${padSide}px ${padBottom}px`,
          zoom: scale < 1 ? scale : undefined,
        }}
      >
        {geom && (
          <svg className="flow-edges" width={geom.w} height={geom.h} viewBox={`0 0 ${geom.w} ${geom.h}`}>
            <defs>
              <marker id={`arr-${uid}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                <path d="M0 0.5 L7 4 L0 7.5 z" className="flow-arrow" />
              </marker>
              <marker id={`arr-on-${uid}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                <path d="M0 0.5 L7 4 L0 7.5 z" className="flow-arrow on" />
              </marker>
            </defs>
            {paths.map((p) => {
              const on = selected !== null && (p.from === selected || p.to === selected);
              return (
                <path key={edgeKey(p.from, p.to)} d={p.d}
                  className={`flow-edge${p.back ? ' back' : ''}${on ? ' on' : ''}`}
                  markerEnd={`url(#arr-${on ? 'on-' : ''}${uid})`} />
              );
            })}
          </svg>
        )}
        {layout.nodes.map((n) => {
          const live = runsAt.get(n.id) ?? [];
          const style = { gridColumn: n.col + 1, gridRow: n.row + 1 };
          if (!n.node) {
            // Список законченных растягивал узел — в узле только число, список в подсказке.
            return (
              <Tooltip key={n.id} className="tip-block" tip={live.length ? <DoneList runs={live} taskTitle={taskTitle} /> : null}>
                <div data-node={n.id} className={`flow-node end${live.length ? ' live' : ''}`} style={style}
                  tabIndex={live.length ? 0 : undefined}
                  aria-label={t('flows.board.doneCount', { n: live.length })}>
                  <Icon name="circle-check" size={14} />
                  <span>{t('flows.board.done')}</span>
                  <span className="flow-end-count">{live.length}</span>
                </div>
              </Tooltip>
            );
          }
          const node = n.node;
          const on = selected === n.id;
          const who = (id: string) => (id === AUTHOR ? t('flows.node.author') : id);
          return (
            <div key={n.id} data-node={n.id} style={style}
              className={`flow-node kind-${node.kind}${on ? ' on' : ''}${live.length ? ' live' : ''}${onSelect ? ' pick' : ''}`}
              onClick={onSelect ? () => onSelect(n.id) : undefined}
              title={t(`flows.kind.hint.${node.kind}`)}>
              <div className="flow-node-main">
                <span className="flow-node-badge"><Icon name={KIND_ICON[node.kind] ?? 'circle'} size={16} /></span>
                <div className="flow-node-text">
                  <div className="flow-node-id">{node.id}</div>
                  <div className="flow-node-tags">
                    <span className="flow-tag kind">{t(`flows.kind.${node.kind}`)}</span>
                    {node.kind === 'gate' && (
                      <span className="flow-tag human"><Icon name="hand-stop" size={10} />{t('flows.tag.owner')}</span>
                    )}
                    {node.same && <span className="flow-tag">{t('flows.tag.same', { id: who(node.same) })}</span>}
                    {node.notSameAs && <span className="flow-tag">{t('flows.tag.notSame', { id: who(node.notSameAs) })}</span>}
                  </div>
                  {(node.run || node.needs?.length) && (
                    <div className="flow-node-sub">{node.run ?? node.needs?.join(', ')}</div>
                  )}
                </div>
              </div>
              <ul className="flow-ports">
                {n.ports.map((p) => (
                  <li key={p.to} className={`flow-port${p.stuck ? ' stuck' : ''}`}
                    title={p.stuck ? t('flows.legend.stuck') : `→ ${p.to === END ? t('flows.board.done') : p.to}`}>
                    <span>{p.labels.join(' / ')}</span>
                    <i className="flow-dot" data-port={p.stuck ? undefined : edgeKey(n.id, p.to)} />
                  </li>
                ))}
              </ul>
              <RunChips runs={live} taskTitle={taskTitle} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RunChips({ runs, taskTitle }: { runs: Run[]; taskTitle?: (id: string) => string }) {
  if (!runs.length) return null;
  return (
    <div className="flow-runs">
      {runs.map((r) => {
        const id = r.subject.taskId ?? r.subject.epicId ?? r.subject.flow ?? r.id;
        return (
          <span key={r.id} className={`chip ${r.status}`}
            title={`${r.subject.taskId ? taskTitle?.(r.subject.taskId) ?? '' : ''}${r.note ? `\n${r.note}` : ''}`.trim()}>
            {id}
          </span>
        );
      })}
    </div>
  );
}

/** Сколько законченных показать в подсказке: она не ловит мышь, прокрутить её нельзя. */
const DONE_SHOWN = 10;

/** Законченные по процессу, свежие сверху; не влезшие — одной строкой «ещё M». */
function DoneList({ runs, taskTitle }: { runs: Run[]; taskTitle?: (id: string) => string }) {
  const sorted = [...runs].sort((a, b) => b.updatedAt - a.updatedAt);
  const rest = sorted.length - DONE_SHOWN;
  return (
    <div className="flow-done-list">
      <div className="flow-done-head">{t('flows.board.doneCount', { n: runs.length })}</div>
      <ul>
        {sorted.slice(0, DONE_SHOWN).map((r) => {
          const id = r.subject.taskId ?? r.subject.epicId ?? r.subject.flow ?? r.id;
          return (
            <li key={r.id}>
              <span className="flow-done-id">{id}</span>
              <span className="flow-done-title">{r.subject.taskId ? taskTitle?.(r.subject.taskId) ?? '' : ''}</span>
            </li>
          );
        })}
      </ul>
      {rest > 0 && <div className="flow-done-more">{t('flows.board.doneMore', { n: rest })}</div>}
    </div>
  );
}

/** Легенда: виды узлов и две пометки, которые не объясняются сами. */
export function FlowLegend() {
  return (
    <div className="flow-legend">
      {(['step', 'check', 'gate', 'decide', 'meeting'] as const).map((k) => (
        <span key={k} className={`flow-legend-kind kind-${k}`} title={t(`flows.kind.hint.${k}`)}>
          <Icon name={KIND_ICON[k]} size={12} />{t(`flows.kind.${k}`)}
        </span>
      ))}
      <span className="flow-legend-kind stuck"><i className="flow-dot" />{t('flows.legend.stuck')}</span>
      <span className="flow-legend-kind"><b>×N</b>{t('flows.legend.max')}</span>
      <span className="flow-legend-kind"><i className="flow-legend-back" />{t('flows.legend.back')}</span>
    </div>
  );
}

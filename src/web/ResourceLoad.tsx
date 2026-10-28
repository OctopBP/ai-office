import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { t } from './i18n';

/**
 * Строка нагрузки в шапке очереди слияния (T-708): load, свободная память, RSS
 * сервера и живые сессии из GET /api/resources (T-706). Клик раскрывает график
 * за 24 ч. Признак перегруза и пороги приходят с сервера (T-709) — те же, что у гейта проверок.
 */
interface Sample {
  at: number;
  load: [number, number, number];
  cpus: number;
  freeMem: number;
  totalMem: number;
  rss: number;
  sessions: number;
  overload: { load: boolean; mem: boolean } | null;
}
interface Answer {
  latest: Sample | null;
  series: Sample[];
  thresholds: { loadPerCpu: number; freeShare: number };
}

const POLL_MS = 30_000;

function bytes(n: number): string {
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} ${t('res.gb')}` : `${Math.round(n / 1024 ** 2)} ${t('res.mb')}`;
}

/** Линия ряда в рамке 0..1 по вертикали; пустой ряд — пустая строка. */
function path(values: number[], max: number, w: number, h: number): string {
  if (values.length < 2 || max <= 0) return '';
  return values
    .map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - Math.min(1, v / max) * h).toFixed(1)}`)
    .join(' ');
}

function Chart({ title, values, max, mark, unit }: {
  title: string; values: number[]; max: number; mark?: number; unit: string;
}) {
  const w = 240;
  const h = 56;
  const last = values[values.length - 1];
  return (
    <figure className="res-chart">
      <figcaption className="small">
        {title}
        {last !== undefined && <span className="mono"> · {unit.replace('{v}', last.toFixed(2))}</span>}
      </figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title} preserveAspectRatio="none">
        {mark !== undefined && max > 0 && (
          <line className="res-mark" x1="0" x2={w} y1={h - (mark / max) * h} y2={h - (mark / max) * h} />
        )}
        <path className="res-line" d={path(values, max, w, h)} />
      </svg>
    </figure>
  );
}

export function ResourceLoad() {
  const officeId = useStore((s) => s.offices.find((o) => o.current)?.id);
  const [data, setData] = useState<Answer | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const q = officeId ? `?office=${encodeURIComponent(officeId)}` : '';
      const res = await fetch(`/api/resources${q}`);
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as Answer);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [officeId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const s = data?.latest ?? null;
  if (!s) {
    return failed ? (
      <div className="mq-load small">
        <span className="muted">{t('res.failed')}</span>{' '}
        <button type="button" className="mini" onClick={() => void load()}>{t('menu.retry')}</button>
      </div>
    ) : null;
  }
  const over = s.overload ?? { load: false, mem: false };
  const hot = s.overload !== null;
  const th = data!.thresholds;
  const series = data?.series ?? [];

  return (
    <div className="mq-load">
      <button
        ref={btn}
        type="button"
        className={`mq-load-btn small${hot ? ' hot' : ''}`}
        aria-expanded={open}
        aria-controls="mq-load-chart"
        title={t('res.toggle')}
        onClick={() => setOpen((v) => !v)}
      >
        {hot && <span className="mq-load-flag">⚠ {t('res.overload')}</span>}
        <span className={over.load ? 'bad' : ''}>{t('res.load', { v: s.load[0].toFixed(2), n: s.cpus })}</span>
        <span className={over.mem ? 'bad' : ''}>{t('res.free', { v: bytes(s.freeMem) })}</span>
        <span>{t('res.rss', { v: bytes(s.rss) })}</span>
        <span>{t('res.sessions', { n: s.sessions })}</span>
      </button>
      {open && (
        <div id="mq-load-chart" className="mq-load-chart">
          <div className="small muted">{t('res.window')}</div>
          <Chart
            title={t('res.chartLoad')}
            values={series.map((p) => p.load[0])}
            max={Math.max(s.cpus * th.loadPerCpu, ...series.map((p) => p.load[0]))}
            mark={s.cpus * th.loadPerCpu}
            unit="{v}"
          />
          <Chart
            title={t('res.chartFree')}
            values={series.map((p) => p.freeMem / 1024 ** 3)}
            max={s.totalMem / 1024 ** 3}
            mark={(s.totalMem * th.freeShare) / 1024 ** 3}
            unit={`{v} ${t('res.gb')}`}
          />
        </div>
      )}
    </div>
  );
}

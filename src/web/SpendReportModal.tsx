import { useEffect, useState } from 'react';
import { useStore } from './store';
import { money, tok } from './money';
import { t } from './i18n';
import type {
  SpendReport, SpendReportPeriod, SpendSignal, SpendSlice,
} from '../shared/spendReport';

/**
 * Окно «Расход токенов»: кто съел деньги и где они утекают. Данные — с
 * `GET /api/spend/report` (T-232), здесь только показ: ничего не считаем сами.
 */

type Slicing = 'task' | 'role' | 'node';

const SLICES: Record<Slicing, keyof Pick<SpendReport, 'byTask' | 'byRole' | 'byNode'>> = {
  task: 'byTask', role: 'byRole', node: 'byNode',
};

/** Цена среза: без цены от провайдера ноль не «бесплатно», а «неизвестно». */
const sliceCost = (s: SpendSlice): string => (s.costUnavailable && s.costUsd === 0 ? '—' : money(s.costUsd));

/** Подпись строки среза: у узла без процесса ключ `-`. */
function sliceTitle(kind: Slicing, s: SpendSlice): string {
  if (kind === 'node' && s.key === '-') return t('spendReport.noProcess');
  return s.label || s.key;
}

function SignalRow({ signal, onTask, onRole }: {
  signal: SpendSignal; onTask: (id: string) => void; onRole: (id: string) => void;
}) {
  const { target } = signal;
  const go = target.kind === 'task' ? () => onTask(target.id)
    : target.kind === 'role' ? () => onRole(target.id) : null;
  const body = (
    <>
      <span className={`spend-signal-dot ${signal.severity}`} aria-hidden />
      <span className="spend-signal-main">
        <b className="small">{target.label}</b>
        <span className="muted small">{signal.text}</span>
      </span>
      <span className="mono small">{money(signal.costUsd)}</span>
    </>
  );
  return go
    ? <button className="usage-row spend-signal" onClick={go} title={t(target.kind === 'task' ? 'board.openCard' : 'spendReport.showRole')}>{body}</button>
    : <div className="usage-row spend-signal">{body}</div>;
}

export function SpendReportModal({ onClose }: { onClose: () => void }) {
  const officeId = useStore((s) => s.offices.find((o) => o.current)?.id);
  const openTaskCard = useStore((s) => s.openTaskCard);
  const [period, setPeriod] = useState<SpendReportPeriod>('week');
  const [slicing, setSlicing] = useState<Slicing>('task');
  const [highlight, setHighlight] = useState<string | null>(null);
  const [state, setState] = useState<{ loading: boolean; failed: boolean; report: SpendReport | null }>(
    { loading: true, failed: false, report: null },
  );

  useEffect(() => {
    if (!officeId) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, failed: false }));
    const params = new URLSearchParams({ office: officeId, period });
    fetch(`/api/spend/report?${params}`)
      .then((res) => (res.ok ? res.json() as Promise<SpendReport> : Promise.reject(res.status)))
      .then((report) => { if (!cancelled) setState({ loading: false, failed: false, report }); })
      .catch(() => { if (!cancelled) setState({ loading: false, failed: true, report: null }); });
    return () => { cancelled = true; };
  }, [officeId, period]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const report = state.report;
  const rows = report ? report[SLICES[slicing]] : [];
  const empty = report !== null && report.total.runs === 0;

  const openTask = (id: string) => { openTaskCard(id); onClose(); };
  const showRole = (id: string) => { setSlicing('role'); setHighlight(id); };
  const pick = (kind: Slicing) => { setSlicing(kind); setHighlight(null); };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide spend-report" onClick={(e) => e.stopPropagation()}>
        <h3>{t('spendReport.title')}</h3>
        <p className="modal-reason">{t('spendReport.note')}</p>

        <div className="spend-controls">
          <div className="seg money-switch">
            <button className={period === 'day' ? 'on' : ''} onClick={() => setPeriod('day')}>
              {t('spendReport.period.day')}
            </button>
            <button className={period === 'week' ? 'on' : ''} onClick={() => setPeriod('week')}>
              {t('spendReport.period.week')}
            </button>
          </div>
          <div className="seg money-switch">
            {(['task', 'role', 'node'] as const).map((k) => (
              <button key={k} className={slicing === k ? 'on' : ''} onClick={() => pick(k)}>
                {t(`spendReport.by.${k}`)}
              </button>
            ))}
          </div>
        </div>

        {state.loading && <p className="muted small">{t('money.table.loading')}</p>}
        {!state.loading && state.failed && <p className="muted small">{t('spendReport.error')}</p>}
        {!state.loading && empty && (
          <div className="card spend-report-empty">
            <b>{t('spendReport.empty.title')}</b>
            <span className="muted small">{t('spendReport.empty.hint')}</span>
          </div>
        )}

        {!state.loading && report && !empty && (
          <>
            <h4 className="section-title">{t('spendReport.leaks')}</h4>
            {report.signals.length === 0 && <p className="muted small">{t('spendReport.noSignals')}</p>}
            <div className="usage-rows">
              {report.signals.map((s, i) => (
                <SignalRow key={`${s.kind}-${s.target.id}-${i}`} signal={s} onTask={openTask} onRole={showRole} />
              ))}
            </div>

            <h4 className="section-title">{t(`spendReport.by.${slicing}`)}</h4>
            <div className="card spend-table-wrap">
              <table className="spend-table">
                <thead>
                  <tr>
                    <th>{t(`spendReport.col.${slicing}`)}</th>
                    <th>{t('spendReport.col.input')}</th>
                    <th>{t('spendReport.col.cacheWrite')}</th>
                    <th>{t('spendReport.col.cacheRead')}</th>
                    <th>{t('spendReport.col.output')}</th>
                    <th>$</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.key} className={highlight === s.key ? 'hl' : ''}>
                      <td>
                        {slicing === 'task' ? (
                          <button className="link-btn" onClick={() => openTask(s.key)} title={t('board.openCard')}>
                            <span className="mono dim">{s.key}</span> {s.label !== s.key ? s.label : ''}
                          </button>
                        ) : sliceTitle(slicing, s)}
                      </td>
                      <td className="mono">{tok(s.input_tokens)}</td>
                      <td className="mono">{tok(s.cache_creation_input_tokens)}</td>
                      <td className="mono">{tok(s.cache_read_input_tokens)}</td>
                      <td className="mono">{tok(s.output_tokens)}</td>
                      <td className="mono"><b>{sliceCost(s)}</b></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>{t('spendReport.total')}</td>
                    <td className="mono">{tok(report.total.input_tokens)}</td>
                    <td className="mono">{tok(report.total.cache_creation_input_tokens)}</td>
                    <td className="mono">{tok(report.total.cache_read_input_tokens)}</td>
                    <td className="mono">{tok(report.total.output_tokens)}</td>
                    <td className="mono"><b>{sliceCost(report.total)}</b></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}

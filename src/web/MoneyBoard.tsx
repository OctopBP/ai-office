import { usageMoney } from './money';
import { useEffect, useMemo, useState } from 'react';
import { useStore, type SpendPeriod } from './store';
import { cacheShare, clock, limitTone, money, tok, usageLine } from './money';
import { Gauge, LimitBars } from './LimitBars';
import type { SpendBucket, SpendEntryView, SpendPage, SpendStep, TaskView, Usage } from '../shared/types';
import { accumulate, dayKey, emptyUsage } from '../shared/types';
import { t } from './i18n';
import { Avatar, AgentTag } from './Avatar';
import { displayInstance, useInstanceName } from './instanceName';

/**
 * Доска расходов: во что офису обошёлся день и каждая задача, и сколько
 * осталось до потолка — денежного и лимита плана.
 *
 * Доска, а не модалка: расход смотрят так же, как доску задач, — открыл,
 * поводил глазами по строкам, вернулся к работе. Раньше на это окно
 * приходилось наводиться мышью в HUD и оно закрывалось от любого промаха.
 */

const dayLabel = (day: string): string => {
  const [, m, d] = day.split('-');
  return `${d}.${m}`;
};

/** Потолок расходов офиса — тот лимит, который задаёт человек, а не план. */
function Budget() {
  const usage = useStore((s) => s.usage);
  const cap = useStore((s) => s.settings.globalBudgetUsd);
  if (cap === null) return <p className="muted small">{t('money.budget.none')}</p>;
  const percent = cap > 0 ? (usage.costUsd / cap) * 100 : 100;
  return (
    <div className="limit-rows">
      <Gauge
        label={t('money.budget.label')}
        percent={percent}
        note={t('money.budget.line', { spent: usageMoney(usage), cap: money(cap) })}
        tone={limitTone(percent)}
      />
    </div>
  );
}

/** Строка задачи: сколько она стоила за выбранный период и сколько всего. */
function TaskRow({ task, spent, span }: { task: TaskView; spent: Usage; span: 'today' | 'all' }) {
  const open = useStore((s) => s.openTaskCard);
  return (
    <button className="usage-row task-row" onClick={() => open(task.id)} title={t('board.openCard')}>
      <span className="mono dim">{task.id}</span>
      <span className="row-title">{task.title}</span>
      <span className={`chip ${task.status}`}>{t(`task.status.${task.status}`)}</span>
      {task.assigneeId && <AgentTag id={task.assigneeId} className="muted small" />}
      <span className="muted small">{usageLine(spent)}</span>
      {span === 'today' && task.usage.costUsd > spent.costUsd && (
        <span className="muted small">{t('money.ofTaskTotal', { total: usageMoney(task.usage) })}</span>
      )}
      <b>{usageMoney(spent)}</b>
    </button>
  );
}

/** Сколько строк детализации спрашивать за раз — максимум, который отдаёт сервер. */
const SPEND_ITEMS_LIMIT = 500;
/** Сколько групп разбивки показывать в строке интервала, остальные — «ещё N». */
const BREAKDOWN_SHOWN = 3;

/** Границы периода в мс по выбору человека — от начала окна до текущего момента. */
function spendRange(period: SpendPeriod, now: number): { from: number; to: number } {
  if (period === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { from: start.getTime(), to: now };
  }
  const days = period === 'week' ? 7 : 30;
  return { from: now - days * 24 * 60 * 60 * 1000, to: now };
}

/** Ключ интервала выбранного шага — та же формула, что группирует агрегаты на сервере (`stepKey` в `spend.ts`). */
function bucketKeyOf(at: number, step: SpendStep): string {
  const day = dayKey(at);
  return step === 'day' ? day : `${day}T${String(new Date(at).getHours()).padStart(2, '0')}`;
}

/** Подпись интервала: «22.09» для суток, «22.09 14:00» для часа. */
function bucketLabel(at: number, step: SpendStep): string {
  const day = dayLabel(dayKey(at));
  return step === 'day' ? day : `${day} ${clock(at)}`;
}

interface BreakdownGroup {
  key: string;
  taskId: string | null;
  instanceId: string;
  model: string | null;
  usage: Usage;
}

interface SpendRow {
  bucket: SpendBucket;
  breakdown: BreakdownGroup[];
  cumulative: Usage;
}

/**
 * Строки таблицы из страницы трат: сумма и накопительный итог берём из
 * серверных агрегатов (`buckets`, `total`) — они честны за весь период, даже
 * если строк детализации (`items`) в периоде больше, чем отдано на странице.
 * Разбивку по задаче/роли/модели строим из `items`: если страница неполная,
 * это видно по `truncated` и показывается отдельной оговоркой, а не молчком.
 */
function buildSpendRows(page: SpendPage, step: SpendStep): { rows: SpendRow[]; truncated: boolean } {
  const byBucket = new Map<string, SpendEntryView[]>();
  for (const e of page.items) {
    const key = bucketKeyOf(e.at, step);
    const list = byBucket.get(key);
    if (list) list.push(e); else byBucket.set(key, [e]);
  }

  const ascending = [...page.buckets].sort((a, b) => a.at - b.at);
  const running = emptyUsage();
  const rows: SpendRow[] = ascending.map((bucket) => {
    accumulate(running, bucket.usage);
    const entries = byBucket.get(bucket.key) ?? [];
    const groups = new Map<string, BreakdownGroup>();
    for (const e of entries) {
      const gKey = [e.taskId ?? '', e.instanceId, e.model ?? ''].join(' ');
      const found = groups.get(gKey);
      if (found) accumulate(found.usage, e.usage);
      else groups.set(gKey, { key: gKey, taskId: e.taskId, instanceId: e.instanceId, model: e.model, usage: { ...e.usage } });
    }
    const breakdown = [...groups.values()].sort((a, b) => b.usage.costUsd - a.usage.costUsd);
    return { bucket, breakdown, cumulative: { ...running } };
  });
  rows.reverse();
  return { rows, truncated: page.hasMore };
}

/** Одна строка разбивки: задача, исполнитель и модель — сумма правее. */
function BreakdownItem({ g }: { g: BreakdownGroup }) {
  const who = useInstanceName(g.instanceId);
  return (
    <div className="spend-break-item">
      <span className="mono dim">{g.taskId ?? t('money.table.noTask')}</span>
      <span className="muted small row-title">
        {who} · {g.model ?? t('money.table.noModel')}
      </span>
      <span className="mono small">{usageMoney(g.usage)}</span>
    </div>
  );
}

/** Строка таблицы: интервал, сумма, разбивка, накопительный итог. */
function SpendTableRow({ row, step }: { row: SpendRow; step: SpendStep }) {
  const extra = row.breakdown.length - BREAKDOWN_SHOWN;
  return (
    <tr>
      <td className="mono">{bucketLabel(row.bucket.at, step)}</td>
      <td className="mono">{usageMoney(row.bucket.usage)}</td>
      <td>
        <div className="spend-breakdown">
          {row.breakdown.slice(0, BREAKDOWN_SHOWN).map((g) => <BreakdownItem key={g.key} g={g} />)}
          {extra > 0 && <span className="muted small">{t('money.table.more', { n: extra })}</span>}
        </div>
      </td>
      <td className="mono">{usageMoney(row.cumulative)}</td>
    </tr>
  );
}

/**
 * Таблица трат по времени: строки — интервалы выбранного шага, столбцы —
 * время, сумма за интервал, разбивка по задаче/исполнителю/модели и
 * накопительный итог. Данные — с маршрута `/api/spend` (T-88): период и шаг
 * летят в запрос, страница отдаёт и сырые записи, и готовые агрегаты.
 */
function SpendTable() {
  const officeId = useStore((s) => s.offices.find((o) => o.current)?.id);
  const period = useStore((s) => s.spendPeriod);
  const step = useStore((s) => s.spendStep);
  const setPeriod = useStore((s) => s.setSpendPeriod);
  const setStep = useStore((s) => s.setSpendStep);

  const [state, setState] = useState<{ loading: boolean; failed: boolean; page: SpendPage | null }>(
    { loading: true, failed: false, page: null },
  );

  useEffect(() => {
    if (!officeId) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, failed: false }));
    const { from, to } = spendRange(period, Date.now());
    const params = new URLSearchParams({
      office: officeId, from: String(from), to: String(to), step, limit: String(SPEND_ITEMS_LIMIT),
    });
    fetch(`/api/spend?${params}`)
      .then((res) => (res.ok ? res.json() as Promise<SpendPage> : Promise.reject(res.status)))
      .then((page) => { if (!cancelled) setState({ loading: false, failed: false, page }); })
      .catch(() => { if (!cancelled) setState({ loading: false, failed: true, page: null }); });
    return () => { cancelled = true; };
  }, [officeId, period, step]);

  const built = useMemo(() => (state.page ? buildSpendRows(state.page, step) : null), [state.page, step]);

  return (
    <>
      <h4 className="section-title">{t('money.table.title')}</h4>
      <div className="spend-controls">
        <div className="seg money-switch">
          <button className={period === 'today' ? 'on' : ''} onClick={() => setPeriod('today')}>
            {t('money.table.period.today')}
          </button>
          <button className={period === 'week' ? 'on' : ''} onClick={() => setPeriod('week')}>
            {t('money.table.period.week')}
          </button>
          <button className={period === 'month' ? 'on' : ''} onClick={() => setPeriod('month')}>
            {t('money.table.period.month')}
          </button>
        </div>
        <div className="seg money-switch">
          <button className={step === 'hour' ? 'on' : ''} onClick={() => setStep('hour')}>
            {t('money.table.step.hour')}
          </button>
          <button className={step === 'day' ? 'on' : ''} onClick={() => setStep('day')}>
            {t('money.table.step.day')}
          </button>
        </div>
      </div>

      {state.loading && <p className="muted small">{t('money.table.loading')}</p>}
      {!state.loading && state.failed && <p className="muted small">{t('money.table.error')}</p>}
      {!state.loading && !state.failed && built && built.rows.length === 0 && (
        <p className="muted small">{t('money.table.empty')}</p>
      )}
      {!state.loading && !state.failed && built && built.rows.length > 0 && (
        <div className="card spend-table-wrap">
          {built.truncated && (
            <p className="modal-reason spend-truncated">
              {t('money.table.truncated', { n: SPEND_ITEMS_LIMIT })}
            </p>
          )}
          <table className="spend-table">
            <thead>
              <tr>
                <th>{t('money.table.col.time')}</th>
                <th>{t('money.table.col.amount')}</th>
                <th>{t('money.table.col.breakdown')}</th>
                <th>{t('money.table.col.total')}</th>
              </tr>
            </thead>
            <tbody>
              {built.rows.map((row) => <SpendTableRow key={row.bucket.key} row={row} step={step} />)}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function MoneyBoard() {
  const usage = useStore((s) => s.usage);
  const days = useStore((s) => s.usageDays);
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  const tasks = useStore((s) => s.tasks);
  // Период показывает и итог, и список задач. Живёт в доске, а не в сторе:
  // это про то, куда человек смотрит сейчас, и переживать закрытие доски ему
  // незачем — ровно как фильтру по фиче на доске задач.
  const [span, setSpan] = useState<'today' | 'all'>('today');

  const week = days.slice(-7);
  const peak = Math.max(0.0001, ...week.map((d) => d.usage.costUsd));
  // «Сегодня» берём из журнала офиса по тому же ключу дня, которым офис туда
  // и писал: сумма по агентам разошлась бы с ним, стоило кого-нибудь уволить.
  const today = days.find((d) => d.day === dayKey())?.usage ?? emptyUsage();
  const total = span === 'today' ? today : usage;

  const spentOn = (task: TaskView): Usage => (span === 'today' ? task.today : task.usage);
  const list = Object.values(tasks)
    .filter((task) => spentOn(task).costUsd > 0 || spentOn(task).costUnavailable)
    .sort((a, b) => spentOn(b).costUsd - spentOn(a).costUsd);

  const agents = Object.values(instances)
    .filter((i) => {
      const spent = span === 'today' ? i.today : i.usage;
      return spent.costUsd > 0 || spent.costUnavailable;
    })
    .sort((a, b) => (span === 'today' ? b.today.costUsd - a.today.costUsd
      : b.usage.costUsd - a.usage.costUsd));

  return (
    <div className="money-board">
      <div className="seg money-switch">
        <button className={span === 'today' ? 'on' : ''} onClick={() => setSpan('today')}>
          {t('money.span.today')}
        </button>
        <button className={span === 'all' ? 'on' : ''} onClick={() => setSpan('all')}>
          {t('money.span.all')}
        </button>
      </div>

      <div className="usage-total">
        <div>
          <b>{usageMoney(total)}</b>
          <span className="muted small">
            {t(span === 'today' ? 'common.today' : 'usage.allTime')}
          </span>
        </div>
        <div>
          <b>{tok(total.tokensIn)} / {tok(total.tokensOut)}</b>
          <span className="muted small">{t('usage.inOut')}</span>
        </div>
        <div>
          <b>{cacheShare(total) ?? 0}%</b>
          <span className="muted small">
            {t('usage.fromCache', { written: tok(total.cacheWrite) })}
          </span>
        </div>
        {/* Четвёртая плитка — всегда про ДРУГОЙ период: рядом с сегодняшним
            счётом нужен общий, а рядом с общим — сегодняшний. Одинаковая
            подпись на двух плитках читалась бы как ошибка в счёте. */}
        <div>
          <b>{usageMoney(span === 'today' ? usage : today)}</b>
          <span className="muted small">
            {t(span === 'today' ? 'usage.allTime' : 'common.today')}
          </span>
        </div>
      </div>

      <h4 className="section-title">{t('limits.title')}</h4>
      <p className="modal-reason">{t('limits.note')}</p>
      <LimitBars />

      <h4 className="section-title">{t('money.budget.title')}</h4>
      <Budget />

      <h4 className="section-title">{t('usage.byDay')}</h4>
      {week.length === 0 && <p className="muted small">{t('usage.nothingSpent')}</p>}
      <div className="usage-days">
        {week.map((d) => (
          <div key={d.day} className="usage-day"
            title={`${d.day}: ${usageMoney(d.usage)} · ${usageLine(d.usage)}`}>
            <div className="usage-bar" style={{ height: `${Math.max(4, (d.usage.costUsd / peak) * 56)}px` }} />
            <span className="muted small">{dayLabel(d.day)}</span>
            <span className="mono small">{usageMoney(d.usage)}</span>
          </div>
        ))}
      </div>

      <h4 className="section-title">{t('money.byTask')}</h4>
      {list.length === 0 && (
        <p className="muted small">
          {t(span === 'today' ? 'money.noTasksToday' : 'money.noTasks')}
        </p>
      )}
      <div className="usage-rows">
        {list.map((task) => (
          <TaskRow key={task.id} task={task} spent={spentOn(task)} span={span} />
        ))}
      </div>

      <h4 className="section-title">{t('usage.byAgent')}</h4>
      {agents.length === 0 && <p className="muted small">{t('usage.nothingSpent')}</p>}
      <div className="usage-rows">
        {agents.map((i) => (
          <div key={i.id} className="usage-row">
            <Avatar roleId={i.roleId} instanceId={i.id} size="sm" />
            <span className="row-title">{displayInstance(i.id, instances, roles)}</span>
            <span className="muted small">{usageLine(span === 'today' ? i.today : i.usage)}</span>
            <b>{usageMoney(span === 'today' ? i.today : i.usage)}</b>
          </div>
        ))}
      </div>

      <SpendTable />

      <p className="modal-reason">{t('usage.note')}</p>
    </div>
  );
}

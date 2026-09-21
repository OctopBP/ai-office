import { usageMoney } from './money';
import { useState } from 'react';
import { useStore } from './store';
import { cacheShare, limitTone, money, tok, usageLine } from './money';
import { Gauge, LimitBars } from './LimitBars';
import type { TaskView, Usage } from '../shared/types';
import { dayKey, emptyUsage } from '../shared/types';
import { t } from './i18n';
import { Avatar, AgentTag } from './Avatar';

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

export function MoneyBoard() {
  const usage = useStore((s) => s.usage);
  const days = useStore((s) => s.usageDays);
  const instances = useStore((s) => s.instances);
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
            <span className="mono dim">{i.id}</span>
            <span className="row-title">{i.label}</span>
            <span className="muted small">{usageLine(span === 'today' ? i.today : i.usage)}</span>
            <b>{usageMoney(span === 'today' ? i.today : i.usage)}</b>
          </div>
        ))}
      </div>

      <p className="modal-reason">{t('usage.note')}</p>
    </div>
  );
}

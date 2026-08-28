import { useState } from 'react';
import {
  approveEpic, cancelEpic, mergeBadge, mergeStepFor, prStageLabel, prStageClass,
  reorderEpics, useStore,
} from './store';
import type { EpicView, TaskStatus, TaskView } from '../shared/types';
import { taskClosed } from '../shared/types';
import { t as tr, type UiKey } from './i18n';
import { Icon } from './icons';

/**
 * Колонки доски. Провалы вынесены отдельно, а не свалены в «Готово»: пока они
 * лежали рядом со сделанным, их не замечали ни человек, ни менеджер — а это
 * ровно та стопка, из-за которой работа встаёт.
 *
 * «План» — тоже отдельная колонка, и по той же причине наоборот: плановая
 * задача стоит по замыслу, а не потому, что о ней забыли. Свалив её к
 * ожидающим, доска показывала бы намеренную паузу как затор.
 */
const COLUMNS: Array<{ key: UiKey; statuses: TaskStatus[]; tone?: 'bad' }> = [
  { key: 'board.col.planned', statuses: ['planned'] },
  { key: 'board.col.waiting', statuses: ['backlog', 'assigned'] },
  { key: 'board.col.working', statuses: ['in_progress'] },
  { key: 'board.col.review', statuses: ['review'] },
  { key: 'board.col.done', statuses: ['done'] },
  { key: 'board.col.failed', statuses: ['failed', 'blocked'], tone: 'bad' },
];

const statusLabel = (status: TaskStatus): string => tr(`task.status.${status}`);

/**
 * Карточка на доске — только то, по чему задачу узнаю́т глазами: номер,
 * название и одна строка меток. Всё остальное (ТЗ, критерии, отчёт, файлы,
 * ветка, кнопки) живёт в раскрытой карточке — TaskDrawer.
 *
 * Так было не всегда: карточка несла всё сразу, и на десятке задач доска
 * превращалась в стену текста, где колонки переставали читаться. Подробности
 * нужны по одной задаче за раз, а обзор — по всем сразу, и это две разные
 * поверхности, а не одна.
 */
function Card({ t }: { t: TaskView }) {
  const open = useStore((s) => s.openTaskCard);
  const active = useStore((s) => s.openTask) === t.id;
  const run = useStore((s) => s.mergeRun);
  const check = useStore((s) => s.mergeChecks[t.id]);
  const badge = mergeBadge(t, mergeStepFor(run, t.id), check);
  // Стадия конвейера точнее статуса: «на проверке» одинаково выглядит и когда
  // ветку синхронизируют, и когда ревьюер уже смотрит.
  const pr = useStore((s) => s.prs[t.id]);
  const done = t.criteria.filter((c) => c.done).length;

  return (
    <button
      className={`task ${t.status}${active ? ' open' : ''}`}
      onClick={() => open(t.id)}
      title={tr('board.openCard')}
    >
      <div className="task-head">
        <b>{t.id}</b>
        <span className="task-title">{t.title}</span>
      </div>
      <div className="task-meta">
        <span className={`chip ${t.status}`}>{statusLabel(t.status)}</span>
        {pr && pr.stage !== 'merged' && (
          <span className={`chip merge-chip ${prStageClass(pr.stage)}`} title={pr.note}>
            {prStageLabel(pr.stage)}
          </span>
        )}
        {badge && <span className={`chip merge-chip ${badge.cls}`}>{badge.label}</span>}
        {t.assigneeId && <span className="muted">{t.assigneeId}</span>}
        {t.criteria.length > 0 && (
          <span className="muted">{done}/{t.criteria.length}</span>
        )}
        {t.usage.costUsd > 0 && <span className="muted">{`$${t.usage.costUsd.toFixed(2)}`}</span>}
        {/* Замок — единственная подробность, оставленная на карточке:
            без него «почему эта задача стоит» пришлось бы открывать. */}
        {t.status === 'planned' && t.dependsOn.length > 0 && (
          <span className="muted lock" title={tr('plan.waits', { deps: t.dependsOn.join(', ') })}>
            <Icon name="lock" size={12} />
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * Строка фичи в плане. Прогресс считается по задачам, которые у клиента и так
 * есть: отдельного счётчика на сервере нет намеренно — он ехал бы заново на
 * каждое изменение любой задачи.
 */
function EpicRow({ epic, order, total, filtered, onFilter }: {
  epic: EpicView;
  order: number;
  total: number;
  filtered: boolean;
  onFilter: () => void;
}) {
  const tasks = useStore((s) => s.tasks);
  const epics = useStore((s) => s.epics);
  const autoPipeline = useStore((s) => s.settings.autoPipeline);
  const [confirmDrop, setConfirmDrop] = useState(false);

  const mine = Object.values(tasks).filter((t) => t.epicId === epic.id);
  const done = mine.filter((t) => taskClosed(t, autoPipeline)).length;
  const spent = mine.reduce((sum, t) => sum + t.usage.costUsd, 0);
  // Ждёт согласия — это не «в плане», а остановка, на которую можно нажать:
  // отличаем её и подписью, и кнопкой.
  const awaiting = epic.status === 'planned' && !epic.approved;
  const open = epic.status === 'planned' || epic.status === 'active';

  /** Сдвиг на одну позицию: порядок пересобираем целиком и шлём его весь. */
  const move = (delta: number) => {
    const ids = Object.values(epics).sort((a, b) => a.order - b.order).map((e) => e.id);
    const at = ids.indexOf(epic.id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(at, 1));
    reorderEpics(ids);
  };

  return (
    <div className={`epic ${epic.status}${awaiting ? ' awaiting' : ''}${filtered ? ' filtered' : ''}`}>
      <div className="epic-head">
        <button className="epic-pick" onClick={onFilter} title={tr('plan.filterHint')}>
          <b>{epic.id}</b>
          <span className="epic-title">{epic.title}</span>
        </button>
        <span className={`chip ${epic.status}`}>{tr(`plan.status.${epic.status}`)}</span>
        <span className="muted">{tr('plan.progress', { done, total: mine.length })}</span>
        {spent > 0 && <span className="muted">{`$${spent.toFixed(2)}`}</span>}
        {open && (
          <span className="epic-move">
            <button className="sq mini" disabled={order === 0} onClick={() => move(-1)}
              title={tr('plan.moveUp')}>↑</button>
            <button className="sq mini" disabled={order === total - 1} onClick={() => move(1)}
              title={tr('plan.moveDown')}>↓</button>
          </span>
        )}
      </div>
      {epic.goal && <div className="epic-goal muted">{epic.goal}</div>}
      {open && (
        <div className="epic-controls">
          {awaiting && <span className="muted small">{tr('plan.awaiting')}</span>}
          {epic.status === 'planned' && epic.approved && (
            <span className="muted small">{tr('plan.queued')}</span>
          )}
          {awaiting && (
            <button className="merge" onClick={() => approveEpic(epic.id)}>{tr('plan.approve')}</button>
          )}
          {/* Снятие спрашивают дважды: незапущенные задачи фичи после него
              не раздаются, и промахнуться мышью по этой кнопке дорого. */}
          {confirmDrop ? (
            <>
              <span className="muted small">{tr('plan.dropConfirm')}</span>
              <button className="stop" onClick={() => { cancelEpic(epic.id); setConfirmDrop(false); }}>
                {tr('plan.dropYes')}
              </button>
              <button className="mini" onClick={() => setConfirmDrop(false)}>{tr('common.cancel')}</button>
            </>
          ) : (
            <button className="mini" onClick={() => setConfirmDrop(true)}>{tr('plan.drop')}</button>
          )}
        </div>
      )}
    </div>
  );
}

export function Board() {
  const tasks = useStore((s) => s.tasks);
  const epics = useStore((s) => s.epics);
  const focus = useStore((s) => s.settings.focusEpics);
  // Фильтр по фиче живёт в доске, а не в сторе: он про то, куда человек
  // смотрит сейчас, и переживать закрытие доски ему незачем.
  const [only, setOnly] = useState<string | null>(null);

  const plan = Object.values(epics).sort((a, b) => a.order - b.order);
  const all = Object.values(tasks).sort((a, b) => a.createdAt - b.createdAt);
  // Фича могла исчезнуть из плана, пока фильтр стоял на ней, — тогда он
  // показывал бы пустую доску, и понять почему было бы нельзя.
  const picked = only && epics[only] ? only : null;
  const list = picked ? all.filter((t) => t.epicId === picked) : all;

  return (
    <div className="board">
      {plan.length > 0 && (
        <div className="plan">
          <div className="plan-head">
            {tr('plan.title')}
            {picked && (
              <button className="mini" onClick={() => setOnly(null)}>
                {tr('plan.showAll', { epic: picked })}
              </button>
            )}
            <span className="muted">{tr('plan.focus', { n: focus ?? 2 })}</span>
          </div>
          <div className="plan-rows">
            {plan.map((epic, i) => (
              <EpicRow
                key={epic.id}
                epic={epic}
                order={i}
                total={plan.length}
                filtered={picked === epic.id}
                onFilter={() => setOnly(picked === epic.id ? null : epic.id)}
              />
            ))}
          </div>
        </div>
      )}
      {all.length === 0 && <p className="empty">{tr('board.empty')}</p>}
      {all.length > 0 && (
        <div className="columns">
          {COLUMNS.map((col) => {
            const items = list.filter((t) => col.statuses.includes(t.status));
            return (
              <div key={col.key} className={`column${col.tone ? ` ${col.tone}` : ''}`}>
                <div className="column-head">
                  {tr(col.key)} <span className="muted">{items.length}</span>
                </div>
                {items.map((t) => <Card key={t.id} t={t} />)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

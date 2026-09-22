import { useState } from 'react';
import {
  approveEpic, cancelEpic, createDirection, mergeBadge, mergeStepFor, prStageLabel, prStageClass,
  removeDirection, reorderEpics, updateDirection, useStore,
} from './store';
import type { EpicView, TaskStatus, TaskView } from '../shared/types';
import { taskClosed, taskOver } from '../shared/types';
import { t as tr } from './i18n';
import { Icon } from './icons';
import { AgentTag } from './Avatar';
import { PriorityChip } from './TaskPriority';

const statusLabel = (status: TaskStatus): string => tr(`task.status.${status}`);

/**
 * Ключ группы «Разное» — задачи, заведённые мимо плана, и задачи фичи,
 * которой в плане уже нет. Не пересекается с номерами фич: в них решётки нет.
 */
const MISC_GROUP = '#misc';

/**
 * Задача остановилась насовсем: доведена до конца, снята или провалена и не
 * перезапущена. Провал лежит здесь же — пока его не перезапустили, в задаче
 * ничего не происходит, а перезапуск меняет статус и возвращает её наверх, к
 * живым. «Готова, но ещё не влита» закрытой не считается: конвейер её везёт.
 */
const taskIdle = (t: TaskView, autoPipeline: boolean): boolean =>
  t.status === 'failed' || taskOver(t, autoPipeline);

/**
 * Живые задачи фичи, разложенные по смыслу ожидания, плюс то, что закончилось
 * плохо. Ровно эти числа и стоят в заголовке группы: по свёрнутой строке видно,
 * что с фичей происходит, не разворачивая её.
 */
type GroupCounts = {
  /** Назначена или уже делается. */
  running: number;
  /** На проверке у ревьюера или едет конвейером слияния. */
  review: number;
  /** Ещё никто не взял: в плане, в бэклоге, заблокирована. */
  queued: number;
  failed: number;
  cancelled: number;
};

/**
 * Куда положить живую задачу. `done` сюда попадает только непритом: доведённая,
 * но ещё не влитая задача не закрыта — её везёт конвейер, а это то же ожидание
 * чужого действия, что и ревью, и смотрят на неё так же.
 */
const liveBucket = (status: TaskStatus): 'running' | 'review' | 'queued' => {
  if (status === 'assigned' || status === 'in_progress') return 'running';
  if (status === 'review' || status === 'done') return 'review';
  return 'queued';
};

/** Группа задач одной фичи: что показать в заголовке и что под ним. */
type TaskGroup = {
  key: string;
  /** Номер фичи для заголовка; у «Разного» его нет. */
  id: string | null;
  title: string;
  /** Идущие задачи — видны сразу. */
  live: TaskView[];
  /** Закрытые — под свёрнутой строкой. */
  closed: TaskView[];
  done: number;
  total: number;
  spent: number;
  counts: GroupCounts;
};

/**
 * Задачи по фичам плана. Связь берём из `task.epicId` — того самого поля, по
 * которому офис и считает фичу закрытой; угадывать фичу по названию задачи
 * нельзя, названия совпадают у половины доски.
 *
 * Порядок групп — как фичи стоят в плане, «Разное» последним. Фичи без задач
 * не показываем: на подвкладке «Задачи» им нечего показать, а сама фича видна
 * на соседней подвкладке «План».
 */
function groupTasks(list: TaskView[], plan: EpicView[], autoPipeline: boolean): TaskGroup[] {
  const empty = (key: string, id: string | null, title: string): TaskGroup => ({
    key, id, title, live: [], closed: [], done: 0, total: 0, spent: 0,
    counts: { running: 0, review: 0, queued: 0, failed: 0, cancelled: 0 },
  });
  const groups = new Map<string, TaskGroup>();
  for (const epic of plan) groups.set(epic.id, empty(epic.id, epic.id, epic.title));
  // «Разное» заводим последним — Map держит порядок вставки, и отдельная
  // сортировка групп не нужна.
  groups.set(MISC_GROUP, empty(MISC_GROUP, null, tr('board.group.misc')));

  for (const t of list) {
    const group = (t.epicId && groups.get(t.epicId)) || groups.get(MISC_GROUP)!;
    const idle = taskIdle(t, autoPipeline);
    (idle ? group.closed : group.live).push(t);
    group.total += 1;
    if (taskClosed(t, autoPipeline)) group.done += 1;
    group.spent += t.usage.costUsd;
    if (idle) {
      // Провал и снятие — единственные исходы, о которых надо сказать и у
      // закрытой фичи: иначе закрытая с провалом выглядит как успешная.
      if (t.status === 'failed') group.counts.failed += 1;
      if (t.status === 'cancelled') group.counts.cancelled += 1;
    } else {
      group.counts[liveBucket(t.status)] += 1;
    }
  }
  return [...groups.values()].filter((g) => g.total > 0);
}

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
        {/* Средней важности на доске нет намеренно: она у большинства задач, и
            чип «обычная» на каждой карточке ничего бы не отличал, а группы
            запестрили бы. Поднять среднюю можно из раскрытой карточки. */}
        {t.priority !== 'normal' && <PriorityChip task={t} />}
        <span className={`chip ${t.status}`}>{statusLabel(t.status)}</span>
        {pr && pr.stage !== 'merged' && (
          <span className={`chip merge-chip ${prStageClass(pr.stage)}`} title={pr.note}>
            {prStageLabel(pr.stage)}
          </span>
        )}
        {badge && <span className={`chip merge-chip ${badge.cls}`}>{badge.label}</span>}
        {t.assigneeId && <AgentTag id={t.assigneeId} className="muted" />}
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
 * Группа фичи на доске. Свёрнута или развёрнута — решает человек, а пока он не
 * решал, умолчание считается по задачам: там, где ещё что-то идёт, группа
 * открыта, а доделанная фича лежит одной строкой. Иначе экран на сотню задач
 * занимает влитая история, а работа сегодняшнего дня теряется в ней.
 */
function TaskGroupBlock({ group }: { group: TaskGroup }) {
  const openFlag = useStore((s) => s.taskGroupsOpen[group.key]);
  const closedFlag = useStore((s) => s.taskGroupClosedOpen[group.key]);
  const setOpen = useStore((s) => s.setTaskGroupOpen);
  const setClosedOpen = useStore((s) => s.setTaskGroupClosedOpen);
  const open = openFlag ?? group.live.length > 0;
  const closedOpen = closedFlag ?? false;

  const { running, review, queued, failed, cancelled } = group.counts;
  const left = group.live.length;
  // Фича закрыта, когда ничего живого не осталось, — тем же правилом, каким
  // офис считает закрытой саму фичу. Ещё не начата — когда все задачи до
  // единой стоят в очереди: ни одной взятой, ни одной законченной.
  const allClosed = left === 0;
  const fresh = !allClosed && queued === group.total;
  // «Осталось» имеет смысл, только когда оно больше любого отдельного
  // счётчика: у фичи, где всё стоит в очереди, это то же самое число третий
  // раз подряд — рядом с «в очереди 2» и «готово 0 из 2».
  const showLeft = [running, review, queued].filter((n) => n > 0).length > 1;
  const percent = group.total > 0 ? Math.round((group.done / group.total) * 100) : 0;

  return (
    <div className={`task-group${open ? ' open' : ''}${allClosed ? ' all-closed' : ''}`}>
      <button className="task-group-head" onClick={() => setOpen(group.key, !open)}
        title={tr('board.group.toggle')}>
        <span className="caret" aria-hidden>{open ? '▾' : '▸'}</span>
        {group.id && <b>{group.id}</b>}
        <span className="task-group-title" title={group.title}>{group.title}</span>
        {/* Счётчики — только ненулевые: строка заголовка узкая, и чип «на ревью
            0» в ней занимает место ровно ничем. У закрытой фичи счётчиков нет
            вовсе, остаётся итог: считать в ней уже нечего. */}
        <span className="task-group-counts">
          {allClosed ? (
            <span className="chip group-count closed">
              <Icon name="circle-check" size={12} />{tr('board.group.allClosed')}
            </span>
          ) : (
            <>
              {fresh && (
                <span className="chip group-count fresh">
                  <Icon name="hourglass" size={11} />{tr('board.group.fresh')}
                </span>
              )}
              {showLeft && (
                <span className="chip group-count left">{tr('board.group.left', { n: left })}</span>
              )}
              {running > 0 && (
                <span className="chip group-count run">{tr('board.group.running', { n: running })}</span>
              )}
              {review > 0 && (
                <span className="chip group-count rev">{tr('board.group.review', { n: review })}</span>
              )}
              {queued > 0 && (
                <span className="chip group-count wait">{tr('board.group.queued', { n: queued })}</span>
              )}
            </>
          )}
          {failed > 0 && (
            <span className="chip group-count fail" title={tr('board.group.failedHint')}>
              {tr('board.group.failed', { n: failed })}
            </span>
          )}
          {cancelled > 0 && (
            <span className="chip group-count drop" title={tr('board.group.cancelledHint')}>
              {tr('board.group.cancelled', { n: cancelled })}
            </span>
          )}
        </span>
        <span className="muted">{tr('board.group.progress', { done: group.done, total: group.total })}</span>
        {group.spent > 0 && <span className="muted">{`$${group.spent.toFixed(2)}`}</span>}
        {/* Полоса прогресса лежит на нижней границе заголовка отдельным слоем:
            в потоке она добавила бы строке высоты, а её здесь и так впритык. */}
        <span className="group-bar" aria-hidden>
          <span className="group-bar-fill" style={{ width: `${percent}%` }} />
        </span>
      </button>
      {open && (
        <div className="task-group-body">
          {/* Идущие задачи — первыми и без всяких переключателей: ради них
              на доску и заходят. */}
          {group.live.length > 0 && (
            <div className="task-cards">
              {group.live.map((t) => <Card key={t.id} t={t} />)}
            </div>
          )}
          {group.closed.length > 0 && (
            <>
              <button className="ghost task-group-closed"
                onClick={() => setClosedOpen(group.key, !closedOpen)}>
                <span className="caret" aria-hidden>{closedOpen ? '▾' : '▸'}</span>
                {tr('board.group.closed', { n: group.closed.length })}
              </button>
              {closedOpen && (
                <div className="task-cards closed">
                  {group.closed.map((t) => <Card key={t.id} t={t} />)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
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

  const initiative = epic.origin === 'office';

  return (
    <div className={`epic ${epic.status}${awaiting ? ' awaiting' : ''}${filtered ? ' filtered' : ''}${initiative ? ' initiative' : ''}`}>
      <div className="epic-head">
        <button className="epic-pick" onClick={onFilter} title={tr('plan.filterHint')}>
          <b>{epic.id}</b>
          <span className="epic-title">{epic.title}</span>
        </button>
        <span className={`chip ${epic.status}`}>{tr(`plan.status.${epic.status}`)}</span>
        {initiative && (
          <span className="chip initiative-chip" title={tr('plan.initiativeHint', { rationale: epic.rationale })}>
            {tr('plan.initiative')}{epic.directionId ? ` · ${epic.directionId}` : ''}
          </span>
        )}
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
      {initiative && epic.rationale && (
        <div className="epic-rationale">{tr('plan.initiativeHint', { rationale: epic.rationale })}</div>
      )}
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

/**
 * Направления владельца (docs/design/living-office/spec.md §7.1): стоящие
 * цели без срока, по которым офис сам выбирает себе фичи. Над планом,
 * потому что объясняют, откуда в плане взялись инициативы.
 */
function Directions() {
  const directions = useStore((s) => s.directions);
  const [text, setText] = useState('');
  const list = [...directions].sort((a, b) =>
    Number(a.builtin) - Number(b.builtin) || a.priority - b.priority || a.createdAt - b.createdAt);
  const add = () => {
    if (!text.trim()) return;
    createDirection(text.trim());
    setText('');
  };
  return (
    <div className="directions">
      <div className="plan-head">
        {tr('directions.title')}
        <span className="muted">{tr('directions.hint')}</span>
      </div>
      <div className="direction-rows">
        {list.length === 0 && <p className="empty">{tr('board.sub.empty')}</p>}
        {list.map((d) => (
          <div key={d.id} className={`direction${d.active ? '' : ' paused'}`}>
            <b>{d.id}</b>
            <span className="direction-text">{d.text}</span>
            {d.builtin && <span className="chip">{tr('directions.builtin')}</span>}
            {!d.active && <span className="chip">{tr('directions.paused')}</span>}
            <button className="mini" onClick={() => updateDirection(d.id, { active: !d.active })}>
              {tr(d.active ? 'directions.pause' : 'directions.resume')}
            </button>
            {!d.builtin && (
              <button className="mini link-danger" onClick={() => removeDirection(d.id)}>{tr('directions.remove')}</button>
            )}
          </div>
        ))}
        <div className="direction new">
          <input value={text} placeholder={tr('directions.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          <button className="mini go" disabled={!text.trim()} onClick={add}>{tr('directions.add')}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Подвкладки экрана доски. Раньше направления, план и колонки стояли друг под
 * другом, и на десятке направлений сама доска уезжала за нижний край экрана —
 * то есть главное на экране пряталось за тем, что читают раз в неделю.
 * Показываем один блок за раз, каждый во всю высоту.
 */
type BoardTab = 'directions' | 'plan' | 'tasks';
const BOARD_TABS: BoardTab[] = ['directions', 'plan', 'tasks'];

export function Board() {
  const tasks = useStore((s) => s.tasks);
  const epics = useStore((s) => s.epics);
  const focus = useStore((s) => s.settings.focusEpics);
  // Тем же признаком, что и в плане, считаем «готово N из M»: доведённой
  // задача считается по правилу офиса, а не по одному статусу.
  const autoPipeline = useStore((s) => s.settings.autoPipeline);
  // Фильтр по фиче живёт в доске, а не в сторе: он про то, куда человек
  // смотрит сейчас, и переживать закрытие доски ему незачем.
  const [only, setOnly] = useState<string | null>(null);
  // Выбранная подвкладка — тоже локальная и по той же причине. Умолчание —
  // задачи: доска и есть то, за чем на этот экран приходят.
  const [tab, setTab] = useState<BoardTab>('tasks');

  const plan = Object.values(epics).sort((a, b) => a.order - b.order);
  const all = Object.values(tasks).sort((a, b) => a.createdAt - b.createdAt);
  // Фича могла исчезнуть из плана, пока фильтр стоял на ней, — тогда он
  // показывал бы пустую доску, и понять почему было бы нельзя.
  const picked = only && epics[only] ? only : null;
  const list = picked ? all.filter((t) => t.epicId === picked) : all;

  return (
    <div className="board">
      {/* Шапка экрана: переключатель блоков и снятие фильтра по фиче. Не
          прокручивается — фильтр ставят в «Плане», а видят его в «Задачах»,
          и кнопка снятия нужна на обеих подвкладках. */}
      <div className="board-tabs">
        <div className="seg">
          {BOARD_TABS.map((k) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {tr(`board.tab.${k}`)}
            </button>
          ))}
        </div>
        {picked && (
          <button className="mini" onClick={() => setOnly(null)}>
            {tr('plan.showAll', { epic: picked })}
          </button>
        )}
      </div>
      <div className="board-pane">
        {tab === 'directions' && <Directions />}
        {tab === 'plan' && (
          <div className="plan">
            <div className="plan-head">
              {tr('plan.title')}
              <span className="muted">{tr('plan.focus', { n: focus ?? 2 })}</span>
            </div>
            <div className="plan-rows">
              {plan.length === 0 && <p className="empty">{tr('board.sub.empty')}</p>}
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
        {tab === 'tasks' && all.length === 0 && <p className="empty">{tr('board.empty')}</p>}
        {tab === 'tasks' && all.length > 0 && (
          <div className="task-groups">
            {groupTasks(list, plan, autoPipeline).map((group) => (
              <TaskGroupBlock key={group.key} group={group} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

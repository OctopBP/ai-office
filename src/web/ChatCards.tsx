import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { ChatEntry, ChatRef, ChatTaskEventRef, EpicView, PullRequestView, TaskView } from '../shared/types';
import { isOfficeSender, taskClosed } from '../shared/types';
import { isOpenQuestion } from '../shared/questions';
import { answerQuestion, approveEpic, prStageClass, prStageLabel, useStore } from './store';
import { locale, t } from './i18n';
import { AgentTag } from './Avatar';
import { PriorityChip } from './TaskPriority';
import { Markdown } from './Markdown';
import { useInstanceName } from './instanceName';

/** Время в шапке карточки вопроса: день нужен, только если спросили не сегодня. */
const clock = (at: number): string => {
  const d = new Date(at);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(locale(), today
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/**
 * Живые карточки в ленте чата с менеджером (docs/design/T-126/cards.md).
 * Сообщение хранит только ссылку (`ChatEntry.ref`), всё остальное — статус,
 * исполнитель, прогресс, ответ на вопрос — читается из стора доски. Поэтому
 * карточка меняется сама, когда меняется задача, и новых реплик это не плодит.
 */

/** Тон карточки задачи: шесть состояний каталога сведены к четырём цветам. */
type Tone = 'muted' | 'accent' | 'ok' | 'danger';

/**
 * Состояние карточки задачи по §1 каталога. «В очереди» — четыре невзятых
 * статуса одним нейтральным тоном, слово в чипе остаётся точным. Готовая, но
 * не влитая задача — ещё «на ревью»: её везёт конвейер.
 */
function taskState(task: TaskView, pr: PullRequestView | undefined, autoPipeline: boolean): { tone: Tone; label: string } {
  switch (task.status) {
    case 'in_progress':
    case 'review':
      return { tone: 'accent', label: t(`task.status.${task.status}`) };
    case 'failed':
      return { tone: 'danger', label: t('task.status.failed') };
    case 'cancelled':
      return { tone: 'muted', label: t('task.status.cancelled') };
    case 'done':
      if (task.merged || pr?.stage === 'merged') return { tone: 'ok', label: t('chatCard.task.merged') };
      // Без конвейера (или без ветки) «готово» и есть конец пути.
      return { tone: taskClosed(task, autoPipeline) ? 'ok' : 'accent', label: t('task.status.done') };
    default:
      return { tone: 'muted', label: t(`task.status.${task.status}`) };
  }
}

/** Куда смотрит точка у строки задачи внутри фичи — те же цвета, что у счётчиков доски. */
function taskDot(task: TaskView, autoPipeline: boolean): 'run' | 'wait' | 'fail' | 'done' | 'drop' {
  if (task.status === 'failed') return 'fail';
  if (task.status === 'cancelled') return 'drop';
  if (taskClosed(task, autoPipeline)) return 'done';
  if (task.status === 'planned' || task.status === 'backlog' || task.status === 'blocked') return 'wait';
  return 'run';
}

/**
 * Карточка — кнопка целиком, но внутри у неё свои кнопки (важность, шеврон,
 * варианты ответа). Вложенные button недопустимы, поэтому снаружи div с ролью.
 */
const asButton = (onOpen: () => void) => ({
  role: 'button' as const,
  tabIndex: 0,
  onClick: onOpen,
  onKeyDown: (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
  },
});

/** Шеврон «развернуть»: только отображение, состояние задачи он не трогает. */
function Chevron({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      className={`cc-chevron${open ? ' open' : ''}`}
      aria-expanded={open}
      title={t(open ? 'chatCard.collapse' : 'chatCard.expand')}
      onClick={(e: MouseEvent) => { e.stopPropagation(); onToggle(); }}
    >▾</button>
  );
}

/** Сущности на доске больше нет (стёрли офис, удалили задачу) — остаётся запасная строка. */
function Missing({ id, entry }: { id: string; entry?: ChatEntry }) {
  // Внутри обёртки запасной строки нет: она про всё сообщение, а не про эту карточку.
  return (
    <div className="chat-card cc-missing">
      {entry && <div>{entry.text}</div>}
      <div className="muted small">{t('chatCard.missing', { id })}</div>
    </div>
  );
}

/**
 * Карточка задачи (§1). Клик открывает дровер — там же, где его открывает
 * доска; решения (влить, остановить, снять) остаются в дровере намеренно.
 * `bare` — карточка внутри обёртки группы: рамка у обёртки, тут только линия.
 */
export function TaskCard({ id, entry, bare }: { id: string; entry: ChatEntry; bare?: boolean }) {
  const task = useStore((s) => s.tasks[id]) as TaskView | undefined;
  const pr = useStore((s) => s.prs[id]);
  const epic = useStore((s) => (task?.epicId ? s.epics[task.epicId] : undefined));
  const tasks = useStore((s) => s.tasks);
  const autoPipeline = useStore((s) => s.settings.autoPipeline);
  const openTask = useStore((s) => s.openTaskCard);
  const [open, setOpen] = useState(false);
  if (!task) return <Missing id={id} entry={bare ? undefined : entry} />;

  const state = taskState(task, pr, autoPipeline);
  const done = task.criteria.filter((c) => c.done).length;
  // «Ждёт» — только незакрытые зависимости: закрытая уже ничего не держит.
  const waits = task.status === 'planned' || task.status === 'blocked'
    ? task.dependsOn.filter((d) => !(tasks[d] && taskClosed(tasks[d], autoPipeline)))
    : [];
  // Обычная важность чипа не получает (как на доске), но щелчком её всё равно
  // можно поднять: чип проступает при наведении, в конце строки, чтобы не
  // сдвигать остальное под курсором.
  const prio = <PriorityChip task={task} />;
  // Шеврон только там, где ему есть что раскрыть: иначе щелчок по нему ничего не меняет.
  const more = !!epic || waits.length > 0;

  return (
    <div
      className={`chat-card cc-task tone-${state.tone}${bare ? ' bare' : ''}${open ? ' open' : ''}`}
      title={t('chatCard.openTask')}
      {...asButton(() => openTask(task.id))}
    >
      <div className="cc-head">
        <span className="cc-id">{task.id}</span>
        <span className="cc-title">{task.title}</span>
        {more && <Chevron open={open} onToggle={() => setOpen(!open)} />}
      </div>
      <div className="cc-meta">
        {task.priority !== 'normal' && prio}
        <span className={`chip cc-status ${state.tone}`}>{state.label}</span>
        {pr && pr.stage !== 'merged' && (
          <span className={`chip merge-chip ${prStageClass(pr.stage)}`} title={pr.note}>{prStageLabel(pr.stage)}</span>
        )}
        {task.assigneeId && <AgentTag id={task.assigneeId} className="muted" />}
        {task.criteria.length > 0 && (
          <span className="muted">{t('plan.progress', { done, total: task.criteria.length })}</span>
        )}
        {task.priority === 'normal' && <span className="cc-prio-normal">{prio}</span>}
      </div>
      {open && more && (
        <div className="cc-more">
          {epic && <span className="chip">{epic.id} · {epic.title}</span>}
          {waits.length > 0 && <span className="muted">{t('plan.waits', { deps: waits.join(', ') })}</span>}
        </div>
      )}
    </div>
  );
}

/** Сколько задач фичи показывать строками; дальше — «и ещё N» (§2). */
const EPIC_ROWS = 4;

/** Тон чипа статуса фичи — тот же ряд, что у задачи. */
const epicTone = (epic: EpicView): Tone =>
  (epic.status === 'active' ? 'accent' : epic.status === 'done' ? 'ok' : 'muted');

/**
 * Карточка фичи (§2). Заголовок и цель ведут на доску, отфильтрованную по
 * фиче; «Поехали» — то же действие, что на доске. Снятие фичи сюда не вынесено:
 * ему нужно подтверждение и полноразмерный экран.
 */
export function EpicCard({ id, entry, bare }: { id: string; entry: ChatEntry; bare?: boolean }) {
  const epic = useStore((s) => s.epics[id]) as EpicView | undefined;
  const tasks = useStore((s) => s.tasks);
  const autoPipeline = useStore((s) => s.settings.autoPipeline);
  const openTask = useStore((s) => s.openTaskCard);
  const showOnBoard = useStore((s) => s.showEpicOnBoard);
  if (!epic) return <Missing id={id} entry={bare ? undefined : entry} />;

  const mine = Object.values(tasks).filter((x) => x.epicId === epic.id).sort((a, b) => a.createdAt - b.createdAt);
  const done = mine.filter((x) => taskClosed(x, autoPipeline)).length;
  const spent = mine.reduce((sum, x) => sum + x.usage.costUsd, 0);
  const money = spent > 0 ? `$${spent.toFixed(2)}` : null;
  const awaiting = epic.status === 'planned' && !epic.approved;
  const goBoard = () => showOnBoard(epic.id);

  return (
    <div className={`chat-card cc-epic ${epic.status}${awaiting ? ' awaiting' : ''}${bare ? ' bare' : ''}`}>
      <div className="cc-head">
        <button className="cc-pick" onClick={goBoard} title={t('chatCard.openEpic')}>
          <span className="cc-id">{epic.id}</span>
          <span className="cc-title">{epic.title}</span>
        </button>
        <span className={`chip cc-status ${epicTone(epic)}`}>{t(`plan.status.${epic.status}`)}</span>
      </div>
      {epic.status === 'done' ? (
        <div className="cc-meta">
          <span className="muted">
            {t('chatCard.epic.closed', { done, total: mine.length })}{money ? ` · ${money}` : ''}
          </span>
        </div>
      ) : epic.status !== 'cancelled' && (
        <>
          {epic.goal && <div className="cc-goal" onClick={goBoard}>{epic.goal}</div>}
          <div className="cc-meta">
            <span className="muted">{t('plan.progress', { done, total: mine.length })}</span>
            {money && <span className="muted">{money}</span>}
            {awaiting && <span className="muted">{t('plan.awaiting')}</span>}
            {epic.status === 'planned' && epic.approved && <span className="muted">{t('plan.queued')}</span>}
          </div>
          {epic.status === 'active' && mine.length > 0 && (
            <div className="cc-rows">
              {mine.slice(0, EPIC_ROWS).map((x) => (
                <button key={x.id} className="cc-row" onClick={() => openTask(x.id)} title={t('chatCard.openTask')}>
                  <i className={`cc-dot ${taskDot(x, autoPipeline)}`} />
                  <span className="cc-id">{x.id}</span>
                  <span className="cc-row-title">{x.title}</span>
                </button>
              ))}
              {mine.length > EPIC_ROWS && (
                <span className="muted small">{t('chatCard.epic.more', { n: mine.length - EPIC_ROWS })}</span>
              )}
            </div>
          )}
          {awaiting && (
            <div className="cc-actions">
              <button className="merge" onClick={() => approveEpic(epic.id)}>{t('plan.approve')}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Карточка вопроса владельцу (§3). Ответ вариантом или своими словами —
 * та же команда `answer_question`, что в «Жизни офиса»; правка, объединение и
 * удаление остаются там же — это модерация, не ответ.
 */
export function QuestionCard({ id, entry }: { id: string; entry: ChatEntry }) {
  const q = useStore((s) => s.questions.find((x) => x.id === id));
  const openTask = useStore((s) => s.openTaskCard);
  const asked = useInstanceName(q?.from ?? '');
  const [own, setOwn] = useState(false);
  const [answer, setAnswer] = useState('');
  // Вопрос закрывается следующим состоянием от сервера; до него кнопки
  // держим погашенными, иначе второй клик отправил бы второй ответ.
  const [sending, setSending] = useState(false);
  // Закрытый вопрос лежит в ленте свёрнутым: ответ важнее формулировки,
  // а длинный текст отвеченного вопроса только растягивал бы переписку.
  const [open, setOpen] = useState(false);
  if (!q) return <Missing id={id} entry={entry} />;

  const taskId = q.taskId;
  const waiting = isOpenQuestion(q);
  const state = q.answeredAt ? 'answered' : q.dismissedAt ? 'dismissed' : waiting ? 'waiting' : 'merged';
  const folded = !waiting && !open;
  const who = isOfficeSender(q.from) ? t('common.office') : asked;
  const options = q.options ?? [];
  const send = (text: string) => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    answerQuestion(q.id, value);
    setAnswer('');
  };
  // Вариант с «…» на конце — не ответ, а заготовка: к нему нужно уточнение.
  const pick = (opt: string) => {
    if (!opt.endsWith('…')) return send(opt);
    setOwn(true);
    setAnswer(`${opt.slice(0, -1).trim()}: `);
  };
  const badge: Record<typeof state, string> = {
    waiting: t('chatCard.q.waiting'),
    answered: t('chatCard.q.answered'),
    dismissed: t('chatCard.q.dismissed'),
    merged: t('chatCard.q.merged', { id: q.mergedInto ?? '' }),
  };
  let reply: ReactNode = null;
  if (waiting && (own || options.length === 0)) {
    reply = (
      <div className="cc-actions">
        <input value={answer} placeholder={t('life.questions.answerPlaceholder')}
          autoFocus={own} disabled={sending}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(answer); }} />
        <button className="allow" disabled={sending || !answer.trim()} onClick={() => send(answer)}>
          {t('life.questions.answer')}
        </button>
      </div>
    );
  } else if (waiting) {
    reply = (
      <>
        <div className="cc-options">
          {options.map((opt, i) => (
            <button key={`${i}:${opt}`} className="mini" disabled={sending} onClick={() => pick(opt)}>{opt}</button>
          ))}
        </div>
        <button className="cc-own" disabled={sending} onClick={() => setOwn(true)}>{t('chatCard.q.own')}</button>
      </>
    );
  }

  return (
    <div className={`chat-card cc-question ${state}${folded ? ' folded' : ''}`}>
      <div className="cc-head">
        <span className={`chip cc-badge ${state}`}>{badge[state]}</span>
        <span className="cc-q-src muted small">
          {who} · {taskId ? (
            <>
              {t('chatCard.q.about')}{' '}
              <button className="ev-task" onClick={() => openTask(taskId)} title={t('chatCard.openTask')}>
                {taskId}
              </button>
            </>
          ) : t('chatCard.q.title')} · {clock(q.askedAt)}
        </span>
        {!waiting && <Chevron open={open} onToggle={() => setOpen(!open)} />}
      </div>
      {/* Свёрнутый вопрос — одна строка с многоточием, там разметке не место;
          развёрнутый пишет агент Markdown-ом — так и показываем. */}
      <div className="cc-text" title={folded ? q.text : undefined}>
        {folded ? q.text : <Markdown source={q.text} compact />}
      </div>
      {!folded && q.assumption && (
        <div className="cc-assumed muted small">
          {t(q.answeredAt ? 'chatCard.q.assumedWas' : 'chatCard.q.assumed', { text: q.assumption })}
        </div>
      )}
      {q.answeredAt && <div className="cc-answer">{q.answer}</div>}
      {reply}
    </div>
  );
}

/**
 * Карточка события конвейера (§4): почти строка — точка, ссылка на задачу,
 * текст. Действий нет намеренно: «встал» решается в дровере, где есть дифф
 * и настоящие кнопки. Событие — снимок момента, поэтому база и причина
 * берутся из ссылки и PR, а не из текущего статуса задачи.
 */
export function EventCard({ refTo, entry }: { refTo: ChatTaskEventRef; entry: ChatEntry }) {
  const task = useStore((s) => s.tasks[refTo.taskId]) as TaskView | undefined;
  const pr = useStore((s) => s.prs[refTo.taskId]);
  const openTask = useStore((s) => s.openTaskCard);
  if (!task) return <Missing id={refTo.taskId} entry={entry} />;

  const merged = refTo.event === 'merged';
  const link = (
    <span className="ev-task">
      {task.id}{merged && <> {t('chatCard.event.title', { title: task.title })}</>}
    </span>
  );
  return (
    <div
      className={`chat-card cc-event ${refTo.event}`}
      title={t('chatCard.openTask')}
      {...asButton(() => openTask(task.id))}
    >
      <div className="cc-head">
        <i className={`cc-dot ${merged ? 'done' : 'fail'}`} />
        <span className="cc-event-text">
          {merged ? (
            <>{link} {t('chatCard.event.merged', { base: pr?.base || task.baseBranch || 'main' })}</>
          ) : (
            <>{link}: {t('chatCard.event.stuck')}</>
          )}
        </span>
      </div>
      {!merged && refTo.why && <div className="cc-event-why">{refTo.why}</div>}
    </div>
  );
}

/** Карточка по ссылке сообщения. План из нескольких фич — обёрткой (§5). */
export function RefCard({ refTo, entry }: { refTo: ChatRef; entry: ChatEntry }) {
  switch (refTo.kind) {
    case 'task': return <TaskCard id={refTo.id} entry={entry} />;
    case 'epic': return <EpicCard id={refTo.id} entry={entry} />;
    case 'question': return <QuestionCard id={refTo.id} entry={entry} />;
    case 'event': return <EventCard refTo={refTo} entry={entry} />;
    case 'plan':
      return (
        <CardGroup title={t('chatCard.group.plan', { n: refTo.epicIds.length })}>
          {refTo.epicIds.map((id) => <EpicCard key={id} id={id} entry={entry} bare />)}
        </CardGroup>
      );
  }
}

/** С какого числа карточек обёртка сворачивается (§5): короче — и так видно всё. */
const GROUP_FOLD = 5;
/** Сколько карточек видно у свёрнутой обёртки. */
const GROUP_PEEK = 3;

/**
 * Обёртка карточек одного ответа менеджера: одна рамка на весь шаг, а не
 * россыпь блоков по ленте. Внутри карточки без своих рамок, через линию.
 */
export function CardGroup({ title, children }: { title: string; children: ReactNode[] }) {
  const [all, setAll] = useState(false);
  const fold = children.length >= GROUP_FOLD;
  const shown = fold && !all ? children.slice(0, GROUP_PEEK) : children;
  return (
    <div className="chat-card cc-group">
      <div className="cc-group-head">
        <span>{title}</span>
        {fold && (
          <button className="cc-own" onClick={() => setAll(!all)}>
            {all ? t('chatCard.group.collapse') : t('chatCard.group.showAll', { n: children.length })}
          </button>
        )}
      </div>
      {shown}
    </div>
  );
}

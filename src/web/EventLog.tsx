import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { LogEntry } from '../shared/types';
import { useStore } from './store';
import { t, type UiKey } from './i18n';
import { Avatar, NO_ROLE_COLOR } from './Avatar';
import { Icon } from './icons';
import { displayInstance, roleOfInstance } from './instanceName';
import { dayKey, formatClock, formatDayLabel, formatFullDateTime, hasTime } from './dates';

/**
 * Тип события для метки и фильтра. В контракте у записи лога только
 * `kind` (инструмент, текст, система, ошибка) — этого мало, чтобы отличить
 * слияние от найма. Остальное добирается по тексту записи: он приходит из
 * словарей сервера на языке офиса, поэтому признаки — на обоих языках.
 * Промах классификатора стоит только цвета метки: запись всё равно видна.
 */
export type EventType = 'task' | 'review' | 'question' | 'error' | 'chat' | 'tool' | 'ritual' | 'system';

export const EVENT_TYPES: readonly EventType[] = ['task', 'review', 'question', 'error', 'chat', 'tool', 'ritual', 'system'];

const TYPE_LABEL: Record<EventType, UiKey> = {
  task: 'log.type.task',
  review: 'log.type.review',
  question: 'log.type.question',
  error: 'log.type.error',
  chat: 'log.type.chat',
  tool: 'log.type.tool',
  ritual: 'log.type.ritual',
  system: 'log.type.system',
};

const ERROR_RE = /провал|сорвал|не удалось|не смог|ошибк|упал|конфликт|\bfail|error|could not|crash|conflict|broke off/i;
const QUESTION_RE = /вопрос|question|\bQ-\d+/i;
const RITUAL_RE = /ритуал|ritual/i;
const REVIEW_RE = /ревью|review|слия|слит|влит|влил|провер(ки|ка)|пулл-реквест|pull request|\bPR\b|исход|outcome|конвейер|pipeline|merge|checks?\b/i;
const TASK_RE = /\bT-\d+|задач|\btask/i;
// Инструменты офиса, которые по смыслу — не «вызвал инструмент», а шаг процесса.
const REVIEW_TOOL_RE = /approve_pr|request_changes|merge/i;
const QUESTION_TOOL_RE = /ask_owner|ask_colleague/i;

export function eventTypeOf(l: LogEntry): EventType {
  if (l.kind === 'error') return 'error';
  if (l.kind === 'text') return 'chat';
  // Имя инструмента — до двоеточия; в аргументах может быть что угодно.
  const tool = l.kind === 'tool' ? l.text.split(':')[0] : l.autoApproved ? l.text : '';
  if (tool) {
    if (REVIEW_TOOL_RE.test(tool)) return 'review';
    if (QUESTION_TOOL_RE.test(tool)) return 'question';
    return 'tool';
  }
  const text = l.text;
  if (ERROR_RE.test(text)) return 'error';
  // Ритуал раньше вопроса: в его итоге есть «вопросов N».
  if (RITUAL_RE.test(text)) return 'ritual';
  if (QUESTION_RE.test(text)) return 'question';
  if (REVIEW_RE.test(text)) return 'review';
  if (TASK_RE.test(text)) return 'task';
  return 'system';
}

/** Значение фильтра «кто» для записей без сотрудника — событий самого офиса. */
const OFFICE = '__office__';
const ALL = '';

/**
 * Лог событий офиса: фильтр сверху, таблица «время | кто | тип | текст».
 * Фильтр живёт в компоненте, серверу он не нужен. Выбранный в комнате
 * сотрудник, как и раньше, сразу сужает лог до себя — но фильтр можно
 * сбросить, не снимая выделения.
 */
export function EventLog() {
  const log = useStore((s) => s.log);
  const selected = useStore((s) => s.selected);
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  const [who, setWho] = useState<string>(selected ?? ALL);
  const [type, setType] = useState<EventType | typeof ALL>(ALL);
  useEffect(() => { if (selected) setWho(selected); }, [selected]);

  const typed = useMemo(() => log.map((entry) => ({ entry, type: eventTypeOf(entry) })), [log]);

  // В списке — и те, кто сейчас в офисе, и те, кто уже ушёл, но остался в логе.
  const people = useMemo(() => {
    const ids = new Set(Object.keys(instances));
    for (const l of log) if (l.agentId) ids.add(l.agentId);
    return [...ids]
      .map((id) => ({ id, name: displayInstance(id, instances, roles) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [log, instances, roles]);

  const rows = typed.filter(({ entry, type: tp }) =>
    (who === ALL || (who === OFFICE ? !entry.agentId : entry.agentId === who))
    && (type === ALL || tp === type));
  const filtered = who !== ALL || type !== ALL;

  return (
    <div className="ev-log">
      <div className="ev-filters">
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label={t('log.filter.who')}>
          <option value={ALL}>{t('log.filter.whoAll')}</option>
          <option value={OFFICE}>{t('log.who.office')}</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value as EventType | typeof ALL)} aria-label={t('log.filter.type')}>
          <option value={ALL}>{t('log.filter.typeAll')}</option>
          {EVENT_TYPES.map((tp) => <option key={tp} value={tp}>{t(TYPE_LABEL[tp])}</option>)}
        </select>
        {filtered && (
          <button className="mini ghost" onClick={() => { setWho(ALL); setType(ALL); }}>{t('log.filter.reset')}</button>
        )}
        <span className="ev-count muted small">{t('log.count', { n: rows.length })}</span>
      </div>
      <EventTable rows={rows} empty={filtered ? t('log.emptyFiltered') : t('log.empty')} />
    </div>
  );
}

/**
 * Сама таблица — отдельно от фильтра: её же показывает стенд кита на
 * выдуманных записях.
 */
export function EventTable({ rows, empty }: {
  rows: { entry: LogEntry; type: EventType }[];
  empty: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Новые записи внизу: пока владелец у нижнего края, лента едет за ними,
  // а когда он отлистал назад читать — не дёргаем.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  let lastDay = '';
  return (
    <div className="ev-table" role="table" ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}>
      <div className="ev-row ev-head" role="row">
        <span role="columnheader">{t('log.col.time')}</span>
        <span role="columnheader">{t('log.col.who')}</span>
        <span role="columnheader">{t('log.col.type')}</span>
        <span role="columnheader">{t('log.col.text')}</span>
      </div>
      {rows.length === 0 && <p className="ev-empty muted small">{empty}</p>}
      {rows.map(({ entry, type }, i) => {
        const day = hasTime(entry.at) ? dayKey(entry.at) : lastDay;
        const sep = day !== lastDay && hasTime(entry.at);
        lastDay = day;
        return (
          <Fragment key={entry.id}>
            {sep && <div className="chat-date-sep ev-day" role="separator">{formatDayLabel(entry.at)}</div>}
            <EventRow entry={entry} type={type} odd={i % 2 === 1} />
          </Fragment>
        );
      })}
    </div>
  );
}

const EventRow = memo(function EventRow({ entry, type, odd }: { entry: LogEntry; type: EventType; odd: boolean }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  // Раскрывать есть что, только если текст правда не влез в две строки.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [entry.text, open]);

  const cls = ['ev-row', odd && 'odd', type === 'error' && 'is-error', long && 'can-open', open && 'open']
    .filter(Boolean).join(' ');
  return (
    <div className={cls} role="row"
      onClick={long || open ? () => setOpen((o) => !o) : undefined}
      title={long && !open ? t('log.expand') : undefined}>
      {hasTime(entry.at)
        ? <span className="ev-time" title={formatFullDateTime(entry.at)}>{formatClock(entry.at)}</span>
        : <span className="ev-time" />}
      <EventWho id={entry.agentId} />
      <span className="ev-type" data-type={type} title={t(TYPE_LABEL[type])}>
        <i aria-hidden />
        <span>{t(TYPE_LABEL[type])}</span>
      </span>
      <span className="ev-text" ref={textRef}>
        {entry.autoApproved && (
          <span className="auto-tag" title={t('log.autoHint')}>{t('log.auto')}</span>
        )}
        <TaskLinks text={entry.text} />
      </span>
    </div>
  );
});

/** Кто: аватарка и подпись в цвете роли; у событий офиса — нейтральный значок. */
function EventWho({ id }: { id: string | null }) {
  const roleId = useStore((s) => (id ? s.instances[id]?.roleId : undefined)) ?? (id ? roleOfInstance(id) : '');
  const color = useStore((s) => s.roles.find((r) => r.id === roleId)?.color) || NO_ROLE_COLOR;
  const name = useStore((s) => (id ? displayInstance(id, s.instances, s.roles) : ''));
  if (!id) {
    return (
      <span className="ev-who office" title={t('log.who.office')}>
        <span className="ev-sys" aria-hidden><Icon name="building" size={11} /></span>
        <span className="ev-name">{t('log.who.office')}</span>
      </span>
    );
  }
  return (
    <span className="ev-who" style={{ '--ev-role': color } as CSSProperties} title={name}>
      <Avatar roleId={roleId} instanceId={id} size="xs" />
      <span className="ev-name">{name}</span>
    </span>
  );
}

/** Упоминания задач в тексте — ссылки на карточку задачи, если она есть на доске. */
function TaskLinks({ text }: { text: string }) {
  const tasks = useStore((s) => s.tasks);
  const openTaskCard = useStore((s) => s.openTaskCard);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\bT-\d+\b/g)) {
    const id = m[0];
    const at = m.index ?? 0;
    if (!tasks[id]) continue;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <button key={at} type="button" className="ev-task" title={t('log.openTask', { id })}
        onClick={(e) => { e.stopPropagation(); openTaskCard(id); }}>
        {id}
      </button>,
    );
    last = at + id.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

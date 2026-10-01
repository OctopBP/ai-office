import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PmChat, TaskView } from '../../shared/types';
import { pmChatMeta, pmChatSections, useStore } from '../store';
import { t } from '../i18n';
import { Avatar } from '../Avatar';
import { formatFullDateTime, formatListTime } from '../dates';
import { focusComposer } from './Composer';

/**
 * Список чатов с менеджером — левая колонка вида «Чат» (docs/design/T-125,
 * экраны 01–04). Здесь только отрисовка и локальное состояние самого списка:
 * поиск, правка названия, меню строки. Что открыто и куда уходят команды —
 * в сторе.
 */
export function PmChatList() {
  const chats = useStore((s) => s.pmChats);
  const current = useStore((s) => s.pmChatId);
  const thread = useStore((s) => s.thread);
  const seen = useStore((s) => s.pmChatSeen);
  const tasks = useStore((s) => s.tasks);
  const questions = useStore((s) => s.questions);
  const connected = useStore((s) => s.connected);
  const create = useStore((s) => s.createPmChat);
  const [query, setQuery] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);

  const { live, archived } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const { live, archived } = pmChatSections(chats);
    const hit = (c: PmChat) => !q || c.title.toLowerCase().includes(q);
    return { live: live.filter(hit), archived: archived.filter(hit) };
  }, [chats, query]);

  // Открытый чат лежит в архиве — секцию раскрываем, иначе выделения не видно.
  const currentArchived = current !== null && chats[current]?.archived === true;
  const showArchive = archiveOpen || currentArchived || (query.trim() !== '' && archived.length > 0);

  const row = (c: PmChat) => (
    <PmChatRow
      key={c.id} chat={c}
      active={thread === 'pm#1' && c.id === current}
      unread={!c.archived && c.id !== current && c.lastActivityAt > (seen[c.id] ?? c.lastActivityAt)}
      tasks={tasks} questions={questions}
    />
  );

  return (
    <aside className="pm-chats float">
      <div className="pm-chats-head">
        <h3>{t('pmChats.title')}</h3>
        <button
          className="sq pm-chats-add" title={t('pmChats.new')} aria-label={t('pmChats.new')}
          disabled={!connected}
          onClick={() => { create(); focusComposer(); }}
        >+</button>
      </div>
      <input
        className="pm-chats-search" type="search" value={query}
        placeholder={t('pmChats.search')}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <div className="pm-chats-list">
        {live.map(row)}
        {live.length === 0 && (
          <p className="small pm-chats-none">
            {query.trim() ? t('pmChats.notFound') : t('pmChats.none')}
          </p>
        )}
      </div>
      {(archived.length > 0 || currentArchived) && (
        <div className={`pm-chats-archive${showArchive ? ' open' : ''}`}>
          <button className="pm-chats-archive-toggle" onClick={() => setArchiveOpen(!showArchive)}>
            <span className="pm-chats-caret">▸</span>
            {t('pmChats.archive', { n: archived.length })}
          </button>
          {showArchive && <div className="pm-chats-list">{archived.map(row)}</div>}
        </div>
      )}
    </aside>
  );
}

function PmChatRow({ chat, active, unread, tasks, questions }: {
  chat: PmChat;
  active: boolean;
  unread: boolean;
  tasks: Parameters<typeof pmChatMeta>[1];
  questions: Parameters<typeof pmChatMeta>[2];
}) {
  const open = useStore((s) => s.openPmChat);
  const rename = useStore((s) => s.renamePmChat);
  const archive = useStore((s) => s.archivePmChat);
  const empty = useStore((s) => !s.chat.some((e) => e.chatId === chat.id));
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const meta = useMemo(() => pmChatMeta(chat.id, tasks, questions), [chat.id, tasks, questions]);

  // Меню строки закрывается кликом мимо него.
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const startEdit = () => { setTitle(chat.title); setEditing(true); setMenu(false); };
  const commit = () => {
    setEditing(false);
    if (title.trim() && title.trim() !== chat.title) rename(chat.id, title);
  };

  const asking = useMemo(() => new Set(questions
    .filter((q) => q.taskId !== null && q.answer === null && q.dismissedAt === null && !q.mergedInto)
    .map((q) => q.taskId as string)), [questions]);

  return (
    <div
      className={`pm-chat-row${active ? ' on' : ''}${chat.archived ? ' archived' : ''}`}
      onClick={() => { if (!editing) open(chat.id); }}
    >
      <Avatar roleId="pm" instanceId="pm#1" size="sm" />
      <div className="pm-chat-body">
        <div className="pm-chat-line">
          {editing ? (
            <input
              className="pm-chat-rename" value={title} autoFocus maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(false);
                e.stopPropagation();
              }}
            />
          ) : (
            <span className="pm-chat-title" onDoubleClick={(e) => { e.stopPropagation(); startEdit(); }}>
              {chat.title}
            </span>
          )}
          {chat.main && (
            <span className="pm-chat-pin" title={t('pmChats.pinned')} aria-label={t('pmChats.pinned')}>
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M9.8 1.5a.75.75 0 0 1 1.06 0l3.64 3.64a.75.75 0 0 1 0 1.06l-.9.9a.75.75 0 0 1-.8.17l-1.52 1.52.3 2.4a.75.75 0 0 1-.21.62l-.8.8a.75.75 0 0 1-1.06 0L7.4 10.5l-3.62 3.62a.6.6 0 0 1-.85-.85L6.55 9.65 4.44 7.54a.75.75 0 0 1 0-1.06l.8-.8a.75.75 0 0 1 .62-.21l2.4.3 1.52-1.52a.75.75 0 0 1 .17-.8l.9-.9z" />
              </svg>
            </span>
          )}
          <span className="pm-chat-time" title={formatFullDateTime(chat.lastActivityAt)}>
            {formatListTime(chat.lastActivityAt)}
          </span>
        </div>
        <div className="pm-chat-meta">
          {meta.waiting && <span className="pm-chat-waiting">{t('pmChats.waiting')}</span>}
          {meta.tasks.length > 0
            ? <TaskNumbers tasks={meta.tasks} asking={asking} />
            : <span className="pm-chat-linked">{empty ? t('pmChats.noMessages') : t('pmChats.noTasks')}</span>}
        </div>
      </div>
      {unread && <i className="pm-chat-dot" aria-label={t('pmChats.unread')} />}
      <div className="pm-chat-actions" ref={menuRef}>
        <button
          className="pm-chat-more" title={t('pmChats.menu')} aria-label={t('pmChats.menu')}
          onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}
        >⋯</button>
        {menu && (
          <div className="pm-chat-menu float" onClick={(e) => e.stopPropagation()}>
            <button onClick={startEdit}>{t('pmChats.rename')}</button>
            <button onClick={() => { setMenu(false); archive(chat.id, !chat.archived); }}>
              {chat.archived ? t('pmChats.unarchive') : t('pmChats.toArchive')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Как номер задачи выглядит в строке чата. Порядок вида — он же порядок
 * показа: при нехватке места в строке остаются проблемные и идущие, а
 * закрытые первыми уходят в «+N».
 */
const TASK_LOOKS = ['problem', 'active', 'idle', 'done', 'cancelled'] as const;
type TaskLook = typeof TASK_LOOKS[number];

function taskLook(tk: TaskView, asking: Set<string>): TaskLook {
  // Открытый вопрос владельцу — та же беда, что и провал: без человека задача не сдвинется.
  if (tk.status === 'failed' || tk.status === 'blocked' || asking.has(tk.id)) return 'problem';
  if (tk.status === 'in_progress' || tk.status === 'review') return 'active';
  if (tk.status === 'done') return 'done';
  if (tk.status === 'cancelled') return 'cancelled';
  return 'idle';
}

function taskHint(tk: TaskView, asking: Set<string>): string {
  const status = asking.has(tk.id) && tk.status !== 'failed' && tk.status !== 'blocked'
    ? t('pmChats.task.asking')
    : tk.status === 'done' && tk.merged ? t('pmChats.task.merged') : t(`task.status.${tk.status}`);
  return `${tk.id} · ${tk.title} · ${status}`;
}

/**
 * Номера привязанных задач, окрашенные по статусу. Сколько влезает в строку,
 * меряем по невидимой копии всех номеров: у скрытых номеров ширины уже не
 * узнать, а подбирать число вслепую — значит то резать лишнее, то вылезать.
 */
function TaskNumbers({ tasks, asking }: { tasks: TaskView[]; asking: Set<string> }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const sorted = useMemo(() => tasks
    .map((tk) => ({ tk, look: taskLook(tk, asking) }))
    // sort устойчив: внутри вида остаётся порядок стора — свежие первыми.
    .sort((a, b) => TASK_LOOKS.indexOf(a.look) - TASK_LOOKS.indexOf(b.look)), [tasks, asking]);
  const [fit, setFit] = useState(sorted.length);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure) return;
    const recount = () => {
      const chips = Array.from(measure.children) as HTMLElement[];
      const more = chips.pop();
      const gap = parseFloat(getComputedStyle(measure).columnGap) || 0;
      const room = box.clientWidth;
      const n = chips.length;
      let used = 0;
      let k = 0;
      while (k < n) {
        const next = used + (k > 0 ? gap : 0) + chips[k].offsetWidth;
        // Последний номер места под «+N» не требует.
        const tail = k + 1 < n ? gap + (more?.offsetWidth ?? 0) : 0;
        if (next + tail > room) break;
        used = next;
        k++;
      }
      // Хотя бы один номер показываем всегда — пусть и обрезанным.
      setFit(Math.max(1, k));
    };
    recount();
    const ro = new ResizeObserver(recount);
    ro.observe(box);
    return () => ro.disconnect();
  }, [sorted]);

  const chip = ({ tk, look }: { tk: TaskView; look: TaskLook }) => (
    <span key={tk.id} className={`pm-chat-task ${look}`} title={taskHint(tk, asking)}>{tk.id}</span>
  );
  const shown = sorted.slice(0, fit);
  const hidden = sorted.slice(fit);

  return (
    <span className="pm-chat-tasks" ref={boxRef}>
      {shown.map(chip)}
      {sorted.length === 1 && <span className="pm-chat-linked">{sorted[0].tk.title}</span>}
      {hidden.length > 0 && (
        <span className="pm-chat-task-more" title={hidden.map(({ tk }) => taskHint(tk, asking)).join('\n')}>
          +{hidden.length}
        </span>
      )}
      <span className="pm-chat-tasks-measure" ref={measureRef} aria-hidden="true">
        {sorted.map(chip)}
        <span className="pm-chat-task-more">+{sorted.length}</span>
      </span>
    </span>
  );
}

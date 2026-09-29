import { useEffect, useMemo, useRef, useState } from 'react';
import type { PmChat } from '../../shared/types';
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

  const linked = meta.tasks.length === 1
    ? `${meta.tasks[0].id} · ${meta.tasks[0].title}`
    : meta.tasks.length > 1
      ? meta.tasks.slice(0, 3).map((tk) => tk.id).join(', ') + (meta.tasks.length > 3 ? '…' : '')
      : empty ? t('pmChats.noMessages') : t('pmChats.noTasks');

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
          <span className="pm-chat-time" title={formatFullDateTime(chat.lastActivityAt)}>
            {formatListTime(chat.lastActivityAt)}
          </span>
        </div>
        <div className="pm-chat-meta">
          {meta.waiting && <span className="pm-chat-waiting">{t('pmChats.waiting')}</span>}
          <span className="pm-chat-linked">{linked}</span>
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

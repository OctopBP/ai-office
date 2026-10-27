import { useLayoutEffect, useRef, useState } from 'react';
import type { ChatAttachment, ChatEntry } from '../shared/types';
import { Icon } from './icons';
import { formatSize } from './result/api';
import { isOfficeSender, repliesOpen } from '../shared/types';
import { inPmChat, send, shownDraft, useStore } from './store';
import { t } from './i18n';
import { AgentTag } from './Avatar';
import { ChatHead } from './ChatPeer';
import { Markdown } from './Markdown';
import { mentionedTask } from './chat/filePaths';
import { CardGroup, RefCard, TaskCard } from './ChatCards';
import { hasTime, dayKey, formatDayLabel, formatClock, formatFullDateTime } from './dates';

/**
 * Лента чата: выбор собеседника, пояснение к треду и сообщения. Без рамки и
 * без поля ввода — их даёт тот, кто ленту показывает: панель поверх офиса
 * со своим композером или вид «Чат» новой оболочки, где поле ввода — общий
 * композер внизу экрана.
 */
export function ChatThread() {
  const chat = useStore((s) => s.chat);
  const thread = useStore((s) => s.thread);
  // Реплика, которую собеседник пишет прямо сейчас. Рисуется на месте будущего
  // ответа и исчезает, когда готовая реплика ложится в ленту.
  // У менеджера сессия на каждый чат, и черновик у каждой свой: берём тот,
  // что пишется в открытый чат, строго по его chatId (см. `shownDraft`).
  const pmChatId = useStore((s) => s.pmChatId);
  // Черновик нового чата: переписки у него ещё нет, лента пуста.
  const pmChatDraft = useStore((s) => s.pmChatDraft);
  const draft = useStore(shownDraft);
  const noChats = useStore((s) => Object.keys(s.pmChats).length === 0);
  const createPmChat = useStore((s) => s.createPmChat);
  const box = useRef<HTMLDivElement>(null);
  // Держится ли пользователь у низа ленты. Пока держится — лента едет за
  // новыми сообщениями; отпустил и читает старое — не трогаем.
  const atBottom = useRef(true);

  const shown = thread === 'pm#1'
    ? (pmChatDraft ? [] : chat.filter((m) => inPmChat(m, pmChatId)))
    : chat.filter((m) => m.thread === thread);
  const last = shown[shown.length - 1];
  const items = groupRefs(shown);
  const connected = useStore((s) => s.connected);

  const toBottom = (el: HTMLDivElement) => { el.scrollTop = el.scrollHeight; };

  // Открытие вкладки и смена треда: ставим ленту на последнее сообщение ДО
  // первой отрисовки. Плавный скролл после отрисовки был бы виден как
  // промотка ленты сверху вниз.
  useLayoutEffect(() => {
    atBottom.current = true;
    if (box.current) toBottom(box.current);
  }, [thread, pmChatId, pmChatDraft]);

  // Новое сообщение (и дописывание текста в последнее, пока менеджер отвечает
  // потоком) утаскивает ленту вниз, только если пользователь и так у низа.
  useLayoutEffect(() => {
    if (box.current && atBottom.current) toBottom(box.current);
  }, [shown.length, last?.text.length, draft?.id, draft?.text.length]);

  // Композер резиновый: вырос — область ленты стала ниже. Пользователя у низа
  // возвращаем к низу, иначе последнее сообщение уезжает за край.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (atBottom.current) toBottom(el); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // «У низа» с запасом в пару строк: попасть в scrollTop пиксель в пиксель
  // мышью нельзя, а дробные размеры дают остаток и при упоре в самый низ.
  const onScroll = () => {
    const el = box.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  return (
    <>
      <ChatHead locked={shown.length > 0 || !!draft} />

      {thread === 'meeting' && (
        <p className="small note">{t('chat.note.meeting')}</p>
      )}
      {thread !== 'pm#1' && thread !== 'meeting' && (
        <p className="small note">{t('chat.note.direct')}</p>
      )}

      <div className="chat" ref={box} onScroll={onScroll}>
        {thread === 'pm#1' && noChats && !pmChatDraft && shown.length === 0 && !draft && (
          <div className="pm-chats-empty">
            <div className="pm-chats-empty-icon">💬</div>
            <h3>{t('pmChats.empty.title')}</h3>
            <p className="small">{t('pmChats.empty.text')}</p>
            <button className="primary" onClick={createPmChat}>{t('pmChats.empty.start')}</button>
          </div>
        )}
        {shown.length === 0 && !draft && !(thread === 'pm#1' && noChats && !pmChatDraft) && (
          <p className="empty">
            {t(thread === 'pm#1' ? 'chat.empty.pm' : 'chat.empty')}
          </p>
        )}
        {items.map(({ m, group }, i) => {
          // Разделитель дня перед первым сообщением новых суток. Реплики без
          // времени (старые, до появления поля) день не считают и разделителя
          // не ставят — они просто идут подряд без даты.
          const prev = i > 0 ? items[i - 1].m : undefined;
          const showDaySep = hasTime(m.at) && (!prev || !hasTime(prev.at) || dayKey(prev.at) !== dayKey(m.at));
          return (
            <div key={m.id}>
              {showDaySep && (
                <div className="chat-date-sep"><span>{formatDayLabel(m.at)}</span></div>
              )}
              <div className={`msg ${m.from === 'user' ? 'from-user' : 'from-agent'}${m.ref ? ' msg-card' : ''}`}>
                <div className="msg-from">
                  <span className="msg-from-name">
                    {m.from === 'user'
                      ? t('chat.you')
                      : (isOfficeSender(m.from) ? t('common.office') : <AgentTag id={m.from} size="sm" />)}
                  </span>
                  {hasTime(m.at) && (
                    <span className="msg-time" title={formatFullDateTime(m.at)}>{formatClock(m.at)}</span>
                  )}
                </div>
                {group ? (
                  <CardGroup title={t('chatCard.group.tasks', { n: group.length })}>
                    {group.map((g) => g.ref?.kind === 'task' && <TaskCard key={g.id} id={g.ref.id} entry={g} bare />)}
                  </CardGroup>
                ) : m.ref ? <RefCard refTo={m.ref} entry={m} /> : <>
                  {(m.text.trim() || !m.attachments?.length) && <div className="msg-text"><Markdown source={m.text} compact files={{ task: mentionedTask(m.text) }} /></div>}
                  {m.attachments && m.attachments.length > 0 && <MsgAttachments list={m.attachments} />}
                </>}
                {thread === 'pm#1' && m === last && !draft && repliesOpen(m, chat) && (
                  <QuickReplies options={m.replies ?? []} disabled={!connected} />
                )}
              </div>
            </div>
          );
        })}
        {draft && (
          <div className="msg from-agent msg-draft">
            <div className="msg-from">
              {isOfficeSender(draft.from) ? t('common.office') : <AgentTag id={draft.from} size="sm" />}
            </div>
            {/* Пусто — собеседник ещё думает; есть текст — рисуем разметкой, как
                будет в готовой реплике (иначе на последнем слове она прыгнет),
                и ставим мерцающий курсор, чтобы было видно: реплика не дописана. */}
            {draft.text
              ? <div className="msg-text"><Markdown source={draft.text} compact files={{ task: mentionedTask(draft.text) }} /><i className="caret" /></div>
              : <div className="msg-text"><span className="typing">{t('chat.typing')}</span></div>}
          </div>
        )}
      </div>
    </>
  );
}

/** Вложения реплики владельца: картинки миниатюрой, прочие ссылкой с именем. */
function MsgAttachments({ list }: { list: ChatAttachment[] }) {
  return (
    <ul className="msg-files">
      {list.map((a) => (
        <li key={a.id}>
          <a href={a.url} target="_blank" rel="noreferrer" title={t('attach.open', { name: a.name })}
            className={a.mime.startsWith('image/') ? 'msg-file-img' : 'msg-file'}>
            {a.mime.startsWith('image/')
              ? <img src={a.url} alt={a.name} loading="lazy" />
              : <><Icon name="file" size={14} /><span className="msg-file-name">{a.name}</span><span className="msg-file-size">{formatSize(a.size)}</span></>}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Задачи, заведённые менеджером одним шагом, идут подряд отдельными
 * ссылками — в ленте они собираются под одну обёртку (§5 каталога карточек),
 * а не рассыпаются блоками. Одна задача обёртки не получает.
 */
function groupRefs(list: ChatEntry[]): { m: ChatEntry; group?: ChatEntry[] }[] {
  const out: { m: ChatEntry; group?: ChatEntry[] }[] = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    let j = i;
    while (j + 1 < list.length && list[j + 1].ref?.kind === 'task' && list[j + 1].from === m.from) j++;
    if (m.ref?.kind === 'task' && j > i) {
      out.push({ m, group: list.slice(i, j + 1) });
      i = j;
    } else out.push({ m });
  }
  return out;
}

/**
 * Кнопки быстрого ответа под репликой менеджера. Нажатие — обычная реплика
 * владельца; когда она ляжет в ленту, `repliesOpen` погасит ряд. До этого
 * кнопки заперты, чтобы двойной клик не отправил ответ дважды.
 */
function QuickReplies({ options, disabled }: { options: string[]; disabled: boolean }) {
  const [sent, setSent] = useState(false);
  return (
    <div className="oq-opts msg-replies" role="group" aria-label={t('chat.replies')}>
      {options.map((o) => (
        <button key={o} className="mini oq-opt" disabled={disabled || sent} title={o}
          onClick={() => { setSent(true); send(o); }}>{o}</button>
      ))}
    </div>
  );
}

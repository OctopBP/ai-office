import { useLayoutEffect, useRef } from 'react';
import type { ChatEntry } from '../shared/types';
import { isOfficeSender } from '../shared/types';
import { inPmChat, shownDraft, useStore } from './store';
import { t } from './i18n';
import { AgentTag } from './Avatar';
import { ChatPeer } from './ChatPeer';
import { Markdown } from './Markdown';
import { CardGroup, RefCard, TaskCard } from './ChatCards';
import { hasTime, dayKey, formatDayLabel, formatClock, formatFullDateTime } from './dates';

/**
 * Лента чата: вкладки тредов, пояснение к треду и сообщения. Без рамки и
 * без поля ввода — их даёт тот, кто ленту показывает: панель поверх офиса
 * со своим композером или вид «Чат» новой оболочки, где поле ввода — общий
 * композер внизу экрана.
 */
export function ChatThread() {
  const chat = useStore((s) => s.chat);
  const instances = useStore((s) => s.instances);
  const meeting = useStore((s) => s.meeting);
  const thread = useStore((s) => s.thread);
  const setThread = useStore((s) => s.setThread);
  // Реплика, которую собеседник пишет прямо сейчас. Рисуется на месте будущего
  // ответа и исчезает, когда готовая реплика ложится в ленту.
  // У менеджера сессия на каждый чат, и черновик у каждой свой: берём тот,
  // что пишется в открытый чат, строго по его chatId (см. `shownDraft`).
  const pmChatId = useStore((s) => s.pmChatId);
  const draft = useStore(shownDraft);
  const noChats = useStore((s) => Object.keys(s.pmChats).length === 0);
  const createPmChat = useStore((s) => s.createPmChat);
  const box = useRef<HTMLDivElement>(null);
  // Держится ли пользователь у низа ленты. Пока держится — лента едет за
  // новыми сообщениями; отпустил и читает старое — не трогаем.
  const atBottom = useRef(true);

  const shown = thread === 'pm#1'
    ? chat.filter((m) => inPmChat(m, pmChatId))
    : chat.filter((m) => m.thread === thread);
  const last = shown[shown.length - 1];
  const items = groupRefs(shown);

  const toBottom = (el: HTMLDivElement) => { el.scrollTop = el.scrollHeight; };

  // Открытие вкладки и смена треда: ставим ленту на последнее сообщение ДО
  // первой отрисовки. Плавный скролл после отрисовки был бы виден как
  // промотка ленты сверху вниз.
  useLayoutEffect(() => {
    atBottom.current = true;
    if (box.current) toBottom(box.current);
  }, [thread, pmChatId]);

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
      <div className="threads">
        <button className={`mini${thread === 'pm#1' ? ' on' : ''}`} onClick={() => setThread('pm#1')}>
          {t('chat.tab.pm')}
        </button>
        <button className={`mini${thread === 'meeting' ? ' on' : ''}`} onClick={() => setThread('meeting')}>
          {t('chat.tab.meeting')}{meeting?.status === 'running' ? ' •' : ''}
        </button>
        {Object.values(instances).filter((i) => i.roleId !== 'pm').map((i) => (
          <button key={i.id} className={`mini${thread === i.id ? ' on' : ''}`} onClick={() => setThread(i.id)}>
            <AgentTag id={i.id} />
          </button>
        ))}
      </div>

      <ChatPeer />

      {thread === 'meeting' && (
        <p className="small note">{t('chat.note.meeting')}</p>
      )}
      {thread !== 'pm#1' && thread !== 'meeting' && (
        <p className="small note">{t('chat.note.direct')}</p>
      )}

      <div className="chat" ref={box} onScroll={onScroll}>
        {thread === 'pm#1' && noChats && shown.length === 0 && !draft && (
          <div className="pm-chats-empty">
            <div className="pm-chats-empty-icon">💬</div>
            <h3>{t('pmChats.empty.title')}</h3>
            <p className="small">{t('pmChats.empty.text')}</p>
            <button className="primary" onClick={createPmChat}>{t('pmChats.empty.start')}</button>
          </div>
        )}
        {shown.length === 0 && !draft && !(thread === 'pm#1' && noChats) && (
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
                ) : m.ref ? <RefCard refTo={m.ref} entry={m} /> : <div className="msg-text"><Markdown source={m.text} compact /></div>}
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
              ? <div className="msg-text"><Markdown source={draft.text} compact /><i className="caret" /></div>
              : <div className="msg-text"><span className="typing">{t('chat.typing')}</span></div>}
          </div>
        )}
      </div>
    </>
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

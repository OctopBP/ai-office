import { useLayoutEffect, useRef } from 'react';
import { isOfficeSender } from '../shared/types';
import { useStore } from './store';
import { t, locale } from './i18n';
import { AgentTag } from './Avatar';
import { ChatPeer } from './ChatPeer';

// Старые реплики (до появления `at` в конкретном снимке состояния или из
// ручной правки state.json) могут прийти без времени — тогда просто не
// рисуем метку и не считаем их точкой разрыва дня.
const hasTime = (at: unknown): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0;

const startOfDay = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Ключ календарного дня — по нему решаем, вставлять ли разделитель дат. */
const dayKey = (at: number) => String(startOfDay(at));

/** «Сегодня» / «Вчера» / «12 мая» / «12 мая 2025» — язык и формат берутся из интерфейса. */
const formatDayLabel = (at: number): string => {
  const daysAgo = Math.round((startOfDay(Date.now()) - startOfDay(at)) / 86400000);
  if (daysAgo <= 0) return t('chat.date.today');
  if (daysAgo === 1) return t('chat.date.yesterday');
  const sameYear = new Date(at).getFullYear() === new Date().getFullYear();
  return new Date(at).toLocaleDateString(locale(), sameYear
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' });
};

const formatClock = (at: number): string =>
  new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

const formatFullDateTime = (at: number): string =>
  new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

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
  const draft = useStore((s) => s.drafts[thread]);
  const box = useRef<HTMLDivElement>(null);
  // Держится ли пользователь у низа ленты. Пока держится — лента едет за
  // новыми сообщениями; отпустил и читает старое — не трогаем.
  const atBottom = useRef(true);

  const shown = chat.filter((m) => m.thread === thread);
  const last = shown[shown.length - 1];

  const toBottom = (el: HTMLDivElement) => { el.scrollTop = el.scrollHeight; };

  // Открытие вкладки и смена треда: ставим ленту на последнее сообщение ДО
  // первой отрисовки. Плавный скролл после отрисовки был бы виден как
  // промотка ленты сверху вниз.
  useLayoutEffect(() => {
    atBottom.current = true;
    if (box.current) toBottom(box.current);
  }, [thread]);

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
        {shown.length === 0 && !draft && (
          <p className="empty">
            {t(thread === 'pm#1' ? 'chat.empty.pm' : 'chat.empty')}
          </p>
        )}
        {shown.map((m, i) => {
          // Разделитель дня перед первым сообщением новых суток. Реплики без
          // времени (старые, до появления поля) день не считают и разделителя
          // не ставят — они просто идут подряд без даты.
          const prev = shown[i - 1];
          const showDaySep = hasTime(m.at) && (!prev || !hasTime(prev.at) || dayKey(prev.at) !== dayKey(m.at));
          return (
            <div key={m.id}>
              {showDaySep && (
                <div className="chat-date-sep"><span>{formatDayLabel(m.at)}</span></div>
              )}
              <div className={`msg ${m.from === 'user' ? 'from-user' : 'from-agent'}`}>
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
                <div className="msg-text">{m.text}</div>
              </div>
            </div>
          );
        })}
        {draft && (
          <div className="msg from-agent msg-draft">
            <div className="msg-from">
              {isOfficeSender(draft.from) ? t('common.office') : <AgentTag id={draft.from} size="sm" />}
            </div>
            {/* Пусто — собеседник ещё думает; есть текст — показываем как есть
                и ставим мерцающий курсор, чтобы было видно: реплика не дописана. */}
            <div className="msg-text">
              {draft.text
                ? <>{draft.text}<i className="caret" /></>
                : <span className="typing">{t('chat.typing')}</span>}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

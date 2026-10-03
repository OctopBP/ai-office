import { useStore } from './store';
import { Avatar } from './Avatar';
import { useInstanceName } from './instanceName';
import { t } from './i18n';

/**
 * Собеседник текущего треда: лицо, имя и должность. Стоит над лентой в виде
 * «Чат» и, компактнее, над полем композера на экране офиса — кнопка
 * «Поговорить» в карточке агента переключает тред, и без шапки не видно,
 * кому сейчас уйдёт написанное. В «Переговорке» собеседника нет.
 */
export function ChatPeer({ compact = false }: { compact?: boolean }) {
  const peer = useStore((s) => (s.thread !== 'meeting' ? s.instances[s.thread] : undefined));
  const role = useStore((s) => s.roles.find((r) => r.id === peer?.roleId));
  const name = useInstanceName(peer?.id ?? '');
  // Название открытого чата с PM; у «Нового чата» без первой реплики — заглушка.
  const isDraft = useStore((s) => s.thread === 'pm#1' && s.pmChatDraft);
  const openTitle = useStore((s) => (s.thread === 'pm#1' && s.pmChatId ? s.pmChats[s.pmChatId]?.title : undefined));
  const chatTitle = isDraft ? t('pmChats.new') : openTitle;
  if (!peer) return null;
  const title = compact ? undefined : chatTitle;
  const who = (
    <>
      <Avatar roleId={peer.roleId} instanceId={peer.id} size={title ? 'xs' : compact ? 'md' : 'lg'} />
      <div className="chat-peer-text">
        <b>{name}</b>
        {/* Вторая строка — должность, и только когда она не повторяет первую:
            без своего имени сотрудник и так зовётся должностью. */}
        {peer.name && <span>{role?.title ?? peer.roleId}</span>}
      </div>
    </>
  );
  if (!title) {
    return <div className={`chat-peer${compact ? ' compact' : ''}`}>{who}</div>;
  }
  return (
    <div className="chat-peer chat-peer-head">
      <div className="chat-peer-title" title={title}>{title}</div>
      <div className="chat-peer-who">{who}</div>
    </div>
  );
}

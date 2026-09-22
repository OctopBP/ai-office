import { useStore } from './store';
import { Avatar } from './Avatar';
import { useInstanceName } from './instanceName';

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
  if (!peer) return null;
  return (
    <div className={`chat-peer${compact ? ' compact' : ''}`}>
      <Avatar roleId={peer.roleId} instanceId={peer.id} size={compact ? 'md' : 'lg'} />
      <div className="chat-peer-text">
        <b>{name}</b>
        {/* Вторая строка — должность, и только когда она не повторяет первую:
            без своего имени сотрудник и так зовётся должностью. */}
        {peer.name && <span>{role?.title ?? peer.roleId}</span>}
      </div>
    </div>
  );
}

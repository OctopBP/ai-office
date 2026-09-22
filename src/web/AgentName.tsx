import { useState, type KeyboardEvent } from 'react';
import { setAgentName } from './store';
import { useInstanceName } from './instanceName';
import { t } from './i18n';
import { Icon } from './icons';
import { Hint, Tooltip } from './Tooltip';
import { HOTKEY } from './hotkeys';
import { MAX_AGENT_NAME, type InstanceView } from '../shared/types';

/**
 * Имя сотрудника в шапке карточки: подпись, по клику — поле правки. Пустое
 * поле снимает имя, и сотрудник снова зовётся по роли. Одно и то же в дровере
 * агента и в карточке окна «Команда», чтобы имя правилось одинаково там и там.
 * `as` — уровень заголовка, каким подпись стоит в этой карточке.
 */
export function AgentName({ inst, as: Tag }: { inst: InstanceView; as: 'h2' | 'h3' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const name = useInstanceName(inst.id);

  const start = () => { setDraft(inst.name ?? ''); setEditing(true); };
  const commit = () => {
    setEditing(false);
    // Отправляем только перемену: сервер и так молчит на то же имя, но и
    // гонять команду ради клика мимо поля незачем.
    if (draft.trim() !== (inst.name ?? '')) setAgentName(inst.id, draft);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') setEditing(false);
  };

  if (editing) {
    return (
      <Tooltip focus={false} tip={<>
        <Hint label={t('employee.nameHint.save')} keys={HOTKEY.task} />
        <Hint label={t('employee.nameHint.cancel')} keys={HOTKEY.close} />
        <Hint label={t('employee.nameHint.empty')} />
      </>}>
        <input
          className="agent-name-input"
          autoFocus
          value={draft}
          maxLength={MAX_AGENT_NAME}
          placeholder={t('employee.namePlaceholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={commit}
        />
      </Tooltip>
    );
  }
  return (
    <Tag className="agent-name">
      <button className="agent-name-btn" title={t('employee.rename')} onClick={start}>
        {name} <Icon name="pencil" size={14} />
      </button>
    </Tag>
  );
}

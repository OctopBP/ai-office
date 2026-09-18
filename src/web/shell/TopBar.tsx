import { setPaused, useStore, type View } from '../store';
import { focusComposer } from './Composer';
import { t } from '../i18n';
import { Icon } from '../icons';
import { Hint, Tooltip } from '../Tooltip';
import { HOTKEY } from '../hotkeys';

const VIEWS: View[] = ['office', 'board', 'chat'];

/**
 * Верхний ряд поверх сцены: сегменты видов по центру, справа пауза и главная
 * кнопка. «Поставить задачу» не открывает ничего нового — она ставит курсор
 * в композер на тред менеджера: задача и так ставится словами внизу.
 */
export function TopBar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const paused = useStore((s) => s.paused);
  const setThread = useStore((s) => s.setThread);
  // Менеджер ответил, пока смотрели не чат: сегмент зажигает точку. Сколько
  // именно реплик пришло — неважно, важен сам факт «там появилось новое».
  const chatUnread = useStore((s) => s.chatUnread);

  return (
    <div className="shell-top">
      <span />
      <div className="seg">
        {VIEWS.map((v) => (
          <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
            {t(`shell.view.${v}`)}
            {v === 'chat' && chatUnread && <i className="seg-dot" />}
          </button>
        ))}
      </div>
      <div className="shell-top-right">
        <button className={`sq float${paused ? ' on' : ''}`} onClick={() => setPaused(!paused)}
          title={t(paused ? 'hud.resume.hint' : 'hud.pause.hint')}>
          <Icon name={paused ? 'player-play' : 'player-pause'} size={16} />
        </button>
        <Tooltip tip={<Hint label={t('shell.newTask.hint')} keys={HOTKEY.task} />}>
          <button className="primary" onClick={() => {
            setThread('pm#1');
            // На доске композера нет — задачу ставят словами в чате, туда и уводим.
            if (view === 'board') setView('chat');
            focusComposer();
          }}>
            {t('shell.newTask')}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

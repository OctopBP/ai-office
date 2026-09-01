import { setPaused, useStore, type View } from '../store';
import { focusComposer } from './Composer';
import { t } from '../i18n';
import { Icon } from '../icons';

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

  return (
    <div className="shell-top">
      <span />
      <div className="seg">
        {VIEWS.map((v) => (
          <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
            {t(`shell.view.${v}`)}
          </button>
        ))}
      </div>
      <div className="shell-top-right">
        <button className={`sq float${paused ? ' on' : ''}`} onClick={() => setPaused(!paused)}
          title={t(paused ? 'hud.resume.hint' : 'hud.pause.hint')}>
          <Icon name={paused ? 'player-play' : 'player-pause'} size={16} />
        </button>
        <button className="primary" title={t('shell.newTask.hint')}
          onClick={() => { setThread('pm#1'); focusComposer(); }}>
          {t('shell.newTask')}
        </button>
      </div>
    </div>
  );
}

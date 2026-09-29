import { setPaused, useStore, type View } from '../store';
import { focusComposer } from './Composer';
import { t } from '../i18n';
import { Icon } from '../icons';
import { Hint, Tooltip } from '../Tooltip';
import { HOTKEY } from '../hotkeys';

const VIEWS: View[] = ['office', 'board', 'chat', 'life'];

// Подпись клавиши у сегмента: те же буквы, что ловит `App.tsx`. У офиса и чата
// своей буквы нет — чат открывает Enter, но он подписан на «Поставить задачу».
const VIEW_KEY: Partial<Record<View, string>> = { board: HOTKEY.board, life: HOTKEY.life };

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
  // Бейдж «Жизни офиса» — число вопросов владельцу, ждущих решения. Считает
  // сервер (openQuestions в сторе), здесь только форматирование: 0 — бейджа
  // нет вовсе, больше 9 — «9+», чтобы сегмент не гулял по ширине.
  const openQuestions = useStore((s) => s.openQuestions);
  const lifeBadge = openQuestions > 0 ? (openQuestions > 9 ? '9+' : String(openQuestions)) : null;

  return (
    <div className="shell-top">
      <span />
      <div className="seg">
        {VIEWS.map((v) => (
          <Tooltip key={v} tip={VIEW_KEY[v] && <Hint label={t(`shell.view.${v}`)} keys={VIEW_KEY[v]} />}>
            <button className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {t(`shell.view.${v}`)}
              {v === 'chat' && chatUnread && <i className="seg-dot" />}
              {v === 'life' && lifeBadge && <span className="seg-badge">{lifeBadge}</span>}
            </button>
          </Tooltip>
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

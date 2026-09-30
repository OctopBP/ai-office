import { setPaused, useStore, type View } from '../store';
import { t } from '../i18n';
import { Icon } from '../icons';
import { Hint, Tooltip } from '../Tooltip';
import { HOTKEY } from '../hotkeys';

const VIEWS: View[] = ['office', 'board', 'chat', 'life'];

// Подпись клавиши у сегмента: те же буквы, что ловит `App.tsx`. У офиса и чата
// своей буквы нет — чат открывает Enter.
const VIEW_KEY: Partial<Record<View, string>> = { board: HOTKEY.board, life: HOTKEY.life };

/**
 * Верхний ряд поверх сцены: сегменты видов по центру, справа пауза. Отдельной
 * кнопки «поставить задачу» нет — задача ставится словами в композере.
 */
export function TopBar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const paused = useStore((s) => s.paused);
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
      </div>
    </div>
  );
}

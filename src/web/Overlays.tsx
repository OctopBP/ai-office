import { Panel } from './Panel';
import { Kbd } from './Kbd';
import { HOTKEY } from './hotkeys';
import { Board } from './Board';
import { AgentDrawer } from './AgentDrawer';
import { TaskDrawer } from './TaskDrawer';
import { PermissionModal } from './PermissionModal';
import { DiffPanel } from './DiffPanel';
import { MeetingModal } from './MeetingModal';
import { OfficesModal } from './OfficesModal';
import { t } from './i18n';

// Лог, расходы, слияние, совещания, команда, процессы, выпуски и настройки —
// страницы главной области (`RailView` в сторе), а не оверлеи.
export type PanelKind = 'board' | 'help' | null;
export type ModalKind = 'meeting' | 'offices' | null;

export interface OverlayProps {
  panel: PanelKind;
  setPanel: (p: PanelKind) => void;
  modal: ModalKind;
  setModal: (m: ModalKind) => void;
}

/**
 * Всё, что открывается поверх комнаты: панели, дроверы, модалки. Состояние
 * «что открыто» держит App: ему же принадлежат горячие клавиши, которые это
 * открывают и закрывают.
 */
export function Overlays({ panel, setPanel, modal, setModal }: OverlayProps) {
  return (
    <>
      {panel === 'board' && (
        <Panel title={t('panel.board')} wide size="board" hotkey={HOTKEY.board} onClose={() => setPanel(null)}>
          <Board />
        </Panel>
      )}
      {panel === 'help' && (
        <Panel title={t('help.title')} onClose={() => setPanel(null)}>
          <div className="help">
            <p>{t('help.office')}</p>
            <p><Kbd keys="ENTER" /> — {t('help.enter')}</p>
            <p>
              <Kbd keys="B" /> — {t('hint.board')}, <Kbd keys="E" /> — {t('hint.money')},{' '}
              <Kbd keys="L" /> — {t('hint.log')},{' '}
              <Kbd keys="M" /> — {t('hint.meeting')}, <Kbd keys="SPACE" /> — {t('hint.pause')},{' '}
              <Kbd keys="1–9" /> — {t('help.keys.agent')}, <Kbd keys="ESC" /> — {t('help.keys.esc')}.
            </p>
            <p>
              {t('help.camera')} <Kbd keys="WASD" /> {t('help.camera.keys')}{' '}
              <Kbd keys="SHIFT+1–9" /> {t('help.camera.room')}{' '}
              <Kbd keys="SHIFT+0" /> {t('help.camera.fit')}
            </p>
            <p>{t('help.home')}</p>
            <p>{t('help.pause')}</p>
            <p>{t('help.money')}</p>
            <p>{t('help.door')}</p>
            <p>{t('help.agent')}</p>
            <p>
              {t('help.danger.before')} <code className="mono">kill</code>
              {t('help.danger.after')}
            </p>
            <p>{t('help.team')}</p>
          </div>
        </Panel>
      )}

      <DiffPanel />
      <AgentDrawer />
      <TaskDrawer />
      <PermissionModal />
      {modal === 'meeting' && <MeetingModal onClose={() => setModal(null)} />}
      {modal === 'offices' && <OfficesModal onClose={() => setModal(null)} />}
    </>
  );
}

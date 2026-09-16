import { Panel } from './Panel';
import { Board } from './Board';
import { MergeQueue } from './MergeQueue';
import { PrPipeline } from './PrPipeline';
import { TeamWindow } from './TeamWindow';
import { AgentDrawer } from './AgentDrawer';
import { TaskDrawer } from './TaskDrawer';
import { PermissionModal } from './PermissionModal';
import { DiffPanel } from './DiffPanel';
import { SettingsModal } from './SettingsModal';
import { MeetingModal } from './MeetingModal';
import { MoneyBoard } from './MoneyBoard';
import { OfficesModal } from './OfficesModal';
import { LifePanel } from './LifePanel';
import { FlowsPanel } from './FlowsPanel';
import { MeetingsPanel } from './MeetingsPanel';
import { useStore } from './store';
import { t } from './i18n';

export type PanelKind = 'board' | 'money' | 'log' | 'help' | 'merge' | 'life' | 'flows' | 'meetings' | null;
export type ModalKind = 'settings' | 'meeting' | 'offices' | 'team' | null;

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
  const log = useStore((s) => s.log);
  const selected = useStore((s) => s.selected);

  return (
    <>
      {panel === 'board' && (
        <Panel title={t('panel.board')} wide size="board" hint="B" onClose={() => setPanel(null)}>
          <Board />
        </Panel>
      )}
      {panel === 'money' && (
        <Panel title={t('panel.money')} wide hint="E" onClose={() => setPanel(null)}>
          <MoneyBoard />
        </Panel>
      )}
      {panel === 'merge' && (
        <Panel title={t('panel.review')} wide hint="Q" onClose={() => setPanel(null)}>
          <PrPipeline />
          <MergeQueue />
        </Panel>
      )}
      {panel === 'life' && (
        <Panel title={t('life.title')} wide hint="J" onClose={() => setPanel(null)}>
          <LifePanel />
        </Panel>
      )}
      {panel === 'flows' && (
        <FlowsPanel onClose={() => setPanel(null)} />
      )}
      {panel === 'meetings' && (
        <Panel title={t('meetings.title')} wide hint={t('meetings.hint')} onClose={() => setPanel(null)}>
          <MeetingsPanel onCall={() => { setPanel(null); setModal('meeting'); }} />
        </Panel>
      )}
      {panel === 'log' && (
        <Panel title={t('panel.log')} wide
          hint={selected ? t('panel.log.only', { who: selected }) : t('panel.log.all')}
          onClose={() => setPanel(null)}>
          <div className="log">
            {(selected ? log.filter((l) => l.agentId === selected) : log).slice(-200).map((l) => (
              <div key={l.id} className={`log-row ${l.kind}${l.autoApproved ? ' auto-approved' : ''}`}>
                <span className="log-agent">{l.agentId ?? t('common.office')}</span>
                <span className="log-text">
                  {l.autoApproved && (
                    <span className="auto-tag" title={t('log.autoHint')}>{t('log.auto')}</span>
                  )}
                  {l.text}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}
      {panel === 'help' && (
        <Panel title={t('help.title')} onClose={() => setPanel(null)}>
          <div className="help">
            <p>{t('help.office')}</p>
            <p><kbd>ENTER</kbd> — {t('help.enter')}</p>
            <p>
              <kbd>B</kbd> — {t('hint.board')}, <kbd>E</kbd> — {t('hint.money')},{' '}
              <kbd>L</kbd> — {t('hint.log')},{' '}
              <kbd>M</kbd> — {t('hint.meeting')}, <kbd>SPACE</kbd> — {t('hint.pause')},{' '}
              <kbd>1–9</kbd> — {t('help.keys.agent')}, <kbd>ESC</kbd> — {t('help.keys.esc')}.
            </p>
            <p>
              {t('help.camera')} <kbd>WASD</kbd> {t('help.camera.keys')}{' '}
              <kbd>SHIFT</kbd>+<kbd>1–9</kbd> {t('help.camera.room')}{' '}
              <kbd>SHIFT</kbd>+<kbd>0</kbd> {t('help.camera.fit')}
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
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {modal === 'meeting' && <MeetingModal onClose={() => setModal(null)} />}
      {modal === 'offices' && <OfficesModal onClose={() => setModal(null)} />}
      {modal === 'team' && <TeamWindow onClose={() => setModal(null)} />}
    </>
  );
}

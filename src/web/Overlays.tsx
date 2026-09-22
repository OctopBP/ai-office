import { Panel } from './Panel';
import { Kbd } from './Kbd';
import { HOTKEY } from './hotkeys';
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
import { displayInstance } from './instanceName';
import { t, locale } from './i18n';

/** Время строки лога с секундами: события инструментов идут пачками в одну минуту. */
const logClock = (at: number): string =>
  new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  // Лента действий тоже зовёт сотрудника подписью: код экземпляра владельцу
  // ничего не говорит, а строк в ленте больше всего.
  const nameOf = (id: string): string => displayInstance(id, instances, roles);

  return (
    <>
      {panel === 'board' && (
        <Panel title={t('panel.board')} wide size="board" hotkey={HOTKEY.board} onClose={() => setPanel(null)}>
          <Board />
        </Panel>
      )}
      {panel === 'money' && (
        <Panel title={t('panel.money')} wide hotkey={HOTKEY.money} onClose={() => setPanel(null)}>
          <MoneyBoard />
        </Panel>
      )}
      {panel === 'merge' && (
        <Panel title={t('panel.review')} wide hotkey={HOTKEY.merge} onClose={() => setPanel(null)}>
          <PrPipeline />
          <MergeQueue />
        </Panel>
      )}
      {panel === 'life' && (
        <Panel title={t('life.title')} wide hotkey={HOTKEY.life} onClose={() => setPanel(null)}>
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
        <Panel title={t('panel.log')} wide hotkey={HOTKEY.log}
          hint={selected ? t('panel.log.only', { who: nameOf(selected) }) : t('panel.log.all')}
          onClose={() => setPanel(null)}>
          <div className="log">
            {(selected ? log.filter((l) => l.agentId === selected) : log).slice(-200).map((l) => (
              <div key={l.id} className={`log-row ${l.kind}${l.autoApproved ? ' auto-approved' : ''}`}>
                <span className="log-time" title={new Date(l.at).toLocaleString(locale())}>{logClock(l.at)}</span>
                <span className="log-agent">{l.agentId ? nameOf(l.agentId) : t('common.office')}</span>
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
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {modal === 'meeting' && <MeetingModal onClose={() => setModal(null)} />}
      {modal === 'offices' && <OfficesModal onClose={() => setModal(null)} />}
      {modal === 'team' && <TeamWindow onClose={() => setModal(null)} />}
    </>
  );
}

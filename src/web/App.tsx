import { useEffect, useState } from 'react';
import { Office } from './Office';
import { Office3D } from './office3d/Office3D';
import { TopHud } from './TopHud';
import { BottomBar } from './BottomBar';
import { Toasts } from './Toasts';
import { Panel } from './Panel';
import { ChatPanel } from './ChatPanel';
import { Board } from './Board';
import { MergeQueue } from './MergeQueue';
import { PrPipeline } from './PrPipeline';
import { TeamWindow } from './TeamWindow';
import { AgentDrawer } from './AgentDrawer';
import { PermissionModal } from './PermissionModal';
import { DiffPanel } from './DiffPanel';
import { SettingsModal } from './SettingsModal';
import { MeetingModal } from './MeetingModal';
import { UsageModal } from './UsageModal';
import { OfficesModal } from './OfficesModal';
import { MenuScreen } from './MenuScreen';
import { closeDiff, connect, setPaused, useStore } from './store';
import { isOfficeSender } from '../shared/types';
import { t } from './i18n';

type PanelKind = 'chat' | 'board' | 'log' | 'help' | 'merge' | null;
type ModalKind = 'settings' | 'meeting' | 'usage' | 'offices' | 'team' | null;

export function App() {
  const theme = useStore((s) => s.theme);
  const screen = useStore((s) => s.screen);
  const instances = useStore((s) => s.instances);
  const log = useStore((s) => s.log);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const paused = useStore((s) => s.paused);
  const diff = useStore((s) => s.diff);
  const leaveOffice = useStore((s) => s.leaveOffice);
  const pending = useStore((s) => s.pending);
  const settingsSection = useStore((s) => s.settingsSection);
  const render3d = useStore((s) => s.render3d);
  const setRender3d = useStore((s) => s.setRender3d);
  const teamRequest = useStore((s) => s.teamRequest);
  const [panel, setPanel] = useState<PanelKind>(null);
  const [modal, setModal] = useState<ModalKind>(null);

  useEffect(() => { connect(); }, []);

  // Ссылка «настройки раскладки» из карточки безместного сотрудника: стор
  // получает запрос на раздел «Проект», а открывает модалку уже здесь.
  useEffect(() => {
    if (settingsSection) setModal('settings');
  }, [settingsSection]);

  // Ссылка «роль, модель, права →» из карточки сотрудника (AgentDrawer) —
  // тот же приём: стор получает запрос на роль, здесь открывается окно.
  useEffect(() => {
    if (teamRequest) setModal('team');
  }, [teamRequest]);

  // Переключаемся на другой офис: закрываем всё, что открыто поверх сцены,
  // иначе доска, лог или дифф прежнего офиса повисли бы в новом.
  useEffect(() => {
    if (pending === 'enter') { setPanel(null); setModal(null); }
  }, [pending]);

  // Тема живёт на корневом элементе: color задаётся на body, а наследуется
  // он уже вычисленным значением — тема ниже body не подействовала бы.
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  // App не размонтируется при уходе в меню — только меняется JSX-ветка ниже.
  // Без этого открытые панель/модалка «протекли» бы в следующий открытый офис.
  useEffect(() => {
    if (screen === 'menu') { setPanel(null); setModal(null); }
  }, [screen]);

  // Горячие клавиши как в макете. В полях ввода не срабатывают.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        // Сначала закрываем всё открытое поверх комнаты, и только если
        // закрывать было нечего — уходим в меню.
        if (panel || modal || diff || selected) {
          setPanel(null); setModal(null); closeDiff(); select(null);
        } else {
          leaveOffice();
        }
        return;
      }
      if (e.key === 'Enter') { setPanel('chat'); return; }
      // Пробел листает страницу по умолчанию — здесь он ставит офис на паузу.
      if (e.key === ' ') { e.preventDefault(); setPaused(!paused); return; }
      const k = e.key.toLowerCase();
      // 0 — переключить плоский офис на трёхмерный и обратно. Цифры 1–9 уже
      // заняты выбором агента, поэтому ноль.
      if (k === '0') { setRender3d(!render3d); return; }
      if (k === 'b' || k === 'и') setPanel('board');
      else if (k === 'l' || k === 'д') setPanel('log');
      else if (k === 'm' || k === 'ь') setModal('meeting');
      else if (k === 'q' || k === 'й') setPanel('merge');
      // Цифра с Shift — камере (`office3d/Camera3D.tsx`): фокус на комнате.
      // Раскладка клавиатуры делает из Shift+2 то «@», то «"», поэтому
      // проверяется сам модификатор, а не то, что из него вышло.
      else if (/^[1-9]$/.test(k) && !e.shiftKey) {
        const ids = Object.keys(instances);
        const id = ids[Number(k) - 1];
        if (id) select(selected === id ? null : id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [instances, selected, select, paused, panel, modal, diff, leaveOffice, render3d, setRender3d]);

  // До выбора офиса в меню комната вообще не монтируется — это отдельный
  // экран приложения, а не оверлей поверх неё.
  if (screen === 'menu') return <MenuScreen />;

  return (
    <div className={`app${paused ? ' paused' : ''}`}>
      <TopHud
        onSettings={() => setModal('settings')}
        onMeeting={() => setModal('meeting')}
        onHelp={() => setPanel('help')}
        onUsage={() => setModal('usage')}
        onMergeQueue={() => setPanel('merge')}
        onTeam={() => setModal('team')}
      />
      <div className="stage">
        {render3d
          ? <Office3D onOpen={setPanel} onDoor={() => setModal('offices')} />
          : <Office onOpen={setPanel} onDoor={() => setModal('offices')} />}
        <Toasts onOpenTask={() => setPanel('board')} />
      </div>
      <BottomBar />

      {panel === 'chat' && <ChatPanel onClose={() => setPanel(null)} />}
      {panel === 'board' && (
        <Panel title={t('panel.board')} wide size="board" hint="B" onClose={() => setPanel(null)}>
          <Board />
        </Panel>
      )}
      {panel === 'merge' && (
        <Panel title={t('panel.review')} wide hint="Q" onClose={() => setPanel(null)}>
          <PrPipeline />
          <MergeQueue />
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
              <kbd>B</kbd> — {t('hint.board')}, <kbd>L</kbd> — {t('hint.log')},{' '}
              <kbd>M</kbd> — {t('hint.meeting')}, <kbd>SPACE</kbd> — {t('hint.pause')},{' '}
              <kbd>1–9</kbd> — {t('help.keys.agent')}, <kbd>ESC</kbd> — {t('help.keys.esc')},{' '}
              <kbd>0</kbd> — {t('help.keys.render')}.
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
      <PermissionModal />
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {modal === 'meeting' && <MeetingModal onClose={() => setModal(null)} />}
      {modal === 'usage' && <UsageModal onClose={() => setModal(null)} />}
      {modal === 'offices' && <OfficesModal onClose={() => setModal(null)} />}
      {modal === 'team' && <TeamWindow onClose={() => setModal(null)} />}
    </div>
  );
}

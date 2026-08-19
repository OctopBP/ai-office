import { useEffect, useState } from 'react';
import { Office } from './Office';
import { TopHud } from './TopHud';
import { BottomBar } from './BottomBar';
import { Toasts } from './Toasts';
import { Panel } from './Panel';
import { ChatPanel } from './ChatPanel';
import { Board } from './Board';
import { TeamPanel } from './TeamPanel';
import { AgentDrawer } from './AgentDrawer';
import { PermissionModal } from './PermissionModal';
import { SettingsModal } from './SettingsModal';
import { MeetingModal } from './MeetingModal';
import { connect, useStore } from './store';

type PanelKind = 'chat' | 'board' | 'log' | 'help' | null;
type ModalKind = 'settings' | 'meeting' | null;

export function App() {
  const theme = useStore((s) => s.theme);
  const instances = useStore((s) => s.instances);
  const log = useStore((s) => s.log);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const [panel, setPanel] = useState<PanelKind>(null);
  const [modal, setModal] = useState<ModalKind>(null);

  useEffect(() => { connect(); }, []);

  // Тема живёт на корневом элементе: color задаётся на body, а наследуется
  // он уже вычисленным значением — тема ниже body не подействовала бы.
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  // Горячие клавиши как в макете. В полях ввода не срабатывают.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') { setPanel(null); setModal(null); select(null); return; }
      if (e.key === 'Enter') { setPanel('chat'); return; }
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'и') setPanel('board');
      else if (k === 'l' || k === 'д') setPanel('log');
      else if (k === 'm' || k === 'ь') setModal('meeting');
      else if (/^[1-9]$/.test(k)) {
        const ids = Object.keys(instances);
        const id = ids[Number(k) - 1];
        if (id) select(selected === id ? null : id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [instances, selected, select]);

  return (
    <div className="app">
      <div className="stage">
        <Office />
        <TopHud
          onSettings={() => setModal('settings')}
          onMeeting={() => setModal('meeting')}
          onHelp={() => setPanel('help')}
        />
        <Toasts onOpenTask={() => setPanel('board')} />
      </div>
      <BottomBar />

      {panel === 'chat' && <ChatPanel onClose={() => setPanel(null)} />}
      {panel === 'board' && (
        <Panel title="Доска задач" wide hint="B" onClose={() => setPanel(null)}>
          <Board />
        </Panel>
      )}
      {panel === 'log' && (
        <Panel title="Лог событий" wide hint={selected ? `только ${selected}` : 'весь офис'}
          onClose={() => setPanel(null)}>
          <div className="log">
            {(selected ? log.filter((l) => l.agentId === selected) : log).slice(-200).map((l) => (
              <div key={l.id} className={`log-row ${l.kind}`}>
                <span className="log-agent">{l.agentId ?? 'офис'}</span>
                <span className="log-text">{l.text}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
      {panel === 'help' && (
        <Panel title="Как этим пользоваться" onClose={() => setPanel(null)}>
          <div className="help">
            <p><b>Офис</b> — это вид на доску задач, а не отдельная жизнь. Всё, что делают
              человечки, отражает реальные сессии агентов.</p>
            <p><kbd>ENTER</kbd> — написать менеджеру. Он разберёт задачу на части и раздаст
              команде; исполнители работают параллельно, каждый в своей ветке.</p>
            <p><kbd>B</kbd> — доска задач, <kbd>L</kbd> — лог, <kbd>M</kbd> — созвать совещание,
              <kbd>1–9</kbd> — открыть карточку агента, <kbd>ESC</kbd> — закрыть.</p>
            <p>Клик по человечку открывает панель справа: что он делает, его задачи,
              живой транскрипт и расходы.</p>
            <p>Опасные действия — удаление файлов, <code className="mono">kill</code>,
              запись за пределы рабочей папки — останавливаются и спрашивают разрешения.</p>
          </div>
          <TeamPanel />
        </Panel>
      )}

      <AgentDrawer />
      <PermissionModal />
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {modal === 'meeting' && <MeetingModal onClose={() => setModal(null)} />}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Office } from './Office';
import { TopHud } from './TopHud';
import { BottomBar } from './BottomBar';
import { Toasts } from './Toasts';
import { Panel } from './Panel';
import { ChatPanel } from './ChatPanel';
import { Board } from './Board';
import { MergeQueue } from './MergeQueue';
import { PrPipeline } from './PrPipeline';
import { TeamPanel } from './TeamPanel';
import { AgentDrawer } from './AgentDrawer';
import { PermissionModal } from './PermissionModal';
import { DiffPanel } from './DiffPanel';
import { SettingsModal } from './SettingsModal';
import { MeetingModal } from './MeetingModal';
import { UsageModal } from './UsageModal';
import { OfficesModal } from './OfficesModal';
import { MenuScreen } from './MenuScreen';
import { closeDiff, connect, setPaused, useStore } from './store';

type PanelKind = 'chat' | 'board' | 'log' | 'help' | 'merge' | null;
type ModalKind = 'settings' | 'meeting' | 'usage' | 'offices' | null;

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
  const [panel, setPanel] = useState<PanelKind>(null);
  const [modal, setModal] = useState<ModalKind>(null);

  useEffect(() => { connect(); }, []);

  // Ссылка «настройки раскладки» из карточки безместного сотрудника: стор
  // получает запрос на раздел «Проект», а открывает модалку уже здесь.
  useEffect(() => {
    if (settingsSection) setModal('settings');
  }, [settingsSection]);

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
      if (k === 'b' || k === 'и') setPanel('board');
      else if (k === 'l' || k === 'д') setPanel('log');
      else if (k === 'm' || k === 'ь') setModal('meeting');
      else if (k === 'q' || k === 'й') setPanel('merge');
      else if (/^[1-9]$/.test(k)) {
        const ids = Object.keys(instances);
        const id = ids[Number(k) - 1];
        if (id) select(selected === id ? null : id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [instances, selected, select, paused, panel, modal, diff, leaveOffice]);

  // До выбора офиса в меню комната вообще не монтируется — это отдельный
  // экран приложения, а не оверлей поверх неё.
  if (screen === 'menu') return <MenuScreen />;

  return (
    <div className={`app${paused ? ' paused' : ''}`}>
      <div className="stage">
        <Office onOpen={setPanel} onDoor={() => setModal('offices')} />
        <TopHud
          onSettings={() => setModal('settings')}
          onMeeting={() => setModal('meeting')}
          onHelp={() => setPanel('help')}
          onUsage={() => setModal('usage')}
          onMergeQueue={() => setPanel('merge')}
        />
        <Toasts onOpenTask={() => setPanel('board')} />
      </div>
      <BottomBar />

      {panel === 'chat' && <ChatPanel onClose={() => setPanel(null)} />}
      {panel === 'board' && (
        <Panel title="Доска задач" wide size="board" hint="B" onClose={() => setPanel(null)}>
          <Board />
        </Panel>
      )}
      {panel === 'merge' && (
        <Panel title="Ревью и слияние" wide hint="Q" onClose={() => setPanel(null)}>
          <PrPipeline />
          <MergeQueue />
        </Panel>
      )}
      {panel === 'log' && (
        <Panel title="Лог событий" wide hint={selected ? `только ${selected}` : 'весь офис'}
          onClose={() => setPanel(null)}>
          <div className="log">
            {(selected ? log.filter((l) => l.agentId === selected) : log).slice(-200).map((l) => (
              <div key={l.id} className={`log-row ${l.kind}${l.autoApproved ? ' auto-approved' : ''}`}>
                <span className="log-agent">{l.agentId ?? 'офис'}</span>
                <span className="log-text">
                  {l.autoApproved && <span className="auto-tag" title="Разрешено без вопроса по режиму доступа">✓ авто</span>}
                  {l.text}
                </span>
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
              <kbd>SPACE</kbd> — пауза, <kbd>1–9</kbd> — открыть карточку агента,
              <kbd>ESC</kbd> — закрыть, а если закрывать нечего — выйти в меню офисов.</p>
            <p>🏠 в шапке — выйти в меню: офис остаётся открытым на сервере, агенты
              продолжают работать, это только смена экрана.</p>
            <p><b>Пауза</b> не убивает сессии: исполнители замирают на следующем вызове
              инструмента и продолжают с того же места, когда вы нажмёте ▶. Новые задачи
              на паузе не запускаются, а с менеджером по-прежнему можно разговаривать.</p>
            <p>Клик по сумме в шапке — расходы по дням, агентам и задачам: свежий ввод,
              вывод и доля кеша считаются отдельно.</p>
            <p><b>Дверь</b> открывает список офисов. Офис — это проект: своя рабочая
              директория, доска и расходы; переключение не требует перезапуска.</p>
            <p>Клик по человечку открывает панель справа: что он делает, его задачи,
              живой транскрипт и расходы.</p>
            <p>Опасные действия — удаление файлов, <code className="mono">kill</code>,
              запись за пределы рабочей папки — останавливаются и спрашивают разрешения.</p>
          </div>
          <TeamPanel />
        </Panel>
      )}

      <DiffPanel />
      <AgentDrawer />
      <PermissionModal />
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {modal === 'meeting' && <MeetingModal onClose={() => setModal(null)} />}
      {modal === 'usage' && <UsageModal onClose={() => setModal(null)} />}
      {modal === 'offices' && <OfficesModal onClose={() => setModal(null)} />}
    </div>
  );
}

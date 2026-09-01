import { useEffect, useState } from 'react';
import { Office } from './Office';
import { Office3D } from './office3d/Office3D';
import { TopHud } from './TopHud';
import { BottomBar } from './BottomBar';
import { Toasts } from './Toasts';
import { MenuScreen } from './MenuScreen';
import { AvatarStage } from './office3d/AgentAvatar';
import { Overlays, type ModalKind, type PanelKind } from './Overlays';
import { Shell } from './shell/Shell';
import { focusComposer } from './shell/Composer';
import { closeDiff, connect, setPaused, useStore } from './store';

export function App() {
  const theme = useStore((s) => s.theme);
  const screen = useStore((s) => s.screen);
  const instances = useStore((s) => s.instances);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const paused = useStore((s) => s.paused);
  const diff = useStore((s) => s.diff);
  const openTask = useStore((s) => s.openTask);
  const openTaskCard = useStore((s) => s.openTaskCard);
  const leaveOffice = useStore((s) => s.leaveOffice);
  const pending = useStore((s) => s.pending);
  const settingsSection = useStore((s) => s.settingsSection);
  const render3d = useStore((s) => s.render3d);
  const setRender3d = useStore((s) => s.setRender3d);
  const teamRequest = useStore((s) => s.teamRequest);
  const shell = useStore((s) => s.shell);
  const setShell = useStore((s) => s.setShell);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
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
      const fresh = shell === 'new';
      if (e.key === 'Escape') {
        // Раскрытая карточка закрывается первой и одна: она лежит поверх
        // доски, и уносить обе разом значило бы терять место, где стоял
        // взгляд, ради закрытия одной панели.
        if (openTask) { openTaskCard(null); return; }
        // Дальше — всё открытое поверх комнаты, потом вид, и только если
        // закрывать было нечего, уходим в меню.
        if (panel || modal || diff || selected) {
          setPanel(null); setModal(null); closeDiff(); select(null);
        } else if (fresh && view !== 'office') {
          setView('office');
        } else {
          leaveOffice();
        }
        return;
      }
      // В новой оболочке доска и чат — виды, а не панели: сегмент сверху
      // подменяет главную область, рейл и композер остаются на месте.
      if (e.key === 'Enter') {
        if (fresh) { setView('chat'); focusComposer(); } else setPanel('chat');
        return;
      }
      // Пробел листает страницу по умолчанию — здесь он ставит офис на паузу.
      if (e.key === ' ') { e.preventDefault(); setPaused(!paused); return; }
      const k = e.key.toLowerCase();
      // 0 — переключить плоский офис на трёхмерный и обратно. Цифры 1–9 уже
      // заняты выбором агента, поэтому ноль.
      if (k === '0') { setRender3d(!render3d); return; }
      // N — прежний HUD или новая оболочка. Флаг временный: пока новая не
      // закроет всё, что умел HUD, между ними нужно ходить без перезагрузки.
      if (k === 'n' || k === 'т') { setShell(fresh ? 'classic' : 'new'); return; }
      if (k === 'b' || k === 'и') {
        if (fresh) setView(view === 'board' ? 'office' : 'board'); else setPanel('board');
      }
      // E — доска расходов. Буква занята под «expenses»/«расходы»: свободных
      // мнемоничных клавиш немного, а «$» на русской раскладке не набрать.
      else if (k === 'e' || k === 'у') setPanel('money');
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
  }, [instances, selected, select, paused, panel, modal, diff, leaveOffice, render3d, setRender3d,
    openTask, openTaskCard, shell, setShell, view, setView]);

  // До выбора офиса в меню комната вообще не монтируется — это отдельный
  // экран приложения, а не оверлей поверх неё.
  if (screen === 'menu') return <MenuScreen />;

  const overlays = { panel, setPanel, modal, setModal };

  if (shell === 'new') {
    return (
      <>
        <AvatarStage />
        <Shell {...overlays} />
      </>
    );
  }

  return (
    <div className={`app${paused ? ' paused' : ''}`}>
      {/* Общая сцена-портрет для всех аватарок в приложении — см.
          `office3d/AgentAvatar.tsx` про то, почему холст ровно один: второй
          `View.Port` продублировал бы рисунок первого. */}
      <AvatarStage />
      <TopHud
        onSettings={() => setModal('settings')}
        onMeeting={() => setModal('meeting')}
        onHelp={() => setPanel('help')}
        onMoney={() => setPanel('money')}
        onMergeQueue={() => setPanel('merge')}
        onTeam={() => setModal('team')}
      />
      <div className="stage">
        {render3d
          ? <Office3D onOpen={setPanel} onDoor={() => setModal('offices')} />
          : <Office onOpen={setPanel} onDoor={() => setModal('offices')} />}
        {/* «Открыть задачу» в тосте теперь и правда открывает задачу: доску
            и поверх неё её карточку. Раньше кнопка знала номер задачи, но
            открывала только доску — искать на ней ту самую приходилось глазами. */}
        <Toasts onOpenTask={(id) => { setPanel('board'); openTaskCard(id); }} />
      </div>
      <BottomBar />
      <Overlays {...overlays} />
    </div>
  );
}

import { Office3D } from '../office3d/Office3D';
import { Board } from '../Board';
import { ChatThread } from '../ChatThread';
import { LifePanel } from '../LifePanel';
import { PmChatList } from './PmChatList';
import { Toasts } from '../Toasts';
import { Overlays, type OverlayProps } from '../Overlays';
import { Rail } from './Rail';
import { TopBar } from './TopBar';
import { Composer } from './Composer';
import { EnvBanner } from './EnvBanner';
import { UpdateBanner } from './UpdateBanner';
import { SettingsPage } from '../SettingsPage';
import { TeamWindow } from '../TeamWindow';
import { RailPage } from './RailPages';
import { FlowsPage } from '../FlowsPage';
import { ReleasesPage } from '../ReleasesPage';
import { isRailView, useStore } from '../store';
import { t } from '../i18n';
import type { SpotTarget } from '../office3d/Hotspots3D';

/**
 * Новая оболочка по макету «11 · оболочка в новом стиле»: сцена во всё окно,
 * поверх неё слева рейл офисов и окон, сверху сегменты «Офис · Доска · Чат · Жизнь офиса»
 * с паузой и главной кнопкой, снизу композер. Всё, что открывается поверх
 * (панели, дроверы, модалки), — общий `Overlays`, тот же, что у прежнего HUD.
 *
 * Сегменты — виды: они подменяют то, что стоит в главной области, а рейл и
 * композер остаются. Поэтому хотспот «доска» в комнате переводит в вид, а
 * не открывает панель, как раньше.
 */
export function Shell(props: OverlayProps) {
  const { setPanel, setModal } = props;
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const collapsed = useStore((s) => s.railCollapsed);
  const paused = useStore((s) => s.paused);
  const openTaskCard = useStore((s) => s.openTaskCard);

  // Стол переговорки ведёт в окно совещаний: стенограмма идущего и история прошлых.
  const open = (kind: SpotTarget) => {
    if (kind === 'board') setView('board');
    else if (kind === 'meeting') setView('meetings');
    else setView(kind);
  };
  const door = () => setModal('offices');

  return (
    <div className={`shell${collapsed ? ' rail-collapsed' : ''}${paused ? ' paused' : ''}`}>
      <div className="shell-main">
        {/* Сцена не размонтируется при уходе на другой вид: смена камеры и
            позы агентов живут внутри неё (Object3D, OrbitControls), и снос
            дерева сбрасывал бы их к стартовым значениям при каждом
            возврате. Вместо этого она прячется через CSS и останавливает
            собственный рендер-цикл (`active` → `frameloop`), пока вид не
            активен, — так же, как невидимая аватарка тормозит анимацию
            (`AgentAvatar.tsx`). */}
        <Office3D onOpen={open} onDoor={door} active={view === 'office'} />
        {view === 'board' && <div className="shell-view shell-board"><Board /></div>}
        {view === 'chat' && (
          <div className="shell-view shell-chat">
            <PmChatList />
            {/* В чате композер — низ колонки переписки, а не полоса во всё
                окно: так список чатов доходит до нижнего края, а поле ввода
                совпадает по ширине с лентой. Черновик живёт в сторе, поэтому
                перемонтирование при смене вида ничего не теряет. */}
            <div className="shell-chat-col">
              <ChatThread />
              <Composer inline onSettings={() => setView('settings')} />
            </div>
          </div>
        )}
        {/* Окна из рейла — страницы на месте сцены (ShellPage). Закрыть —
            вернуться в комнату, как Esc с любого вида. */}
        {view === 'settings' && <SettingsPage onClose={() => setView('office')} />}
        {view === 'team' && <TeamWindow onClose={() => setView('office')} />}
        {(view === 'merge' || view === 'log' || view === 'money' || view === 'meetings') && (
          <RailPage view={view} onClose={() => setView('office')} onCall={() => setModal('meeting')} />
        )}
        {view === 'flows' && <FlowsPage />}
        {view === 'releases' && <ReleasesPage />}
        {view === 'life' && (
          <div className="shell-view shell-life">
            <h2 className="shell-life-title">{t('life.title')}</h2>
            <LifePanel />
          </div>
        )}
        <Toasts onOpenTask={(id) => { setView('board'); openTaskCard(id); }} />
      </div>
      <Rail onPanel={setPanel} onModal={setModal} />
      <TopBar />
      {/* На доске композера нет: экран целиком про задачи, а разговор с
          менеджером живёт в виде «Чат». Освободившуюся полосу внизу забирает
          сама доска (.shell-board). В «Чате» он встроен в колонку переписки.
          Страницам из рейла он тоже не нужен: там свои поля и кнопки. */}
      {view !== 'board' && view !== 'chat' && !isRailView(view) && <Composer onSettings={() => setView('settings')} />}
      <EnvBanner />
      <UpdateBanner />
      <Overlays {...props} />
    </div>
  );
}

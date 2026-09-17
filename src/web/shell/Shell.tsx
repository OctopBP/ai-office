import { Office3D } from '../office3d/Office3D';
import { Board } from '../Board';
import { ChatThread } from '../ChatThread';
import { Toasts } from '../Toasts';
import { Overlays, type OverlayProps } from '../Overlays';
import { Rail } from './Rail';
import { TopBar } from './TopBar';
import { Composer } from './Composer';
import { EnvBanner } from './EnvBanner';
import { useStore } from '../store';
import type { SpotTarget } from '../office3d/Hotspots3D';

/**
 * Новая оболочка по макету «11 · оболочка в новом стиле»: сцена во всё окно,
 * поверх неё слева рейл офисов и окон, сверху сегменты «Офис · Доска · Чат»
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
    else if (kind === 'meeting') setPanel('meetings');
    else setPanel(kind);
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
        {view === 'board' && <div className="shell-view"><Board /></div>}
        {view === 'chat' && <div className="shell-view shell-chat"><ChatThread /></div>}
        <Toasts onOpenTask={(id) => { setView('board'); openTaskCard(id); }} />
      </div>
      <Rail onPanel={setPanel} onModal={setModal} />
      <TopBar />
      <Composer onSettings={() => setModal('settings')} />
      <EnvBanner />
      <Overlays {...props} />
    </div>
  );
}

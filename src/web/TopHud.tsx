import { useState } from 'react';
import { ACCESS_LABEL, reset, resetLayout, setEditingLayout, setPaused, useStore } from './store';
import { OfficeSwitcher } from './OfficeSwitcher';
import { Icon, type IconName } from './icons';

const money = (v: number) => `$${v.toFixed(2)}`;

const ACCESS_ICON: Record<string, IconName> = {
  auto: 'lock-open',
  'ask-risky': 'shield-lock',
  'ask-writes': 'lock',
  readonly: 'ban',
};

export function TopHud({ onSettings, onMeeting, onHelp, onUsage, onMergeQueue, onTeam }: {
  onSettings: () => void; onMeeting: () => void; onHelp: () => void; onUsage: () => void;
  onMergeQueue: () => void; onTeam: () => void;
}) {
  const instances = useStore((s) => s.instances);
  const tasks = useStore((s) => s.tasks);
  const permissions = useStore((s) => s.permissions);
  const settings = useStore((s) => s.settings);
  const authSource = useStore((s) => s.authSource);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const connected = useStore((s) => s.connected);
  const usage = useStore((s) => s.usage);
  const paused = useStore((s) => s.paused);
  const leaveOffice = useStore((s) => s.leaveOffice);
  const editingLayout = useStore((s) => s.editingLayout);
  const layouts = useStore((s) => s.layouts);
  const [confirmReset, setConfirmReset] = useState(false);

  const list = Object.values(tasks);
  // «Сегодня» — это сегодня, а не всё время: раньше в HUD стояла общая сумма
  // с подписью «сегодня», и после перезапуска она врала.
  const today = Object.values(instances).reduce((sum, i) => sum + i.today.costUsd, 0);
  const working = list.filter((t) => t.status === 'in_progress').length;
  const review = list.filter((t) => (t.status === 'review' || t.status === 'done') && t.branch && !t.merged).length;
  const readyToMerge = list.filter((t) => t.status === 'done' && t.branch && !t.merged).length;
  const over = settings.globalBudgetUsd !== null && usage.costUsd >= settings.globalBudgetUsd;

  return (
    <>
      <div className="hud-bar">
        <div className="hud-group hud-left">
          <OfficeSwitcher />
          <span className="hud-sep" />
          <button className="hud-btn" onClick={leaveOffice}
            title="В меню — офис остаётся открытым, агенты продолжат работать — ESC">
            <Icon name="home" /><span className="hud-label">Меню</span>
          </button>
        </div>

        <span className="hud-sep" />

        <div className="hud-group hud-center">
          <button className={`hud-btn hud-money ${over ? 'over' : ''}`} onClick={onUsage}
            title={`Расходы сегодня: ${money(today)} · всего ${money(usage.costUsd)}`
              + (settings.globalBudgetUsd !== null ? ` из ${money(settings.globalBudgetUsd)}` : '')}>
            <Icon name="coin" /><b>{money(today)}</b>
          </button>

          <div className="hud-status"
            title={`${Object.keys(instances).length} агента в офисе, ${working} сейчас в работе`
              + (permissions.length > 0 ? ` · ${permissions.length} ждёт решения человека` : '')}>
            <span className="hud-status-item"><Icon name="activity" size={16} />{Object.keys(instances).length} · {working} в работе</span>
            <span className={`hud-status-item ${permissions.length ? 'alarm' : 'muted small'}`}>
              {permissions.length > 0 && <><Icon name="alert-circle" size={16} />{permissions.length} · </>}
              {review} на ревью
            </span>
          </div>

          <div className={`hud-chip access ${settings.officePermissionMode}`}
            title={`Режим доступа офиса: ${ACCESS_LABEL[settings.officePermissionMode]} — настраивается в ⚙`}>
            <Icon name={ACCESS_ICON[settings.officePermissionMode]} />
          </div>

          {paused && (
            <div className="hud-chip paused" title="Исполнители замирают на следующем действии">
              <Icon name="player-pause" size={16} /> ПАУЗА
            </div>
          )}
        </div>

        <span className="hud-sep" />

        <div className="hud-group hud-right">
          <button className={`hud-btn ${paused ? 'on' : ''}`} onClick={() => setPaused(!paused)}
            title={paused ? 'Продолжить работу — SPACE' : 'Пауза: остановить всех исполнителей — SPACE'}>
            <Icon name={paused ? 'player-play' : 'player-pause'} />
          </button>
          <button className="hud-btn" onClick={onTeam} title="Команда: роли, найм, увольнение">
            <Icon name="user-cog" /><span className="hud-label">Команда</span>
          </button>
          <button className="hud-btn" onClick={onMeeting} title="Созвать совещание — M">
            <Icon name="users" />
          </button>
          <button className={`hud-btn ${editingLayout ? 'on' : ''}`}
            onClick={() => setEditingLayout(!editingLayout)}
            title={editingLayout
              ? 'Выключить редактор расстановки'
              : 'Редактор расстановки: тащите мебель мышью'}>
            <Icon name="armchair" />
          </button>
          {editingLayout && (
            <button className="hud-btn" onClick={() => setConfirmReset(true)}
              title="Сбросить расстановку к пресету"><Icon name="rotate" /></button>
          )}

          <span className="hud-sep" />

          <button className={`hud-btn ${readyToMerge > 0 ? 'alert' : ''}`} onClick={onMergeQueue}
            title="Очередь слияния — Q">
            <Icon name="git-merge" />{readyToMerge > 0 && ` ${readyToMerge}`}
          </button>

          <span className="hud-sep" />

          <button className="hud-btn" onClick={() => setTheme(theme === 'day' ? 'night' : 'day')}
            title="Светлая или тёмная тема"><Icon name={theme === 'day' ? 'moon' : 'sun'} /></button>
          <button className="hud-btn" onClick={onSettings} title="Бюджет офиса"><Icon name="settings" /></button>
          <button className="hud-btn" onClick={onHelp} title="Справка"><Icon name="help" /></button>
          <button className="hud-btn" onClick={reset} title="Сбросить офис"><Icon name="refresh" /></button>

          <span className="hud-sep" />

          <span className={`link-dot ${connected ? 'on' : 'off'}`}
            title={connected ? 'связь с офисом есть' : 'нет связи с сервером'} />
          <span className={`auth ${authSource}`}
            title={authSource === 'api-key'
              ? 'Задан ключ API — расход идёт в платный API, а не в подписку'
              : 'Работает на авторизации Claude Code — расход в лимиты подписки'}>
            <Icon name={authSource === 'api-key' ? 'credit-card' : 'key'} size={18} />
          </span>
        </div>
      </div>

      {confirmReset && (
        <div className="modal-backdrop" onClick={() => setConfirmReset(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Сбросить расстановку?</h3>
            <p>
              Мебель вернётся туда, где стоит в пресете «
              {layouts.find((l) => l.id === settings.layoutId)?.title ?? settings.layoutId}
              ». Все сдвиги мышью пропадут.
            </p>
            <div className="modal-actions">
              <button onClick={() => setConfirmReset(false)}>Отмена</button>
              <button className="deny" onClick={() => { resetLayout(); setConfirmReset(false); }}>
                Да, сбросить
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

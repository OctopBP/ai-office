import { useState } from 'react';
import { ACCESS_LABEL, reset, resetLayout, setEditingLayout, setPaused, useStore } from './store';
import { OfficeSwitcher } from './OfficeSwitcher';

const money = (v: number) => `$${v.toFixed(2)}`;

const ACCESS_ICON: Record<string, string> = { auto: '🔓', 'ask-risky': '🔐', 'ask-writes': '🔒', readonly: '🚫' };

export function TopHud({ onSettings, onMeeting, onHelp, onUsage, onMergeQueue }: {
  onSettings: () => void; onMeeting: () => void; onHelp: () => void; onUsage: () => void;
  onMergeQueue: () => void;
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
      <OfficeSwitcher />

      <div className="hud right">
        <button className={`pixel money ${over ? 'over' : ''}`} onClick={onUsage}
          title="Расходы: токены, кеш, дни">
          <span className="ico">🪙</span>
          <div>
            <b>{money(today)}</b>
            <div className="muted small">
              сегодня · всего {money(usage.costUsd)}
              {settings.globalBudgetUsd !== null && ` из ${money(settings.globalBudgetUsd)}`}
            </div>
          </div>
        </button>

        <div className="pixel counters">
          <div>👥 {Object.keys(instances).length} агента · {working} в работе</div>
          <div className={permissions.length ? 'alarm' : 'muted small'}>
            {permissions.length > 0 && <>{permissions.length} ждёт решения ❗ · </>}
            {review} на ревью
          </div>
        </div>

        <div className={`pixel access-chip ${settings.officePermissionMode}`}
          title="Общий режим доступа офиса — настраивается в ⚙">
          {ACCESS_ICON[settings.officePermissionMode]} {ACCESS_LABEL[settings.officePermissionMode]}
        </div>

        {paused && <div className="pixel paused-chip" title="Исполнители замирают на следующем действии">⏸ ПАУЗА</div>}

        <button className="sq" onClick={leaveOffice}
          title="В меню — офис остаётся открытым, агенты продолжат работать — ESC">🏠</button>
        <button className={`sq ${paused ? 'on' : ''}`} onClick={() => setPaused(!paused)}
          title={paused ? 'Продолжить работу — SPACE' : 'Пауза: остановить всех исполнителей — SPACE'}>
          {paused ? '▶' : '⏸'}
        </button>
        <button className="sq" onClick={onMeeting} title="Созвать совещание — M">👥</button>
        <button className={`sq ${editingLayout ? 'on' : ''}`}
          onClick={() => setEditingLayout(!editingLayout)}
          title={editingLayout
            ? 'Выключить редактор расстановки'
            : 'Редактор расстановки: тащите мебель мышью'}>
          🪑
        </button>
        {editingLayout && (
          <button className="sq" onClick={() => setConfirmReset(true)}
            title="Сбросить расстановку к пресету">↺</button>
        )}
        <button className={`sq ${readyToMerge > 0 ? 'alert' : ''}`} onClick={onMergeQueue}
          title="Очередь слияния — Q">
          🔀{readyToMerge > 0 && ` ${readyToMerge}`}
        </button>
        <button className="sq" onClick={() => setTheme(theme === 'day' ? 'night' : 'day')}
          title="Светлая или тёмная тема">{theme === 'day' ? '🌙' : '☀️'}</button>
        <button className="sq" onClick={onSettings} title="Бюджет офиса">⚙</button>
        <button className="sq" onClick={onHelp} title="Справка">?</button>
        <button className="sq" onClick={reset} title="Сбросить офис">⟳</button>
        <span className={`link-dot ${connected ? 'on' : 'off'}`}
          title={connected ? 'связь с офисом есть' : 'нет связи с сервером'} />
        <span className={`auth ${authSource}`}
          title={authSource === 'api-key'
            ? 'Задан ключ API — расход идёт в платный API, а не в подписку'
            : 'Работает на авторизации Claude Code — расход в лимиты подписки'}>
          {authSource === 'api-key' ? '💳' : '🔑'}
        </span>
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

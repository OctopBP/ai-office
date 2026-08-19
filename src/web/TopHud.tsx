import { reset, useStore } from './store';

const money = (v: number) => `$${v.toFixed(2)}`;

export function TopHud({ onSettings, onMeeting, onHelp }: {
  onSettings: () => void; onMeeting: () => void; onHelp: () => void;
}) {
  const instances = useStore((s) => s.instances);
  const tasks = useStore((s) => s.tasks);
  const permissions = useStore((s) => s.permissions);
  const settings = useStore((s) => s.settings);
  const projectDir = useStore((s) => s.projectDir);
  const authSource = useStore((s) => s.authSource);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const connected = useStore((s) => s.connected);

  const list = Object.values(tasks);
  const spent = Object.values(instances).reduce((sum, i) => sum + i.costUsd, 0);
  const working = list.filter((t) => t.status === 'in_progress').length;
  const review = list.filter((t) => (t.status === 'review' || t.status === 'done') && t.branch && !t.merged).length;
  const over = settings.globalBudgetUsd !== null && spent >= settings.globalBudgetUsd;

  return (
    <>
      <div className="hud project pixel">
        <span className="ico">🏢</span>
        <div>
          <b>{projectDir.split('/').pop()}</b>
          <div className="muted mono">
            {projectDir} · тема «{theme === 'day' ? 'Лофт' : 'Ночь / неон'}»
          </div>
        </div>
      </div>

      <div className="hud right">
        <div className={`pixel money ${over ? 'over' : ''}`}>
          <span className="ico">🪙</span>
          <div>
            <b>{money(spent)}</b>
            <div className="muted small">
              сегодня · бюджет {settings.globalBudgetUsd !== null ? money(settings.globalBudgetUsd) : '—'}
            </div>
          </div>
        </div>

        <div className="pixel counters">
          <div>👥 {Object.keys(instances).length} агента · {working} в работе</div>
          <div className={permissions.length ? 'alarm' : 'muted small'}>
            {permissions.length > 0 && <>{permissions.length} ждёт решения ❗ · </>}
            {review} на ревью
          </div>
        </div>

        <button className="sq" onClick={onMeeting} title="Созвать совещание">▶</button>
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
    </>
  );
}

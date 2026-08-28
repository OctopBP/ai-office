import { useState } from 'react';
import { accessLabel, reset, resetLayout, setEditingLayout, setPaused, useStore } from './store';
import { OfficeSwitcher } from './OfficeSwitcher';
import { t } from './i18n';
import { Icon, type IconName } from './icons';

const money = (v: number) => `$${v.toFixed(2)}`;

const ACCESS_ICON: Record<string, IconName> = {
  auto: 'lock-open',
  'ask-risky': 'shield-lock',
  'ask-writes': 'lock',
  readonly: 'ban',
};

export function TopHud({ onSettings, onMeeting, onHelp, onMoney, onMergeQueue, onTeam }: {
  onSettings: () => void; onMeeting: () => void; onHelp: () => void; onMoney: () => void;
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
            title={t('hud.menu.hint')}>
            <Icon name="home" /><span className="hud-label">{t('hud.menu')}</span>
          </button>
        </div>

        <span className="hud-sep" />

        <div className="hud-group hud-center">
          <button className={`hud-btn hud-money ${over ? 'over' : ''}`} onClick={onMoney}
            title={t('hud.money.hint', { today: money(today), total: money(usage.costUsd) })
              + (settings.globalBudgetUsd !== null
                ? t('hud.money.cap', { cap: money(settings.globalBudgetUsd) })
                : '')}>
            <Icon name="coin" /><b>{money(today)}</b>
          </button>

          <div className="hud-status"
            title={t('hud.staff.hint', { n: Object.keys(instances).length, working })
              + (permissions.length > 0 ? t('hud.staff.waiting', { n: permissions.length }) : '')}>
            <span className="hud-status-item"><Icon name="activity" size={16} />{Object.keys(instances).length} · {t('hud.working', { n: working })}</span>
            <span className={`hud-status-item ${permissions.length ? 'alarm' : 'muted small'}`}>
              {permissions.length > 0 && <><Icon name="alert-circle" size={16} />{permissions.length} · </>}
              {t('hud.inReview', { n: review })}
            </span>
          </div>

          <div className={`hud-chip access ${settings.officePermissionMode}`}
            title={t('hud.access.hint', { mode: accessLabel(settings.officePermissionMode) })}>
            <Icon name={ACCESS_ICON[settings.officePermissionMode]} />
          </div>

          {paused && (
            <div className="hud-chip paused" title={t('hud.paused.hint')}>
              <Icon name="player-pause" size={16} /> {t('hud.paused')}
            </div>
          )}
        </div>

        <span className="hud-sep" />

        <div className="hud-group hud-right">
          <button className={`hud-btn ${paused ? 'on' : ''}`} onClick={() => setPaused(!paused)}
            title={t(paused ? 'hud.resume.hint' : 'hud.pause.hint')}>
            <Icon name={paused ? 'player-play' : 'player-pause'} />
          </button>
          <button className="hud-btn" onClick={onTeam} title={t('hud.team.hint')}>
            <Icon name="user-cog" /><span className="hud-label">{t('hud.team')}</span>
          </button>
          <button className="hud-btn" onClick={onMeeting} title={t('hud.meeting.hint')}>
            <Icon name="users" />
          </button>
          <button className={`hud-btn ${editingLayout ? 'on' : ''}`}
            onClick={() => setEditingLayout(!editingLayout)}
            title={t(editingLayout ? 'hud.layoutOff.hint' : 'hud.layoutOn.hint')}>
            <Icon name="armchair" />
          </button>
          {editingLayout && (
            <button className="hud-btn" onClick={() => setConfirmReset(true)}
              title={t('hud.layoutReset.hint')}><Icon name="rotate" /></button>
          )}

          <span className="hud-sep" />

          <button className={`hud-btn ${readyToMerge > 0 ? 'alert' : ''}`} onClick={onMergeQueue}
            title={t('hud.merge.hint')}>
            <Icon name="git-merge" />{readyToMerge > 0 && ` ${readyToMerge}`}
          </button>

          <span className="hud-sep" />

          <button className="hud-btn" onClick={() => setTheme(theme === 'day' ? 'night' : 'day')}
            title={t('hud.theme.hint')}><Icon name={theme === 'day' ? 'moon' : 'sun'} /></button>
          <button className="hud-btn" onClick={onSettings} title={t('hud.settings.hint')}><Icon name="settings" /></button>
          <button className="hud-btn" onClick={onHelp} title={t('hud.help.hint')}><Icon name="help" /></button>
          <button className="hud-btn" onClick={reset} title={t('hud.reset.hint')}><Icon name="refresh" /></button>

          <span className="hud-sep" />

          <span className={`link-dot ${connected ? 'on' : 'off'}`}
            title={t(connected ? 'hud.online' : 'hud.offline')} />
          <span className={`auth ${authSource}`}
            title={t(authSource === 'api-key' ? 'hud.auth.key' : 'hud.auth.subscription')}>
            <Icon name={authSource === 'api-key' ? 'credit-card' : 'key'} size={18} />
          </span>
        </div>
      </div>

      {confirmReset && (
        <div className="modal-backdrop" onClick={() => setConfirmReset(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('hud.layoutReset.title')}</h3>
            <p>
              {t('hud.layoutReset.body', {
                preset: layouts.find((l) => l.id === settings.layoutId)?.title ?? settings.layoutId,
              })}
            </p>
            <div className="modal-actions">
              <button onClick={() => setConfirmReset(false)}>{t('common.cancel')}</button>
              <button className="deny" onClick={() => { resetLayout(); setConfirmReset(false); }}>
                {t('hud.layoutReset.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

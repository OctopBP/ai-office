import { useState } from 'react';
import {
  accessLabel, fullAccessWarning, permissionSourceLabel, effectivePermissionMode, fire,
  openLayoutSettings, permissionSource, setAgentPermission, useStore,
} from './store';
import { t } from './i18n';
import { usageLine } from './money';
import { Icon } from './icons';
import { AgentAvatar } from './office3d/AgentAvatar';
import type { PermissionMode } from '../shared/types';

const money = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;

const PERM_OPTIONS: PermissionMode[] = ['readonly', 'ask-writes', 'ask-risky', 'auto'];

/**
 * Карточка сотрудника в окне «Команда»: режим доступа, стол, расходы.
 * Полный дровер с задачами и транскриптом остаётся на клике по человечку
 * в комнате (AgentDrawer) — здесь только то, что нужно для управления штатом.
 */
export function EmployeeCard({ instanceId }: { instanceId: string }) {
  const inst = useStore((s) => s.instances[instanceId]);
  const role = useStore((s) => s.roles.find((r) => r.id === inst?.roleId));
  const settings = useStore((s) => s.settings);
  const [confirmAuto, setConfirmAuto] = useState(false);

  if (!inst) return <p className="muted small">{t('employee.gone')}</p>;

  const roleFallbackLabel = role ? accessLabel(effectivePermissionMode(role, settings)) : '';
  const chooseMode = (mode: PermissionMode | null) => {
    if (mode === 'auto') { setConfirmAuto(true); return; }
    setAgentPermission(inst.id, mode);
  };

  const busy = Boolean(inst.currentTaskId);
  const fireDisabled = Boolean(role?.isManager) || busy;
  const fireTitle = role?.isManager
    ? t('employee.pmCannotFire')
    : busy
      ? t('employee.busyHint', { task: inst.currentTaskId ?? '' })
      : t('employee.fireHint');

  return (
    <div className="employee-card">
      <div className="employee-card-head">
        <AgentAvatar
          roleId={inst.roleId} instanceId={inst.id} look={role?.sprite} className="employee-avatar"
        />
        <div>
          <h3>{inst.id}</h3>
          <p className="muted">{role?.title} · {role?.model.replace('claude-', '')}</p>
        </div>
      </div>

      {inst.deskless && (
        <div className="deskless-notice">
          <Icon name="armchair" size={16} /> {t('employee.deskless', { index: inst.desk.index })}{' '}
          <button className="link" onClick={openLayoutSettings}>{t('employee.layoutSettings')}</button>
        </div>
      )}

      <section>
        <h4 className="section-title">{t('employee.desk')}</h4>
        <p className="muted small">
          {inst.deskless ? t('employee.noDesk') : t('employee.deskNo', { index: inst.desk.index })}
        </p>
      </section>

      <section>
        <h4 className="section-title">{t('employee.access')}</h4>
        <label>{t('employee.personalMode')}
          <select
            value={inst.permissionMode ?? ''}
            onChange={(e) => chooseMode(e.target.value === '' ? null : e.target.value as PermissionMode)}
          >
            <option value="">{t('employee.asRole', { mode: roleFallbackLabel })}</option>
            {PERM_OPTIONS.map((m) => <option key={m} value={m}>{accessLabel(m)}</option>)}
          </select>
          <span className="hint">
            {inst.permissionMode
              ? t('employee.ownRule', { mode: accessLabel(inst.permissionMode) })
              : t('employee.roleRule', { mode: roleFallbackLabel })}
          </span>
        </label>
        <span className={`perm-badge ${inst.effectivePermissionMode}`}>
          <Icon name={inst.effectivePermissionMode === 'auto' ? 'lock-open' : 'shield-lock'} size={14} />{' '}
          {accessLabel(inst.effectivePermissionMode)} · {permissionSourceLabel(permissionSource(inst, role))}
        </span>
        {confirmAuto && (
          <div className="access-confirm">
            <p>{fullAccessWarning()}</p>
            <div className="modal-actions">
              <button onClick={() => setConfirmAuto(false)}>{t('common.cancel')}</button>
              <button className="danger" onClick={() => { setAgentPermission(inst.id, 'auto'); setConfirmAuto(false); }}>
                {t('settings.access.confirm')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h4 className="section-title">{t('usage.title.short')}</h4>
        <div className="usage-lines">
          <div>
            <b>{money(inst.today.costUsd)}</b> {t('usage.forToday')} ·{' '}
            <span className="muted">{usageLine(inst.today)}</span>
          </div>
          <div className="muted">
            {money(inst.usage.costUsd)} {t('usage.forAllTime')} · {usageLine(inst.usage)}
          </div>
        </div>
      </section>

      <div className="modal-actions">
        <button className="link-danger" disabled={fireDisabled} title={fireTitle} onClick={() => fire(inst.id)}>
          {t('employee.fire')}
        </button>
      </div>
    </div>
  );
}

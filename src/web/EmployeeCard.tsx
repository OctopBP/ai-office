import { useState } from 'react';
import {
  ACCESS_LABEL, FULL_ACCESS_WARNING, PERMISSION_SOURCE_LABEL, effectivePermissionMode, fire,
  openLayoutSettings, permissionSource, setAgentPermission, useStore,
} from './store';
import { usageLine } from './UsageModal';
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

  if (!inst) return <p className="muted small">Сотрудника больше нет — его уволили или он был удалён вместе с ролью.</p>;

  const roleFallbackLabel = role ? ACCESS_LABEL[effectivePermissionMode(role, settings)] : '';
  const chooseMode = (mode: PermissionMode | null) => {
    if (mode === 'auto') { setConfirmAuto(true); return; }
    setAgentPermission(inst.id, mode);
  };

  const busy = Boolean(inst.currentTaskId);
  const fireDisabled = Boolean(role?.isManager) || busy;
  const fireTitle = role?.isManager
    ? 'PM — единственный, кого нельзя уволить'
    : busy ? `Занят задачей ${inst.currentTaskId} — сначала остановите или дождитесь` : 'Уволить сотрудника';

  return (
    <div className="employee-card">
      <h3>{inst.id}</h3>
      <p className="muted">{role?.title} · {role?.model.replace('claude-', '')}</p>

      {inst.deskless && (
        <div className="deskless-notice">
          🪑 Рабочего места сейчас нет — в раскладке не хватило столов на всех. Номер места
          #{inst.desk.index} за сотрудником сохранён: вернётся раскладка попросторнее — он
          сядет обратно.{' '}
          <button className="link" onClick={openLayoutSettings}>Настройки раскладки →</button>
        </div>
      )}

      <section>
        <h4>Стол</h4>
        <p className="muted small">
          {inst.deskless ? 'сейчас стоит без места' : `место #${inst.desk.index}`}
        </p>
      </section>

      <section>
        <h4>Доступ</h4>
        <label>Личный режим доступа
          <select
            value={inst.permissionMode ?? ''}
            onChange={(e) => chooseMode(e.target.value === '' ? null : e.target.value as PermissionMode)}
          >
            <option value="">Как у роли (сейчас: {roleFallbackLabel})</option>
            {PERM_OPTIONS.map((m) => <option key={m} value={m}>{ACCESS_LABEL[m]}</option>)}
          </select>
          <span className="hint">
            {inst.permissionMode
              ? `У сотрудника своё правило — переопределено на «${ACCESS_LABEL[inst.permissionMode]}».`
              : `Сотрудник использует режим роли: «${roleFallbackLabel}».`}
          </span>
        </label>
        <span className={`perm-badge ${inst.effectivePermissionMode}`}>
          {inst.effectivePermissionMode === 'auto' ? '🔓' : '🔐'}{' '}
          {ACCESS_LABEL[inst.effectivePermissionMode]} · {PERMISSION_SOURCE_LABEL[permissionSource(inst, role)]}
        </span>
        {confirmAuto && (
          <div className="access-confirm">
            <p>{FULL_ACCESS_WARNING}</p>
            <div className="modal-actions">
              <button onClick={() => setConfirmAuto(false)}>Отмена</button>
              <button className="danger" onClick={() => { setAgentPermission(inst.id, 'auto'); setConfirmAuto(false); }}>
                Да, включить полный доступ
              </button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h4>Расходы</h4>
        <div className="usage-lines">
          <div><b>{money(inst.today.costUsd)}</b> за сегодня · <span className="muted">{usageLine(inst.today)}</span></div>
          <div className="muted">{money(inst.usage.costUsd)} за всё время · {usageLine(inst.usage)}</div>
        </div>
      </section>

      <div className="modal-actions">
        <button className="link-danger" disabled={fireDisabled} title={fireTitle} onClick={() => fire(inst.id)}>
          Уволить
        </button>
      </div>
    </div>
  );
}

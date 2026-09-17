import { useStore, decide } from './store';
import { t } from './i18n';

const riskLabel = (risk: string): string => (
  risk === 'danger' ? t('perm.risk.danger')
    : risk === 'write' ? t('perm.risk.write')
      : risk === 'safe' ? t('perm.risk.safe')
        : risk);

export function PermissionModal() {
  const queue = useStore((s) => s.permissions);
  const instances = useStore((s) => s.instances);
  if (queue.length === 0) return null;

  const req = queue[0];
  const agent = instances[req.agentId];

  return (
    <div className="modal-backdrop">
      <div className={`modal ${req.risk}`}>
        <div className="modal-head">
          <span className={`risk ${req.risk}`}>{riskLabel(req.risk)}</span>
          {queue.length > 1 && (
            <span className="muted">{t('perm.more', { n: queue.length - 1 })}</span>
          )}
        </div>

        <h3>
          {t('perm.asks', { who: agent?.label ?? req.agentId })}
          {req.taskId && <span className="muted"> · {req.taskId}</span>}
        </h3>
        <p className="modal-reason">{req.reason}</p>

        <div className="modal-tool mono">{req.toolName}</div>
        <pre className="modal-detail">{req.detail || req.summary}</pre>

        <div className="modal-actions stacked">
          <div className="modal-actions-row">
            <button className="deny" onClick={() => decide(req.id, 'deny')}>
              {t('perm.deny')}
            </button>
            <button className="allow" onClick={() => decide(req.id, 'allow')}>
              {t('perm.allowOnce')}
            </button>
          </div>
          <div className="modal-actions-row secondary">
            <button className="always" onClick={() => decide(req.id, 'always')}>
              {t('perm.always')}
            </button>
            <button className="never" onClick={() => decide(req.id, 'never')}>
              {t('perm.never')}
            </button>
          </div>
        </div>
        <p className="modal-hint muted">
          {t('perm.hint.before')} <code className="mono">{req.key}</code> {t('perm.hint.after')}
        </p>
      </div>
    </div>
  );
}

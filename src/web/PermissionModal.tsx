import { useStore, decide } from './store';

const RISK_LABEL: Record<string, string> = {
  danger: 'Необратимое действие',
  write: 'Изменение',
  safe: 'Безопасно',
};

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
          <span className={`risk ${req.risk}`}>{RISK_LABEL[req.risk] ?? req.risk}</span>
          {queue.length > 1 && <span className="muted">ещё {queue.length - 1} в очереди</span>}
        </div>

        <h3>
          {agent?.label ?? req.agentId} просит разрешение
          {req.taskId && <span className="muted"> · {req.taskId}</span>}
        </h3>
        <p className="modal-reason">{req.reason}</p>

        <div className="modal-tool mono">{req.toolName}</div>
        <pre className="modal-detail">{req.detail || req.summary}</pre>

        <div className="modal-actions">
          <button className="deny" onClick={() => decide(req.id, 'deny')}>
            Запретить
          </button>
          <button className="allow" onClick={() => decide(req.id, 'allow')}>
            Разрешить один раз
          </button>
          <button className="always" onClick={() => decide(req.id, 'always')}>
            Всегда разрешать
          </button>
          <button className="never" onClick={() => decide(req.id, 'never')}>
            Всегда запрещать
          </button>
        </div>
        <p className="modal-hint muted">
          «Всегда» запомнит <code className="mono">{req.key}</code> для этой роли до перезапуска
          сервера — разрешая или запрещая без вопросов. Без ответа запрос отклонится через 10 минут.
        </p>
      </div>
    </div>
  );
}

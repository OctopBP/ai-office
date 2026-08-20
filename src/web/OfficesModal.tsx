import { useState } from 'react';
import { createOffice, renameOffice, switchOffice, useStore } from './store';

/**
 * Дверь офиса: список проектов и создание нового. Офис = проект: своя
 * рабочая директория, своя доска и свои расходы.
 */
export function OfficesModal({ onClose }: { onClose: () => void }) {
  const offices = useStore((s) => s.offices);
  const tasks = useStore((s) => s.tasks);
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [creating, setCreating] = useState(false);

  const busy = Object.values(tasks).some((t) => t.status === 'in_progress');

  const create = () => {
    if (!dir.trim()) return;
    createOffice(name.trim(), dir.trim());
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Офисы и проекты</h3>
        <p className="modal-reason">
          Офис — это проект: своя рабочая директория, доска, расходы и история.
          Переключение не перезапускает сервер, но задачи в работе трогать нельзя.
        </p>

        <div className="offices">
          {offices.map((o) => (
            <div key={o.id} className={`office-row ${o.current ? 'current' : ''}`}>
              <div className="office-who">
                <b>{o.name}</b>
                <div className="muted mono">{o.projectDir}</div>
              </div>
              {o.current ? (
                <span className="chip done">открыт</span>
              ) : (
                <button className="mini go" disabled={busy}
                  title={busy ? 'Сначала дождитесь или остановите задачи в работе' : 'Открыть этот офис'}
                  onClick={() => { switchOffice(o.id); onClose(); }}>
                  открыть
                </button>
              )}
              <button className="mini" title="Переименовать"
                onClick={() => {
                  const next = prompt('Название офиса', o.name);
                  if (next) renameOffice(o.id, next);
                }}>
                ✎
              </button>
            </div>
          ))}
        </div>

        {busy && (
          <p className="hint muted">
            Пока идут задачи, переключаться нельзя: их сессии живут в директории этого офиса.
          </p>
        )}

        {creating ? (
          <>
            <label>Название
              <input value={name} placeholder="Новый проект"
                onChange={(e) => setName(e.target.value)} />
            </label>
            <label>Директория проекта
              <input value={dir} placeholder="/Users/you/projects/my-app"
                onChange={(e) => setDir(e.target.value)} />
              <span className="hint muted">
                Абсолютный путь. Если папки нет, офис создаст её и заведёт git-репозиторий —
                без него не работает изоляция задач по веткам.
              </span>
            </label>
            <div className="modal-actions">
              <button onClick={() => setCreating(false)}>Отмена</button>
              <button className="allow" onClick={create}>Создать и открыть</button>
            </div>
          </>
        ) : (
          <div className="modal-actions">
            <button onClick={onClose}>Закрыть</button>
            <button className="allow" onClick={() => setCreating(true)}>＋ Новый офис</button>
          </div>
        )}
      </div>
    </div>
  );
}

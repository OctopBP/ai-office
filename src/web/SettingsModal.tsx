import { useState } from 'react';
import { updateSettings, useStore } from './store';

const parse = (v: string): number | null => {
  const n = Number(v.replace(',', '.'));
  return v.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n;
};

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const [global, setGlobal] = useState(settings.globalBudgetUsd?.toString() ?? '');
  const [perTask, setPerTask] = useState(settings.taskBudgetUsd?.toString() ?? '');

  const save = () => {
    updateSettings({ globalBudgetUsd: parse(global), taskBudgetUsd: parse(perTask) });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Бюджет офиса</h3>
        <p className="modal-reason">Пустое поле — без ограничения.</p>

        <label>Общий потолок, $
          <input value={global} placeholder="без ограничения"
            onChange={(e) => setGlobal(e.target.value)} />
          <span className="hint muted">
            Когда потрачено больше — PM перестаёт запускать новые задачи. Уже идущие
            дорабатывают: обрывать их посреди работы дороже, чем дать закончить.
          </span>
        </label>

        <label>Потолок на одну задачу, $
          <input value={perTask} placeholder="без ограничения"
            onChange={(e) => setPerTask(e.target.value)} />
          <span className="hint muted">
            Жёсткий стоп внутри сессии исполнителя: превысив лимит, он остановится
            и вернёт задачу с пометкой о бюджете.
          </span>
        </label>

        <div className="modal-actions">
          <button onClick={onClose}>Отмена</button>
          <button className="allow" onClick={save}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

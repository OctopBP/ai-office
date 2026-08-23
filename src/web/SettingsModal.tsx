import { useState } from 'react';
import { ACCESS_MODES, FULL_ACCESS_WARNING, parseTaskMaxTurns, setCloudToken, updateSettings, useStore } from './store';
import type { PermissionMode } from '../shared/types';

const parse = (v: string): number | null => {
  const n = Number(v.replace(',', '.'));
  return v.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n;
};

type Section = 'access' | 'limits' | 'project';

const SECTIONS: Array<[Section, string]> = [
  ['access', 'Доступ'],
  ['limits', 'Модели и лимиты'],
  ['project', 'Проект'],
];

// Раздел держится на время сессии вкладки: закрыли окно, открыли снова — курсор
// остаётся там же, где был, а не прыгает на первый пункт.
let lastSection: Section = 'access';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const cloud = useStore((s) => s.cloud);
  const layouts = useStore((s) => s.layouts);
  const [section, setSection] = useState<Section>(lastSection);
  const [global, setGlobal] = useState(settings.globalBudgetUsd?.toString() ?? '');
  const [perTask, setPerTask] = useState(settings.taskBudgetUsd?.toString() ?? '');
  const [maxTurns, setMaxTurns] = useState(settings.taskMaxTurns?.toString() ?? '');
  const [engine, setEngine] = useState(settings.engine);
  const [repo, setRepo] = useState(settings.cloudRepoUrl ?? '');
  const [layoutId, setLayoutId] = useState(settings.layoutId);
  const [token, setToken] = useState('');
  const [access, setAccess] = useState(settings.officePermissionMode);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const maxTurnsParsed = parseTaskMaxTurns(maxTurns);

  const chooseSection = (id: Section) => {
    lastSection = id;
    setSection(id);
    setConfirmAuto(false);
  };

  const chooseAccess = (mode: PermissionMode) => {
    // Полный доступ — опасное состояние, включаем только после явного подтверждения.
    if (mode === 'auto' && access !== 'auto') { setConfirmAuto(true); return; }
    setAccess(mode);
  };

  const save = () => {
    updateSettings({
      globalBudgetUsd: parse(global),
      taskBudgetUsd: parse(perTask),
      // Значение вне диапазона не отправляем — на месте останется то, что было в настройках.
      ...(maxTurnsParsed.error ? {} : { taskMaxTurns: maxTurnsParsed.value }),
      engine,
      cloudRepoUrl: repo.trim() || null,
      officePermissionMode: access,
      layoutId,
    });
    if (token.trim()) setCloudToken(token.trim());
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Настройки офиса</h3>

        <div className="settings-layout">
          <div className="settings-nav">
            {SECTIONS.map(([id, label]) => (
              <button key={id} className={section === id ? 'on' : ''} onClick={() => chooseSection(id)}>
                {label}
              </button>
            ))}
          </div>

          <div className="settings-content">
            {section === 'access' && (
              <>
                <h4>Режим доступа</h4>
                <div className="engine access-modes">
                  {ACCESS_MODES.map(([id, label, hint]) => (
                    <button key={id} className={`${access === id ? 'on' : ''} ${id}`.trim()}
                      onClick={() => chooseAccess(id)}>
                      {label}
                      <span className="muted small">{hint}</span>
                    </button>
                  ))}
                </div>
                {confirmAuto && (
                  <div className="access-confirm">
                    <p>{FULL_ACCESS_WARNING}</p>
                    <div className="modal-actions">
                      <button onClick={() => setConfirmAuto(false)}>Отмена</button>
                      <button className="danger" onClick={() => { setAccess('auto'); setConfirmAuto(false); }}>
                        Да, включить полный доступ
                      </button>
                    </div>
                  </div>
                )}
                <p className="hint muted">
                  Это правило по умолчанию для всех ролей. У конкретной роли можно выставить свой режим
                  в настройке роли — он переопределит общий.
                </p>
              </>
            )}

            {section === 'limits' && (
              <>
                <p className="modal-reason">Пустое поле бюджета — без ограничения.</p>

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
                    Локально это лимит внутри сессии исполнителя; в облаке — жёсткий потолок
                    сессии: дойдя до него, она встаёт на паузу.
                  </span>
                </label>
                <label>Лимит шагов исполнителя
                  <input value={maxTurns} placeholder="без ограничения"
                    onChange={(e) => setMaxTurns(e.target.value)} />
                  <span className="hint muted">
                    Потолок ходов одной сессии исполнителя: инструмент, ответ модели, снова
                    инструмент — и так далее. Пустое поле — без ограничения. Именно этот лимит
                    даёт ошибку «Reached maximum number of turns», если сессия упирается в потолок
                    посреди задачи.
                  </span>
                  {maxTurnsParsed.error && <span className="hint error">{maxTurnsParsed.error}</span>}
                </label>
              </>
            )}

            {section === 'project' && (
              <>
                <h4>Раскладка офиса</h4>
                <div className="engine">
                  {layouts.map((l) => (
                    <button key={l.id} className={layoutId === l.id ? 'on' : ''} onClick={() => setLayoutId(l.id)}>
                      {l.title}
                    </button>
                  ))}
                </div>
                <p className="hint muted">
                  Раскладка задаёт планировку комнаты — пол, стены и расстановку мебели. После
                  сохранения сотрудники пересядут за столы новой раскладки.
                </p>

                <h4>Где работают исполнители</h4>
                <div className="engine">
                  <button className={engine === 'local' ? 'on' : ''} onClick={() => setEngine('local')}>
                    💻 Локально
                    <span className="muted small">Claude Code на этой машине, расход в лимиты подписки</span>
                  </button>
                  <button className={engine === 'cloud' ? 'on' : ''} onClick={() => setEngine('cloud')}>
                    ☁️ В облаке
                    <span className="muted small">Managed Agents, расход в платный API</span>
                  </button>
                </div>

                {engine === 'cloud' && (
                  <>
                    <p className="hint muted">
                      В облаке цикл агента и контейнер держит Anthropic. Файлы рождаются не в вашей
                      папке, поэтому проект должен лежать на GitHub: контейнер монтирует репозиторий,
                      исполнитель пушит ветку задачи, а офис забирает её к себе. Песочница ОС и
                      классификатор рисков к контейнеру не применяются — границу держит он сам;
                      подтверждения по режиму роли остаются.
                    </p>

                    <div className={`ready ${cloud.hasKey ? 'ok' : 'bad'}`}>
                      {cloud.hasKey
                        ? '✓ ANTHROPIC_API_KEY задан — облачный режим доступен'
                        : '✗ Нет ANTHROPIC_API_KEY: задайте ключ и перезапустите сервер'}
                    </div>

                    <label>Репозиторий на GitHub
                      <input value={repo} placeholder="https://github.com/owner/repo"
                        onChange={(e) => setRepo(e.target.value)} />
                      <span className="hint muted">
                        Тот же репозиторий, что открыт локально, — иначе ветку задачи будет некуда забрать.
                      </span>
                    </label>

                    <label>Токен GitHub {cloud.hasToken && <span className="chip done">задан</span>}
                      <input value={token} type="password" placeholder={cloud.hasToken ? '••••••• (оставьте пустым, чтобы не менять)' : 'ghp_…'}
                        onChange={(e) => setToken(e.target.value)} />
                      <span className="hint muted">
                        Нужен доступ Contents: Read and write. Токен живёт только в памяти сервера и
                        на диск не пишется — после перезапуска введите заново или задайте
                        <code className="mono"> OFFICE_GITHUB_TOKEN</code>. В контейнер он не попадает:
                        git-запросы проксируются, и токен подставляется уже за его пределами.
                      </span>
                    </label>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>Отмена</button>
          <button className="allow" onClick={save}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

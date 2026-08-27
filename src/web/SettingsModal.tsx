import { useEffect, useState } from 'react';
import {
  ACCESS_MODES, clearSettingsSection, FULL_ACCESS_WARNING, parseMaxWorkers, parseTaskMaxTurns,
  setCloudToken, updateSettings, useStore,
} from './store';
import { DEFAULT_OFFICE_WORKERS, DEFAULT_PROCESS_WORKERS, type PermissionMode } from '../shared/types';
import { DEFAULT_GRAPHICS, GRAPHICS_RANGE, type Graphics } from './office3d/graphics';

const parse = (v: string): number | null => {
  const n = Number(v.replace(',', '.'));
  return v.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n;
};

type Section = 'access' | 'limits' | 'project' | 'graphics';

const SECTIONS: Array<[Section, string]> = [
  ['access', 'Доступ'],
  ['limits', 'Модели и лимиты'],
  ['project', 'Проект'],
  ['graphics', 'Графика'],
];

/** Ползунок настройки картинки: подпись, значение справа и сам range.
 *  Значение показывается рядом всегда — вслепую двигать нечего, окно
 *  закрывает комнату, и увидеть результат можно только после сохранения. */
function Slider({ label, hint, value, range, decimals = 0, disabled, onChange }: {
  label: string;
  hint: string;
  value: number;
  range: { min: number; max: number; step: number };
  decimals?: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className={`slider${disabled ? ' off' : ''}`}>
      <span className="slider-head">
        {label}
        <b className="mono">{value.toFixed(decimals)}</b>
      </span>
      <input
        type="range" value={value} disabled={disabled}
        min={range.min} max={range.max} step={range.step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="hint muted">{hint}</span>
    </label>
  );
}

// Раздел держится на время сессии вкладки: закрыли окно, открыли снова — курсор
// остаётся там же, где был, а не прыгает на первый пункт.
let lastSection: Section = 'access';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const cloud = useStore((s) => s.cloud);
  const graphics = useStore((s) => s.graphics);
  const render3d = useStore((s) => s.render3d);
  const setGraphics = useStore((s) => s.setGraphics);
  const layouts = useStore((s) => s.layouts);
  // Запрос конкретного раздела (например, ссылка «настройки раскладки» из
  // карточки безместного сотрудника) перебивает запомненный за сессию раздел.
  const settingsSection = useStore((s) => s.settingsSection);
  const [section, setSection] = useState<Section>(settingsSection ?? lastSection);
  useEffect(() => {
    if (!settingsSection) return;
    lastSection = settingsSection;
    setSection(settingsSection);
    clearSettingsSection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsSection]);
  const [global, setGlobal] = useState(settings.globalBudgetUsd?.toString() ?? '');
  const [perTask, setPerTask] = useState(settings.taskBudgetUsd?.toString() ?? '');
  const [maxTurns, setMaxTurns] = useState(settings.taskMaxTurns?.toString() ?? '');
  const [maxWorkers, setMaxWorkers] = useState(
    (settings.maxConcurrentWorkers ?? DEFAULT_OFFICE_WORKERS).toString());
  const [engine, setEngine] = useState(settings.engine);
  const [repo, setRepo] = useState(settings.cloudRepoUrl ?? '');
  const [layoutId, setLayoutId] = useState(settings.layoutId);
  const [token, setToken] = useState('');
  const [access, setAccess] = useState(settings.officePermissionMode);
  const [gfx, setGfx] = useState<Graphics>(graphics);
  const patchGfx = (patch: Partial<Graphics>) => setGfx((g) => ({ ...g, ...patch }));
  const [autoPipeline, setAutoPipeline] = useState(settings.autoPipeline);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const maxTurnsParsed = parseTaskMaxTurns(maxTurns);
  const maxWorkersParsed = parseMaxWorkers(maxWorkers);

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
      // Пустое поле лимита исполнителей — «не менять»: «без ограничения»
      // здесь не бывает, и null сервер всё равно отбросил бы.
      ...(maxWorkersParsed.value === null ? {} : { maxConcurrentWorkers: maxWorkersParsed.value }),
      engine,
      cloudRepoUrl: repo.trim() || null,
      officePermissionMode: access,
      layoutId,
      autoPipeline,
    });
    setGraphics(gfx);
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

                <div className="row2">
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
                </div>
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

                <label>Одновременно исполнителей
                  <input value={maxWorkers} placeholder={DEFAULT_OFFICE_WORKERS.toString()}
                    onChange={(e) => setMaxWorkers(e.target.value)} />
                  <span className="hint muted">
                    Сколько сессий исполнителей этого офиса работают разом. Лимит действует
                    на этот офис: остальные задачи ждут очереди на доске и стартуют сами, как
                    только слот освободится. Поверх офисного действует общий потолок на весь
                    процесс (по умолчанию {DEFAULT_PROCESS_WORKERS} сессий на все офисы сразу,
                    меняется переменной окружения <code className="mono">OFFICE_MAX_WORKERS</code>):
                    он и решает, если открыто несколько офисов. Менеджера и ревью лимит не
                    трогает — они идут всегда.
                  </span>
                  {maxWorkersParsed.error && <span className="hint error">{maxWorkersParsed.error}</span>}
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

                <h4>Ревью и слияние</h4>
                <div className="engine">
                  <button className={autoPipeline ? 'on' : ''} onClick={() => setAutoPipeline(true)}>
                    🔁 Конвейером
                    <span className="muted small">
                      Сдал → подтянуть основную ветку → проверки → пулл-реквест → ревью → слияние
                    </span>
                  </button>
                  <button className={autoPipeline ? '' : 'on'} onClick={() => setAutoPipeline(false)}>
                    ✋ Вручную
                    <span className="muted small">Ветки копятся, сливаете сами в панели «Ревью и слияние»</span>
                  </button>
                </div>
                <p className="hint muted">
                  Конвейер ведёт сданную задачу сам: подтягивает основную ветку в ветку задачи и
                  отдаёт конфликты автору, гоняет проверки проекта, открывает пулл-реквест, зовёт
                  ревьюера и по одобрению вливает, а ветку и рабочую копию убирает. Вставшее офис
                  перезапускает сам, а чего не может — передаёт менеджеру. Ревьюер должен быть
                  нанят: иначе ревьюить некому. Есть токен GitHub и origin на github.com —
                  пулл-реквест будет настоящим; нет — тот же порядок пройдёт внутри офиса.
                </p>

                <label>Токен GitHub {cloud.hasToken && <span className="chip done">задан</span>}
                  <input value={token} type="password" placeholder={cloud.hasToken ? '••••••• (оставьте пустым, чтобы не менять)' : 'ghp_…'}
                    onChange={(e) => setToken(e.target.value)} />
                  <span className="hint muted">
                    Нужен доступ Contents и Pull requests: Read and write. Токен живёт только в
                    памяти сервера и на диск не пишется — после перезапуска введите заново или
                    задайте <code className="mono">OFFICE_GITHUB_TOKEN</code>. Без него конвейер
                    работает локально, а облачный режим — не работает вовсе.
                  </span>
                </label>

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

                    <p className="hint muted">
                      Токен GitHub задаётся выше, в разделе «Ревью и слияние»: он один и тот же и
                      для пулл-реквестов, и для облака. В контейнер он не попадает — git-запросы
                      проксируются, и токен подставляется уже за его пределами.
                    </p>
                  </>
                )}
              </>
            )}

            {section === 'graphics' && (
              <>
                <h4>Пикселизация</h4>
                <div className="engine">
                  <button className={gfx.pixelate ? 'on' : ''} onClick={() => patchGfx({ pixelate: true })}>
                    🟪 Включена
                    <span className="muted small">Комната рисуется в низком разрешении, с контуром по граням</span>
                  </button>
                  <button className={gfx.pixelate ? '' : 'on'} onClick={() => patchGfx({ pixelate: false })}>
                    🔷 Выключена
                    <span className="muted small">Обычный гладкий рендер</span>
                  </button>
                </div>
                <p className="hint muted">
                  Свет, тени и облёт остаются теми же — меняется только то, чем сцена показана:
                  она рисуется в низкое разрешение и растягивается без сглаживания, а по изломам
                  и границам предметов дорисовываются контуры. Подписи и облачка реплик остаются
                  чёткими: они не часть картинки, а обычный текст поверх неё.
                </p>

                <Slider
                  label="Размер пикселя" value={gfx.pixelSize} range={GRAPHICS_RANGE.pixelSize}
                  disabled={!gfx.pixelate} onChange={(v) => patchGfx({ pixelSize: v })}
                  hint={'Сторона клетки в точках экрана. Чем крупнее, тем меньше разрешение, в '
                    + 'котором считается комната: мебель грубеет, зато вид ближе к пиксель-арту.'}
                />
                <Slider
                  label="Контур на изломах" value={gfx.normalEdge} range={GRAPHICS_RANGE.normalEdge}
                  decimals={2} disabled={!gfx.pixelate}
                  onChange={(v) => patchGfx({ normalEdge: v })}
                  hint={'Светлая линия там, где поверхность ломается, — рёбра столов, углы стен. '
                    + 'Ноль убирает её совсем.'}
                />
                <Slider
                  label="Контур по глубине" value={gfx.depthEdge} range={GRAPHICS_RANGE.depthEdge}
                  decimals={2} disabled={!gfx.pixelate}
                  onChange={(v) => patchGfx({ depthEdge: v })}
                  hint={'Тёмная обводка там, где предмет кончается и начинается то, что за ним. '
                    + 'Отделяет мебель от пола, но на мелком пикселе быстро становится грязью.'}
                />

                <div className="engine">
                  <button onClick={() => setGfx(DEFAULT_GRAPHICS)}>Вернуть значения по умолчанию</button>
                </div>

                {!render3d && (
                  <p className="hint muted">
                    Сейчас офис показан плоским рендером, и настройки этого раздела на него не
                    влияют — они про трёхмерную комнату. Переключает клавиша <code className="mono">0</code>.
                  </p>
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

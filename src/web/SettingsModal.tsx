import { useEffect, useState } from 'react';
import {
  accessModes, clearSettingsSection, fullAccessWarning, parseMaxWorkers, parseTaskMaxTurns,
  setCloudToken, updateSettings, useStore,
} from './store';
import {
  DEFAULT_FOCUS_EPICS, DEFAULT_OFFICE_WORKERS, DEFAULT_PROCESS_WORKERS,
  MAX_FOCUS_EPICS, MIN_FOCUS_EPICS, type McpServerDef, type PermissionMode,
} from '../shared/types';
import { LANGS, LANG_TITLE, type Lang } from '../shared/i18n';
import { DEFAULT_GRAPHICS, GRAPHICS_RANGE, type Graphics } from './office3d/graphics';
import { t, type UiKey } from './i18n';
import { McpCatalog, type McpRequest } from './McpCatalog';
import { Icon } from './icons';

const parse = (v: string): number | null => {
  const n = Number(v.replace(',', '.'));
  return v.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n;
};

type Section = 'general' | 'access' | 'limits' | 'tools' | 'project' | 'graphics';

const SECTIONS: Array<[Section, UiKey]> = [
  ['general', 'settings.section.general'],
  ['access', 'settings.section.access'],
  ['limits', 'settings.section.limits'],
  ['tools', 'settings.section.tools'],
  ['project', 'settings.section.project'],
  ['graphics', 'settings.section.graphics'],
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
let lastSection: Section = 'general';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const cloud = useStore((s) => s.cloud);
  const graphics = useStore((s) => s.graphics);
  const setGraphics = useStore((s) => s.setGraphics);
  const layouts = useStore((s) => s.layouts);
  const roles = useStore((s) => s.roles);
  // Запрос конкретного раздела (например, ссылка «настройки раскладки» из
  // карточки безместного сотрудника) перебивает запомненный за сессию раздел.
  const settingsSection = useStore((s) => s.settingsSection);
  const [section, setSection] = useState<Section>(settingsSection ?? lastSection);
  // Каталог серверов правится списком целиком и уезжает одной настройкой:
  // сервер проверяет его весь и отказывает целиком, как и любую форму.
  const [servers, setServers] = useState<McpServerDef[]>(settings.mcpServers ?? []);
  // Чего просят пакеты сотрудников и чего в каталоге ещё нет. Считается здесь,
  // а не на сервере: список зависит от того, что человек уже добавил в форму,
  // и после «добавить» просьба обязана исчезать сразу, до сохранения.
  const requests: McpRequest[] = [];
  for (const role of roles) {
    for (const asked of role.mcpRequested ?? []) {
      if (servers.some((s) => s.id === asked.id)) continue;
      const seen = requests.find((r) => r.server.id === asked.id);
      if (seen) seen.roles.push(role.title);
      else requests.push({ server: asked, roles: [role.title] });
    }
  }
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
  const [language, setLanguage] = useState<Lang>(settings.language ?? 'en');
  const [gfx, setGfx] = useState<Graphics>(graphics);
  const patchGfx = (patch: Partial<Graphics>) => setGfx((g) => ({ ...g, ...patch }));
  const [autoPipeline, setAutoPipeline] = useState(settings.autoPipeline);
  const [focusEpics, setFocusEpics] = useState(settings.focusEpics ?? DEFAULT_FOCUS_EPICS);
  const [planApproval, setPlanApproval] = useState(settings.planApproval !== false);
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
      mcpServers: servers,
      layoutId,
      autoPipeline,
      focusEpics,
      planApproval,
      language,
    });
    setGraphics(gfx);
    if (token.trim()) setCloudToken(token.trim());
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('settings.title')}</h3>

        <div className="settings-layout">
          <div className="settings-nav">
            {SECTIONS.map(([id, label]) => (
              <button key={id} className={`ghost${section === id ? ' on' : ''}`} onClick={() => chooseSection(id)}>
                {t(label)}
              </button>
            ))}
          </div>

          <div className="settings-content">
            {section === 'general' && (
              <>
                <h4 className="section-title">{t('common.language')}</h4>
                <div className="engine">
                  {LANGS.map((code) => (
                    <button key={code} className={language === code ? 'on' : ''}
                      onClick={() => setLanguage(code)}>
                      {LANG_TITLE[code]}
                    </button>
                  ))}
                </div>
                <p className="hint muted">{t('settings.language.hint')}</p>
              </>
            )}

            {section === 'access' && (
              <>
                <h4 className="section-title">{t('settings.access.title')}</h4>
                <div className="engine access-modes">
                  {accessModes().map(([id, label, hint]) => (
                    <button key={id} className={`${access === id ? 'on' : ''} ${id}`.trim()}
                      onClick={() => chooseAccess(id)}>
                      {label}
                      <span className="muted small">{hint}</span>
                    </button>
                  ))}
                </div>
                {confirmAuto && (
                  <div className="access-confirm">
                    <p>{fullAccessWarning()}</p>
                    <div className="modal-actions">
                      <button onClick={() => setConfirmAuto(false)}>{t('common.cancel')}</button>
                      <button className="danger" onClick={() => { setAccess('auto'); setConfirmAuto(false); }}>
                        {t('settings.access.confirm')}
                      </button>
                    </div>
                  </div>
                )}
                <p className="hint muted">{t('settings.access.hint')}</p>
              </>
            )}

            {section === 'limits' && (
              <>
                <p className="modal-reason">{t('settings.limits.note')}</p>

                <div className="row2">
                  <label>{t('settings.limits.global')}
                    <input value={global} placeholder={t('settings.limits.unlimited')}
                      onChange={(e) => setGlobal(e.target.value)} />
                    <span className="hint muted">{t('settings.limits.global.hint')}</span>
                  </label>

                  <label>{t('settings.limits.perTask')}
                    <input value={perTask} placeholder={t('settings.limits.unlimited')}
                      onChange={(e) => setPerTask(e.target.value)} />
                    <span className="hint muted">{t('settings.limits.perTask.hint')}</span>
                  </label>
                </div>
                <label>{t('settings.limits.turns')}
                  <input value={maxTurns} placeholder={t('settings.limits.unlimited')}
                    onChange={(e) => setMaxTurns(e.target.value)} />
                  <span className="hint muted">{t('settings.limits.turns.hint')}</span>
                  {maxTurnsParsed.error && <span className="hint error">{maxTurnsParsed.error}</span>}
                </label>

                <label>{t('settings.limits.workers')}
                  <input value={maxWorkers} placeholder={DEFAULT_OFFICE_WORKERS.toString()}
                    onChange={(e) => setMaxWorkers(e.target.value)} />
                  <span className="hint muted">
                    {t('settings.limits.workers.hint', { cap: DEFAULT_PROCESS_WORKERS })}
                    {' '}<code className="mono">OFFICE_MAX_WORKERS</code>
                    {t('settings.limits.workers.hintTail')}
                  </span>
                  {maxWorkersParsed.error && <span className="hint error">{maxWorkersParsed.error}</span>}
                </label>
              </>
            )}

            {section === 'tools' && (
              <McpCatalog servers={servers} requests={requests} onChange={setServers} />
            )}

            {section === 'project' && (
              <>
                <h4 className="section-title">{t('settings.layout.title')}</h4>
                <div className="engine">
                  {layouts.map((l) => (
                    <button key={l.id} className={layoutId === l.id ? 'on' : ''} onClick={() => setLayoutId(l.id)}>
                      {l.title}
                    </button>
                  ))}
                </div>
                <p className="hint muted">{t('settings.layout.hint')}</p>

                <h4 className="section-title">{t('settings.pipeline.title')}</h4>
                <div className="engine">
                  <button className={autoPipeline ? 'on' : ''} onClick={() => setAutoPipeline(true)}>
                    <span><Icon name="repeat" size={18} /> {t('settings.pipeline.auto')}</span>
                    <span className="muted small">{t('settings.pipeline.auto.hint')}</span>
                  </button>
                  <button className={autoPipeline ? '' : 'on'} onClick={() => setAutoPipeline(false)}>
                    <span><Icon name="hand-stop" size={18} /> {t('settings.pipeline.manual')}</span>
                    <span className="muted small">{t('settings.pipeline.manual.hint')}</span>
                  </button>
                </div>
                <p className="hint muted">{t('settings.pipeline.note')}</p>

                <h4 className="section-title">{t('settings.plan.title')}</h4>
                <div className="engine">
                  <button className={planApproval ? 'on' : ''} onClick={() => setPlanApproval(true)}>
                    <span><Icon name="hand-stop" size={18} /> {t('settings.plan.approval')}</span>
                    <span className="muted small">{t('settings.plan.approval.hint')}</span>
                  </button>
                  <button className={planApproval ? '' : 'on'} onClick={() => setPlanApproval(false)}>
                    <span><Icon name="repeat" size={18} /> {t('settings.plan.auto')}</span>
                    <span className="muted small">{t('settings.plan.auto.hint')}</span>
                  </button>
                </div>
                <Slider
                  label={t('settings.plan.focus')}
                  hint={t('settings.plan.focus.hint', {
                    min: MIN_FOCUS_EPICS, max: MAX_FOCUS_EPICS,
                  })}
                  value={focusEpics}
                  range={{ min: MIN_FOCUS_EPICS, max: MAX_FOCUS_EPICS, step: 1 }}
                  disabled={false}
                  onChange={setFocusEpics}
                />
                <p className="hint muted">{t('settings.plan.note')}</p>

                <label>{t('settings.token')} {cloud.hasToken && (
                  <span className="chip done">{t('settings.token.set')}</span>
                )}
                  <input value={token} type="password"
                    placeholder={cloud.hasToken ? t('settings.token.placeholder') : 'ghp_…'}
                    onChange={(e) => setToken(e.target.value)} />
                  <span className="hint muted">
                    {t('settings.token.hint')}
                    {' '}<code className="mono">OFFICE_GITHUB_TOKEN</code>
                    {t('settings.token.hintTail')}
                  </span>
                </label>

                <h4 className="section-title">{t('settings.engine.title')}</h4>
                <div className="engine">
                  <button className={engine === 'local' ? 'on' : ''} onClick={() => setEngine('local')}>
                    <span><Icon name="device-desktop" size={18} /> {t('settings.engine.local')}</span>
                    <span className="muted small">{t('settings.engine.local.hint')}</span>
                  </button>
                  <button className={engine === 'cloud' ? 'on' : ''} onClick={() => setEngine('cloud')}>
                    <span><Icon name="cloud" size={18} /> {t('settings.engine.cloud')}</span>
                    <span className="muted small">{t('settings.engine.cloud.hint')}</span>
                  </button>
                </div>

                {engine === 'cloud' && (
                  <>
                    <p className="hint muted">{t('settings.cloud.note')}</p>

                    <div className={`ready ${cloud.hasKey ? 'ok' : 'bad'}`}>
                      {t(cloud.hasKey ? 'settings.cloud.keyOk' : 'settings.cloud.keyMissing')}
                    </div>

                    <label>{t('settings.cloud.repo')}
                      <input value={repo} placeholder="https://github.com/owner/repo"
                        onChange={(e) => setRepo(e.target.value)} />
                      <span className="hint muted">{t('settings.cloud.repo.hint')}</span>
                    </label>

                    <p className="hint muted">{t('settings.cloud.tokenNote')}</p>
                  </>
                )}
              </>
            )}

            {section === 'graphics' && (
              <>
                <h4 className="section-title">{t('settings.gfx.title')}</h4>
                <div className="engine">
                  <button className={gfx.pixelate ? 'on' : ''} onClick={() => patchGfx({ pixelate: true })}>
                    <span><Icon name="grid-dots" size={18} /> {t('settings.gfx.on')}</span>
                    <span className="muted small">{t('settings.gfx.on.hint')}</span>
                  </button>
                  <button className={gfx.pixelate ? '' : 'on'} onClick={() => patchGfx({ pixelate: false })}>
                    <span><Icon name="circle" size={18} /> {t('settings.gfx.off')}</span>
                    <span className="muted small">{t('settings.gfx.off.hint')}</span>
                  </button>
                </div>
                <p className="hint muted">{t('settings.gfx.note')}</p>

                <Slider
                  label={t('settings.gfx.pixelSize')} value={gfx.pixelSize}
                  range={GRAPHICS_RANGE.pixelSize}
                  disabled={!gfx.pixelate} onChange={(v) => patchGfx({ pixelSize: v })}
                  hint={t('settings.gfx.pixelSize.hint')}
                />
                <Slider
                  label={t('settings.gfx.normalEdge')} value={gfx.normalEdge}
                  range={GRAPHICS_RANGE.normalEdge}
                  decimals={2} disabled={!gfx.pixelate}
                  onChange={(v) => patchGfx({ normalEdge: v })}
                  hint={t('settings.gfx.normalEdge.hint')}
                />
                <Slider
                  label={t('settings.gfx.depthEdge')} value={gfx.depthEdge}
                  range={GRAPHICS_RANGE.depthEdge}
                  decimals={2} disabled={!gfx.pixelate}
                  onChange={(v) => patchGfx({ depthEdge: v })}
                  hint={t('settings.gfx.depthEdge.hint')}
                />

                <div className="engine">
                  <button onClick={() => setGfx(DEFAULT_GRAPHICS)}>{t('settings.gfx.reset')}</button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="allow" onClick={save}>{t('common.save')}</button>
        </div>
      </div>
    </div>
  );
}

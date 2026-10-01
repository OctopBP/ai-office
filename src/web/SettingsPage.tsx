import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  accessModes, clearSettingsSection, fullAccessWarning, parseMaxWorkers, parseTaskMaxTurns,
  refreshProviders, setCloudToken, updateSettings, useStore, type ThemeMode,
} from './store';
import {
  DEFAULT_FOCUS_EPICS, DEFAULT_INITIATIVE_MODE, DEFAULT_INITIATIVE_SHARE, DEFAULT_OFFICE_WORKERS,
  DEFAULT_PM_CONTEXT_LIMIT, DEFAULT_PROCESS_WORKERS, DEFAULT_RITUAL_LIMIT, DEFAULT_WORKER_CONTEXT_LIMIT,
  INITIATIVE_MODES, MAX_FOCUS_EPICS, MAX_INITIATIVE_SHARE, MAX_PM_CONTEXT_LIMIT, MAX_WORKER_CONTEXT_LIMIT,
  MIN_FOCUS_EPICS, MIN_INITIATIVE_SHARE, MIN_PM_CONTEXT_LIMIT, MIN_WORKER_CONTEXT_LIMIT,
  type InitiativeMode, type McpServerDef, type PermissionMode,
} from '../shared/types';
import { DEFAULT_LANG, LANGS, LANG_TITLE, type Lang } from '../shared/i18n';
import { DEFAULT_GRAPHICS, GRAPHICS_RANGE, type Graphics } from './office3d/graphics';
import { t, type UiKey } from './i18n';
import { McpCatalog, type McpRequest } from './McpCatalog';
import { OfficeIconSetting } from './OfficeIcon';
import { Icon } from './icons';
import { ShellPage } from './shell/ShellPage';
import { ProviderCard } from './ProviderCard';
import { CustomApiGroup } from './CustomApiForm';
import { byLabel } from './FirstLaunch';
import { ProviderOptions, freeModel, modelHint, modelOptions, useProviderModels } from './ProviderPick';
import { PROVIDERS, isConnected, type ModelChoice, type ProviderId } from '../shared/providers';
import { notifyPermission, notifyWanted, setNotifyWanted, type NotifyPermission } from './notify';

const parse = (v: string): number | null => {
  const n = Number(v.replace(',', '.'));
  return v.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n;
};

type Section = 'general' | 'providers' | 'access' | 'limits' | 'tools' | 'project' | 'life' | 'graphics';

const THEME_MODES: Array<[ThemeMode, UiKey]> = [
  ['day', 'settings.theme.day'],
  ['night', 'settings.theme.night'],
  ['system', 'settings.theme.system'],
];

const SECTIONS: Array<[Section, UiKey]> = [
  ['general', 'settings.section.general'],
  ['providers', 'providers.title'],
  ['access', 'settings.section.access'],
  ['limits', 'settings.section.limits'],
  ['tools', 'settings.section.tools'],
  ['project', 'settings.section.project'],
  ['life', 'settings.section.life'],
  ['graphics', 'settings.section.graphics'],
];

/** Группа полей вкладки: заголовок, описание и строки шаблона `.form-*`.
 *  Описание обязательно — без него заголовок прилипает к первой строке. */
function Group({ title, desc, children }: { title: string; desc: ReactNode; children: ReactNode }) {
  return (
    <section className="form-section">
      <header className="form-section-head">
        <h3 className="form-section-title">{title}</h3>
        <p className="form-section-desc">{desc}</p>
      </header>
      <div className="form-rows">{children}</div>
    </section>
  );
}

/** Строка «подпись — поле». Подсказка стоит под полем, а не под подписью:
 *  подсказки здесь длинные, и в узкой колонке подписи они вытягивались бы
 *  в столбик на полэкрана. */
function Row({ label, htmlFor, hint, off, children }: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  off?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`form-row${off ? ' off' : ''}`}>
      <div className="form-row-label"><label htmlFor={htmlFor}>{label}</label></div>
      <div className="form-row-control">
        {children}
        {hint && <span className="form-hint">{hint}</span>}
      </div>
    </div>
  );
}

/** Ползунок: строка шаблона, range и значение справа от него.
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
  const id = useId();
  return (
    <Row label={label} htmlFor={id} hint={hint} off={disabled}>
      <div className="settings-range">
        <input
          id={id} type="range" value={value} disabled={disabled}
          min={range.min} max={range.max} step={range.step}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <b className="mono">{value.toFixed(decimals)}</b>
      </div>
    </Row>
  );
}

/**
 * Вкладка «Провайдеры» (docs/design/T-189/ui.md §2): карточки подключений.
 * Всё здесь применяется сразу — установка, ключ и вход живут на машине и
 * общие для всех офисов, «Сохранить» страницы их не касается.
 */
function ProvidersSection() {
  const view = useStore((s) => s.providers);
  const choice = useStore((s) => s.settings.model);
  // Открыли вкладку — свежий статус; принудительно мимо кешей только по «Проверить снова».
  useEffect(() => { refreshProviders(); }, []);
  // Свой API без адреса — ещё не подключение: он ждёт в группе «Свой API» ниже.
  const list = [...(view?.providers ?? [])].filter((p) => p.id !== 'custom' || p.baseUrl).sort(byLabel);
  const custom = view?.providers.find((p) => p.id === 'custom');
  // Выбор офиса уходит сразу, как и всё на этой вкладке: «Сохранить» страницы
  // его не шлёт, и «Отмена» его не откатывает.
  const choose = (provider: ProviderId) => {
    if (provider === choice?.provider) return;
    updateSettings({ model: { provider, model: PROVIDERS[provider].defaultModel } });
  };
  return (
    <div className="form">
      <OfficeProviderGroup choose={choose} />
      <section className="form-section" id="provider-connections">
        <header className="form-section-head provider-section-head">
          <div>
            <h3 className="form-section-title">{t('providers.connections.title')}</h3>
            <p className="form-section-desc">{t('providers.connections.desc')}</p>
          </div>
          <span className="provider-shared">{t('providers.connections.shared')}</span>
        </header>
        {view?.noneReady && <p className="provider-empty">{t('providers.office.empty')}</p>}
        {view === null
          ? <p className="form-hint"><span className="spinner" /> {t('providers.loading')}</p>
          : (
            <div className="provider-list">
              {list.map((p) => (
                <ProviderCard key={p.id} p={p} onUse={p.id === choice?.provider ? undefined : () => choose(p.id)} />
              ))}
            </div>
          )}
      </section>
      <CustomApiGroup p={custom} />
    </div>
  );
}

/**
 * Группа «Провайдер офиса» (ui.md §2.1): пара, на которой работает каждая
 * роль без своего выбора. Выбрать можно только подключённого; остальные
 * видны серыми с причиной и ведут к карточкам ниже.
 */
function OfficeProviderGroup({ choose }: { choose: (provider: ProviderId) => void }) {
  const choice = useStore((s) => s.settings.model);
  return choice ? <OfficeProviderChosen choose={choose} choice={choice} /> : <OfficeProviderUnset choose={choose} />;
}

/** Прокрутка к карточкам подключений ниже на вкладке. */
const toCards = () => document.getElementById('provider-connections')?.scrollIntoView({ behavior: 'smooth' });

/**
 * Провайдер офиса не выбран (`Settings.model === null`, T-243): ни одного
 * провайдера не подставляем, в списке — пустой пункт «не выбран».
 */
function OfficeProviderUnset({ choose }: { choose: (provider: ProviderId) => void }) {
  const view = useStore((s) => s.providers);
  const fid = useId();
  const providers = view?.providers ?? [];
  const noneReady = view !== null && !providers.some((p) => isConnected(p.status));
  return (
    <Group title={t('providers.office.title')} desc={t('providers.office.desc')}>
      <Row label={t('providers.office.provider')} htmlFor={`${fid}-provider`} hint={t('providers.office.switchHint')}>
        <select id={`${fid}-provider`} value="" disabled={noneReady || view === null}
          onChange={(e) => { if (e.target.value) choose(e.target.value as ProviderId); }}>
          <option value="" disabled>{t('shell.provider.none')}</option>
          {providers.length > 0 && <ProviderOptions providers={providers} />}
        </select>
        <span className="form-hint warn">
          {t(noneReady ? 'providers.office.unsetConnect' : 'providers.office.unset')}
          {noneReady && <>{' '}<button type="button" className="link" onClick={toCards}>{t('providers.office.connectBelow')}</button></>}
        </span>
      </Row>
    </Group>
  );
}

function OfficeProviderChosen({ choose, choice }: { choose: (provider: ProviderId) => void; choice: ModelChoice }) {
  const view = useStore((s) => s.providers);
  const fid = useId();
  const models = useProviderModels(choice.provider);
  const [draftModel, setDraftModel] = useState(choice.model);
  useEffect(() => setDraftModel(choice.model), [choice.model]);
  const providers = view?.providers ?? [];
  const current = providers.find((p) => p.id === choice.provider);
  const noneReady = view !== null && !providers.some((p) => isConnected(p.status));
  const chosenOff = current !== undefined && !isConnected(current.status);
  const setModel = (model: string) => {
    const clean = model.trim();
    if (!clean || clean === choice.model) { setDraftModel(choice.model); return; }
    updateSettings({ model: { provider: choice.provider, model: clean } });
  };
  const connectBelow = (
    <button type="button" className="link" onClick={toCards}>{t('providers.office.connectBelow')}</button>
  );

  return (
    <Group title={t('providers.office.title')} desc={t('providers.office.desc')}>
      <Row label={t('providers.office.provider')} htmlFor={`${fid}-provider`}
        hint={noneReady ? connectBelow : t('providers.office.switchHint')}>
        <select id={`${fid}-provider`} value={choice.provider} disabled={noneReady || view === null}
          onChange={(e) => choose(e.target.value as ProviderId)}>
          {providers.length
            ? <ProviderOptions providers={providers} />
            : <option value={choice.provider}>{PROVIDERS[choice.provider].label}</option>}
        </select>
        {chosenOff && !noneReady && (
          <span className="form-hint warn">
            {t('providers.office.notReady', { name: current.label })} {connectBelow}
          </span>
        )}
      </Row>
      <Row label={t('providers.office.model')} htmlFor={`${fid}-model`}
        hint={modelHint(choice.provider) && t(modelHint(choice.provider)!)}>
        {freeModel(choice.provider) ? (
          <>
            <input id={`${fid}-model`} list={`${fid}-models`} value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              onBlur={() => setModel(draftModel)}
              onKeyDown={(e) => { if (e.key === 'Enter') setModel(draftModel); }} />
            <datalist id={`${fid}-models`}>
              {modelOptions(choice.provider, models, '').map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </datalist>
          </>
        ) : (
          <select id={`${fid}-model`} value={choice.model} onChange={(e) => setModel(e.target.value)}>
            {modelOptions(choice.provider, models, choice.model).map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        )}
      </Row>
    </Group>
  );
}

// Раздел держится на время сессии вкладки: закрыли окно, открыли снова — курсор
// остаётся там же, где был, а не прыгает на первый пункт.
let lastSection: Section = 'general';

/**
 * Настройки офиса — страница в главной области оболочки (пункт рейла,
 * `RailView` в сторе), а не модалка: без подложки и затемнения, «Отмена» и
 * «Сохранить» — в шапке страницы. `onClose` уводит с неё обратно.
 */
export function SettingsPage({ onClose }: { onClose: () => void }) {
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
  // Основа для id полей: подпись строки связана с полем через htmlFor.
  const fid = useId();
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
  const [notify, setNotify] = useState<{ wanted: boolean; permission: NotifyPermission }>(
    () => ({ wanted: notifyWanted(), permission: notifyPermission() }),
  );
  const toggleNotify = (on: boolean) => {
    setNotify((n) => ({ ...n, wanted: on }));
    // Ответ браузера приходит не сразу: человек ещё смотрит на его запрос.
    void setNotifyWanted(on).then((permission) => setNotify({ wanted: on, permission }));
  };
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
  // Два языка офиса — независимые: договариваться по-русски и держать код и
  // комментарии английскими это обычное требование, а не ошибка ввода.
  // Старое `settings.language` тут только запасным значением для офисов,
  // заведённых до разделения языков; язык интерфейса сюда не приходит вовсе.
  const [chatLanguage, setChatLanguage] = useState<Lang>(
    settings.chatLanguage ?? settings.language ?? DEFAULT_LANG);
  const [codeLanguage, setCodeLanguage] = useState<Lang>(
    settings.codeLanguage ?? settings.chatLanguage ?? settings.language ?? DEFAULT_LANG);
  const themeMode = useStore((s) => s.themeMode);
  const setThemeMode = useStore((s) => s.setThemeMode);
  // Язык интерфейса — только для показа: меняют его на главном экране.
  const uiLang = useStore((s) => s.lang);
  const [gfx, setGfx] = useState<Graphics>(graphics);
  const patchGfx = (patch: Partial<Graphics>) => setGfx((g) => ({ ...g, ...patch }));
  const [autoPipeline, setAutoPipeline] = useState(settings.autoPipeline);
  const [focusEpics, setFocusEpics] = useState(settings.focusEpics ?? DEFAULT_FOCUS_EPICS);
  const [planApproval, setPlanApproval] = useState(settings.planApproval !== false);
  const [ritualsEnabled, setRitualsEnabled] = useState(settings.ritualsEnabled !== false);
  const [ritualLimit, setRitualLimit] = useState(settings.ritualLimitThreshold ?? DEFAULT_RITUAL_LIMIT);
  // Порог контекста менеджера показываем в тысячах токенов: точность до
  // токена здесь никому не нужна, а шестизначные числа на ползунке не читаются.
  const [pmContext, setPmContext] = useState(
    Math.round((settings.pmContextLimit ?? DEFAULT_PM_CONTEXT_LIMIT) / 1000));
  const [workerContext, setWorkerContext] = useState(
    Math.round((settings.workerContextLimit ?? DEFAULT_WORKER_CONTEXT_LIMIT) / 1000));
  const [initiativeMode, setInitiativeMode] = useState<InitiativeMode>(settings.initiativeMode ?? DEFAULT_INITIATIVE_MODE);
  const [initiativeShare, setInitiativeShare] = useState(
    Math.round((settings.initiativeShare ?? DEFAULT_INITIATIVE_SHARE) * 100));
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
      ritualsEnabled,
      ritualLimitThreshold: ritualLimit,
      pmContextLimit: pmContext * 1000,
      workerContextLimit: workerContext * 1000,
      initiativeMode,
      initiativeShare: initiativeShare / 100,
      chatLanguage,
      codeLanguage,
    });
    setGraphics(gfx);
    if (token.trim()) setCloudToken(token.trim());
    onClose();
  };

  return (
    <ShellPage title={t('settings.title')} bodyClass="fixed" actions={<>
      <button onClick={onClose}>{t('common.cancel')}</button>
      <button className="allow" onClick={save}>{t('common.save')}</button>
    </>}>
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
            <div className="form">
              {/* Два языка офиса стоят рядом и переключаются порознь: так
                  видно, что это разные настройки, а не одна с уточнением. */}
              <Group title={t('settings.general.lang')} desc={t('settings.general.lang.desc')}>
                <Row label={t('settings.lang.chat')} hint={t('settings.lang.chat.hint')}>
                  <div className="engine">
                    {LANGS.map((code) => (
                      <button key={code} className={chatLanguage === code ? 'on' : ''}
                        onClick={() => setChatLanguage(code)}>
                        {LANG_TITLE[code]}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row label={t('settings.lang.code')} hint={t('settings.lang.code.hint')}>
                  <div className="engine">
                    {LANGS.map((code) => (
                      <button key={code} className={codeLanguage === code ? 'on' : ''}
                        onClick={() => setCodeLanguage(code)}>
                        {LANG_TITLE[code]}
                      </button>
                    ))}
                  </div>
                </Row>
                {chatLanguage !== codeLanguage && (
                  <span className="form-hint">
                    {t('settings.lang.split', {
                      chat: LANG_TITLE[chatLanguage], code: LANG_TITLE[codeLanguage],
                    })}
                  </span>
                )}
                {/* Язык интерфейса здесь не настраивается: он один на всё
                    приложение, и место у него одно — главный экран. Строка
                    оставлена, чтобы его не искали в настройках офиса. */}
                <span className="form-hint settings-elsewhere">
                  {t('settings.lang.ui.elsewhere', { lang: LANG_TITLE[uiLang] })}
                </span>
              </Group>

              {/* Тема и уведомления применяются сразу, без «Сохранить»: они
                  живут на этом компьютере, а не в настройках офиса на сервере. */}
              <Group title={t('settings.general.device')} desc={t('settings.general.device.desc')}>
                <Row label={t('settings.theme')} hint={t('settings.theme.hint')}>
                  <div className="seg">
                    {THEME_MODES.map(([mode, label]) => (
                      <button key={mode} className={themeMode === mode ? 'on' : ''}
                        onClick={() => setThemeMode(mode)}>
                        {t(label)}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row label={t('settings.notify.title')}>
                  <label className="form-check">
                    <input
                      type="checkbox" checked={notify.wanted} disabled={notify.permission === 'unsupported'}
                      onChange={(e) => toggleNotify(e.target.checked)}
                    />
                    <span className="form-check-text">
                      {t('settings.notify')}
                      <span className="form-hint">{t('settings.notify.hint')}</span>
                      {notify.permission === 'denied' && notify.wanted && (
                        <span className="form-hint error">{t('settings.notify.denied')}</span>
                      )}
                      {notify.permission === 'unsupported' && (
                        <span className="form-hint">{t('settings.notify.unsupported')}</span>
                      )}
                    </span>
                  </label>
                </Row>
              </Group>
            </div>
          )}

          {section === 'providers' && <ProvidersSection />}

          {section === 'access' && (
            <div className="form">
              <Group title={t('settings.access.title')} desc={t('settings.access.hint')}>
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
              </Group>
            </div>
          )}

          {section === 'limits' && (
            <div className="form">
              {/* Деньги и параллелизм — разные рычаги: первый останавливает
                  офис, второй только растягивает очередь. Поэтому разные группы. */}
              <Group title={t('settings.limits.money')} desc={t('settings.limits.note')}>
                <Row label={t('settings.limits.global')} htmlFor={`${fid}-global`}
                  hint={t('settings.limits.global.hint')}>
                  <input id={`${fid}-global`} value={global} placeholder={t('settings.limits.unlimited')}
                    onChange={(e) => setGlobal(e.target.value)} />
                </Row>
                <Row label={t('settings.limits.perTask')} htmlFor={`${fid}-task`}
                  hint={t('settings.limits.perTask.hint')}>
                  <input id={`${fid}-task`} value={perTask} placeholder={t('settings.limits.unlimited')}
                    onChange={(e) => setPerTask(e.target.value)} />
                </Row>
              </Group>

              <Group title={t('settings.limits.work')} desc={t('settings.limits.work.desc')}>
                <Row label={t('settings.limits.workers')} htmlFor={`${fid}-workers`} hint={<>
                  {t('settings.limits.workers.hint', { cap: DEFAULT_PROCESS_WORKERS })}
                  {' '}<code className="mono">OFFICE_MAX_WORKERS</code>
                  {t('settings.limits.workers.hintTail')}
                </>}>
                  <input id={`${fid}-workers`} value={maxWorkers} placeholder={DEFAULT_OFFICE_WORKERS.toString()}
                    onChange={(e) => setMaxWorkers(e.target.value)} />
                  {maxWorkersParsed.error && <span className="form-hint error">{maxWorkersParsed.error}</span>}
                </Row>
                <Row label={t('settings.limits.turns')} htmlFor={`${fid}-turns`}
                  hint={t('settings.limits.turns.hint')}>
                  <input id={`${fid}-turns`} value={maxTurns} placeholder={t('settings.limits.unlimited')}
                    onChange={(e) => setMaxTurns(e.target.value)} />
                  {maxTurnsParsed.error && <span className="form-hint error">{maxTurnsParsed.error}</span>}
                </Row>
              </Group>

              <Group title={t('settings.limits.context')} desc={t('settings.limits.context.desc')}>
                <Slider
                  label={t('settings.limits.pmContext')}
                  hint={t('settings.limits.pmContext.hint')}
                  value={pmContext}
                  range={{ min: MIN_PM_CONTEXT_LIMIT / 1000, max: MAX_PM_CONTEXT_LIMIT / 1000, step: 10 }}
                  disabled={false}
                  onChange={setPmContext}
                />
                <Slider
                  label={t('settings.limits.workerContext')}
                  hint={t('settings.limits.workerContext.hint')}
                  value={workerContext}
                  range={{ min: MIN_WORKER_CONTEXT_LIMIT / 1000, max: MAX_WORKER_CONTEXT_LIMIT / 1000, step: 10 }}
                  disabled={false}
                  onChange={setWorkerContext}
                />
              </Group>
            </div>
          )}

          {section === 'tools' && (
            <div className="form">
              <McpCatalog servers={servers} requests={requests} onChange={setServers} />
            </div>
          )}

          {section === 'project' && (
            <div className="form">
              <Group title={t('settings.project.office')} desc={t('settings.project.office.desc')}>
                {/* Иконка сохраняется сразу, без «Сохранить»: картинка уходит
                    отдельной ручкой, а не вместе с настройками офиса. */}
                <OfficeIconSetting />
                <Row label={t('settings.layout.title')} hint={t('settings.layout.hint')}>
                  <div className="engine">
                    {layouts.map((l) => (
                      <button key={l.id} className={layoutId === l.id ? 'on' : ''} onClick={() => setLayoutId(l.id)}>
                        {l.title}
                      </button>
                    ))}
                  </div>
                </Row>
              </Group>

              {/* Токен стоит в этой группе, а не у облака: на него ссылается
                  settings.cloud.tokenNote («задаётся выше, в «Ревью и слияние»»). */}
              <Group title={t('settings.pipeline.title')} desc={t('settings.pipeline.note')}>
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
                <Row label={<>{t('settings.token')} {cloud.hasToken && (
                  <span className="chip done">{t('settings.token.set')}</span>
                )}</>} htmlFor={`${fid}-token`} hint={<>
                  {t('settings.token.hint')}
                  {' '}<code className="mono">OFFICE_GITHUB_TOKEN</code>
                  {t('settings.token.hintTail')}
                </>}>
                  <input id={`${fid}-token`} value={token} type="password"
                    placeholder={cloud.hasToken ? t('settings.token.placeholder') : 'ghp_…'}
                    onChange={(e) => setToken(e.target.value)} />
                </Row>
              </Group>

              <Group title={t('settings.plan.title')} desc={t('settings.plan.note')}>
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
              </Group>

              <Group title={t('settings.engine.title')} desc={t('settings.project.engine.desc')}>
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
                    <span className="form-hint">{t('settings.cloud.note')}</span>
                    <div className={`ready ${cloud.hasKey ? 'ok' : 'bad'}`}>
                      {t(cloud.hasKey ? 'settings.cloud.keyOk' : 'settings.cloud.keyMissing')}
                    </div>
                    <Row label={t('settings.cloud.repo')} htmlFor={`${fid}-repo`}
                      hint={t('settings.cloud.repo.hint')}>
                      <input id={`${fid}-repo`} value={repo} placeholder="https://github.com/owner/repo"
                        onChange={(e) => setRepo(e.target.value)} />
                    </Row>
                    <span className="form-hint">{t('settings.cloud.tokenNote')}</span>
                  </>
                )}
              </Group>
            </div>
          )}

          {section === 'life' && (
            <div className="form">
              <Group title={t('settings.life.rituals')} desc={t('settings.life.rituals.desc')}>
                <div className="engine">
                  <button className={ritualsEnabled ? 'on' : ''} onClick={() => setRitualsEnabled(true)}>
                    <span><Icon name="repeat" size={18} /> {t('settings.life.rituals.on')}</span>
                    <span className="muted small">{t('settings.life.rituals.on.hint')}</span>
                  </button>
                  <button className={ritualsEnabled ? '' : 'on'} onClick={() => setRitualsEnabled(false)}>
                    <span><Icon name="hand-stop" size={18} /> {t('settings.life.rituals.off')}</span>
                    <span className="muted small">{t('settings.life.rituals.off.hint')}</span>
                  </button>
                </div>
                <Slider
                  label={t('settings.life.limit')}
                  hint={t('settings.life.limit.hint')}
                  value={ritualLimit}
                  range={{ min: 10, max: 100, step: 5 }}
                  disabled={!ritualsEnabled}
                  onChange={setRitualLimit}
                />
              </Group>

              <Group title={t('settings.life.initiative')} desc={t('settings.life.initiative.desc')}>
                <div className="engine">
                  {INITIATIVE_MODES.map((mode) => (
                    <button key={mode} className={initiativeMode === mode ? 'on' : ''}
                      onClick={() => setInitiativeMode(mode)}>
                      <span>{t(`settings.life.initiative.${mode}`)}</span>
                      <span className="muted small">{t(`settings.life.initiative.${mode}.hint`)}</span>
                    </button>
                  ))}
                </div>
                <Slider
                  label={t('settings.life.share')}
                  hint={t('settings.life.share.hint')}
                  value={initiativeShare}
                  range={{ min: MIN_INITIATIVE_SHARE * 100, max: MAX_INITIATIVE_SHARE * 100, step: 5 }}
                  disabled={initiativeMode === 'off'}
                  onChange={setInitiativeShare}
                />
              </Group>
            </div>
          )}

          {section === 'graphics' && (
            <div className="form">
              <Group title={t('settings.gfx.title')} desc={t('settings.gfx.note')}>
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
              </Group>

              {/* Сетка и карта проходимости — линейки для раскладки, а не
                  украшение картинки: своя группа, чтобы их не искали в качестве. */}
              <Group title={t('settings.gfx.debug')} desc={t('settings.gfx.debug.desc')}>
                <Row label={t('settings.gfx.grid.title')}>
                  <label className="form-check">
                    <input
                      type="checkbox" checked={gfx.grid}
                      onChange={(e) => patchGfx({ grid: e.target.checked })}
                    />
                    <span className="form-check-text">
                      {t('settings.gfx.grid')}
                      <span className="form-hint">{t('settings.gfx.grid.hint')}</span>
                    </span>
                  </label>
                </Row>
                <Row label={t('settings.gfx.dev.title')}>
                  <label className="form-check">
                    <input
                      type="checkbox" checked={gfx.dev}
                      onChange={(e) => patchGfx({ dev: e.target.checked })}
                    />
                    <span className="form-check-text">
                      {t('settings.gfx.dev')}
                      <span className="form-hint">{t('settings.gfx.dev.hint')}</span>
                    </span>
                  </label>
                </Row>
                <div className="settings-row">
                  <button onClick={() => setGfx(DEFAULT_GRAPHICS)}>{t('settings.gfx.reset')}</button>
                </div>
              </Group>
            </div>
          )}
        </div>
      </div>
    </ShellPage>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { t } from './i18n';
import { slugify } from '../shared/slug';
import {
  MAX_HIRE_COUNT, type MarketPackageView, type OfficeSetupPlan, type SetupStep, type SetupWhere, type SetupWorkspace,
} from '../shared/types';

/**
 * Мастер нового офиса — четыре шага поверх сетки меню: что строим, где,
 * кто, строим. Спека docs/design/office-setup/spec.md §3.
 *
 * Сеть трогает только последний шаг: витрину мастер спрашивает при открытии,
 * а всё, что человек набрал, живёт здесь до нажатия «Создать». Прогресс
 * сборки и ошибка приходят через стор (`setupSteps`, `menuNotice`), вход в
 * готовый офис — снапшотом, как у старой формы.
 */

type Mode = SetupWhere['mode'];
type WsKind = SetupWorkspace['kind'];

interface Member {
  count: number;
  ws: WsKind;
  folder: string;
  path: string;
}

/** Имя подпапки: то же правило, что у сервера (`FOLDER_NAME_RE`). */
const FOLDER_RE = /^(?!\.)[A-Za-z0-9._-]{1,64}$/;

const STEPS = ['what', 'where', 'who', 'build'] as const;
type Step = (typeof STEPS)[number];

export function SetupWizard({ onClose }: { onClose: () => void }) {
  const catalog = useStore((s) => s.setupCatalog);
  const loadSetupCatalog = useStore((s) => s.loadSetupCatalog);
  const requestSetupOffice = useStore((s) => s.requestSetupOffice);
  const dismissMenuNotice = useStore((s) => s.dismissMenuNotice);
  const pending = useStore((s) => s.pending);
  const menuNotice = useStore((s) => s.menuNotice);
  const steps = useStore((s) => s.setupSteps);
  const pickFolder = useStore((s) => s.pickFolder);
  const picking = useStore((s) => s.picking);
  const picked = useStore((s) => s.picked);

  const [step, setStep] = useState<Step>('what');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<Mode>('new');
  const [dir, setDir] = useState('');
  const [parent, setParent] = useState('');
  const [folder, setFolder] = useState('');
  const [folderTouched, setFolderTouched] = useState(false);
  const [team, setTeam] = useState<Record<string, Member>>({});
  const [teamPackage, setTeamPackage] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const busy = pending === 'create';
  // Сборка началась или закончилась отказом: экран прогресса показывает
  // шаги и ошибку, а форму уже не вернуть — офис мог быть создан частично.
  const building = steps !== null;

  useEffect(() => { loadSetupCatalog(); }, [loadSetupCatalog]);
  // Родитель по умолчанию — там же, где лежит последний проект.
  useEffect(() => {
    if (!parent && catalog?.recentParents[0]) setParent(catalog.recentParents[0]);
  }, [catalog, parent]);
  // Имя папки идёт за названием, пока человек не поправил его сам.
  useEffect(() => {
    if (!folderTouched) setFolder(slugify(name));
  }, [name, folderTouched]);

  const agents = useMemo(() => (catalog?.packages ?? []).filter((p) => p.kind === 'agent' && !p.manager && p.title), [catalog]);
  const teams = useMemo(() => (catalog?.packages ?? []).filter((p) => p.kind === 'team' && p.title), [catalog]);
  const byName = useMemo(() => new Map((catalog?.packages ?? []).map((p) => [p.name, p])), [catalog]);

  // Ответ нативного диалога: метка говорит, какому полю он предназначен.
  // Отмена — тишина; ошибка — строкой под полем, а не в чате офиса, которого нет.
  useEffect(() => {
    if (!picked) return;
    setPickError(picked.error);
    if (!picked.dir) return;
    if (picked.purpose === 'dir') setDir(picked.dir);
    else if (picked.purpose === 'parent') setParent(picked.dir);
    else if (picked.purpose.startsWith('path:')) setMember(picked.purpose.slice(5), { path: picked.dir });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.seq]);

  const canPick = catalog?.folderPicker === true && !busy;
  const pickButton = (purpose: string, start: string) => canPick && (
    <button type="button" className="setup-pick" disabled={picking !== null}
      onClick={() => { setPickError(null); pickFolder(purpose, start.trim() || undefined); }}>
      {picking === purpose ? t('setup.picking') : t('setup.pick')}
    </button>
  );

  const setMember = (pkg: string, patch: Partial<Member>) => setTeam((prev) => {
    const cur = prev[pkg] ?? { count: 0, ws: 'root', folder: slugify(pkg.split('/').pop() ?? ''), path: '' };
    const next = { ...cur, ...patch };
    if (next.count <= 0) {
      const { [pkg]: _gone, ...rest } = prev;
      return rest;
    }
    return { ...prev, [pkg]: next };
  });

  /** Команда — стартовая точка: состав и рабочие места переписываются её участниками. */
  const applyTeam = (pkg: MarketPackageView) => {
    const next: Record<string, Member> = {};
    for (const m of pkg.members) {
      if (byName.get(m.package)?.manager) continue;
      next[m.package] = {
        count: m.count, ws: m.workspace ? 'folder' : 'root',
        folder: m.workspace || slugify(m.package.split('/').pop() ?? ''), path: '',
      };
    }
    setTeam(next);
    setTeamPackage(pkg.name);
  };

  const whereProblem = (): boolean => {
    if (mode === 'existing') return !dir.trim();
    if (mode === 'new') return !parent.trim() || !FOLDER_RE.test(folder);
    return false;
  };
  const teamProblem = (): boolean => Object.values(team).some((m) =>
    (m.ws === 'folder' && !FOLDER_RE.test(m.folder)) || (m.ws === 'path' && !m.path.trim()));

  const canNext = (): boolean => {
    if (step === 'what') return Boolean(name.trim());
    if (step === 'where') return !whereProblem();
    if (step === 'who') return !teamProblem();
    return !busy;
  };

  const plan = (): OfficeSetupPlan => ({
    name: name.trim(),
    description: description.trim(),
    where: mode === 'existing' ? { mode, dir: dir.trim() }
      : mode === 'new' ? { mode, parent: parent.trim(), folder }
        : { mode },
    team: Object.entries(team).map(([pkg, m]) => ({
      package: pkg, count: m.count,
      workspace: m.ws === 'folder' ? { kind: 'folder', name: m.folder }
        : m.ws === 'path' ? { kind: 'path', dir: m.path.trim() }
          : { kind: 'root' },
    })),
    teamPackage,
  });

  const index = STEPS.indexOf(step);
  const back = () => { dismissMenuNotice(); setStep(STEPS[Math.max(0, index - 1)]); };
  const next = () => {
    if (!canNext()) return;
    if (step === 'build') requestSetupOffice(plan());
    else setStep(STEPS[index + 1]);
  };
  const close = () => { if (!busy) onClose(); };

  const headcount = Object.values(team).reduce((n, m) => n + m.count, 0);

  return (
    <div className="modal-backdrop" onClick={close}>
      <form className="modal wide setup" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); next(); }}>
        <div className="modal-head">
          <h3>{t('setup.title')}</h3>
          <ol className="setup-crumbs">
            {STEPS.map((id, i) => (
              <li key={id} className={id === step ? 'on' : i < index ? 'done' : ''}>{t(`setup.step.${id}`)}</li>
            ))}
          </ol>
        </div>

        {step === 'what' && (
          <div className="menu-form">
            <label>{t('offices.name')}
              <input autoFocus value={name} placeholder={t('offices.namePlaceholder')}
                onChange={(e) => setName(e.target.value)} />
            </label>
            <label>{t('setup.description')}
              <textarea rows={3} value={description} placeholder={t('setup.descriptionPlaceholder')}
                onChange={(e) => setDescription(e.target.value)} />
              <span className="hint">{t('setup.descriptionHint')}</span>
            </label>
          </div>
        )}

        {step === 'where' && (
          <div className="menu-form">
            <div className="seg setup-modes">
              {(['new', 'existing', 'none'] as Mode[]).map((m) => (
                <button type="button" key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                  {t(`setup.where.${m}`)}
                </button>
              ))}
            </div>
            {mode === 'existing' && (
              <label>{t('offices.dir')}
                <span className="setup-path">
                  <input autoFocus value={dir} placeholder="/Users/you/projects/my-app" onChange={(e) => setDir(e.target.value)} />
                  {pickButton('dir', dir)}
                </span>
                <span className="hint">{t('setup.where.existingHint')}</span>
              </label>
            )}
            {mode === 'new' && (
              <>
                <label>{t('setup.parent')}
                  <span className="setup-path">
                    <input autoFocus value={parent} list="setup-parents" placeholder="/Users/you/projects"
                      onChange={(e) => setParent(e.target.value)} />
                    {pickButton('parent', parent)}
                  </span>
                  <datalist id="setup-parents">
                    {(catalog?.recentParents ?? []).map((p) => <option key={p} value={p} />)}
                  </datalist>
                </label>
                <label>{t('setup.folder')}
                  <input value={folder} className={folder && !FOLDER_RE.test(folder) ? 'invalid' : ''}
                    onChange={(e) => { setFolderTouched(true); setFolder(e.target.value); }} />
                  <span className="hint">{t('setup.where.newHint', { dir: `${parent.trim().replace(/\/+$/, '') || '…'}/${folder || '…'}` })}</span>
                </label>
              </>
            )}
            {mode === 'none' && (
              <p className="hint">{t('setup.where.noneHint', { dir: `${catalog?.defaultRoot ?? '~/Office'}/${slugify(name, 'office')}` })}</p>
            )}
          </div>
        )}

        {step === 'who' && (
          <div className="menu-form setup-who">
            {!catalog && <p className="muted">{t('setup.loadingCatalog')}</p>}
            {teams.length > 0 && (
              <div className="setup-teams">
                <span className="hint">{t('setup.teamsHint')}</span>
                <div className="setup-team-row">
                  {teams.map((p) => (
                    <button type="button" key={p.name} className={`chip${teamPackage === p.name ? ' on' : ''}`}
                      style={{ '--chip-color': p.color } as React.CSSProperties}
                      title={p.summary} onClick={() => applyTeam(p)}>
                      {p.emoji} {p.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <p className="hint">{t('setup.pmAlways')}</p>
            <ul className="setup-agents">
              {agents.map((p) => {
                const m = team[p.name];
                return (
                  <li key={p.name} className={`setup-agent${m ? ' on' : ''}`}>
                    <span className="setup-agent-emoji" style={{ background: p.color }}>{p.emoji}</span>
                    <span className="setup-agent-text">
                      <span className="setup-agent-title">{p.title}</span>
                      <span className="setup-agent-summary">{p.summary}</span>
                      {p.mcp.length > 0 && <span className="setup-agent-mcp">{t('setup.mcp', { list: p.mcp.join(', ') })}</span>}
                    </span>
                    <span className="setup-count">
                      <button type="button" className="mini" disabled={!m} onClick={() => setMember(p.name, { count: (m?.count ?? 0) - 1 })}>−</button>
                      <b>{m?.count ?? 0}</b>
                      <button type="button" className="mini" disabled={(m?.count ?? 0) >= MAX_HIRE_COUNT}
                        onClick={() => setMember(p.name, { count: (m?.count ?? 0) + 1 })}>+</button>
                    </span>
                    {m && (
                      <span className="setup-ws">
                        <select value={m.ws} onChange={(e) => setMember(p.name, { ws: e.target.value as WsKind })}>
                          <option value="root">{t('setup.ws.root')}</option>
                          <option value="folder">{t('setup.ws.folder')}</option>
                          <option value="path">{t('setup.ws.path')}</option>
                        </select>
                        {m.ws === 'folder' && (
                          <input value={m.folder} className={FOLDER_RE.test(m.folder) ? '' : 'invalid'}
                            placeholder="backend" onChange={(e) => setMember(p.name, { folder: e.target.value })} />
                        )}
                        {m.ws === 'path' && (
                          <>
                            <input value={m.path} placeholder="/Users/you/projects/backend"
                              onChange={(e) => setMember(p.name, { path: e.target.value })} />
                            {pickButton(`path:${p.name}`, m.path)}
                          </>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {step === 'build' && !building && (
          <div className="menu-form setup-summary">
            <dl>
              <dt>{t('offices.name')}</dt><dd>{name.trim()}</dd>
              <dt>{t('setup.step.where')}</dt>
              <dd>
                {mode === 'existing' && dir.trim()}
                {mode === 'new' && `${parent.trim().replace(/\/+$/, '')}/${folder}`}
                {mode === 'none' && t('setup.summary.noProject')}
              </dd>
              <dt>{t('setup.step.who')}</dt>
              <dd>
                {headcount === 0 ? t('setup.summary.pmOnly') : Object.entries(team).map(([pkg, m]) => {
                  const p = byName.get(pkg);
                  const where = m.ws === 'folder' ? ` → ${m.folder}/` : m.ws === 'path' ? ` → ${m.path.trim()}` : '';
                  return <span key={pkg} className="setup-summary-member">{p?.emoji} {p?.title ?? pkg}{m.count > 1 ? ` ×${m.count}` : ''}{where}</span>;
                })}
              </dd>
              {description.trim() && <><dt>{t('setup.summary.direction')}</dt><dd>{description.trim()}</dd></>}
            </dl>
            <p className="hint">{t('setup.buildHint')}</p>
          </div>
        )}

        {step === 'build' && building && <Progress steps={steps} />}

        {pickError && <p className="menu-error">{pickError}</p>}
        {menuNotice?.kind === 'create-error' && <p className="menu-error">{menuNotice.text}</p>}

        <div className="menu-actions">
          {building
            ? <button type="button" onClick={onClose} disabled={busy}>{t('common.close')}</button>
            : (
              <>
                <button type="button" onClick={close} disabled={busy}>{t('common.cancel')}</button>
                {index > 0 && <button type="button" onClick={back} disabled={busy}>{t('setup.back')}</button>}
                <button type="submit" className="primary" disabled={!canNext()}>
                  {step === 'build' ? t('setup.create') : t('setup.next')}
                </button>
              </>
            )}
        </div>
      </form>
    </div>
  );
}

/** Ход сборки: шаги с состоянием. Упавший шаг — не конец: офис всё равно откроется, если поднялся. */
function Progress({ steps }: { steps: SetupStep[] | null }) {
  return (
    <ol className="setup-progress">
      {(steps ?? []).map((s) => (
        <li key={s.id} className={s.status}>
          <span className="setup-progress-dot" aria-hidden />
          <span className="setup-progress-text">
            <span>{s.label}</span>
            {s.detail && <span className="setup-progress-detail">{s.detail}</span>}
          </span>
        </li>
      ))}
      {steps?.length === 0 && <li className="running"><span className="setup-progress-dot" aria-hidden /><span>{t('setup.starting')}</span></li>}
    </ol>
  );
}

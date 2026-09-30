import { useMemo, useState } from 'react';
import {
  closeReleasePlan, resumeRelease, saveReleasePlan, setEpicRelease, startRelease, updateSettings, useStore,
} from './store';
import {
  LEVEL_MODES, RELEASE_KINDS, VERSION_LEVELS, VERSION_SCHEMES, allowsManual, parseReleaseConfig,
  releaseActive, versionLabel,
  type Release, type ReleaseTarget, type VersionLevel,
} from '../shared/release';
import type { Settings } from '../shared/types';
import { ShellPage } from './shell/ShellPage';
import { t } from './i18n';
import { money } from './money';
import { formatFullDateTime } from './dates';

type Tab = 'targets' | 'plans' | 'setup';

/**
 * Страница «Выпуски» (docs/design/releases/spec.md §11): цели карточками —
 * последний выпуск, что накопилось, кнопка «Выпустить», история; планы
 * выпусков и вклад фич; настройка целей полями с проверкой до сохранения.
 * Открывается из рейла в главной области (`RailView`), вкладки — в шапке.
 */
export function ReleasesPage() {
  const [tab, setTab] = useState<Tab>('targets');
  const tabs = (
    <div className="seg panel-tabs">
      {(['targets', 'plans', 'setup'] as Tab[]).map((k) => (
        <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(`releases.tab.${k}`)}</button>
      ))}
    </div>
  );
  return (
    <ShellPage title={t('releases.title')} actions={tabs} bodyClass="fixed">
      <div className="life releases">
        {tab === 'targets' && <TargetsTab onSetup={() => setTab('setup')} />}
        {tab === 'plans' && <PlansTab />}
        {tab === 'setup' && <SetupTab />}
      </div>
    </ShellPage>
  );
}

const label = (r: Release): string => versionLabel({ version: r.version, build: r.build }) || r.id;

function StatusChip({ release }: { release: Release }) {
  const cls = release.status === 'done' ? 'done' : release.status === 'failed' ? 'stuck'
    : release.status === 'waiting' ? 'waiting' : release.status === 'skipped' ? 'builtin' : 'running';
  return <span className={`chip ${cls}`}>{t(`releases.status.${release.status}`)}</span>;
}

/** Цели карточками: что выпущено, что накопилось, что идёт. */
function TargetsTab({ onSetup }: { onSetup: () => void }) {
  const settings = useStore((s) => s.settings);
  const releases = useStore((s) => s.releases);
  const tasks = useStore((s) => s.tasks);
  const epics = useStore((s) => s.epics);
  const targets = settings.release?.targets ?? [];
  if (!targets.length) {
    return (
      <div className="life-list">
        <p className="empty">{t('releases.empty')}</p>
        <div className="life-actions"><button className="mini" onClick={onSetup}>{t('releases.setupFirst')}</button></div>
      </div>
    );
  }
  return (
    <div className="life-list">
      {targets.map((target) => {
        const mine = releases.filter((r) => r.targetId === target.id).sort((a, b) => b.startedAt - a.startedAt);
        const last = mine.find((r) => r.status === 'done') ?? null;
        const active = mine.find((r) => releaseActive(r.status)) ?? null;
        const latest = mine[0] ?? null;
        const since = last?.startedAt ?? 0;
        const merged = Object.values(tasks).filter((x) => x.merged && (x.outcome?.at ?? 0) > since).length;
        const doneEpics = Object.values(epics).filter((e) => e.status === 'done' && (e.finishedAt ?? 0) > since).length;
        const stuck = latest && latest.status === 'failed' ? latest : null;
        return (
          <div key={target.id} className="life-row release-target">
            <div className="life-row-head">
              <b>{target.title}</b>
              <span className="chip builtin">{t(`releases.kind.${target.kind}`)}</span>
              <span className="muted small">{policyText(target)}</span>
            </div>
            <div className="release-facts">
              <span>{t('releases.last')}: <b>{last ? label(last) : '—'}</b>
                {last && <span className="muted small"> · {formatFullDateTime(last.startedAt)}</span>}</span>
              <span>{t('releases.pending', { tasks: merged, epics: doneEpics })}</span>
            </div>
            {last && last.links.length > 0 && (
              <div className="release-links">
                {last.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{l.title}</a>)}
              </div>
            )}
            {active && (
              <div className="release-live">
                <StatusChip release={active} /> <span className="mono small">{active.id}</span> {active.stage}
              </div>
            )}
            {stuck && (
              <div className="release-live stuck">
                <StatusChip release={stuck} /> {stuck.stage}
                {stuck.needsDecision && <span className="muted small"> · {t('releases.needsDecision')}</span>}
              </div>
            )}
            <div className="life-actions">
              <button className="mini" disabled={Boolean(active) || !allowsManual(target.policy)}
                title={allowsManual(target.policy) ? '' : t('releases.noManual')}
                onClick={() => startRelease(target.id)}>
                {t('releases.start')}
              </button>
              {stuck && <button className="mini" onClick={() => resumeRelease(stuck.id)}>{t('releases.resume')}</button>}
            </div>
            {mine.length > 0 && (
              <table className="flows-nodes">
                <thead>
                  <tr>
                    <th>{t('releases.col.version')}</th><th>{t('releases.col.status')}</th>
                    <th>{t('releases.col.when')}</th><th>{t('releases.col.why')}</th>
                    <th>{t('releases.col.tasks')}</th><th>{t('releases.col.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.slice(0, 8).map((r) => (
                    <tr key={r.id} title={r.notes}>
                      <td className="mono">{label(r)}</td>
                      <td><StatusChip release={r} /></td>
                      <td>{formatFullDateTime(r.startedAt)}</td>
                      <td>{t(`releases.reason.${r.reason === 'epic.done' ? 'epic' : r.reason}`)}</td>
                      <td>{r.taskIds.length}</td>
                      <td>{money(r.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

function policyText(target: ReleaseTarget): string {
  const when = target.policy.when.map((w) => (typeof w === 'string'
    ? t(`releases.when.${w === 'epic.done' ? 'epic' : 'manual'}`)
    : t('releases.when.merged', { n: w.merged }))).join(', ');
  return t('releases.policy', { when, approve: t(`releases.approve.${target.policy.approve}`) });
}

/** Планы выпусков и вклад фич в версию (§6.2). */
function PlansTab() {
  const settings = useStore((s) => s.settings);
  const plans = useStore((s) => s.releasePlans);
  const epicMap = useStore((s) => s.epics);
  const targets = settings.release?.targets ?? [];
  const epics = Object.values(epicMap).filter((e) => e.status !== 'cancelled').sort((a, b) => a.order - b.order);
  if (!targets.length) return <p className="empty">{t('releases.empty')}</p>;
  return (
    <div className="life-list">
      {targets.map((target) => (
        <PlanEditor key={`${target.id}:${plans.find((p) => p.targetId === target.id && p.status === 'open')?.id ?? ''}`}
          target={target} />
      ))}
      <div className="life-row">
        <div className="life-row-head"><b>{t('releases.contrib.title')}</b></div>
        <p className="muted small">{t('releases.contrib.hint')}</p>
        {epics.length === 0 && <p className="muted small">{t('releases.contrib.none')}</p>}
        {epics.map((e) => (
          <label key={e.id} className="flows-limit">
            <span className="mono">{e.id}</span>
            <span className="release-epic">{e.title}</span>
            <select value={e.release?.level ?? ''}
              onChange={(ev) => setEpicRelease(e.id, { target: e.release?.target ?? null, level: (ev.target.value || null) as VersionLevel | null })}>
              <option value="">{t('releases.contrib.default')}</option>
              {VERSION_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <select value={e.release?.target ?? ''}
              onChange={(ev) => setEpicRelease(e.id, { target: ev.target.value || null, level: e.release?.level ?? null })}>
              <option value="">{t('releases.contrib.anyTarget')}</option>
              {targets.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

function PlanEditor({ target }: { target: ReleaseTarget }) {
  const plans = useStore((s) => s.releasePlans);
  const epicMap = useStore((s) => s.epics);
  const open = plans.find((p) => p.targetId === target.id && p.status === 'open') ?? null;
  const closed = plans.filter((p) => p.targetId === target.id && p.status === 'closed').slice(-3);
  const [title, setTitle] = useState(open?.title ?? '');
  const [version, setVersion] = useState(open?.version ?? '');
  const [level, setLevel] = useState<VersionLevel | ''>(open?.level ?? '');
  const [picked, setPicked] = useState<string[]>(open?.epicIds ?? []);
  const epics = Object.values(epicMap).filter((e) => e.status !== 'cancelled').sort((a, b) => a.order - b.order);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const badVersion = version.trim() !== '' && !/^\d+\.\d+\.\d+$/.test(version.trim());
  return (
    <div className="life-row">
      <div className="life-row-head">
        <b>{target.title}</b>
        {open ? <span className="chip running">{t('releases.plan.open', { id: open.id })}</span>
          : <span className="muted small">{t('releases.plan.none')}</span>}
      </div>
      <div className="life-actions">
        <input value={title} placeholder={t('releases.plan.title')} onChange={(e) => setTitle(e.target.value)} />
        <input value={version} placeholder={t('releases.plan.version')} className="mono" onChange={(e) => setVersion(e.target.value)} />
        <select value={level} onChange={(e) => setLevel(e.target.value as VersionLevel | '')}>
          <option value="">{t('releases.plan.levelAuto')}</option>
          {VERSION_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      {badVersion && <div className="flows-problem">{t('releases.plan.badVersion')}</div>}
      <div className="release-epics">
        {epics.map((e) => (
          <label key={e.id} className="release-check">
            <input type="checkbox" checked={picked.includes(e.id)} onChange={() => toggle(e.id)} />
            <span className="mono">{e.id}</span> {e.title}
            {e.status === 'done' && <span className="chip done">{t('releases.plan.epicDone')}</span>}
          </label>
        ))}
      </div>
      <div className="life-actions">
        <button className="mini" disabled={badVersion || (!picked.length && !version.trim())}
          onClick={() => saveReleasePlan({
            id: open?.id, targetId: target.id, title, version: version.trim() || null,
            level: level || null, epicIds: picked,
          })}>
          {t(open ? 'releases.plan.save' : 'releases.plan.create')}
        </button>
        {open && <button className="mini" onClick={() => closeReleasePlan(open.id)}>{t('releases.plan.close')}</button>}
      </div>
      {closed.length > 0 && (
        <p className="muted small">{t('releases.plan.closed')}: {closed.map((p) => `${p.title}${p.releaseId ? ` → ${p.releaseId}` : ''}`).join(', ')}</p>
      )}
    </div>
  );
}

const blankTarget = (n: number): ReleaseTarget => ({
  id: `target-${n}`, title: '', kind: 'tag',
  policy: { when: ['manual'], approve: 'always' },
  version: { scheme: 'semver', level: 'plan' },
});

/**
 * Настройка целей полями. Проверка — тем же разбором, что на сервере:
 * кнопка «Сохранить» не нажимается, пока настройка с ошибкой, и ошибка
 * написана словами под формой.
 */
function SetupTab() {
  const settings = useStore((s) => s.settings);
  const [draft, setDraft] = useState<ReleaseTarget[]>(() => structuredClone(settings.release?.targets ?? []));
  const problem = useMemo(() => {
    try {
      parseReleaseConfig({ targets: draft }, settings.checks ?? {});
      return null;
    } catch (err) {
      const e = err as { issues?: Array<{ path: Array<string | number>; message: string }>; message: string };
      return e.issues ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : e.message;
    }
  }, [draft, settings.checks]);
  const edit = (i: number, patch: (x: ReleaseTarget) => ReleaseTarget) =>
    setDraft(draft.map((x, j) => (j === i ? patch(structuredClone(x)) : x)));
  const commands = Object.keys(settings.checks ?? {});
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.release?.targets ?? []);
  return (
    <div className="life-list">
      <p className="muted small">{t('releases.setup.hint')}</p>
      {draft.map((x, i) => {
        const merged = x.policy.when.find((w): w is { merged: number } => typeof w === 'object');
        const setWhen = (key: 'manual' | 'epic.done', on: boolean) => edit(i, (y) => {
          y.policy.when = on ? [...y.policy.when.filter((w) => w !== key), key] : y.policy.when.filter((w) => w !== key);
          return y;
        });
        return (
          <div key={i} className="life-row release-setup">
            <div className="life-actions">
              <input className="mono" value={x.id} placeholder="id" onChange={(e) => edit(i, (y) => ({ ...y, id: e.target.value }))} />
              <input value={x.title} placeholder={t('releases.setup.title')} onChange={(e) => edit(i, (y) => ({ ...y, title: e.target.value }))} />
              <select value={x.kind} onChange={(e) => edit(i, (y) => {
                const kind = e.target.value as ReleaseTarget['kind'];
                const next: ReleaseTarget = { ...y, kind };
                if (kind !== 'push') delete next.branch;
                if (kind !== 'command') delete next.run;
                if (kind === 'push' && !next.branch) next.branch = 'deploy';
                return next;
              })}>
                {RELEASE_KINDS.map((k) => <option key={k} value={k}>{t(`releases.kind.${k}`)}</option>)}
              </select>
              <button className="mini" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>×</button>
            </div>
            <div className="release-grid">
              {x.kind === 'push' && (
                <Field label={t('releases.setup.branch')}>
                  <input className="mono" value={x.branch ?? ''} onChange={(e) => edit(i, (y) => ({ ...y, branch: e.target.value }))} />
                </Field>
              )}
              {x.kind === 'tag' && (
                <Field label={t('releases.setup.tag')}>
                  <input className="mono" value={x.tag ?? ''} placeholder="v{version}"
                    onChange={(e) => edit(i, (y) => ({ ...y, tag: e.target.value || undefined }))} />
                </Field>
              )}
              {x.kind === 'command' && (
                <Field label={t('releases.setup.run')}>
                  <select value={x.run ?? ''} onChange={(e) => edit(i, (y) => ({ ...y, run: e.target.value || undefined }))}>
                    <option value="">—</option>
                    {commands.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
              )}
              <Field label={t('releases.setup.bump')}>
                <input className="mono" value={x.bump ?? ''} placeholder="npm version {version} --no-git-tag-version"
                  onChange={(e) => edit(i, (y) => ({ ...y, bump: e.target.value || undefined }))} />
              </Field>
              <Field label={t('releases.setup.timeout')}>
                <input type="number" min={1} max={120} value={x.timeoutMin ?? ''} placeholder="30"
                  onChange={(e) => edit(i, (y) => ({ ...y, timeoutMin: e.target.value ? Number(e.target.value) : undefined }))} />
              </Field>
              {x.kind !== 'command' && (
                <Field label={t('releases.setup.ci')}>
                  <select value={x.ci ?? 'auto'} onChange={(e) => edit(i, (y) => ({ ...y, ci: e.target.value as ReleaseTarget['ci'] }))}>
                    {(['auto', 'required', 'off'] as const).map((c) => <option key={c} value={c}>{t(`releases.ci.${c}`)}</option>)}
                  </select>
                </Field>
              )}
              <Field label={t('releases.setup.when')}>
                <span className="release-when">
                  <label className="release-check"><input type="checkbox" checked={x.policy.when.includes('manual')}
                    onChange={(e) => setWhen('manual', e.target.checked)} />{t('releases.when.manual')}</label>
                  <label className="release-check"><input type="checkbox" checked={x.policy.when.includes('epic.done')}
                    onChange={(e) => setWhen('epic.done', e.target.checked)} />{t('releases.when.epic')}</label>
                  <label className="release-check">
                    <input type="checkbox" checked={Boolean(merged)} onChange={(e) => edit(i, (y) => {
                      y.policy.when = e.target.checked
                        ? [...y.policy.when.filter((w) => typeof w !== 'object'), { merged: 5 }]
                        : y.policy.when.filter((w) => typeof w !== 'object');
                      return y;
                    })} />
                    {t('releases.when.mergedPrefix')}
                    <input type="number" min={1} value={merged?.merged ?? 5} disabled={!merged}
                      onChange={(e) => edit(i, (y) => {
                        y.policy.when = [...y.policy.when.filter((w) => typeof w !== 'object'), { merged: Math.max(1, Number(e.target.value) || 1) }];
                        return y;
                      })} />
                  </label>
                </span>
              </Field>
              <Field label={t('releases.setup.approve')}>
                <select value={x.policy.approve} onChange={(e) => edit(i, (y) => {
                  y.policy.approve = e.target.value as ReleaseTarget['policy']['approve'];
                  return y;
                })}>
                  {(['always', 'major', 'never'] as const).map((a) => <option key={a} value={a}>{t(`releases.approve.${a}`)}</option>)}
                </select>
              </Field>
              <Field label={t('releases.setup.cooldown')}>
                <input type="number" min={0} value={x.policy.cooldownHours ?? ''} placeholder="0"
                  onChange={(e) => edit(i, (y) => {
                    y.policy.cooldownHours = e.target.value ? Number(e.target.value) : undefined;
                    return y;
                  })} />
              </Field>
              <Field label={t('releases.setup.scheme')}>
                <select value={x.version.scheme} onChange={(e) => edit(i, (y) => {
                  y.version.scheme = e.target.value as ReleaseTarget['version']['scheme'];
                  return y;
                })}>
                  {VERSION_SCHEMES.map((v) => <option key={v} value={v}>{t(`releases.scheme.${v === 'semver+build' ? 'semverBuild' : v}`)}</option>)}
                </select>
              </Field>
              <Field label={t('releases.setup.level')}>
                <select value={x.version.level} onChange={(e) => edit(i, (y) => {
                  y.version.level = e.target.value as ReleaseTarget['version']['level'];
                  return y;
                })}>
                  {LEVEL_MODES.map((l) => <option key={l} value={l}>{t(`releases.level.${l}`)}</option>)}
                </select>
              </Field>
              <Field label={t('releases.setup.source')}>
                <select value={x.version.source ?? ''} onChange={(e) => edit(i, (y) => {
                  y.version.source = (e.target.value || undefined) as ReleaseTarget['version']['source'];
                  if (y.version.source !== 'command') delete y.version.read;
                  return y;
                })}>
                  <option value="">{t('releases.source.history')}</option>
                  <option value="tag">{t('releases.source.tag')}</option>
                  <option value="package.json">package.json</option>
                  <option value="command">{t('releases.source.command')}</option>
                </select>
              </Field>
              {x.version.source === 'command' && (
                <Field label={t('releases.setup.read')}>
                  <input className="mono" value={x.version.read ?? ''}
                    onChange={(e) => edit(i, (y) => { y.version.read = e.target.value || undefined; return y; })} />
                </Field>
              )}
            </div>
          </div>
        );
      })}
      <div className="life-actions">
        <button className="mini" onClick={() => setDraft([...draft, blankTarget(draft.length + 1)])}>{t('releases.setup.add')}</button>
        <button className="mini" disabled={!dirty || Boolean(problem)}
          onClick={() => updateSettings({ release: (draft.length ? { targets: draft } : null) as Settings['release'] })}>
          {t('releases.setup.save')}
        </button>
        {problem && <span className="flows-problem">{problem}</span>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="release-field">
      <span className="muted small">{label}</span>
      {children}
    </label>
  );
}

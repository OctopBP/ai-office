import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { t } from './i18n';
import { publishMyAgent } from './myAgents';
import { Row } from './AgentPanels';
import type { FieldError } from '../shared/types';
import type { MyAgentPublished, MyAgentView } from '../shared/myagent';

/**
 * Диалог «Опубликовать в маркет» у своего агента: поля `MyAgentPublishRequest`.
 * Проверку и публикацию делает сервер; диалог раскладывает его ошибки по
 * полям (`name`, `version`, `repoDir`, `path`, `token`, `package:license`),
 * а чему поля не нашлось — баннером. Значения прошлой публикации
 * подставляются из `agent.published`.
 */

const REPO_KEY = 'office.publish.repoDir';

/** Следующая patch после версии: `1.2.3` → `1.2.4`; не semver — как есть. */
function nextPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : v;
}

const errorsOf = (errors: FieldError[], field: string): FieldError[] =>
  errors.filter((e) => e.field === field || e.field.startsWith(`${field}:`) || e.field.startsWith(`${field}.`));

const FIELDS = ['name', 'version', 'repoDir', 'path', 'token', 'package:license'];

function rememberedRepo(): string {
  try { return localStorage.getItem(REPO_KEY) ?? ''; } catch { return ''; }
}

export function MyAgentPublishDialog({ agent, onClose, onPublished }: {
  agent: MyAgentView;
  onClose: () => void;
  onPublished: (published: MyAgentPublished) => void;
}) {
  const uid = useId();
  const prev = agent.published;
  const localId = agent.name.replace(/^@local\//, '');
  const [name, setName] = useState(prev?.name ?? '');
  const [version, setVersion] = useState(prev ? nextPatch(prev.version) : agent.version);
  const [license, setLicense] = useState(prev?.license || 'MIT');
  const [repoDir, setRepoDir] = useState(rememberedRepo());
  const [path, setPath] = useState(prev?.path || `agents/${localId}`);
  const [token, setToken] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [warnings, setWarnings] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLFormElement>(null);

  useEffect(() => { root.current?.querySelector<HTMLElement>('input')?.focus(); }, []);

  const close = () => { if (!busy) onClose(); };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErrors([]);
    const res = await publishMyAgent(agent.name, {
      name: name.trim(), version: version.trim(), license: license.trim(),
      repoDir: repoDir.trim(), path: path.trim(), token: token.trim() || undefined,
    });
    setBusy(false);
    if (res.ok) {
      try { localStorage.setItem(REPO_KEY, repoDir.trim()); } catch { /* память недоступна — не страшно */ }
      setWarnings(res.warnings);
      onPublished(res.published);
      return;
    }
    setErrors(res.errors);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
  };

  const inv = (f: string) => errorsOf(errors, f).length > 0;
  const field = (f: string) => ({
    id: `${uid}-${f}`,
    'aria-invalid': inv(f),
    'aria-describedby': inv(f) ? `${uid}-${f}-err` : undefined,
    className: inv(f) ? 'invalid' : undefined,
  });
  const note = (f: string) => inv(f) && (
    <span className="form-hint error" id={`${uid}-${f}-err`} role="alert">
      {errorsOf(errors, f).map((e) => e.message).join(' ')}
    </span>
  );
  // Ошибки валидатора пакета не про лицензию — у них нет своего поля, идут баннером.
  const unplaced = errors.filter((e) => !FIELDS.some((f) => errorsOf([e], f).length));

  return (
    <div className="modal-backdrop" onClick={close}>
      <form
        ref={root} className="modal wide publish-dialog" role="dialog" aria-modal="true" aria-labelledby={`${uid}-h`}
        aria-busy={busy} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <div className="modal-head"><h3 id={`${uid}-h`}>{t('agent.publish.title', { title: agent.title })}</h3></div>
        <p className="modal-reason">{t('agent.publish.intro')}</p>

        {errors.length > 0 && (
          <div className="form-banner error" role="alert">
            {t('agent.publish.failed', { n: errors.length })}
            {unplaced.length > 0 && <ul>{unplaced.map((e, i) => <li key={i}>{e.message}</li>)}</ul>}
          </div>
        )}
        {warnings.length > 0 && <div className="form-banner">{warnings.map((w) => w.message).join(' ')}</div>}

        <fieldset className="my-agent-lock" disabled={busy}>
          <div className="form">
            <Row id={`${uid}-name`} label={t('agent.publish.name')} hint={t('agent.publish.nameHint')}>
              <input {...field('name')} value={name} placeholder={`@owner/${localId}`} onChange={(e) => setName(e.target.value)} />
              {note('name')}
            </Row>
            <Row id={`${uid}-version`} label={t('agent.publish.version')} hint={prev ? t('agent.publish.versionPrev', { version: prev.version }) : undefined}>
              <input {...field('version')} value={version} onChange={(e) => setVersion(e.target.value)} />
              {note('version')}
            </Row>
            <Row id={`${uid}-package:license`} label={t('agent.publish.license')} hint={t('agent.publish.licenseHint')}>
              <input {...field('package:license')} value={license} onChange={(e) => setLicense(e.target.value)} />
              {note('package:license')}
            </Row>
            <Row id={`${uid}-repoDir`} label={t('agent.publish.repoDir')} hint={t('agent.publish.repoDirHint')}>
              <input {...field('repoDir')} value={repoDir} placeholder="/Users/me/Projects/agents" onChange={(e) => setRepoDir(e.target.value)} />
              {note('repoDir')}
            </Row>
            <Row id={`${uid}-path`} label={t('agent.publish.path')} hint={t('agent.publish.pathHint')}>
              <input {...field('path')} value={path} onChange={(e) => setPath(e.target.value)} />
              {note('path')}
            </Row>
            <Row id={`${uid}-token`} label={t('agent.publish.token')} hint={t('agent.publish.tokenHint')}>
              <input {...field('token')} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
              {note('token')}
            </Row>
          </div>
        </fieldset>
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={close}>{t('common.cancel')}</button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t('agent.publish.busy') : t('agent.publish.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}

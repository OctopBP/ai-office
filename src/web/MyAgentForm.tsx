import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { has, t, type UiKey } from './i18n';
import { useStore } from './store';
import { createFromRole, createMyAgent, draftFromRole, updateMyAgent } from './myAgents';
import { Row, Section } from './AgentPanels';
import type { FieldError, RoleView } from '../shared/types';
import type { MyAgentDraft, MyAgentSkill, MyAgentView } from '../shared/myagent';

/**
 * Форма «Создать агента» / «Изменить» / «Создать на основе» — в правой панели
 * окна «Команда» (docs/design/custom-agent/spec.md). Свой агент живёт в этом
 * офисе (Q-206): правка доходит до его копий здесь, в другие офисы он
 * попадает только публикацией в маркет.
 *
 * Проверку делает сервер; форма раскладывает его ошибки по полям (`field`),
 * а то, чему поля не нашлось, показывает баннером над формой.
 */

export type MyAgentFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; agent: MyAgentView }
  | { kind: 'from'; role: RoleView };

const TITLE_LIMIT = 60;
const SUMMARY_LIMIT = 140;
const BRIEF_SOFT = 8000;
const BRIEF_MAX = 30000;
const ACCENTS = [1, 2, 3, 4, 5, 6, 7, 8];
const EMOJIS = ['🎲', '🧑‍💻', '🎨', '📝', '🔍', '📊', '🧪', '🛠️', '📣', '🧭', '🤖', '💡'];
const TIERS = ['opus', 'sonnet', 'haiku'];
/** Встроенные инструменты Claude Code — пока провайдеры не приехали. */
const FALLBACK_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'WebSearch', 'WebFetch'];
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Поля формы, у которых есть место под строку ошибки. */
const SHOWN_FIELDS = new Set(['title', 'summary', 'brief', 'engine', 'model', 'docsDir', 'tools', 'mcp', 'color', 'zone']);

interface FormState {
  title: string;
  summary: string;
  emoji: string;
  color: string;
  brief: string;
  engine: string;
  model: string;
  isolate: boolean;
  docsDir: string;
  tools: string[];
  mcp: string[];
  skills: MyAgentSkill[];
  zone: string;
}

/** Цвета палитры в hex: сервер хранит `#rrggbb`, а токены знает только браузер. */
function accentHexes(): string[] {
  const style = getComputedStyle(document.documentElement);
  return ACCENTS.map((n) => {
    const raw = style.getPropertyValue(`--accent-${n}`).trim();
    return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : '#2f7bf6';
  });
}

const fromDraft = (d: MyAgentDraft, titleSuffix: boolean, allTools: string[], zone: string | null): FormState => ({
  title: titleSuffix ? t('agent.custom.copyTitle', { title: d.title }) : d.title,
  summary: d.summary ?? '',
  emoji: d.emoji ?? EMOJIS[0],
  color: (d.color ?? '').toLowerCase(),
  brief: d.brief ?? '',
  engine: d.engine ?? '',
  model: d.model ?? '',
  isolate: d.isolate === true,
  docsDir: d.docsDir ?? '',
  tools: d.tools ?? allTools,
  mcp: d.mcp ?? [],
  skills: d.skills ?? [],
  zone: zone ?? d.zone ?? '',
});

const toDraft = (f: FormState): MyAgentDraft => ({
  title: f.title.trim(),
  summary: f.summary.trim(),
  emoji: f.emoji,
  color: f.color || undefined,
  brief: f.brief,
  engine: (f.engine || null) as MyAgentDraft['engine'],
  model: f.model.trim(),
  isolate: f.isolate,
  ...(f.isolate ? {} : { docsDir: f.docsDir.trim() }),
  tools: f.tools,
  mcp: f.mcp,
  skills: f.skills,
  zone: f.zone || null,
});

/** Сообщение сервера у поля: точное совпадение или вложенное (`skills.0.name`). */
const errorsOf = (errors: FieldError[], field: string): FieldError[] =>
  errors.filter((e) => e.field === field || e.field.startsWith(`${field}.`));

function FieldNote({ id, errors }: { id: string; errors: FieldError[] }) {
  if (!errors.length) return null;
  return (
    <span className="form-hint error" id={id} role="alert">
      {errors.map((e) => e.message).join(' ')}
    </span>
  );
}

export function MyAgentForm({ mode, onSaved, onCancel, onDirty }: {
  mode: MyAgentFormMode;
  /** Сохранено: агент и id ролей-копий в офисе (нанятая или обновлённые). */
  onSaved: (agent: MyAgentView, roleIds: string[]) => void;
  onCancel: () => void;
  /** Есть несохранённое — окно спросит, прежде чем закрыть форму. */
  onDirty?: (dirty: boolean) => void;
}) {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const zones = useStore((s) => s.subprojects);
  const uid = useId();
  const root = useRef<HTMLFormElement>(null);
  const accents = useMemo(accentHexes, []);

  const providerList = providers?.providers ?? [];
  const known = useMemo(() => {
    const all = new Set<string>(FALLBACK_TOOLS);
    for (const p of providerList) for (const tool of p.builtinTools) all.add(tool);
    return [...all];
  }, [providerList]);
  const defaultTools = (available: string[]) => available.filter((x) => x !== 'Bash');

  const blank: FormState = {
    title: '', summary: '', emoji: EMOJIS[0], color: accents[0], brief: '', engine: '', model: '',
    isolate: false, docsDir: '', tools: defaultTools(FALLBACK_TOOLS), mcp: [], skills: [], zone: '',
  };
  const [form, setForm] = useState<FormState>(() => {
    if (mode.kind === 'edit') return fromDraft(mode.agent.draft, false, FALLBACK_TOOLS, mode.agent.zone);
    return blank;
  });
  const [initial, setInitial] = useState<FormState>(form);
  const [loading, setLoading] = useState(mode.kind === 'from');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [skillDraft, setSkillDraft] = useState<MyAgentSkill | null>(null);
  const [skillErrors, setSkillErrors] = useState<string[]>([]);

  // «Создать на основе»: черновик из роли приходит с сервера (бриф с припиской офиса).
  const sourceId = mode.kind === 'from' ? mode.role.id : null;
  useEffect(() => {
    if (!sourceId) return;
    let live = true;
    draftFromRole(sourceId).then((got) => {
      if (!live) return;
      setLoading(false);
      if ('error' in got) { setLoadError(got.error); return; }
      const next = fromDraft(got.draft, true, FALLBACK_TOOLS, null);
      setForm(next);
      setInitial(next);
    });
    return () => { live = false; };
  }, [sourceId]);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useEffect(() => { onDirty?.(dirty); }, [dirty]);
  useEffect(() => () => onDirty?.(false), []);

  // Инструменты движка: у выбранного движка, а без выбора — у движка офиса.
  const effectiveEngine = form.engine || settings.model?.provider || '';
  const engineView = providerList.find((p) => p.id === effectiveEngine);
  const available = engineView?.builtinTools ?? known;
  const engineLabel = engineView?.label ?? effectiveEngine;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    // Поле исправляют — его ошибка гаснет сразу, остальные остаются.
    setErrors((list) => list.filter((e) => e.field !== key && !e.field.startsWith(`${key}.`)));
  };
  const toggle = (key: 'tools' | 'mcp', value: string) => {
    const list = form[key];
    set(key, list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  };
  const changeEngine = (engine: string) => {
    const view = providerList.find((p) => p.id === (engine || settings.model?.provider));
    setForm((f) => ({
      ...f, engine,
      tools: view ? f.tools.filter((x) => view.builtinTools.includes(x)) : f.tools,
    }));
  };

  const servers = settings.mcpServers ?? [];
  const tierSelect = TIERS.includes(form.model) ? form.model : form.model ? 'custom' : '';
  const nonEmpty = form.title.trim() !== '' && form.brief.trim() !== '';

  const submit = async () => {
    if (saving || loading) return;
    setSaving(true);
    setErrors([]);
    const draft = toDraft(form);
    const res = mode.kind === 'edit'
      ? await updateMyAgent(mode.agent.name, draft)
      : mode.kind === 'from' ? await createFromRole(mode.role.id, draft) : await createMyAgent(draft);
    setSaving(false);
    if (res.ok) { onSaved(res.agent, res.roleIds); return; }
    setErrors(res.errors);
    // Фокус — в первое поле с ошибкой, чтобы не искать её глазами.
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
  };

  const addSkill = () => {
    if (!skillDraft) return;
    const problems: string[] = [];
    const name = skillDraft.name.trim();
    if (!SKILL_NAME_RE.test(name) || form.skills.some((s) => s.name === name)) problems.push(t('agent.custom.skill.nameBad'));
    if (!skillDraft.text.trim()) problems.push(t('agent.custom.skill.textEmpty'));
    setSkillErrors(problems);
    if (problems.length) return;
    set('skills', [...form.skills, { ...skillDraft, name, description: skillDraft.description.trim() }]);
    setSkillDraft(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !saving) { e.stopPropagation(); onCancel(); }
  };

  const unplaced = errors.filter((e) => !SHOWN_FIELDS.has(e.field.split('.')[0]) || e.field.startsWith('skills'));
  // Пустое обязательное поле подсказывает само — после первого ухода с него.
  const required = [['title', form.title, 'agent.custom.titleEmpty'], ['brief', form.brief, 'agent.custom.briefEmpty']] as const;
  const emptyErrors: FieldError[] = required
    .filter(([name, value]) => touched.has(name) && value.trim() === '' && !errors.some((e) => e.field === name))
    .map(([name, , key]) => ({ field: name, message: t(key) }));
  const shownErrors = [...errors, ...emptyErrors];
  const touch = (name: string) => setTouched((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));
  const inv = (field: string) => errorsOf(shownErrors, field).length > 0;
  const briefTokens = Math.round(form.brief.length / 3.5);

  const heading = mode.kind === 'edit'
    ? t('agent.custom.title.edit')
    : mode.kind === 'from' ? t('agent.custom.title.from', { title: mode.role.title }) : t('agent.custom.title.create');

  const field = (name: string): { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string; className?: string } => ({
    id: `${uid}-${name}`,
    'aria-invalid': inv(name),
    'aria-describedby': inv(name) ? `${uid}-${name}-err` : undefined,
    className: inv(name) ? 'invalid' : undefined,
  });
  const note = (name: string): ReactNode => <FieldNote id={`${uid}-${name}-err`} errors={errorsOf(shownErrors, name)} />;

  return (
    <form
      className="agent-page my-agent-form" ref={root} onKeyDown={onKeyDown}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      aria-busy={saving}
    >
      <div className="agent-top my-agent-head">
        <h3 className="agent-name">{heading}</h3>
        <p className="muted small">
          {mode.kind === 'edit'
            ? t('agent.custom.sub.edit', { name: mode.agent.name, version: mode.agent.version })
            : t('agent.custom.sub.new')}
        </p>
      </div>

      <div className="agent-panel">
        {loading && <p className="muted small" role="status">{t('agent.custom.loading')}</p>}
        {loadError && <div className="form-banner error" role="alert">{loadError}</div>}
        {errors.length > 0 && (
          <div className="form-banner error" role="alert">
            {t('agent.custom.errors', { n: errors.length })}
            {unplaced.length > 0 && <ul>{unplaced.map((e, i) => <li key={i}>{e.message}</li>)}</ul>}
          </div>
        )}
        {mode.kind === 'edit' && mode.agent.roleIds.length > 0 && (
          <div className="form-banner">{t('agent.custom.editBanner', { n: mode.agent.roleIds.length })}</div>
        )}
        {mode.kind === 'from' && <div className="form-banner">{t('agent.custom.fromBanner')}</div>}
        {mode.kind !== 'edit' && <div className="form-banner">{t('agent.custom.officeBanner')}</div>}

        <fieldset className="my-agent-lock" disabled={saving || loading}>
          <div className="form">
            <Section title={t('agent.custom.section.who')}>
              <Row id={`${uid}-title`} label={t('agent.custom.title')} hint={t('agent.custom.titleHint', { n: form.title.length, max: TITLE_LIMIT })}>
                <input
                  {...field('title')} value={form.title} autoFocus={mode.kind === 'create'} maxLength={200}
                  onChange={(e) => set('title', e.target.value)} onBlur={() => touch('title')}
                />
                {note('title')}
                {mode.kind === 'edit' && <span className="form-hint">{t('agent.custom.idStays', { name: mode.agent.name })}</span>}
              </Row>
              <Row id={`${uid}-summary`} label={t('agent.custom.summary')} hint={t('agent.custom.summaryHint', { n: form.summary.length, max: SUMMARY_LIMIT })}>
                <input {...field('summary')} value={form.summary} onChange={(e) => set('summary', e.target.value)} />
                {note('summary')}
              </Row>
              <Row label={t('agent.custom.emoji')}>
                <div className="my-agent-choices" role="radiogroup" aria-label={t('agent.custom.emoji')}>
                  {EMOJIS.map((e) => (
                    <button
                      key={e} type="button" role="radio" aria-checked={form.emoji === e}
                      className={`my-agent-emoji${form.emoji === e ? ' on' : ''}`} onClick={() => set('emoji', e)}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label={t('agent.custom.color')}>
                <div className="my-agent-choices" role="radiogroup" aria-label={t('agent.custom.color')}>
                  {ACCENTS.map((n, i) => (
                    <button
                      key={n} type="button" role="radio" aria-checked={form.color === accents[i]}
                      aria-label={t('agent.custom.colorN', { n })}
                      className={`my-agent-swatch${form.color === accents[i] ? ' on' : ''}`}
                      style={{ background: `var(--accent-${n})`, color: `var(--accent-${n}-ink)` }}
                      onClick={() => set('color', accents[i])}
                    >
                      {form.color === accents[i] ? '✓' : ''}
                    </button>
                  ))}
                </div>
                {note('color')}
              </Row>
            </Section>

            <Section title={t('agent.custom.section.brief')} desc={t('agent.custom.briefHint')}>
              <Row id={`${uid}-brief`} label={t('agent.custom.brief')} wide>
                <textarea
                  {...field('brief')} className={`my-agent-brief mono${inv('brief') ? ' invalid' : ''}`} rows={10}
                  value={form.brief} placeholder={t('agent.custom.briefPlaceholder')}
                  onChange={(e) => set('brief', e.target.value)} onBlur={() => touch('brief')}
                />
                <span className={`form-hint${form.brief.length > BRIEF_SOFT ? ' warn' : ''}`}>
                  {t('agent.custom.briefCount', { n: form.brief.length, tokens: briefTokens, soft: BRIEF_SOFT, max: BRIEF_MAX })}
                  {form.brief.length > BRIEF_SOFT && ` ${t('agent.custom.briefLong')}`}
                </span>
                {note('brief')}
              </Row>
            </Section>

            <Section title={t('agent.custom.section.model')}>
              <Row id={`${uid}-engine`} label={t('agent.custom.engine')}>
                <select {...field('engine')} value={form.engine} onChange={(e) => changeEngine(e.target.value)}>
                  <option value="">{t('agent.custom.asOffice')}</option>
                  {providerList.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
                {note('engine')}
              </Row>
              <Row id={`${uid}-model`} label={t('agent.custom.model')} hint={t('agent.custom.modelHint')}>
                <select
                  {...field('model')} value={tierSelect}
                  onChange={(e) => set('model', e.target.value === 'custom' ? ' ' : e.target.value)}
                >
                  <option value="">{t('agent.custom.asOffice')}</option>
                  {TIERS.map((x) => <option key={x} value={x}>{t(`agent.custom.tier.${x}` as UiKey)}</option>)}
                  <option value="custom">{t('agent.custom.tier.custom')}</option>
                </select>
                {tierSelect === 'custom' && (
                  <input
                    aria-label={t('agent.custom.model')} value={form.model.trim() === '' ? '' : form.model} autoFocus
                    onChange={(e) => set('model', e.target.value || ' ')}
                  />
                )}
                {note('model')}
              </Row>
              <Row id={`${uid}-isolate`} label={t('agent.custom.work')}>
                <select
                  {...field('isolate')} value={form.isolate ? 'code' : 'docs'}
                  onChange={(e) => set('isolate', e.target.value === 'code')}
                >
                  <option value="docs">{t('agent.custom.work.docs')}</option>
                  <option value="code">{t('agent.custom.work.code')}</option>
                </select>
              </Row>
              {!form.isolate && (
                <Row id={`${uid}-docsDir`} label={t('agent.custom.docsDir')} hint={t('agent.custom.docsDirHint')}>
                  <input
                    {...field('docsDir')} value={form.docsDir} placeholder="docs/agent"
                    onChange={(e) => set('docsDir', e.target.value)}
                  />
                  {note('docsDir')}
                </Row>
              )}
            </Section>

            <Section title={t('agent.custom.section.tools')}>
              <Row label={t('agent.custom.builtin')} hint={t('agent.custom.builtinHint', { engine: engineLabel || '—' })}>
                <div className="my-agent-checks" role="group" aria-label={t('agent.custom.builtin')} id={`${uid}-tools`}>
                  {known.map((tool) => {
                    const ok = available.includes(tool);
                    const key = `agent.custom.tool.${tool}`;
                    const about = has(key) ? t(key) : '';
                    return (
                      <label key={tool} className={`checkbox my-agent-check${ok ? '' : ' off'}`} aria-disabled={!ok}>
                        <input
                          type="checkbox" checked={ok && form.tools.includes(tool)} disabled={!ok}
                          aria-invalid={inv('tools')} onChange={() => toggle('tools', tool)}
                        />
                        <span className="mono">{tool}</span>
                        <span className="muted small">{ok ? about : t('agent.custom.toolOff', { engine: engineLabel })}</span>
                      </label>
                    );
                  })}
                </div>
                {note('tools')}
              </Row>
              <Row label={t('agent.custom.mcp')} hint={t('agent.custom.mcpHint')}>
                <div className="my-agent-checks" role="group" aria-label={t('agent.custom.mcp')} id={`${uid}-mcp`}>
                  {servers.length === 0 && <span className="muted small">{t('role.mcp.empty')}</span>}
                  {servers.map((s) => (
                    <label key={s.id} className={`checkbox my-agent-check${s.disabled ? ' off' : ''}`}>
                      <input
                        type="checkbox" checked={form.mcp.includes(s.id)} aria-invalid={inv('mcp')}
                        onChange={() => toggle('mcp', s.id)}
                      />
                      <span className="mono">{s.title || s.id}</span>
                      {s.disabled && <span className="muted small">{t('role.mcp.off')}</span>}
                    </label>
                  ))}
                </div>
                {note('mcp')}
              </Row>
              <Row label={t('agent.custom.skills')} hint={t('agent.custom.skillsHint')} wide>
                <ul className="my-agent-skills">
                  {form.skills.map((s) => (
                    <li key={s.name}>
                      <span className="mono">{s.name}</span>
                      <span className="muted small my-agent-skill-desc">{s.description}</span>
                      <button
                        type="button" className="mini ghost"
                        onClick={() => set('skills', form.skills.filter((x) => x.name !== s.name))}
                      >
                        {t('agent.custom.skill.remove')}
                      </button>
                    </li>
                  ))}
                </ul>
                {errorsOf(errors, 'skills').map((e, i) => <span key={i} className="form-hint error">{e.message}</span>)}
                {skillDraft ? (
                  <div className="my-agent-skill-form">
                    <input
                      aria-label={t('agent.custom.skill.name')} placeholder={t('agent.custom.skill.name')} autoFocus
                      value={skillDraft.name} onChange={(e) => setSkillDraft({ ...skillDraft, name: e.target.value })}
                    />
                    <input
                      aria-label={t('agent.custom.skill.when')} placeholder={t('agent.custom.skill.when')}
                      value={skillDraft.description}
                      onChange={(e) => setSkillDraft({ ...skillDraft, description: e.target.value })}
                    />
                    <textarea
                      className="mono" rows={5} aria-label={t('agent.custom.skill.text')} placeholder={t('agent.custom.skill.text')}
                      value={skillDraft.text} onChange={(e) => setSkillDraft({ ...skillDraft, text: e.target.value })}
                    />
                    {skillErrors.map((m, i) => <span key={i} className="form-hint error" role="alert">{m}</span>)}
                    <div className="modal-actions">
                      <button type="button" onClick={() => { setSkillDraft(null); setSkillErrors([]); }}>{t('common.cancel')}</button>
                      <button type="button" className="go" onClick={addSkill}>{t('agent.custom.skill.add')}</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" className="mini" onClick={() => setSkillDraft({ name: '', description: '', text: '' })}>
                    {t('agent.custom.skill.new')}
                  </button>
                )}
              </Row>
            </Section>

            <Section title={t('agent.custom.section.zone')}>
              <Row id={`${uid}-zone`} label={t('agent.custom.zone')} hint={t('agent.custom.zoneHint')}>
                <select {...field('zone')} value={form.zone} onChange={(e) => set('zone', e.target.value)}>
                  <option value="">{t('agent.custom.zone.all')}</option>
                  {zones.map((z) => <option key={z.id} value={z.id}>{z.name || z.id}</option>)}
                </select>
                {note('zone')}
              </Row>
            </Section>
          </div>
        </fieldset>

      </div>

      <div className="my-agent-foot">
        {saving && <span className="muted small" role="status"><span className="spinner" /> {t(mode.kind === 'edit' ? 'agent.custom.saving' : 'agent.custom.hiring')}</span>}
        <button type="button" onClick={onCancel} disabled={saving}>{t('common.cancel')}</button>
        {!nonEmpty && !saving && <span className="muted small" id={`${uid}-need`}>{t('agent.custom.needBoth')}</span>}
        <button type="submit" className="go" aria-describedby={nonEmpty ? undefined : `${uid}-need`} disabled={saving || loading || !nonEmpty} title={nonEmpty ? undefined : t('agent.custom.needBoth')}>
          {saving
            ? t(mode.kind === 'edit' ? 'agent.custom.saving' : 'agent.custom.hiring')
            : t(mode.kind === 'edit' ? 'common.save' : 'agent.custom.saveHire')}
        </button>
      </div>
    </form>
  );
}

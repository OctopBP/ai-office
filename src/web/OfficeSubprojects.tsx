import { useEffect, useRef, useState } from 'react';
import type { SubprojectDraft, SubprojectField, SubprojectKind, SubprojectView } from '../shared/types';
import { OFFICE_COLORS } from '../shared/types';
import { t } from './i18n';
import { saveSubproject, socketOpen, useStore } from './store';

/**
 * Раздел настроек «Подпроекты» (docs/design/subprojects/ui.md §1): список зон
 * и форма заведения и правки. Веб ничего не решает — допуск, вид по корню и
 * отказы считает сервер, форма показывает его тексты под нужным полем.
 */

const PICK_PURPOSE = 'zone-root';

const emptyDraft = (color: string): SubprojectDraft => ({
  name: '', root: '', summary: '', color, sharedPaths: [],
});

const fromZone = (z: SubprojectView): SubprojectDraft => ({
  name: z.name, root: z.root, kind: z.kind, summary: z.summary, color: z.color, sharedPaths: z.sharedPaths ?? [],
});

/** Первый цвет палитры, не занятый другими зонами; заняты все — по кругу. */
const freeColor = (zones: readonly SubprojectView[]): string =>
  OFFICE_COLORS.find((c) => !zones.some((z) => z.color === c)) ?? OFFICE_COLORS[zones.length % OFFICE_COLORS.length];

function ZoneCard({ zone, onOpen }: { zone: SubprojectView; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="zone-card" onClick={onOpen}>
        <span className="zone-mark" style={{ background: `var(--${zone.color})` }} aria-hidden="true" />
        <span className="zone-body">
          <span className="zone-head">
            <span className="zone-name" title={zone.name}>{zone.name}</span>
            <span className="zone-kind">{t(zone.kind === 'folder' ? 'settings.zones.kind.folder' : 'settings.zones.kind.repo')}</span>
            <code className="zone-root" title={zone.root}>{zone.root}</code>
          </span>
          {zone.summary && <span className="zone-summary" title={zone.summary}>{zone.summary}</span>}
          {zone.problem && <span className="zone-problem">⚠ {zone.problem}</span>}
        </span>
        <span className="zone-side">
          <span>
            {zone.members.length === 0
              ? t('settings.zones.nobody')
              : zone.members.slice(0, 4).map((m) => m.title).join(', ')
                + (zone.members.length > 4 ? ` +${zone.members.length - 4}` : '')}
          </span>
          <span>{zone.openTasks === 0 ? t('settings.zones.noTasks') : t('settings.zones.openTasks', { n: zone.openTasks })}</span>
        </span>
      </button>
    </li>
  );
}

function ZoneForm({ zone, zones, onClose }: { zone: SubprojectView | null; zones: SubprojectView[]; onClose: () => void }) {
  const [draft, setDraft] = useState<SubprojectDraft>(() => (zone ? fromZone(zone) : emptyDraft(freeColor(zones))));
  const [shared, setShared] = useState((zone?.sharedPaths ?? []).join(', '));
  const [errors, setErrors] = useState<Partial<Record<SubprojectField | 'form', string>>>({});
  const [busy, setBusy] = useState(false);
  const reply = useStore((s) => s.subprojectReply);
  const picked = useStore((s) => s.picked);
  const picking = useStore((s) => s.picking);
  const pickFolder = useStore((s) => s.pickFolder);
  const seenReply = useRef(reply?.seq ?? 0);
  const seenPick = useRef(picked?.seq ?? 0);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (!reply || reply.seq === seenReply.current) return;
    seenReply.current = reply.seq;
    setBusy(false);
    if (reply.message === null) { onClose(); return; }
    setErrors(reply.field ? { [reply.field]: reply.message } : { form: reply.message });
  }, [reply, onClose]);

  useEffect(() => {
    if (!picked || picked.seq === seenPick.current) return;
    seenPick.current = picked.seq;
    if (picked.purpose !== PICK_PURPOSE) return;
    if (picked.dir) setDraft((d) => ({ ...d, root: picked.dir! }));
    else if (picked.error) setErrors((e) => ({ ...e, root: picked.error! }));
  }, [picked]);

  const set = <K extends keyof SubprojectDraft>(key: K, value: SubprojectDraft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined, form: undefined }));
  };

  const submit = (): void => {
    const next: typeof errors = {};
    if (!draft.name.trim()) next.name = t('settings.zones.err.name');
    if (!draft.root.trim()) next.root = t('settings.zones.err.root');
    if (next.name || next.root) { setErrors(next); return; }
    if (!socketOpen()) { setErrors({ form: t('settings.zones.err.offline') }); return; }
    setBusy(true);
    setErrors({});
    const sharedPaths = draft.kind === 'repo' ? [] : shared.split(',').map((p) => p.trim()).filter(Boolean);
    saveSubproject(zone?.id, { ...draft, sharedPaths });
  };

  const kindButton = (kind: SubprojectKind) => (
    <button
      type="button"
      className={draft.kind === kind ? 'on' : ''}
      aria-pressed={draft.kind === kind}
      onClick={() => set('kind', draft.kind === kind ? undefined : kind)}
    >
      {t(kind === 'folder' ? 'settings.zones.kind.folder' : 'settings.zones.kind.repo')}
    </button>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form
        className="modal zone-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby="zone-form-title"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <h3 id="zone-form-title">
          {zone ? t('settings.zones.form.edit', { name: zone.name }) : t('settings.zones.form.new')}
        </h3>
        <p className="modal-reason">
          {zone ? t('settings.zones.form.idFixed', { id: zone.id }) : t('settings.zones.form.idNew')}
        </p>

        <label className="zone-field">
          <span>{t('settings.zones.field.name')}</span>
          <input
            ref={nameRef}
            value={draft.name}
            aria-invalid={Boolean(errors.name)}
            onChange={(e) => set('name', e.target.value)}
          />
          {errors.name && <span className="form-hint error" role="alert">{errors.name}</span>}
        </label>

        <div className="zone-field">
          <label htmlFor="zone-root">{t('settings.zones.field.root')}</label>
          <div className="zone-row">
            <input
              id="zone-root"
              className="zone-mono"
              value={draft.root}
              spellCheck={false}
              aria-invalid={Boolean(errors.root)}
              onChange={(e) => set('root', e.target.value)}
            />
            <button
              type="button"
              disabled={picking === PICK_PURPOSE}
              onClick={() => pickFolder(PICK_PURPOSE, draft.root.trim() || undefined)}
            >
              {t('settings.zones.pick')}
            </button>
          </div>
          {errors.root
            ? <span className="form-hint error" role="alert">{errors.root}</span>
            : <span className="form-hint">{t('settings.zones.rootHint')}</span>}
        </div>

        <div className="zone-field">
          <span>{t('settings.zones.field.kind')}</span>
          <div className="engine">{kindButton('folder')}{kindButton('repo')}</div>
          <span className="form-hint">{t('settings.zones.kindHint')}</span>
        </div>

        <label className="zone-field">
          <span>{t('settings.zones.field.summary')}</span>
          <input value={draft.summary} onChange={(e) => set('summary', e.target.value)} />
        </label>

        <div className="zone-field" role="group" aria-label={t('settings.zones.field.color')}>
          <span>{t('settings.zones.field.color')}</span>
          <div className="zone-swatches">
            {OFFICE_COLORS.map((c, i) => {
              const taken = zones.some((z) => z.color === c && z.id !== zone?.id);
              return (
                <button
                  key={c}
                  type="button"
                  className={`zone-swatch${draft.color === c ? ' on' : ''}${taken ? ' taken' : ''}`}
                  style={{ background: `var(--${c})`, color: `var(--${c}-ink)` }}
                  aria-pressed={draft.color === c}
                  aria-label={t('settings.zones.swatch', { n: i + 1 })}
                  title={taken ? t('settings.zones.swatchTaken') : undefined}
                  onClick={() => set('color', c)}
                >
                  {draft.color === c ? '✓' : ''}
                </button>
              );
            })}
          </div>
        </div>

        {draft.kind !== 'repo' && (
          <label className="zone-field">
            <span>{t('settings.zones.field.shared')}</span>
            <input
              className="zone-mono"
              value={shared}
              spellCheck={false}
              aria-invalid={Boolean(errors.sharedPaths)}
              onChange={(e) => { setShared(e.target.value); setErrors((er) => ({ ...er, sharedPaths: undefined })); }}
            />
            {errors.sharedPaths
              ? <span className="form-hint error" role="alert">{errors.sharedPaths}</span>
              : <span className="form-hint">{t('settings.zones.sharedHint')}</span>}
          </label>
        )}

        {errors.form && (
          <div className="zone-fail" role="alert">
            {t('settings.zones.err.failed', { text: errors.form })}
            <button type="button" className="mini" onClick={submit}>{t('settings.zones.retry')}</button>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="primary" disabled={busy}>
            {t(zone ? 'common.save' : 'settings.zones.create')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function OfficeSubprojects() {
  const zones = useStore((s) => s.subprojects);
  const connected = useStore((s) => s.connected);
  const [editing, setEditing] = useState<SubprojectView | 'new' | null>(null);

  // Правку открыли, а зону удалили с другого клиента — форма закрывается сама.
  useEffect(() => {
    if (editing && editing !== 'new' && !zones.some((z) => z.id === editing.id)) setEditing(null);
  }, [zones, editing]);

  if (!connected) return <p className="form-hint error" role="alert">{t('settings.zones.offline')}</p>;

  return (
    <div className="office-zones">
      {zones.length === 0 ? (
        <div className="zone-empty">
          <strong>{t('settings.zones.empty.title')}</strong>
          <p className="form-hint">{t('settings.zones.empty.text')}</p>
          <button type="button" className="primary" onClick={() => setEditing('new')}>{t('settings.zones.addFirst')}</button>
        </div>
      ) : (
        <>
          <div className="zone-toolbar">
            <button type="button" className="primary" onClick={() => setEditing('new')}>{t('settings.zones.add')}</button>
          </div>
          <ul className="zone-list">
            {zones.map((z) => <ZoneCard key={z.id} zone={z} onOpen={() => setEditing(z)} />)}
          </ul>
          <p className="form-hint">{t('settings.zones.wholeHint')}</p>
        </>
      )}
      {editing && (
        <ZoneForm zone={editing === 'new' ? null : editing} zones={zones} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

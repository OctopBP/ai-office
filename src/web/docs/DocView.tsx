import { useEffect, useRef, useState } from 'react';
import { pushToast, useStore } from '../store';
import { Markdown } from '../Markdown';
import { Icon } from '../icons';
import { AgentTag } from '../Avatar';
import { t } from '../i18n';
import { formatClock, formatDayLabel } from '../dates';
import type { DocKind, DocMeta, OfficeDoc } from '../../shared/types';
import { DOC_KINDS, archiveDoc, fetchDoc, updateDoc, useDocs } from './store';

const SUMMARY_MAX = 140;
const UNDO_TTL = 6000;

const when = (at: number): string => `${formatDayLabel(at)}, ${formatClock(at)}`;

function toast(title: string, kind: 'info' | 'failed' = 'info', action?: { label: string; run: () => void }): void {
  pushToast({ id: `doc-${Date.now()}-${Math.random()}`, kind, title, ttl: UNDO_TTL, action });
}

/**
 * Карточка документа в правой панели окна «Документы»: просмотр markdown,
 * правка владельцем с проверкой версии, смена типа и архив
 * (docs/design/office-docs/spec.md §6, §7, §9, §11).
 */
export function DocView({ meta }: { meta: DocMeta }) {
  const connected = useStore((s) => s.connected);
  const [doc, setDoc] = useState<OfficeDoc | null>(null);
  const [failed, setFailed] = useState(false);
  const [menu, setMenu] = useState(false);

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState(0);
  const [pane, setPane] = useState<'text' | 'preview'>('text');
  const [saving, setSaving] = useState(false);
  const [theirs, setTheirs] = useState<OfficeDoc | null>(null);
  const [showTheirs, setShowTheirs] = useState(false);
  const [askLeave, setAskLeave] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;

  // Другой документ — всё сначала.
  useEffect(() => {
    setDoc(null); setFailed(false); setEditing(false); setMenu(false);
    setTheirs(null); setShowTheirs(false); setAskLeave(false);
  }, [meta.id]);

  // Версия в оглавлении изменилась (правка агента, наша или чужая): перечитываем текст.
  useEffect(() => {
    let live = true;
    void fetchDoc(meta.id).then((r) => {
      if (!live) return;
      if (r.ok) { setDoc(r.doc); setFailed(false); } else setFailed(true);
    });
    return () => { live = false; };
  }, [meta.id, meta.version, meta.archived, meta.kind]);

  const dirty = editing && doc !== null && (title !== doc.title || summary !== doc.summary || body !== doc.body);
  // Пока владелец правит, версия ушла вперёд — документ изменили под ним.
  const conflict = editing && !saving && meta.version > base;

  useEffect(() => {
    if (!conflict || theirs?.version === meta.version) return;
    void fetchDoc(meta.id).then((r) => { if (r.ok && editingRef.current) setTheirs(r.doc); });
  }, [conflict, meta.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = () => {
    if (!doc) return;
    setTitle(doc.title); setSummary(doc.summary); setBody(doc.body);
    setBase(doc.version); setTheirs(null); setShowTheirs(false); setPane('text');
    setEditing(true);
  };

  const finishEdit = () => { setEditing(false); setAskLeave(false); setTheirs(null); setShowTheirs(false); };

  const cancel = () => {
    if (dirty && !askLeave) { setAskLeave(true); return; }
    finishEdit();
  };

  const save = async (over = false) => {
    if (!doc || saving || !title.trim()) return;
    setSaving(true);
    if (!over) {
      // Проверяем версию на сервере прямо перед записью: событие могло не дойти.
      const fresh = await fetchDoc(doc.id);
      if (fresh.ok && fresh.doc.version !== base) {
        setTheirs(fresh.doc); setSaving(false); return;
      }
    }
    const r = await updateDoc(doc.id, { title: title.trim(), summary: summary.trim(), body });
    setSaving(false);
    if (!r.ok) { toast(t('docs.saveError', { error: r.error }), 'failed'); return; }
    setDoc(r.doc);
    finishEdit();
  };

  const changeKind = async (kind: DocKind) => {
    if (!doc || kind === doc.kind) return;
    const prev = doc.kind;
    const r = await updateDoc(doc.id, { kind });
    if (!r.ok) { toast(t('docs.kindError', { error: r.error }), 'failed'); return; }
    setDoc(r.doc);
    toast(t('docs.kindMoved', { kind: t(`docs.kind.${kind}`) }), 'info', {
      label: t('docs.undo'),
      run: () => { void updateDoc(doc.id, { kind: prev }); },
    });
  };

  const setArchived = async (archived: boolean) => {
    if (!doc) return;
    setMenu(false);
    const r = await archiveDoc(doc.id, archived);
    if (!r.ok) { toast(t('docs.archiveError', { error: r.error }), 'failed'); return; }
    setDoc(r.doc);
    toast(t(archived ? 'docs.archivedToast' : 'docs.restoredToast'), 'info', {
      label: t('docs.undo'),
      run: () => { void archiveDoc(doc.id, !archived); },
    });
  };

  const copyText = () => {
    setMenu(false);
    if (doc) void navigator.clipboard?.writeText(doc.body);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void save(conflict || theirs !== null); }
    else if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
  };

  if (failed && !doc) return <div className="team-notice">{t('docs.viewError')}</div>;
  if (!doc) return <div className="docs-center"><span className="spinner" /></div>;

  const archived = doc.archived;
  const hasConflict = conflict || theirs !== null;
  const author = doc.updatedBy === 'owner' ? t('docs.you') : <AgentTag id={doc.updatedBy} />;

  if (editing) {
    return (
      <div className="docs-card docs-edit" onKeyDown={onKey}>
        <div className="docs-head">
          <div className="docs-actions">
            <button className="primary" disabled={!connected || saving || !title.trim()}
              onClick={() => void save(hasConflict)}>{t('docs.save')}</button>
            <button disabled={saving} onClick={cancel}>{t('docs.cancel')}</button>
            <span className={`save-status${dirty ? '' : ' saved'}`}>
              {dirty
                ? <span className="save-status-dirty"><i className="save-status-dot" />{t('docs.unsaved')}</span>
                : t('docs.noChanges')}
            </span>
          </div>
        </div>
        {askLeave && (
          <div className="team-notice team-close-ask docs-ask">
            {t('docs.leaveAsk')}
            <button className="mini" onClick={() => { setAskLeave(false); void save(hasConflict); }}>{t('docs.save')}</button>
            <button className="mini" onClick={finishEdit}>{t('docs.discard')}</button>
            <button className="mini ghost" onClick={() => setAskLeave(false)}>{t('docs.stay')}</button>
          </div>
        )}
        {hasConflict && (
          <div className="team-notice docs-conflict">
            <span>{t('docs.conflict', { who: theirs ? theirs.updatedBy : meta.updatedBy })}</span>
            <button className="mini" disabled={!theirs} onClick={() => setShowTheirs((v) => !v)}>
              {showTheirs ? t('docs.theirsHide') : t('docs.theirsShow')}
            </button>
            <button className="mini primary" disabled={saving} onClick={() => void save(true)}>{t('docs.saveOver')}</button>
          </div>
        )}
        {showTheirs && theirs && (
          <div className="card docs-theirs">
            <b>{theirs.title}</b>
            <Markdown source={theirs.body} />
          </div>
        )}
        <input className="docs-title-input" value={title} placeholder={t('docs.titlePh')}
          onChange={(e) => setTitle(e.target.value)} />
        <span className="docs-summary-row">
          <input value={summary} maxLength={SUMMARY_MAX} placeholder={t('docs.summaryPh')}
            onChange={(e) => setSummary(e.target.value)} />
          <span className="small docs-counter">{summary.length}/{SUMMARY_MAX}</span>
        </span>
        <span className="seg docs-pane-seg">
          <button className={pane === 'text' ? 'on' : ''} onClick={() => setPane('text')}>{t('docs.paneText')}</button>
          <button className={pane === 'preview' ? 'on' : ''} onClick={() => setPane('preview')}>{t('docs.panePreview')}</button>
        </span>
        <div className={`docs-split pane-${pane}`}>
          <textarea className="docs-source" value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="docs-preview"><Markdown source={body} /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="docs-card">
      <div className="docs-head">
        <h2>{doc.title}</h2>
        <div className="docs-meta small">
          {connected && !archived ? (
            <select value={doc.kind} onChange={(e) => void changeKind(e.target.value as DocKind)}>
              {DOC_KINDS.map((k) => <option key={k} value={k}>{t(`docs.kind.${k}`)}</option>)}
            </select>
          ) : <span className="chip">{t(`docs.kind.${doc.kind}`)}</span>}
          {doc.kind === 'working' && doc.taskId && <span className="chip">{doc.taskId}</span>}
          <span>{t('docs.editedBy')} {author}, {when(doc.updatedAt)}</span>
          <span>{t('docs.version', { n: doc.version })}</span>
        </div>
        <div className="docs-actions">
          <button disabled={!connected || archived} onClick={startEdit}>{t('docs.edit')}</button>
          <span className="docs-menu-wrap">
            <button className="sq ghost" onClick={() => setMenu((v) => !v)}><Icon name="dots" size={14} /></button>
            {menu && (
              <div className="float docs-menu">
                <button className="ghost" onClick={copyText}><Icon name="copy" size={12} /> {t('docs.copyText')}</button>
                <button className="ghost" disabled={!connected} onClick={() => void setArchived(!archived)}>
                  <Icon name="archive" size={12} /> {t(archived ? 'docs.archive.restore' : 'docs.archive.toArchive')}
                </button>
              </div>
            )}
          </span>
        </div>
      </div>
      {archived && (
        <div className="team-notice docs-archived">
          {t('docs.archivedNotice')}
          <button className="mini" disabled={!connected} onClick={() => void setArchived(false)}>{t('docs.archive.restore')}</button>
        </div>
      )}
      {doc.summary && <p className="docs-summary muted">{doc.summary}</p>}
      <div className="docs-body">
        {doc.body.trim() ? <Markdown source={doc.body} /> : <p className="muted">{t('docs.emptyBody')}</p>}
      </div>
    </div>
  );
}

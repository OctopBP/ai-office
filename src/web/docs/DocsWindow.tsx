import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { ShellPage } from '../shell/ShellPage';
import { Icon } from '../icons';
import { Tooltip } from '../Tooltip';
import { AgentTag } from '../Avatar';
import { HOTKEY } from '../hotkeys';
import { Kbd } from '../Kbd';
import { t } from '../i18n';
import { formatClock, formatDayLabel } from '../dates';
import type { DocKind, DocMeta } from '../../shared/types';
import { DocView } from './DocView';
import { DOC_KINDS, countKind, draftGuard, createDoc, useDocs, visibleDocs } from './store';
import { DocHistory } from './DocHistory';

const TEMPLATES = ['vision', 'characters', 'brand'] as const;

const when = (at: number): string => `${formatDayLabel(at)}, ${formatClock(at)}`;

/**
 * Окно «Документы» (docs/design/office-docs/spec.md): библиотека документов
 * офиса — вкладки по типам, поиск, режим архива, список. Справа — карточка
 * документа (DocView), по кнопке «История» — ящик версий (DocHistory).
 */
export function DocsWindow({ onClose }: { onClose: () => void }) {
  const officeId = useStore((s) => s.offices.find((o) => o.current)?.id ?? null);
  const connected = useStore((s) => s.connected);
  const d = useDocs();
  const list = visibleDocs(d);
  const searching = d.matches !== null;
  const selected = d.docs.find((x) => x.id === d.selectedId) ?? null;
  const [historyOpen, setHistoryOpen] = useState(false);

  // Уход с несохранённой правкой (другой документ, вкладка, закрытие) — через вопрос.
  const [leaving, setLeaving] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const go = (action: () => void) => {
    if (draftGuard.current?.dirty) { pending.current = action; setLeaving(true); } else action();
  };
  const resolveLeave = (how: 'save' | 'discard' | 'stay') => {
    const action = pending.current;
    pending.current = null;
    setLeaving(false);
    if (how === 'stay' || !action) return;
    if (how === 'discard') { draftGuard.current?.discard(); action(); return; }
    void draftGuard.current?.save().then((ok) => { if (ok) action(); });
  };
  useEffect(() => { setLeaving(false); }, [d.selectedId]);

  useEffect(() => { d.setOffice(officeId); }, [officeId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Вернулась связь — перечитываем снимок, пока окно открыто.
  useEffect(() => { if (connected && d.officeId) void d.reload(); }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const archivedCount = d.docs.filter((x) => x.kind === d.tab && x.archived).length;
  const others = DOC_KINDS.filter((k) => k !== d.tab && countKind(d, k) > 0);
  const kindTitle = (k: DocKind) => t(`docs.kind.${k}`);

  const row = (doc: DocMeta) => (
    <button key={doc.id}
      className={`team-role-row docs-row${d.selectedId === doc.id ? ' selected' : ''}${doc.archived ? ' archived' : ''}`}
      onClick={() => doc.id !== d.selectedId && go(() => d.select(doc.id))}>
      <span className="docs-row-title">
        <b>{doc.title}</b>
        {searching && d.allKinds && <span className="chip">{kindTitle(doc.kind)}</span>}
        {doc.kind === 'working' && doc.taskId && <span className="chip">{doc.taskId}</span>}
      </span>
      <span className="docs-row-desc muted small">{doc.summary || t('docs.noSummary')}</span>
      <span className="docs-row-meta small">
        {doc.updatedBy === 'owner' ? t('docs.you') : <AgentTag id={doc.updatedBy} />}
        {' · '}{when(doc.updatedAt)}
        {doc.createdBy !== doc.updatedBy && <span className="muted"> {t('docs.moreAuthors')}</span>}
      </span>
    </button>
  );

  const empty = () => {
    if (searching) {
      return (
        <div className="docs-empty muted">
          <p>{t('docs.empty.search', { query: d.appliedQuery })}</p>
          {others.map((k) => (
            <button key={k} className="ghost" onClick={() => go(() => d.setTab(k))}>
              {t('docs.empty.inOther', { kind: kindTitle(k), n: countKind(d, k) })}
            </button>
          ))}
          <button onClick={d.resetSearch}>{t('docs.empty.reset')}</button>
        </div>
      );
    }
    if (d.tab === 'foundation') {
      return (
        <div className="docs-empty">
          <div className="card docs-invite">{t('docs.empty.foundation')}</div>
          {TEMPLATES.map((k) => (
            <button key={k} className="team-role-row dashed" disabled={!connected}
              onClick={() => go(() => void createDoc(t(`docs.tpl.${k}`), 'foundation'))}>
              + {t(`docs.tpl.${k}`)}
            </button>
          ))}
        </div>
      );
    }
    if (d.tab === 'documentation') {
      return (
        <div className="docs-empty muted">
          <p>{t('docs.empty.documentation')}</p>
          <button disabled={!connected} onClick={() => go(() => void createDoc(t('docs.untitled'), 'documentation'))}>{t('docs.new')}</button>
        </div>
      );
    }
    return (
      <div className="docs-empty muted">
        <p>{t('docs.empty.working')}</p>
        {archivedCount > 0 && !d.showArchived && (
          <button className="ghost mini" onClick={() => d.setShowArchived(true)}>{t('docs.empty.showArchive')}</button>
        )}
      </div>
    );
  };

  const tabs = (
    <span className="seg team-tabs">
      {DOC_KINDS.map((k) => (
        <button key={k} className={d.tab === k ? 'on' : ''} title={kindTitle(k)} onClick={() => d.tab !== k && go(() => d.setTab(k))}>
          {t(`docs.tab.${k}`)} <span className="team-tab-count">{countKind(d, k)}</span>
        </button>
      ))}
    </span>
  );

  return (
    <ShellPage bodyClass="fixed team-page"
      title={<span className="team-head-left">{t('docs.title')}{tabs}</span>}
      actions={<>
        {selected && (
          <button className={`ghost mini${historyOpen ? ' on' : ''}`} onClick={() => setHistoryOpen((v) => !v)}>
            {t('docs.history.button')}
          </button>
        )}
        <button className="primary mini" disabled={!connected}
          onClick={() => go(() => void createDoc(t('docs.untitled'), d.tab))}>
          <Icon name="plus" size={12} /> {t('docs.new')}
        </button>
        <Tooltip tip={t('panel.close')}>
          <button className="sq ghost" onClick={() => go(onClose)}>✕</button>
        </Tooltip>
        <Kbd keys={HOTKEY.close} />
      </>}>
      <div className="team-window-body">
        <div className="team-list-pane docs-list-pane">
          <div className="team-list-head docs-list-head">
            <span className="docs-search">
              <Icon name="search" size={12} />
              <input value={d.query} placeholder={t('docs.search.ph')}
                onChange={(e) => d.setQuery(e.target.value)} />
              {d.query && <button className="sq ghost mini" onClick={d.resetSearch}>✕</button>}
            </span>
            {searching && !d.allKinds && (
              <button className="ghost mini" onClick={() => d.setAllKinds(true)}>{t('docs.search.allKinds')}</button>
            )}
            <label className="docs-archive-toggle small">
              <input type="checkbox" checked={d.showArchived} onChange={(e) => d.setShowArchived(e.target.checked)} />
              {t('docs.showArchive')}
            </label>
          </div>
          {!connected && <div className="team-notice">{t('docs.offline')}</div>}
          {d.load === 'error' && (
            <div className="team-notice">
              {t('docs.loadError')}
              <button className="mini" onClick={() => void d.reload()}>{t('docs.retry')}</button>
            </div>
          )}
          {(d.load === 'loading' || d.load === 'idle') && <div className="docs-center"><span className="spinner" /></div>}
          {d.load === 'ready' && (list.length ? (
            <>
              {list.map(row)}
              {!searching && <p className="team-group-hint muted small">{t(`docs.hint.${d.tab}`)}</p>}
            </>
          ) : empty())}
        </div>
        <div className="team-detail">
          {leaving && (
            <div className="team-notice team-close-ask docs-ask">
              {t('docs.leaveAsk')}
              <button className="mini" onClick={() => resolveLeave('save')}>{t('docs.save')}</button>
              <button className="mini" onClick={() => resolveLeave('discard')}>{t('docs.discard')}</button>
              <button className="mini ghost" onClick={() => resolveLeave('stay')}>{t('docs.stay')}</button>
            </div>
          )}
          {selected ? (
            <DocHistory docId={selected.id} version={selected.version} open={historyOpen} onClose={() => setHistoryOpen(false)}>
              <DocView meta={selected} />
            </DocHistory>
          ) : d.load === 'ready' && d.tab === 'foundation' && !d.docs.some((x) => x.kind === 'foundation' && !x.archived) && !searching ? (
            <div className="docs-center docs-intro">
              <Icon name="book" size={40} />
              <h3>{t('docs.intro.title')}</h3>
              <p className="muted">{t('docs.intro.text')}</p>
              <button className="primary" disabled={!connected}
                onClick={() => go(() => void createDoc(t('docs.tpl.vision'), 'foundation'))}>{t('docs.intro.write')}</button>
            </div>
          ) : (
            <div className="muted docs-center">{t('docs.pick')}</div>
          )}
        </div>
      </div>
    </ShellPage>
  );
}

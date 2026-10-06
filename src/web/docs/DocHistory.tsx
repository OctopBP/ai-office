import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import { AgentTag } from '../Avatar';
import { Markdown } from '../Markdown';
import { Tooltip } from '../Tooltip';
import { t } from '../i18n';
import { formatClock, formatDayLabel } from '../dates';
import type { DocHistoryResponse, DocResponse, DocVersion, OfficeDoc } from '../../shared/types';
import { diffLines, diffStat } from './linediff';

/** Порция списка версий: «Показать ещё» добавляет столько же (spec §10). */
const PAGE = 30;

const when = (at: number): string => `${formatDayLabel(at)}, ${formatClock(at)}`;

type Load = 'loading' | 'error' | 'ready';

/** Что открыто слева вместо текущего текста: версия на чтение или её дифф с текущей. */
type Opened = { version: number; mode: 'read' | 'diff' } | null;

const getJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as T;
};

/**
 * История версий документа (docs/design/office-docs/spec.md §10): ящик справа
 * со списком версий, а слева — либо `children` (текущий документ), либо
 * открытая старая версия только для чтения, либо её сравнение с текущей.
 * `version` — номер текущей версии из метаданных: сменился — список перечитывается.
 */
export function DocHistory({ docId, version, onClose, children }: {
  docId: string;
  version: number;
  onClose: () => void;
  children?: ReactNode;
}) {
  const officeId = useStore((s) => s.offices.find((o) => o.current)?.id ?? null);
  const [load, setLoad] = useState<Load>('loading');
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [shown, setShown] = useState(PAGE);
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<Opened>(null);
  const [openedDoc, setOpenedDoc] = useState<OfficeDoc | null>(null);
  const [openLoad, setOpenLoad] = useState<Load>('ready');

  const q = officeId ? `office=${encodeURIComponent(officeId)}` : '';
  const base = `/api/docs/${encodeURIComponent(docId)}`;

  // Сменился документ — всё открытое закрываем и начинаем с первой порции.
  useEffect(() => { setOpened(null); setShown(PAGE); }, [docId]);

  useEffect(() => {
    if (!officeId) return;
    let stale = false;
    setLoad((l) => (l === 'ready' && versions.length ? l : 'loading'));
    getJson<DocHistoryResponse>(`${base}/history?${q}`)
      .then((r) => { if (!stale) { setVersions(r.versions); setLoad('ready'); } })
      .catch(() => { if (!stale) setLoad('error'); });
    return () => { stale = true; };
  }, [officeId, docId, version, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Старая версия на чтение — отдельным запросом конкретной версии.
  useEffect(() => {
    setOpenedDoc(null);
    if (!opened || opened.mode !== 'read' || !officeId) return;
    let stale = false;
    setOpenLoad('loading');
    getJson<DocResponse>(`${base}?version=${opened.version}&${q}`)
      .then((r) => { if (!stale) { setOpenedDoc(r.doc); setOpenLoad('ready'); } })
      .catch(() => { if (!stale) setOpenLoad('error'); });
    return () => { stale = true; };
  }, [opened, officeId, docId]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = versions.length ? versions[versions.length - 1] : null;
  // Свежие сверху; размер правки — относительно предыдущей версии.
  const newestFirst = useMemo(() => [...versions].reverse(), [versions]);
  const page = newestFirst.slice(0, shown);
  const stats = useMemo(() => {
    const byVersion = new Map<number, { added: number; removed: number }>();
    for (const v of page) {
      const prev = versions.find((x) => x.version === v.version - 1);
      byVersion.set(v.version, diffStat(diffLines(prev?.body ?? '', v.body)));
    }
    return byVersion;
  }, [versions, shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const openedVersion = opened ? versions.find((v) => v.version === opened.version) ?? null : null;
  const diff = useMemo(
    () => (opened?.mode === 'diff' && openedVersion && current ? diffLines(openedVersion.body, current.body) : null),
    [opened, openedVersion, current],
  );

  const toggle = (v: number, mode: 'read' | 'diff') =>
    setOpened((o) => (o && o.version === v && o.mode === mode ? null : { version: v, mode }));

  const banner = (v: DocVersion, text: string) => (
    <div className="team-notice docs-history-banner">
      <span>{text}</span>
      <span className="muted small">
        {v.author === 'owner' ? t('docs.you') : <AgentTag id={v.author} />} · {when(v.at)}
      </span>
      <button className="mini" onClick={() => setOpened(null)}>{t('docs.history.backToCurrent')}</button>
    </div>
  );

  const main = () => {
    if (!opened || !openedVersion) return children;
    if (opened.mode === 'diff') {
      const s = diffStat(diff ?? []);
      return (
        <>
          {banner(openedVersion, t('docs.history.diffTitle', { n: openedVersion.version, current: current?.version ?? 0 }))}
          <div className="diff-stat">
            <span className="docs-history-add">+{s.added}</span> <span className="docs-history-del">−{s.removed}</span>
          </div>
          {diff && diff.length && (s.added || s.removed) ? (
            <div className="diff">
              {diff.map((l, i) => (
                <div key={i} className={`dl${l.kind === 'same' ? '' : ` ${l.kind}`}`}>
                  {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}{l.text}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">{t('docs.history.noChanges')}</p>
          )}
        </>
      );
    }
    return (
      <>
        {banner(openedVersion, t('docs.history.readOnly', { n: openedVersion.version }))}
        {openLoad === 'loading' && <div className="docs-center"><span className="spinner" /></div>}
        {openLoad === 'error' && (
          <div className="team-notice">
            {t('docs.history.loadError')}
            <button className="mini" onClick={() => setOpened({ ...opened })}>{t('docs.retry')}</button>
          </div>
        )}
        {openLoad === 'ready' && openedDoc && (
          <article className="docs-history-read">
            <h2>{openedDoc.title}</h2>
            {openedDoc.summary && <p className="muted">{openedDoc.summary}</p>}
            <Markdown source={openedDoc.body} />
          </article>
        )}
      </>
    );
  };

  const item = (v: DocVersion) => {
    const isCurrent = v.version === current?.version;
    const prev = versions.find((x) => x.version === v.version - 1);
    const s = stats.get(v.version);
    const on = opened?.version === v.version;
    return (
      <div key={v.version} className={`team-role-row docs-history-row${on ? ' selected' : ''}`}>
        <button className="docs-history-pick" onClick={() => toggle(v.version, 'read')}>
          <span className="docs-history-title">
            <b>{t('docs.history.version', { n: v.version })}</b>
            {isCurrent && <span className="chip">{t('docs.history.current')}</span>}
          </span>
          <span className="docs-row-meta small">
            {v.author === 'owner' ? t('docs.you') : <AgentTag id={v.author} />} · {when(v.at)}
          </span>
          {s && (s.added || s.removed) ? (
            <span className="small">
              <span className="docs-history-add">+{s.added}</span>{' '}
              <span className="docs-history-del">−{s.removed}</span>{' '}
              <span className="muted">{t('docs.history.lines')}</span>
            </span>
          ) : null}
          {prev && prev.kind !== v.kind && (
            <span className="muted small">{t('docs.history.kindChanged', { kind: t(`docs.kind.${v.kind}`) })}</span>
          )}
          {prev && prev.title !== v.title && (
            <span className="muted small">{t('docs.history.renamed', { title: v.title })}</span>
          )}
        </button>
        <span className="docs-history-actions">
          <button className={`ghost mini${on && opened?.mode === 'read' ? ' on' : ''}`}
            onClick={() => toggle(v.version, 'read')}>{t('docs.history.open')}</button>
          {!isCurrent && (
            <button className={`ghost mini${on && opened?.mode === 'diff' ? ' on' : ''}`}
              onClick={() => toggle(v.version, 'diff')}>{t('docs.history.compare')}</button>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="docs-history">
      <div className="docs-history-main">{main()}</div>
      <aside className="docs-history-drawer">
        <div className="docs-history-head">
          <b>{t('docs.history.title')}</b>
          <Tooltip tip={t('panel.close')}>
            <button className="sq ghost mini" onClick={onClose}>✕</button>
          </Tooltip>
        </div>
        {load === 'loading' && <div className="docs-center"><span className="spinner" /></div>}
        {load === 'error' && (
          <div className="team-notice">
            {t('docs.history.loadError')}
            <button className="mini" onClick={() => setAttempt((n) => n + 1)}>{t('docs.retry')}</button>
          </div>
        )}
        {load === 'ready' && (
          <>
            {page.map(item)}
            {versions.length <= 1 && <p className="muted small">{t('docs.history.single')}</p>}
            {newestFirst.length > shown && (
              <button className="ghost mini" onClick={() => setShown((n) => n + PAGE)}>{t('docs.history.more')}</button>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

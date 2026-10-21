import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addRule, archiveFact, confirmFact, decideProposal, dropRule,
  editRule, listRules, requestTeamRole, runRitual, useStore,
} from './store';
import { buildQueue, cardTitle, isOpenQuestion, queueSegments } from '../shared/questions';
import type {
  FactStatus, HealthEntry, OwnerQuestion, ProposalView, ProposalProbe, RitualId, RuleScopeView, RuleView,
} from '../shared/types';
import { RITUAL_IDS, isOfficeSender } from '../shared/types';
import { locale, t } from './i18n';
import { useInstanceName } from './instanceName';
import { Icon } from './icons';
import { Markdown } from './Markdown';
import { AgreeAll, CardView } from './QuestionCards';

type Tab = 'questions' | 'proposals' | 'rules' | 'journal' | 'rituals' | 'health';

const when = (at: number | null | undefined): string =>
  (at ? new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** Русское окончание по числу: 1 день, 2 дня, 5 дней. */
const pluralRu = (n: number, one: string, few: string, many: string): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
};

/** Возраст в человеческом виде: «3 дня», «5 часов», «2 минуты». */
const ageLabel = (ageMs: number): string => {
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (ageMs >= day) {
    const n = Math.floor(ageMs / day);
    return `${n} ${pluralRu(n, 'день', 'дня', 'дней')}`;
  }
  if (ageMs >= hour) {
    const n = Math.floor(ageMs / hour);
    return `${n} ${pluralRu(n, 'час', 'часа', 'часов')}`;
  }
  const n = Math.max(1, Math.floor(ageMs / minute));
  return `${n} ${pluralRu(n, 'минута', 'минуты', 'минут')}`;
};

/**
 * Панель «Жизнь офиса» (docs/design/living-office/spec.md): вопросы владельцу,
 * журнал и ритуалы. Планёрка показывает 3–5 вопросов; здесь — вся очередь,
 * весь журнал и то, когда что шло.
 */
export function LifePanel() {
  const [tab, setTab] = useState<Tab>('questions');
  const open = useStore((s) => s.questions.filter(isOpenQuestion).length);
  return (
    <div className="life">
      <div className="threads">
        {(['questions', 'rules', 'journal', 'rituals', 'health'] as Tab[]).map((k) => (
          <button key={k} className={`mini${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
            {t(`life.tab.${k}`)}{k === 'questions' && open ? ` · ${open}` : ''}
          </button>
        ))}
      </div>
      {tab === 'questions' && <Questions />}
      {tab === 'proposals' && <Proposals />}
      {tab === 'rules' && <Rules />}
      {tab === 'journal' && <Journal />}
      {tab === 'rituals' && <Rituals />}
      {tab === 'health' && <Health />}
    </div>
  );
}

/** Знак изменения числа: ▲ больше, ▼ меньше, = без изменений. */
function deltaSign(n: number): string {
  return n > 0 ? '▲' : n < 0 ? '▼' : '=';
}

/** Список добавленного/убранного одной строкой: «+a, b · −c». */
function setDiff(added: string[], removed: string[]): string {
  const parts = [] as string[];
  if (added.length) parts.push(`+ ${added.join(', ')}`);
  if (removed.length) parts.push(`− ${removed.join(', ')}`);
  return parts.join(' · ');
}

/**
 * Проба правила на стенде (T-670/T-671): что изменилось с правилом против
 * без него. Без прогона — одна строка с причиной. Решение принимает человек,
 * проба на него не влияет.
 */
function ProbeBlock({ probe }: { probe: ProposalProbe }) {
  const title = <div className="probe-title">{t('life.probe.title')}</div>;
  if (probe.status !== 'checked') {
    const why = t(`life.probe.${probe.status}`);
    return (
      <div className="probe" role="group" aria-label={t('life.probe.title')}>
        {title}
        <div className="probe-line muted small">{probe.note ? `${why}: ${probe.note}` : why}</div>
      </div>
    );
  }
  const sum = <K extends 'openedAdded' | 'calledAdded'>(a: K, r: K extends 'openedAdded' ? 'openedRemoved' : 'calledRemoved') =>
    setDiff([...new Set(probe.cases.flatMap((c) => c[a]))], [...new Set(probe.cases.flatMap((c) => c[r]))]);
  const skills = sum('openedAdded', 'openedRemoved');
  const calls = sum('calledAdded', 'calledRemoved');
  const money = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}$${Math.abs(n).toFixed(3)}`;
  const num = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`;
  const cls = (n: number) => (n > 0 ? 'worse' : n < 0 ? 'better' : '');
  const row = (label: string, value: string, c = '') => (
    <div className={`probe-row ${c}`}>
      <span className="probe-k">{label}</span>
      <span className="probe-v" title={value}>{value}</span>
    </div>
  );
  return (
    <div className="probe" role="group" aria-label={t('life.probe.title')}>
      {title}
      {row(t('life.probe.skills'), skills || t('life.probe.same'))}
      {row(t('life.probe.calls'), calls || t('life.probe.same'))}
      {row(t('life.probe.turns'), probe.turnsDelta ? `${deltaSign(probe.turnsDelta)} ${num(probe.turnsDelta)}` : t('life.probe.same'), cls(probe.turnsDelta))}
      {row(t('life.probe.cost'), probe.costDelta ? `${deltaSign(probe.costDelta)} ${money(probe.costDelta)}` : t('life.probe.same'), cls(probe.costDelta))}
      {(probe.broke > 0 || probe.fixed > 0) && row(t('life.probe.cases'), t('life.probe.casesValue', { fixed: probe.fixed, broke: probe.broke }), probe.broke > 0 ? 'worse' : 'better')}
      <div className="probe-line muted small">{t('life.probe.price', { runs: probe.runs, cost: `$${probe.costUsd.toFixed(3)}` })}</div>
    </div>
  );
}

/**
 * Предложения офиса (§8.1): правило для роли, настройка, фича при
 * выключенных инициативах. Офис ничего из этого не делает сам — принять или
 * отклонить решает человек, и только здесь.
 */
function Proposals() {
  const proposals = useStore((s) => s.proposals);
  const pending = proposals.filter((p) => p.status === 'pending').sort((a, b) => b.createdAt - a.createdAt);
  const decided = proposals.filter((p) => p.status !== 'pending').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  if (!proposals.length) return <p className="empty">{t('life.proposals.empty')}</p>;
  const row = (p: ProposalView) => (
    <div key={p.id} className={`life-row proposal ${p.kind}${p.status !== 'pending' ? ' closed' : ''}`}>
      <div className="life-row-head">
        <span className="mono dim">{p.id}</span>
        <span className={`chip ${p.kind}`}>{t(`life.proposals.kind.${p.kind}`)}</span>
        {p.kind === 'rule' && (
          <span className="chip rulekind" title={t(`life.proposals.ruleKind.${p.ruleKind ?? 'how'}.hint`)}>
            {t(`life.proposals.ruleKind.${p.ruleKind ?? 'how'}`)}
          </span>
        )}
        {p.roleId && <span className="muted small">{t('life.proposals.role', { role: p.roleId })}</span>}
        {p.directionId && <span className="muted small">{p.directionId}</span>}
        <span className="muted small">{when(p.createdAt)}</span>
        {p.status !== 'pending' && <span className="muted small">{t(`life.proposals.status.${p.status}`)}</span>}
      </div>
      <div className="life-text"><b>{p.title}</b></div>
      {p.text && p.text !== p.title && <div className="life-text"><Markdown source={p.text} compact /></div>}
      <div className="muted small">{p.rationale}</div>
      {p.probe && <ProbeBlock probe={p.probe} />}
      {p.status === 'pending' && (
        <div className="life-actions">
          <button className="allow" onClick={() => decideProposal(p.id, true)}>{t('life.proposals.accept')}</button>
          <button className="mini" onClick={() => decideProposal(p.id, false)}>{t('life.proposals.reject')}</button>
        </div>
      )}
    </div>
  );
  return (
    <div className="life-list">
      {pending.length > 0 && <div className="section-title">{t('life.proposals.pending')}</div>}
      {pending.map(row)}
      {decided.length > 0 && <div className="section-title">{t('life.proposals.decided')}</div>}
      {decided.slice(0, 30).map(row)}
    </div>
  );
}

/** Закрытый вопрос: суть, как закрыт и ответ — без кнопок. */
function ClosedQuestionRow({ q }: { q: OwnerQuestion }) {
  const asked = useInstanceName(q.from);
  const who = isOfficeSender(q.from) ? t('common.office') : asked;
  const waiting = !q.answeredAt && !q.dismissedAt;
  return (
    <div className={`life-row question ${q.kind} closed`}>
      <div className="life-row-head">
        <span className="mono dim">{q.id}</span>
        <span className={`chip ${q.kind}`}>{t(`life.questions.kind.${q.kind}`)}</span>
        <span className="muted small">{t('life.questions.from', { who })}</span>
        {q.taskId && <span className="muted small">{t('life.questions.task', { task: q.taskId })}</span>}
        <span className="muted small">{when(q.askedAt)}</span>
      </div>
      <div className="life-text">{cardTitle(q)}</div>
      {q.mergedInto && (
        <div className="muted small">
          {t(waiting ? 'life.questions.mergedWaiting' : 'life.questions.mergedInto', { id: q.mergedInto })}
        </div>
      )}
      {q.answeredAt && <div className="life-answer">{t('life.questions.answered')}: {q.answer}</div>}
      {q.dismissedAt && (
        <div className="muted small">
          {t('life.questions.dismissed')}{q.closedWhy ? ` — ${q.closedWhy}` : ''} · {when(q.dismissedAt)}
        </div>
      )}
    </div>
  );
}

type QuestionsView = 'queue' | 'list';
const VIEW_KEY = 'life.questions.view';

function loadView(): QuestionsView {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'queue'; } catch { return 'queue'; }
}

/** Пока решений меньше этого, подтверждения в списке не сворачиваются в строку. */
const FOLD_CONFIRM_AT = 3;

function Questions() {
  const questions = useStore((s) => s.questions);
  const [view, setView] = useState<QuestionsView>(loadView);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [foldOpen, setFoldOpen] = useState(false);
  const open = useMemo(() => questions.filter(isOpenQuestion), [questions]);
  const closed = useMemo(
    () => questions.filter((q) => !isOpenQuestion(q)).sort((a, b) => b.askedAt - a.askedAt),
    [questions],
  );
  const queue = useMemo(() => buildQueue(open, skipped), [open, skipped]);
  const decideCards = queue.filter((c) => c.section === 'decide');
  const confirmCards = queue.filter((c) => c.section === 'confirm');
  // Сделанные шаги очереди: карточки, что были на экране и исчезли.
  const seen = useRef(new Set<string>());
  queue.forEach((c) => seen.current.add(c.id));
  const done = [...seen.current].filter((id) => !queue.some((c) => c.id === id)).length;
  const current = queue[0];
  const switchView = (next: QuestionsView) => {
    if (next === view) return;
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* приватный режим */ }
    // Обратно в очередь — текущей становится первая неотвеченная, пропущенные не помнятся.
    if (next === 'queue') setSkipped([]);
    setView(next);
  };
  const currentId = current?.id;
  useEffect(() => {
    if (view === 'list' && currentId) document.getElementById(`oq-card-${currentId}`)?.scrollIntoView?.({ block: 'nearest' });
    // Прокрутка к текущей — только при переключении режима.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  const cardCount = queue.length;
  const closedBlock = closed.length > 0 && (
    <>
      <button className="mini ghost oq-closedlink" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>
        {showClosed ? t('life.questions.hideClosed') : t('life.questions.showClosed', { n: closed.length })}
      </button>
      {showClosed && (
        <>
          <div className="section-title">{t('life.questions.closed')}</div>
          {closed.slice(0, 30).map((q) => <ClosedQuestionRow key={q.id} q={q} />)}
        </>
      )}
    </>
  );
  const bar = (
    <div className="oq-bar">
      <div className="seg" role="group" aria-label={t('life.questions.viewLabel')}>
        {(['queue', 'list'] as QuestionsView[]).map((v) => (
          <button key={v} className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => switchView(v)}>
            {t(v === 'queue' ? 'life.questions.viewQueue' : 'life.questions.viewList')}
          </button>
        ))}
      </div>
      <span className="oq-count">
        {t('life.questions.countQuestions', { n: open.length })}
        {view === 'queue' ? ` · ${t('life.questions.countCards', { n: cardCount })}` : ''}
      </span>
    </div>
  );
  if (!open.length) {
    return (
      <div className="life-list">
        {questions.length > 0 && bar}
        <div className="oq-empty">
          <div className="oq-empty-ico" aria-hidden>✓</div>
          <h4>{t('life.questions.emptyTitle')}</h4>
          <p>{t('life.questions.emptyText')}</p>
        </div>
        {closedBlock}
      </div>
    );
  }
  if (view === 'queue' && current) {
    const segs = queueSegments(done, queue);
    const decideLeft = decideCards.length;
    return (
      <div className="life-list">
        {bar}
        {current.section === 'confirm' && decideLeft === 0 && (
          <div className="oq-handover">{t('life.questions.noDecisions', { n: confirmCards.length })}</div>
        )}
        <div className="oq-qhead">
          <span className={`oq-pos ${current.section}`} aria-live="polite">
            <b>{t(current.section === 'decide' ? 'life.questions.queueDecide' : 'life.questions.queueConfirm')}</b>
            {' · '}{t('life.questions.queuePos', { pos: done + 1, total: done + queue.length })}
          </span>
          <div className="oq-progress" aria-hidden>
            {segs.map((sg, i) => <i key={i} className={sg} />)}
          </div>
        </div>
        <CardView key={current.id} card={current} all={questions} />
        <div className="oq-qfoot">
          <span>{t('life.questions.queueHint')}</span>
          {queue.length > 1 && (
            <button className="mini ghost" onClick={() => setSkipped([...skipped.filter((id) => id !== current.id), current.id])}>
              {t('life.questions.skip')}
            </button>
          )}
        </div>
        {closedBlock}
      </div>
    );
  }
  const foldConfirm = decideCards.length >= FOLD_CONFIRM_AT && confirmCards.length > 0 && !foldOpen;
  return (
    <div className="life-list">
      {bar}
      {decideCards.length > 0 ? (
        <div className="oq-group decide">
          <h3>{t('life.questions.sectionDecide')}</h3>
          <span className="oq-n">{decideCards.reduce((n, c) => n + c.questions.length, 0)}</span>
          <span className="oq-rule" />
        </div>
      ) : (
        <div className="oq-handover">{t('life.questions.onlyConfirm', { n: confirmCards.length })}</div>
      )}
      {decideCards.map((c) => <CardView key={c.id} card={c} all={questions} />)}
      {confirmCards.length > 0 && (foldConfirm ? (
        <button className="mini ghost oq-fold" aria-expanded={false} onClick={() => setFoldOpen(true)}>
          {t('life.questions.confirmFold', { n: confirmCards.reduce((n, c) => n + c.questions.length, 0) })} ▸
        </button>
      ) : (
        <>
          <div className="oq-group">
            <h3>{t('life.questions.sectionConfirm')}</h3>
            <span className="oq-n">{confirmCards.reduce((n, c) => n + c.questions.length, 0)}</span>
            <span className="oq-rule" />
            <AgreeAll cards={confirmCards} />
          </div>
          {confirmCards.map((c) => <CardView key={c.id} card={c} all={questions} />)}
        </>
      ))}
      {closedBlock}
    </div>
  );
}

const scopeLabel = (scope: string): string => {
  if (scope === 'project') return t('life.journal.scope.project');
  if (scope === 'office') return t('life.journal.scope.office');
  return scope.replace(/^role:/, '');
};

/**
 * Правила офиса (docs/design/rules/spec.md) — единственное место, где видно
 * сразу все круги: весь офис, направления (репозитории) и роли.
 *
 * Список приходит с сервера целиком на каждую правку и своей копии здесь нет:
 * правила лежат файлами, номера пунктов после удаления съезжают, и угаданный
 * локально список разошёлся бы с тем, что доедет до агентов.
 */
function Rules() {
  const scopes = useStore((s) => s.rules);
  // Спрашиваем при открытии вкладки, а не в снимке офиса: файлы читаются с
  // диска, и делать это на каждое подключение ради панели, которую открывают
  // раз в неделю, незачем.
  useEffect(() => { listRules(); }, []);
  if (!scopes) return <p className="empty">{t('life.rules.loading')}</p>;
  return (
    <div className="life-list">
      {scopes.map((scope) => <RuleScope key={scope.id} scope={scope} />)}
      <p className="muted small">{t('life.rules.hint')}</p>
    </div>
  );
}

function RuleScope({ scope }: { scope: RuleScopeView }) {
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const who = scope.roles.map((r) => r.title).join(', ');
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    addRule(scope.id, text);
    setDraft('');
    setAdding(false);
  };
  return (
    <div className={`life-row rules-scope ${scope.kind}`}>
      <div className="life-row-head">
        <span className={`chip ${scope.kind}`}>{t(`life.rules.kind.${scope.kind}`)}</span>
        <b>{scope.label}</b>
        <span className="muted small">
          {who ? t('life.rules.who', { who }) : t('life.rules.nobody')}
        </span>
        {scope.path && <span className="mono dim small">{scope.path}/RULES.md</span>}
      </div>

      {scope.rules.length === 0 && <div className="muted small">{t('life.rules.empty')}</div>}
      {scope.rules.map((rule) => <RuleRow key={rule.id} rule={rule} editable={scope.editable} />)}

      {scope.editable ? (
        <div className="life-actions">
          {adding ? (
            <>
              <input
                autoFocus value={draft} placeholder={t('life.rules.placeholder')}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setAdding(false); }}
              />
              <button className="allow" onClick={submit}>{t('life.rules.save')}</button>
              <button className="mini" onClick={() => { setAdding(false); setDraft(''); }}>{t('life.rules.cancel')}</button>
            </>
          ) : (
            <button className="mini" onClick={() => setAdding(true)}>{t('life.rules.add')}</button>
          )}
        </div>
      ) : (
        // Правила роли — часть её брифа, и правятся там же. Второй редактор
        // того же текста разошёлся бы с первым.
        <div className="life-actions">
          <span className="muted small">{t('life.rules.roleOwned')}</span>
          <button className="mini" onClick={() => requestTeamRole(scope.roles[0]?.id ?? '')}>
            {t('life.rules.openRole')}
          </button>
        </div>
      )}
    </div>
  );
}

function RuleRow({ rule, editable }: { rule: RuleView; editable: boolean }) {
  const [text, setText] = useState(rule.text);
  const [editing, setEditing] = useState(false);
  // Снятие правила спрашивается прямо на кнопке: модальное окно ради одной
  // строки — перебор, а снять правило случайным кликом неприятно.
  const [confirm, setConfirm] = useState(false);
  const save = () => {
    const clean = text.trim();
    if (!clean || clean === rule.text) { setEditing(false); setText(rule.text); return; }
    editRule(rule.id, clean);
    setEditing(false);
  };
  if (editing) {
    return (
      <div className="rule-row editing">
        <input
          autoFocus value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setText(rule.text); } }}
        />
        <button className="allow" onClick={save}>{t('life.rules.save')}</button>
        <button className="mini" onClick={() => { setEditing(false); setText(rule.text); }}>{t('life.rules.cancel')}</button>
      </div>
    );
  }
  return (
    <div className="rule-row">
      <span className="life-text">{rule.text}</span>
      {editable && (
        <span className="rule-row-actions">
          <button className="mini" onClick={() => setEditing(true)}>{t('life.rules.edit')}</button>
          <button
            className="mini"
            onClick={() => (confirm ? dropRule(rule.id) : setConfirm(true))}
            onBlur={() => setConfirm(false)}
          >
            {t(confirm ? 'life.rules.dropConfirm' : 'life.rules.drop')}
          </button>
        </span>
      )}
    </div>
  );
}

const EVIDENCE_REF = /\b(?:T|J)-\d+\b/g;

/** Основание урока: T-N открывает карточку задачи, J-N ведёт к записи журнала, остальное — текст. */
function Evidence({ items, onTask, onFact }: {
  items: string[]; onTask: (id: string) => void; onFact: (id: string) => void;
}) {
  const facts = useStore((s) => s.facts);
  return (
    <div className="fact-evidence small">
      <span className="fact-label">{t('life.journal.evidence')}</span>
      <ul>
        {items.map((e, i) => {
          const parts: React.ReactNode[] = [];
          let last = 0;
          for (const m of e.matchAll(EVIDENCE_REF)) {
            const id = m[0];
            const idx = m.index ?? 0;
            if (id.startsWith('J-') && !facts.some((f) => f.id === id)) continue;
            if (idx > last) parts.push(e.slice(last, idx));
            parts.push(
              <button
                key={`${id}-${idx}`} type="button" className="link-btn mono"
                title={t(id.startsWith('T-') ? 'chatCard.openTask' : 'life.journal.openFact')}
                onClick={() => (id.startsWith('T-') ? onTask(id) : onFact(id))}
              >{id}</button>,
            );
            last = idx + id.length;
          }
          if (last < e.length) parts.push(e.slice(last));
          return <li key={i}>{parts}</li>;
        })}
      </ul>
    </div>
  );
}

function Journal() {
  const facts = useStore((s) => s.facts);
  const openTaskCard = useStore((s) => s.openTaskCard);
  const [status, setStatus] = useState<FactStatus>('live');
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (focusId) document.getElementById(`fact-${focusId}`)?.scrollIntoView({ block: 'center' });
  }, [focusId, status]);
  const showFact = (id: string) => {
    const target = facts.find((f) => f.id === id);
    if (!target) return;
    setStatus(target.status);
    setFocusId(id);
  };
  const shown = facts.filter((f) => f.status === status).sort((a, b) => b.confirmedAt - a.confirmedAt);
  if (!facts.length) return <p className="empty">{t('life.journal.empty')}</p>;
  return (
    <div className="life-list">
      <div className="seg mini-seg">
        {(['live', 'stale', 'archived'] as FactStatus[]).map((s) => (
          <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
            {t(`life.journal.${s}`)} · {facts.filter((f) => f.status === s).length}
          </button>
        ))}
      </div>
      {shown.map((f) => (
        <div key={f.id} id={`fact-${f.id}`} className={`life-row fact ${f.kind} ${f.status}${focusId === f.id ? ' focus' : ''}`}>
          <div className="life-row-head">
            <span className="mono dim">{f.id}</span>
            <span className={`chip ${f.kind}`}>{t(`life.journal.kind.${f.kind}`)}</span>
            <span className="muted small">{scopeLabel(f.scope)}</span>
            {f.source.taskId && <span className="muted small">{f.source.taskId}</span>}
            {f.source.questionId && <span className="muted small">{f.source.questionId}</span>}
            {f.unfounded && (
              <span className="chip unfounded" title={t('life.journal.unfoundedHint')}>
                {t('life.journal.unfounded')}
              </span>
            )}
            {f.supersededBy && (
              <span className="chip superseded" title={t('life.journal.supersededHint')}>
                {t('life.journal.superseded', { id: f.supersededBy })}
              </span>
            )}
            <span className="muted small">{t('life.journal.confirmed', { when: when(f.confirmedAt) })}</span>
          </div>
          <div className="life-text"><Markdown source={f.text} compact /></div>
          {f.cue && (
            <div className="fact-cue muted small">
              <span className="fact-label">{t('life.journal.cue')}</span> {f.cue}
            </div>
          )}
          {!!f.evidence?.length && <Evidence items={f.evidence} onTask={openTaskCard} onFact={showFact} />}
          {f.status !== 'archived' && (
            <div className="life-actions">
              <button className="mini" onClick={() => confirmFact(f.id)}>{t('life.journal.confirm')}</button>
              <button className="mini" onClick={() => archiveFact(f.id)}>{t('life.journal.archive')}</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Rituals() {
  const life = useStore((s) => s.life);
  const enabled = useStore((s) => s.settings.ritualsEnabled !== false);
  const runs = [...life.runs].reverse().slice(0, 20);
  return (
    <div className="life-list">
      <p className="muted small">{t(enabled ? 'life.rituals.hint' : 'life.rituals.off')}</p>
      {RITUAL_IDS.map((id: RitualId) => {
        const last = life.lastRun[id];
        const running = life.running === id;
        return (
          <div key={id} className="life-row ritual">
            <div className="life-row-head">
              <b>{t(`life.rituals.name.${id}`)}</b>
              <span className="muted small">
                {running ? t('life.rituals.running') : last ? t('life.rituals.last', { when: when(last) }) : t('life.rituals.never')}
              </span>
              <button className="mini" disabled={Boolean(life.running) || (!enabled && id !== 'standup')}
                onClick={() => runRitual(id)}>
                {t('life.rituals.run')}
              </button>
            </div>
            <div className="muted small">{t(`life.rituals.desc.${id}`)}</div>
          </div>
        );
      })}
      <div className="section-title">{t('life.rituals.policy')}</div>
      <div className="muted small life-policy">
        <span>{t('life.rituals.policy.consolidate', { h: Math.round(life.policy.consolidateEveryMs / 3_600_000) })}</span>
        <span>{t('life.rituals.policy.questions', { n: life.policy.questionsPerStandup })}</span>
        <span>{t('life.rituals.policy.pmLine')}: {t(life.policy.standupPmLine ? 'life.rituals.on' : 'life.rituals.offShort')}</span>
        <span>{t('life.rituals.policy.reflection')}: {t(life.policy.reflectionOn ? 'life.rituals.on' : 'life.rituals.offShort')}</span>
      </div>
      {runs.length > 0 && <div className="section-title">{t('life.rituals.runs')}</div>}
      {runs.map((r) => (
        <div key={r.id} className="life-run muted small">
          <span className="mono dim">{when(r.at)}</span>
          <span>{t(`life.rituals.name.${r.ritual}`)}</span>
          {/* Итог рефлексии и противоречий пишет агент — Markdown-ом. */}
          {r.note
            ? <div className="life-run-note"><Markdown source={r.note} compact /></div>
            : <span>{Object.entries(r.produced).map(([k, v]) => `${k} ${v}`).join(', ')}</span>}
          {r.costUsd > 0 && <span>${r.costUsd.toFixed(3)}</span>}
        </div>
      ))}
      <span className="dim"><Icon name="book" size={12} /></span>
    </div>
  );
}

/**
 * Здоровье офиса (T-25): три счётчика — провалы без разбора, протухшие
 * ветки, вставшие задачи. Ноль зелёным, больше нуля красным. Записи не
 * кликабельны — переход к задаче/ветке будет отдельной задачей.
 */
function Health() {
  const health = useStore((s) => s.health);
  if (!health) return <p className="empty">{t('life.health.empty')}</p>;
  const groups: { key: HealthEntry['kind']; label: string; entries: HealthEntry[] }[] = [
    { key: 'failure', label: t('life.health.failures'), entries: health.failures },
    { key: 'branch', label: t('life.health.branches'), entries: health.branches },
    { key: 'stall', label: t('life.health.stalled'), entries: health.stalled },
  ];
  const entries = [...health.failures, ...health.branches, ...health.stalled].sort((a, b) => b.ageMs - a.ageMs);
  return (
    <div className="life-list">
      <div className="health-counters">
        {groups.map((g) => (
          <div key={g.key} className={`health-counter ${g.entries.length ? 'bad' : 'good'}`}>
            <span className="health-counter-value">{g.entries.length}</span>
            <span className="health-counter-label">{g.label}</span>
          </div>
        ))}
      </div>
      {entries.length === 0
        ? <p className="empty">{t('life.health.clean')}</p>
        : entries.map((e, i) => (
          <div key={`${e.kind}-${e.taskId}-${e.reason}-${i}`} className="life-row health-entry">
            <div className="life-row-head">
              <span className="muted small">{ageLabel(e.ageMs)}</span>
            </div>
            <div className="life-text">{e.note}</div>
          </div>
        ))}
    </div>
  );
}

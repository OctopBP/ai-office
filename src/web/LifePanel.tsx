import { useState } from 'react';
import {
  answerQuestion, archiveFact, confirmFact, decideProposal, dismissQuestion, runRitual, useStore,
} from './store';
import type { FactStatus, HealthEntry, OwnerQuestion, ProposalView, RitualId } from '../shared/types';
import { RITUAL_IDS, isOfficeSender } from '../shared/types';
import { locale, t } from './i18n';
import { Icon } from './icons';

type Tab = 'questions' | 'proposals' | 'journal' | 'rituals' | 'health';

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
  const open = useStore((s) => s.questions.filter((q) => !q.answeredAt && !q.dismissedAt).length);
  return (
    <div className="life">
      <div className="threads">
        {(['questions', 'journal', 'rituals', 'health'] as Tab[]).map((k) => (
          <button key={k} className={`mini${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>
            {t(`life.tab.${k}`)}{k === 'questions' && open ? ` · ${open}` : ''}
          </button>
        ))}
      </div>
      {tab === 'questions' && <Questions />}
      {tab === 'proposals' && <Proposals />}
      {tab === 'journal' && <Journal />}
      {tab === 'rituals' && <Rituals />}
      {tab === 'health' && <Health />}
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
        {p.roleId && <span className="muted small">{t('life.proposals.role', { role: p.roleId })}</span>}
        {p.directionId && <span className="muted small">{p.directionId}</span>}
        <span className="muted small">{when(p.createdAt)}</span>
        {p.status !== 'pending' && <span className="muted small">{t(`life.proposals.status.${p.status}`)}</span>}
      </div>
      <div className="life-text"><b>{p.title}</b></div>
      {p.text && p.text !== p.title && <div className="life-text">{p.text}</div>}
      <div className="muted small">{p.rationale}</div>
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

function QuestionRow({ q }: { q: OwnerQuestion }) {
  const [answer, setAnswer] = useState('');
  // Поле ввода раскрывается ссылкой только у вопроса с вариантами: без них
  // строка должна выглядеть ровно как раньше.
  const [own, setOwn] = useState(false);
  // Ответ уходит по сокету, а вопрос закрывается уже следующим состоянием от
  // сервера — до этого момента держим кнопки заблокированными, иначе клик по
  // второму варианту отправит второй ответ.
  const [sending, setSending] = useState(false);
  const closed = Boolean(q.answeredAt || q.dismissedAt);
  const who = isOfficeSender(q.from) ? t('common.office') : q.from;
  const options = q.options ?? [];
  const send = (text: string) => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    answerQuestion(q.id, value);
    setAnswer('');
  };
  return (
    <div className={`life-row question ${q.kind}${closed ? ' closed' : ''}`}>
      <div className="life-row-head">
        <span className="mono dim">{q.id}</span>
        <span className={`chip ${q.kind}`}>{t(`life.questions.kind.${q.kind}`)}</span>
        <span className="muted small">{t('life.questions.from', { who })}</span>
        {q.taskId && <span className="muted small">{t('life.questions.task', { task: q.taskId })}</span>}
        <span className="muted small">{when(q.askedAt)}</span>
      </div>
      <div className="life-text">{q.text}</div>
      <div className="muted small">{t('life.questions.assumed')}: {q.assumption}</div>
      {q.answeredAt && <div className="life-answer">{t('life.questions.answered')}: {q.answer}</div>}
      {q.dismissedAt && <div className="muted small">{t('life.questions.dismissed')} · {when(q.dismissedAt)}</div>}
      {!closed && options.length > 0 && (
        <div className="life-options">
          {options.map((opt, i) => (
            <button key={`${i}:${opt}`} className="mini" disabled={sending} onClick={() => send(opt)}>{opt}</button>
          ))}
        </div>
      )}
      {!closed && (
        <div className="life-actions">
          {options.length > 0 && !own ? (
            <button className="mini ghost" disabled={sending} onClick={() => setOwn(true)}>
              {t('life.questions.ownWords')}
            </button>
          ) : (
            <>
              <input value={answer} placeholder={t('life.questions.answerPlaceholder')}
                autoFocus={own} disabled={sending}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send(answer); }} />
              <button className="allow" disabled={sending || !answer.trim()} onClick={() => send(answer)}>
                {t('life.questions.answer')}
              </button>
            </>
          )}
          <button className="mini" disabled={sending} onClick={() => dismissQuestion(q.id)}>
            {t('life.questions.dismiss')}
          </button>
        </div>
      )}
    </div>
  );
}

function Questions() {
  const questions = useStore((s) => s.questions);
  const open = questions.filter((q) => !q.answeredAt && !q.dismissedAt).sort((a, b) => b.askedAt - a.askedAt);
  const closed = questions.filter((q) => q.answeredAt || q.dismissedAt).sort((a, b) => b.askedAt - a.askedAt);
  if (!questions.length) return <p className="empty">{t('life.questions.empty')}</p>;
  return (
    <div className="life-list">
      {open.length > 0 && <div className="section-title">{t('life.questions.open')}</div>}
      {open.map((q) => <QuestionRow key={q.id} q={q} />)}
      {closed.length > 0 && <div className="section-title">{t('life.questions.closed')}</div>}
      {closed.slice(0, 30).map((q) => <QuestionRow key={q.id} q={q} />)}
    </div>
  );
}

const scopeLabel = (scope: string): string => {
  if (scope === 'project') return t('life.journal.scope.project');
  if (scope === 'office') return t('life.journal.scope.office');
  return scope.replace(/^role:/, '');
};

function Journal() {
  const facts = useStore((s) => s.facts);
  const [status, setStatus] = useState<FactStatus>('live');
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
        <div key={f.id} className={`life-row fact ${f.kind} ${f.status}`}>
          <div className="life-row-head">
            <span className="mono dim">{f.id}</span>
            <span className={`chip ${f.kind}`}>{t(`life.journal.kind.${f.kind}`)}</span>
            <span className="muted small">{scopeLabel(f.scope)}</span>
            {f.source.taskId && <span className="muted small">{f.source.taskId}</span>}
            {f.source.questionId && <span className="muted small">{f.source.questionId}</span>}
            <span className="muted small">{t('life.journal.confirmed', { when: when(f.confirmedAt) })}</span>
          </div>
          <div className="life-text">{f.text}</div>
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
          <span>{r.note || Object.entries(r.produced).map(([k, v]) => `${k} ${v}`).join(', ')}</span>
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

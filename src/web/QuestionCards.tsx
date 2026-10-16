import { useEffect, useMemo, useRef, useState } from 'react';
import {
  answerQuestion, deleteQuestion, dismissQuestion, editQuestion, mergeQuestion, pushToast, useStore,
} from './store';
import {
  ASSUMPTION_LINE, cardTitle, commonAssumption, commonOptions, confirmAnswer, findDuplicate, groupTopic,
  isOpenQuestion, plainText, proposalLine, stripBoilerplate, type QuestionCard,
} from '../shared/questions';
import type { OwnerQuestion } from '../shared/types';
import { isOfficeSender } from '../shared/types';
import { t } from './i18n';
import { useInstanceName } from './instanceName';
import { Markdown } from './Markdown';
import { mentionedTask } from './chat/filePaths';
import { ResultFiles } from './chat/ResultFiles';

/** Сколько вопрос висит: «5 мин назад», «3 ч назад», «2 д назад». */
const ago = (at: number): string => {
  const min = Math.max(1, Math.floor((Date.now() - at) / 60_000));
  if (min < 60) return t('life.questions.agoMin', { n: min });
  const hours = Math.floor(min / 60);
  return hours < 48 ? t('life.questions.agoHour', { n: hours }) : t('life.questions.agoDay', { n: Math.floor(hours / 24) });
};

/** Ответ вроде «Да» / «Выпускай» делает первую кнопку акцентной (§2). */
const YES_RE = /^(?:да|выпускай|согласен|ок|ok|yes|go)\b/i;

const isDelegate = (q: OwnerQuestion, i: number, options: readonly string[]): boolean =>
  q.kind === 'contradiction' && i === options.length - 1;

function Meta({ q, count }: { q: OwnerQuestion; count?: number }) {
  const asked = useInstanceName(q.from);
  const who = isOfficeSender(q.from) ? t('common.office') : asked;
  return (
    <div className="oq-meta">
      <span className={`oq-dot ${q.kind}`} aria-hidden />
      <span>{t(`life.questions.kind.${q.kind}`)}</span>
      <span>· {t('life.questions.from', { who })}</span>
      {q.taskId && <span>· {q.taskId}</span>}
      <span>· {ago(q.askedAt)}</span>
      {count ? <span className="oq-badge">×{count}</span> : null}
    </div>
  );
}

/** «Пока считаем: …» в одну строку; полный текст — в подсказке и в подробностях. */
function AssumedLine({ text }: { text: string }) {
  const plain = plainText(text);
  if (!plain) return null;
  const line = t('life.questions.assumedLine', { text: plain });
  return <div className="oq-assumed" title={line}>{line}</div>;
}

/** Ряд кнопок: общий для одиночного вопроса и общего ответа группы. */
function OptionRow({ q, options, disabled, onPick, onOwn }: {
  q: OwnerQuestion; options: readonly string[]; disabled: boolean;
  onPick: (opt: string) => void; onOwn: () => void;
}) {
  const plain = options.map((o, i) => ({ o, i })).filter(({ i }) => !isDelegate(q, i, options));
  const delegate = options.find((_, i) => isDelegate(q, i, options));
  const accent = options.length === 2 && YES_RE.test(options[0] ?? '');
  return (
    <div className="oq-opts">
      {plain.map(({ o, i }) => (
        <button key={`${i}:${o}`} className={`mini oq-opt${accent && i === 0 ? ' primary' : ''}`}
          disabled={disabled} onClick={() => onPick(o)}>{o}</button>
      ))}
      <button className="mini ghost oq-own" disabled={disabled} onClick={onOwn}>{t('life.questions.ownWords')}</button>
      {delegate && (
        <button className="mini oq-helper" disabled={disabled} onClick={() => onPick(delegate)}>
          <span aria-hidden>✦</span>{delegate}
        </button>
      )}
    </div>
  );
}

/** Поле свободного ответа. */
function AnswerInput({ value, onChange, onSend, disabled, placeholder, label }: {
  value: string; onChange: (v: string) => void; onSend: () => void; disabled: boolean;
  placeholder: string; label: string;
}) {
  return (
    <div className="oq-input">
      <input value={value} placeholder={placeholder} aria-label={placeholder} autoFocus disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSend(); }} />
      <button className="mini primary" disabled={disabled || !value.trim()} onClick={onSend}>{label}</button>
    </div>
  );
}

/** Кто из пары остаётся главным: согласование (его ждёт процесс), иначе старший. */
const keeperOf = (a: OwnerQuestion, b: OwnerQuestion): OwnerQuestion => {
  if ((a.kind === 'gate') !== (b.kind === 'gate')) return a.kind === 'gate' ? a : b;
  return a.askedAt <= b.askedAt ? a : b;
};

/** Правка, объединение, удаление и снятие без ответа — внутри «Подробнее». */
function Manage({ q, all }: { q: OwnerQuestion; all: OwnerQuestion[] }) {
  const [mode, setMode] = useState<'edit' | 'merge' | 'delete' | null>(null);
  const [draft, setDraft] = useState({ text: q.text, assumption: q.assumption });
  const [target, setTarget] = useState('');
  const others = all.filter((o) => o.id !== q.id && isOpenQuestion(o));
  const twin = findDuplicate(q, all);
  const hint = twin && keeperOf(q, twin).id === twin.id ? twin : null;
  const deletable = !(q.kind === 'gate');
  const merge = (into: string) => { if (into) { mergeQuestion(q.id, into); setMode(null); } };
  return (
    <div className="oq-manage">
      {hint && mode === null && (
        <div className="life-hint small">
          <span>{t('life.questions.similar', { id: hint.id })}</span>
          <button className="mini" onClick={() => merge(hint.id)}>{t('life.questions.mergeInto', { id: hint.id })}</button>
        </div>
      )}
      {mode === 'edit' && (
        <div className="life-edit">
          <textarea value={draft.text} rows={3} autoFocus aria-label={t('life.questions.edit')}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <label className="muted small">{t('life.questions.assumed')}
            <input value={draft.assumption} onChange={(e) => setDraft({ ...draft, assumption: e.target.value })} />
          </label>
          <div className="life-actions">
            <button className="mini primary" disabled={!draft.text.trim()}
              onClick={() => { editQuestion(q.id, draft.text, draft.assumption); setMode(null); }}>
              {t('life.questions.save')}
            </button>
            <button className="mini" onClick={() => setMode(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
      {mode === 'merge' && (
        <div className="life-actions">
          <select value={target} aria-label={t('life.questions.mergePick')} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{t('life.questions.mergePick')}</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>{o.id} — {cardTitle(o).slice(0, 70)}</option>
            ))}
          </select>
          <button className="mini primary" disabled={!target} onClick={() => merge(target)}>{t('life.questions.merge')}</button>
          <button className="mini" onClick={() => setMode(null)}>{t('common.cancel')}</button>
        </div>
      )}
      {mode === 'delete' && (
        <div className="life-actions">
          <span className="small">{t('life.questions.deleteConfirm', { id: q.id })}</span>
          <button className="mini" onClick={() => setMode(null)}>{t('common.cancel')}</button>
          <button className="mini danger" onClick={() => { deleteQuestion(q.id); setMode(null); }}>{t('life.questions.delete')}</button>
        </div>
      )}
      {mode === null && (
        <div className="life-manage">
          <button className="mini ghost" onClick={() => { setDraft({ text: q.text, assumption: q.assumption }); setMode('edit'); }}>
            {t('life.questions.edit')}
          </button>
          {others.length > 0 && (
            <button className="mini ghost" onClick={() => { setTarget(''); setMode('merge'); }}>{t('life.questions.mergeWith')}</button>
          )}
          {deletable && <button className="mini ghost" onClick={() => setMode('delete')}>{t('life.questions.delete')}</button>}
          <button className="mini ghost" onClick={() => dismissQuestion(q.id)}>{t('life.questions.dismiss')}</button>
        </div>
      )}
    </div>
  );
}

/** Что есть под «Подробнее», кроме управления (его всегда можно показать). */
function detailText(q: OwnerQuestion, headline: string): string {
  const full = (q.details ?? stripBoilerplate(q.text)).trim();
  return plainText(full) === headline ? '' : full;
}

function Details({ q, all, headline }: { q: OwnerQuestion; all: OwnerQuestion[]; headline: string }) {
  const full = detailText(q, headline);
  const assumedLong = plainText(q.assumption).length > ASSUMPTION_LINE;
  const openTaskCard = useStore((s) => s.openTaskCard);
  return (
    <div className="oq-details">
      {full && (
        <section>
          <div className="oq-lbl">{t('life.questions.dFull')}</div>
          <div className="life-text"><Markdown source={full} compact files={{ task: q.taskId ?? mentionedTask(full) }} /></div>
        </section>
      )}
      {q.quotes && q.quotes.length > 0 && (
        <section>
          <div className="oq-lbl">{t('life.questions.dQuotes')}</div>
          {q.quotes.map((quote, i) => (
            <div key={`${i}:${quote.ref}`}>
              {i > 0 && <div className="oq-vs">{t('life.questions.vs')}</div>}
              <blockquote className="oq-quote">
                <div className="oq-ref">{quote.ref}{quote.note ? ` · ${quote.note}` : ''}</div>
                {quote.text}
              </blockquote>
            </div>
          ))}
        </section>
      )}
      {q.basis && (
        <section>
          <div className="oq-lbl">{t('life.questions.dBasis')}</div>
          <Markdown source={q.basis} compact />
        </section>
      )}
      {assumedLong && (
        <section>
          <div className="oq-lbl">{t('life.questions.dAssumed')}</div>
          <Markdown source={q.assumption} compact />
        </section>
      )}
      {q.refs && q.refs.length > 0 && (
        <section>
          <div className="oq-lbl">{t('life.questions.dRefs')}</div>
          <div className="oq-refs">
            {q.refs.map((r) => (r.kind === 'task'
              ? <button key={`${r.kind}:${r.id}`} className="oq-chip" onClick={() => openTaskCard(r.id)}>{r.label ?? r.id}</button>
              : <span key={`${r.kind}:${r.id}`} className="oq-chip" title={r.id}>{r.label ?? r.id}</span>))}
          </div>
        </section>
      )}
      {q.files && q.files.length > 0 && (
        <section>
          <div className="oq-lbl">{t('life.questions.dFiles')}</div>
          <ResultFiles files={q.files} task={q.taskId} />
        </section>
      )}
      <Manage q={q} all={all} />
    </div>
  );
}

/**
 * Карточка открытого вопроса: решение (суть, кнопки, допущение) или
 * подтверждение («Офис считает: …»). `sub` — вопрос внутри раскрытой группы.
 */
export function QuestionCardView({ q, all, sub = false }: { q: OwnerQuestion; all: OwnerQuestion[]; sub?: boolean }) {
  const [more, setMore] = useState(false);
  const [own, setOwn] = useState(false);
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const options = q.options ?? [];
  const proposal = q.proposal?.trim() ?? '';
  const confirm = proposal !== '';
  const headline = cardTitle(q);
  const send = (text: string) => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    answerQuestion(q.id, value);
    setAnswer('');
  };
  // Вариант с «…» — не ответ, а начало: открываем поле с заготовкой.
  const pick = (opt: string) => {
    if (!opt.endsWith('…')) return send(opt);
    setOwn(true);
    setAnswer(`${opt.slice(0, -1).trim()}: `);
  };
  return (
    <article className={`oq${confirm ? ' confirm' : ''}${sub ? ' sub' : ''}`} id={sub ? undefined : `oq-card-${q.id}`}>
      {!sub && <Meta q={q} />}
      {confirm ? (
        <p className="oq-says">
          {t('life.questions.officeThinks')} <b>{proposalLine(proposal)}</b>
        </p>
      ) : (
        <h4 className="oq-title">{headline}</h4>
      )}
      {confirm ? (
        own ? (
          <>
            <AnswerInput value={answer} onChange={setAnswer} onSend={() => send(answer)} disabled={sending}
              placeholder={t('life.questions.howThen')} label={t('life.questions.send')} />
            <button className="mini ghost oq-own" onClick={() => { setOwn(false); setAnswer(''); }}>
              {t('life.questions.backToAgree')}
            </button>
          </>
        ) : (
          <div className="oq-opts">
            <button className="mini primary" disabled={sending} onClick={() => send(confirmAnswer(proposal))}>
              {t('life.questions.agree')}
            </button>
            <button className="mini" disabled={sending} onClick={() => setOwn(true)}>{t('life.questions.disagree')}</button>
          </div>
        )
      ) : options.length > 0 && !own ? (
        <OptionRow q={q} options={options} disabled={sending} onPick={pick} onOwn={() => setOwn(true)} />
      ) : (
        <AnswerInput value={answer} onChange={setAnswer} onSend={() => send(answer)} disabled={sending}
          placeholder={t('life.questions.answerPlaceholder')} label={t('life.questions.answer')} />
      )}
      <div className="oq-foot">
        {q.assumption && <AssumedLine text={q.assumption} />}
        <button className="mini ghost oq-more" aria-expanded={more} onClick={() => setMore(!more)}>
          {t(more ? 'life.questions.less' : 'life.questions.more')} {more ? '▴' : '▾'}
        </button>
      </div>
      {more && <Details q={q} all={all} headline={headline} />}
    </article>
  );
}

/** Группа однотипных вопросов: одна карточка с общим ответом (§4). */
export function GroupCardView({ card, all }: { card: QuestionCard; all: OwnerQuestion[] }) {
  const [expanded, setExpanded] = useState(false);
  const [own, setOwn] = useState(false);
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const open = card.questions;
  const first = open[0]!;
  const confirm = card.section === 'confirm';
  // Отвеченные по ходу остаются зачёркнутыми, пока группа раскрыта.
  const seen = useRef<string[]>([]);
  for (const q of open) if (!seen.current.includes(q.id)) seen.current.push(q.id);
  const shown = useMemo(
    () => seen.current.map((id) => all.find((o) => o.id === id)).filter((o): o is OwnerQuestion => !!o),
    [all, open],
  );
  const options = confirm ? [] : commonOptions(open);
  const topic = groupTopic(open);
  const title = topic
    ? t('life.questions.similarTopic', { n: open.length, topic })
    : t('life.questions.similarBare', { n: open.length });
  const sendAll = (text: string) => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    for (const q of open) answerQuestion(q.id, value);
    pushToast({ id: `oq-group-${Date.now()}`, kind: 'done', title: t('life.questions.groupAnswered', { n: open.length }) });
    setAnswer('');
  };
  const agreeAll = () => {
    if (sending) return;
    setSending(true);
    for (const q of open) answerQuestion(q.id, confirmAnswer(q.proposal ?? ''));
    pushToast({ id: `oq-group-${Date.now()}`, kind: 'done', title: t('life.questions.groupAnswered', { n: open.length }) });
  };
  const pick = (opt: string) => {
    if (!opt.endsWith('…')) return sendAll(opt);
    setOwn(true);
    setAnswer(`${opt.slice(0, -1).trim()}: `);
  };
  // Нет общих вариантов — блока нет, остаётся только раскрытие.
  const common = confirm || options.length === 0 ? null : own ? (
    <AnswerInput value={answer} onChange={setAnswer} onSend={() => sendAll(answer)} disabled={sending}
      placeholder={t('life.questions.answerPlaceholder')} label={t('life.questions.answer')} />
  ) : (
    <OptionRow q={first} options={options} disabled={sending} onPick={pick} onOwn={() => setOwn(true)} />
  );
  const assumed = commonAssumption(open);
  return (
    <article className={`oq group${confirm ? ' confirm' : ''}${expanded ? ' expanded' : ''}`} id={`oq-card-${card.id}`}>
      <Meta q={first} count={open.length} />
      <h4 className="oq-title">{title}</h4>
      {(common || confirm) && (
        <div className="oq-common">
          {expanded && <div className="oq-lbl">{t('life.questions.commonAnswer', { n: open.length })}</div>}
          {confirm ? (
            <div className="oq-opts">
              <button className="mini primary" disabled={sending} onClick={agreeAll}>
                {t('life.questions.agreeGroup', { n: open.length })}
              </button>
            </div>
          ) : common}
        </div>
      )}
      {!expanded && (
        <div className="oq-foot">
          {assumed && <AssumedLine text={assumed} />}
          <button className="mini ghost oq-own oq-more" aria-expanded={false} onClick={() => setExpanded(true)}>
            {t('life.questions.expandAll')}
          </button>
        </div>
      )}
      {expanded && (
        <>
          <div className="oq-subs">
            {shown.map((q) => (isOpenQuestion(q) ? (
              <QuestionCardView key={q.id} q={q} all={all} sub />
            ) : (
              <div key={q.id} className="oq sub done">
                <h4 className="oq-title">{cardTitle(q)}</h4>
                <div className="oq-ok">{t('life.questions.answeredDone', { answer: q.answer ?? '' })}</div>
              </div>
            )))}
          </div>
          <button className="mini ghost oq-own" aria-expanded onClick={() => setExpanded(false)}>
            {t('life.questions.collapse')}
          </button>
        </>
      )}
    </article>
  );
}

/** Карточка очереди или списка: одиночный вопрос или группа. */
export function CardView({ card, all }: { card: QuestionCard; all: OwnerQuestion[] }) {
  return card.grouped
    ? <GroupCardView card={card} all={all} />
    : <QuestionCardView q={card.questions[0]!} all={all} />;
}

/** «Согласен со всеми» в шапке группы подтверждений; сначала спрашивает. */
export function AgreeAll({ cards }: { cards: QuestionCard[] }) {
  const [ask, setAsk] = useState(false);
  const open = cards.flatMap((c) => c.questions).filter(isOpenQuestion);
  useEffect(() => { if (!open.length) setAsk(false); }, [open.length]);
  if (!open.length) return null;
  const go = () => {
    for (const q of open) answerQuestion(q.id, confirmAnswer(q.proposal ?? ''));
    pushToast({ id: `oq-all-${Date.now()}`, kind: 'done', title: t('life.questions.groupAnswered', { n: open.length }) });
    setAsk(false);
  };
  return ask ? (
    <span className="oq-agreeall">
      <span className="small">{t('life.questions.agreeAllAsk', { n: open.length })}</span>
      <button className="mini primary" onClick={go}>{t('life.questions.agree')}</button>
      <button className="mini" onClick={() => setAsk(false)}>{t('common.cancel')}</button>
    </span>
  ) : (
    <button className="mini ghost" onClick={() => setAsk(true)}>{t('life.questions.agreeAll')}</button>
  );
}

/**
 * Вопросы владельцу (docs/design/living-office/spec.md §6).
 *
 * Прямое продолжение правила «прими решение сам и опиши допущение в отчёте»:
 * агент по-прежнему решает сам и идёт дальше, но допущение больше не
 * хоронится в отчёте — оно ложится в очередь, показывается порцией в
 * планёрке, а ответ владельца становится записью журнала.
 *
 * Не блокирует никогда. Ждущий владельца исполнитель — это оплачиваемая
 * сессия, которая простаивает, и ветка, которая стоит. Единственное, что
 * по-прежнему блокирует, — запрос доступа: там цена ошибки не в переделке.
 */
import type { OwnerQuestion, QuestionKind } from '../shared/types';
import { OFFICE_SENDER } from '../shared/types';
import { findDuplicate } from '../shared/questions';
import { isOpenQuestion, type OfficeState } from './state';
import { tellPm } from './review';
import { onOutcome } from './outcomes';

/** Сколько вопросов можно задать по одной задаче — как у `ask_colleague`. */
export const MAX_QUESTIONS_PER_TASK = 2;

/** Сколько вариантов ответа показываем и какой длины. Кнопка в строку не влезет. */
const MAX_OPTIONS = 4;
const MAX_OPTION_LEN = 40;
/** Разобранных из текста вариантов берём меньше: эвристика ошибается чаще агента. */
const MAX_GUESSED = 3;

/**
 * Варианты ответа для вопроса: что дал агент, а если не дал — что удалось
 * разобрать в самом вопросе. Пустой список значит «вариантов нет», и это
 * нормально: тогда владелец пишет ответ руками, как раньше.
 */
export function questionOptions(options: string[] | undefined, text: string): string[] {
  const given = tidyOptions(options ?? [], MAX_OPTIONS);
  return given.length > 1 ? given : guessOptions(text);
}

/** Чистка списка: обрезка, без пустых, без повторов, без длинных, не больше `max`. */
function tidyOptions(list: string[], max: number): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const option = raw.replace(/\s+/g, ' ').trim();
    if (!option || option.length > MAX_OPTION_LEN) continue;
    if (out.some((o) => o.toLowerCase() === option.toLowerCase())) continue;
    out.push(option);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Запасной разбор: «делаем А или Б?» в последнем предложении вопроса.
 * Нарочно тупой — лучше не предложить ничего, чем предложить бессмыслицу:
 * длинные куски и одиночный вариант отбрасываются целиком.
 */
function guessOptions(text: string): string[] {
  const last = (text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*$/)?.[0] ?? '').trim();
  // Отрезаем зачин до двоеточия или тире («Пагинация: по 20 или по 50?»);
  // дефис для этого не годится — он живёт внутри слов.
  const tail = last.replace(/^[^:—–]*[:—–]\s*/, '').replace(/[?!.]+$/, '').trim();
  const parts = tail.split(/\s+или\s+/i).map((p) => p.replace(/^[«"'(]+|[»"')]+$/g, '').trim());
  if (parts.length < 2 || parts.length > MAX_GUESSED) return [];
  const tidy = tidyOptions(parts, MAX_GUESSED);
  // Разбор засчитывается только целиком: выкинули хоть кусок — значит не поняли.
  return tidy.length === parts.length ? tidy : [];
}

/** Порядок важности в планёрке: противоречие и протухшее решение выше допущений. */
const PRIORITY: Record<QuestionKind, number> = {
  gate: 0, contradiction: 1, stale: 2, revert: 3, assumption: 4,
};

/** Открытые вопросы: без ответа и не снятые. Признак — `isOpenQuestion`, им же
 *  считается счётчик `openQuestions`, который уходит в веб. */
export const openQuestions = (state: OfficeState): OwnerQuestion[] =>
  state.questionList().filter(isOpenQuestion);

/**
 * Задать вопрос от агента по задаче. Возвращает текст для инструмента:
 * «записано, продолжай по допущению» либо причину отказа. Лимит — на
 * задачу: иначе исполнитель начал бы спрашивать вместо того, чтобы читать код.
 */
export function askOwner(
  state: OfficeState, from: string, taskId: string | null, text: string, assumption: string,
  options?: string[], replaces: string[] = [],
  /** Чат менеджера, из которого спросили. Нет — чат задачи, если он у неё есть. */
  chatId?: string | null,
): { ok: boolean; text: string; question: OwnerQuestion | null } {
  if (!text.trim()) return { ok: false, text: state.say('questions.empty'), question: null };
  // Такой вопрос уже ждёт владельца — второй раз его не заводим и лимит не
  // тратим. Заменить старый можно только явно: `replaces`.
  const same = findDuplicate({ taskId, text }, openQuestions(state));
  if (same && !replaces.includes(same.id)) {
    return { ok: true, text: state.say('questions.duplicate', { id: same.id, text: clip(same.text, 200) }), question: same };
  }
  if (taskId) {
    const used = state.questionsByTask.get(taskId) ?? 0;
    if (used >= MAX_QUESTIONS_PER_TASK) {
      return { ok: false, text: state.say('questions.limit', { max: MAX_QUESTIONS_PER_TASK }), question: null };
    }
    state.questionsByTask.set(taskId, used + 1);
  }
  const question = state.addQuestion({
    from, taskId, kind: 'assumption', text, assumption: assumption || state.say('questions.noAssumption'),
    options: questionOptions(options, text), chatId: questionChat(state, taskId, chatId),
  });
  state.addLog(from === OFFICE_SENDER ? null : from, 'system',
    state.say('questions.askedLog', { id: question.id, text: clip(text, 120) }));
  state.addChatRef({ kind: 'question', id: question.id }, question.chatId);
  const merged = replaces.filter((id) => mergeQuestion(state, id, question.id).ok);
  const note = merged.length ? ` ${state.say('questions.replacedOk', { ids: merged.join(', ') })}` : '';
  return { ok: true, text: state.say('questions.askedOk', { id: question.id }) + note, question };
}

/** Вопрос от самого офиса: ритуал заметил противоречие, протухшее решение, откат. */
export function officeAsks(
  state: OfficeState, kind: QuestionKind, text: string, assumption: string, taskId: string | null = null,
  options?: string[],
): OwnerQuestion {
  // Ритуал не помнит, о чём офис уже спросил: повтор тихо сводим к открытому.
  const same = findDuplicate({ taskId, text }, openQuestions(state));
  if (same) return same;
  const question = state.addQuestion({
    from: OFFICE_SENDER, taskId, kind, text, assumption, options: questionOptions(options, text),
    chatId: questionChat(state, taskId),
  });
  state.addLog(null, 'system', state.say('questions.askedLog', { id: question.id, text: clip(text, 120) }));
  state.addChatRef({ kind: 'question', id: question.id }, question.chatId);
  return question;
}

/**
 * Чат, в котором живёт вопрос (спека T-125 §4): названный явно (менеджер
 * спросил из своего чата), иначе чат задачи или её фичи, а без привязки —
 * основной. Вопрос без чата владелец увидел бы только в «Жизни офиса», а
 * индикатор «ждёт вас» в списке чатов его бы не заметил.
 */
function questionChat(state: OfficeState, taskId: string | null, chatId?: string | null): string {
  return state.pmChatFor({ chatId, taskId }) ?? state.ensureMainChat().id;
}

/**
 * Ответ владельца. Ложится в журнал самой надёжной записью из всех и уходит
 * менеджеру: если это правило для роли, предложить его — его дело.
 * Возвращает false, если такого вопроса нет или он уже закрыт.
 */
export function answerQuestion(state: OfficeState, askedId: string, answer: string): boolean {
  // Ответ на влитый вопрос — ответ на тот, куда его влили: «Q-10: да» в чате
  // после объединения должно работать так же, как до него.
  const question = rootQuestion(state, askedId);
  if (!question || question.answeredAt) return false;
  const id = question.id;
  const text = answer.trim();
  if (!text) return false;
  const now = Date.now();
  state.updateQuestion(id, { answer: text, answeredAt: now, dismissedAt: null });
  const along = absorbed(state, id);
  for (const q of along) state.updateQuestion(q.id, { answer: text, answeredAt: now });

  const roleId = question.from !== OFFICE_SENDER ? state.instances.get(question.from)?.roleId ?? null : null;
  const fact = state.addFact({
    kind: question.kind === 'stale' ? 'decision' : 'fact',
    text: state.say('questions.factText', { question: question.text, answer: text }),
    // Ответ по допущению исполнителя — факт его роли; остальное — про проект.
    scope: question.kind === 'assumption' && roleId ? `role:${roleId}` : 'project',
    source: { questionId: id, ...(question.taskId ? { taskId: question.taskId } : {}) },
  });
  // Откуда бы ни пришёл ответ — кнопкой в карточке, строкой «Q-3: да» в
  // любом чате или из «Жизни офиса», — подтверждение и весть менеджеру идут
  // в чат вопроса: там его задали и там его ждёт сессия менеджера.
  state.addChat(OFFICE_SENDER, state.say('questions.answeredChat', { id, fact: fact.id }),
    'pm#1', undefined, question.chatId);
  tellPm(state, state.say('questions.pmAnswered', {
    id, question: question.text, assumption: question.assumption, answer: text,
    task: [question.taskId, ...along.map((q) => q.taskId)].filter(Boolean).join(', ') || '—',
  }) + (along.length ? `\n${state.say('questions.pmAlong', { ids: along.map((q) => q.id).join(', ') })}` : ''),
  { chatId: question.chatId, taskId: question.taskId });
  return true;
}

/** Снять вопрос без ответа: офис остаётся при своём допущении. */
export function dismissQuestion(state: OfficeState, id: string, why?: string): boolean {
  const question = rootQuestion(state, id);
  if (!question || question.answeredAt || question.dismissedAt) return false;
  const now = Date.now();
  const patch = { dismissedAt: now, ...(why ? { closedWhy: why } : {}) };
  state.updateQuestion(question.id, patch);
  for (const q of absorbed(state, question.id)) state.updateQuestion(q.id, patch);
  return true;
}

/** Вопрос, который отвечает за `id`: сам он или тот, в который его влили. */
export function rootQuestion(state: OfficeState, id: string): OwnerQuestion | null {
  let q = state.questions.get(id) ?? null;
  for (let hops = 0; q?.mergedInto && hops < 20; hops += 1) q = state.questions.get(q.mergedInto) ?? q;
  return q;
}

/** Вопросы, влитые в `id` (и во влитые в него), ещё не закрытые сами. */
function absorbed(state: OfficeState, id: string): OwnerQuestion[] {
  return state.questionList().filter((q) => q.id !== id && q.mergedInto && !q.answeredAt && !q.dismissedAt
    && rootQuestion(state, q.id)?.id === id);
}

type Outcome = { ok: boolean; text: string };

/**
 * Влить вопрос `id` в `into`: повтор или старая формулировка того же. Влитый
 * перестаёт быть открытым, а ответ на главный достаётся и ему — процесс,
 * который ждал согласования по влитому, получит то же «да» или «нет».
 */
export function mergeQuestion(state: OfficeState, id: string, intoId: string, by?: string): Outcome {
  const q = state.questions.get(id);
  const into = rootQuestion(state, intoId);
  if (!q || !isOpenQuestion(q)) return { ok: false, text: state.say('questions.noSuch', { id }) };
  if (!into || !isOpenQuestion(into)) return { ok: false, text: state.say('questions.noSuch', { id: intoId }) };
  if (into.id === q.id) return { ok: false, text: state.say('questions.mergeSelf', { id }) };
  // Согласованию нужны его кнопки: влитое в вопрос без вариантов даёт их главному.
  if (!into.options?.length && q.options?.length) state.updateQuestion(into.id, { options: q.options });
  for (const child of absorbed(state, q.id)) state.updateQuestion(child.id, { mergedInto: into.id });
  state.updateQuestion(q.id, { mergedInto: into.id });
  state.addLog(by && by !== OFFICE_SENDER ? by : null, 'system',
    state.say('questions.mergedLog', { id: q.id, into: into.id }));
  return { ok: true, text: state.say('questions.mergedOk', { id: q.id, into: into.id }) };
}

/** Поправить формулировку открытого вопроса. Варианты согласования не трогаем. */
export function editQuestion(
  state: OfficeState, id: string, patch: { text?: string; assumption?: string; options?: string[] }, by?: string,
): Outcome {
  const q = state.questions.get(id);
  if (!q || !isOpenQuestion(q)) return { ok: false, text: state.say('questions.noSuch', { id }) };
  const text = (patch.text ?? q.text).trim();
  if (!text) return { ok: false, text: state.say('questions.empty') };
  const assumption = (patch.assumption ?? q.assumption).trim() || q.assumption;
  const next: Partial<OwnerQuestion> = { text, assumption, editedAt: Date.now() };
  // Новый текст может сам называть варианты («синяя или зелёная?») — тогда
  // берём их; не называет — прежние кнопки остаются: правка опечатки их не отменяет.
  if (q.kind !== 'gate' && (patch.options || text !== q.text)) {
    const options = questionOptions(patch.options, text);
    next.options = options.length > 1 ? options : patch.options ? undefined : q.options;
  }
  state.updateQuestion(id, next);
  state.addLog(by && by !== OFFICE_SENDER ? by : null, 'system', state.say('questions.editedLog', { id }));
  return { ok: true, text: state.say('questions.editedOk', { id }) };
}

/**
 * Удалить вопрос совсем — он был не нужен. Открытое согласование удалить
 * нельзя: процесс ждёт «да» или «нет», и его пропажа ничего бы не решила —
 * для этого есть «Оставить как есть» (отказ) и объединение. Влитые в
 * удалённый снова становятся открытыми: они-то ещё ничего не получили.
 */
export function deleteQuestion(state: OfficeState, id: string, why?: string, by?: string): Outcome {
  const q = state.questions.get(id);
  if (!q) return { ok: false, text: state.say('questions.noSuch', { id }) };
  // Влитое согласование тоже ждёт: его ответ придёт через главный вопрос.
  if (q.kind === 'gate' && !q.answeredAt && !q.dismissedAt) {
    return { ok: false, text: state.say('questions.gateNoDelete', { id }) };
  }
  for (const child of absorbed(state, id)) state.updateQuestion(child.id, { mergedInto: undefined });
  state.removeQuestion(id);
  state.addLog(by && by !== OFFICE_SENDER ? by : null, 'system',
    state.say('questions.deletedLog', { id, why: why?.trim() ? ` — ${clip(why, 160)}` : '' }));
  return { ok: true, text: state.say('questions.deletedOk', { id }) };
}

/**
 * Задача снята или провалилась — её вопросы больше некому применять.
 * Согласование закрытой задачи особенно шумное: задачу переделывают
 * повтором, и у владельца висят два одинаковых «согласуйте макет».
 */
export function closeQuestionsOfTask(state: OfficeState, taskId: string, why: string): number {
  let n = 0;
  for (const q of openQuestions(state)) {
    if (q.taskId !== taskId || q.kind === 'revert') continue;
    // Влитое сюда по другим задачам живо: оно снова открыто само по себе,
    // иначе снятие чужой задачи сошло бы за отказ по ней.
    for (const child of absorbed(state, q.id)) {
      if (child.taskId !== taskId) state.updateQuestion(child.id, { mergedInto: undefined });
    }
    if (dismissQuestion(state, q.id, why)) n += 1;
  }
  return n;
}

onOutcome((state, task, outcome) => {
  if (outcome.kind !== 'cancelled' && outcome.kind !== 'failed') return;
  closeQuestionsOfTask(state, task.id, state.say(`questions.closedTask.${outcome.kind}`, { task: task.id }));
});

/** Открытые вопросы строками — менеджеру и ритуалам, чтобы не спрашивали дважды. */
export function openQuestionsText(state: OfficeState): string {
  const list = openQuestions(state);
  if (!list.length) return state.say('questions.noneOpen');
  return list.map((q) => {
    const along = absorbed(state, q.id).map((a) => a.id);
    return state.say('questions.openRow', {
      id: q.id, kind: q.kind, task: q.taskId ? ` ${q.taskId}` : '',
      from: q.from, text: clip(q.text, 240), assumption: clip(q.assumption, 160),
      along: along.length ? ` ${state.say('questions.openAlong', { ids: along.join(', ') })}` : '',
    });
  }).join('\n');
}

/**
 * Порция вопросов для планёрки: самые важные из ещё не показанных. Вопрос
 * по задаче, которая уже закрылась чисто с этим допущением, идёт последним —
 * спрашивать всерьёз то, что уже сработало, незачем.
 */
export function pickForStandup(state: OfficeState, n: number, now = Date.now()): OwnerQuestion[] {
  const settled = (q: OwnerQuestion): number =>
    (q.taskId && state.tasks.get(q.taskId)?.outcome?.kind === 'clean' ? 1 : 0);
  const picked = openQuestions(state)
    .filter((q) => q.shownAt === null)
    .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || settled(a) - settled(b) || a.askedAt - b.askedAt)
    .slice(0, Math.max(0, n));
  for (const q of picked) state.updateQuestion(q.id, { shownAt: now });
  return picked;
}

/**
 * Ответ прямо в чате: «Q-3: да, оставляем». Возвращает id вопроса, если
 * строка про него, — тогда менеджеру она как сообщение не идёт.
 */
export function answerFromChat(state: OfficeState, text: string): string | null {
  const m = /^\s*(Q-\d+)\s*[:\-—–]\s*(.+)$/s.exec(text);
  if (!m) return null;
  return answerQuestion(state, m[1], m[2]) ? m[1] : null;
}

const clip = (s: string, n: number): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

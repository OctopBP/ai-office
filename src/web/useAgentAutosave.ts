import { useEffect, useReducer, useRef } from 'react';
import {
  archiveRole, clearRoleFeedback, detachRole, parseTaskMaxTurns, removeRole, setAgentName,
  setAgentPermission, socketOpen, updateRole, useStore,
} from './store';
import { t } from './i18n';
import { providerOf } from '../shared/providers';
import {
  MAX_AGENT_NAME, ROLE_TITLE_LIMIT,
  type FieldError, type InstanceView, type PermissionMode, type RoleEditable, type RoleOp, type RoleView,
} from '../shared/types';

/**
 * Автосохранение страницы агента (спека docs/design/T-151/spec.md, §4).
 *
 * Поля страницы — это поля роли плюс два поля сотрудника (имя и личный режим
 * доступа). У каждого своя локальная копия (`drafts`): пока она есть, поле
 * показывает её, а не серверное значение, — так пришедшее с сервера не
 * затирает набираемое. Копия исчезает, когда сервер подтвердил запись.
 *
 * На роль в полёте не больше одной `update_role`: пока ответа нет, правки
 * копятся в `queued` и уходят следом одним патчем. Ответы сервер шлёт по
 * порядку, поэтому номер запроса не нужен.
 */

export type AgentField =
  | 'name' | 'personalMode'
  | 'title' | 'sprite' | 'provider' | 'model' | 'permissionMode' | 'isolate'
  | 'maxTurns' | 'repoDir' | 'mcp' | 'capabilities' | 'brief' | 'briefExtra';

type RoleField = Exclude<AgentField, 'name' | 'personalMode'>;
type InstField = 'name' | 'personalMode';

/** Выбор из списка: ошибка откатывает значение к серверному, а не оставляет его в поле. */
const INSTANT: ReadonlySet<AgentField> = new Set<AgentField>([
  'personalMode', 'sprite', 'provider', 'model', 'permissionMode', 'isolate', 'mcp', 'capabilities',
]);

/** Длинные тексты сохраняются сами через эту паузу в наборе. */
const TYPING_DELAY_MS = 800;
/** «Сохраняется…» держится не меньше этого, иначе быстрый ответ мигает. */
const MIN_SAVING_MS = 400;
const JUST_SAVED_MS = 2000;
const FIELD_FLASH_MS = 1500;

export type SaveStatus = 'saved' | 'justSaved' | 'dirty' | 'saving' | 'error' | 'offline';

export interface FieldState {
  error: string | null;
  saving: boolean;
  justSaved: boolean;
}

interface FieldFailure {
  message: string;
  /** Что пытались записать — «Повторить» отправит это же. */
  value: unknown;
}

interface Machine {
  drafts: Partial<Record<AgentField, unknown>>;
  queued: Set<RoleField>;
  inflight: { fields: RoleField[]; sent: Partial<Record<RoleField, unknown>> } | null;
  instInflight: Partial<Record<InstField, unknown>>;
  instQueued: Set<InstField>;
  errors: Partial<Record<AgentField, FieldFailure>>;
  offline: boolean;
  savedAt: Partial<Record<AgentField, number>>;
  lastSavedAt: number;
  savingSince: number;
  timers: Map<AgentField, ReturnType<typeof setTimeout>>;
  action: RoleOp | null;
  actionFailed: { op: RoleOp; errors: FieldError[] } | null;
  actionDone: RoleOp | null;
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/** Серверное значение поля в том виде, в каком его держит форма. */
function serverValue(f: AgentField, role: RoleView, inst: InstanceView): unknown {
  switch (f) {
    case 'name': return inst.name ?? '';
    case 'personalMode': return inst.permissionMode;
    case 'maxTurns': return role.maxTurns?.toString() ?? '';
    case 'capabilities': return role.capabilities ?? [];
    case 'provider': return providerOf(role);
    default: return role[f];
  }
}

/** Проверка до отправки: то, что сервер заведомо отвергнет, на сервер не уходит. */
function localError(f: AgentField, v: unknown): string | null {
  if (f === 'title') {
    const s = String(v).trim();
    if (!s) return t('agent.err.titleEmpty');
    if (s.length > ROLE_TITLE_LIMIT) return t('agent.err.titleLong', { max: ROLE_TITLE_LIMIT });
  }
  if (f === 'name' && String(v).trim().length > MAX_AGENT_NAME) {
    return t('agent.err.nameLong', { max: MAX_AGENT_NAME });
  }
  if (f === 'maxTurns') return parseTaskMaxTurns(String(v)).error;
  return null;
}

/** Значение формы → значение патча роли. */
function toPatch(f: RoleField, v: unknown): unknown {
  if (f === 'maxTurns') return parseTaskMaxTurns(String(v)).value;
  if (f === 'title') return String(v).trim();
  return v;
}

export interface AgentAutosave {
  value: <T = unknown>(f: AgentField) => T;
  /** Правка без отправки: набор в коротком поле, числе, пути. */
  edit: (f: AgentField, v: unknown) => void;
  /** Набор в длинном тексте: отправка через паузу. */
  type: (f: AgentField, v: unknown) => void;
  /** Потеря фокуса или Enter. */
  commit: (f: AgentField) => void;
  /** Мгновенное поле: выбрали — ушло. Несколько полей — одним патчем (провайдер с моделью). */
  set: (values: Partial<Record<AgentField, unknown>>) => void;
  /** Esc: вернуть серверное значение и забыть ошибку. */
  cancel: (f: AgentField) => void;
  retry: () => void;
  /** Дослать всё, что ждёт таймера или выхода из поля. */
  flush: () => void;
  /** Что так и не сохранилось (после flush): для вопроса при закрытии. */
  unsaved: () => AgentField[];
  status: SaveStatus;
  field: (f: AgentField) => FieldState;
  /** Длинный текст на момент открытия страницы — для «Вернуть как было». */
  opened: (f: AgentField) => unknown;
  /** Действия с ролью (архив, удаление, отвязка): ответ приходит тем же каналом. */
  act: (op: 'archive' | 'restore' | 'remove' | 'detach') => void;
  actionPending: RoleOp | null;
  actionFailed: { op: RoleOp; errors: FieldError[] } | null;
  actionDone: RoleOp | null;
}

export function useAgentAutosave(role: RoleView, inst: InstanceView, onRemoved: () => void): AgentAutosave {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const m = useRef<Machine>({
    drafts: {}, queued: new Set(), inflight: null, instInflight: {}, instQueued: new Set(),
    errors: {}, offline: false, savedAt: {}, lastSavedAt: 0, savingSince: 0, timers: new Map(),
    action: null, actionFailed: null, actionDone: null,
  }).current;
  const live = useRef({ role, inst, onRemoved });
  live.current = { role, inst, onRemoved };
  const openedAt = useRef({ brief: role.brief, briefExtra: role.briefExtra }).current;

  const later = (ms: number) => { setTimeout(bump, ms + 20); };
  const current = (f: AgentField): unknown => (
    f in m.drafts ? m.drafts[f] : serverValue(f, live.current.role, live.current.inst)
  );

  const markSaving = () => { m.savingSince = Date.now(); later(MIN_SAVING_MS); };
  const markSaved = (f: AgentField) => {
    const now = Date.now();
    m.savedAt[f] = now;
    m.lastSavedAt = now;
    later(FIELD_FLASH_MS);
    later(JUST_SAVED_MS);
  };
  const goOffline = () => { m.offline = true; };

  /** Отправить накопленное по роли, если ничего не в полёте. */
  const pump = () => {
    if (m.inflight || m.queued.size === 0) return;
    if (!socketOpen()) { goOffline(); return; }
    const fields = [...m.queued];
    // Смена провайдера без модели сервер всё равно сбросил бы на умолчание,
    // поэтому модель уходит вместе с провайдером тем же патчем.
    if (fields.includes('provider') && !fields.includes('model') && 'model' in m.drafts) fields.push('model');
    m.queued.clear();
    const sent: Partial<Record<RoleField, unknown>> = {};
    const patch: Record<string, unknown> = {};
    for (const f of fields) {
      sent[f] = current(f);
      patch[f] = toPatch(f, sent[f]);
    }
    m.inflight = { fields, sent };
    markSaving();
    updateRole(live.current.role.id, patch as Partial<RoleEditable>);
  };

  const sendInst = (f: InstField) => {
    if (f in m.instInflight) { m.instQueued.add(f); return; }
    if (!socketOpen()) { goOffline(); m.instQueued.add(f); return; }
    const v = current(f);
    m.instInflight[f] = v;
    markSaving();
    if (f === 'name') setAgentName(live.current.inst.id, String(v));
    else setAgentPermission(live.current.inst.id, v as PermissionMode | null);
  };

  const commit = (f: AgentField) => {
    const timer = m.timers.get(f);
    if (timer) { clearTimeout(timer); m.timers.delete(f); }
    if (!(f in m.drafts)) return;
    const v = m.drafts[f];
    const problem = localError(f, v);
    if (problem) { m.errors[f] = { message: problem, value: v }; bump(); return; }
    delete m.errors[f];
    const inFlight = f === 'name' || f === 'personalMode'
      ? f in m.instInflight
      : Boolean(m.inflight?.fields.includes(f as RoleField));
    // То же значение уже летит (модель ушла вместе с провайдером) — второй раз не шлём.
    const flying = f === 'name' || f === 'personalMode' ? m.instInflight[f] : m.inflight?.sent[f as RoleField];
    if (inFlight && same(v, flying)) { bump(); return; }
    // Вернули то, что уже на сервере, и ничего не летит — отправлять нечего.
    if (!inFlight && same(v, serverValue(f, live.current.role, live.current.inst))) {
      delete m.drafts[f];
      bump();
      return;
    }
    if (f === 'name' || f === 'personalMode') sendInst(f);
    else { m.queued.add(f); pump(); }
    bump();
  };

  const edit = (f: AgentField, v: unknown) => { m.drafts[f] = v; bump(); };

  const type = (f: AgentField, v: unknown) => {
    m.drafts[f] = v;
    const old = m.timers.get(f);
    if (old) clearTimeout(old);
    // Пустоту по таймеру не сохраняем: «выделить всё и заменить» прошло бы
    // через пустой текст и стёрло инструкцию. Пустое уходит только по выходу из поля.
    if (String(v).trim()) m.timers.set(f, setTimeout(() => { m.timers.delete(f); commit(f); }, TYPING_DELAY_MS));
    bump();
  };

  const set = (values: Partial<Record<AgentField, unknown>>) => {
    const fields = Object.keys(values) as AgentField[];
    for (const f of fields) m.drafts[f] = values[f];
    for (const f of fields) commit(f);
  };

  const cancel = (f: AgentField) => {
    const timer = m.timers.get(f);
    if (timer) { clearTimeout(timer); m.timers.delete(f); }
    const pending = m.queued.has(f as RoleField) || m.inflight?.fields.includes(f as RoleField) || f in m.instInflight;
    if (!pending) delete m.drafts[f];
    delete m.errors[f];
    bump();
  };

  const flush = () => {
    for (const f of [...m.timers.keys()]) commit(f);
    for (const f of Object.keys(m.drafts) as AgentField[]) {
      if (!m.errors[f] && !m.queued.has(f as RoleField) && !m.inflight?.fields.includes(f as RoleField) && !(f in m.instInflight)) commit(f);
    }
  };

  const retry = () => {
    m.offline = false;
    const failed = Object.entries(m.errors) as Array<[AgentField, FieldFailure]>;
    m.errors = {};
    for (const [f, e] of failed) m.drafts[f] = e.value;
    for (const [f] of failed) commit(f);
    // Правки, застрявшие без связи, уходят тем же нажатием.
    for (const f of [...m.instQueued]) { m.instQueued.delete(f); sendInst(f); }
    pump();
    bump();
  };

  const fail = (f: AgentField, sent: unknown, reason: string) => {
    if (INSTANT.has(f)) {
      if (same(m.drafts[f], sent)) delete m.drafts[f];
      m.errors[f] = { message: t('agent.save.notApplied', { reason }), value: sent };
    } else {
      m.errors[f] = { message: reason, value: sent };
    }
  };

  const onReply = (op: RoleOp, errors: FieldError[]) => {
    if (op === 'update') {
      const flight = m.inflight;
      if (!flight) return;
      m.inflight = null;
      if (!errors.length) {
        for (const f of flight.fields) {
          if (same(m.drafts[f], flight.sent[f])) delete m.drafts[f];
          markSaved(f);
        }
      } else {
        // Сервер отвергает патч целиком: поле без своей ошибки получает общую.
        const general = errors.find((e) => e.field === '')?.message ?? errors[0].message;
        for (const f of flight.fields) {
          fail(f, flight.sent[f], errors.find((e) => e.field === f)?.message ?? general);
        }
      }
      pump();
    } else if (op === 'name' || op === 'permission') {
      const f: InstField = op === 'name' ? 'name' : 'personalMode';
      if (!(f in m.instInflight)) return;
      const sent = m.instInflight[f];
      delete m.instInflight[f];
      if (!errors.length) {
        if (same(m.drafts[f], sent)) delete m.drafts[f];
        markSaved(f);
      } else {
        fail(f, sent, errors[0].message);
      }
      if (m.instQueued.delete(f)) sendInst(f);
    } else if (op === m.action) {
      m.action = null;
      m.actionFailed = errors.length ? { op, errors } : null;
      m.actionDone = errors.length ? null : op;
      if (op === 'remove' && !errors.length) live.current.onRemoved();
    }
    bump();
  };

  // Слот `roleFeedback` в сторе одиночный: читаем его подпиской, а не
  // эффектом по рендеру, — два ответа подряд (имя и роль) пришли бы между
  // рендерами, и первый затёрся бы вторым.
  useEffect(() => useStore.subscribe((s, prev) => {
    const fb = s.roleFeedback;
    if (fb && fb !== prev.roleFeedback && fb.roleId === live.current.role.id) {
      clearRoleFeedback();
      onReply(fb.op, fb.errors);
    }
    if (prev.connected && !s.connected) {
      // Ответа на то, что было в полёте, уже не будет.
      const reason = t('agent.save.offline');
      if (m.inflight) {
        for (const f of m.inflight.fields) fail(f, m.inflight.sent[f], reason);
        m.inflight = null;
      }
      for (const f of Object.keys(m.instInflight) as InstField[]) {
        fail(f, m.instInflight[f], reason);
        delete m.instInflight[f];
      }
      goOffline();
      bump();
    }
  }), []);

  // Ушли к другому сотруднику или закрыли окно — дослать недосохранённое.
  useEffect(() => () => {
    for (const timer of m.timers.values()) clearTimeout(timer);
    flushRef.current();
  }, []);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const pendingInst = (f: AgentField) => f in m.instInflight || m.instQueued.has(f as InstField);
  const isSaving = (f: AgentField) => m.queued.has(f as RoleField) || Boolean(m.inflight?.fields.includes(f as RoleField)) || pendingInst(f);

  const unsaved = (): AgentField[] => (Object.keys(m.drafts) as AgentField[])
    .filter((f) => m.errors[f] || (m.offline && isSaving(f)))
    .concat((Object.keys(m.errors) as AgentField[]).filter((f) => !(f in m.drafts)));

  const now = Date.now();
  const hasErrors = Object.keys(m.errors).length > 0;
  const dirty = (Object.keys(m.drafts) as AgentField[]).some((f) => !m.errors[f] && !isSaving(f)
    && !same(m.drafts[f], serverValue(f, role, inst)));
  const saving = Boolean(m.inflight) || Object.keys(m.instInflight).length > 0 || now - m.savingSince < MIN_SAVING_MS;
  const status: SaveStatus = m.offline && (hasErrors || m.queued.size > 0 || m.instQueued.size > 0) ? 'offline'
    : hasErrors ? 'error'
    : saving ? 'saving'
    : dirty ? 'dirty'
    : now - m.lastSavedAt < JUST_SAVED_MS ? 'justSaved'
    : 'saved';

  return {
    value: <T,>(f: AgentField) => current(f) as T,
    edit, type, commit, set, cancel, retry, flush, unsaved, status,
    field: (f) => ({
      error: m.errors[f]?.message ?? null,
      saving: isSaving(f),
      justSaved: now - (m.savedAt[f] ?? 0) < FIELD_FLASH_MS && !m.errors[f],
    }),
    opened: (f) => (f === 'brief' || f === 'briefExtra' ? openedAt[f] : undefined),
    act: (op) => {
      m.action = op;
      m.actionFailed = null;
      m.actionDone = null;
      const id = live.current.role.id;
      if (op === 'archive' || op === 'restore') archiveRole(id, op === 'archive');
      else if (op === 'remove') removeRole(id);
      else detachRole(id);
      bump();
    },
    actionPending: m.action,
    actionFailed: m.actionFailed,
    actionDone: m.actionDone,
  };
}

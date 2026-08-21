import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type {
  AgentState, ChatEntry, Criterion, DayUsage, Desk, InstanceView, LogEntry,
  PermissionDecision, AuthSource, MeetingView, PermissionRequest, RoleEditable,
  RoleView, ServerEvent, Settings, TaskStatus, TaskView, Usage,
  CloudStatus, OfficeView, MergeCheck, MergeRun,
} from '../shared/types';
import { emptyUsage } from '../shared/types';
import { activityFromFile, summarize } from './activity';
import { currentOffice, offices } from './offices';
import { effectiveMode } from './permissions';
import { allRoles, getRoleOverrides, roleById, setRoleOverrides, type Role } from './roles';
import {
  DEFAULT_STATE_FILE, flush as flushFile, load, save, wipe as wipeFile,
  type Persisted, type PersistedInstance,
} from './store';

/** Раскладка рабочих мест в комнате (координаты в клетках сетки). */
export const DESKS: Desk[] = [
  // Раскладка по макету: два ряда столов под стеной, два места в центре,
  // низ комнаты занят переговоркой (слева) и кухней (справа).
  { index: 0, x: 1, y: 4 },   // PM — отдельно, у входа
  { index: 1, x: 6, y: 4 },  { index: 2, x: 11, y: 4 }, { index: 3, x: 16, y: 4 },
  { index: 4, x: 1, y: 8 },  { index: 5, x: 6, y: 8 },  { index: 6, x: 11, y: 8 },
  { index: 7, x: 16, y: 8 }, { index: 8, x: 10, y: 12 }, { index: 9, x: 14, y: 12 },
];

type Listener = (e: ServerEvent) => void;

/** Сколько дней истории расходов держим — на «за день» и недельный график. */
const DAYS_KEPT = 14;

/** Настройки офиса по умолчанию — они же дополняют старые сохранения. */
export const DEFAULT_SETTINGS: Settings = {
  globalBudgetUsd: null,
  taskBudgetUsd: null,
  taskMaxTurns: 200,
  engine: 'local',
  cloudRepoUrl: null,
  officePermissionMode: 'ask-risky',
};

/** Ключ дня в местном времени: расход «за сегодня» считается по часам пользователя. */
export function dayKey(at = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Складывает расход в накопитель. Возвращает его же — удобно в цепочках. */
function accumulate(into: Usage, delta: Usage): Usage {
  into.costUsd += delta.costUsd;
  into.tokensIn += delta.tokensIn;
  into.tokensOut += delta.tokensOut;
  into.cacheRead += delta.cacheRead;
  into.cacheWrite += delta.cacheWrite;
  return into;
}

/** Расход за день из журнала: отсутствующий день — это нули, а не пропуск. */
function dayOf(journal: Record<string, Usage>, day: string): Usage {
  const found = journal[day];
  if (found) return found;
  const fresh = emptyUsage();
  journal[day] = fresh;
  return fresh;
}

/** Обрезает журнал до DAYS_KEPT последних дней: иначе он растёт бесконечно. */
function trimJournal(journal: Record<string, Usage>): void {
  const days = Object.keys(journal).sort();
  for (const day of days.slice(0, Math.max(0, days.length - DAYS_KEPT))) {
    delete journal[day];
  }
}

export interface Instance {
  id: string;
  roleId: string;
  /** id сессии Agent SDK — чтобы продолжить разговор после перезапуска. */
  sessionId: string | null;
  label: string;
  desk: Desk;
  state: AgentState;
  currentTaskId: string | null;
  note: string | null;
  usage: Usage;
  /** Расход по дням: «сколько агент стоил сегодня» без пересчёта всей истории. */
  daily: Record<string, Usage>;
  abort: AbortController | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  criteria: Criterion[];
  roleId: string | null;
  assigneeId: string | null;
  status: TaskStatus;
  result: string | null;
  files: string[];
  branch: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  /** Репозиторий, в котором выполнялась задача: у ролей они могут отличаться. */
  repoDir: string | null;
  merged: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  usage: Usage;
}

interface Pending {
  request: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

/** Сколько ждём ответа пользователя, прежде чем отказать. */
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

export class OfficeState {
  instances = new Map<string, Instance>();
  tasks = new Map<string, Task>();
  chat: ChatEntry[] = [];
  log: LogEntry[] = [];
  busy = false;
  projectDir = '';
  /** Доступна ли изоляция через worktree (рабочая директория — git-репозиторий). */
  gitReady = false;
  /** Режим проверки поведения PM: исполнители заглушены, задачи закрываются мгновенно. */
  dryRun = false;
  meeting: MeetingView | null = null;
  settings: Settings = { ...DEFAULT_SETTINGS };
  authSource: AuthSource = 'unknown';
  /** Чей это офис: от него зависят worktree и файл состояния. */
  readonly officeId: string;
  /**
   * Правки ролей этого офиса. Реестр ролей в roles.ts — общий на процесс,
   * поэтому офис держит свою копию и возвращает её, когда снова становится
   * текущим: иначе настройки одного проекта уезжали бы в другой.
   */
  roleOverrides: Record<string, Partial<Role>> = {};
  /**
   * Поднимали ли уже это состояние с диска. Пустая заготовка (её заводит
   * стартовое значение `office`) от открытого офиса отличается именно этим:
   * заготовку надо восстановить, открытый офис — переиспользовать как есть.
   */
  opened = false;
  /**
   * Файл состояния этого офиса. Хранится здесь, а не в store.ts: сохранение
   * привязано к офису, а не к процессу, поэтому два офиса не делят ни путь,
   * ни таймер записи.
   */
  private stateFile = DEFAULT_STATE_FILE;
  /** Готовность облачного режима. Ключ и токен в состояние не пишутся. */
  cloud: CloudStatus = { hasKey: false, hasToken: false };
  /**
   * Статусы мержабельности завершённых задач, ключ — id задачи. На диск
   * не сохраняются: порядок слияний и чужие коммиты меняют результат,
   * а восстановленный из файла статус врал бы с уверенным видом.
   */
  mergeChecks = new Map<string, MergeCheck>();
  /** Идёт ли пересчёт статусов прямо сейчас. */
  mergeChecking = false;
  /** Последний прогон очереди слияния — он же текущий, пока running. */
  mergeRun: MergeRun | null = null;
  /**
   * Пауза офиса: новая работа не запускается, а живые сессии замирают
   * на следующем вызове инструмента. Не сохраняется на диск — пауза
   * относится к живым сессиям, а после перезапуска их всё равно нет.
   */
  paused = false;
  /** Расход офиса за всё время — считается отдельно, чтобы увольнение клона не обнуляло сумму. */
  usage: Usage = emptyUsage();
  /** Расход офиса по дням. */
  daily: Record<string, Usage> = {};
  /** Кого разбудить, когда паузу снимут. */
  private resumeWaiters = new Set<() => void>();
  private listeners = new Set<Listener>();
  private taskSeq = 0;
  private permSeq = 0;
  private pending = new Map<string, Pending>();
  /** Ключи вида «roleId:Bash:rm», разрешённые пользователем до конца сессии. */
  private alwaysAllowed = new Set<string>();
  /** Те же ключи, но запрещённые: симметрично «разрешить всегда». */
  private alwaysDenied = new Set<string>();

  constructor(officeId: string) {
    this.officeId = officeId;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ServerEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** Пометить состояние изменившимся — запись на диск идёт с дебаунсом. */
  private markDirty(): void {
    save(this.stateFile, () => this.toPersisted());
  }

  /**
   * Переключить офис на другой файл состояния. Хвост записи прежнего офиса
   * дописываем до переключения: снимок берётся отложенно, и после смены
   * файла он собрал бы уже чужие данные.
   */
  setStateFile(path: string): void {
    const next = resolve(path);
    if (next === this.stateFile) return;
    flushFile(this.stateFile);
    this.stateFile = next;
  }

  /** Досохранить состояние этого офиса немедленно. */
  flush(): void {
    flushFile(this.stateFile);
  }

  /** Стереть сохранение этого офиса вместе с отложенной записью. */
  wipe(): void {
    wipeFile(this.stateFile);
  }

  toPersisted(): Persisted {
    return {
      version: 1,
      projectDir: this.projectDir,
      taskSeq: this.taskSeq,
      tasks: [...this.tasks.values()],
      chat: this.chat,
      log: this.log.slice(-500),
      settings: this.settings,
      roleOverrides: getRoleOverrides(),
      instances: [...this.instances.values()].map<PersistedInstance>((i) => ({
        id: i.id, roleId: i.roleId, deskIndex: i.desk.index,
        usage: i.usage, daily: i.daily, sessionId: i.sessionId,
      })),
      usage: this.usage,
      daily: this.daily,
      savedAt: Date.now(),
    };
  }

  /**
   * Восстановить офис с диска. Возвращает false, если сохранения нет
   * или оно относится к другой рабочей директории.
   */
  restore(): boolean {
    const data = load(this.stateFile);
    if (!data) return false;
    if (data.projectDir !== this.projectDir) {
      console.log('⚠️  Сохранение относится к другой рабочей директории — начинаю с чистого листа');
      return false;
    }

    // Роли восстанавливаем ДО seed: от них зависят названия и лимиты инстансов.
    setRoleOverrides(data.roleOverrides ?? {});
    // Сохранения старше настройки движка не знают про облако — дополняем.
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    this.seed();
    this.taskSeq = data.taskSeq;
    // Записи из версий до появления веток чата относим к разговору с менеджером.
    this.chat = (data.chat ?? []).map((c) => ({ ...c, thread: c.thread ?? 'pm#1' }));
    this.log = data.log ?? [];

    this.usage = { ...emptyUsage(), ...(data.usage ?? {}) };
    this.daily = data.daily ?? {};

    for (const raw of data.tasks ?? []) {
      const t = migrateTask(raw);
      // Задачу, прерванную перезапуском, нельзя выдавать за выполненную:
      // сессия исполнителя умерла вместе с процессом.
      if (t.status === 'in_progress' || t.status === 'assigned') {
        t.status = 'blocked';
        t.result = (t.result ? `${t.result}\n\n` : '') +
          '⚠️ Работа прервана перезапуском сервера. Ветка и рабочая копия сохранены; ' +
          'поставьте задачу заново или слейте то, что успели сделать.';
      }
      this.tasks.set(t.id, t);
    }

    // Состав команды берём из сохранения целиком, а не дополняем им seed():
    // seed() сажает по одному сотруднику на роль и ничего не знает ни про
    // нанятых сверх того клонов, ни про уволенных. Иначе роль, из которой
    // всех уволили, воскресала бы при каждом перезапуске.
    const roster = data.instances ?? [];
    if (roster.length) {
      this.instances.clear();
      for (const pi of roster) this.rehire(pi);
      // PM уволить нельзя, но сохранение могло прийти из версии без него.
      for (const role of allRoles()) {
        if (role.isManager && this.staffOf(role.id).length === 0) this.spawn(role.id);
      }
    }
    // Офисной суммы в старых сохранениях тоже нет — собираем её из агентов.
    if (!data.usage) {
      for (const inst of this.instances.values()) accumulate(this.usage, inst.usage);
    }
    return true;
  }

  /**
   * Вернуть сотрудника из сохранения как есть: тот же id, тот же стол,
   * те же расходы. Стол берём прежний, если он свободен, — иначе офис
   * «разъезжается» после смены раскладки.
   */
  private rehire(pi: PersistedInstance): void {
    const role = roleById(pi.roleId);
    if (!role) return;   // роль исчезла из реестра — восстанавливать некого
    const taken = new Set([...this.instances.values()].map((i) => i.desk.index));
    const desk = (!taken.has(pi.deskIndex) && DESKS.find((d) => d.index === pi.deskIndex))
      || this.freeDesk();
    if (!desk) return;
    const n = pi.id.split('#')[1] ?? '1';
    this.instances.set(pi.id, {
      id: pi.id,
      roleId: pi.roleId,
      label: `${role.title}${role.maxInstances > 1 ? ` #${n}` : ''}`,
      desk,
      state: 'idle',
      currentTaskId: null,
      note: null,
      // Сохранения до детализации расходов знали только сумму — токенов
      // в них нет, и придумывать их нельзя: пусть остаются нулями.
      usage: { ...emptyUsage(), ...(pi.usage ?? { costUsd: pi.costUsd ?? 0 }) },
      daily: pi.daily ?? {},
      sessionId: pi.sessionId,
      abort: null,
    });
  }

  setSessionId(instanceId: string, sessionId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.sessionId === sessionId) return;
    inst.sessionId = sessionId;
    this.markDirty();
  }

  // ---------- инстансы ----------

  seed(): void {
    this.instances.clear();
    this.tasks.clear();
    this.chat = [];
    this.log = [];
    this.taskSeq = 0;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve('deny');
    }
    this.pending.clear();
    this.alwaysAllowed.clear();
    this.alwaysDenied.clear();
    this.usage = emptyUsage();
    this.daily = {};
    this.setPaused(false);
    for (const role of allRoles()) this.spawn(role.id);
  }

  /** Полный сброс по кнопке: стереть сохранение и начать с чистого листа. */
  hardReset(): void {
    this.wipe();
    this.seed();
    // Забываем и id сессий: разговор начинается с чистого листа.
    for (const inst of this.instances.values()) inst.sessionId = null;
    this.markDirty();
  }

  private freeDesk(): Desk | null {
    const taken = new Set([...this.instances.values()].map((i) => i.desk.index));
    return DESKS.find((d) => !taken.has(d.index)) ?? null;
  }

  /** Сотрудники роли: пустой список — вакансия открыта, никого не нанято. */
  staffOf(roleId: string): Instance[] {
    return [...this.instances.values()].filter((i) => i.roleId === roleId);
  }

  /**
   * Наименьший свободный номер в роли. Считать по количеству нельзя:
   * после увольнения backend#1 у роли снова «один сотрудник», и новый
   * получил бы id уже занятого backend#2, затерев живого агента.
   */
  private nextNumber(roleId: string): number {
    const taken = new Set(this.staffOf(roleId).map((i) => Number(i.id.split('#')[1] ?? 0)));
    let n = 1;
    while (taken.has(n)) n += 1;
    return n;
  }

  spawn(roleId: string): Instance | null {
    const role = roleById(roleId);
    if (!role) return null;
    const existing = this.staffOf(roleId);
    if (existing.length >= role.maxInstances) return null;
    // PM всегда садится за нулевой стол, остальные — на любой свободный.
    const desk = role.isManager ? DESKS[0] : this.freeDesk();
    if (!desk) return null;

    const n = this.nextNumber(roleId);
    const inst: Instance = {
      id: `${roleId}#${n}`,
      roleId,
      label: `${role.title}${role.maxInstances > 1 ? ` #${n}` : ''}`,
      desk,
      state: 'idle',
      currentTaskId: null,
      note: null,
      usage: emptyUsage(),
      daily: {},
      sessionId: null,
      abort: null,
    };
    this.instances.set(inst.id, inst);
    this.emit({ t: 'instance', instance: toInstanceView(inst) });
    this.markDirty();
    return inst;
  }

  setState(id: string, state: AgentState, note?: string | null): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.state = state;
    if (note !== undefined) inst.note = note;
    this.emit({ t: 'instance', instance: toInstanceView(inst) });
  }

  /**
   * Записать расход сессии. Одно и то же попадает в четыре места:
   * задача, агент, день агента и офис. «Сколько стоила задача»,
   * «сколько стоил агент» и «сколько потрачено сегодня» — разные вопросы,
   * и ответ на каждый нужен в своём месте интерфейса.
   */
  addUsage(id: string, delta: Usage): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    const day = dayKey();

    if (inst.currentTaskId) {
      const task = this.tasks.get(inst.currentTaskId);
      if (task) {
        accumulate(task.usage, delta);
        this.emit({ t: 'task', task: toTaskView(task) });
      }
    }

    accumulate(inst.usage, delta);
    accumulate(dayOf(inst.daily, day), delta);
    trimJournal(inst.daily);
    this.emit({ t: 'instance', instance: toInstanceView(inst) });

    accumulate(this.usage, delta);
    accumulate(dayOf(this.daily, day), delta);
    trimJournal(this.daily);
    this.emit({ t: 'usage', total: this.usage, days: this.usageDays() });
    this.markDirty();
  }

  /** История расходов офиса по дням, от старых к новым. */
  usageDays(): DayUsage[] {
    return Object.keys(this.daily).sort().map((day) => ({ day, usage: this.daily[day] }));
  }

  /** Расход офиса за сегодня. */
  todayUsage(): Usage {
    return this.daily[dayKey()] ?? emptyUsage();
  }

  /** Свободный исполнитель нужной роли, иначе null. */
  findFree(roleId: string): Instance | null {
    return [...this.instances.values()].find(
      (i) => i.roleId === roleId && !i.currentTaskId,
    ) ?? null;
  }

  // ---------- задачи ----------

  createTask(input: {
    title: string; description: string; criteria: string[]; roleId: string | null;
  }): Task {
    this.taskSeq += 1;
    const task: Task = {
      id: `T-${this.taskSeq}`,
      title: input.title,
      description: input.description,
      criteria: input.criteria.map((text) => ({ text, done: false })),
      roleId: input.roleId,
      assigneeId: null,
      status: 'backlog',
      result: null,
      files: [],
      branch: null,
      baseBranch: null,
      worktreePath: null,
      repoDir: null,
      merged: false,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      usage: emptyUsage(),
    };
    this.tasks.set(task.id, task);
    this.emit({ t: 'task', task: toTaskView(task) });
    this.markDirty();
    return task;
  }

  updateTask(id: string, patch: Partial<Task>): Task | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    Object.assign(task, patch);
    this.emit({ t: 'task', task: toTaskView(task) });
    this.markDirty();
    return task;
  }

  /**
   * Отметить критерий выполненным. Возвращает описание прогресса или
   * причину отказа — исполнитель видит её как результат вызова инструмента.
   */
  checkCriterion(taskId: string, index: number, done = true): { ok: boolean; text: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, text: `Задачи ${taskId} нет на доске.` };
    const item = task.criteria[index - 1];
    if (!item) {
      return {
        ok: false,
        text: `У задачи ${taskId} нет критерия №${index}. Всего критериев: ${task.criteria.length}.`,
      };
    }
    item.done = done;
    this.emit({ t: 'task', task: toTaskView(task) });
    this.markDirty();
    const { done: ready, total } = criteriaProgress(task);
    return { ok: true, text: `Критерий №${index} «${clipText(item.text, 60)}» — ${done ? 'выполнен' : 'снова не выполнен'}. Готово ${ready} из ${total}.` };
  }

  // ---------- чат и лог ----------

  addChat(from: string, text: string, thread = 'pm#1'): void {
    const entry: ChatEntry = { id: randomUUID(), thread, from, text, at: Date.now() };
    this.chat.push(entry);
    this.emit({ t: 'chat', entry });
    this.markDirty();
  }

  addLog(agentId: string | null, kind: LogEntry['kind'], text: string, autoApproved?: boolean): void {
    const entry: LogEntry = { id: randomUUID(), at: Date.now(), agentId, kind, text, autoApproved };
    this.log.push(entry);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    this.emit({ t: 'log', entry });
    this.markDirty();
  }

  // ---------- разрешения ----------

  isAlwaysAllowed(roleId: string, key: string): boolean {
    return this.alwaysAllowed.has(`${roleId}:${key}`);
  }

  isAlwaysDenied(roleId: string, key: string): boolean {
    return this.alwaysDenied.has(`${roleId}:${key}`);
  }

  /** Создаёт запрос, показывает его в UI и ждёт решения пользователя. */
  requestPermission(
    input: Omit<PermissionRequest, 'id' | 'createdAt'>,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    this.permSeq += 1;
    const request: PermissionRequest = {
      ...input,
      id: `P-${this.permSeq}`,
      createdAt: Date.now(),
    };
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.resolvePermission(request.id, 'deny', true);
      }, PERMISSION_TIMEOUT_MS);
      this.pending.set(request.id, { request, resolve, timer });
      // Сессию могли прервать, пока ждём ответа — тогда запрос снимается.
      signal?.addEventListener(
        'abort',
        () => this.resolvePermission(request.id, 'deny'),
        { once: true },
      );
      this.emit({ t: 'permission.request', request });
    });
  }

  resolvePermission(id: string, decision: PermissionDecision, byTimeout = false): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);

    const roleId = this.instances.get(entry.request.agentId)?.roleId;
    if (roleId && decision === 'always') {
      this.alwaysAllowed.add(`${roleId}:${entry.request.key}`);
    }
    if (roleId && decision === 'never') {
      this.alwaysDenied.add(`${roleId}:${entry.request.key}`);
      this.addLog(entry.request.agentId, 'system',
        `Запрет до конца сессии: ${entry.request.key} для роли ${roleId}`);
    }
    if (byTimeout) {
      this.addLog(entry.request.agentId, 'system',
        `Запрос ${id} отклонён: пользователь не ответил за 10 минут`);
    }
    this.emit({ t: 'permission.resolved', id, decision });
    entry.resolve(decision);
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  // ---------- роли и настройки ----------

  /**
   * Репозиторий роли: свой, если задан, иначе общий репозиторий офиса.
   * Относительный путь считается от директории офиса.
   */
  repoFor(role: Role | null | undefined): string {
    const dir = role?.repoDir?.trim();
    if (!dir) return this.projectDir;
    return isAbsolute(dir) ? resolve(dir) : resolve(this.projectDir, dir);
  }

  roleViews(): RoleView[] {
    const officeMode = this.settings.officePermissionMode ?? DEFAULT_SETTINGS.officePermissionMode;
    return allRoles().map<RoleView>((r) => ({
      id: r.id, title: r.title, emoji: r.emoji, color: r.color, model: r.model,
      permissionMode: r.permissionMode, maxInstances: r.maxInstances,
      isolate: r.isolate, repoDir: r.repoDir ?? '', brief: r.brief, isManager: r.isManager,
      active: [...this.instances.values()].filter((i) => i.roleId === r.id).length,
      effectivePermissionMode: effectiveMode(r.permissionMode, officeMode),
    }));
  }

  updateRole(roleId: string, patch: Partial<RoleEditable>): void {
    const base = roleById(roleId);
    if (!base) return;
    const next = { ...getRoleOverrides() };
    next[roleId] = { ...(next[roleId] ?? {}), ...(patch as Partial<Role>) };
    setRoleOverrides(next);
    // Ярлыки инстансов зависят от названия роли.
    for (const inst of this.instances.values()) {
      if (inst.roleId !== roleId) continue;
      const role = roleById(roleId)!;
      const n = inst.id.split('#')[1] ?? '1';
      inst.label = `${role.title}${role.maxInstances > 1 ? ` #${n}` : ''}`;
      this.emit({ t: 'instance', instance: toInstanceView(inst) });
    }
    this.emit({ t: 'roles', roles: this.roleViews() });
    this.addLog(null, 'system', `Роль ${roleId} изменена: ${Object.keys(patch).join(', ')}`);
    this.markDirty();
  }

  updateSettings(patch: Partial<Settings>): void {
    const prevMode = this.settings.officePermissionMode;
    this.settings = { ...this.settings, ...patch };
    this.emit({ t: 'settings', settings: this.settings });
    // Смена режима офиса меняет эффективный режим всех ролей-наследников —
    // без этого UI показывал бы старое до следующего снимка.
    if (this.settings.officePermissionMode !== prevMode) {
      this.emit({ t: 'roles', roles: this.roleViews() });
    }
    this.markDirty();
  }

  totalCost(): number {
    return this.usage.costUsd;
  }

  /** Исчерпан ли общий бюджет офиса. */
  budgetExhausted(): boolean {
    const cap = this.settings.globalBudgetUsd;
    return cap !== null && this.totalCost() >= cap;
  }

  /**
   * Нанять сотрудника роли. Возвращает причину отказа по-русски или null,
   * если наняли. Роль без сотрудников — это открытая вакансия, а не удалённая
   * роль: нанять обратно можно в любой момент.
   */
  hire(roleId: string): string | null {
    const role = roleById(roleId);
    if (!role) return `Роли «${roleId}» нет в офисе.`;
    const staff = this.staffOf(roleId);
    if (staff.length >= role.maxInstances) {
      return `${role.title}: уже нанято ${staff.length} из ${role.maxInstances} — ` +
        'больше эта роль не вмещает. Лимит меняется в настройках роли.';
    }
    const inst = this.spawn(roleId);
    if (!inst) {
      return `Некуда посадить: в офисе ${DESKS.length} рабочих мест и все заняты. ` +
        'Сначала увольте кого-нибудь.';
    }
    this.addLog(null, 'system', `Нанят ${inst.label} (${inst.id})`);
    this.emit({ t: 'roles', roles: this.roleViews() });
    return null;
  }

  /**
   * Уволить сотрудника. Нельзя уволить менеджера и занятого задачей.
   * Последнего в роли уволить можно: роль остаётся в реестре с нулём
   * сотрудников — «вакансия открыта, никого не нанято».
   */
  fire(instanceId: string): string | null {
    const inst = this.instances.get(instanceId);
    if (!inst) return 'Такого сотрудника нет.';
    const role = roleById(inst.roleId);
    if (role?.isManager) return 'PM — единственный, кого нельзя уволить.';
    if (inst.currentTaskId) {
      return `${inst.label} сейчас работает над задачей ${inst.currentTaskId}. ` +
        'Дождитесь её или остановите задачу — тогда сотрудника можно будет уволить.';
    }
    inst.abort?.abort();
    this.instances.delete(instanceId);
    // Стол освобождается вместе с инстансом: свободные места считаются
    // по живым сотрудникам, отдельного реестра занятости нет.
    this.emit({ t: 'instance.remove', id: instanceId });
    this.emit({ t: 'roles', roles: this.roleViews() });
    const left = this.staffOf(inst.roleId).length;
    this.addLog(null, 'system', `Уволен ${inst.label} (${inst.id})` +
      (left === 0 ? `. В роли «${role?.title ?? inst.roleId}» больше никого — вакансия открыта` : ''));
    this.markDirty();
    return null;
  }

  setMeeting(meeting: MeetingView | null): void {
    this.meeting = meeting;
    this.emit({ t: 'meeting', meeting });
  }

  /**
   * Пауза и снятие паузы. Пауза не трогает уже начатые вызовы инструментов:
   * агент замирает на следующем — прервать вызов на середине означало бы
   * потерять сделанное, а это работа кнопки «Остановить», а не паузы.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.emit({ t: 'paused', paused });
    if (!paused) {
      for (const wake of this.resumeWaiters) wake();
      this.resumeWaiters.clear();
    }
  }

  /** Ждать снятия паузы. Прерванная сессия просыпается сразу. */
  whenResumed(signal?: AbortSignal): Promise<void> {
    if (!this.paused || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = () => {
        this.resumeWaiters.delete(wake);
        resolve();
      };
      this.resumeWaiters.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
    });
  }

  /** Сообщить UI о готовности облачного режима. */
  setCloud(patch: Partial<CloudStatus>): void {
    this.cloud = { ...this.cloud, ...patch };
    this.emit({ t: 'cloud', cloud: this.cloud });
  }

  // ---------- слияние ----------

  /** Заменить статусы мержабельности целиком и разослать их клиентам. */
  setMergeChecks(checks: MergeCheck[], checking = false): void {
    this.mergeChecks = new Map(checks.map((c) => [c.taskId, c]));
    this.mergeChecking = checking;
    this.emit({ t: 'merge.checks', checks, checking });
  }

  /** Отметить, что пересчёт пошёл: UI показывает это, пока не пришли новые статусы. */
  setMergeChecking(checking: boolean): void {
    this.mergeChecking = checking;
    this.emit({ t: 'merge.checks', checks: [...this.mergeChecks.values()], checking });
  }

  /** Сохранить и разослать состояние прогона очереди. */
  setMergeRun(run: MergeRun): void {
    this.mergeRun = run;
    this.emit({ t: 'merge.run', run });
  }

  setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.emit({ t: 'busy', busy });
  }

  snapshot(): ServerEvent {
    return {
      t: 'snapshot',
      roles: this.roleViews(),
      instances: [...this.instances.values()].map(toInstanceView),
      tasks: [...this.tasks.values()].map(toTaskView),
      chat: this.chat,
      log: this.log.slice(-200),
      permissions: this.pendingRequests(),
      settings: this.settings,
      projectDir: this.projectDir,
      authSource: this.authSource,
      meeting: this.meeting,
      busy: this.busy,
      paused: this.paused,
      usage: { total: this.usage, days: this.usageDays() },
      offices: officeViews(),
      cloud: this.cloud,
      mergeChecks: [...this.mergeChecks.values()],
      mergeRun: this.mergeRun,
    };
  }
}

/**
 * Список офисов для UI: реестр, отметка текущего и сводка активности.
 * У текущего офиса берём её из памяти — файл отстаёт на дебаунс записи,
 * у остальных читаем их сохранение.
 */
export const officeViews = (): OfficeView[] => {
  const current = currentOffice();
  return offices().map((o) => ({
    id: o.id, name: o.name, projectDir: o.projectDir,
    current: o.id === current?.id, lastOpenedAt: o.lastOpenedAt,
    activity: o.id === current?.id
      ? summarize({ tasks: [...office.tasks.values()], chat: office.chat, log: office.log })
      : activityFromFile(o.stateFile),
  }));
};

export const toInstanceView = (i: Instance): InstanceView => ({
  id: i.id, roleId: i.roleId, label: i.label, desk: i.desk,
  state: i.state, currentTaskId: i.currentTaskId, note: i.note,
  usage: i.usage, today: i.daily[dayKey()] ?? emptyUsage(),
});

export const toTaskView = (t: Task): TaskView => ({
  id: t.id, title: t.title, description: t.description,
  criteria: t.criteria, roleId: t.roleId,
  assigneeId: t.assigneeId, status: t.status, result: t.result,
  files: t.files, branch: t.branch, baseBranch: t.baseBranch,
  worktreePath: t.worktreePath, repoDir: t.repoDir ?? null, merged: t.merged,
  createdAt: t.createdAt,
  startedAt: t.startedAt, finishedAt: t.finishedAt,
  usage: t.usage,
});

/**
 * Репозиторий, в котором велась задача. Путь берётся с самой задачи: настройка
 * роли могла с тех пор смениться, а результат лежит там, где его сделали.
 * У задач, заведённых до появления репозиториев на роль, поля нет — для них
 * это директория офиса.
 */
export const taskRepo = (t: Task): string => t.repoDir ?? office.projectDir;

/** Сколько критериев отмечено — одна формулировка на весь офис. */
export const criteriaProgress = (t: Task | TaskView): { done: number; total: number } => ({
  done: t.criteria.filter((c) => c.done).length,
  total: t.criteria.length,
});

const clipText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Сохранения до структурированных критериев держали один текст, а расход —
 * тремя плоскими полями. Читаем и то и другое: терять доску из-за смены
 * формата нельзя.
 */
function migrateTask(raw: Task & {
  acceptanceCriteria?: string; costUsd?: number; tokensIn?: number; tokensOut?: number;
}): Task {
  const criteria: Criterion[] = raw.criteria ?? (raw.acceptanceCriteria
    ? raw.acceptanceCriteria.split(/\n+/).map((line) => line.replace(/^[-—•*\d.)\s]+/, '').trim())
      .filter(Boolean).map((text) => ({ text, done: false }))
    : []);
  const usage: Usage = raw.usage ?? {
    ...emptyUsage(),
    costUsd: raw.costUsd ?? 0,
    tokensIn: raw.tokensIn ?? 0,
    tokensOut: raw.tokensOut ?? 0,
  };
  return { ...raw, criteria, usage };
}

/**
 * Реестр состояний: один OfficeState на офис за всё время жизни процесса.
 * Ленивый — состояние заводится при первом обращении и дальше живёт в памяти.
 * Пересоздавать его на каждом открытии нельзя: тогда возврат в офис читал бы
 * доску заново с диска и терял всё, что не успело до него доехать.
 */
const states = new Map<string, OfficeState>();

/**
 * Слушатели, которые следуют за офисом, а не за конкретным состоянием:
 * сокет живёт дольше открытого офиса. Держим их отдельно, чтобы подписать
 * каждое новое состояние ровно один раз и не копить дубли при переключениях.
 */
const followers = new Set<Listener>();

/** Состояние офиса по id: уже поднятое либо пустое, заведённое сейчас. */
export function getOffice(officeId: string): OfficeState {
  const found = states.get(officeId);
  if (found) return found;
  const created = new OfficeState(officeId);
  for (const fn of followers) created.subscribe(fn);
  states.set(officeId, created);
  return created;
}

/**
 * Подписка на события текущего офиса и всех, которые откроются позже.
 * Отписки нет намеренно: подписчик здесь один — рассылка по сокетам,
 * и живёт она столько же, сколько процесс.
 */
export function subscribeOffices(fn: Listener): void {
  followers.add(fn);
  // Set в subscribe() делает повторную подписку тем же обработчиком пустой,
  // так что второй вызов не удваивает рассылку.
  for (const state of states.values()) state.subscribe(fn);
}

/**
 * Текущий открытый офис. Именно ссылка, а не константа: переключение офиса
 * переставляет её, и весь код, читающий `office`, продолжает работать без
 * правок — импорт в ES-модуле живой.
 */
export let office = getOffice('o-1');

/** Сделать состояние текущим, передав ему общие на процесс правки ролей. */
function activate(next: OfficeState): void {
  if (next === office) return;
  office.roleOverrides = getRoleOverrides();
  office = next;
  setRoleOverrides(next.roleOverrides);
}

/**
 * Открыть офис и сделать его текущим. Первое открытие поднимает состояние
 * из своего файла, повторное — берёт уже поднятое из памяти: доска, расходы
 * и разговоры офиса переживают переключение туда и обратно.
 *
 * `restored` — подняли с диска сейчас, `reused` — офис уже был открыт в этом
 * процессе; оба false означают новый офис, начатый с чистого листа.
 */
export function openOfficeState(entry: { id: string; projectDir: string; stateFile: string }):
  { state: OfficeState; restored: boolean; reused: boolean } {
  const state = getOffice(entry.id);
  activate(state);
  if (state.opened) return { state, restored: false, reused: true };

  state.projectDir = entry.projectDir;
  state.setStateFile(entry.stateFile);
  state.opened = true;
  const restored = state.restore();
  if (!restored) {
    // Офис с чистого листа начинается и с чистых ролей: правки ролей
    // принадлежат офису, а их реестр в roles.ts — общий на процесс.
    setRoleOverrides({});
    state.seed();
  }
  state.roleOverrides = getRoleOverrides();
  return { state, restored, reused: false };
}

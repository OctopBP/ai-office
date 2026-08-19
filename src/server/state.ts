import { randomUUID } from 'node:crypto';
import type {
  AgentState, ChatEntry, Desk, InstanceView, LogEntry, PermissionDecision,
  AuthSource, MeetingView, PermissionRequest, RoleEditable, RoleView, ServerEvent,
  Settings, TaskStatus, TaskView,
} from '../shared/types';
import { allRoles, getRoleOverrides, roleById, setRoleOverrides, type Role } from './roles';
import { load, save, wipe, type Persisted, type PersistedInstance } from './store';

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
  costUsd: number;
  abort: AbortController | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  roleId: string | null;
  assigneeId: string | null;
  status: TaskStatus;
  result: string | null;
  files: string[];
  branch: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  merged: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

interface Pending {
  request: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

/** Сколько ждём ответа пользователя, прежде чем отказать. */
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

class OfficeState {
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
  settings: Settings = { globalBudgetUsd: null, taskBudgetUsd: null };
  authSource: AuthSource = 'unknown';
  private listeners = new Set<Listener>();
  private taskSeq = 0;
  private permSeq = 0;
  private pending = new Map<string, Pending>();
  /** Ключи вида «roleId:Bash:rm», разрешённые пользователем до конца сессии. */
  private alwaysAllowed = new Set<string>();
  /** Те же ключи, но запрещённые: симметрично «разрешить всегда». */
  private alwaysDenied = new Set<string>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ServerEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** Пометить состояние изменившимся — запись на диск идёт с дебаунсом. */
  private markDirty(): void {
    save(() => this.toPersisted());
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
        costUsd: i.costUsd, sessionId: i.sessionId,
      })),
      savedAt: Date.now(),
    };
  }

  /**
   * Восстановить офис с диска. Возвращает false, если сохранения нет
   * или оно относится к другой рабочей директории.
   */
  restore(): boolean {
    const data = load();
    if (!data) return false;
    if (data.projectDir !== this.projectDir) {
      console.log('⚠️  Сохранение относится к другой рабочей директории — начинаю с чистого листа');
      return false;
    }

    // Роли восстанавливаем ДО seed: от них зависят названия и лимиты инстансов.
    setRoleOverrides(data.roleOverrides ?? {});
    this.settings = data.settings ?? { globalBudgetUsd: null, taskBudgetUsd: null };
    this.seed();
    this.taskSeq = data.taskSeq;
    // Записи из версий до появления веток чата относим к разговору с менеджером.
    this.chat = (data.chat ?? []).map((c) => ({ ...c, thread: c.thread ?? 'pm#1' }));
    this.log = data.log ?? [];

    for (const t of data.tasks ?? []) {
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

    // Восстанавливаем нанятых клонов: seed() создаёт по одному на роль,
    // без этого их расходы потерялись бы и общая сумма занижалась.
    for (const pi of data.instances ?? []) {
      if (!this.instances.has(pi.id)) this.spawn(pi.roleId);
    }
    for (const pi of data.instances ?? []) {
      const inst = this.instances.get(pi.id);
      if (inst) {
        inst.costUsd = pi.costUsd;
        inst.sessionId = pi.sessionId;
      }
    }
    return true;
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
    for (const role of allRoles()) this.spawn(role.id);
  }

  /** Полный сброс по кнопке: стереть сохранение и начать с чистого листа. */
  hardReset(): void {
    wipe();
    this.seed();
    this.markDirty();
  }

  private freeDesk(): Desk | null {
    const taken = new Set([...this.instances.values()].map((i) => i.desk.index));
    return DESKS.find((d) => !taken.has(d.index)) ?? null;
  }

  spawn(roleId: string): Instance | null {
    const role = roleById(roleId);
    if (!role) return null;
    const existing = [...this.instances.values()].filter((i) => i.roleId === roleId);
    if (existing.length >= role.maxInstances) return null;
    // PM всегда садится за нулевой стол, остальные — на любой свободный.
    const desk = role.isManager ? DESKS[0] : this.freeDesk();
    if (!desk) return null;

    const n = existing.length + 1;
    const inst: Instance = {
      id: `${roleId}#${n}`,
      roleId,
      label: `${role.title}${role.maxInstances > 1 ? ` #${n}` : ''}`,
      desk,
      state: 'idle',
      currentTaskId: null,
      note: null,
      costUsd: 0,
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

  addCost(id: string, usd: number, tokens?: { input: number; output: number }): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    // Расход пишем и агенту, и его текущей задаче: «сколько стоил агент»
    // и «сколько стоила задача» — разные вопросы, оба нужны в дровере.
    if (inst.currentTaskId) {
      const task = this.tasks.get(inst.currentTaskId);
      if (task) {
        task.costUsd += usd;
        task.tokensIn += tokens?.input ?? 0;
        task.tokensOut += tokens?.output ?? 0;
        this.emit({ t: 'task', task: toTaskView(task) });
      }
    }
    if (!usd) return;
    inst.costUsd += usd;
    this.emit({ t: 'instance', instance: toInstanceView(inst) });
    this.markDirty();
  }

  /** Свободный исполнитель нужной роли, иначе null. */
  findFree(roleId: string): Instance | null {
    return [...this.instances.values()].find(
      (i) => i.roleId === roleId && !i.currentTaskId,
    ) ?? null;
  }

  // ---------- задачи ----------

  createTask(input: {
    title: string; description: string; acceptanceCriteria: string; roleId: string | null;
  }): Task {
    this.taskSeq += 1;
    const task: Task = {
      id: `T-${this.taskSeq}`,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      roleId: input.roleId,
      assigneeId: null,
      status: 'backlog',
      result: null,
      files: [],
      branch: null,
      baseBranch: null,
      worktreePath: null,
      merged: false,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
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

  // ---------- чат и лог ----------

  addChat(from: string, text: string, thread = 'pm#1'): void {
    const entry: ChatEntry = { id: randomUUID(), thread, from, text, at: Date.now() };
    this.chat.push(entry);
    this.emit({ t: 'chat', entry });
    this.markDirty();
  }

  addLog(agentId: string | null, kind: LogEntry['kind'], text: string): void {
    const entry: LogEntry = { id: randomUUID(), at: Date.now(), agentId, kind, text };
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

  roleViews(): RoleView[] {
    return allRoles().map<RoleView>((r) => ({
      id: r.id, title: r.title, emoji: r.emoji, color: r.color, model: r.model,
      permissionMode: r.permissionMode, maxInstances: r.maxInstances,
      isolate: r.isolate, brief: r.brief, isManager: r.isManager,
      active: [...this.instances.values()].filter((i) => i.roleId === r.id).length,
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
    this.settings = { ...this.settings, ...patch };
    this.emit({ t: 'settings', settings: this.settings });
    this.markDirty();
  }

  totalCost(): number {
    return [...this.instances.values()].reduce((sum, i) => sum + i.costUsd, 0);
  }

  /** Исчерпан ли общий бюджет офиса. */
  budgetExhausted(): boolean {
    const cap = this.settings.globalBudgetUsd;
    return cap !== null && this.totalCost() >= cap;
  }

  /** Убрать клона. Нельзя уволить занятого, менеджера и последнего в роли. */
  fire(instanceId: string): string | null {
    const inst = this.instances.get(instanceId);
    if (!inst) return 'Такого сотрудника нет.';
    const role = roleById(inst.roleId);
    if (role?.isManager) return 'PM — единственный, кого нельзя уволить.';
    if (inst.currentTaskId) return `${inst.id} сейчас занят задачей ${inst.currentTaskId}.`;
    const sameRole = [...this.instances.values()].filter((i) => i.roleId === inst.roleId);
    if (sameRole.length <= 1) return `${inst.id} — последний в своей роли.`;
    inst.abort?.abort();
    this.instances.delete(instanceId);
    this.emit({ t: 'instance.remove', id: instanceId });
    this.emit({ t: 'roles', roles: this.roleViews() });
    this.markDirty();
    return null;
  }

  setMeeting(meeting: MeetingView | null): void {
    this.meeting = meeting;
    this.emit({ t: 'meeting', meeting });
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
    };
  }
}

export const toInstanceView = (i: Instance): InstanceView => ({
  id: i.id, roleId: i.roleId, label: i.label, desk: i.desk,
  state: i.state, currentTaskId: i.currentTaskId, note: i.note, costUsd: i.costUsd,
});

export const toTaskView = (t: Task): TaskView => ({
  id: t.id, title: t.title, description: t.description,
  acceptanceCriteria: t.acceptanceCriteria, roleId: t.roleId,
  assigneeId: t.assigneeId, status: t.status, result: t.result,
  files: t.files, branch: t.branch, baseBranch: t.baseBranch,
  worktreePath: t.worktreePath, merged: t.merged, createdAt: t.createdAt,
  startedAt: t.startedAt, finishedAt: t.finishedAt,
  costUsd: t.costUsd, tokensIn: t.tokensIn, tokensOut: t.tokensOut,
});

export const office = new OfficeState();

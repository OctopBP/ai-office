import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type {
  AgentState, ChatDraft, ChatEntry, Criterion, DayUsage, Desk, FieldError, InstanceView, LogEntry,
  PermissionDecision, AuthSource, MeetingView, PermissionMode, PermissionRequest, RoleDraft,
  McpServerDef, McpServerState, RoleEditable, RoleView, ServerEvent, Settings, TaskStatus,
  TaskPriority, TaskView, Usage,
  EpicStatus, EpicView,
  CloudStatus, EnvCheck, EnvReport, OfficeView, MergeCheck, MergeRun, LayoutOption,
  Layout, LayoutOverride, LayoutPropEdit,
  PullRequestView, PrStage, ReviewNote, TaskOutcome, BranchMark,
  FactView, LifeView, OwnerQuestion, RitualId, RitualPolicy, RitualRun,
  DirectionView, ProposalView, InitiativeMode,
} from '../shared/types';
import { OFFICE_SENDER } from '../shared/types';
import {
  asTaskPriority, DEFAULT_TASK_PRIORITY,
  dayKey, emptyUsage, DEFAULT_RITUAL_LIMIT, DEFAULT_RITUAL_POLICY,
  DEFAULT_INITIATIVE_MODE, DEFAULT_INITIATIVE_SHARE, HEALTH_DIRECTION, INITIATIVE_MODES,
  MAX_INITIATIVE_SHARE, MIN_INITIATIVE_SHARE,
  DEFAULT_OFFICE_WORKERS, MAX_AGENT_NAME, MAX_HIRE_COUNT, MAX_OFFICE_WORKERS, MAX_TASK_MAX_TURNS,
  MIN_OFFICE_WORKERS, MIN_TASK_MAX_TURNS, ROLE_TITLE_LIMIT,
  DEFAULT_FOCUS_EPICS, MAX_FOCUS_EPICS, MIN_FOCUS_EPICS,
  DEFAULT_PM_CONTEXT_LIMIT, MAX_PM_CONTEXT_LIMIT, MIN_PM_CONTEXT_LIMIT,
  DEFAULT_WORKER_CONTEXT_LIMIT, MAX_WORKER_CONTEXT_LIMIT, MIN_WORKER_CONTEXT_LIMIT,
} from '../shared/types';
import { isBlocked, isEmptyOverride, passability } from '../shared/layout';
import { isLookId, LOOKS } from '../shared/looks';
import { asLang, DEFAULT_LANG, isLang, type Lang, type Vars, LANG_TITLE } from '../shared/i18n';
import {
  CHECK_NAME_RE, TASK_TYPES, emptyFlowMemory, isCapability, typeForCapabilities,
  type Capability, type FlowMemory, type Handoff, type Run, type TaskType,
} from '../shared/workflow';
import { workflowCatalog } from './workflows';
import { capabilitiesOf } from './roles';
import { t, setProcessLang, c, type ServerKey } from './i18n';
import { activityFromFile, summarize } from './activity';
import {
  DEFAULT_LAYOUT_ID, FALLBACK_LAYOUT_ID, catalog, checkPropEdit, deskPlan, effectiveLayout, hasLayout,
  layoutOptions,
  layoutTitle, type DeskPlan,
} from './layout';
import { OFFICE_PERSON, repoProblem, type GitPerson } from './git';
import {
  limitsView, noteRateLimit as recordRateLimit, pollLimits,
  type LimitSource, type RateLimitInfo,
} from './limits';
import { currentOffice, officeIconView, officePaused, offices, setOfficePaused } from './offices';
import {
  checkMcpServers, DEFAULT_MCP_SERVERS, mcpNamesFor, pollMcpStatus, type McpStatusSource,
} from './mcp';
import { employeeServers } from './skills';
import { effectiveMode, isPermissionMode, modeLabel } from './permissions';
import type { MessageQueue } from './queue';
import {
  basePackageName, blankRole, defaultRole, defaultRoles, newRoleId, newRoleTitle,
  OVERRIDABLE_KEYS, paletteColor, roleFromPackage, roleIdFor, rolesFromOverrides, sameValue,
  withManagerRole,
  type LinkOverrides, type PackageSource, type Role, type RoleLink,
} from './roles';
import {
  loadPackage, packageBrief, packageTitle, PACKAGE_NAME_RE, resolvePackage, type AgentPackage,
} from './packages';
import {
  DEFAULT_STATE_FILE, flush as flushFile, load, save, wipe as wipeFile,
  type Persisted, type PersistedInstance,
} from './store';

type Listener = (e: ServerEvent) => void;

/**
 * Слушатель рассылки по всем офисам. Офис приходит вторым аргументом, а не
 * внутри события: события — общий контракт с вебом, и клиенту знать чужие
 * id офисов незачем. Отправителю же метка нужна, чтобы не слать событие
 * одного офиса тому, кто открыл другой.
 */
type OfficeListener = (e: ServerEvent, officeId: string) => void;

/** Сколько дней истории расходов держим — на «за день» и недельный график. */
const DAYS_KEPT = 14;

/** Настройки офиса по умолчанию — они же дополняют старые сохранения. */
export const DEFAULT_SETTINGS: Settings = {
  language: DEFAULT_LANG,
  globalBudgetUsd: null,
  taskBudgetUsd: null,
  // 60 — то, что и так стояло в коде константой MAX_WORKER_TURNS: возврат
  // настройки не должен менять поведение офисов, где её никто не трогал.
  taskMaxTurns: 60,
  maxConcurrentWorkers: DEFAULT_OFFICE_WORKERS,
  engine: 'local',
  cloudRepoUrl: null,
  officePermissionMode: 'ask-risky',
  layoutId: DEFAULT_LAYOUT_ID,
  autoPipeline: true,
  focusEpics: DEFAULT_FOCUS_EPICS,
  // Согласие спрашиваем по умолчанию: план — это обещание потратить деньги
  // на несколько часов работы, и начинать его молча офис не вправе.
  planApproval: true,
  // Каталог внешних серверов: с ним заводится новый офис. Дальше он живёт в
  // настройках этого офиса и правится из интерфейса.
  mcpServers: DEFAULT_MCP_SERVERS,
  // Ритуалы включены по умолчанию: офис, который не помнит вчерашнего, —
  // это офис, которым нужно управлять руками, а от этого он и должен избавлять.
  ritualsEnabled: true,
  ritualLimitThreshold: DEFAULT_RITUAL_LIMIT,
  initiativeMode: DEFAULT_INITIATIVE_MODE,
  initiativeShare: DEFAULT_INITIATIVE_SHARE,
  pmContextLimit: DEFAULT_PM_CONTEXT_LIMIT,
  workerContextLimit: DEFAULT_WORKER_CONTEXT_LIMIT,
};

/** Доля на своё: число от MIN до MAX; всё остальное — мусор. */
export function sanitizeShare(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < MIN_INITIATIVE_SHARE || value > MAX_INITIATIVE_SHARE) return undefined;
  return Math.round(value * 100) / 100;
}

export const isInitiativeMode = (value: unknown): value is InitiativeMode =>
  typeof value === 'string' && (INITIATIVE_MODES as string[]).includes(value);

/** Сколько направлений держим: больше — уже бэклог, а не курс (§7.1). */
export const MAX_DIRECTIONS = 7;

/** Направление на сервере — то же, что видит клиент. */
export type Direction = DirectionView;

/**
 * План одной фичи, как его присылает менеджер (plan.ts → PlannedEpic).
 * Описан здесь структурно, а не импортом: план зовёт состояние, и импорт
 * в обратную сторону замкнул бы модули друг на друга.
 */
export interface PlannedEpicLike {
  title: string;
  goal: string;
  tasks: Array<{
    key: string; title: string; description: string; acceptanceCriteria: string[];
    roleId: string; dependsOn?: string[];
  }>;
}

/** Предложение на сервере: клиентский вид плюс план фичи, если это фича. */
export interface Proposal extends ProposalView {
  plan: PlannedEpicLike | null;
}

/** Порог лимита для ритуалов: проценты окна, целое от 10 до 100. */
export function sanitizeRitualLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n < 10 || n > 100) return undefined;
  return n;
}

/** Порог контекста менеджера: целое число токенов в допустимом окне; всё остальное — мусор. */
export function sanitizePmContextLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n < MIN_PM_CONTEXT_LIMIT || n > MAX_PM_CONTEXT_LIMIT) return undefined;
  return n;
}

/** Окно автосжатия исполнителя: то же, но в своих границах — ниже минимума SDK не примет. */
export function sanitizeWorkerContextLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n < MIN_WORKER_CONTEXT_LIMIT || n > MAX_WORKER_CONTEXT_LIMIT) return undefined;
  return n;
}

/**
 * Язык, на котором заводится НОВЫЙ офис. Это свойство запуска, а не офиса:
 * у офиса язык свой и живёт в его настройках, но самый первый откуда-то надо
 * взять. Берём его из окружения (`OFFICE_LANG`), как и остальные свойства
 * прогона: своей настройки в интерфейсе у него нет и быть не может — менять
 * там нечего, пока офис не открыт.
 *
 * Читается на каждое открытие, а не один раз при загрузке модуля: так его
 * может задать и проверка, поднимающая офисы в одном процессе.
 */
const startupLang = (): Lang => asLang(process.env.OFFICE_LANG);

/**
 * Привести лимит ходов к допустимому: целое в границах либо null («без
 * ограничения»). undefined — значение непригодно и его надо игнорировать,
 * а не превращать в null: пустое поле и опечатка означают разное.
 */
export function sanitizeMaxTurns(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n < MIN_TASK_MAX_TURNS) return undefined;
  return Math.min(n, MAX_TASK_MAX_TURNS);
}

/**
 * Привести лимит одновременных исполнителей к допустимому. undefined —
 * значение непригодно и его надо игнорировать: в отличие от лимита ходов,
 * null здесь не значит «без ограничения», а значит «мусор из сети или из
 * файла состояния», и прежнее число надёжнее.
 */
export function sanitizeWorkers(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n < MIN_OFFICE_WORKERS) return undefined;
  return Math.min(n, MAX_OFFICE_WORKERS);
}

/**
 * Привести число одновременно ведомых фич к допустимому. Ноль из правленого
 * руками файла означал бы план, который офис не начнёт никогда, — это не
 * настройка, а поломка, и такое значение мы не берём.
 */
export function sanitizeFocus(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n < MIN_FOCUS_EPICS) return undefined;
  return Math.min(n, MAX_FOCUS_EPICS);
}

/**
 * Кого позвать, когда лимит исполнителей офиса подняли: ждущие слота задачи
 * должны поехать сразу, а не после следующего завершения. Живёт здесь, а не
 * вызовом agents.ts напрямую: состояние про запуск сессий ничего не знает и
 * знать не должно, иначе модули замкнутся друг на друга.
 */
let workerLimitWatcher: (() => void) | null = null;

export function onWorkerLimitChanged(fn: () => void): void {
  workerLimitWatcher = fn;
}

/**
 * Кого позвать, когда перечень ролей офиса стал другим. Перечень вшит в
 * описание create_task и в бриф менеджера в момент старта сессии: не перезапусти
 * её — и менеджер будет назначать задачи на роль, которой больше нет, либо не
 * увидит только что заведённую. Живёт здесь по той же причине, что и watcher
 * лимита: состояние про сессии ничего не знает и знать не должно.
 */
let roleSetWatcher: ((state: OfficeState) => void) | null = null;

export function onRoleSetChanged(fn: (state: OfficeState) => void): void {
  roleSetWatcher = fn;
}

/**
 * Кого позвать, когда критичные проверки окружения из красных стали зелёными:
 * задачи, которых офис не брал из-за мёртвого окружения, должны поехать сами,
 * без «нажмите ещё раз». Живёт здесь по той же причине, что и watcher лимита:
 * состояние про запуск сессий ничего не знает.
 */
let envReadyWatcher: ((state: OfficeState) => void) | null = null;

export function onEnvReady(fn: (state: OfficeState) => void): void {
  envReadyWatcher = fn;
}

/**
 * Есть ли среди проверок красная критичная. Пустой список — это «ещё ни разу
 * не считали», а не «всё плохо»: до первого пересчёта офис работает как
 * работал, иначе старт сервера сам себе перекрыл бы доску.
 */
export const criticalEnvFail = (checks: EnvCheck[]): EnvCheck | null =>
  checks.find((ch) => ch.critical && ch.status === 'fail') ?? null;

/**
 * Поля роли, которые правятся из формы. Список нужен именно перечислением:
 * патч приезжает из сети, и без белого списка вместе с ним доехали бы
 * `archived` и `isManager` — архивация и второй менеджер в обход проверок.
 */
const ROLE_EDITABLE_KEYS: readonly (keyof RoleEditable)[] = [
  'title', 'emoji', 'color', 'model', 'permissionMode',
  'isolate', 'maxTurns', 'repoDir', 'sprite', 'brief', 'briefExtra', 'mcp', 'capabilities',
];

/** Свои проверки проекта: имя по форме, команда непустая и не бесконечная. */
function sanitizeChecks(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const clean: Record<string, string> = {};
  for (const [name, command] of Object.entries(value as Record<string, unknown>)) {
    if (!CHECK_NAME_RE.test(name) || typeof command !== 'string') continue;
    const cmd = command.trim();
    if (!cmd || cmd.length > 500) continue;
    clean[name] = cmd;
  }
  return clean;
}

/** Какой процесс за каким типом задачи: только известные типы, id по форме. */
function sanitizeWorkflowMap(value: unknown): Partial<Record<TaskType, string>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const clean: Partial<Record<TaskType, string>> = {};
  for (const [type, id] of Object.entries(value as Record<string, unknown>)) {
    if (!(TASK_TYPES as readonly string[]).includes(type) || typeof id !== 'string') continue;
    if (/^[a-z][a-z0-9-]*$/.test(id.trim())) clean[type as TaskType] = id.trim();
  }
  return clean;
}

/**
 * Форма id модели. Точного списка на сервере нет и быть не должно: модели
 * появляются чаще, чем выходит офис, а выбор из знакомых предлагает UI. Здесь
 * отсекается мусор — пустое поле и строки, которые SDK не примет.
 */
const MODEL_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Модель новой роли, если форма её не назвала. */
const DEFAULT_ROLE_MODEL = 'claude-sonnet-5';

/** Непустая строка из файла состояния либо undefined: пустое поле — не значение. */
const text = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.trim() ? value : undefined);

/**
 * Ссылка роли на пакет из сохранения — или null, если её нет или она
 * испорчена. Оверрайды здесь не проверяются по значению: их проверит
 * roleFromPackage тем же путём, что и правку из формы.
 */
function sanitizeLink(raw: unknown): RoleLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const link = raw as Partial<RoleLink>;
  if (typeof link.name !== 'string' || !PACKAGE_NAME_RE.test(link.name)) return null;
  const overrides = link.overrides && typeof link.overrides === 'object' && !Array.isArray(link.overrides)
    ? link.overrides : {};
  const src = link.source && typeof link.source === 'object' ? link.source as Partial<PackageSource> : null;
  const source: PackageSource | null = src && typeof src.repo === 'string' && typeof src.commit === 'string'
    ? { repo: src.repo, path: typeof src.path === 'string' ? src.path : '', commit: src.commit }
    : null;
  return {
    name: link.name,
    version: typeof link.version === 'string' ? link.version : '',
    ...(source ? { source } : {}),
    overrides: { ...overrides },
    briefExtra: typeof link.briefExtra === 'string' ? link.briefExtra : '',
    // Номер копии — часть названия сотрудника, и без него «Бэкенд 2» после
    // перезапуска снова стал бы «Бэкендом», неотличимым от первого.
    ...(typeof link.copy === 'number' && Number.isFinite(link.copy) && link.copy > 1
      ? { copy: Math.floor(link.copy) } : {}),
  };
}

/**
 * Привязать сохранённую роль к пакету, найдя разницу: сохранение старше
 * пакетов хранит роль целиком, и всё, что в ней отличается от пакета, —
 * правки человека. Бриф при этом делится так: совпал с брифом пакета на
 * любом языке — приписки нет; начинается с него — остаток и есть приписка;
 * другой текст — человек переписал роль, и это форк: null, роль остаётся
 * без пакета, как и была.
 */
function linkFromSave(raw: Partial<Role>, pkg: AgentPackage, id: string, lang: Lang): RoleLink | null {
  const link: RoleLink = { name: pkg.name, version: pkg.version, overrides: {}, briefExtra: '' };
  const saved = typeof raw.brief === 'string' ? raw.brief.trimEnd() : '';
  const briefs = Object.values(pkg.briefs).map((b) => b.trimEnd());
  if (saved && !briefs.includes(saved)) {
    const own = briefs.find((b) => b && saved.startsWith(`${b}\n`));
    if (!own) return null;
    link.briefExtra = saved.slice(own.length).trim();
  }
  const defaults = roleFromPackage(pkg, lang, id);
  // Название сверяем на обоих языках: файл мог быть сохранён офисом на
  // другом языке, и «Backend developer» у русского офиса — это не переименование.
  const titles = Object.values(pkg.manifest.title);
  for (const key of OVERRIDABLE_KEYS) {
    const value = raw[key as keyof Role];
    if (value === undefined) continue;
    if (key === 'title' && typeof value === 'string' && titles.includes(value)) continue;
    if (key === 'maxTurns' && sanitizeMaxTurns(value) === undefined) continue;
    if (!sameValue(value, defaults[key as keyof Role])) {
      (link.overrides as Record<string, unknown>)[key] = value;
    }
  }
  return link;
}

/**
 * Причесать одну роль из сохранения. Файл состояния правят руками, а роль
 * уезжает прямо в SDK: без модели и названия она обрушила бы и офис, и запуск
 * сессии. Каждое непригодное поле заменяем базовым значением этой роли —
 * терять из-за одной опечатки весь набор нельзя.
 *
 * Роль с пакетом не читается из сохранения, а считается заново из пакета:
 * так обновлённый пакет доезжает до уже заведённого офиса. Сохранённые поля
 * нужны ей только на случай, если пакета на диске нет.
 */
function sanitizeRole(raw: Partial<Role>, id: string, lang: Lang): Role {
  const savedLink = sanitizeLink(raw.package);
  const archived = raw.archived === true;
  // Роль без ссылки, но с id нашей базовой роли — сохранение старше пакетов.
  // Привязываем к пакету, если человек не переписал ей бриф.
  // Ссылка с источником ведёт в кеш по имени и версии; без источника — во
  // встроенные. Роль без ссылки, но с id нашей базовой — тоже во встроенные.
  const pkg = savedLink ? resolvePackage(savedLink) : loadPackage(basePackageName(id));
  if (pkg) {
    const link = savedLink ?? linkFromSave(raw, pkg, id, lang);
    if (link) {
      // Лимит ходов из правленого файла проверяем как и раньше: испорченный
      // выкидываем, роль возвращается к офисному.
      if ('maxTurns' in link.overrides && sanitizeMaxTurns(link.overrides.maxTurns) === undefined) {
        delete link.overrides.maxTurns;
      }
      if (typeof link.overrides.model === 'string' && !MODEL_RE.test(link.overrides.model)) {
        delete link.overrides.model;
      }
      // Переезд на единую палитру: оверрайд, равный прежнему умолчанию этого
      // же пакета, — не выбор человека, а старый цвет, застрявший в состоянии
      // офиса (у сохранения без ссылки он становится оверрайдом прямо здесь,
      // в linkFromSave: с цветом нового манифеста он не совпадает). Снимаем
      // его — и роль снова берёт цвет из манифеста. Идемпотентно: снятый
      // оверрайд не возвращается, а цвет палитры в таблице не значится.
      if (typeof link.overrides.color === 'string'
        && paletteColor(link.overrides.color, pkg.name) !== link.overrides.color) {
        delete link.overrides.color;
      }
      return { ...roleFromPackage(pkg, lang, id, link), archived };
    }
  } else if (savedLink) {
    console.log(c('state.role.packageMissing', { name: savedLink.name, title: text(raw.title) ?? id, id }));
  }

  const base = blankRole(id);
  const turns = sanitizeMaxTurns(raw.maxTurns);
  const mode = raw.permissionMode;
  return {
    id,
    title: text(raw.title) ?? base.title,
    // Роль без пакета цвет хранит сама — переводим его на палитру здесь же:
    // совпал со старым умолчанием (своего пакета, а без пакета — с любым из
    // прежнего набора) — берём цвет палитры, иначе оставляем как есть.
    color: paletteColor(text(raw.color) ?? base.color, pkg?.name),
    emoji: text(raw.emoji) ?? base.emoji,
    model: text(raw.model) ?? base.model,
    isManager: typeof raw.isManager === 'boolean' ? raw.isManager : base.isManager,
    // null у режима законен — «как в офисе», поэтому отличаем его от мусора.
    permissionMode: mode === null || isPermissionMode(mode) ? mode : base.permissionMode,
    isolate: typeof raw.isolate === 'boolean' ? raw.isolate : base.isolate,
    // Непригодный лимит ходов выкидываем: роль вернётся к офисному, а
    // остальные её настройки останутся на месте.
    maxTurns: turns === undefined ? (base.maxTurns ?? null) : turns,
    // Набор инструментов из UI не правится (его нет в RoleEditable), так что
    // у роли без пакета сохранение — единственный его источник. Роль,
    // отвязанная от нашего пакета, набор пакета берёт по-прежнему из него:
    // это единственное, что она от пакета ещё получает, и терять выданную
    // ролью оболочку из-за отвязки незачем.
    tools: pkg?.manifest.runtime.tools
      ? [...pkg.manifest.runtime.tools]
      : (Array.isArray(raw.tools)
        ? raw.tools.filter((t): t is string => typeof t === 'string')
        : base.tools),
    ...(Array.isArray(raw.mcp)
      ? { mcp: raw.mcp.filter((m): m is string => typeof m === 'string') }
      : (pkg ? { mcp: [...pkg.manifest.runtime.mcp] } : {})),
    docsDir: text(raw.docsDir) ?? pkg?.manifest.docsDir ?? base.docsDir,
    // Пустой repoDir — законное «общий репозиторий офиса», а не пропуск.
    repoDir: typeof raw.repoDir === 'string' ? raw.repoDir : base.repoDir,
    // Пустой спрайт — тоже законное значение: «подбери по id роли».
    sprite: typeof raw.sprite === 'string' ? raw.sprite : base.sprite,
    archived,
    brief: typeof raw.brief === 'string' ? raw.brief : base.brief,
    // Ссылка на пропавший пакет остаётся: вернётся пакет — вернётся и связь.
    ...(savedLink ? { package: savedLink } : {}),
  };
}

/**
 * Причесать набор ролей офиса из сохранения. Роль без id восстанавливать не из
 * чего — выкидываем её целиком; второй записи с тем же id быть не может, иначе
 * половина офиса работала бы по одной роли, половина по другой.
 */
function sanitizeRoles(raw: unknown, lang: Lang): Role[] {
  const clean: Role[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const role = item as Partial<Role>;
    const id = typeof role.id === 'string' ? role.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    clean.push(sanitizeRole(role, id, lang));
  }
  return clean;
}

/**
 * Набор ролей офиса из сохранения. Новый формат хранит роли целиком. В
 * сохранениях до переезда ролей в офис их нет — есть только правки поверх
 * базового набора: накладываем их на умолчания, иначе выставленные человеком
 * модель, лимит и репозиторий пропали бы при первом же запуске.
 */
function rolesFromSave(data: Persisted, lang: Lang): Role[] {
  const stored = Array.isArray(data.roles)
    ? data.roles
    : rolesFromOverrides(data.roleOverrides, lang);
  return withManagerRole(sanitizeRoles(stored, lang), lang);
}

/**
 * Причесать оверрайды расстановки из сохранения. Файл состояния правят руками,
 * а испорченная координата уехала бы прямо в рендер и в сетку проходимости:
 * непригодные правки выкидываем поштучно, а не теряем всю расстановку.
 */
function sanitizeOverrides(raw: Record<string, LayoutOverride> | undefined): Record<string, LayoutOverride> {
  const clean: Record<string, LayoutOverride> = {};
  for (const [layoutId, override] of Object.entries(raw ?? {})) {
    const props = (override?.props ?? []).filter((p) => {
      if (!p || typeof p.key !== 'string' || !p.key) return false;
      if (p.at !== undefined && !(Array.isArray(p.at) && p.at.length === 2 && p.at.every(Number.isFinite))) {
        return false;
      }
      return p.scale === undefined || Number.isFinite(p.scale);
    });
    if (props.length) clean[layoutId] = { version: 1, props };
  }
  return clean;
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

/**
 * Подпись сотрудника в офисе — его имя, а без имени название роли. Номер
 * приписывается только второму и следующим в одной роли: у новых офисов
 * сотрудник в роли один, а такие пары остались в сохранениях времён клонов,
 * и одинаковых подписей в комнате быть не должно.
 */
const labelFor = (name: string | null, title: string, n: number | string): string =>
  name ?? (Number(n) > 1 ? `${title} #${n}` : title);

/** Порядковый номер сотрудника в роли — из его id (`backend#2` → 2). */
const numberOf = (id: string): string => id.split('#')[1] ?? '1';

/**
 * Имя из формы в имя для хранения: обрезано, пробелы внутри схлопнуты,
 * пустое — null (имени нет). Длину и занятость проверяет `setAgentName`.
 */
const cleanName = (raw: string): string | null => {
  const name = raw.replace(/\s+/g, ' ').trim();
  return name ? name : null;
};

export interface Instance {
  id: string;
  roleId: string;
  /** id сессии Agent SDK — чтобы продолжить разговор после перезапуска. */
  sessionId: string | null;
  /** См. `InstanceView.label`: имя, а без него роль с номером. */
  label: string;
  /** Имя от владельца; null — зовётся по роли. */
  name: string | null;
  desk: Desk;
  /** Места в текущей раскладке не хватило — см. `InstanceView.deskless`. */
  deskless: boolean;
  state: AgentState;
  currentTaskId: string | null;
  note: string | null;
  usage: Usage;
  /** Расход по дням: «сколько агент стоил сегодня» без пересчёта всей истории. */
  daily: Record<string, Usage>;
  /**
   * Свой режим доступа этого сотрудника, сильнее режима роли.
   * null — своего нет: работает по режиму роли, а та — по режиму офиса.
   */
  permissionMode: PermissionMode | null;
  abort: AbortController | null;
  /** Контекст последнего вызова модели, токенов — см. `InstanceView.contextTokens`. */
  contextTokens: number;
}

/**
 * Фича в плане офиса. Живёт на доске, а не в памяти менеджера: сессия PM
 * перезапускается (сменили роли, упала, перезапустили сервер), и план,
 * который знал только он, испарялся бы вместе с ней.
 */
export interface Epic {
  id: string;
  title: string;
  goal: string;
  order: number;
  status: EpicStatus;
  approved: boolean;
  /**
   * Кто завёл фичу: человек через менеджера или офис себе — инициатива
   * (docs/design/living-office/spec.md §7.2). Инициатива подчиняется тем же
   * правилам фокуса и конвейера; отличается тем, кто её одобряет и что она
   * считается в долю расхода на своё.
   */
  origin: 'owner' | 'office';
  /** Из чего инициатива выведена — читает человек в плане. Пусто у фич владельца. */
  rationale: string;
  /** Направление владельца, по которому заведена. null — вне направлений. */
  directionId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /**
   * Когда офис в последний раз говорил про эту фичу менеджеру. Как и у задач:
   * иначе про фичу, ждущую согласия, напоминалось бы каждую минуту.
   */
  attention: number | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  criteria: Criterion[];
  roleId: string | null;
  assigneeId: string | null;
  status: TaskStatus;
  epicId: string | null;
  order: number;
  /**
   * Важность задачи. Не путать с `order`: порядок — это место внутри фичи,
   * а приоритет говорит, насколько работа важна сама по себе. В сохранениях
   * старше приоритета поля нет — там подставляется средний (migrateTask).
   */
  priority: TaskPriority;
  dependsOn: string[];
  result: string | null;
  files: string[];
  branch: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  /** Репозиторий, в котором выполнялась задача: у ролей они могут отличаться. */
  repoDir: string | null;
  merged: boolean;
  /**
   * Сессии исполнителя и ревьюера этой задачи — чтобы доработка и повторное
   * ревью продолжали тот же разговор через `resume`, а не платили за
   * пересборку контекста заново на каждом круге. Не для вьюхи (см. toTaskView).
   */
  workerSessionId: string | null;
  reviewerSessionId: string | null;
  /**
   * Работу оборвал перезапуск сервера, а не человек. Отличать обязательно:
   * остановленную человеком задачу возобновлять нельзя, а прибитую
   * перезапуском — нужно, и делать это должен офис, а не пользователь.
   */
  interrupted: boolean;
  /**
   * Исполнитель упёрся в лимит плана подписки — когда. Ветка и рабочая копия
   * остаются на месте: после сброса окна офис продолжит ту же сессию, а не
   * начнёт задачу заново. null — стоит не по лимиту.
   */
  limitedAt: number | null;
  /**
   * Почему задача ждёт окружения: готовый к показу текст красной критичной
   * предполётной проверки. Пока поле заполнено, задачу не запускали и денег на
   * неё не тратили — она лежит в backlog. Снимается само, когда проверки
   * зеленеют. null — окружение задаче не мешает.
   */
  envWait: string | null;
  /**
   * Когда офис в последний раз показывал эту задачу менеджеру, потому что она
   * стоит. Нужно, чтобы не рассказывать про одно и то же на каждом проходе.
   */
  attention: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  usage: Usage;
  /**
   * Расход задачи по дням, ключ — 'ГГГГ-ММ-ДД'. Как у агента: задача живёт
   * дольше суток, и без журнала «сколько ушло на неё сегодня» не ответить.
   * В сохранениях, сделанных до доски расходов, поля нет — там пустой журнал,
   * и придумывать ему дни офис не станет.
   */
  daily: Record<string, Usage>;
  /** Чем задача кончилась. Ставится один раз при закрытии (outcomes.ts). */
  outcome: TaskOutcome | null;
  /**
   * Ревизия базовой ветки сразу после слияния. По ней надзор замечает откат:
   * пропала из истории базы — работу выбросили руками. null — не сливали.
   */
  mergeCommit: string | null;
  /**
   * Тип работы — по нему после сдачи выбирается процесс
   * (docs/design/workflows/spec.md §7.2). Ставит менеджер; нет — по роли.
   */
  type: TaskType | null;
  /** Записка при передаче (§4): что сделано, что решил сам, что не сделано. */
  handoff: Handoff | null;
  /**
   * Сколько раз сессия исполнителя сжимала контекст на этой задаче. Живёт на
   * задаче, а не на сессии: сессия умирает вместе с процессом, а вопрос
   * «эта задача буксует на автосжатии» остаётся и после перезапуска.
   */
  compactions: number;
  /** Когда сжимала в последний раз. null — не сжимала ни разу. */
  compactedAt: number | null;
  /**
   * Что разбор завалов решил про повисшую ветку: слить или удалить. Метка и
   * ничего больше — веток офис сам не сливает и не удаляет.
   */
  branchMark: BranchMark | null;
  /** Когда пометил. null — не помечена. */
  branchMarkAt: number | null;
}

interface Pending {
  request: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

/**
 * Жизнь офиса поверх доски: то, что он помнит о себе между сессиями
 * (docs/design/living-office/spec.md). Планёрка — единственный ритуал,
 * который смотрит вперёд: показывается при первом открытии офиса за день.
 */
export interface LifeState {
  /** День последней планёрки, 'ГГГГ-ММ-ДД', и её момент. */
  standupDay: string | null;
  standupAt: number | null;
  /** Когда каждый ритуал шёл последний раз. */
  lastRun: Partial<Record<RitualId, number>>;
  /** Портфель ритуалов — то, что офис подкручивает в себе сам (§8.2). */
  policy: RitualPolicy;
  /** Последние прогоны, свежие в конце. Обрезается — см. RUNS_KEPT. */
  runs: RitualRun[];
  /** Итог последней рефлексии и когда она была — для планёрки (§5.5). */
  reflection: string | null;
  reflectionAt: number | null;
  /** Сколько раз за неделю ритуалы откладывались из-за лимита — для портфеля (§8.2). */
  deferrals: number;
  /** Память процессов по состоянию (spec процессов §6.2), ключ — id процесса. */
  flows: Record<string, FlowMemory>;
}

export const emptyLife = (): LifeState => ({
  standupDay: null, standupAt: null, lastRun: {}, policy: { ...DEFAULT_RITUAL_POLICY }, runs: [],
  reflection: null, reflectionAt: null, deferrals: 0, flows: {},
});

/** Сколько прогонов ритуалов помним: портфелю хватает нескольких недель. */
const RUNS_KEPT = 60;

/**
 * Запись журнала на сервере: то же, что видит клиент, плюс отметка «об этой
 * записи уже спрашивали» — чтобы протухшее решение не превращалось в вопрос
 * каждую неделю.
 */
export interface Fact extends FactView {
  askedAt: number | null;
}

/** Сколько ждём ответа пользователя, прежде чем отказать. */
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Сколько черновик реплики живёт без единого признака жизни от сессии.
 * С запасом: ход менеджера может простоять на модалке разрешения, и снимать
 * «печатает…» раньше значило бы врать в обратную сторону.
 */
const DRAFT_IDLE_MS = 10 * 60 * 1000;

export class OfficeState {
  instances = new Map<string, Instance>();
  tasks = new Map<string, Task>();
  /** План офиса: фичи по id. Порядок держится полем `order`, а не вставкой. */
  epics = new Map<string, Epic>();
  chat: ChatEntry[] = [];
  /**
   * Кто сейчас пишет ответ и что успел наговорить. Ключ — ветка разговора,
   * черновик в ней ровно один. На диск не идёт: после перезапуска писать
   * некому (см. `ChatDraft`).
   */
  drafts = new Map<string, ChatDraft>();
  /** Сторожевые таймеры черновиков, ключ тот же — ветка (см. `armDraft`). */
  private draftTimers = new Map<string, NodeJS.Timeout>();
  log: LogEntry[] = [];
  busy = false;
  projectDir = '';
  /** Доступна ли изоляция через worktree (рабочая директория — git-репозиторий). */
  gitReady = false;
  /** Режим проверки поведения PM: исполнители заглушены, задачи закрываются мгновенно. */
  dryRun = false;
  meeting: MeetingView | null = null;
  /**
   * История совещаний, старые первыми. Реплики лежат в чате (ветка `meeting`,
   * `ChatEntry.meetingId`), здесь — тема, участники, статус и время: то, по
   * чему совещание находят в списке, когда оно давно закончилось.
   */
  meetings: MeetingView[] = [];
  settings: Settings = { ...DEFAULT_SETTINGS, language: startupLang() };
  authSource: AuthSource = 'unknown';
  /** Чей это офис: от него зависят worktree и файл состояния. */
  readonly officeId: string;
  /**
   * Набор ролей этого офиса — целиком, а не правками поверх общего реестра.
   * Живёт в самом офисе и сохраняется вместе с его состоянием: офисов в
   * памяти несколько, они работают одновременно, и ни модель роли, ни сама
   * роль одного проекта не должны попадать в другой. Общего на процесс
   * реестра ролей нет вовсе — офис у любой роли спрашивают явно.
   */
  // Роли заводятся на языке офиса: бриф уезжает в системный промпт, и
  // русский бриф в английском офисе означал бы агента, который отвечает
  // не на том языке, на котором с ним говорят.
  private roleList: Role[] = defaultRoles(startupLang());
  /**
   * Расстановка мебели этого офиса поверх пресетов, ключ — id пресета (§8).
   * Своя у каждого офиса: пресет — общий эталон в репозитории, а подвинутый
   * стол — дело того офиса, где его подвинули.
   */
  layoutOverrides: Record<string, LayoutOverride> = {};
  /**
   * Что известно о внешних MCP-серверах, по id сервера. Живёт в памяти: это
   * наблюдение живых сессий, а не настройка офиса.
   */
  private mcpState = new Map<string, McpServerState>();
  /**
   * Поднимали ли уже это состояние с диска. Пустая заготовка (её заводит
   * первое обращение к getOffice) от открытого офиса отличается именно этим:
   * заготовку надо восстановить, открытый офис — переиспользовать как есть.
   */
  opened = false;
  /**
   * Офис выгружен из памяти и больше не говорит: ни записи в свой файл, ни
   * событий зрителям (см. retire). Ссылки на выгруженное состояние живут
   * дольше него — их держат догорающие сессии SDK, — и без этого признака их
   * поздние сообщения писали бы в файл, который ведёт уже другое состояние.
   */
  private retired = false;
  /**
   * Файл состояния этого офиса. Хранится здесь, а не в store.ts: сохранение
   * привязано к офису, а не к процессу, поэтому два офиса не делят ни путь,
   * ни таймер записи.
   */
  private stateFile = DEFAULT_STATE_FILE;
  /** Готовность облачного режима. Ключ и токен в состояние не пишутся. */
  cloud: CloudStatus = { hasKey: false, hasToken: false };
  /**
   * Проверки окружения (envcheck.ts): ключ модели, рабочая директория, git,
   * состав офиса. На диск не сохраняются — окружение меняется мимо офиса, и
   * поднятый из файла ответ врал бы с уверенным видом. Пустой список значит
   * «ещё не считали», а не «всё хорошо».
   */
  env: EnvReport = { checks: [], at: 0 };
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
   * Пулл-реквесты конвейера ревью, ключ — id задачи: у задачи он ровно один,
   * и все стадии (синхронизация, ревью, слияние) пишутся в него же.
   * Сохраняются на диск: конвейер длится минутами, а перезапуск сервера
   * не должен превращать открытый пулл-реквест в потерянную ветку.
   */
  prs = new Map<string, PullRequestView>();
  /** Прогоны процессов по задачам, ключ — id прогона (docs/design/workflows/spec.md §8). */
  runs = new Map<string, Run>();
  /**
   * Пауза офиса: новая работа не запускается, а живые сессии замирают
   * на следующем вызове инструмента. Сохраняется — в реестре офисов
   * (`OfficeEntry.paused`), а не в файле состояния: пауза относится к офису,
   * а не к сессиям, и офис, оставленный на паузе, после перезапуска сервера
   * обязан остаться на паузе, а не начать раздавать задачи.
   */
  paused = false;
  /**
   * Живая сессия менеджера этого офиса: очередь сообщений и цикл её чтения.
   * Принадлежат офису, а не процессу: иначе второй открытый офис не поднял бы
   * своего PM (цикл уже не пуст), а сообщения ушли бы в чужую очередь.
   */
  pmQueue: MessageQueue | null = null;
  pmLoop: Promise<void> | null = null;
  /**
   * Сколько ходов менеджера сейчас в работе. Считаем их, а не смотрим на
   * состояние сотрудника: сообщений в очередь могло лечь несколько (реплика
   * пользователя и следом уведомление о закрытой задаче), результат придёт на
   * каждое, и «печатает…» снимает только последний.
   */
  pmTurns = 0;
  /**
   * Сессия менеджера ужимает память по порогу контекста (см.
   * `Settings.pmContextLimit`): обычно командой /compact в той же сессии, а
   * если сжатие не удалось — передачей дел и закрытием (`pmRotationKind`).
   * Пока это идёт, новые сообщения ей не отдают, а копят в `pmPending`:
   * команда из очереди обрабатывается только между ходами, и реплика,
   * вставшая перед ней, снова разогнала бы контекст.
   */
  pmRotating = false;
  pmRotationKind: 'compact' | 'handoff' = 'compact';
  pmPending: { text: string; fromUser: boolean }[] = [];
  /**
   * Контекст на момент запроса сжатия: сам ход с ним перепишет цифру, а
   * пользователю сообщают, до чего сессия доросла, а не сколько стоил её
   * последний ход.
   */
  pmRotatingFrom = 0;
  /** Сколько осталось после сжатия; null — граница сжатия ещё не пришла. */
  pmCompactedTo: number | null = null;
  /**
   * Что менеджер помнил на момент последнего сжатия (или передача дел
   * закрытой сессии). Нужна только новой сессии: продолжаемая несёт то же
   * в своей стенограмме.
   */
  pmHandoff: string | null = null;
  /**
   * Задачи, которые пользователь остановил вручную — чтобы отличить это от
   * падения. Ключ — id задачи, а он уникален только внутри офиса.
   */
  stoppedByUser = new Set<string>();
  /**
   * Задачи, которые сняли прямо во время работы: исполнителя прерывают так
   * же, как остановкой, но задача после этого не ждёт перезапуска, а
   * закрывается снятой. Отдельно от `stoppedByUser` именно поэтому — конец
   * у них разный.
   */
  cancelledByUser = new Set<string>();
  /**
   * Сотрудники, чью сессию SDK только что отбил по лимиту плана. Ставится
   * при разборе событий сессии, снимается тем, кто разбирает её конец:
   * по одному тексту ошибки лимит от прочих бед не отличить.
   */
  limitHits = new Set<string>();
  /**
   * Сколько сессий исполнителей этого офиса живы прямо сейчас. Счётчик офисный,
   * а не процессный: по нему гаснет индикатор занятости, и чужие задачи держали
   * бы его зажжённым в офисе, где никто не работает.
   */
  running = 0;
  /**
   * Задачи, которые упёрлись в лимит одновременных исполнителей и ждут слота.
   * Только в памяти и намеренно: после перезапуска они снова просто стоят
   * в очереди на доске, и разбирается с ними надзор — сохранять «ждала слота»
   * значило бы обещать очередь, которой уже нет.
   */
  waitingForSlot = new Set<string>();
  /**
   * Живые прямые разговоры пользователя с исполнителями этого офиса.
   * Ключ — instanceId, а он уникален только внутри офиса: в соседнем офисе
   * сидит свой backend#1 со своей сессией.
   */
  talks = new Map<string, { queue: MessageQueue; loop: Promise<void> }>();
  /** Сколько раз спрашивали коллег по каждой задаче — лимит считается по офису. */
  consultsByTask = new Map<string, number>();
  /** Идёт ли совещание в этом офисе: в соседнем своё и мешать не должно. */
  meetingRunning = false;
  /** Расход офиса за всё время — считается отдельно, чтобы увольнение клона не обнуляло сумму. */
  usage: Usage = emptyUsage();
  /** Расход офиса по дням. */
  daily: Record<string, Usage> = {};
  /** Планёрки, журнал и прочая жизнь офиса поверх доски. */
  life: LifeState = emptyLife();
  /** Журнал офиса: записи по id (§4). */
  facts = new Map<string, Fact>();
  /** Вопросы владельцу по id (§6). */
  questions = new Map<string, OwnerQuestion>();
  /**
   * Когда в офисе последний раз шла работа: задача менялась, кто-то писал,
   * тратились токены. По этому «тихий тик» отличается от занятого: ритуалы
   * идут, когда офис молчит. В памяти, а не на диске: после перезапуска
   * тишина начинается заново.
   */
  lastWorkAt = Date.now();
  /** Ритуал, который идёт прямо сейчас. Второй поверх него не запускается. */
  ritualRunning: RitualId | null = null;
  /** Сколько вопросов владельцу задано по каждой задаче — лимит, как у коллег. */
  questionsByTask = new Map<string, number>();
  /** Направления владельца по id (§7.1). Встроенное есть всегда. */
  directions = new Map<string, Direction>();
  /** Предложения офиса по id (§8.1). */
  proposals = new Map<string, Proposal>();
  private factSeq = 0;
  private questionSeq = 0;
  /** Кто ждёт закрытия вопроса: узлы согласования процессов. */
  private questionWaiters = new Map<string, Set<() => void>>();
  private directionSeq = 0;
  private proposalSeq = 0;
  /** Кого разбудить, когда паузу снимут. */
  private resumeWaiters = new Set<() => void>();
  private listeners = new Set<Listener>();
  private taskSeq = 0;
  private epicSeq = 0;
  private permSeq = 0;
  private pending = new Map<string, Pending>();
  /** Ключи вида «roleId:Bash:rm», разрешённые пользователем до конца сессии. */
  private alwaysAllowed = new Set<string>();
  /** Те же ключи, но запрещённые: симметрично «разрешить всегда». */
  private alwaysDenied = new Set<string>();

  constructor(officeId: string) {
    this.officeId = officeId;
  }

  // ---------- роли этого офиса ----------

  /**
   * Роли этого офиса. Копия списка, а не он сам: набор меняется только через
   * updateRole, и случайная правка на стороне вызывающего не должна тихо
   * менять состав офиса.
   */
  roles(): Role[] {
    return [...this.roleList];
  }

  /**
   * Роль офиса по id — включая архивную. undefined — такой роли в этом офисе
   * нет. Архив специально не прячется: roleId лежит в задачах, логах и
   * сохранённых сотрудниках, и история обязана читаться после архивации.
   */
  role(id: string): Role | undefined {
    return this.roleList.find((r) => r.id === id);
  }

  /**
   * Подпись сотрудника для git: имя владельца и роль с номером в скобках —
   * «Денис (Backend #2)», а без имени просто «Backend #2». Почта — из id
   * сотрудника, она не меняется при переименовании, и хостинг рисует одному
   * сотруднику один и тот же значок. Нет такого сотрудника (уволен, id пуст) —
   * подписывает сам офис.
   */
  gitPerson(instanceId: string | null | undefined): GitPerson {
    const inst = instanceId ? this.instances.get(instanceId) : undefined;
    if (!inst) return OFFICE_PERSON;
    const byRole = labelFor(null, this.role(inst.roleId)?.title ?? inst.roleId, numberOf(inst.id));
    return {
      name: inst.name ? `${inst.name} (${byRole})` : byRole,
      // В подписи git запрещены только «<», «>» и перевод строки; «#» и пробелы
      // в почте выглядят чужеродно, остальное (в том числе кириллица) оставляем.
      email: `${inst.id.replace(/[\s#<>@]+/g, '-')}@local`,
    };
  }

  /** Менеджер офиса — тот, кто подписывает слияния, когда ревьюера не было. */
  managerId(): string | null {
    for (const inst of this.instances.values()) {
      if (this.role(inst.roleId)?.isManager) return inst.id;
    }
    return null;
  }

  /** Роли, с которыми офис работает сейчас: весь набор, кроме архива. */
  activeRoles(): Role[] {
    return this.roleList.filter((r) => !r.archived);
  }

  /**
   * Роли, которым можно отдать задачу: рабочие, кроме менеджера. Архивных
   * здесь нет — именно из этого перечня собираются описание assign у PM и
   * список для найма, и предлагать уволенную роль незачем.
   */
  workerRoles(): Role[] {
    return this.roleList.filter((r) => !r.isManager && !r.archived);
  }

  /**
   * Потолок ходов сессии этой роли: свой лимит роли сильнее офисного,
   * null — без ограничения. Одна функция и на показ в UI, и на запуск сессии,
   * чтобы человек видел ровно то число, которое уедет в SDK.
   */
  turnsFor(role: Pick<Role, 'maxTurns'>): number | null {
    return role.maxTurns ?? this.settings.taskMaxTurns ?? null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ServerEvent): void {
    // Выгруженный офис молчит: его событие ушло бы зрителям офиса с тем же
    // id — то есть в ленту нового состояния, поднятого при возврате.
    if (this.retired) return;
    for (const fn of this.listeners) fn(e);
  }

  /** Пометить состояние изменившимся — запись на диск идёт с дебаунсом. */
  private markDirty(): void {
    // Выгруженный офис в свой файл больше не пишет: файлом распоряжается
    // состояние, поднятое после него, и старый снимок затёр бы его доску.
    if (this.retired) return;
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

  /**
   * Проводить состояние из памяти: дописать хвост отложенной записи и дальше
   * молчать — ни в файл, ни зрителям.
   *
   * Выгрузка не обрывает ссылки на состояние: abort у сессии кооперативный,
   * и поток SDK успевает принести ещё несколько сообщений — id сессии, расход,
   * реплику в чат. Каждое из них звало бы markDirty у уже выгруженного офиса,
   * а файл к тому времени ведёт другое состояние, поднятое при возврате:
   * чей снимок лёг в отложенную запись последним, тот и оказывался на диске,
   * и доска с чатом вернувшегося офиса пропадали через раз.
   */
  retire(): void {
    // Дописываем только у поднятого: у пустой заготовки файл ещё общий по
    // умолчанию, и запись ушла бы в чужое состояние.
    if (this.opened) flushFile(this.stateFile);
    this.retired = true;
    this.opened = false;
  }

  /** Стереть сохранение этого офиса вместе с отложенной записью. */
  wipe(): void {
    wipeFile(this.stateFile);
  }

  /**
   * Закрыть живые сессии офиса: менеджера, прямые разговоры и исполнителей.
   * Одна точка на все причины (сброс доски по кнопке и выгрузка офиса из
   * памяти) — разойдясь, они оставляли бы за собой то очередь менеджера,
   * то незакрытый разговор, а тот держит сессию SDK живой.
   *
   * Задачи и доску не трогает: это про живые разговоры, а не про работу.
   */
  closeSessions(): void {
    this.pmQueue?.close();
    this.pmQueue = null;
    this.pmLoop = null;
    // Сессии нет — некому и дописывать передачу дел, а накопленное за это
    // время адресовалось разговору, которого больше нет.
    this.pmRotating = false;
    this.pmCompactedTo = null;
    this.pmPending = [];
    // Живых сессий больше нет — значит и «печатает…» ни за кем не стоит.
    this.pmTurns = 0;
    for (const thread of [...this.drafts.keys()]) this.endDraft(thread, 'error');
    for (const [id, talk] of this.talks) {
      talk.queue.close();
      this.talks.delete(id);
    }
    for (const inst of this.instances.values()) inst.abort?.abort();
    this.stoppedByUser.clear();
    this.cancelledByUser.clear();
    this.limitHits.clear();
    // Очередь за слотом — это обещание запустить задачу, а сессий больше нет:
    // держать её значило бы ждать освобождения того, что уже освобождено.
    this.waitingForSlot.clear();
    this.meetingRunning = false;
  }

  toPersisted(): Persisted {
    return {
      version: 1,
      projectDir: this.projectDir,
      taskSeq: this.taskSeq,
      tasks: [...this.tasks.values()],
      epics: [...this.epics.values()],
      epicSeq: this.epicSeq,
      prs: [...this.prs.values()],
      runs: [...this.runs.values()],
      chat: this.chat,
      log: this.log.slice(-500),
      meetings: this.meetings,
      settings: this.settings,
      roles: this.roleList,
      layoutOverrides: this.layoutOverrides,
      instances: [...this.instances.values()].map<PersistedInstance>((i) => ({
        id: i.id, roleId: i.roleId, deskIndex: i.desk.index,
        usage: i.usage, daily: i.daily, sessionId: i.sessionId,
        permissionMode: i.permissionMode,
        name: i.name,
        contextTokens: i.contextTokens,
      })),
      pmHandoff: this.pmHandoff,
      usage: this.usage,
      daily: this.daily,
      life: this.life,
      facts: [...this.facts.values()],
      factSeq: this.factSeq,
      questions: [...this.questions.values()],
      questionSeq: this.questionSeq,
      directions: [...this.directions.values()],
      directionSeq: this.directionSeq,
      proposals: [...this.proposals.values()],
      proposalSeq: this.proposalSeq,
      savedAt: Date.now(),
    };
  }

  // ---------- живой офис: журнал, вопросы, ритуалы ----------

  /** Записи журнала в порядке заведения. */
  factList(): Fact[] {
    return [...this.facts.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  addFact(input: {
    kind: FactView['kind']; text: string; scope: string; source?: FactView['source'];
  }): Fact {
    this.factSeq += 1;
    const now = Date.now();
    const fact: Fact = {
      id: `J-${this.factSeq}`,
      kind: input.kind,
      text: input.text.trim(),
      scope: input.scope,
      source: input.source ?? {},
      createdAt: now,
      confirmedAt: now,
      status: 'live',
      askedAt: null,
    };
    this.facts.set(fact.id, fact);
    this.emit({ t: 'fact', fact: toFactView(fact) });
    this.markDirty();
    return fact;
  }

  updateFact(id: string, patch: Partial<Fact>): Fact | null {
    const fact = this.facts.get(id);
    if (!fact) return null;
    Object.assign(fact, patch);
    this.emit({ t: 'fact', fact: toFactView(fact) });
    this.markDirty();
    return fact;
  }

  removeFact(id: string): void {
    if (!this.facts.delete(id)) return;
    this.emit({ t: 'fact.remove', id });
    this.markDirty();
  }

  /** Вопросы владельцу в порядке заведения. */
  questionList(): OwnerQuestion[] {
    return [...this.questions.values()].sort((a, b) => a.askedAt - b.askedAt);
  }

  /**
   * Сколько вопросов ждут владельца. Признак тот же, что у отбора в планёрку
   * (`isOpenQuestion`), — иначе значок и планёрка считали бы по-разному.
   */
  openQuestionCount(): number {
    let n = 0;
    for (const q of this.questions.values()) if (isOpenQuestion(q)) n += 1;
    return n;
  }

  addQuestion(input: {
    from: string; taskId: string | null; kind: OwnerQuestion['kind']; text: string; assumption: string;
    options?: string[];
  }): OwnerQuestion {
    this.questionSeq += 1;
    // Вариантов либо нет вовсе, либо их больше одного: один вариант — не выбор.
    const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean);
    const question: OwnerQuestion = {
      id: `Q-${this.questionSeq}`,
      from: input.from,
      taskId: input.taskId,
      kind: input.kind,
      text: input.text.trim(),
      assumption: input.assumption.trim(),
      ...(options.length > 1 ? { options } : {}),
      askedAt: Date.now(),
      shownAt: null,
      answer: null,
      answeredAt: null,
      dismissedAt: null,
    };
    this.questions.set(question.id, question);
    this.emit({ t: 'question', question, openQuestions: this.openQuestionCount() });
    this.markDirty();
    return question;
  }

  updateQuestion(id: string, patch: Partial<OwnerQuestion>): OwnerQuestion | null {
    const question = this.questions.get(id);
    if (!question) return null;
    Object.assign(question, patch);
    this.emit({ t: 'question', question, openQuestions: this.openQuestionCount() });
    this.markDirty();
    if (question.answeredAt || question.dismissedAt) {
      for (const wake of this.questionWaiters.get(id) ?? []) wake();
      this.questionWaiters.delete(id);
    }
    return question;
  }

  /**
   * Дождаться ответа или снятия вопроса. Закрытый вопрос возвращается сразу.
   * Нужно узлам согласования: прогон стоит и ничего не тратит, пока
   * владелец не скажет «да» или «нет».
   */
  whenQuestionClosed(id: string, signal?: AbortSignal): Promise<OwnerQuestion | null> {
    const question = this.questions.get(id);
    if (!question) return Promise.resolve(null);
    if (question.answeredAt || question.dismissedAt || signal?.aborted) return Promise.resolve(question);
    return new Promise((resolve) => {
      const wake = () => {
        this.questionWaiters.get(id)?.delete(wake);
        resolve(this.questions.get(id) ?? null);
      };
      const set = this.questionWaiters.get(id) ?? new Set<() => void>();
      set.add(wake);
      this.questionWaiters.set(id, set);
      signal?.addEventListener('abort', wake, { once: true });
    });
  }

  /** Жизнь офиса глазами клиента: планёрка, прогоны, портфель. */
  lifeView(): LifeView {
    return {
      standupDay: this.life.standupDay,
      standupAt: this.life.standupAt,
      lastRun: { ...this.life.lastRun },
      policy: { ...this.life.policy },
      flows: this.life.flows,
      runs: [...this.life.runs],
      running: this.ritualRunning,
    };
  }

  /** Разослать жизнь офиса: ритуал начался, кончился, портфель подкрутили. */
  emitLife(): void {
    this.emit({ t: 'life', life: this.lifeView() });
  }

  /** Записать прогон ритуала и его момент. */
  noteRitualRun(run: Omit<RitualRun, 'id'>): RitualRun {
    const full: RitualRun = { ...run, id: `R-${run.at.toString(36)}-${run.ritual}` };
    this.life.runs.push(full);
    if (this.life.runs.length > RUNS_KEPT) this.life.runs.splice(0, this.life.runs.length - RUNS_KEPT);
    this.life.lastRun[run.ritual] = run.at;
    this.markDirty();
    this.emitLife();
    return full;
  }

  /** Подкрутить портфель ритуалов — офис делает это сам (§8.2). */
  setPolicy(patch: Partial<RitualPolicy>): void {
    this.life.policy = { ...this.life.policy, ...patch };
    this.markDirty();
    this.emitLife();
  }

  /** Порог лимита подписки для ритуалов — с подстраховкой для старых сохранений. */
  ritualLimit(): number {
    return sanitizeRitualLimit(this.settings.ritualLimitThreshold) ?? DEFAULT_RITUAL_LIMIT;
  }

  /** В офисе шла работа: сбросить тишину, по которой идут ритуалы. */
  noteWork(): void {
    this.lastWorkAt = Date.now();
  }

  // ---------- направления и предложения ----------

  initiativeMode(): InitiativeMode {
    return isInitiativeMode(this.settings.initiativeMode) ? this.settings.initiativeMode : DEFAULT_INITIATIVE_MODE;
  }

  initiativeShare(): number {
    return sanitizeShare(this.settings.initiativeShare) ?? DEFAULT_INITIATIVE_SHARE;
  }

  /** Направления по важности; встроенное — последним. */
  directionList(): Direction[] {
    return [...this.directions.values()]
      .sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.priority - b.priority || a.createdAt - b.createdAt);
  }

  /**
   * Встроенное направление есть у каждого офиса (§7.1): без него офису
   * нечего делать, когда владелец ничего не дал, а красные проверки не
   * ждут, пока кто-то догадается их назвать направлением.
   */
  private ensureBuiltinDirection(): void {
    if (this.directions.has(HEALTH_DIRECTION)) return;
    this.directions.set(HEALTH_DIRECTION, {
      id: HEALTH_DIRECTION, text: this.say('direction.health'), priority: 1000,
      active: true, builtin: true, createdAt: Date.now(),
    });
  }

  /** Завести направление. Возвращает причину отказа готовым текстом или null. */
  createDirection(text: string): string | null {
    const clean = String(text ?? '').trim();
    if (!clean) return this.say('direction.empty');
    const own = [...this.directions.values()].filter((d) => !d.builtin);
    if (own.length >= MAX_DIRECTIONS) {
      return this.say('direction.tooMany', { n: own.length, max: MAX_DIRECTIONS });
    }
    this.directionSeq += 1;
    const direction: Direction = {
      id: `D-${this.directionSeq}`, text: clean, priority: own.length + 1,
      active: true, builtin: false, createdAt: Date.now(),
    };
    this.directions.set(direction.id, direction);
    this.emit({ t: 'direction', direction });
    this.addLog(null, 'system', this.say('direction.createdLog', { id: direction.id, text: clean }));
    this.markDirty();
    // Направления вшиты в бриф менеджера — как и перечень ролей.
    roleSetWatcher?.(this);
    return null;
  }

  updateDirection(id: string, patch: Partial<Pick<Direction, 'text' | 'active' | 'priority'>>): string | null {
    const direction = this.directions.get(id);
    if (!direction) return this.say('direction.noSuch', { id });
    const clean: Partial<Direction> = {};
    if (typeof patch.text === 'string') {
      const text = patch.text.trim();
      if (!text) return this.say('direction.empty');
      // Текст встроенного — не правится: оно одно на все офисы по смыслу.
      if (!direction.builtin) clean.text = text;
    }
    if (typeof patch.active === 'boolean') clean.active = patch.active;
    if (typeof patch.priority === 'number' && Number.isFinite(patch.priority)) clean.priority = Math.floor(patch.priority);
    Object.assign(direction, clean);
    this.emit({ t: 'direction', direction });
    this.addLog(null, 'system', this.say('direction.updatedLog', { id }));
    this.markDirty();
    roleSetWatcher?.(this);
    return null;
  }

  removeDirection(id: string): string | null {
    const direction = this.directions.get(id);
    if (!direction) return this.say('direction.noSuch', { id });
    if (direction.builtin) return this.say('direction.builtin', { text: direction.text });
    this.directions.delete(id);
    this.emit({ t: 'direction.remove', id });
    this.addLog(null, 'system', this.say('direction.removedLog', { id }));
    this.markDirty();
    roleSetWatcher?.(this);
    return null;
  }

  proposalList(): Proposal[] {
    return [...this.proposals.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  addProposal(input: Omit<Proposal, 'id' | 'status' | 'createdAt' | 'decidedAt'>): Proposal {
    this.proposalSeq += 1;
    const proposal: Proposal = {
      ...input, id: `P-${this.proposalSeq}`, status: 'pending', createdAt: Date.now(), decidedAt: null,
    };
    this.proposals.set(proposal.id, proposal);
    this.emit({ t: 'proposal', proposal: toProposalView(proposal) });
    this.markDirty();
    return proposal;
  }

  updateProposal(id: string, patch: Partial<Proposal>): Proposal | null {
    const proposal = this.proposals.get(id);
    if (!proposal) return null;
    Object.assign(proposal, patch);
    this.emit({ t: 'proposal', proposal: toProposalView(proposal) });
    this.markDirty();
    return proposal;
  }

  /**
   * Жизнь офиса изменилась (планёрка показана, запись журнала подтверждена).
   * Отдельный метод, а не прямая правка поля: запись на диск идёт с дебаунсом,
   * и о ней надо сказать — иначе планёрка после перезапуска повторилась бы.
   */
  touchLife(patch: Partial<LifeState> = {}): void {
    Object.assign(this.life, patch);
    this.markDirty();
  }

  /** Память процесса по состоянию. Нет — пустая. */
  flowMemory(id: string): FlowMemory {
    return this.life.flows[id] ?? emptyFlowMemory();
  }

  touchFlow(id: string, patch: Partial<FlowMemory>): FlowMemory {
    const next = { ...this.flowMemory(id), ...patch };
    this.life.flows = { ...this.life.flows, [id]: next };
    this.markDirty();
    this.emitLife();
    return next;
  }

  /** Оставить у процесса офиса не больше `keep` последних прогонов. */
  pruneFlowRuns(workflowId: string, keep: number): void {
    const mine = [...this.runs.values()]
      .filter((r) => r.subject.flow === workflowId)
      .sort((a, b) => b.startedAt - a.startedAt);
    for (const old of mine.slice(Math.max(0, keep))) this.runs.delete(old.id);
  }

  /** Показать интерфейсу процессы заново: файл проекта сохранили или убрали. */
  emitWorkflows(): void {
    this.emit({ t: 'workflows', workflows: workflowCatalog(this) });
  }

  /** Последний прогон процесса самого офиса (не по задаче). */
  flowRun(workflowId: string): Run | null {
    let found: Run | null = null;
    for (const run of this.runs.values()) {
      if (run.subject.flow === workflowId && (!found || run.startedAt > found.startedAt)) found = run;
    }
    return found;
  }

  /**
   * Восстановить офис с диска. Возвращает false, если сохранения нет
   * или оно относится к другой рабочей директории.
   */
  restore(): boolean {
    const data = load(this.stateFile);
    if (!data) return false;
    if (data.projectDir !== this.projectDir) {
      console.log(c('state.restore.otherDir'));
      return false;
    }

    // Язык узнаём раньше всего: на нём поднимаются базовые роли, и не зная
    // его, офис поставил бы английские названия рядом с русской перепиской.
    const lang = asLang((data.settings as Partial<Settings> | undefined)?.language ?? 'ru');
    // Роли восстанавливаем ДО seed: от них зависят названия и лимиты инстансов.
    this.roleList = rolesFromSave(data, lang);
    // Сохранения старше настройки движка не знают про облако — дополняем.
    // Язык в них тоже не записан, и подставлять базовый английский нельзя:
    // такой офис заводили до появления настройки, когда офис был русским, —
    // его лог, переписка и брифы ролей написаны по-русски, и английская
    // подпись над русской лентой выглядела бы поломкой, а не выбором.
    // Раскладка в старых сохранениях тоже не записана, и умолчание для новых
    // офисов сюда не годится: заведённый раньше офис должен выглядеть так же,
    // как выглядел, — то есть по classic.
    // Сохранение старше поля отдаёт его как undefined: тип говорит «всегда
    // есть», поэтому для слияния с умолчаниями оно — Partial.
    const saved: Partial<Settings> = data.settings ?? {};
    this.settings = { ...DEFAULT_SETTINGS, language: 'ru', layoutId: FALLBACK_LAYOUT_ID, ...saved };
    // Язык мог приехать из правленого руками файла: чужое значение оставило бы
    // офис без словаря, и каждая фраза выродилась бы в голый ключ.
    this.settings.language = asLang(this.settings.language);
    // Файл раскладки могли удалить между запусками. Офис без мебели — не
    // состояние, в котором его можно оставить: молча возвращаем к classic.
    if (!hasLayout(this.settings.layoutId)) {
      console.log(this.say('state.restore.noLayout', {
        id: this.settings.layoutId, office: this.officeId, fallback: FALLBACK_LAYOUT_ID,
      }));
      this.settings = { ...this.settings, layoutId: FALLBACK_LAYOUT_ID };
    }
    // Файл состояния правят руками: испорченный лимит ходов обрушил бы каждую
    // задачу офиса, поэтому непригодное значение откатываем к умолчанию.
    // null здесь законен («без ограничения»), поэтому отличаем его от undefined.
    const turns = sanitizeMaxTurns(this.settings.taskMaxTurns);
    this.settings.taskMaxTurns = turns === undefined ? DEFAULT_SETTINGS.taskMaxTurns : turns;
    // То же и с лимитом исполнителей: ноль из правленого руками файла означал бы
    // офис, в котором ни одна задача больше не стартует.
    this.settings.maxConcurrentWorkers = sanitizeWorkers(this.settings.maxConcurrentWorkers)
      ?? DEFAULT_SETTINGS.maxConcurrentWorkers;
    // И с числом ведомых фич: ноль означал бы план, который не начнётся.
    this.settings.focusEpics = sanitizeFocus(this.settings.focusEpics) ?? DEFAULT_FOCUS_EPICS;
    // Расстановку поднимаем ДО seed: по итоговой раскладке считаются столы,
    // за которые он сажает сотрудников.
    this.layoutOverrides = sanitizeOverrides(data.layoutOverrides);
    this.seed();
    this.taskSeq = data.taskSeq;
    // План поднимаем ДО задач: задача ссылается на фичу, и разбирать доску
    // проще, когда фичи уже на месте. Сохранения старше плана его не знают —
    // там план пуст, а задачи остаются задачами вне плана.
    for (const epic of data.epics ?? []) {
      // Фичи из сохранений до инициатив — все от владельца: офис тогда
      // ничего себе не ставил.
      this.epics.set(epic.id, {
        ...epic, attention: epic.attention ?? null,
        origin: epic.origin ?? 'owner', rationale: epic.rationale ?? '',
        directionId: epic.directionId ?? null,
      });
    }
    this.life = {
      ...emptyLife(), ...(data.life ?? {}),
      policy: { ...DEFAULT_RITUAL_POLICY, ...(data.life?.policy ?? {}) },
      lastRun: { ...(data.life?.lastRun ?? {}) },
      runs: [...(data.life?.runs ?? [])],
      flows: { ...(data.life?.flows ?? {}) },
    };
    for (const fact of data.facts ?? []) {
      this.facts.set(fact.id, { ...fact, askedAt: fact.askedAt ?? null, status: fact.status ?? 'live' });
    }
    this.factSeq = data.factSeq ?? this.facts.size;
    for (const q of data.questions ?? []) this.questions.set(q.id, { ...q, dismissedAt: q.dismissedAt ?? null });
    this.questionSeq = data.questionSeq ?? this.questions.size;
    for (const d of data.directions ?? []) this.directions.set(d.id, { ...d });
    this.directionSeq = data.directionSeq ?? this.directions.size;
    // Встроенное направление могло не попасть в сохранение старше него.
    this.ensureBuiltinDirection();
    for (const p of data.proposals ?? []) this.proposals.set(p.id, { ...p, plan: p.plan ?? null });
    this.proposalSeq = data.proposalSeq ?? this.proposals.size;
    // Режим и доля инициативы из правленого руками файла: чужой режим
    // означал бы офис, который либо никогда ничего не предлагает, либо
    // начинает всё подряд без спроса.
    if (!isInitiativeMode(this.settings.initiativeMode)) this.settings.initiativeMode = DEFAULT_INITIATIVE_MODE;
    this.settings.initiativeShare = sanitizeShare(this.settings.initiativeShare) ?? DEFAULT_INITIATIVE_SHARE;
    // Порог ритуалов из правленого руками файла: чужое значение либо гоняло
    // бы ритуалы на пустом лимите, либо не давало бы им идти никогда.
    this.settings.ritualLimitThreshold = sanitizeRitualLimit(this.settings.ritualLimitThreshold)
      ?? DEFAULT_RITUAL_LIMIT;
    // Порог контекста менеджера из правленого руками файла: ноль ротировал
    // бы сессию на каждом ходу, а миллиард — никогда.
    this.settings.pmContextLimit = sanitizePmContextLimit(this.settings.pmContextLimit)
      ?? DEFAULT_PM_CONTEXT_LIMIT;
    this.settings.workerContextLimit = sanitizeWorkerContextLimit(this.settings.workerContextLimit)
      ?? DEFAULT_WORKER_CONTEXT_LIMIT;
    this.epicSeq = data.epicSeq ?? this.epics.size;
    // Записи из версий до появления веток чата относим к разговору с менеджером.
    this.chat = (data.chat ?? []).map((c) => ({ ...c, thread: c.thread ?? 'pm#1' }));
    this.log = data.log ?? [];
    // Совещание, застигнутое перезапуском, не продолжится: сессии участников
    // умерли вместе с процессом. Оставить его «идущим» значило бы показывать
    // в окне совещаний живую точку у стенограммы, которая никогда не допишется.
    this.meetings = (data.meetings ?? []).map((m) => (m.status === 'running'
      ? { ...m, status: 'failed', speaking: null, finishedAt: m.finishedAt ?? data.savedAt }
      : m));

    this.usage = { ...emptyUsage(), ...(data.usage ?? {}) };
    this.daily = data.daily ?? {};
    this.pmHandoff = typeof data.pmHandoff === 'string' && data.pmHandoff.trim() ? data.pmHandoff : null;

    for (const raw of data.tasks ?? []) {
      const t = migrateTask(raw);
      // Задачу, прерванную перезапуском, нельзя выдавать за выполненную:
      // сессия исполнителя умерла вместе с процессом.
      if (t.status === 'in_progress' || t.status === 'assigned') {
        t.status = 'blocked';
        // Пометка для надзора: такую задачу офис возобновит сам. Раньше она
        // молча оставалась заблокированной навсегда — сессия умерла вместе
        // с процессом, а сказать об этом было некому.
        t.interrupted = true;
        t.result = (t.result ? `${t.result}\n\n` : '') + this.say('state.task.interrupted');
      }
      this.tasks.set(t.id, t);
    }

    // Конвейер живёт в сессиях, а они умерли вместе с процессом: любой PR,
    // застигнутый перезапуском на ходу, поднимаем как вставший. Врать, что
    // ревью идёт, нельзя — ревьюера уже нет.
    for (const pr of data.prs ?? []) {
      const alive: PrStage[] = ['merged', 'stuck'];
      const known = {
        ...pr,
        retries: pr.retries ?? 0,
        nextTryAt: pr.nextTryAt ?? null,
        needsDecision: pr.needsDecision ?? false,
        gate: pr.gate ?? null,
      };
      this.prs.set(pr.taskId, alive.includes(pr.stage) ? known : {
        ...known,
        stage: 'stuck',
        note: this.say('state.pr.interrupted'),
        updatedAt: Date.now(),
      });
    }
    // Прогон — то же самое: шедший в момент перезапуска поднимается вставшим.
    // Стоявший на согласовании так и стоит: вопрос владельцу никуда не делся,
    // и надзор вернёт прогон к нему.
    for (const run of data.runs ?? []) {
      const known = { ...run, actors: run.actors ?? {}, waitingOn: run.waitingOn ?? null };
      this.runs.set(run.id, known.status !== 'running' ? known : {
        ...known, status: 'stuck', note: this.say('state.pr.interrupted'), updatedAt: Date.now(),
      });
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
      for (const role of this.roles()) {
        if (role.isManager && this.staffOf(role.id).length === 0) this.spawn(role.id);
      }
      // Раскладку могли сузить между запусками: кому-то стола не нашлось, и
      // он поднялся «без стола» с координатами-заглушкой. Пересадка ставит
      // такого внутрь комнаты и объясняет это в чате — так же, как при живой
      // смене раскладки.
      if ([...this.instances.values()].some((i) => i.deskless)) this.resyncDesks();
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
   *
   * Стола может не найтись вовсе: раскладку офиса сузили, а состав команды
   * остался прежним. Сотрудника всё равно поднимаем — «без стола», с
   * запомненным номером места. Раньше он тут молча пропадал вместе со своей
   * сессией и расходами, и объяснить это исчезновение было нечем.
   */
  private rehire(pi: PersistedInstance): void {
    const role = this.role(pi.roleId);
    if (!role) return;   // роль исчезла из реестра — восстанавливать некого
    const taken = new Set([...this.instances.values()].map((i) => i.desk.index));
    const desks = this.deskPlan().desks;
    const desk = (!taken.has(pi.deskIndex) && desks.find((d) => d.index === pi.deskIndex))
      || this.freeDesk();
    // Имя из сохранения: мусор (не строка) считаем отсутствием имени.
    const name = typeof pi.name === 'string' ? cleanName(pi.name) : null;
    this.instances.set(pi.id, {
      id: pi.id,
      roleId: pi.roleId,
      label: labelFor(name, role.title, numberOf(pi.id)),
      name,
      // Координаты безместного поправит resyncDesks — он же знает, какие
      // клетки уже заняты соседями. Габарит у такого места 1×1: стола за ним
      // нет, а человечек занимает ровно одну клетку, на которую его поставят.
      desk: desk ?? { index: pi.deskIndex, x: 0, y: 0, w: 1, h: 1 },
      deskless: !desk,
      state: 'idle',
      currentTaskId: null,
      note: null,
      // Сохранения до детализации расходов знали только сумму — токенов
      // в них нет, и придумывать их нельзя: пусть остаются нулями.
      usage: { ...emptyUsage(), ...(pi.usage ?? { costUsd: pi.costUsd ?? 0 }) },
      daily: pi.daily ?? {},
      sessionId: pi.sessionId,
      // Персональный режим переживает перезапуск: иначе выданный сотруднику
      // полный доступ молча пропадал бы, а человек об этом не узнал.
      permissionMode: pi.permissionMode ?? null,
      abort: null,
      contextTokens: typeof pi.contextTokens === 'number' && pi.contextTokens > 0 ? pi.contextTokens : 0,
    });
  }

  setSessionId(instanceId: string, sessionId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.sessionId === sessionId) return;
    inst.sessionId = sessionId;
    this.markDirty();
  }

  /**
   * Запомнить размер контекста последнего вызова модели. Считается по
   * usage ответа: обычный ввод плюс прочитанный и записанный кеш — ровно
   * столько сессия перечитала на этом вызове.
   */
  noteContext(instanceId: string, tokens: number): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const clean = Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
    if (inst.contextTokens === clean) return;
    inst.contextTokens = clean;
    this.emit({ t: 'instance', instance: this.instanceView(inst) });
    this.markDirty();
  }

  /** Порог контекста менеджера — см. `Settings.pmContextLimit`. */
  pmContextLimit(): number {
    return sanitizePmContextLimit(this.settings.pmContextLimit) ?? DEFAULT_PM_CONTEXT_LIMIT;
  }

  /** Окно автосжатия исполнителя — см. `Settings.workerContextLimit`. */
  workerContextLimit(): number {
    return sanitizeWorkerContextLimit(this.settings.workerContextLimit) ?? DEFAULT_WORKER_CONTEXT_LIMIT;
  }

  /** Передача дел закрытой сессии менеджера: пустая строка стирает прошлую. */
  setPmHandoff(text: string | null): void {
    const clean = text?.trim() || null;
    if (this.pmHandoff === clean) return;
    this.pmHandoff = clean;
    this.markDirty();
  }

  // ---------- инстансы ----------

  /**
   * Свести набор ролей к одному менеджеру. Только для офиса без сохранения:
   * роли из сохранения принадлежат офису, и трогать их так нельзя.
   */
  startWithManagerOnly(): void {
    this.roleList = withManagerRole([], this.lang());
  }

  seed(): void {
    this.instances.clear();
    this.tasks.clear();
    this.epics.clear();
    this.prs.clear();
    this.runs.clear();
    this.chat = [];
    this.log = [];
    this.meetings = [];
    this.taskSeq = 0;
    this.epicSeq = 0;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve('deny');
    }
    this.pending.clear();
    this.alwaysAllowed.clear();
    this.alwaysDenied.clear();
    this.usage = emptyUsage();
    this.daily = {};
    this.life = emptyLife();
    this.facts.clear();
    this.questions.clear();
    this.questionsByTask.clear();
    this.directions.clear();
    this.proposals.clear();
    this.factSeq = 0;
    this.questionSeq = 0;
    this.directionSeq = 0;
    this.proposalSeq = 0;
    this.ensureBuiltinDirection();
    this.setPaused(false);
    // В архивные роли не сажаем никого: их убрали именно затем, чтобы офис
    // в них не работал, — а seed заново рассаживает штат по умолчанию.
    for (const role of this.activeRoles()) this.spawn(role.id);
  }

  /** Полный сброс по кнопке: стереть сохранение и начать с чистого листа. */
  hardReset(): void {
    this.wipe();
    this.seed();
    // Забываем и id сессий: разговор начинается с чистого листа — вместе
    // с передачей дел и размером контекста, они от той же сессии.
    for (const inst of this.instances.values()) {
      inst.sessionId = null;
      inst.contextTokens = 0;
    }
    this.pmHandoff = null;
    this.markDirty();
  }

  /**
   * Столы этого офиса — по его итоговой раскладке (пресет плюс оверрайд).
   * Общей на процесс «текущей раскладки» нет: офисов в памяти несколько, у
   * каждого свой layoutId и своя расстановка. Оверрайд учитывается здесь, а не
   * у каждого вызывающего: сдвинутый стол обязан быть сдвинутым для всех — и
   * для лимита штата, и для стола PM, и для места, за которое садится человечек.
   */
  private deskPlan(): DeskPlan {
    return deskPlan(this.settings.layoutId, this.override());
  }

  /** Оверрайд расстановки текущего пресета. null — офис живёт по пресету. */
  override(): LayoutOverride | null {
    const found = this.layoutOverrides[this.settings.layoutId];
    return isEmptyOverride(found) ? null : found;
  }

  /** Итоговая раскладка офиса: пресет с наложенным оверрайдом. */
  layout(): Layout {
    return effectiveLayout(this.settings.layoutId, this.override());
  }

  /**
   * Сохранить правки расстановки поверх пресета: по одной на предмет.
   * Присланное накладывается на уже сохранённое, поэтому править можно как
   * один сдвинутый стол, так и всю расстановку разом. Возвращает причину
   * отказа по-русски или null.
   *
   * Отказ означает, что не применено ничего: половина переехавшей мебели —
   * не то состояние, которое человек может себе объяснить.
   */
  editLayout(edits: LayoutPropEdit[]): string | null {
    if (!Array.isArray(edits) || edits.length === 0) return this.say('state.layout.emptyEdit');
    const layoutId = this.settings.layoutId;
    const clean: LayoutPropEdit[] = [];
    for (const edit of edits) {
      const checked = checkPropEdit(layoutId, this.override(), edit ?? ({} as LayoutPropEdit), this.lang());
      if ('error' in checked) return checked.error;
      clean.push(checked);
    }
    const props = [...(this.layoutOverrides[layoutId]?.props ?? [])];
    for (const edit of clean) {
      const at = props.findIndex((p) => p.key === edit.key);
      // Правки одного предмета складываются: править можно только то, что
      // поменяли, и новый `at` не должен обнулять сохранённые flip и scale.
      const merged = at === -1 ? edit : { ...props[at], ...edit };
      if (at === -1) props.push(merged);
      else props[at] = merged;
    }
    this.layoutOverrides[layoutId] = { version: 1, props };
    this.afterLayoutChange();
    return null;
  }

  /**
   * Вернуть расстановку к пресету: целиком или один предмет.
   * Возвращает причину отказа по-русски или null.
   */
  resetLayout(rawKey?: string): string | null {
    // Имя предмета приходит из сети: не строку считаем «сбросить всё», иначе
    // в отказ уехало бы «Предмет «[object Object]»».
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    const layoutId = this.settings.layoutId;
    const current = this.layoutOverrides[layoutId];
    if (isEmptyOverride(current)) {
      return this.say('state.layout.sameAsPreset', { preset: layoutTitle(layoutId, this.lang()) });
    }
    if (key) {
      const props = current.props.filter((p) => p.key !== key);
      if (props.length === current.props.length) {
        return this.say('state.layout.propSameAsPreset', { key, preset: layoutTitle(layoutId, this.lang()) });
      }
      this.layoutOverrides[layoutId] = { version: 1, props };
    } else {
      delete this.layoutOverrides[layoutId];
    }
    this.afterLayoutChange();
    this.addLog(null, 'system', key
      ? this.say('state.layout.propReset', { key })
      : this.say('state.layout.reset', { preset: layoutTitle(layoutId, this.lang()) }));
    return null;
  }

  /**
   * Раскладка изменилась: разослать её целиком, пересадить людей по новым
   * координатам столов и запомнить на диск. Одна точка на все причины
   * (правка предмета, сброс, смена пресета) — иначе какая-нибудь из них
   * оставила бы клиента рисовать вчерашнюю расстановку, а человечков — сидеть
   * в воздухе.
   *
   * `prevLayoutId` — пресет, с которого ушли. Нужен только затем, чтобы в
   * совете «верните прежнюю раскладку» назвать её по имени: человек выбирал
   * из списка подписей, а не из id.
   */
  private afterLayoutChange(prevLayoutId?: string): void {
    this.resyncDesks(prevLayoutId);
    this.emit({ t: 'layout', layout: this.layout(), override: this.override() });
    this.markDirty();
  }

  /**
   * Пересадить всех по итоговой раскладке. Порядок разбора и есть правило
   * рассадки:
   *
   * 1. Менеджер — за стол PM НОВОЙ раскладки. Он закреплён раскладкой, а не
   *    номером места: иначе после смены пресета PM сидел бы за случайным
   *    столом, а на его законный сел бы исполнитель.
   * 2. Остальные — за место со своим прежним индексом, если оно есть и
   *    свободно. Индекс — контракт (`Desk.index`), поэтому «стол N остаётся
   *    столом N», а едет вслед за столом только позиция.
   * 3. Кому прежнего места не досталось (стол убрали, номер занял PM) — на
   *    любой свободный.
   * 4. Кому столов не хватило совсем — состояние «без стола», см. ниже.
   */
  private resyncDesks(prevLayoutId?: string): void {
    const plan = this.deskPlan();
    const desks = plan.desks;
    const taken = new Set<number>();
    const queue: Instance[] = [];
    const homeless: Instance[] = [];
    // Клетки, на которых кто-то уже стоит. Заполняется только теми, кто сидит:
    // координаты безместного относятся к прежней раскладке, и считать их
    // занятыми в новой значило бы городить призрачные препятствия.
    const busy = new Set<string>();

    const seat = (inst: Instance, desk: Desk): void => {
      taken.add(desk.index);
      busy.add(`${desk.x},${desk.y}`);
      const moved = inst.desk.index !== desk.index
        || inst.desk.x !== desk.x || inst.desk.y !== desk.y;
      if (!moved && !inst.deskless) return;
      inst.desk = desk;
      inst.deskless = false;
      this.emit({ t: 'instance', instance: this.instanceView(inst) });
    };

    // 1. Менеджер садится первым — его стол в новой раскладке занят по праву.
    const manager = [...this.instances.values()].find((i) => this.role(i.roleId)?.isManager);
    const pmDesk = desks[plan.pmIndex];
    if (manager && pmDesk) seat(manager, pmDesk);

    // 2. Каждый на своё прежнее место, если оно уцелело и свободно.
    for (const inst of this.instances.values()) {
      if (inst === manager && pmDesk) continue;
      const same = desks.find((d) => d.index === inst.desk.index);
      if (!same || taken.has(same.index) || inst.deskless) { queue.push(inst); continue; }
      seat(inst, same);
    }

    // 3. Вытесненные — на свободные места, по порядку номеров.
    for (const inst of queue) {
      // Безместный сначала пробует вернуться на свой запомненный номер: он
      // мог освободиться вместе с приходом просторной раскладки.
      const own = inst.deskless ? desks.find((d) => d.index === inst.desk.index && !taken.has(d.index)) : undefined;
      const free = own ?? desks.find((d) => !taken.has(d.index));
      if (!free) { homeless.push(inst); continue; }
      seat(inst, free);
    }

    // 4. Столы кончились. Индекс места сотрудник сохраняет — вернётся
    // раскладка попросторнее, и он снова сядет за свой стол. А вот координаты
    // чужой раскладки годятся не всегда: стол с x=23 в комнате шириной 8
    // оставил бы человечка за стеной. Поэтому ставим его на свободную клетку
    // новой комнаты и помечаем «без стола» — молча растворять сотрудника
    // нельзя, а рисовать за столом, которого нет, тем более.
    for (const inst of homeless) {
      const spot = this.standingSpot(busy);
      if (spot) busy.add(`${spot.x},${spot.y}`);
      inst.desk = spot ? { ...inst.desk, x: spot.x, y: spot.y } : inst.desk;
      inst.deskless = true;
      this.emit({ t: 'instance', instance: this.instanceView(inst) });
      this.addLog(null, 'system', this.say('state.desk.lost', {
        who: inst.label, desks: desks.length, staff: this.instances.size,
      }));
    }
    if (homeless.length) this.tellAboutHomeless(homeless, desks.length, prevLayoutId);
  }

  /**
   * Сказать в чат офиса, кого не посадили и что с этим делать. Лента получает
   * строку на каждого — она про события; человеку же нужен один разбор с
   * именами и двумя выходами, иначе «кто-то стоит без стола» останется
   * замеченным только на картинке.
   */
  private tellAboutHomeless(homeless: Instance[], deskCount: number, prevLayoutId?: string): void {
    const who = homeless.map((i) => i.label).join(', ');
    const back = prevLayoutId && prevLayoutId !== this.settings.layoutId
      ? this.say('state.desk.backTo', { preset: layoutTitle(prevLayoutId, this.lang()) })
      : this.say('state.desk.backPlain');
    this.addChat(OFFICE_SENDER, this.say('state.desk.homeless', {
      preset: layoutTitle(this.settings.layoutId, this.lang()),
      desks: deskCount, staff: this.instances.size, who, back,
    }));
  }

  /**
   * Куда поставить сотрудника, которому в раскладке не хватило стола: ближайшая
   * к центру комнаты проходимая и никем не занятая клетка. Центр, а не угол,
   * потому что там человечек точно внутри комнаты и заметен — «стоит посреди
   * офиса без стола» и есть то, что произошло.
   *
   * null — свободных клеток не осталось (раскладка из одних стен). Тогда
   * сотрудник остаётся где стоял: это лучше, чем поставить его в стену.
   */
  private standingSpot(busy: Set<string>): { x: number; y: number } | null {
    const layout = this.layout();
    const grid = passability(layout, catalog);
    const cx = Math.floor(grid.cols / 2);
    const cy = Math.floor(grid.rows / 2);
    // Обход кольцами от центра: первое же подходящее — оно и ближайшее.
    const maxRing = Math.max(grid.cols, grid.rows);
    for (let r = 0; r <= maxRing; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (isBlocked(grid, x, y) || busy.has(`${x},${y}`)) continue;
          return { x, y };
        }
      }
    }
    return null;
  }

  private freeDesk(): Desk | null {
    const taken = new Set([...this.instances.values()].map((i) => i.desk.index));
    return this.deskPlan().desks.find((d) => !taken.has(d.index)) ?? null;
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

  /**
   * Нанять сотрудника в роль. Сотрудник в роли один: второй такой же — это
   * вторая роль из того же пакета (`hireCopy`), со своим именем, внешностью
   * и настройками. null — сажать некуда: в роли уже есть человек или в
   * раскладке не осталось свободных столов.
   */
  spawn(roleId: string): Instance | null {
    const role = this.role(roleId);
    if (!role) return null;
    if (this.staffOf(roleId).length) return null;
    // PM всегда садится за свой стол, остальные — на любой свободный.
    // Стол PM закреплён раскладкой этого офиса, а не общим на процесс числом.
    const plan = this.deskPlan();
    const desk = role.isManager ? plan.desks[plan.pmIndex] ?? null : this.freeDesk();
    if (!desk) return null;

    const n = this.nextNumber(roleId);
    const inst: Instance = {
      id: `${roleId}#${n}`,
      roleId,
      label: labelFor(null, role.title, n),
      // Имя даёт владелец после найма; нанятый приходит под названием роли.
      name: null,
      desk,
      // Нанимают только когда стол нашёлся: `spawn` без места возвращает null.
      deskless: false,
      state: 'idle',
      currentTaskId: null,
      note: null,
      usage: emptyUsage(),
      daily: {},
      sessionId: null,
      // Нового сотрудника нанимают без личных послаблений: режим он берёт
      // у роли. Права не должны появляться сами при найме.
      permissionMode: null,
      abort: null,
      contextTokens: 0,
    };
    this.instances.set(inst.id, inst);
    this.emit({ t: 'instance', instance: this.instanceView(inst) });
    this.markDirty();
    return inst;
  }

  setState(id: string, state: AgentState, note?: string | null): void {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.state = state;
    if (note !== undefined) inst.note = note;
    this.emit({ t: 'instance', instance: this.instanceView(inst) });
  }

  /**
   * Записать расход сессии. Одно и то же попадает в шесть мест: задача, день
   * задачи, агент, день агента, офис и день офиса. «Сколько стоила задача»,
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
        // День задачи считается отдельно, а не выводится из даты завершения:
        // работа над задачей переходит через полночь, и «сколько она стоила
        // сегодня» у такой задачи иначе не спросить.
        accumulate(dayOf(task.daily, day), delta);
        trimJournal(task.daily);
        this.emit({ t: 'task', task: toTaskView(task) });
      }
    }

    accumulate(inst.usage, delta);
    accumulate(dayOf(inst.daily, day), delta);
    trimJournal(inst.daily);
    this.emit({ t: 'instance', instance: this.instanceView(inst) });

    accumulate(this.usage, delta);
    accumulate(dayOf(this.daily, day), delta);
    trimJournal(this.daily);
    this.emit({ t: 'usage', total: this.usage, days: this.usageDays() });
    this.markDirty();
    // Токены тратятся — значит, кто-то работает. Ритуал сам тоже тратит,
    // но он один за раз и следующий ждёт своей тишины.
    if (!this.ritualRunning) this.noteWork();
  }

  /**
   * SDK рассказал, сколько лимита плана съедено. Само хранилище — общее на
   * процесс (`limits.ts`): лимит принадлежит аккаунту, а не офису. Событие
   * шлём только когда цифры и правда изменились: `rate_limit_event` прилетает
   * на каждый ответ модели, и рассылать в UI одно и то же незачем.
   */
  noteRateLimit(info: RateLimitInfo): void {
    if (recordRateLimit(info)) this.emit({ t: 'limits', limits: limitsView() });
  }

  /**
   * Спросить у только что заведённой сессии полную картину лимитов. Событие
   * `rate_limit_event` рассказывает лишь про то окно, в которое упираются
   * сейчас, — пятичасовое из него можно не увидеть ни разу. Вопрос задаётся
   * попутно и не чаще раза в минуту (см. `limits.ts`), а ответа никто не
   * ждёт: сессия заводится ради работы, а не ради шкалы.
   */
  pollLimits(session: LimitSource): void {
    void pollLimits(session).then((changed) => {
      if (changed) this.emit({ t: 'limits', limits: limitsView() });
    });
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
    /** Часть плана: фича, порядок внутри неё и задачи, которых она ждёт. */
    epicId?: string | null; order?: number; dependsOn?: string[];
    /**
     * Статус на старте. По умолчанию `backlog` — «делать сейчас»: так задача
     * заводилась до появления плана, и одиночные просьбы должны работать
     * ровно так же. Плановая задача заводится в `planned` и ждёт своей
     * очереди (см. plan.ts).
     */
    status?: TaskStatus;
    /** Тип работы. Не передан — выводится из способностей роли. */
    type?: TaskType | null;
    /** Важность. Не передана — средняя: важность — это отличие от остального. */
    priority?: TaskPriority;
  }): Task {
    this.taskSeq += 1;
    const task: Task = {
      id: `T-${this.taskSeq}`,
      title: input.title,
      description: input.description,
      criteria: input.criteria.map((text) => ({ text, done: false })),
      roleId: input.roleId,
      assigneeId: null,
      status: input.status ?? 'backlog',
      epicId: input.epicId ?? null,
      order: input.order ?? this.taskSeq,
      priority: asTaskPriority(input.priority),
      dependsOn: input.dependsOn ?? [],
      result: null,
      files: [],
      branch: null,
      baseBranch: null,
      worktreePath: null,
      repoDir: null,
      merged: false,
      interrupted: false,
      limitedAt: null,
      envWait: null,
      attention: null,
      workerSessionId: null,
      reviewerSessionId: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      usage: emptyUsage(),
      daily: {},
      outcome: null,
      mergeCommit: null,
      type: input.type === undefined ? this.typeForRole(input.roleId) : input.type,
      handoff: null,
      compactions: 0,
      compactedAt: null,
      branchMark: null,
      branchMarkAt: null,
    };
    this.tasks.set(task.id, task);
    this.emit({ t: 'task', task: toTaskView(task) });
    this.markDirty();
    return task;
  }

  // ---------- план: фичи ----------

  /**
   * Завести фичу. Порядок задаётся явно, а не по времени заведения: менеджер
   * может переставить план, и «раньше завели» перестало бы значить «раньше
   * делать» — а именно порядок и есть весь смысл плана.
   */
  createEpic(input: {
    title: string; goal: string; order?: number; approved: boolean;
    origin?: 'owner' | 'office'; rationale?: string; directionId?: string | null;
  }): Epic {
    this.epicSeq += 1;
    const epic: Epic = {
      id: `F-${this.epicSeq}`,
      title: input.title,
      goal: input.goal,
      order: input.order ?? this.epicSeq,
      status: 'planned',
      approved: input.approved,
      origin: input.origin ?? 'owner',
      rationale: input.rationale ?? '',
      directionId: input.directionId ?? null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      attention: null,
    };
    this.epics.set(epic.id, epic);
    this.emit({ t: 'epic', epic: toEpicView(epic) });
    this.markDirty();
    return epic;
  }

  updateEpic(id: string, patch: Partial<Epic>): Epic | null {
    const epic = this.epics.get(id);
    if (!epic) return null;
    Object.assign(epic, patch);
    this.emit({ t: 'epic', epic: toEpicView(epic) });
    this.markDirty();
    return epic;
  }

  /** Фичи в порядке плана. Один порядок на всех: и веб, и менеджер, и надзор. */
  epicList(): Epic[] {
    return [...this.epics.values()].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  /** Задачи фичи в том порядке, в котором их положено раздавать. */
  tasksOfEpic(epicId: string): Task[] {
    return [...this.tasks.values()]
      .filter((t) => t.epicId === epicId)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  /** Сколько фич офис ведёт одновременно — с учётом старых сохранений. */
  focusLimit(): number {
    return sanitizeFocus(this.settings.focusEpics) ?? DEFAULT_FOCUS_EPICS;
  }

  /** Спрашивать ли согласие человека перед началом фичи. */
  needsApproval(): boolean {
    return this.settings.planApproval !== false;
  }

  updateTask(id: string, patch: Partial<Task>): Task | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    Object.assign(task, patch);
    this.emit({ t: 'task', task: toTaskView(task) });
    this.markDirty();
    // Исход задачи ставит ритуал или закрытие — это не «работа идёт», а её
    // конец; метку на ветке тоже ставит ритуал. Всё остальное сбрасывает
    // тишину, по которой идут ритуалы.
    if (!('outcome' in patch) && !('branchMark' in patch)) this.noteWork();
    return task;
  }

  /**
   * Сменить важность задачи. Одна точка на всех, кто её меняет: команда из
   * веба, инструмент менеджера `edit_task`. Возвращает текст отказа или null.
   * Менять можно у любой задачи, в том числе у идущей и у закрытой: приоритет
   * ничего не запускает и не останавливает — он говорит, что важнее, и на
   * закрытой задаче остаётся частью её истории.
   */
  setTaskPriority(id: string, priority: TaskPriority): string | null {
    const task = this.tasks.get(id);
    if (!task) return this.say('state.criteria.noTask', { task: id });
    if (task.priority === priority) return null;
    task.priority = priority;
    this.emit({ t: 'task', task: toTaskView(task) });
    this.addLog(null, 'system', this.say('state.task.priority', {
      task: task.id, title: clipText(task.title, 40), priority: this.priorityWord(priority),
    }));
    this.markDirty();
    return null;
  }

  /** Приоритет словом на языке офиса — в ленту, в доску менеджера и в отказы. */
  priorityWord(priority: TaskPriority): string {
    return this.say(`task.priority.${asTaskPriority(priority)}`);
  }

  /**
   * Стереть задачу насовсем. Только само хранилище: решает, можно ли её
   * стирать, и чистит ссылки на неё — `deleteTask` в tasks.ts.
   */
  removeTask(id: string): boolean {
    if (!this.tasks.delete(id)) return false;
    this.waitingForSlot.delete(id);
    this.stoppedByUser.delete(id);
    this.cancelledByUser.delete(id);
    this.emit({ t: 'task.remove', id });
    this.markDirty();
    return true;
  }

  /**
   * Отметить критерий выполненным. Возвращает описание прогресса или
   * причину отказа — исполнитель видит её как результат вызова инструмента.
   */
  checkCriterion(taskId: string, index: number, done = true): { ok: boolean; text: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, text: this.say('state.criteria.noTask', { task: taskId }) };
    const item = task.criteria[index - 1];
    if (!item) {
      return {
        ok: false,
        text: this.say('state.criteria.noItem', {
          task: taskId, index, total: task.criteria.length,
        }),
      };
    }
    item.done = done;
    this.emit({ t: 'task', task: toTaskView(task) });
    this.markDirty();
    const { done: ready, total } = criteriaProgress(task);
    return {
      ok: true,
      text: this.say('state.criteria.marked', {
        index,
        text: clipText(item.text, 60),
        verdict: this.say(done ? 'state.criteria.done' : 'state.criteria.undone'),
        ready,
        total,
      }),
    };
  }

  // ---------- чат и лог ----------

  addChat(from: string, text: string, thread = 'pm#1', meetingId?: string): void {
    const entry: ChatEntry = { id: randomUUID(), thread, from, text, at: Date.now() };
    if (meetingId) entry.meetingId = meetingId;
    this.chat.push(entry);
    this.emit({ t: 'chat', entry });
    this.markDirty();
    // Реплики самого офиса тишину не сбивают: планёрка и ритуалы пишут в
    // чат, и считать это работой значило бы никогда не дождаться тишины.
    if (from !== OFFICE_SENDER) this.noteWork();
  }

  /**
   * Агент начал писать ответ в ветку: вебу пора показать «печатает…».
   * Повторный вызов на живом черновике ничего не начинает заново — ход мог
   * прийти вторым, а индикатор уже висит.
   */
  startDraft(from: string, thread = 'pm#1'): void {
    const live = this.drafts.get(thread);
    if (live) { this.armDraft(live); return; }
    const draft: ChatDraft = { id: randomUUID(), thread, from, text: '', at: Date.now() };
    this.drafts.set(thread, draft);
    this.armDraft(draft);
    // Копией: черновик потом дописывается на месте, и подписчик, отложивший
    // событие, увидел бы не то состояние, о котором ему сообщили.
    this.emit({ t: 'chat.draft', draft: { ...draft } });
  }

  /**
   * Кусок ответа от модели — дописать в конец черновика. Черновика может и не
   * быть (сторож снял его на долгом вызове инструмента) — тогда заводим
   * заново: текст пошёл, значит агент точно пишет.
   */
  appendDraft(thread: string, from: string, chunk: string): void {
    if (!chunk) return;
    let draft = this.drafts.get(thread);
    if (!draft) {
      this.startDraft(from, thread);
      draft = this.drafts.get(thread)!;
    }
    draft.text += chunk;
    this.armDraft(draft);
    this.emit({ t: 'chat.draft.delta', id: draft.id, text: chunk });
  }

  /**
   * Агент начал новое сообщение: прежний недописанный текст к ответу больше
   * не относится — обычно это была подводка перед вызовом инструмента, а в
   * чат уедет только последнее сказанное. Черновик тот же, чтобы индикатор не
   * мигал, но текст начинается с нуля.
   */
  clearDraftText(thread = 'pm#1'): void {
    const draft = this.drafts.get(thread);
    if (!draft || !draft.text) return;
    draft.text = '';
    this.armDraft(draft);
    this.emit({ t: 'chat.draft', draft: { ...draft } });
  }

  /** Признак жизни от сессии: черновик ещё пишется, сторожа отодвинуть. */
  touchDraft(thread = 'pm#1'): void {
    const draft = this.drafts.get(thread);
    if (draft) this.armDraft(draft);
  }

  /**
   * Ход закончился. Звать обязательно и на обрыве тоже, иначе «печатает…»
   * висело бы до перезапуска сервера. Идемпотентно: черновика нет — тихо.
   */
  endDraft(thread = 'pm#1', reason: 'done' | 'error' = 'done'): void {
    const draft = this.drafts.get(thread);
    clearTimeout(this.draftTimers.get(thread));
    this.draftTimers.delete(thread);
    if (!draft) return;
    this.drafts.delete(thread);
    this.emit({ t: 'chat.draft.end', id: draft.id, reason });
  }

  /**
   * Сторож черновика. Сессия способна умереть молча — без ошибки и без конца
   * потока (зависший вызов, убитый процесс SDK), и тогда конец хода не позовёт
   * никто. Поэтому у черновика есть срок: ни куска текста, ни другого признака
   * жизни за `DRAFT_IDLE_MS` — снимаем сами, как при обрыве.
   */
  private armDraft(draft: ChatDraft): void {
    clearTimeout(this.draftTimers.get(draft.thread));
    const timer = setTimeout(() => this.endDraft(draft.thread, 'error'), DRAFT_IDLE_MS);
    timer.unref?.();
    this.draftTimers.set(draft.thread, timer);
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
        this.say('perm.deniedBySession', { key: entry.request.key, role: roleId }));
    }
    if (byTimeout) {
      this.addLog(entry.request.agentId, 'system',
        this.say('perm.timedOut', { id }));
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
    return this.resolveRepoDir(role?.repoDir);
  }

  /**
   * Путь репозитория роли в абсолютном виде. Пусто — общий репозиторий офиса.
   * Отдельно от repoFor: проверять путь из формы приходится до того, как роль
   * существует, а считаться он обязан ровно так же — иначе форма одобрит одну
   * директорию, а задача пойдёт в другую.
   */
  resolveRepoDir(dir: string | null | undefined): string {
    const clean = dir?.trim();
    if (!clean) return this.projectDir;
    return isAbsolute(clean) ? resolve(clean) : resolve(this.projectDir, clean);
  }

  /** Состав офиса для UI: у каждого сотрудника посчитан эффективный режим. */
  instanceViews(): InstanceView[] {
    return [...this.instances.values()].map((i) => this.instanceView(i));
  }

  /**
   * Вид сотрудника для UI. Метод, а не свободная функция: эффективный режим
   * доступа считается по ролям и режиму ИМЕННО этого офиса, а офисов в памяти
   * несколько — из соседнего сотрудник приехал бы с чужими правами.
   */
  instanceView(i: Instance): InstanceView {
    return {
      id: i.id, roleId: i.roleId, label: i.label, name: i.name, desk: i.desk, deskless: i.deskless,
      state: i.state, currentTaskId: i.currentTaskId, note: i.note,
      usage: i.usage, today: i.daily[dayKey()] ?? emptyUsage(),
      permissionMode: i.permissionMode,
      effectivePermissionMode: effectiveMode(
        i.permissionMode, this.role(i.roleId)?.permissionMode, this.officeMode(),
      ),
      contextTokens: i.contextTokens,
    };
  }

  /**
   * Режим доступа офиса. Метод, а не поле: в сохранениях старше режима поля
   * нет, и подстраховку значением по умолчанию не должен повторять каждый,
   * кому нужен режим.
   */
  officeMode(): PermissionMode {
    return this.settings.officePermissionMode ?? DEFAULT_SETTINGS.officePermissionMode;
  }

  /**
   * Язык офиса. Своя обёртка по той же причине, что и у режима доступа:
   * в старых сохранениях поля нет, и подстраховку не должен повторять каждый,
   * кто пишет человеку хоть строчку.
   */
  lang(): Lang {
    return asLang(this.settings.language);
  }

  /**
   * Фраза на языке офиса. Через неё проходит всё, что офис говорит человеку:
   * лента, чат и отказы форм. Язык берётся у офиса, а не у процесса, — в одном
   * сервере открыто несколько офисов, и у каждого он свой.
   */
  say(key: ServerKey, vars?: Vars): string {
    return t(this.lang(), key, vars);
  }

  /**
   * Каталог внешних MCP-серверов офиса. Метод, а не обращение к полю: в
   * сохранениях старше каталога его нет, и подстраховку умолчанием не должен
   * повторять каждый, кому нужен список серверов.
   */
  mcpServers(): McpServerDef[] {
    return this.settings.mcpServers ?? DEFAULT_MCP_SERVERS;
  }

  /**
   * Что известно о внешних серверах. Не сохраняется на диск: сервер поднимает
   * сессия, и после перезапуска офиса прошлое «подключился» — не знание, а
   * воспоминание. Пустой список честнее: узнаем, когда кто-то поработает.
   */
  mcpStatuses(): McpServerState[] {
    return [...this.mcpState.values()];
  }

  /**
   * Спросить живую сессию, что с её серверами, и запомнить ответ. Вызов
   * фоновый: сессия работает, а офис узнаёт о серверах попутно.
   *
   * Опрашиваем только те роли, у которых внешние серверы есть: остальным
   * рассказывать не о чем, а лишний управляющий вызов на каждую сессию —
   * это накладные на пустом месте.
   */
  pollMcp(agentId: string, role: Role, session: McpStatusSource): void {
    const wanted = new Set(
      mcpNamesFor(role).filter((id) => this.mcpServers().some((s) => s.id === id && !s.disabled)),
    );
    if (!wanted.size) return;
    void pollMcpStatus(session, wanted, agentId).then((list) => this.noteMcpStatus(list));
  }

  /**
   * Положить статусы серверов и сказать о переменах. В ленту пишем только
   * смену состояния, а не каждый опрос: сессий много, серверы одни и те же, и
   * строка «figma-bridge подключился» на каждую задачу была бы шумом.
   */
  noteMcpStatus(list: McpServerState[]): void {
    let changed = false;
    for (const next of list) {
      const prev = this.mcpState.get(next.id);
      this.mcpState.set(next.id, next);
      if (prev?.status === next.status && prev.error === next.error) continue;
      changed = true;
      const title = this.mcpServers().find((s) => s.id === next.id)?.title || next.id;
      if (next.status === 'connected') {
        this.addLog(next.agentId, 'system', this.say('state.mcp.connected', { title }));
      } else if (next.status !== 'pending') {
        // Отказ сервера — это не отказ офиса: роль доработает тем, что есть.
        // Но человек должен видеть причину, а не гадать по пустым инструментам.
        this.addLog(next.agentId, 'system', this.say('state.mcp.failed', {
          title, reason: clipText(next.error, 200) || next.status,
        }));
      }
    }
    if (changed) this.emit({ t: 'mcp.status', servers: this.mcpStatuses() });
  }

  roleViews(): RoleView[] {
    const officeMode = this.officeMode();
    return this.roles().map<RoleView>((r) => ({
      id: r.id, title: r.title, emoji: r.emoji, color: r.color, model: r.model,
      permissionMode: r.permissionMode,
      isolate: r.isolate, maxTurns: r.maxTurns ?? null,
      repoDir: r.repoDir ?? '', sprite: r.sprite ?? '', brief: r.brief,
      briefExtra: r.package?.briefExtra ?? '',
      package: this.packageView(r),
      // Действующий набор, а не сырое поле: у роли без своей подписки это
      // умолчание по её id, и UI должен показывать то, что реально уедет в
      // сессию, а не пустоту.
      mcp: mcpNamesFor(r),
      // Чего не хватает пакету роли. Читается с диска, как и сами скилы:
      // положили пакет — просьба видна в каталоге без перезапуска.
      mcpRequested: employeeServers(r),
      isManager: r.isManager, archived: r.archived === true,
      removable: this.roleRemovable(r),
      active: [...this.instances.values()].filter((i) => i.roleId === r.id).length,
      effectivePermissionMode: effectiveMode(null, r.permissionMode, officeMode),
      effectiveMaxTurns: this.turnsFor(r),
      capabilities: capabilitiesOf(r),
    }));
  }

  /**
   * Пакет роли для формы: имя, версия и бриф пакета на языке офиса — тот
   * текст, который форма показывает только для чтения над припиской.
   * Пакета на диске нет — показываем то, что помним по ссылке, без брифа.
   */
  private packageView(role: Role): RoleView['package'] {
    if (!role.package) return null;
    const pkg = resolvePackage(role.package);
    return {
      name: role.package.name,
      version: pkg?.version ?? role.package.version,
      brief: pkg ? packageBrief(pkg, this.lang()) : '',
    };
  }

  // ---------- создание, правка и архивация ролей ----------

  /**
   * Задачи роли — любые, включая закрытые. Именно они делают архивацию
   * обязательной: roleId лежит в каждой такой задаче, и роль, стёртая
   * насовсем, перестала бы находиться при показе истории.
   */
  private tasksOf(roleId: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.roleId === roleId);
  }

  /**
   * Задачи роли, которые прямо сейчас в работе: их нельзя оставить без роли.
   * Взятые в работу и назначенные считаются одинаково — у обеих уже есть
   * исполнитель, который вот-вот пойдёт (или уже пошёл) работать.
   */
  private liveTasksOf(roleId: string): Task[] {
    const live: TaskStatus[] = ['assigned', 'in_progress', 'review'];
    return this.tasksOf(roleId).filter((t) => live.includes(t.status));
  }

  /**
   * Можно ли стереть роль насовсем, а не убрать в архив. Можно ровно тогда,
   * когда её id нигде в истории не встречается: ни одной задачи, ни одного
   * сотрудника. Менеджер не удаляется никогда — на нём держится весь офис.
   */
  private roleRemovable(role: Role): boolean {
    if (role.isManager) return false;
    return this.tasksOf(role.id).length === 0 && this.staffOf(role.id).length === 0;
  }

  /**
   * Отпечаток перечня ролей, вшитого в сессию менеджера: описание поля roleId
   * у create_task перечисляет id и названия исполнителей, и собирается оно
   * один раз, при старте сессии. Пока отпечаток тот же, перезапускать нечего.
   *
   * Брифы сюда не входят намеренно: их менеджер читает вызовом list_team, а
   * тот ходит в состояние офиса на каждый вызов и видит правки сразу.
   */
  private roleMenuSignature(): string {
    return this.workerRoles().map((r) => `${r.id} ${r.title}`).join('');
  }

  /**
   * Разослать изменившийся набор ролей и, если перечень для менеджера стал
   * другим, перезапустить его сессию. Одна точка на все правки набора: разойдись
   * они — менеджер продолжал бы назначать задачи на заархивированную роль.
   */
  private roleSetChanged(before: string): void {
    this.emit({ t: 'roles', roles: this.roleViews() });
    this.markDirty();
    if (this.roleMenuSignature() !== before) roleSetWatcher?.(this);
  }

  /**
   * Проверить поля роли, пришедшие из формы. Возвращает ошибки по полям —
   * пустой список означает «можно применять». Проверяется только то, что в
   * патче есть: правка одного поля не должна спотыкаться о соседнее.
   *
   * `roleId` — чью роль правим; для создания пусто (id ещё не выдан).
   */
  private async checkRolePatch(
    patch: Partial<RoleEditable>, roleId: string | null,
  ): Promise<FieldError[]> {
    const errors: FieldError[] = [];
    if ('title' in patch) {
      const title = String(patch.title ?? '').trim();
      if (!title) errors.push({ field: 'title', message: this.say('state.role.titleEmpty') });
      else if (title.length > ROLE_TITLE_LIMIT) {
        errors.push({
          field: 'title',
          message: this.say('state.role.titleLong', { limit: ROLE_TITLE_LIMIT }),
        });
      // Сравниваем без учёта регистра: «Аналитик» и «аналитик» в списке ролей
      // не различить глазами, а раздавать задачи придётся именно по нему.
      } else if (this.roles().some((r) => r.id !== roleId
          && r.title.trim().toLowerCase() === title.toLowerCase())) {
        errors.push({
          field: 'title',
          message: this.say('state.role.titleTaken', { title }),
        });
      }
    }
    if ('model' in patch && !MODEL_RE.test(String(patch.model ?? ''))) {
      errors.push({ field: 'model', message: this.say('state.role.noModel') });
    }
    if ('maxTurns' in patch && sanitizeMaxTurns(patch.maxTurns) === undefined) {
      errors.push({
        field: 'maxTurns',
        message: this.say('state.role.turnsRange', {
          min: MIN_TASK_MAX_TURNS, max: MAX_TASK_MAX_TURNS,
        }),
      });
    }
    if ('permissionMode' in patch
        && patch.permissionMode !== null && !isPermissionMode(patch.permissionMode)) {
      errors.push({ field: 'permissionMode', message: this.say('state.role.badMode') });
    }
    if ('sprite' in patch) {
      const sprite = String(patch.sprite ?? '').trim();
      // Пусто — законно: значит «подбери внешность по id роли».
      if (sprite && !isLookId(sprite)) {
        errors.push({
          field: 'sprite',
          message: this.say('state.role.noSprite', { sprite }),
        });
      }
    }
    if ('repoDir' in patch) {
      const dir = String(patch.repoDir ?? '').trim();
      // Пусто — «работать в общем репозитории офиса», проверять нечего.
      if (dir) {
        const problem = await repoProblem(this.resolveRepoDir(dir), this.lang());
        if (problem) errors.push({ field: 'repoDir', message: problem });
      }
    }
    return errors;
  }

  /**
   * Завести роль. id генерирует офис по названию: только он знает, какие id
   * заняты у него и в базовом наборе. Возвращает либо созданную роль, либо
   * ошибки по полям формы.
   */
  async createRole(draft: RoleDraft): Promise<{ role: Role } | { errors: FieldError[] }> {
    // Умолчания добираем ДО проверки: короткая форма (одно название) обязана
    // проходить её так же, как заполненная целиком.
    const wanted: RoleEditable = {
      title: String(draft.title ?? '').trim(),
      emoji: text(draft.emoji) ?? '🙂',
      color: text(draft.color) ?? '#94a3b8',
      model: text(draft.model) ?? DEFAULT_ROLE_MODEL,
      permissionMode: draft.permissionMode ?? null,
      isolate: draft.isolate !== false,
      // Новая роль без подписки — это роль без внешних инструментов: умолчания
      // по id заведены для базовых ролей, а у заведённой руками его нет.
      mcp: Array.isArray(draft.mcp) ? draft.mcp.map((id) => String(id)) : [],
      // Умения — из словаря; пусто — офис выведет их по инструментам.
      capabilities: Array.isArray(draft.capabilities) ? draft.capabilities.map((c) => String(c)).filter(isCapability) : [],
      maxTurns: draft.maxTurns ?? null,
      repoDir: typeof draft.repoDir === 'string' ? draft.repoDir.trim() : '',
      sprite: typeof draft.sprite === 'string' ? draft.sprite.trim() : '',
      brief: typeof draft.brief === 'string' ? draft.brief : '',
      // Заведённая руками роль пакета не имеет — приписывать не к чему.
      briefExtra: '',
    };
    const errors = await this.checkRolePatch(wanted, null);
    if (errors.length) return { errors };

    const before = this.roleMenuSignature();
    const role: Role = {
      id: newRoleId(wanted.title, this.roleList.map((r) => r.id)),
      title: wanted.title,
      color: wanted.color,
      emoji: wanted.emoji,
      model: wanted.model,
      isManager: false,          // менеджер в офисе один, и он уже есть
      permissionMode: wanted.permissionMode,
      isolate: wanted.isolate,
      maxTurns: wanted.maxTurns,
      repoDir: wanted.repoDir,
      sprite: wanted.sprite,
      archived: false,
      brief: wanted.brief,
    };
    this.roleList = [...this.roleList, role];
    this.addLog(null, 'system', this.say('state.role.created', { title: role.title, id: role.id }));
    this.roleSetChanged(before);
    return { role };
  }

  /**
   * Правка роли из формы: те же проверки, что и при создании, и тот же формат
   * ошибок. Пустой список — правка применена.
   */
  async editRole(roleId: string, patch: Partial<RoleEditable>): Promise<FieldError[]> {
    const role = this.role(roleId);
    if (!role) return [{ field: '', message: this.say('state.role.missing', { role: roleId }) }];
    // Переименовать PM во что-то другое нельзя: на этой роли держится раздача
    // задач, и «Проектный менеджер», ставший «Верстальщиком», — это офис,
    // в котором менеджера больше нет, хотя в списке он есть.
    if (role.isManager && 'title' in patch && String(patch.title ?? '').trim() !== role.title) {
      return [{
        field: 'title',
        message: this.say('state.role.pmRename'),
      }];
    }
    const errors = await this.checkRolePatch(patch, roleId);
    if (errors.length) return errors;
    this.updateRole(roleId, patch);
    return [];
  }

  /**
   * Убрать роль в архив или вернуть её из архива. Архивная роль пропадает из
   * найма и из перечня для менеджера, но остаётся в наборе и находится по id:
   * задачи, логи и сохранённые сотрудники ссылаются на неё именно так.
   *
   * Возвращает ошибки формы; пустой список — сделано.
   */
  archiveRole(roleId: string, archived: boolean): FieldError[] {
    const role = this.role(roleId);
    if (!role) return [{ field: '', message: this.say('state.role.missing', { role: roleId }) }];
    if (role.isManager) {
      return [{
        field: '',
        message: this.say('state.role.pmArchive'),
      }];
    }
    if (role.archived === archived) return [];
    if (archived) {
      const staff = this.staffOf(roleId);
      if (staff.length) {
        return [{
          field: '',
          message: this.say('state.role.archiveBusy', {
            title: role.title, who: staff.map((i) => i.id).join(', '),
          }),
        }];
      }
      const live = this.liveTasksOf(roleId);
      if (live.length) {
        return [{
          field: '',
          message: this.say('state.role.archiveTasks', {
            title: role.title, tasks: live.map((t) => t.id).join(', '),
          }),
        }];
      }
    }
    const before = this.roleMenuSignature();
    this.roleList = this.roleList.map((r) => (r.id === roleId ? { ...r, archived } : r));
    this.addLog(null, 'system', archived
      ? this.say('state.role.archived', { title: role.title, id: roleId })
      : this.say('state.role.restored', { title: role.title, id: roleId }));
    this.roleSetChanged(before);
    return [];
  }

  /**
   * Стереть роль насовсем. Разрешено только там, где её id не встречается
   * нигде в истории: ни задач, ни сотрудников. Во всех остальных случаях
   * удаление — это архивация, иначе доска перестала бы читаться.
   */
  removeRole(roleId: string): FieldError[] {
    const role = this.role(roleId);
    if (!role) return [{ field: '', message: this.say('state.role.missing', { role: roleId }) }];
    if (role.isManager) {
      return [{ field: '', message: this.say('state.role.pmRemove') }];
    }
    if (!this.roleRemovable(role)) {
      const tasks = this.tasksOf(roleId).length;
      const staff = this.staffOf(roleId).length;
      const trace = tasks
        ? this.say('state.role.removeTraceTasks', { n: tasks })
        : this.say('state.role.removeTraceStaff', { n: staff });
      return [{
        field: '',
        message: this.say('state.role.removeRefused', { title: role.title, trace }),
      }];
    }
    const before = this.roleMenuSignature();
    this.roleList = this.roleList.filter((r) => r.id !== roleId);
    this.addLog(null, 'system', this.say('state.role.removed', { title: role.title, id: roleId }));
    this.roleSetChanged(before);
    return [];
  }

  /**
   * Некуда посадить нового сотрудника — готовый текст отказа; null — место
   * есть. Спрашивается ДО того, как завести роль: иначе «нанять ещё одного»
   * в полном офисе оставляло бы после себя роль без человека.
   */
  private noDeskProblem(): string | null {
    return this.freeDesk() ? null : this.say('state.hire.noDesk', {
      preset: layoutTitle(this.settings.layoutId, this.lang()),
      desks: this.deskPlan().desks.length,
    });
  }

  /**
   * Внешность, которой в офисе ещё ни у кого нет. null — все разобраны, и
   * тогда второй такой же сотрудник выйдет на одно лицо с первым, пока
   * человек не выберет ему внешность сам.
   */
  private freeLook(): string | null {
    const taken = new Set(this.roleList.map((r) => r.sprite).filter(Boolean));
    return LOOKS.find((l) => !taken.has(l.id))?.id ?? null;
  }

  /**
   * Нанять из пакета: роль плюс сотрудник в неё. Роль из этого пакета уже
   * есть, но пустая — это открытая вакансия, и найм закрывает её, а не
   * плодит вторую такую же. Иначе заводится ЕЩЁ ОДНА роль из того же пакета:
   * клонов внутри роли нет, второй программист — это отдельный сотрудник со
   * своим номером в названии, своей внешностью и своими настройками, и
   * правка одного не трогает другого.
   *
   * Возвращает причину отказа готовым текстом или null.
   */
  hireFromPackage(pkg: AgentPackage, source: PackageSource | null, extra: LinkOverrides = {}): string | null {
    const fromPackage = this.roleList.filter((r) => r.package?.name === pkg.name && !r.archived);
    const vacancy = fromPackage.find((r) => this.staffOf(r.id).length === 0);
    // Открытая вакансия закрывается как есть: её рабочее место человек уже
    // мог настроить, и правки мастера поверх были бы сюрпризом.
    if (vacancy) return this.hire(vacancy.id);
    if (pkg.manifest.manager) return this.say('market.managerTaken', { name: pkg.name });
    if (fromPackage.length >= MAX_HIRE_COUNT) {
      return this.say('state.hire.copies', { title: packageTitle(pkg, this.lang()), max: MAX_HIRE_COUNT });
    }
    const noDesk = this.noDeskProblem();
    if (noDesk) return noDesk;
    const before = this.roleMenuSignature();
    const id = newRoleId(roleIdFor(pkg.name), this.roleList.map((r) => r.id));
    // Номер копии — по самому большому из занятых, а не по количеству ролей:
    // уволь и убери «Бэкенда 2», и следующий получил бы то же название, что
    // уже лежит в истории задач.
    const copy = fromPackage.reduce((max, r) => Math.max(max, r.package?.copy ?? 1), 0) + 1;
    // `extra` — правки поверх пакета от того, кто нанимает: мастер нового
    // офиса кладёт сюда рабочее место (repoDir). Они такие же оверрайды, как
    // те, что человек потом сделает в карточке роли.
    const overrides: LinkOverrides = { ...extra };
    // Второму такому же — другая внешность: двух одинаковых человечков в
    // комнате не различить. Это правка поверх пакета, и человек её поменяет.
    if (copy > 1) {
      const look = this.freeLook();
      if (look) overrides.sprite = look;
    }
    const link: RoleLink = {
      name: pkg.name, version: pkg.version, ...(source ? { source } : {}),
      overrides, briefExtra: '', ...(copy > 1 ? { copy } : {}),
    };
    const role = roleFromPackage(pkg, this.lang(), id, link);
    this.roleList = [...this.roleList, role];
    this.addLog(null, 'system', this.say('market.hiredFrom', {
      title: role.title, id: role.id, name: pkg.name, version: pkg.version,
    }));
    this.roleSetChanged(before);
    return this.hire(id);
  }

  /**
   * Нанять ещё одного такого же. Роль из пакета — ещё одна роль из того же
   * пакета; роль, заведённая руками, — копия её настроек. В обоих случаях
   * это отдельный сотрудник: настройки те же, а название, внешность и
   * дальнейшие правки — свои, и первого они не касаются.
   */
  hireCopy(roleId: string): string | null {
    const role = this.role(roleId);
    if (!role) return this.say('state.role.missing', { role: roleId });
    if (role.isManager) return this.say('state.hire.pmCopy');
    if (role.package) {
      const pkg = resolvePackage(role.package);
      // Пакета на диске нет — считать роль заново не из чего, а копировать
      // её сохранённые поля значило бы завести подделку, которая не получит
      // ни обновлений, ни брифа пакета.
      if (!pkg) return this.say('state.hire.copyNoPackage', { name: role.package.name });
      return this.hireFromPackage(pkg, role.package.source ?? null);
    }
    const noDesk = this.noDeskProblem();
    if (noDesk) return noDesk;
    const before = this.roleMenuSignature();
    const title = newRoleTitle(role.title, this.roleList.map((r) => r.title));
    const copy: Role = {
      ...role,
      id: newRoleId(title, this.roleList.map((r) => r.id)),
      title,
      sprite: this.freeLook() ?? role.sprite,
      archived: false,
    };
    this.roleList = [...this.roleList, copy];
    this.addLog(null, 'system', this.say('state.role.copied', {
      title: copy.title, id: copy.id, from: role.title,
    }));
    this.roleSetChanged(before);
    return this.hire(copy.id);
  }

  /**
   * Перевести роль на другую версию её пакета. Оверрайды и приписка остаются:
   * они лежат в ссылке отдельно от пакета. Живых сессий не касается — новая
   * версия достаётся следующей задаче.
   */
  updateRolePackage(roleId: string, pkg: AgentPackage, source: PackageSource | null): string | null {
    const role = this.role(roleId);
    if (!role) return this.say('state.role.missing', { role: roleId });
    if (!role.package) return this.say('market.roleNotLinked', { title: role.title });
    if (role.package.name !== pkg.name) {
      return this.say('market.nameMismatch', {
        repo: source?.repo ?? '', path: source?.path ?? '', found: pkg.name, name: role.package.name,
      });
    }
    const before = this.roleMenuSignature();
    const from = role.package.version;
    const link: RoleLink = { ...role.package, version: pkg.version, ...(source ? { source } : {}) };
    this.roleList = this.roleList.map((r) =>
      (r.id === roleId ? { ...roleFromPackage(pkg, this.lang(), roleId, link), archived: r.archived } : r));
    this.addLog(null, 'system', this.say('market.roleUpdated', {
      title: role.title, id: roleId, name: pkg.name, from, to: pkg.version,
    }));
    this.roleSetChanged(before);
    return null;
  }

  /**
   * Отвязать роль от пакета — форк. Вычисленная роль остаётся какой была,
   * включая бриф с припиской, и дальше живёт как заведённая руками: бриф
   * правится напрямую, обновления пакета до неё не доходят. Обратного пути
   * нет — привязать заново значит завести роль из пакета ещё раз.
   */
  detachRole(roleId: string): FieldError[] {
    const role = this.role(roleId);
    if (!role) return [{ field: '', message: this.say('state.role.missing', { role: roleId }) }];
    if (!role.package) return [{ field: '', message: this.say('state.role.notLinked', { title: role.title }) }];
    const before = this.roleMenuSignature();
    const { package: link, ...rest } = role;
    this.roleList = this.roleList.map((r) => (r.id === roleId ? rest : r));
    this.addLog(null, 'system', this.say('state.role.detached', {
      title: role.title, id: roleId, name: link.name,
    }));
    this.roleSetChanged(before);
    return [];
  }

  /**
   * Применить правку роли. Проверки полей — в editRole: сюда правка приходит
   * уже разобранной, а этот метод отвечает за то, чтобы она легла в набор и
   * доехала до всех, кого касается.
   */
  updateRole(roleId: string, patch: Partial<RoleEditable>): void {
    const base = this.role(roleId);
    if (!base) return;
    const beforeMenu = this.roleMenuSignature();
    // Берём только те поля, которые человеку и правда можно править. Патч
    // приходит из сети: с ним доехали бы и `archived`, и `isManager` — то
    // есть архивация и назначение второго менеджера в обход всех проверок.
    const clean: Partial<RoleEditable> = {};
    for (const key of ROLE_EDITABLE_KEYS) {
      if (key in patch) (clean as Record<string, unknown>)[key] = patch[key];
    }
    // Пути и внешность приходят из поля ввода — с пробелами по краям.
    if (typeof clean.repoDir === 'string') clean.repoDir = clean.repoDir.trim();
    if (typeof clean.sprite === 'string') clean.sprite = clean.sprite.trim();
    if (typeof clean.title === 'string') clean.title = clean.title.trim();
    // Режим роли правит человек из UI — значение проверяем, как и офисное.
    if ('permissionMode' in clean
        && clean.permissionMode !== null && !isPermissionMode(clean.permissionMode)) {
      delete clean.permissionMode;
    }
    // Подписка на серверы приходит из формы: чужое значение (строка вместо
    // массива, id несуществующего сервера) осело бы в сохранении и всплывало
    // при каждом запуске сессии. Пустой массив законен — это «ничего не
    // подключать», и отличать его от мусора обязательно.
    if ('mcp' in clean) {
      if (!Array.isArray(clean.mcp)) delete clean.mcp;
      else {
        const known = new Set(this.mcpServers().map((srv) => srv.id));
        clean.mcp = [...new Set(clean.mcp.map((id) => String(id)))].filter((id) => known.has(id));
      }
    }
    // Умения — из словаря: чужое слово ничего бы не значило для узлов процесса.
    if ('capabilities' in clean) {
      if (!Array.isArray(clean.capabilities)) delete clean.capabilities;
      else clean.capabilities = [...new Set(clean.capabilities.map((c) => String(c)))].filter(isCapability);
    }
    // Лимит ходов роли проверяем теми же границами, что и офисный: с нулём или
    // строкой сессия роли падала бы на первом ходу. null законен — он значит
    // «как в офисе», поэтому отличаем его от непригодного значения.
    if ('maxTurns' in clean) {
      const turns = sanitizeMaxTurns(clean.maxTurns);
      if (turns === undefined) delete clean.maxTurns;
      else clean.maxTurns = turns;
    }
    // Правка ложится в набор ролей самого офиса: соседний работает со своими.
    // Роль заменяется новым объектом, а не правится на месте: снимок, который
    // держит уже запущенная сессия, обязан остаться прежним.
    //
    // У роли с пакетом правка ложится не в саму роль, а в разницу с пакетом:
    // поле, вернувшееся к умолчанию пакета, из разницы уходит, а бриф
    // правится только припиской — сам бриф пакета неприкосновенен.
    const pkg = base.package ? resolvePackage(base.package) : null;
    if (base.package && pkg) {
      const link: RoleLink = { ...base.package, overrides: { ...base.package.overrides } };
      for (const key of OVERRIDABLE_KEYS) {
        if (!(key in clean)) continue;
        (link.overrides as Record<string, unknown>)[key] = clean[key];
      }
      if ('briefExtra' in clean) link.briefExtra = String(clean.briefExtra ?? '').trim();
      // `brief` у привязанной роли не правится: форма его и не шлёт, а патч
      // из сети с ним молча отбрасывается — отвязка делается явной командой.
      delete clean.brief;
      this.roleList = this.roleList.map((r) =>
        (r.id === roleId ? { ...roleFromPackage(pkg, this.lang(), roleId, link), archived: r.archived } : r));
    } else {
      delete clean.briefExtra;
      this.roleList = this.roleList.map((r) =>
        (r.id === roleId ? { ...r, ...(clean as Partial<Role>) } : r));
    }
    if ('permissionMode' in clean && clean.permissionMode !== base.permissionMode) {
      this.addLog(null, 'system', clean.permissionMode
        ? this.say('state.role.modeSet', {
          title: base.title, mode: modeLabel(clean.permissionMode, this.lang()),
        })
        : this.say('state.role.modeInherited', {
          title: base.title, mode: modeLabel(this.officeMode(), this.lang()),
        }));
    }
    // Ярлыки инстансов без имени зависят от названия роли.
    for (const inst of this.instances.values()) {
      if (inst.roleId !== roleId) continue;
      const role = this.role(roleId)!;
      inst.label = labelFor(inst.name, role.title, numberOf(inst.id));
      this.emit({ t: 'instance', instance: this.instanceView(inst) });
    }
    this.addLog(null, 'system',
      this.say('state.role.updated', { role: roleId, fields: Object.keys(clean).join(', ') }));
    // Название роли вшито в описание assign у менеджера — переименование
    // меняет перечень так же, как заведение новой роли.
    this.roleSetChanged(beforeMenu);
  }

  /**
   * Обновить настройки офиса. Возвращает причину отказа по-русски или null.
   * Отказ означает, что не применено ничего: настройки сохраняются одной
   * формой, и «половина приехала» человеку не объяснить.
   */
  updateSettings(patch: Partial<Settings>): string | null {
    const prevMode = this.settings.officePermissionMode;
    const prevLayout = this.settings.layoutId;
    const prevWorkers = this.workerLimit();
    const prevLang = this.lang();
    const next = { ...patch };
    // Язык приходит от клиента: неизвестное значение оставило бы офис без
    // словаря, и каждая фраза выродилась бы в голый ключ.
    if ('language' in next && !isLang(next.language)) delete next.language;
    // Режим приходит от клиента: чужое значение испортило бы решение по
    // каждому вызову инструмента, поэтому непонятное просто не берём.
    if ('officePermissionMode' in next && !isPermissionMode(next.officePermissionMode)) {
      delete next.officePermissionMode;
    }
    if ('taskMaxTurns' in next) {
      const clean = sanitizeMaxTurns(next.taskMaxTurns);
      // undefined — прислали мусор (строку, NaN, ноль). Прежнее значение
      // надёжнее: с нулём исполнитель падал бы на первом же ходу.
      if (clean === undefined) delete next.taskMaxTurns;
      else next.taskMaxTurns = clean;
    }
    if ('focusEpics' in next) {
      const clean = sanitizeFocus(next.focusEpics);
      if (clean === undefined) delete next.focusEpics;
      else next.focusEpics = clean;
    }
    if ('maxConcurrentWorkers' in next) {
      const clean = sanitizeWorkers(next.maxConcurrentWorkers);
      if (clean === undefined) delete next.maxConcurrentWorkers;
      else next.maxConcurrentWorkers = clean;
    }
    if ('ritualLimitThreshold' in next) {
      const clean = sanitizeRitualLimit(next.ritualLimitThreshold);
      if (clean === undefined) delete next.ritualLimitThreshold;
      else next.ritualLimitThreshold = clean;
    }
    if ('pmContextLimit' in next) {
      const clean = sanitizePmContextLimit(next.pmContextLimit);
      if (clean === undefined) delete next.pmContextLimit;
      else next.pmContextLimit = clean;
    }
    if ('workerContextLimit' in next) {
      const clean = sanitizeWorkerContextLimit(next.workerContextLimit);
      if (clean === undefined) delete next.workerContextLimit;
      else next.workerContextLimit = clean;
    }
    if ('ritualsEnabled' in next && typeof next.ritualsEnabled !== 'boolean') delete next.ritualsEnabled;
    if ('initiativeMode' in next && !isInitiativeMode(next.initiativeMode)) delete next.initiativeMode;
    if ('initiativeShare' in next) {
      const clean = sanitizeShare(next.initiativeShare);
      if (clean === undefined) delete next.initiativeShare;
      else next.initiativeShare = clean;
    }
    if ('meetingEveryDays' in next) {
      const n = Number(next.meetingEveryDays);
      if (!Number.isInteger(n) || n < 1 || n > 90) delete next.meetingEveryDays;
      else next.meetingEveryDays = n;
    }
    if ('checks' in next) {
      const clean = sanitizeChecks(next.checks);
      if (!clean) delete next.checks;
      else next.checks = clean;
    }
    if ('workflows' in next) {
      const clean = sanitizeWorkflowMap(next.workflows);
      if (!clean) delete next.workflows;
      else next.workflows = clean;
    }
    // Каталог серверов молча не чиним: человек заполнял форму руками, и
    // проглоченная ошибка обернулась бы ролью без инструментов, у которой
    // всё «сохранилось». Отказ называет и сервер, и что с ним не так.
    if ('mcpServers' in next) {
      const { servers, problems } = checkMcpServers(next.mcpServers);
      if (problems.length) {
        const first = problems[0];
        return this.say(`state.settings.mcp.${first.key}`, {
          id: first.id || '—', detail: first.detail,
        });
      }
      next.mcpServers = servers;
    }
    // Раскладку, наоборот, молча отбросить нельзя: человек выбрал её сам и
    // ждёт, что офис переставится. Тихо оставленная прежняя выглядела бы как
    // «кнопка не работает», поэтому про неизвестный id говорим прямо.
    if (next.layoutId !== undefined && next.layoutId !== prevLayout && !hasLayout(next.layoutId)) {
      const known = layoutOptions(this.lang()).map((l) => l.id).join(', ')
        || this.say('state.settings.noLayoutsAtAll');
      return this.say('state.settings.noLayout', { id: String(next.layoutId), known });
    }

    this.settings = { ...this.settings, ...next };
    this.emit({ t: 'settings', settings: this.settings });
    if (this.settings.layoutId !== prevLayout) {
      // Раскладка меняет офис на глаз, а не одно число в форме, — это событие
      // для ленты. Вместе с пресетом меняется и оверрайд: у каждого пресета
      // своя расстановка, и на новом офис показывает то, что правили на нём.
      this.addLog(null, 'system',
        this.say('state.layout.changed', { preset: layoutTitle(this.settings.layoutId, this.lang()) }));
      // Прежний пресет передаём дальше: если мест в новом не хватит, офис
      // предложит вернуться именно к нему, по имени.
      this.afterLayoutChange(prevLayout);
    }
    // Лимит исполнителей меняет, сколько денег офис тратит в минуту, — это
    // событие для ленты, а не тихое число в форме. Поднятый лимит ещё и
    // отпускает задачи, стоящие в очереди за слотом: ждать следующего
    // завершения им уже незачем.
    if (this.workerLimit() !== prevWorkers) {
      this.addLog(null, 'system',
        this.say('state.settings.workers', { now: this.workerLimit(), before: prevWorkers }));
      if (this.workerLimit() > prevWorkers) workerLimitWatcher?.();
    }
    // Язык меняет не одно поле, а весь голос офиса: подписи, ленту, брифы
    // базовых ролей и системный промпт менеджера. Поэтому смена языка — это
    // отдельная работа, а не просто новое значение в настройках.
    if (this.lang() !== prevLang) this.applyLanguage(prevLang);
    // Смена режима офиса меняет эффективный режим всех, кто его наследует, —
    // без этого UI показывал бы старое до следующего снимка.
    if (this.settings.officePermissionMode !== prevMode) {
      this.emit({ t: 'roles', roles: this.roleViews() });
      for (const inst of this.instances.values()) {
        this.emit({ t: 'instance', instance: this.instanceView(inst) });
      }
      // Смена режима — событие для человека, а не деталь настроек: с этой
      // минуты меняется, о чём офис перестаёт спрашивать.
      this.addLog(null, 'system',
        this.say('state.settings.officeMode', { mode: modeLabel(this.officeMode(), this.lang()) }));
    }
    this.markDirty();
    return null;
  }

  /**
   * Перевести офис на новый язык.
   *
   * Названия и брифы базовых ролей — тот же текст для человека и для модели,
   * что и подписи в интерфейсе, и оставлять их на прежнем языке нельзя: бриф
   * уезжает в системный промпт исполнителя, а название — на его бейдж.
   * Переводятся только те, которых не правили руками: совпадает с базовым
   * текстом прежнего языка — значит, это наш текст, а не пользовательский.
   */
  private applyLanguage(prevLang: Lang): void {
    const lang = this.lang();
    setProcessLang(lang);
    this.roleList = this.roleList.map((role) => {
      // Роль из пакета просто считается заново на новом языке: бриф и
      // название пакета переводятся, оверрайды и приписка остаются.
      const pkg = role.package ? resolvePackage(role.package) : null;
      if (role.package && pkg) {
        return { ...roleFromPackage(pkg, lang, role.id, role.package), archived: role.archived };
      }
      // Отвязанная от нашего пакета роль: переводим лишь то, что человек
      // не трогал. Роль, заведённую руками, не трогаем вовсе — её слова наши
      // только по форме, а не по смыслу.
      const was = defaultRole(role.id, prevLang);
      if (!was) return role;
      const now = defaultRole(role.id, lang)!;
      return {
        ...role,
        title: role.title === was.title ? now.title : role.title,
        brief: role.brief === was.brief ? now.brief : role.brief,
      };
    });
    // Ярлык сотрудника без имени собран из названия роли — переводится вместе
    // с ним. Имя от владельца не переводится: оно его, а не офиса.
    for (const inst of this.instances.values()) {
      const role = this.role(inst.roleId);
      if (!role) continue;
      inst.label = labelFor(inst.name, role.title, numberOf(inst.id));
      this.emit({ t: 'instance', instance: this.instanceView(inst) });
    }
    this.emit({ t: 'roles', roles: this.roleViews() });
    this.addLog(null, 'system', this.say('state.settings.language', { lang: LANG_TITLE[lang] }));
    // Сессию менеджера перезапускаем всегда, а не только когда перечень ролей
    // стал другим: язык вшит в его системный промпт, и продолжать разговор
    // по-английски в русском офисе он бы не стал.
    roleSetWatcher?.(this);
  }

  /**
   * Личный режим доступа сотрудника: он сильнее режима роли и офиса.
   * null возвращает сотрудника к режиму роли.
   */
  setAgentPermissionMode(instanceId: string, mode: PermissionMode | null): void {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.permissionMode === mode) return;
    inst.permissionMode = mode;
    const view = this.instanceView(inst);
    this.emit({ t: 'instance', instance: view });
    this.addLog(instanceId, 'system', mode
      ? this.say('state.agent.modeSet', { mode: modeLabel(mode, this.lang()) })
      : this.say('state.agent.modeInherited', {
        mode: modeLabel(view.effectivePermissionMode, this.lang()),
      }));
    this.markDirty();
  }

  /**
   * Дать сотруднику имя; пустое — снять, и он снова зовётся по роли. Отказ
   * возвращается готовым текстом, как по найму: слишком длинное или уже
   * занятое имя. Занятость смотрится по подписям всех остальных, включая
   * тех, кто зовётся по роли: два «Backend» в одной комнате — та же путаница,
   * что два Васи.
   */
  setAgentName(instanceId: string, raw: string): string | null {
    const inst = this.instances.get(instanceId);
    if (!inst) return this.say('state.fire.missing');
    const name = cleanName(raw);
    if (name !== null && name.length > MAX_AGENT_NAME) {
      return this.say('state.agent.nameLong', { max: MAX_AGENT_NAME });
    }
    if (name === inst.name) return null;
    const role = this.role(inst.roleId);
    const label = labelFor(name, role?.title ?? inst.roleId, numberOf(inst.id));
    const taken = [...this.instances.values()]
      .find((i) => i.id !== inst.id && i.label.toLowerCase() === label.toLowerCase());
    if (taken) return this.say('state.agent.nameTaken', { name: taken.label, id: taken.id });
    const before = inst.label;
    inst.name = name;
    inst.label = label;
    this.emit({ t: 'instance', instance: this.instanceView(inst) });
    this.addLog(instanceId, 'system', name
      ? this.say('state.agent.named', { before, name })
      : this.say('state.agent.unnamed', { before, label }));
    this.markDirty();
    return null;
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
   * Сколько исполнителей офиса могут работать одновременно. Читается на каждой
   * проверке, а не запоминается: поднятый в настройках лимит обязан подействовать
   * на следующую же задачу, без перезапуска.
   */
  workerLimit(): number {
    return sanitizeWorkers(this.settings.maxConcurrentWorkers) ?? DEFAULT_OFFICE_WORKERS;
  }

  /**
   * Нанять сотрудника роли. Возвращает причину отказа по-русски или null,
   * если наняли. Роль без сотрудников — это открытая вакансия, а не удалённая
   * роль: нанять обратно можно в любой момент.
   */
  hire(roleId: string): string | null {
    const role = this.role(roleId);
    if (!role) return this.say('state.role.missing', { role: roleId });
    // Архивная роль находится по id ради истории, но нанимать в неё нельзя:
    // её для того и убрали, чтобы офис перестал в ней работать.
    if (role.archived) {
      return this.say('state.hire.archived', { title: role.title });
    }
    // В роли один сотрудник. Второго такого же заводит `hireCopy` — он
    // придёт отдельной ролью, со своим названием и внешностью.
    if (this.staffOf(roleId).length) return this.say('state.hire.taken', { title: role.title });
    const inst = this.spawn(roleId);
    if (!inst) {
      // Верхняя граница штата — число столов в раскладке ЭТОГО офиса:
      // в тесной раскладке офис вмещает меньше людей, чем в просторной.
      return this.say('state.hire.noDesk', {
        preset: layoutTitle(this.settings.layoutId, this.lang()), desks: this.deskPlan().desks.length,
      });
    }
    this.addLog(null, 'system', this.say('state.hire.done', { label: inst.label, id: inst.id }));
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
    if (!inst) return this.say('state.fire.missing');
    const role = this.role(inst.roleId);
    if (role?.isManager) return this.say('state.fire.pm');
    if (inst.currentTaskId) {
      return this.say('state.fire.busy', { label: inst.label, task: inst.currentTaskId });
    }
    inst.abort?.abort();
    this.instances.delete(instanceId);
    // Стол освобождается вместе с инстансом: свободные места считаются
    // по живым сотрудникам, отдельного реестра занятости нет.
    this.emit({ t: 'instance.remove', id: instanceId });
    this.emit({ t: 'roles', roles: this.roleViews() });
    const left = this.staffOf(inst.roleId).length;
    this.addLog(null, 'system', this.say('state.fire.done', { label: inst.label, id: inst.id })
      + (left === 0
        ? this.say('state.fire.roleEmpty', { title: role?.title ?? inst.roleId })
        : ''));
    this.markDirty();
    return null;
  }

  setMeeting(meeting: MeetingView | null): void {
    this.meeting = meeting;
    // В историю — каждое состояние совещания, а не только итог: окно
    // совещаний показывает и то, что идёт сейчас, и кто в нём говорит.
    // null — совещание ушло со стола, из истории оно не уходит.
    if (meeting) {
      const i = this.meetings.findIndex((m) => m.id === meeting.id);
      if (i >= 0) this.meetings[i] = meeting;
      else this.meetings.push(meeting);
      this.markDirty();
    }
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
    // Запоминаем сразу, а не отложенной записью состояния: между нажатием
    // паузы и закрытием сервера может не быть и секунды, а проснуться офис
    // обязан таким, каким его оставили.
    setOfficePaused(this.officeId, paused);
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

  /**
   * Положить свежие проверки окружения и сообщить о них UI. Время ставится
   * здесь: «когда считали» — свойство записи, а не того, кто её заказал.
   */
  setEnv(checks: EnvCheck[]): EnvReport {
    const wasBad = this.env.at > 0 && criticalEnvFail(this.env.checks) !== null;
    this.env = { checks, at: Date.now() };
    this.emit({ t: 'env', env: this.env });
    // Единственное место, где видно переход «красное → зелёное»: проверки
    // пересчитываются из полудюжины мест, и если отпускать очередь в каждом,
    // они разойдутся. Красное окружение ждущих не трогает — их пометит
    // ближайшая попытка раздачи.
    if (wasBad && criticalEnvFail(checks) === null) envReadyWatcher?.(this);
    return this.env;
  }

  /** Сообщить UI о готовности облачного режима. */
  setCloud(patch: Partial<CloudStatus>): void {
    this.cloud = { ...this.cloud, ...patch };
    this.emit({ t: 'cloud', cloud: this.cloud });
  }

  // ---------- пулл-реквесты ----------

  /** Пулл-реквест задачи. null — конвейер по ней ещё не начинался. */
  prOf(taskId: string): PullRequestView | null {
    return this.prs.get(taskId) ?? null;
  }

  /**
   * Завести пулл-реквест задачи (или вернуть заведённый). Заводится он в самом
   * начале конвейера, ещё до похода в GitHub: стадии «подтягиваю базу» и
   * «жду ревью» тоже надо где-то показывать, и это то же самое дело.
   */
  startPr(input: {
    taskId: string; title: string; branch: string; base: string; repoDir: string;
  }): PullRequestView {
    const now = Date.now();
    const pr: PullRequestView = this.prs.get(input.taskId) ?? {
      id: `PR-${input.taskId}`,
      taskId: input.taskId,
      title: input.title,
      branch: input.branch,
      base: input.base,
      repoDir: input.repoDir,
      number: null,
      url: null,
      stage: 'sync',
      note: this.say('state.pr.pullingBase'),
      rounds: 0,
      retries: 0,
      nextTryAt: null,
      needsDecision: false,
      reviewerId: null,
      reviews: [],
      createdAt: now,
      updatedAt: now,
      gate: null,
    };
    // Повторный заход (перезапуск конвейера) не заводит второй PR, но
    // возвращает его к началу: ветка снова расходится с базой.
    pr.title = input.title;
    pr.branch = input.branch;
    pr.base = input.base;
    pr.repoDir = input.repoDir;
    this.prs.set(pr.taskId, pr);
    this.emit({ t: 'pr', pr });
    this.markDirty();
    return pr;
  }

  /** Сдвинуть пулл-реквест по конвейеру. Возвращает обновлённый вид. */
  patchPr(taskId: string, patch: Partial<PullRequestView>): PullRequestView | null {
    const pr = this.prs.get(taskId);
    if (!pr) return null;
    Object.assign(pr, patch, { updatedAt: Date.now() });
    this.emit({ t: 'pr', pr });
    this.markDirty();
    return pr;
  }

  /** Записать отзыв ревьюера в историю пулл-реквеста. */
  addReview(taskId: string, note: ReviewNote): void {
    const pr = this.prs.get(taskId);
    if (!pr) return;
    pr.reviews.push(note);
    pr.reviewerId = note.reviewerId;
    pr.updatedAt = Date.now();
    this.emit({ t: 'pr', pr });
    this.markDirty();
  }

  // ---------- прогоны процессов ----------

  /** Прогон процесса по задаче. null — процесс по ней ещё не начинался. */
  runOf(taskId: string): Run | null {
    for (const run of this.runs.values()) {
      if (run.subject.taskId === taskId) return run;
    }
    return null;
  }

  /** Запомнить прогон и показать его интерфейсу. */
  saveRun(run: Run): void {
    this.runs.set(run.id, run);
    this.emit({ t: 'run', run });
    this.markDirty();
  }

  /**
   * Свободный сотрудник, который умеет всё из `needs` (spec процессов §5).
   * Сначала свободные, потом клон в пределах maxInstances роли. Нет никого
   * с такими умениями вовсе — null и `empty: true`: ждать некого.
   */
  findCapable(needs: readonly string[], opts: { exclude?: string[] } = {}): { inst: Instance | null; empty: boolean } {
    const fits = (roleId: string) => {
      const role = this.role(roleId);
      if (!role || role.isManager || role.archived) return false;
      const caps = capabilitiesOf(role);
      return needs.every((n) => caps.includes(n as Capability));
    };
    const roles = this.roleList.filter((r) => fits(r.id));
    if (!roles.length) return { inst: null, empty: true };
    const exclude = new Set(opts.exclude ?? []);
    const free = [...this.instances.values()].find(
      (i) => !i.currentTaskId && !exclude.has(i.id) && fits(i.roleId),
    );
    if (free) return { inst: free, empty: false };
    for (const role of roles) {
      const spawned = this.spawn(role.id);
      if (spawned && !exclude.has(spawned.id)) return { inst: spawned, empty: false };
    }
    return { inst: null, empty: false };
  }

  /** Тип задачи для роли — по её способностям. Роли нет — процесса нет. */
  typeForRole(roleId: string | null): TaskType | null {
    const role = roleId ? this.role(roleId) : null;
    return role ? typeForCapabilities(capabilitiesOf(role)) : null;
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

  /**
   * Из чего офис может выбрать раскладку. Читается с диска, а не хранится:
   * пресеты в этом проекте добавляют не выключая офис.
   */
  layouts(): LayoutOption[] {
    return layoutOptions(this.lang());
  }

  snapshot(): ServerEvent {
    return {
      t: 'snapshot',
      roles: this.roleViews(),
      instances: this.instanceViews(),
      tasks: [...this.tasks.values()].map(toTaskView),
      epics: this.epicList().map(toEpicView),
      mcpStatus: this.mcpStatuses(),
      chat: this.chat,
      drafts: [...this.drafts.values()],
      log: this.log.slice(-200),
      permissions: this.pendingRequests(),
      settings: this.settings,
      projectDir: this.projectDir,
      authSource: this.authSource,
      meeting: this.meeting,
      meetings: this.meetings,
      busy: this.busy,
      paused: this.paused,
      usage: { total: this.usage, days: this.usageDays() },
      limits: limitsView(),
      offices: officeViews(),
      layouts: this.layouts(),
      layout: this.layout(),
      layoutOverride: this.override(),
      cloud: this.cloud,
      env: this.env,
      mergeChecks: [...this.mergeChecks.values()],
      mergeRun: this.mergeRun,
      prs: [...this.prs.values()],
      runs: [...this.runs.values()],
      workflows: workflowCatalog(this),
      facts: this.factList().map(toFactView),
      questions: this.questionList(),
      openQuestions: this.openQuestionCount(),
      life: this.lifeView(),
      directions: this.directionList(),
      proposals: this.proposalList().map(toProposalView),
    };
  }
}

/**
 * Вопрос ещё ждёт владельца: без ответа и не снятый. Признак живёт здесь, а не
 * в questions.ts, чтобы счётчик в снапшоте и отбор в планёрку не разъехались:
 * `openQuestions` из questions.ts фильтрует этим же.
 */
export const isOpenQuestion = (q: OwnerQuestion): boolean => !q.answeredAt && !q.dismissedAt;

/** Запись журнала для клиента: без служебной отметки «уже спрашивали». */
export const toFactView = (f: Fact): FactView => ({
  id: f.id, kind: f.kind, text: f.text, scope: f.scope, source: f.source,
  createdAt: f.createdAt, confirmedAt: f.confirmedAt, status: f.status,
});

/** Предложение для клиента: без плана фичи — он нужен только серверу. */
export const toProposalView = (p: Proposal): ProposalView => ({
  id: p.id, kind: p.kind, title: p.title, text: p.text, rationale: p.rationale,
  roleId: p.roleId, setting: p.setting, directionId: p.directionId,
  status: p.status, createdAt: p.createdAt, decidedAt: p.decidedAt,
});

/**
 * Список офисов для UI: реестр, отметка текущего и сводка активности.
 * Из памяти берём сводку по КАЖДОМУ поднятому офису, а не только по текущему:
 * покинутый офис продолжает работать, и его файл отстаёт на дебаунс записи —
 * счётчик «в работе» в списке иначе врал бы про идущие там задачи.
 *
 * Порядок здесь и есть порядок списка на экране: `offices()` отдаёт офисы уже
 * упорядоченными (`compareOffices`), и оба ключа этого порядка — ручная
 * расстановка `order` и время создания `createdAt` — уезжают в веб, чтобы
 * рейл, модалка и главный экран сортировали одинаково, а не каждый по-своему.
 */
export const officeViews = (): OfficeView[] => {
  const current = currentOffice();
  return offices().map((o) => {
    const live = states.get(o.id);
    const icon = officeIconView(o);
    return {
      id: o.id, name: o.name, projectDir: o.projectDir, noProject: o.noProject === true,
      current: o.id === current?.id, createdAt: o.createdAt, lastOpenedAt: o.lastOpenedAt,
      // Ручной порядок уезжает только если он есть: «руками не двигали» и
      // «стоит нулевым» для сортировки разные вещи — во втором случае офис
      // всплыл бы наверх списка.
      ...(typeof o.order === 'number' ? { order: o.order } : {}),
      // Поля нет, если иконку не задавали: «нет иконки» и «иконка пустая» для
      // веба разные вещи — во втором случае он рисовал бы пустоту. Картинка
      // уезжает адресом, а не путём к файлу: с диска браузер её не откроет,
      // а файл иконки вообще может лежать вне проекта (см. officeIconView).
      // Пропавший файл — тоже «нет иконки»: рисовать сломанную картинку хуже,
      // чем инициалы.
      ...(icon ? { icon } : {}),
      activity: live?.opened
        ? {
          ...summarize({
            tasks: [...live.tasks.values()], chat: live.chat, log: live.log,
            // У поднятого офиса расход берём из памяти, а не из файла: запись
            // отложена на дебаунс, и список показывал бы вчерашние цифры
            // ровно там, где тратят прямо сейчас.
            usage: live.usage, daily: live.daily,
          }),
          // «Кто-то работает прямо сейчас» видно только по живым сессиям:
          // задача в статусе in_progress остаётся такой и после перезапуска,
          // а разговор менеджера вообще не заводит задач.
          live: hasLiveSessions(live),
          // Запрос доступа в покинутом офисе останавливает там работу: агент
          // замер на вызове инструмента и ждёт человека, который смотрит
          // другой проект. В списке это должно быть видно.
          waiting: live.pendingRequests().length,
          // Пауза покинутого офиса из списка тоже видна: иначе «простаивает»
          // и «стоит на паузе» выглядели бы одинаково, а это разные вещи —
          // во втором случае работа не начнётся сама.
          paused: live.paused,
        }
        // Неподнятый офис тоже может стоять на паузе: признак лежит в реестре,
        // а не в файле состояния, поэтому за ним никуда идти не надо.
        // Сводку из файла копируем — её отдаёт кеш, и править его нельзя.
        : { ...activityFromFile(o.stateFile), paused: o.paused === true },
    };
  });
};

/** Идут ли в офисе живые сессии: исполнители, менеджер или прямые разговоры. */
const hasLiveSessions = (state: OfficeState): boolean =>
  state.running > 0 || Boolean(state.pmLoop) || state.talks.size > 0 || state.meetingRunning;

export const toEpicView = (e: Epic): EpicView => ({
  id: e.id, title: e.title, goal: e.goal, order: e.order,
  status: e.status, approved: e.approved,
  origin: e.origin ?? 'owner', rationale: e.rationale ?? '', directionId: e.directionId ?? null,
  createdAt: e.createdAt, startedAt: e.startedAt, finishedAt: e.finishedAt,
});

export const toTaskView = (t: Task): TaskView => ({
  id: t.id, title: t.title, description: t.description,
  criteria: t.criteria, roleId: t.roleId,
  assigneeId: t.assigneeId, status: t.status, result: t.result,
  epicId: t.epicId ?? null, order: t.order ?? 0, dependsOn: t.dependsOn ?? [],
  // Веб про старые форматы не знает: в снимке приоритет есть всегда.
  priority: asTaskPriority(t.priority),
  files: t.files, branch: t.branch, baseBranch: t.baseBranch,
  worktreePath: t.worktreePath, repoDir: t.repoDir ?? null, merged: t.merged,
  interrupted: t.interrupted, limitedAt: t.limitedAt ?? null,
  envWait: t.envWait ?? null, createdAt: t.createdAt,
  startedAt: t.startedAt, finishedAt: t.finishedAt,
  usage: t.usage,
  today: t.daily?.[dayKey()] ?? emptyUsage(),
  outcome: t.outcome ?? null,
  type: t.type ?? null,
  handoff: t.handoff ?? null,
  branchMark: t.branchMark ?? null,
});

/**
 * Репозиторий, в котором велась задача. Путь берётся с самой задачи: настройка
 * роли могла с тех пор смениться, а результат лежит там, где его сделали.
 * У задач, заведённых до появления репозиториев на роль, поля нет — для них
 * это директория офиса. Офис передаётся явно и обязательно: офисов в памяти
 * несколько, у каждого своя директория, и «текущий на процесс» отправил бы
 * работу покинутого офиса в чужой проект.
 */
export const taskRepo = (t: Task, state: OfficeState): string =>
  t.repoDir ?? state.projectDir;

/**
 * Куда складываем рабочие копии задач — вне репозитория пользователя, чтобы не
 * сорить в нём. У каждого офиса своя папка: номера задач в разных проектах
 * совпадают, и общий корень склеил бы чужие рабочие копии.
 *
 * Живёт здесь, а не в agents.ts: путь считают и запуск задачи, и конвейер
 * ревью, а разойдясь на символ, они начали бы работать с разными копиями.
 */
export const worktreesRoot = (state: OfficeState): string =>
  resolve(process.cwd(), '.office/worktrees', state.officeId);

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
  // Сохранения до надзора этих полей не знают: отсутствие — это «не прерывалась»
  // и «менеджеру не показывали».
  // Сохранения до плана не знают ни фичи, ни порядка, ни зависимостей.
  // Отсутствие — это «задача вне плана»: такая раздаётся сразу, как и
  // раздавалась, и ничьей готовности не ждёт.
  // Журнала по дням в старых сохранениях нет, и восстановить его из общей
  // суммы нельзя: разложить её по прошедшим дням было бы выдумкой. Пустой
  // журнал честнее — «за сегодня» у такой задачи ноль, пока она не поработает.
  // Исходов в сохранениях до живого офиса нет: закрытые тогда задачи остаются
  // без исхода, а не получают выдуманный, — табель считается с этого дня.
  return {
    ...raw, criteria, usage, daily: raw.daily ?? {},
    interrupted: raw.interrupted ?? false, limitedAt: raw.limitedAt ?? null,
    // Ожидание окружения на диск попадает, но живёт недолго: окружение
    // пересчитывается на старте офиса, и текст причины там же обновится.
    envWait: raw.envWait ?? null,
    attention: raw.attention ?? null,
    workerSessionId: raw.workerSessionId ?? null, reviewerSessionId: raw.reviewerSessionId ?? null,
    epicId: raw.epicId ?? null, order: raw.order ?? 0, dependsOn: raw.dependsOn ?? [],
    // Приоритета в сохранениях до него нет, и угадывать его по чему-либо
    // нельзя: «средний» — это ровно то, чем такая задача и была.
    priority: asTaskPriority(raw.priority),
    outcome: raw.outcome ?? null, mergeCommit: raw.mergeCommit ?? null,
    // Сжатий в старых сохранениях нет: «не знаем» считаем нулём, а не
    // выдумываем — сводка здоровья скорее промолчит, чем соврёт.
    compactions: raw.compactions ?? 0, compactedAt: raw.compactedAt ?? null,
    // Метки на ветках в старых сохранениях нет: «не помечена» — разбор завалов
    // пройдёт по ней сам и пометит, если ветка правда повисла.
    branchMark: raw.branchMark ?? null, branchMarkAt: raw.branchMarkAt ?? null,
  };
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
 * сокет живёт дольше открытого офиса. Держим их отдельно от подписчиков
 * состояния: состояние подписывается на них один раз при создании, поэтому
 * ни переключение, ни повторный вход в офис не копят дубли рассылки.
 */
const followers = new Set<OfficeListener>();

/** Состояние офиса по id: уже поднятое либо пустое, заведённое сейчас. */
export function getOffice(officeId: string): OfficeState {
  const found = states.get(officeId);
  if (found) return found;
  const created = new OfficeState(officeId);
  // Одна переходная подписка на состояние — она и раздаёт событие всем
  // подписчикам с меткой офиса. Подписывать каждого follower отдельно нельзя:
  // метку пришлось бы добавлять обёрткой, а обёртка каждый раз новая — и
  // повторный вход в офис копил бы дубли рассылки.
  created.subscribe((e) => {
    for (const fn of followers) fn(e, officeId);
  });
  states.set(officeId, created);
  return created;
}

/**
 * Сколько сессий исполнителей живо во всём процессе — сумма по всем офисам,
 * поднятым в память. Именно эта сумма упирается в общий потолок: офисов может
 * быть открыто сколько угодно, а машина и счёт за токены у пользователя одни.
 * Считаем по всем состояниям, а не только по «открытым»: покинутый офис
 * продолжает работать, и его сессии тратят деньги наравне с текущим.
 */
export function totalRunningWorkers(): number {
  let total = 0;
  for (const state of states.values()) total += state.running;
  return total;
}

/** Все офисы, поднятые в память, — в порядке первого обращения к ним. */
export function loadedOffices(): OfficeState[] {
  return [...states.values()];
}

/**
 * Задачи, которые прямо сейчас выполняются в офисе. Смотрим только на уже
 * поднятое состояние: не открытый офис ничего не выполняет, и заводить ему
 * состояние ради проверки незачем. Нужно тем, кто трогает офис со стороны, —
 * покинутый офис продолжает работать, и «в нём никого нет» больше не следует
 * из того, что открыт другой.
 */
export function runningTasksOf(officeId: string): string[] {
  const state = states.get(officeId);
  if (!state?.opened) return [];
  return [...state.tasks.values()].filter((t) => t.status === 'in_progress').map((t) => t.id);
}

/**
 * Поднят ли офис: состояние с доской и сессиями уже живёт в памяти.
 * Заведённая, но не открытая заготовка (её создаёт getOffice) — это ещё
 * не офис, и командам с ней делать нечего.
 */
export function isOpened(officeId: string): boolean {
  return states.get(officeId)?.opened === true;
}

/**
 * Все поднятые офисы. Нужно тому, что относится к процессу целиком, а не к
 * одному проекту, — например появившемуся токену GitHub: он одинаково меняет
 * готовность облачного режима у каждого офиса, включая те, что сейчас никто
 * не смотрит.
 */
export function openedOffices(): OfficeState[] {
  return [...states.values()].filter((s) => s.opened);
}

/**
 * Подписка на события всех офисов — и открытых сейчас, и тех, которые
 * откроются позже. Отписки нет намеренно: подписчик здесь один — рассылка
 * по сокетам, и живёт она столько же, сколько процесс.
 */
export function subscribeOffices(fn: OfficeListener): void {
  // Set делает повторную подписку тем же обработчиком пустой, так что второй
  // вызов не удваивает рассылку.
  followers.add(fn);
}

/**
 * Открыть офис. Первое открытие поднимает состояние из своего файла,
 * повторное — берёт уже поднятое из памяти: доска, расходы и разговоры офиса
 * переживают переключение туда и обратно.
 *
 * Ссылки «офис, открытый последним» здесь намеренно нет: офисов в памяти
 * несколько и работают они одновременно, поэтому состояние берут только по id
 * — по подписке клиента (office-api.stateFor) или по задаче, которая его
 * захватила. Общая ссылка на процесс отправила бы работу покинутого офиса
 * в чужую доску.
 *
 * `restored` — подняли с диска сейчас, `reused` — офис уже был открыт в этом
 * процессе; оба false означают новый офис, начатый с чистого листа.
 */
/**
 * `entry.initTeam` — с кем офис начинает, если сохранения нет: с набором по
 * умолчанию (`default-office.json`) или только с менеджером. Второе — офис
 * из мастера: кого нанимать, сказал план, и набор «все десять» ему не нужен.
 */
export function openOfficeState(
  entry: {
    id: string; projectDir: string; stateFile: string;
    initTeam?: 'manager-only'; paused?: boolean;
  },
): { state: OfficeState; restored: boolean; reused: boolean } {
  const state = getOffice(entry.id);
  if (state.opened) return { state, restored: false, reused: true };

  state.projectDir = entry.projectDir;
  state.setStateFile(entry.stateFile);
  state.opened = true;
  const restored = state.restore();
  if (!restored && entry.initTeam === 'manager-only') state.startWithManagerOnly();
  // Офис с чистого листа начинается и с чистых ролей: правки ролей
  // принадлежат офису, и у нового их просто нет.
  if (!restored) state.seed();
  // Паузу вспоминаем последним шагом — и обязательно после seed(), который
  // сбрасывает её вместе со всем остальным. Запись реестра уже содержит поле,
  // а неполной заготовке (так офисы заводят проверки) отвечает сам реестр.
  // Раньше первой раздачи задач: и надзор, и планировщик включаются после
  // открытия, и оба смотрят на этот признак.
  state.paused = entry.paused ?? officePaused(entry.id);
  return { state, restored, reused: false };
}

/**
 * Выгрузить офис из памяти: дописать состояние на диск, закрыть живые сессии
 * и убрать состояние из реестра. Обратное к openOfficeState.
 *
 * Сохранение на диске остаётся нетронутым: офис убирают из списка, а не
 * стирают, и вернувшись, он поднимет с диска ту же доску, те же расходы и тот
 * же разговор. Стирание — это wipe(), и делается оно только по кнопке сброса.
 *
 * Возвращает false, если офис в памяти и не жил: выгружать было нечего.
 */
export function unloadOfficeState(officeId: string): boolean {
  const state = states.get(officeId);
  if (!state) return false;
  state.closeSessions();
  // Хвост отложенной записи дописываем последним шагом и тем же вызовом
  // запираем запись: закрытие сессий само дописывает в состояние, а поздние
  // сообщения уже прибитых сессий не должны попасть ни в файл, ни в ленту.
  state.retire();
  // Состояние уходит из реестра целиком: возврат в офис поднимет новое из
  // того же файла. Ссылки на старое при этом ещё живут — их держат
  // догорающие сессии, — и молчит оно не потому, что его никто не помнит,
  // а потому, что retire его запер.
  states.delete(officeId);
  return true;
}

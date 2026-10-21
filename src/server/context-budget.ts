/**
 * Замер постоянного контекста роли: сколько символов роль несёт в КАЖДОЙ
 * сессии ещё до первого слова задачи (D-8, идея C; в harness2 это
 * `always_on_max`). Постоянное — то, что от задачи не зависит:
 *
 *   brief        бриф пакета (`brief/<lang>.md`) или свой бриф роли без пакета;
 *   briefExtra   приписка роли к брифу пакета;
 *   rules        блок правил офиса и кругов — ровно тот, что уезжает в промпт;
 *   journal      порция журнала в промпте;
 *   skills       описания скилов пакета: модель видит их всегда, а сам скил
 *                читает, только когда дело дошло до него.
 *
 * Бриф офиса (OFFICE.md) и бриф зоны сюда не входят: они общие на весь офис,
 * и роль на их длину не влияет.
 *
 * Замер ничего не блокирует: превышение порога и скилы без внятного описания —
 * повод поправить пакет, а не отказ запускать сессию.
 */
import { alwaysOnMax, MIN_SKILL_DESCRIPTION } from './context-limits';
import { journalBrief } from './journal';
import type { Role } from './roles';
import { rulesBrief } from './rules';
import { employeePack } from './skills';
import type { OfficeState } from './state';

export { alwaysOnMax, DEFAULT_ALWAYS_ON_MAX, MIN_SKILL_DESCRIPTION } from './context-limits';

export type ContextPart = 'brief' | 'briefExtra' | 'rules' | 'journal' | 'skills';

export interface SkillWarning {
  /** Полное имя скила, `<плагин>:<скил>`. */
  skill: string;
  /** Описание как есть; пустое — не нашлось. */
  description: string;
  reason: 'empty' | 'short';
}

export interface ContextBudget {
  roleId: string;
  /** Символы по частям. */
  parts: Record<ContextPart, number>;
  /** Сумма частей. */
  total: number;
  /** Действующий порог. */
  limit: number;
  /** На сколько символов порог превышен; 0 — уложились. */
  over: number;
  /** Скилы с пустым или слишком коротким описанием. */
  skillWarnings: SkillWarning[];
  /**
   * Встроенные скилы агента (`builtin` в манифесте): их описания живут у
   * агента, а не в пакете, и в замер не входят — названы, чтобы было видно,
   * что не посчитано.
   */
  unmeasuredSkills: string[];
}

/**
 * Бриф роли на две части. `Role.brief` уже склеен из брифа пакета и приписки
 * (`roleFromPackage`) — режем обратно, чтобы мерить ровно то, что уехало в
 * промпт, а не перечитывать пакет на другом языке.
 */
function splitBrief(role: Role): { brief: string; extra: string } {
  const extra = role.package?.briefExtra.trim() ?? '';
  if (!extra || !role.brief.endsWith(extra)) return { brief: role.brief, extra: '' };
  return { brief: role.brief.slice(0, role.brief.length - extra.length).trimEnd(), extra };
}

/** Скилы пакета: длина описаний и те, у кого описание пустое или общее. */
export function skillsBudget(role: Role): { chars: number; warnings: SkillWarning[]; unmeasured: string[] } {
  const pack = employeePack(role);
  if (!pack) return { chars: 0, warnings: [], unmeasured: [] };
  let chars = 0;
  const warnings: SkillWarning[] = [];
  const unmeasured: string[] = [];
  for (const skill of pack.skills) {
    if (!(skill in pack.descriptions)) { unmeasured.push(skill); continue; }
    const description = pack.descriptions[skill].trim();
    // Модель видит имя и описание — их и считаем.
    chars += skill.length + description.length;
    if (!description) warnings.push({ skill, description, reason: 'empty' });
    else if (description.length < MIN_SKILL_DESCRIPTION) warnings.push({ skill, description, reason: 'short' });
  }
  return { chars, warnings, unmeasured };
}

/**
 * Постоянный контекст роли по частям. Правила и журнал берутся теми же
 * функциями, что собирают системный промпт, — для сессии вне задачи (зона —
 * единственная зона роли), так что замер совпадает с тем, что роль получает.
 */
export function contextBudget(state: OfficeState, role: Role): ContextBudget {
  const { brief, extra } = splitBrief(role);
  // Менеджер в промпте идёт с roleId = null: ему достаются все круги правил
  // и офисные записи журнала вместо своих.
  const promptRole = role.isManager ? null : role.id;
  const skills = skillsBudget(role);
  const parts: Record<ContextPart, number> = {
    brief: brief.length,
    briefExtra: extra.length,
    rules: rulesBrief(state, promptRole).trim().length,
    journal: journalBrief(state, promptRole).trim().length,
    skills: skills.chars,
  };
  const total = Object.values(parts).reduce((sum, n) => sum + n, 0);
  const limit = alwaysOnMax(state.settings.alwaysOnMax);
  return {
    roleId: role.id,
    parts,
    total,
    limit,
    over: Math.max(0, total - limit),
    skillWarnings: skills.warnings,
    unmeasuredSkills: skills.unmeasured,
  };
}

/** Не чаще раза в сутки на роль — лента не должна повторять одно и то же. */
export const BUDGET_NOTE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Когда роль последний раз попала в ленту с превышением — по офису. В памяти:
 * после перезапуска сервера роль скажет о себе ещё раз, и это не беда.
 */
const lastNoted = new WeakMap<OfficeState, Map<string, number>>();

/**
 * Старт сессии исполнителя: превысила роль порог — одна строка в ленту офиса,
 * не чаще раза в сутки на роль. Ничего не блокирует; ошибка замера (битый
 * пакет, нечитаемый файл) сессию не роняет. Возвращает, записано ли событие.
 */
export function noteContextBudget(state: OfficeState, role: Role, now = Date.now()): boolean {
  let budget: ContextBudget;
  try {
    budget = contextBudget(state, role);
  } catch {
    return false;
  }
  if (!budget.over) return false;
  let seen = lastNoted.get(state);
  if (!seen) lastNoted.set(state, (seen = new Map()));
  const last = seen.get(role.id);
  if (last !== undefined && now - last < BUDGET_NOTE_EVERY_MS) return false;
  seen.set(role.id, now);
  const p = budget.parts;
  state.addLog(null, 'system', state.say('budget.session.over', {
    role: role.title, total: budget.total, limit: budget.limit, over: budget.over,
    brief: p.brief, extra: p.briefExtra, rules: p.rules, journal: p.journal, skills: p.skills,
  }));
  return true;
}

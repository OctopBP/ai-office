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
import { journalBrief } from './journal';
import type { Role } from './roles';
import { rulesBrief } from './rules';
import { employeePack } from './skills';
import type { OfficeState } from './state';

/** Порог по умолчанию — как `always_on_max` в harness2. */
export const DEFAULT_ALWAYS_ON_MAX = 24_000;

/**
 * Описание скила короче этого — «слишком общее»: по нему модель не поймёт,
 * когда скил открывать, и либо не откроет его вовсе, либо будет открывать зря.
 */
export const MIN_SKILL_DESCRIPTION = 40;

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
 * Действующий порог: переменная `OFFICE_ALWAYS_ON_MAX`, затем настройка офиса
 * `alwaysOnMax`, затем 24 000. Негодное значение (не целое, ноль, меньше
 * нуля) пропускается, а не обнуляет порог.
 */
export function alwaysOnMax(setting?: number | null, env = process.env.OFFICE_ALWAYS_ON_MAX): number {
  for (const raw of [env, setting]) {
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_ALWAYS_ON_MAX;
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

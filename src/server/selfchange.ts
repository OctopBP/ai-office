/**
 * Офис меняет себя (docs/design/living-office/spec.md §8.1) — но только с
 * одобрения владельца и только там, где ему это позволено.
 *
 * Правило одно: всё, что меняет поведение исполнителей, офис не пишет молча.
 * Правило для роли — в приписку к брифу пакета (`briefExtra`; сам бриф
 * пакета неприкосновенен) либо, у роли без пакета, в конец её брифа под
 * заголовком; правило вида 'domain' (знание о проекте) — в журнал, а не в
 * бриф. Настройка — только из белого списка, и это короткие числа,
 * которые нельзя перепутать с правами: модель, инструменты и режим доступа
 * офис не трогает никогда.
 */
import type { ProposalView } from '../shared/types';
import { findRoleRules, ROLE_RULES_HEADERS } from './rules';
import type { OfficeState, PlannedEpicLike } from './state';
import { sanitizeFocus, sanitizeMaxTurns, sanitizeRitualLimit } from './state';

/** Настройки, которые офис вправе предложить, и как их причесать. */
const SETTING_WHITELIST: Record<string, (value: unknown) => number | null | undefined> = {
  taskMaxTurns: sanitizeMaxTurns,
  focusEpics: sanitizeFocus,
  ritualLimitThreshold: sanitizeRitualLimit,
};

export const isProposableSetting = (key: string): boolean => key in SETTING_WHITELIST;


/**
 * Применить принятое предложение. Возвращает причину отказа готовым
 * текстом или null. Фичи сюда не попадают — их заводит initiatives.ts.
 */
export function applyProposal(
  state: OfficeState, proposal: ProposalView & { plan: PlannedEpicLike | null },
): string | null {
  if (proposal.kind === 'rule') {
    const role = proposal.roleId ? state.role(proposal.roleId) : undefined;
    if (!role) return state.say('state.role.missing', { role: proposal.roleId ?? '—' });
    const rule = proposal.text.trim();
    // Знание о проекте в бриф не пишем: бриф с припиской уезжает в пакет
    // роли при экспорте, а нашему проекту там не место (D-8 §3, идея D).
    // Ложится решением в журнал, в круг этой роли.
    if (proposal.ruleKind === 'domain') {
      const fact = state.addFact({
        kind: 'decision', text: rule, scope: `role:${role.id}`,
        evidence: [proposal.id], source: { ritual: 'reflect' },
      });
      state.addLog(null, 'system', state.say('proposal.domainRuleLog', { id: proposal.id, role: role.id, fact: fact.id }));
      return null;
    }
    if (role.package) {
      const extra = role.package.briefExtra.trim();
      state.updateRole(role.id, { briefExtra: extra ? `${extra}\n${rule}` : rule });
    } else {
      const brief = role.brief.trimEnd();
      // Раздел уже есть (на любом из языков) — дописываем в него; нет —
      // заводим заголовком на языке брифа, то есть общения офиса.
      const tail = findRoleRules(brief) ? `\n${rule}` : `\n\n${ROLE_RULES_HEADERS[state.lang()]}\n${rule}`;
      state.updateRole(role.id, { brief: brief + tail });
    }
    state.addLog(null, 'system', state.say('proposal.ruleLog', { id: proposal.id, role: role.id }));
    return null;
  }
  if (proposal.kind === 'setting') {
    const key = proposal.setting?.key ?? '';
    const sanitize = SETTING_WHITELIST[key];
    if (!sanitize) return state.say('proposal.settingRefused', { key });
    const value = sanitize(proposal.setting?.value);
    if (value === undefined) return state.say('proposal.settingRefused', { key });
    const problem = state.updateSettings({ [key]: value });
    if (problem) return problem;
    state.addLog(null, 'system', state.say('proposal.settingLog', { id: proposal.id, key, value: String(value) }));
    return null;
  }
  return null;
}

/**
 * Офис меняет себя (docs/design/living-office/spec.md §8.1) — но только с
 * одобрения владельца и только там, где ему это позволено.
 *
 * Правило одно: всё, что меняет поведение исполнителей, офис не пишет молча.
 * Правило для роли — в приписку к брифу пакета (`briefExtra`; сам бриф
 * пакета неприкосновенен) либо, у роли без пакета, в конец её брифа под
 * заголовком. Настройка — только из белого списка, и это короткие числа,
 * которые нельзя перепутать с правами: модель, инструменты и режим доступа
 * офис не трогает никогда.
 */
import type { ProposalView } from '../shared/types';
import type { OfficeState, PlannedEpicLike } from './state';
import { sanitizeFocus, sanitizeMaxTurns, sanitizeRitualLimit } from './state';

/** Настройки, которые офис вправе предложить, и как их причесать. */
const SETTING_WHITELIST: Record<string, (value: unknown) => number | null | undefined> = {
  taskMaxTurns: sanitizeMaxTurns,
  focusEpics: sanitizeFocus,
  ritualLimitThreshold: sanitizeRitualLimit,
};

export const isProposableSetting = (key: string): boolean => key in SETTING_WHITELIST;

/** Заголовок, под которым правила офиса дописываются в бриф роли без пакета. */
const RULES_HEADER = '## Правила офиса';

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
    if (role.package) {
      const extra = role.package.briefExtra.trim();
      state.updateRole(role.id, { briefExtra: extra ? `${extra}\n${rule}` : rule });
    } else {
      const brief = role.brief.trimEnd();
      const tail = brief.includes(RULES_HEADER) ? `\n${rule}` : `\n\n${RULES_HEADER}\n${rule}`;
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

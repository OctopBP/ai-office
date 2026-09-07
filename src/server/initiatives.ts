/**
 * Инициативы (docs/design/living-office/spec.md §7): фичи, которые офис
 * заводит себе сам, и предложения, которые ждут решения владельца (§8.1).
 *
 * Инициатива — это обычная фича с полями `origin: 'office'` и `rationale`,
 * а не отдельная очередь: она подчиняется фокусу, зависимостям и конвейеру
 * наравне с фичами владельца. Отличается двумя вещами: кто её одобряет
 * (режим инициативы) и что она считается в долю расхода на своё.
 *
 * Здоровье проекта (встроенное направление) — не инициатива, а обязанность:
 * оно не входит в долю и в режиме `propose` начинается без «поехали».
 */
import { HEALTH_DIRECTION, OFFICE_SENDER } from '../shared/types';
import type { ProposalKind, ProposalView } from '../shared/types';
import type { OfficeState } from './state';
import { createPlan, dispatch, type PlannedEpic } from './plan';

export { initiativeBudget, type InitiativeBudget } from './plan';

export interface FeatureProposal extends PlannedEpic {
  rationale: string;
  directionId: string | null;
}

/**
 * Офис предлагает фичу. Что с ней будет, решает режим инициативы: `off` —
 * предложение в очередь; `propose` — в план без согласия; `auto` — в план
 * с согласием. Здоровье проекта в `propose` тоже согласовано сразу: красные
 * проверки не ждут «поехали».
 *
 * Возвращает готовый текст для инструмента: что именно случилось.
 */
export function proposeFeature(state: OfficeState, feature: FeatureProposal): { ok: boolean; message: string } {
  const title = feature.title.trim();
  const open = state.epicList().some((e) =>
    (e.status === 'planned' || e.status === 'active') && e.title.trim().toLowerCase() === title.toLowerCase());
  if (open) return { ok: false, message: state.say('initiative.dedupe', { title }) };
  const pending = state.proposalList().some((p) =>
    p.kind === 'feature' && p.status === 'pending' && p.title.trim().toLowerCase() === title.toLowerCase());
  if (pending) return { ok: false, message: state.say('initiative.dedupe', { title }) };

  const direction = feature.directionId ? state.directions.get(feature.directionId) : null;
  const directionId = direction ? direction.id : null;
  const dirLabel = directionId
    ? state.say('initiative.dirLabel', { id: directionId })
    : state.say('initiative.noDir');
  const mode = state.initiativeMode();

  if (mode === 'off') {
    const proposal = state.addProposal({
      kind: 'feature', title, text: feature.goal, rationale: feature.rationale,
      roleId: null, setting: null, directionId, plan: feature,
    });
    state.addChat(OFFICE_SENDER, state.say('initiative.offChat', {
      title, direction: dirLabel, rationale: feature.rationale,
    }));
    return { ok: true, message: `${proposal.id}: ${title}` };
  }

  const health = directionId === HEALTH_DIRECTION;
  const approved = mode === 'auto' || health;
  const made = createPlan(state, [feature], { origin: 'office', rationale: feature.rationale, directionId, approved });
  if (!made.ok) return made;
  const epic = state.epicList().filter((e) => e.origin === 'office').pop();
  if (epic) {
    state.addChat(OFFICE_SENDER, state.say(approved ? 'initiative.startedChat' : 'initiative.proposedChat', {
      epic: epic.id, title: epic.title, direction: dirLabel, rationale: feature.rationale,
    }));
  }
  return { ok: true, message: made.message };
}

/**
 * Решение владельца по предложению. Принятая фича встаёт в план уже
 * согласованной: «принять» и есть «поехали». Правила и настройки — §8.1,
 * их применяет фаза 3; здесь они только закрываются.
 */
export function decideProposal(
  state: OfficeState, id: string, accept: boolean,
  apply?: (state: OfficeState, proposal: ProposalView & { plan: PlannedEpic | null }) => string | null,
): { ok: boolean; message: string } {
  const proposal = state.proposals.get(id);
  if (!proposal || proposal.status !== 'pending') {
    return { ok: false, message: state.say('proposal.noSuch', { id }) };
  }
  if (!accept) {
    state.updateProposal(id, { status: 'rejected', decidedAt: Date.now() });
    state.addChat(OFFICE_SENDER, state.say('proposal.rejectedChat', { id, title: proposal.title }));
    return { ok: true, message: '' };
  }
  if (proposal.kind === 'feature' && proposal.plan) {
    const made = createPlan(state, [proposal.plan], {
      origin: 'office', rationale: proposal.rationale, directionId: proposal.directionId, approved: true,
    });
    if (!made.ok) return made;
    const epic = state.epicList().filter((e) => e.origin === 'office').pop();
    state.addLog(null, 'system', state.say('proposal.featureLog', { id, epic: epic?.id ?? '—' }));
  } else if (apply) {
    const problem = apply(state, proposal);
    if (problem) return { ok: false, message: problem };
  }
  state.updateProposal(id, { status: 'accepted', decidedAt: Date.now() });
  state.addChat(OFFICE_SENDER, state.say('proposal.acceptedChat', { id, title: proposal.title }));
  dispatch(state);
  return { ok: true, message: '' };
}

/** Предложения, которые ждут владельца, — для планёрки. */
export const pendingProposals = (state: OfficeState): ProposalView[] =>
  state.proposalList().filter((p) => p.status === 'pending');

export const proposalKindLabel = (state: OfficeState, kind: ProposalKind): string =>
  state.say(`proposal.kind.${kind}`);

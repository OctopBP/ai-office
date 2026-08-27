/**
 * Как состояние агента называется и чем помечается на сцене.
 *
 * Общее для обоих рендеров: плоский офис и трёхмерный показывают одни и те же
 * состояния одними и теми же словами, и расходиться им незачем. Раньше обе
 * таблицы жили в `Office.tsx` — там же, где отрисовка, — и переезд сюда
 * ничего не меняет по смыслу, только перестаёт заставлять второй рендер
 * копировать их себе.
 */
import type { AgentState, InstanceView, RoleView } from '../shared/types';
import { t } from './i18n';
import type { IconName } from './icons';

/** Состояние словами. Функция, а не таблица: язык офиса меняется на ходу. */
export const stateText = (state: AgentState): string => t(`agent.state.${state}`);

/** Значок состояния — `null` у «свободен» и «идёт»: их и так видно по позе фигуры. */
export const STATE_ICON: Record<AgentState, IconName | null> = {
  idle: null, thinking: 'dots', working: 'keyboard', walking: null, talking: 'message',
  waiting_approval: 'alert-circle', paused: 'player-pause', blocked: 'hourglass',
  done: 'circle-check', failed: 'alert-triangle',
};

/**
 * Занят ли агент прямо сейчас. Занятый сидит за своим столом, свободному
 * ищется занятие в зоне отдыха (`interests.ts`).
 *
 * У исполнителя занятость — это задача: либо он её ведёт, либо свободен.
 * У менеджера задач своих нет, его работа — ход разговора, поэтому занятость
 * читается по состоянию: пока он думает, отвечает или ждёт разрешения — он за
 * компьютером; закончил ход и снова `idle` — идёт отдыхать вместе со всеми.
 * Сорвавшийся ход (`failed`) оставляем за столом: это не отдых, а поломка, и
 * показывать её честнее там, где он работал.
 */
export function isBusy(inst: InstanceView, roles: RoleView[]): boolean {
  const manager = roles.find((r) => r.id === inst.roleId)?.isManager ?? false;
  return manager ? inst.state !== 'idle' : !!inst.currentTaskId;
}

/**
 * Как состояние агента называется и чем помечается на сцене.
 *
 * Общее для обоих рендеров: плоский офис и трёхмерный показывают одни и те же
 * состояния одними и теми же словами, и расходиться им незачем. Раньше обе
 * таблицы жили в `Office.tsx` — там же, где отрисовка, — и переезд сюда
 * ничего не меняет по смыслу, только перестаёт заставлять второй рендер
 * копировать их себе.
 */
import type { AgentState } from '../shared/types';

export const STATE_TEXT: Record<AgentState, string> = {
  idle: 'свободен', thinking: 'думает', working: 'работает', walking: 'идёт',
  talking: 'разговор', waiting_approval: 'ждёт разрешения', paused: 'на паузе',
  blocked: 'заблокирован', done: 'сдал работу', failed: 'ошибка',
};

export const STATE_ICON: Record<AgentState, string> = {
  idle: '', thinking: '💭', working: '⌨️', walking: '', talking: '💬',
  waiting_approval: '❗', paused: '⏸', blocked: '⏳', done: '✅', failed: '⚠️',
};

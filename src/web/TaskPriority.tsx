import type { TaskPriority as Priority, TaskView } from '../shared/types';
import { TASK_PRIORITIES } from '../shared/types';
import { setTaskPriority } from './store';
import { t } from './i18n';

/** Подпись важности — одно слово: метка на карточке должна остаться короткой. */
export const priorityLabel = (p: Priority): string => t(`task.priority.${p}`);

/**
 * Стрелка перед подписью. Слово «высокая» рядом с чипами статуса читается не
 * сразу — стрелка опознаётся раньше текста. У среднего стрелки нет: он и есть
 * точка отсчёта, и рисовать её значило бы уравнять его с остальными.
 */
const MARK: Record<Priority, string> = { high: '↑ ', normal: '', low: '↓ ' };

/** Следующее значение по кругу: высокая → обычная → низкая → высокая. */
const NEXT: Record<Priority, Priority> = { high: 'normal', normal: 'low', low: 'high' };

/**
 * Метка важности на карточке доски. Щелчок по ней перебирает три значения по
 * кругу — не выпадающее меню: карточка лежит в прокручиваемой колонке, и
 * всплывающий список пришлось бы вытаскивать из-под её краёв ради выбора из
 * трёх слов. Точный выбор из трёх — в раскрытой карточке, PrioritySeg.
 *
 * Карточка сама по себе кнопка, поэтому метка — span с role, а не вложенная
 * кнопка, и щелчок по ней не должен открывать карточку: stopPropagation.
 */
export function PriorityChip({ task }: { task: TaskView }) {
  return (
    <span
      className={`chip prio-chip ${task.priority}`}
      role="button"
      title={t('task.priority.hint', { value: priorityLabel(task.priority) })}
      onClick={(e) => {
        e.stopPropagation();
        setTaskPriority(task.id, NEXT[task.priority]);
      }}
    >
      {MARK[task.priority]}{priorityLabel(task.priority)}
    </span>
  );
}

/** Выбор важности из трёх в раскрытой карточке: здесь место есть. */
export function PrioritySeg({ task }: { task: TaskView }) {
  return (
    <span className="seg prio-seg">
      {TASK_PRIORITIES.map((p) => (
        <button
          key={p}
          className={p === task.priority ? 'on' : ''}
          onClick={() => setTaskPriority(task.id, p)}
        >
          {priorityLabel(p)}
        </button>
      ))}
    </span>
  );
}

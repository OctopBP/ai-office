/**
 * Разделитель между основной областью и доком. Мышь и касание — pointer
 * events; клавиатура — стрелки ±16 px (Shift ±64), Home/End — предел,
 * Enter и двойной клик — размер по умолчанию (спека §2.3).
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { t } from '../i18n';
import { KEY_STEP, KEY_STEP_BIG, type DockId } from './model';

interface SplitterProps {
  dock: DockId;
  /** Текущий размер дока, px. */
  value: number;
  min: number;
  max: number;
  onChange(px: number): void;
  onReset(): void;
}

/** Куда растёт док: нижний — вверх, правый — влево, левый — вправо. */
const GROW_KEYS: Record<DockId, { grow: string; shrink: string }> = {
  bottom: { grow: 'ArrowUp', shrink: 'ArrowDown' },
  right: { grow: 'ArrowLeft', shrink: 'ArrowRight' },
  left: { grow: 'ArrowRight', shrink: 'ArrowLeft' },
};

export function Splitter({ dock, value, min, max, onChange, onReset }: SplitterProps) {
  const horizontal = dock === 'bottom'; // линия горизонтальна, тянем по вертикали
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ pos: number; size: number } | null>(null);

  const axis = (e: PointerEvent) => (horizontal ? e.clientY : e.clientX);
  // Знак: +1, если движение курсора вдоль оси увеличивает док.
  const sign = dock === 'left' ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { pos: axis(e), size: value };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    onChange(s.size + sign * (axis(e) - s.pos));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    const keys = GROW_KEYS[dock];
    let next: number | null = null;
    if (e.key === keys.grow) next = value + step;
    else if (e.key === keys.shrink) next = value - step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else if (e.key === 'Enter') {
      e.preventDefault();
      onReset();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  };

  return (
    <div
      className={`dock-splitter dock-splitter-${dock}${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-label={t('dock.resize')}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      title={t('dock.resizeHint')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}

import {
  cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ReactElement, type ReactNode, type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { Kbd } from './Kbd';

const GAP = 6;      // от края элемента до подсказки
const EDGE = 8;     // не ближе к краю окна
const DELAY = 250;  // по наведению — с задержкой, как у браузерной; по фокусу — сразу

/**
 * Своя подсказка вместо `title`: браузерная принимает только текст, а в
 * подсказках офиса стоят горячие клавиши, и им место в плашке (`Kbd`).
 *
 * Обёртки в разметке нет — на дочерний элемент вешается только ref, так что
 * кнопка в ряду остаётся кнопкой в ряду. Слушатели нативные, не React:
 * отключённой кнопке React наведение не доставляет, а подсказка ей нужна
 * не меньше (кнопка отправки пуста, пока нечего отправлять). Подсказка
 * рисуется порталом в `body` над всеми слоями и сама выбирает, встать под
 * элементом или над ним. Пустой `tip` — элемент отдаётся как есть.
 */
export function Tooltip({ tip, focus = true, className, children }: {
  tip: ReactNode;
  /** Модификатор плашки: например, многострочная подсказка вместо пилюли. */
  className?: string;
  /** Показывать и по фокусу. У полей ввода — нет: там фокус значит «печатаю». */
  focus?: boolean;
  children: ReactElement<{ ref?: Ref<HTMLElement> }>;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; above: boolean } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const wantFocus = useRef(focus);
  wantFocus.current = focus;

  const show = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => { clearTimeout(timer.current); setOpen(false); };
  useEffect(() => () => clearTimeout(timer.current), []);

  // Ref-колбэк с очисткой: элемент может смениться, слушатели переезжают с ним.
  const outerRef = children.props.ref;
  const setAnchor = useCallback((el: HTMLElement | null) => {
    anchor.current = el;
    if (typeof outerRef === 'function') outerRef(el);
    else if (outerRef) (outerRef as { current: HTMLElement | null }).current = el;
    if (!el) return;
    const onEnter = () => show(DELAY);
    const onFocus = () => { if (wantFocus.current) show(0); };
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', hide);
    // Нажали — подсказка больше не нужна, а по клику часто уходит и сам элемент.
    el.addEventListener('mousedown', hide);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', hide);
    return () => {
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', hide);
      el.removeEventListener('mousedown', hide);
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('blur', hide);
      hide();
    };
  }, [outerRef]);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const a = anchor.current, b = box.current;
    if (!a || !b) return;
    const r = a.getBoundingClientRect();
    const w = b.offsetWidth, h = b.offsetHeight;
    const above = r.bottom + GAP + h > window.innerHeight - EDGE;
    const x = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), window.innerWidth - EDGE - w);
    setPos({ x, y: above ? r.top - GAP - h : r.bottom + GAP, above });
  }, [open]);

  if (!tip) return children;

  return (
    <>
      {cloneElement(children, { ref: setAnchor })}
      {open && createPortal(
        <div ref={box} role="tooltip" className={`tip${className ? ` ${className}` : ''}${pos?.above ? ' above' : ''}`}
          style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
          {tip}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Строка подсказки: подпись и, если есть, клавиша плашкой. */
export function Hint({ label, keys }: { label: ReactNode; keys?: string }) {
  return (
    <span className="tip-item">
      {label}
      {keys && <Kbd keys={keys} />}
    </span>
  );
}

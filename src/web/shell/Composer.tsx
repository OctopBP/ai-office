import { useEffect, useRef } from 'react';
import { accessLabel, pushToast, send, useInputDraft, useStore } from '../store';
import { money } from '../money';
import { t } from '../i18n';
import { Icon } from '../icons';
import { Hint, Tooltip } from '../Tooltip';
import { HOTKEY } from '../hotkeys';
import { ChatPeer } from '../ChatPeer';
import { displayInstance } from '../instanceName';

/**
 * Курсор в композер просят снаружи — кнопка «Поставить задачу» и клавиша
 * Enter. Ссылка модульная, а не через контекст: композер на экране один,
 * а звонящие ему — в разных ветках дерева.
 */
let focus: (() => void) | null = null;
export const focusComposer = (): void => {
  // На виде «Доска» композера на экране нет. Просьба о курсоре приходит вместе
  // со сменой вида, и в этот момент он ещё не смонтирован — ждём кадр.
  if (focus) focus();
  else requestAnimationFrame(() => focus?.());
};

/**
 * Композер внизу экрана — постоянный, а не внутри чата: задача ставится
 * словами из любого вида. В виде «Чат» он же поле ввода треда. Чипы под
 * полем показывают, с чем задача уйдёт, — модель менеджера, режим правок,
 * бюджет; меняются они в настройках, чип туда и ведёт.
 */
export function Composer({ onSettings }: { onSettings: () => void }) {
  const thread = useStore((s) => s.thread);
  const instances = useStore((s) => s.instances);
  const roles = useStore((s) => s.roles);
  const settings = useStore((s) => s.settings);
  const connected = useStore((s) => s.connected);
  const view = useStore((s) => s.view);
  // Черновик — в сторе: на виде «Доска» композера на экране нет, и локальное
  // состояние теряло бы недописанное при каждой смене вида.
  const draft = useInputDraft();
  const setDraft = useStore((s) => s.setInputDraft);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    focus = () => input.current?.focus();
    return () => { focus = null; };
  }, []);

  // Композер плавает над видами и растёт с многострочным вводом, поэтому его
  // высоту нельзя прибить числом в css: под ней прячется низ ленты чата, чипы
  // камеры и тосты. Отдаём измеренную высоту переменной `--composer-h` — от
  // неё все они отмеряют свой нижний край (см. shell.css).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const root = document.documentElement;
    let last = -1;
    // offsetHeight, а не contentRect: нужна высота с рамкой и отступами. Он же
    // целый, поэтому дробные колебания не дёргают всё, что висит над полем.
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h === last) return;
      last = h;
      root.style.setProperty('--composer-h', `${h}px`);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--composer-h');
    };
  }, []);

  // Поле растёт с текстом до четырёх-пяти строк, дальше прокручивается.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const meeting = thread === 'meeting';
  const submit = () => {
    const text = draft.trim();
    if (!text || meeting || !connected) return;
    send(text);
    setDraft('');
    // Из «Офиса» и «Доски» вид не меняем: человек смотрел на офис — пусть и
    // дальше смотрит. Вместо перескока — короткое подтверждение, а о том, что
    // менеджер ответил, скажет точка на сегменте «Чат».
    if (view !== 'chat') {
      pushToast({
        id: `sent:${Date.now()}`, kind: 'info',
        title: t('toast.sent'),
        detail: text.length > 80 ? `${text.slice(0, 80)}…` : text,
        ttl: 2500,
      });
    }
  };

  const placeholder = meeting ? t('shell.composer.meeting')
    : thread === 'pm#1' ? t('shell.composer.placeholder')
    : t('shell.composer.agent', { who: displayInstance(thread, instances, roles) });
  const model = roles.find((r) => r.id === 'pm')?.model;
  const cap = settings.globalBudgetUsd;

  return (
    <div className="shell-composer float" ref={box}>
      {/* В виде «Чат» собеседник уже стоит над лентой — второй раз не показываем. */}
      {view !== 'chat' && <ChatPeer compact />}
      <textarea
        ref={input} value={draft} rows={1} placeholder={placeholder} disabled={meeting}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          // Escape отдаёт клавиши обратно офису: пока курсор в поле, хоткеи
          // молчат, и без этого из композера было бы не выйти без мыши.
          if (e.key === 'Escape') input.current?.blur();
          e.stopPropagation();
        }}
      />
      <div className="shell-composer-row">
        {model && <button className="chip-btn" onClick={onSettings} title={t('shell.chip.hint')}>{model} ▾</button>}
        <button className="chip-btn" onClick={onSettings} title={t('shell.chip.hint')}>
          {t('shell.chip.edits', { mode: accessLabel(settings.officePermissionMode) })}
        </button>
        <button className="chip-btn" onClick={onSettings} title={t('shell.chip.hint')}>
          {cap !== null ? t('shell.chip.budget', { cap: money(cap) }) : t('shell.chip.noBudget')}
        </button>
        <Tooltip tip={<><Hint label={t('shell.send')} keys={HOTKEY.task} /><Hint label={t('shell.newline')} keys="SHIFT+ENTER" /></>}>
          <button className="sq primary shell-send" onClick={submit} disabled={!connected || meeting || !draft.trim()}>
            <Icon name="arrow-up" size={16} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

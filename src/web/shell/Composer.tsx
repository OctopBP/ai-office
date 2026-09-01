import { useEffect, useRef, useState } from 'react';
import { accessLabel, send, useStore } from '../store';
import { money } from '../money';
import { t } from '../i18n';
import { Icon } from '../icons';

/**
 * Курсор в композер просят снаружи — кнопка «Поставить задачу» и клавиша
 * Enter. Ссылка модульная, а не через контекст: композер на экране один,
 * а звонящие ему — в разных ветках дерева.
 */
let focus: (() => void) | null = null;
export const focusComposer = (): void => { focus?.(); };

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
  const setView = useStore((s) => s.setView);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    focus = () => input.current?.focus();
    return () => { focus = null; };
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
    // Ответ менеджера приходит в чат — туда и переключаемся, иначе он
    // мелькнул бы тостом, а сам разговор остался бы за кадром.
    if (view !== 'chat') setView('chat');
  };

  const placeholder = meeting ? t('shell.composer.meeting')
    : thread === 'pm#1' ? t('shell.composer.placeholder')
    : t('shell.composer.agent', { who: instances[thread]?.label ?? thread });
  const model = roles.find((r) => r.id === 'pm')?.model;
  const cap = settings.globalBudgetUsd;

  return (
    <div className="shell-composer float">
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
        <button className="sq primary shell-send" onClick={submit} disabled={!connected || meeting || !draft.trim()}
          title={t('shell.send')}>
          <Icon name="arrow-up" size={16} />
        </button>
      </div>
    </div>
  );
}

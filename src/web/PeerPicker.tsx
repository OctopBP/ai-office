import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { t } from './i18n';
import { Avatar } from './Avatar';
import { Icon } from './icons';
import { useInstanceName } from './instanceName';

/**
 * Выбор собеседника чата: менеджер, переговорка или сотрудник напрямую.
 * Раньше это был ряд чипов, который с ростом команды занимал полэкрана, —
 * теперь одна кнопка с текущим собеседником и меню под ней. Список и
 * переключение те же: треды из стора, `setThread`.
 */
export function PeerPicker() {
  const thread = useStore((s) => s.thread);
  const setThread = useStore((s) => s.setThread);
  const instances = useStore((s) => s.instances);
  const meetingOn = useStore((s) => s.meeting?.status === 'running');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const threads = ['pm#1', 'meeting', ...Object.values(instances).filter((i) => i.roleId !== 'pm').map((i) => i.id)];

  // Меню закрывается кликом мимо него и Escape — даже если фокус ушёл из
  // меню (кликнули по пустому месту внутри), поэтому слушаем документ.
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  // Открылось — курсор на текущем собеседнике, чтобы стрелки шли от него.
  // Зависит только от открытия: состав команды, сменившийся при открытом
  // меню, не повод выдёргивать курсор.
  useEffect(() => {
    if (!open) return;
    const items = list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    items?.[Math.max(0, threads.indexOf(thread))]?.focus();
  }, [open]);

  const pick = (id: string) => {
    setThread(id);
    setOpen(false);
    toggle.current?.focus();
  };

  // Клавиши внутри меню: стрелки ходят по пунктам по кругу, Home/End — к
  // краям, Escape закрывает и возвращает фокус кнопке. Enter и пробел
  // срабатывают сами — пункты это кнопки. Всплывать не даём: иначе хоткеи
  // офиса сработают поверх меню.
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Escape') { setOpen(false); toggle.current?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (next >= 0) items[next]?.focus();
  };

  return (
    <div className="peer-picker" ref={box}>
      <button
        ref={toggle}
        className={`peer-picker-btn${open ? ' on' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('chat.peer.pick')}
        title={t('chat.peer.pick')}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); }
        }}
      >
        <PeerFace id={thread} />
        <PeerLabel id={thread} meetingOn={meetingOn} />
        <span className="peer-picker-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div
          ref={list}
          className="peer-picker-menu float"
          role="listbox"
          aria-label={t('chat.peer.list')}
          onKeyDown={onMenuKey}
        >
          {threads.map((id) => (
            <PeerOption key={id} id={id} on={id === thread} meetingOn={meetingOn} onPick={pick} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Лицо треда: у переговорки лица нет — вместо него значок «люди». */
function PeerFace({ id }: { id: string }) {
  const roleId = useStore((s) => s.instances[id]?.roleId);
  if (id === 'meeting') return <span className="peer-picker-icon"><Icon name="users" size={14} /></span>;
  return <Avatar roleId={roleId ?? 'pm'} instanceId={id} size="sm" />;
}

/** Подпись треда — те же слова, что были на чипах. */
function PeerLabel({ id, meetingOn }: { id: string; meetingOn: boolean }) {
  const name = useInstanceName(id);
  return (
    <span className="peer-picker-name">
      {id === 'pm#1' ? t('chat.tab.pm') : id === 'meeting' ? t('chat.tab.meeting') : name}
      {id === 'meeting' && meetingOn ? ' •' : ''}
    </span>
  );
}

function PeerOption({ id, on, meetingOn, onPick }: {
  id: string;
  on: boolean;
  meetingOn: boolean;
  onPick: (id: string) => void;
}) {
  const peer = useStore((s) => s.instances[id]);
  const role = useStore((s) => s.roles.find((r) => r.id === peer?.roleId));
  // Должность второй строкой — как в шапке собеседника: только когда у
  // сотрудника своё имя, иначе она повторила бы подпись.
  const sub = id !== 'pm#1' && peer?.name ? role?.title ?? peer.roleId : null;
  return (
    <button
      role="option"
      aria-selected={on}
      className={`peer-picker-item${on ? ' on' : ''}`}
      onClick={() => onPick(id)}
    >
      <PeerFace id={id} />
      <span className="peer-picker-text">
        <PeerLabel id={id} meetingOn={meetingOn} />
        {sub && <span className="peer-picker-role">{sub}</span>}
      </span>
      <span className="peer-picker-check" aria-hidden>{on ? '✓' : ''}</span>
    </button>
  );
}

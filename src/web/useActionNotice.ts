import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { isOfficeSender } from '../shared/types';

/**
 * Команды найма и увольнения ничего не возвращают напрямую — единственный
 * канал обратной связи от сервера при отказе — системное сообщение в чат
 * менеджера (from: OFFICE_SENDER, thread: 'pm#1'). Хук ловит такое сообщение,
 * пришедшее после markPending(), и отдаёт его текстом для показа в UI,
 * а не даёт ошибке потеряться в чате, который может быть не открыт.
 */
export function useActionNotice(): { notice: string | null; markPending: () => void; clear: () => void } {
  const lastChat = useStore((s) => (s.chat.length ? s.chat[s.chat.length - 1] : null));
  const [notice, setNotice] = useState<string | null>(null);
  const pendingSince = useRef<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!lastChat || pendingSince.current === null) return;
    if (isOfficeSender(lastChat.from) && lastChat.thread === 'pm#1' && lastChat.at >= pendingSince.current) {
      pendingSince.current = null;
      setNotice(lastChat.text);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setNotice(null), 8000);
    }
  }, [lastChat]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  return {
    notice,
    markPending: () => { pendingSince.current = Date.now(); },
    clear: () => setNotice(null),
  };
}

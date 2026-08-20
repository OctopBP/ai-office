import { useEffect, useState } from 'react';
import { useStore } from './store';

const HINTS: Array<[string, string]> = [
  ['ENTER', 'написать PM'],
  ['B', 'доска'],
  ['L', 'лог'],
  ['M', 'совещание'],
  ['SPACE', 'пауза'],
  ['ESC', 'закрыть'],
  ['1–9', 'выбрать агента'],
];

export function BottomBar() {
  const busy = useStore((s) => s.busy);
  const theme = useStore((s) => s.theme);
  const [now, setNow] = useState(() => new Date());
  const [start] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(t);
  }, []);

  const min = Math.floor((now.getTime() - start) / 60000);
  const session = min < 60 ? `${min}м` : `${Math.floor(min / 60)}ч ${min % 60}м`;

  return (
    <footer className="bottom">
      <div className="hints">
        {HINTS.map(([key, what]) => (
          <span key={key}><kbd>{key}</kbd> {what}</span>
        ))}
      </div>
      <div className="muted small">
        {busy && <span className="working">команда работает… · </span>}
        {theme === 'day' ? '☀' : '🌙'} {now.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
        {' · сеанс '}{session}
      </div>
    </footer>
  );
}

import { useEffect, useState } from 'react';
import { useStore } from './store';
import { locale, t } from './i18n';
import { Icon } from './icons';

const HINT_KEYS: Array<[string, 'hint.pm' | 'hint.board' | 'hint.log' | 'hint.meeting'
  | 'hint.merge' | 'hint.pause' | 'hint.close' | 'hint.agent']> = [
  ['ENTER', 'hint.pm'],
  ['B', 'hint.board'],
  ['L', 'hint.log'],
  ['M', 'hint.meeting'],
  ['Q', 'hint.merge'],
  ['SPACE', 'hint.pause'],
  ['ESC', 'hint.close'],
  ['1–9', 'hint.agent'],
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
  const session = min < 60
    ? t('bottom.minutes', { m: min })
    : t('bottom.hours', { h: Math.floor(min / 60), m: min % 60 });

  return (
    <footer className="bottom">
      <div className="hints">
        {HINT_KEYS.map(([key, what]) => (
          <span key={key}><kbd>{key}</kbd> {t(what)}</span>
        ))}
      </div>
      <div className="muted small">
        {busy && <span className="working">{t('bottom.busy')} · </span>}
        <Icon name={theme === 'day' ? 'sun' : 'moon'} size={14} />{' '}
        {now.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}
        {' · '}{t('bottom.session', { time: session })}
      </div>
    </footer>
  );
}

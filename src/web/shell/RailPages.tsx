import { ShellPage } from './ShellPage';
import { EventLog } from '../EventLog';
import { MoneyBoard } from '../MoneyBoard';
import { PrPipeline } from '../PrPipeline';
import { MergeQueue } from '../MergeQueue';
import { MeetingsPanel } from '../MeetingsPanel';
import { Kbd } from '../Kbd';
import { Hint, Tooltip } from '../Tooltip';
import { HOTKEY } from '../hotkeys';
import { t, type UiKey } from '../i18n';

/** Окна рейла без своей страницы: содержимое прежних панелей в `ShellPage`. */
export type PlainRailView = 'merge' | 'log' | 'money' | 'meetings';

const TITLE: Record<PlainRailView, UiKey> = {
  merge: 'panel.review', log: 'panel.log', money: 'panel.money', meetings: 'meetings.title',
};
// Клавиша, которой окно открывается, — плашкой в шапке, как было у панели.
const KEY: Partial<Record<PlainRailView, string>> = { merge: HOTKEY.merge, log: HOTKEY.log, money: HOTKEY.money };

/**
 * Лог, расходы, очередь слияния и совещания — страницы главной области.
 * Содержимое то же, что было в панелях; внутренние диалоги (созыв
 * совещания) по-прежнему модалки — их открывает `onCall`.
 */
export function RailPage({ view, onClose, onCall }: {
  view: PlainRailView;
  onClose: () => void;
  onCall: () => void;
}) {
  const key = KEY[view];
  return (
    <ShellPage title={t(TITLE[view])} bodyClass="pad" actions={<>
      {view === 'meetings' && <span className="muted small">{t('meetings.hint')}</span>}
      {key && <Kbd keys={key} />}
      <Tooltip tip={<Hint label={t('panel.close')} keys={HOTKEY.close} />}>
        <button className="sq ghost" onClick={onClose}>✕</button>
      </Tooltip>
    </>}>
      {view === 'log' && <EventLog />}
      {view === 'money' && <MoneyBoard />}
      {view === 'merge' && <><PrPipeline /><MergeQueue /></>}
      {view === 'meetings' && <MeetingsPanel onCall={onCall} />}
    </ShellPage>
  );
}

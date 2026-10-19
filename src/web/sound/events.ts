/**
 * Подписка звукового слоя на события сервера. Схема та же, что у notify.ts:
 * слушатель работает уже после того, как стор применил событие, и сравнивает
 * набор «поводов» с запомненным. Снимок только запоминает. Логика здесь, а не
 * в компонентах: офис — визуализация, звук ничего не блокирует.
 *
 * Звучат только события уровня A и отклики tick/sent. Задача влита — без
 * звука (решение владельца), фоновых звуков сцены нет.
 */
import { isOpenQuestion } from '../../shared/questions';
import { OFFICE_SENDER, type ServerEvent } from '../../shared/types';
import { onServerEvent, useStore } from '../store';
import { play, installUnlock, setFocusProvider } from './engine';
import { createKnown, createSeen, type SoundName } from './gate';

interface Cue { key: string; sound: SoundName }

const RELEVANT = new Set<ServerEvent['t']>([
  'task', 'task.remove', 'epic', 'question', 'run', 'pr', 'limits', 'usage', 'settings',
  'release', 'permission.request', 'permission.resolved',
]);

/** Все повода-звуки по текущему состоянию стора. Ключи — как у notify.ts, плюс rel: и perm:. */
function cues(): Cue[] {
  const s = useStore.getState();
  const out: Cue[] = [];
  for (const q of s.questions) {
    if (isOpenQuestion(q)) out.push({ key: `q:${q.id}`, sound: 'ask' });
  }
  for (const p of s.permissions) out.push({ key: `perm:${p.id}`, sound: 'ask' });

  const stuck = new Set<string>();
  for (const run of Object.values(s.runs)) {
    if (run.status === 'stuck' && run.subject.taskId) stuck.add(run.subject.taskId);
  }
  for (const pr of Object.values(s.prs)) if (pr.stage === 'stuck') stuck.add(pr.taskId);
  for (const id of stuck) {
    if (s.tasks[id]?.status !== 'cancelled') out.push({ key: `stuck:${id}`, sound: 'alert' });
  }

  let limited = s.limits.status === 'rejected';
  for (const task of Object.values(s.tasks)) {
    if (task.limitedAt) limited = true;
    if (task.status === 'failed') out.push({ key: `failed:${task.id}`, sound: 'alert' });
  }
  for (const epic of Object.values(s.epics)) {
    if (epic.status === 'planned' && !epic.approved) out.push({ key: `epic:${epic.id}:approve`, sound: 'ask' });
    else if (epic.status === 'done') out.push({ key: `epic:${epic.id}:done`, sound: 'done' });
  }
  if (limited) out.push({ key: 'limit:plan', sound: 'limit' });
  const cap = s.settings.globalBudgetUsd;
  if (cap !== null && s.usage.costUsd >= cap) out.push({ key: 'limit:budget', sound: 'limit' });

  for (const r of s.releases) {
    if (r.status === 'done') out.push({ key: `rel:${r.id}:done`, sound: 'release' });
    else if (r.status === 'failed') out.push({ key: `rel:${r.id}:failed`, sound: 'alert' });
  }
  return out;
}

const known = createKnown();
const msgSeen = createSeen();
let officeId: string | null = null;
let view: string | null = null;

const currentOfficeId = (): string | null => useStore.getState().offices.find((o) => o.current)?.id ?? null;

function handle(e: ServerEvent): void {
  if (e.t === 'snapshot') {
    // Снимок и переподключение молчат: только запоминаем набор.
    officeId = currentOfficeId();
    known.baseline(cues().map((c) => c.key));
    return;
  }
  const id = currentOfficeId();
  if (!id) return;
  // Офис сменился без снимка — сравнивать с чужими поводами нельзя.
  if (id !== officeId) {
    officeId = id;
    known.baseline(cues().map((c) => c.key));
    return;
  }

  if (e.t === 'chat') {
    const c = e.entry;
    if (c.thread === 'pm#1' && c.from !== 'user' && c.from !== OFFICE_SENDER) {
      // Готовая реплика, не поток chat.draft*; дедуп по id записи.
      if (msgSeen.add(`msg:${c.id}`)) play('message');
    } else if (c.from === 'user' && c.thread === 'pm#1') {
      play('sent');
    }
    return;
  }
  if (e.t === 'office.error' || e.t === 'role.error') {
    play('alert');
    return;
  }
  if (!RELEVANT.has(e.t)) return;

  const now = cues();
  const fresh = new Set(known.fresh(now.map((c) => c.key)));
  for (const c of now) if (fresh.has(c.key)) play(c.sound);
}

/** Подключить звуки. Вызывается из App; возвращает отписку. */
export function startSound(): () => void {
  setFocusProvider(() => {
    const s = useStore.getState();
    return {
      focused: document.hasFocus() && !document.hidden,
      pmChatOpen: s.view === 'chat' && s.thread === 'pm#1',
      lifeOpen: s.view === 'life',
    };
  });
  const offUnlock = installUnlock();
  const offEvents = onServerEvent(handle);
  // tick — тихий отклик на переход по разделам.
  view = useStore.getState().view;
  const offView = useStore.subscribe((s) => {
    if (s.view === view) return;
    view = s.view;
    play('tick');
  });
  return () => { offUnlock(); offEvents(); offView(); };
}

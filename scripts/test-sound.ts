/**
 * Логика звукового слоя без AudioContext (src/web/sound/gate.ts): дедуп,
 * пачка, троттлинг, фокус, режим, аренда вкладки.
 *
 * Запуск: npm run test:sound
 */
import assert from 'node:assert/strict';
import {
  BATCH_MS, createGate, createKnown, createLease, createSeen, mutedByFocus, type FocusState, type SoundName,
} from '../src/web/sound/gate';
import { normalizeSoundSettings } from '../src/web/sound/settings';

const results: string[] = [];
function check(name: string, fn: () => void): void {
  fn();
  results.push(`ok — ${name}`);
}

function rig(over: { mode?: 'important' | 'all'; enabled?: boolean; leader?: boolean; focus?: Partial<FocusState> } = {}) {
  let t = 1000;
  const timers: { at: number; fn: () => void }[] = [];
  const played: SoundName[] = [];
  const st = { mode: over.mode ?? 'important', enabled: over.enabled ?? true, leader: over.leader ?? true };
  const focus: FocusState = { focused: false, pmChatOpen: false, lifeOpen: false, ...over.focus };
  const gate = createGate({
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); },
    play: (n) => played.push(n),
    mode: () => st.mode,
    enabled: () => st.enabled,
    focus: () => focus,
    isLeader: () => st.leader,
  });
  const advance = (ms: number) => {
    t += ms;
    for (const x of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(x), 1); x.fn(); }
  };
  return { gate, played, advance, st, focus };
}

check('дедуп: снимок молчит, новый ключ звучит один раз, ушедший забывается', () => {
  const k = createKnown();
  assert.deepEqual(k.fresh(['q:1']), [], 'до снимка сравнивать не с чем');
  k.baseline(['q:1', 'failed:T-1']);
  assert.deepEqual(k.fresh(['q:1', 'failed:T-1']), []);
  assert.deepEqual(k.fresh(['q:1', 'failed:T-1', 'q:2']), ['q:2']);
  assert.deepEqual(k.fresh(['q:1', 'failed:T-1', 'q:2']), [], 'повтор не звучит');
  assert.deepEqual(k.fresh(['q:1']), []);
  assert.deepEqual(k.fresh(['q:1', 'q:2']), ['q:2'], 'ушёл и вернулся — снова повод');
  k.baseline(['x']);
  assert.deepEqual(k.fresh(['x', 'rel:R-1:done', 'perm:p1']), ['rel:R-1:done', 'perm:p1']);
});

check('дедуп реплик: один id — один звук, потолок размера', () => {
  const s = createSeen(3);
  assert.equal(s.add('msg:1'), true);
  assert.equal(s.add('msg:1'), false);
  s.add('msg:2'); s.add('msg:3'); s.add('msg:4');
  assert.equal(s.has('msg:1'), false, 'старейший вытеснен');
  assert.equal(s.has('msg:4'), true);
});

check('пачка: за окно играет один звук высшего приоритета', () => {
  const r = rig();
  for (const n of ['done', 'message', 'ask', 'alert', 'limit'] as SoundName[]) r.gate.request(n);
  assert.deepEqual(r.played, [], 'до конца окна тихо');
  r.advance(BATCH_MS);
  assert.deepEqual(r.played, ['alert']);
});

check('пачка: порядок приоритета alert > limit > ask > message > release > done', () => {
  const order: SoundName[] = ['alert', 'limit', 'ask', 'message', 'release', 'done'];
  for (let i = 0; i < order.length; i++) {
    const r = rig();
    for (const n of order.slice(i).reverse()) r.gate.request(n);
    r.advance(BATCH_MS);
    assert.deepEqual(r.played, [order[i]]);
  }
});

check('троттлинг: тот же звук не чаще раза в 3 с', () => {
  const r = rig();
  r.gate.request('ask'); r.advance(BATCH_MS);
  r.gate.request('ask'); r.advance(BATCH_MS);
  assert.deepEqual(r.played, ['ask'], 'прошло 1,5 с — рано');
  r.advance(1500);
  r.gate.request('ask'); r.advance(BATCH_MS);
  assert.deepEqual(r.played, ['ask', 'ask']);
});

check('троттлинг: заглушённый высший не съедает следующий по приоритету', () => {
  const r = rig();
  r.gate.request('alert'); r.advance(BATCH_MS);
  r.gate.request('alert'); r.gate.request('done'); r.advance(BATCH_MS);
  assert.deepEqual(r.played, ['alert', 'done']);
});

check('tick: не чаще 150 мс, сразу, без пачки', () => {
  const r = rig({ mode: 'all' });
  r.gate.request('tick');
  assert.deepEqual(r.played, ['tick']);
  r.advance(100); r.gate.request('tick');
  assert.equal(r.played.length, 1);
  r.advance(60); r.gate.request('tick');
  assert.equal(r.played.length, 2);
});

check('режим «Только важное»: tick и sent молчат, A звучит; «Всё» — оба', () => {
  const a = rig();
  a.gate.request('tick'); a.gate.request('sent'); a.gate.request('done'); a.advance(BATCH_MS);
  assert.deepEqual(a.played, ['done']);
  const b = rig({ mode: 'all' });
  b.gate.request('tick'); b.gate.request('sent'); b.gate.request('done'); b.advance(BATCH_MS);
  assert.deepEqual(b.played, ['tick', 'sent', 'done']);
});

check('выключено и чужая вкладка — тишина', () => {
  const off = rig({ enabled: false });
  off.gate.request('alert'); off.advance(BATCH_MS);
  assert.deepEqual(off.played, []);
  const other = rig({ leader: false });
  other.gate.request('alert'); other.advance(BATCH_MS);
  assert.deepEqual(other.played, []);
});

check('фокус: message при открытом чате PM и ask при «Жизни офиса» молчат; alert/limit/release звучат', () => {
  const f = (o: Partial<FocusState>): FocusState => ({ focused: true, pmChatOpen: false, lifeOpen: false, ...o });
  assert.equal(mutedByFocus('message', f({ pmChatOpen: true })), true);
  assert.equal(mutedByFocus('ask', f({ lifeOpen: true })), true);
  assert.equal(mutedByFocus('message', f({ lifeOpen: true })), false);
  for (const n of ['alert', 'limit', 'release', 'done'] as SoundName[]) {
    assert.equal(mutedByFocus(n, f({ pmChatOpen: true, lifeOpen: true })), false, n);
  }
  assert.equal(mutedByFocus('message', f({ focused: false, pmChatOpen: true })), false, 'окно не в фокусе — звучит');
  const r = rig({ focus: { focused: true, pmChatOpen: true } });
  r.gate.request('message'); r.advance(BATCH_MS);
  assert.deepEqual(r.played, []);
});

check('аренда: одна вкладка из нескольких, устаревшая уступает, фокусная забирает', () => {
  let cur: { id: string; at: number } | null = null;
  let now = 0;
  const store = { read: () => cur, write: (v: { id: string; at: number }) => { cur = v; } };
  const a = createLease('a', store, () => now);
  const b = createLease('b', store, () => now);
  assert.equal(a.acquire(false), true);
  assert.equal(b.acquire(false), false);
  assert.equal(a.acquire(false), true);
  now += 6000;
  assert.equal(b.acquire(false), true, 'аренда a протухла');
  assert.equal(a.acquire(true), true, 'вкладка в фокусе забирает');
  assert.equal(b.acquire(false), false);
});

check('настройки: умолчания и защита от мусора', () => {
  assert.deepEqual(normalizeSoundSettings(null), { enabled: true, volume: 0.4, mode: 'important' });
  assert.deepEqual(normalizeSoundSettings({ enabled: false, volume: 5, mode: 'all' }), { enabled: false, volume: 1, mode: 'all' });
  assert.deepEqual(normalizeSoundSettings({ volume: 'x', mode: 'zzz' }), { enabled: true, volume: 0.4, mode: 'important' });
});

console.log(results.join('\n'));

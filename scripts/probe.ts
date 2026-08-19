// Диагностика: подключается к серверу офиса, шлёт задачу PM'у и печатает события.
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:3001');
const text = process.argv[2] ?? 'Проверка связи: ответь одним словом.';
ws.on('open', () => {
  console.log('connected');
  setTimeout(() => ws.send(JSON.stringify({ c: 'user_message', text })), 300);
});
// PROBE_DECISION=allow|deny|none — как отвечать на запросы разрешения
const DECISION = process.env.PROBE_DECISION ?? 'none';

ws.on('message', (raw) => {
  const e = JSON.parse(raw.toString());
  if (e.t === 'permission.request') {
    const r = e.request;
    console.log(`  ASK  [${r.agentId}] ${r.risk.toUpperCase()} ${r.toolName}: ${r.summary}`);
    console.log(`       причина: ${r.reason} | ключ: ${r.key}`);
    if (DECISION !== 'none') {
      setTimeout(() => {
        console.log(`       → отвечаем: ${DECISION}`);
        ws.send(JSON.stringify({ c: 'permission', id: r.id, decision: DECISION }));
      }, 400);
    }
    return;
  }
  if (e.t === 'snapshot') console.log(`snapshot: ${e.instances.length} агентов, dir=${e.projectDir}`);
  else if (e.t === 'instance') console.log(`  [${e.instance.id}] ${e.instance.state}${e.instance.note ? ` — ${e.instance.note}` : ''}`);
  else if (e.t === 'task') console.log(`  TASK ${e.task.id} [${e.task.status}] ${e.task.title} → ${e.task.assigneeId ?? '—'}`);
  else if (e.t === 'chat') console.log(`  CHAT <${e.entry.from}> ${e.entry.text.slice(0, 300)}`);
  else if (e.t === 'log' && e.entry.kind === 'error') console.log(`  ERR [${e.entry.agentId}] ${e.entry.text}`);
  else if (e.t === 'handoff') console.log(`  HANDOFF ${e.from} → ${e.to}: ${e.text}`);
});
setTimeout(() => { console.log('--- таймаут пробы ---'); process.exit(0); }, Number(process.env.PROBE_MS ?? 45000));

/**
 * Регрессионные проверки поведения PM.
 *
 * Почти все поломки офиса были не в коде, а в поведении менеджера: отказывался
 * делегировать, заводил невыполнимые задачи, врал про ветки. Каждая правка
 * промпта может тихо сломать что-то ещё, поэтому поведение проверяется
 * сценариями с утверждениями, а не глазами.
 *
 * Исполнители заглушены (OFFICE_DRY_RUN=1), поэтому прогон стоит только
 * токенов PM и занимает секунды, а не минуты.
 *
 * Запуск: npm run test:pm
 */
import WebSocket from 'ws';
import type { ServerEvent, TaskView } from '../src/shared/types';

const PORT = Number(process.env.OFFICE_PORT ?? 3002);
// Ход считается законченным, только когда PM УЖЕ ответил в чат и после этого
// наступила тишина. Просто «N секунд тишины» не годится: пауза до первого
// вызова инструмента легко больше любого разумного порога.
const QUIET_MS = 8000;
const MAX_MS = 240000;
const SILENCE_LIMIT_MS = 90000;  // ни одного события — считаем, что всё сломалось

interface Run {
  tasks: TaskView[];
  toolCalls: string[];
  pmText: string;
  maxParallel: number;
}

interface Scenario {
  name: string;
  prompt: string;
  /** Прогревочный запрос: нужен там, где проверка зависит от накопленного расхода. */
  warmup?: string;
  before?: (ws: WebSocket) => void;
  checks: Array<{ what: string; ok: (r: Run) => boolean }>;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Декомпозиция и параллельная раздача',
    prompt: 'Сделай CRUD для заметок: JSON API на бэке и страница на фронте.',
    checks: [
      { what: 'создал минимум две задачи', ok: (r) => r.tasks.length >= 2 },
      { what: 'вызвал create_task', ok: (r) => r.toolCalls.some((t) => t.includes('create_task')) },
      { what: 'вызвал assign_task', ok: (r) => r.toolCalls.filter((t) => t.includes('assign_task')).length >= 2 },
      { what: 'все задачи назначены', ok: (r) => r.tasks.length > 0 && r.tasks.every((t) => t.assigneeId !== null) },
      { what: 'задействовал обе роли', ok: (r) => new Set(r.tasks.map((t) => t.roleId)).size >= 2 },
      {
        what: 'роль задачи совпадает с ролью исполнителя',
        ok: (r) => r.tasks.every((t) => !t.assigneeId || t.assigneeId.split('#')[0] === t.roleId),
      },
      { what: 'работали параллельно (2+ одновременно)', ok: (r) => r.maxParallel >= 2 },
      {
        what: 'не завёл задачу на проверку чужого результата',
        ok: (r) => !r.tasks.some((t) => /провер|убедис|убедить/i.test(t.title)),
      },
    ],
  },
  {
    name: 'Делегирует, а не отказывается',
    prompt: 'Командой bash запиши строку hello в файл hello.txt и проверь, что он создан.',
    checks: [
      { what: 'создал задачу вместо отказа', ok: (r) => r.tasks.length >= 1 },
      { what: 'назначил исполнителя', ok: (r) => r.tasks.some((t) => t.assigneeId !== null) },
      {
        what: 'не отговаривается отсутствием доступа у себя',
        ok: (r) => !/у меня нет (доступа|bash)|я не могу (записать|создать)/i.test(r.pmText),
      },
    ],
  },
  {
    name: 'Не врёт про ветки у документных ролей',
    prompt: 'Поручи юристу подготовить короткую политику конфиденциальности.',
    checks: [
      { what: 'задача ушла юристу', ok: (r) => r.tasks.some((t) => t.roleId === 'legal') },
      {
        what: 'роль задачи совпадает с ролью исполнителя',
        ok: (r) => r.tasks.every((t) => !t.assigneeId || t.assigneeId.split('#')[0] === t.roleId),
      },
      {
        what: 'не предлагает смержить то, что не в ветке',
        ok: (r) => !/смерж|влить ветк|в отдельной ветке/i.test(r.pmText),
      },
    ],
  },
  {
    name: 'Честно сообщает про исчерпанный бюджет',
    // Без прогрева расход офиса равен нулю, и никакой лимит не сработает.
    warmup: 'Поручи бэкендеру создать файл warmup.txt.',
    prompt: 'Поручи бэкендеру создать ещё один файл, second.txt.',
    before: (ws) => ws.send(JSON.stringify({ c: 'settings', settings: { globalBudgetUsd: 0.001 } })),
    checks: [
      { what: 'сообщил, что бюджет исчерпан', ok: (r) => /бюджет.{0,40}исчерпан|исчерпан.{0,20}бюджет|лимит.{0,30}исчерпан/i.test(r.pmText) },
      { what: 'не назначил задачу', ok: (r) => r.tasks.length > 0 && r.tasks.every((t) => t.assigneeId === null) },
      { what: 'не выдал невыполненное за сделанное', ok: (r) => !/готово|выполнено|сделал/i.test(r.pmText) },
    ],
  },
];

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function runScenario(sc: Scenario): Promise<Run> {
  const ws = await connect();
  const run: Run = { tasks: [], toolCalls: [], pmText: '', maxParallel: 0 };
  const byId = new Map<string, TaskView>();
  let last = Date.now();

  let sawReply = false;
  ws.on('message', (raw) => {
    const e = JSON.parse(raw.toString()) as ServerEvent;
    last = Date.now();
    if (e.t === 'task') {
      byId.set(e.task.id, e.task);
      const parallel = [...byId.values()].filter((t) => t.status === 'in_progress').length;
      run.maxParallel = Math.max(run.maxParallel, parallel);
    }
    if (e.t === 'log' && e.entry.kind === 'tool' && e.entry.agentId === 'pm#1') {
      run.toolCalls.push(e.entry.text);
    }
    if (e.t === 'chat' && (e.entry.from === 'pm#1' || e.entry.from === 'офис')) {
      run.pmText += `\n${e.entry.text}`;
      sawReply = true;
    }
  });

  ws.send(JSON.stringify({ c: 'reset' }));
  await new Promise((r) => setTimeout(r, 800));

  if (sc.warmup) {
    ws.send(JSON.stringify({ c: 'user_message', text: sc.warmup }));
    const warmStart = Date.now();
    while (!sawReply && Date.now() - warmStart < 120000) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 4000));
    sawReply = false;
  }

  sc.before?.(ws);
  await new Promise((r) => setTimeout(r, 400));
  byId.clear();
  run.toolCalls = [];
  run.pmText = '';
  last = Date.now();
  ws.send(JSON.stringify({ c: 'user_message', text: sc.prompt }));

  const started = Date.now();
  while (Date.now() - started < MAX_MS) {
    const quiet = Date.now() - last;
    if (sawReply && quiet > QUIET_MS) break;
    if (quiet > SILENCE_LIMIT_MS) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  ws.close();
  run.tasks = [...byId.values()];
  return run;
}

async function main(): Promise<void> {
  const only = process.argv[2];
  const list = only ? SCENARIOS.filter((s) => s.name.toLowerCase().includes(only.toLowerCase())) : SCENARIOS;
  let failed = 0;

  for (const sc of list) {
    process.stdout.write(`\n▶ ${sc.name}\n`);
    const run = await runScenario(sc);
    for (const check of sc.checks) {
      const ok = check.ok(run);
      if (!ok) failed += 1;
      console.log(`   ${ok ? '✅' : '❌'} ${check.what}`);
    }
    console.log(`   задач: ${run.tasks.length}, вызовов инструментов: ${run.toolCalls.length}, макс. параллельно: ${run.maxParallel}`);
    if (sc.checks.some((c) => !c.ok(run))) {
      console.log(`   ── ответ PM ──\n   ${run.pmText.trim().replace(/\n/g, '\n   ').slice(0, 600)}`);
    }
  }

  console.log(failed === 0 ? '\nВсе проверки прошли' : `\nПРОВАЛЕНО проверок: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();

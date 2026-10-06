/**
 * Тест сводки доски (src/server/board-view.ts) на синтетической доске:
 * 400 задач, 30 фич, несколько вопросов. Без сервера и без состояния офиса.
 *
 * Запуск: npm run test:boardview
 */
import assert from 'node:assert/strict';
import {
  BOARD_CAP, formatBoard, type BoardEpic, type BoardInput, type BoardQuestion, type BoardTask,
} from '../src/server/board-view';
import type { EpicHold, EpicStatus, TaskStatus } from '../src/shared/types';

let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

// ------------------------------------------------------------- доска

const EPICS = 30;
const TASKS = 400;

const epics: BoardEpic[] = Array.from({ length: EPICS }, (_, i) => {
  const n = i + 1;
  // Первые десять закрыты, следующие — вперемешку активные и плановые с простоем.
  const status: EpicStatus = n <= 10 ? 'done' : n === 11 ? 'cancelled' : n % 2 ? 'active' : 'planned';
  let hold: EpicHold | null = null;
  if (status === 'planned') hold = n % 4 === 0 ? { kind: 'approval' } : { kind: 'slot', epics: ['E-13', 'E-15'] };
  if (n === 13) hold = { kind: 'stuck', tasks: ['T-13'] };
  return {
    id: `E-${n}`, title: `Фича номер ${n} с довольно длинным названием`, status, order: n, hold,
    goal: `Цель фичи ${n}`,
  };
});

/** Статус задачи по номеру: большинство закрыто, хвост — живой. */
function statusOf(n: number): TaskStatus {
  if (n <= 300) return n % 10 === 0 ? 'cancelled' : 'done';
  const live: TaskStatus[] = ['backlog', 'assigned', 'in_progress', 'review', 'blocked', 'failed', 'planned'];
  return live[n % live.length];
}

const tasks: BoardTask[] = Array.from({ length: TASKS }, (_, i) => {
  const n = i + 1;
  const status = statusOf(n);
  return {
    id: `T-${n}`,
    title: `Задача ${n}: сделать что-то полезное в модуле и не сломать соседей`,
    status,
    roleId: `backend-${(n % 3) + 1}`,
    assigneeId: status === 'in_progress' ? `agent-${n % 5}` : null,
    epicId: `E-${(n % EPICS) + 1}`,
    order: n,
    priority: n % 17 === 0 ? 'high' : 'normal',
    dependsOn: n > 1 && n % 7 === 0 ? [`T-${n - 1}`] : [],
    // Часть сданных ещё не влита — должны попасть в живые как «ждёт слияния».
    merged: status === 'done' && n % 50 !== 1,
    branch: `task/T-${n}`,
    result: status === 'done' ? `Сделано в задаче ${n}. `.repeat(20) : null,
    criteria: [{ text: 'одно', done: true }, { text: 'другое', done: status === 'done' }],
  };
});

const questions: BoardQuestion[] = [
  { id: 'Q-1', taskId: 'T-305', text: 'Какой цвет кнопки?', answer: null, dismissedAt: null },
  { id: 'Q-2', taskId: null, text: 'Уже отвечен', answer: 'синий', dismissedAt: null },
  { id: 'Q-3', taskId: null, text: 'Нужен ли тёмный режим?', answer: null, dismissedAt: null },
];

const input: BoardInput = { tasks, epics, questions, autoPipeline: true };

// ------------------------------------------------------------- проверки

console.log('board-view:');

const summary = formatBoard(input);

check('сводка укладывается в потолок', () => {
  assert.ok(summary.length <= BOARD_CAP, `длина ${summary.length}`);
  assert.ok(!summary.includes('обрезано'), 'сводка не должна обрезаться на 400 задачах');
});

check('сводка: счётчики по статусам', () => {
  assert.match(summary, /Задач всего 400: /);
  assert.match(summary, /cancelled 30/);
});

check('сводка: фичи с прогрессом и причиной простоя', () => {
  assert.match(summary, /E-12 «[^»]+» \[planned\] \d+ из \d+ — ждёт «поехали» владельца/);
  assert.match(summary, /E-14 «[^»]+» \[planned\] \d+ из \d+ — ждёт слота: заняты E-13, E-15/);
  assert.match(summary, /E-13 «[^»]+» \[active\] \d+ из \d+ — T-13 провалены/);
  assert.ok(!/^E-1 «/m.test(summary), 'закрытая фича строкой не показывается');
  assert.match(summary, /Закрыто фич: 10, снято: 1/);
});

check('сводка: живые задачи строками, закрытые числом', () => {
  assert.match(summary, /^T-301 \[\w+\]/m);
  assert.match(summary, /→ agent-\d/, 'исполнитель в строке');
  assert.match(summary, /→ backend-\d/, 'роль в строке');
  assert.match(summary, /после T-\d+/, 'зависимости в строке');
  assert.match(summary, /\[done, ждёт слияния\]/);
  assert.match(summary, /Влито: \d+, закрыто без слияния: 0, снято: 30/);
  assert.ok(!/^T-2 \[/m.test(summary), 'влитая задача строкой не показывается');
  assert.ok(!summary.includes('Сделано в задаче'), 'результаты в сводку не попадают');
});

check('сводка: открытые вопросы, отвеченные скрыты', () => {
  assert.match(summary, /Q-1 \(T-305\): Какой цвет кнопки\?/);
  assert.match(summary, /Q-3: Нужен ли тёмный режим\?/);
  assert.ok(!summary.includes('Q-2'));
});

check('featureId: одна фича со всеми задачами', () => {
  const text = formatBoard(input, { featureId: 'E-5', limit: 200 });
  const own = tasks.filter((x) => x.epicId === 'E-5');
  assert.ok(text.startsWith('E-5 «'), text.slice(0, 80));
  for (const t of own) assert.match(text, new RegExp(`^${t.id} \\[`, 'm'));
  const rows = text.split('\n').filter((l) => /^T-\d+ \[/.test(l));
  assert.equal(rows.length, own.length);
  assert.match(text, /Это всё\./);
  assert.match(formatBoard(input, { featureId: 'E-999' }), /Фичи E-999 нет/);
});

check('status: строка и массив', () => {
  const one = formatBoard(input, { status: 'failed', limit: 200 });
  const rows = one.split('\n').filter((l) => /^T-\d+ \[/.test(l));
  const want = tasks.filter((x) => x.status === 'failed').length;
  assert.equal(rows.length, want);
  assert.ok(rows.every((l) => l.includes('[failed]')));
  const two = formatBoard(input, { status: ['failed', 'blocked'], limit: 200 });
  const rows2 = two.split('\n').filter((l) => /^T-\d+ \[/.test(l));
  assert.equal(rows2.length, want + tasks.filter((x) => x.status === 'blocked').length);
  assert.match(formatBoard(input, { status: 'nope' }), /Неизвестный статус: nope/);
});

check('taskIds: конкретные задачи и неизвестные', () => {
  const text = formatBoard(input, { taskIds: ['T-7', 'T-399', 'T-9999'] });
  assert.match(text, /^T-7 \[/m);
  assert.match(text, /^T-399 \[/m);
  assert.match(text, /Нет таких задач: T-9999/);
});

check('limit/offset: страницы без пропусков и пометка «есть ещё»', () => {
  const seen = new Set<string>();
  let offset = 0;
  for (let guard = 0; guard < 50; guard++) {
    const text = formatBoard(input, { status: 'done', limit: 40, offset });
    for (const l of text.split('\n')) {
      const m = /^(T-\d+) \[/.exec(l);
      if (m) {
        assert.ok(!seen.has(m[1]), `повтор ${m[1]}`);
        seen.add(m[1]);
      }
    }
    const next = /Есть ещё — offset=(\d+)/.exec(text);
    if (!next) break;
    offset = Number(next[1]);
  }
  assert.equal(seen.size, tasks.filter((x) => x.status === 'done').length);
});

check('потолок: длинная выборка обрезается с пометкой', () => {
  const text = formatBoard(input, { status: 'done', limit: 200 });
  assert.ok(text.length <= BOARD_CAP, `длина ${text.length}`);
  assert.match(text, /обрезано.*сузь выборку/);
  const small = formatBoard(input, { cap: 500 });
  assert.ok(small.length <= 500);
  assert.match(small, /сузь выборку/);
});

check('пустая доска', () => {
  assert.match(formatBoard({ tasks: [], epics: [] }), /Доска пуста/);
});

if (failed) {
  console.log(`\nпровалено: ${failed}`);
  process.exit(1);
}
console.log('\nвсё прошло');

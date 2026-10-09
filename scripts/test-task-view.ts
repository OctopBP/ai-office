/**
 * Проверка task-view.ts: короткий review_status (невлитые и влитые за сутки,
 * остальные числом), постраничный режим all=true и карточка get_task.
 *
 * Запуск: node --import tsx/esm scripts/test-task-view.ts
 */
import assert from 'node:assert/strict';
import type { PullRequestView } from '../src/shared/types';
import {
  pickReviews, reviewStatusText, taskDetails, RECENT_MERGED_MS, type TaskForView,
} from '../src/server/task-view';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const pr = (taskId: string, stage: PullRequestView['stage'], ago: number, extra: Partial<PullRequestView> = {}): PullRequestView => ({
  id: `pr-${taskId}`, taskId, title: `Задача ${taskId}`, branch: `task/${taskId}`, base: 'main',
  repoDir: '/repo', number: null, url: null, stage, note: `заметка ${taskId}`, rounds: 0, retries: 0,
  nextTryAt: null, needsDecision: false, reviewerId: null, reviews: [],
  createdAt: NOW - ago - HOUR, updatedAt: NOW - ago, gate: null, ...extra,
});

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`✓ ${name}`);
};

// Конвейер: два едущих (один старый), один вставший, два свежих влитых, три старых влитых.
const prs = [
  pr('T-1', 'review', 2 * HOUR),
  pr('T-2', 'rework', 10 * 24 * HOUR),
  pr('T-3', 'stuck', 5 * HOUR),
  pr('T-4', 'merged', 1 * HOUR),
  pr('T-5', 'merged', 23 * HOUR),
  pr('T-6', 'merged', 25 * HOUR),
  pr('T-7', 'merged', 3 * 24 * HOUR),
  pr('T-8', 'merged', 30 * 24 * HOUR),
];

check('по умолчанию: невлитые и влитые за сутки, свежие сверху', () => {
  const pick = pickReviews(prs, { now: NOW });
  assert.deepEqual(pick.shown.map((p) => p.taskId), ['T-4', 'T-1', 'T-3', 'T-5', 'T-2']);
  assert.equal(pick.olderMerged, 3);
  assert.equal(pick.total, 8);
  assert.equal(pick.hasMore, false);
});

check('граница суток: влитое ровно сутки назад ещё показывается', () => {
  const pick = pickReviews([pr('T-9', 'merged', RECENT_MERGED_MS)], { now: NOW });
  assert.equal(pick.shown.length, 1);
  assert.equal(pick.olderMerged, 0);
});

check('текст по умолчанию: строка «ещё N влито раньше»', () => {
  const text = reviewStatusText(prs, { now: NOW }, 'ru');
  assert.match(text, /ещё 3 закрыто раньше/);
  assert.ok(!text.includes('T-8'));
  assert.ok(text.includes('T-2 «Задача T-2»'));
});

check('всё давно влито: пишет, что свежего нет, и число', () => {
  const text = reviewStatusText([pr('T-8', 'merged', 30 * 24 * HOUR)], { now: NOW }, 'ru');
  assert.match(text, /Невлитых задач нет/);
  assert.match(text, /ещё 1 закрыто раньше/);
});

check('пустой конвейер', () => {
  assert.equal(reviewStatusText([], {}, 'ru'), 'Сданных задач в конвейере нет.');
});

check('all=true: страницы и признак «есть ещё»', () => {
  const first = pickReviews(prs, { all: true, limit: 3, now: NOW });
  assert.deepEqual(first.shown.map((p) => p.taskId), ['T-4', 'T-1', 'T-3']);
  assert.equal(first.hasMore, true);
  const last = pickReviews(prs, { all: true, limit: 3, offset: 6, now: NOW });
  assert.deepEqual(last.shown.map((p) => p.taskId), ['T-2', 'T-8']);
  assert.equal(last.hasMore, false);
  const text = reviewStatusText(prs, { all: true, limit: 3, offset: 3, now: NOW }, 'ru');
  assert.match(text, /показаны 4–6 из 8/);
  assert.match(text, /offset=6/);
  const beyond = reviewStatusText(prs, { all: true, limit: 3, offset: 20 }, 'ru');
  assert.match(beyond, /на этой странице пусто/);
});

check('all=true без limit: страница по умолчанию вмещает всё', () => {
  const pick = pickReviews(prs, { all: true });
  assert.equal(pick.shown.length, 8);
  assert.equal(pick.hasMore, false);
});

const task: TaskForView = {
  id: 'T-10', title: 'Сделать get_task', description: 'Полное ТЗ\nвторая строка '.repeat(30),
  criteria: [{ text: 'Первый', done: true }, { text: 'Второй', done: false }],
  roleId: 'backend', assigneeId: 'backend#4', status: 'review', priority: 'high',
  epicId: 'F-2', dependsOn: ['T-8', 'T-99'], result: 'Сделал инструмент',
  handoff: { did: 'Сделал инструмент', assumed: 'страница 30', left: 'ничего' },
  merged: false, branch: 'task/T-10',
};

check('get_task: все поля, ТЗ без обрезки, критерии с отметками', () => {
  const text = taskDetails(task, {
    epic: { id: 'F-2', title: 'Менеджеру удобнее' },
    pr: pr('T-10', 'rework', HOUR, {
      rounds: 1,
      reviews: [
        { at: NOW - 3 * HOUR, verdict: 'approve', reviewerId: 'reviewer#1', text: 'старый отзыв' },
        { at: NOW - 2 * HOUR, verdict: 'changes', reviewerId: 'reviewer#1', text: 'поправь описание' },
      ],
    }),
    depStatus: { 'T-8': 'done' },
    lang: 'ru',
  });
  assert.ok(text.startsWith('T-10 «Сделать get_task»'));
  assert.match(text, /Статус: review/);
  assert.match(text, /Приоритет: высокий/);
  assert.match(text, /Роль: backend, исполнитель: backend#4/);
  assert.match(text, /Фича: F-2 «Менеджеру удобнее»/);
  assert.match(text, /Зависит от: T-8 \[done\], T-99/);
  assert.ok(text.includes(task.description.trim()), 'ТЗ целиком');
  assert.match(text, /Критерии 1\/2:\n✓ 1\. Первый\n· 2\. Второй/);
  assert.match(text, /Итог исполнителя:\nСделал инструмент/);
  assert.match(text, /Решил сам: страница 30/);
  assert.match(text, /Ревью: \S/);
  assert.match(text, /кругов доработки: 1/);
  assert.match(text, /Последний отзыв \(нужны правки, reviewer#1\):\nпоправь описание/);
  assert.ok(!text.includes('старый отзыв'));
});

check('get_task: задача без фичи, зависимостей и ревью', () => {
  const text = taskDetails(
    { ...task, epicId: null, dependsOn: [], result: null, handoff: null, priority: 'normal', assigneeId: null },
    { epic: null, pr: null, lang: 'en' },
  );
  assert.match(text, /Feature: —/);
  assert.match(text, /Depends on: —/);
  assert.match(text, /assignee: —/);
  assert.match(text, /Priority: normal/);
  assert.match(text, /Review: never handed in/);
  assert.ok(!text.includes('Worker’s result'));
});

console.log(`\nВсе проверки пройдены: ${passed}`);

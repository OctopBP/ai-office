/**
 * Тест модели раскладки окон (src/web/layout): операции, зажим размеров,
 * перенос, сохранение и восстановление. Без DOM и сервера.
 *
 * Запуск: node --import tsx/esm scripts/test-layout.ts (npm run test:layout)
 */
import assert from 'node:assert/strict';
import {
  activate, clampSize, closeOthers, closeWindow, defaultLayout, defaultRuntime, displayLayout, dockRange,
  effectiveSize, findWindow, makeRef, maximizeRuntime, moveWindow, normalize, openWindow, reorder,
  resetDockSize, resizeDock, syncRuntime, toggleCollapsed, toggleDock, DOCK_DEFAULT, DOCK_MIN, MAIN_MIN,
  STRIP_SIZE, type Layout,
} from '../src/web/layout/model';
import { createSaver, layoutKey, loadLayout, saveLayout, type KeyValueStore } from '../src/web/layout/persist';

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

const COL = { w: 1200, h: 800 };
const term = makeRef('terminal', '1');
const log = makeRef('log');
const docs = makeRef('docs');

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

console.log('открыть / закрыть');
check('окно открывается в своём доке по умолчанию', () => {
  let l = openWindow(defaultLayout(), term);
  l = openWindow(l, docs);
  assert.deepEqual(l.docks.bottom?.tabs.map((w) => w.id), ['terminal:1']);
  assert.deepEqual(l.docks.right?.tabs.map((w) => w.id), ['docs']);
  assert.equal(l.docks.bottom?.size, DOCK_DEFAULT.bottom);
  assert.equal(l.focus, 'right');
});
check('повторное открытие фокусирует и разворачивает, не дублирует', () => {
  let l = openWindow(openWindow(defaultLayout(), term), log);
  l = toggleCollapsed(l, 'bottom');
  l = openWindow(l, term);
  assert.equal(l.docks.bottom?.tabs.length, 2);
  assert.equal(l.docks.bottom?.active, 'terminal:1');
  assert.equal(l.docks.bottom?.collapsed, false);
});
check('закрытие активной выбирает соседа, последняя убирает док', () => {
  let l = openWindow(openWindow(openWindow(defaultLayout(), term), log), makeRef('diff', 'T-1'));
  l = closeWindow(l, 'diff:T-1');
  assert.equal(l.docks.bottom?.active, 'log');
  l = closeWindow(closeWindow(l, 'log'), 'terminal:1');
  assert.equal(l.docks.bottom, undefined);
  assert.equal(l.focus, 'main');
});
check('закрытие неизвестного — тот же объект', () => {
  const l = defaultLayout();
  assert.equal(closeWindow(l, 'nope'), l);
});
check('toggleDock: нет дока — открыть терминал; есть — свернуть/развернуть', () => {
  let l = toggleDock(defaultLayout(), 'bottom');
  assert.equal(l.docks.bottom?.tabs[0]?.kind, 'terminal');
  l = toggleDock(l, 'bottom');
  assert.equal(l.docks.bottom?.collapsed, true);
  l = toggleDock(l, 'bottom');
  assert.equal(l.docks.bottom?.collapsed, false);
  assert.equal(toggleDock(defaultLayout(), 'left').docks.left, undefined);
});
check('activate разворачивает док и ставит фокус', () => {
  let l = toggleCollapsed(openWindow(openWindow(defaultLayout(), term), log), 'bottom');
  l = activate(l, 'bottom', 'log');
  assert.equal(l.docks.bottom?.active, 'log');
  assert.equal(l.docks.bottom?.collapsed, false);
  assert.equal(l.focus, 'bottom');
});
check('closeOthers оставляет одну вкладку', () => {
  const l = closeOthers(openWindow(openWindow(defaultLayout(), term), log), 'bottom', 'log');
  assert.deepEqual(l.docks.bottom?.tabs.map((w) => w.id), ['log']);
});

console.log('перенос и порядок');
check('moveWindow переносит в другой док, пустой исходный удаляется', () => {
  let l = openWindow(defaultLayout(), docs);
  l = moveWindow(l, 'docs', 'left');
  assert.equal(l.docks.right, undefined);
  assert.equal(l.docks.left?.active, 'docs');
  assert.equal(l.focus, 'left');
});
check('moveWindow в существующий док — на указанное место', () => {
  let l = openWindow(openWindow(openWindow(defaultLayout(), term), log), docs);
  l = moveWindow(l, 'docs', 'bottom', 1);
  assert.deepEqual(l.docks.bottom?.tabs.map((w) => w.id), ['terminal:1', 'docs', 'log']);
  assert.equal(l.docks.bottom?.active, 'docs');
  assert.equal(l.docks.right, undefined);
});
check('id остаются уникальными во всём Layout', () => {
  let l = openWindow(openWindow(defaultLayout(), term), docs);
  l = moveWindow(moveWindow(l, 'docs', 'bottom'), 'terminal:1', 'left');
  const ids = Object.values(l.docks).flatMap((d) => d!.tabs.map((w) => w.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(findWindow(l, 'docs'), { dock: 'bottom', index: 0 });
});
check('reorder меняет порядок и зажимает границы', () => {
  let l = openWindow(openWindow(openWindow(defaultLayout(), term), log), makeRef('merge'));
  l = reorder(l, 'bottom', 0, 2);
  assert.deepEqual(l.docks.bottom?.tabs.map((w) => w.id), ['log', 'merge', 'terminal:1']);
  l = reorder(l, 'bottom', 2, 99);
  assert.deepEqual(l.docks.bottom?.tabs.map((w) => w.id), ['log', 'merge', 'terminal:1']);
});

console.log('размеры');
check('минимум дока', () => {
  const l = openWindow(defaultLayout(), term);
  assert.equal(resizeDock(l, 'bottom', 10, COL).docks.bottom?.size, DOCK_MIN.bottom);
});
check('максимум нижнего — 70 % высоты и минимум основной области', () => {
  const l = openWindow(defaultLayout(), term);
  assert.equal(resizeDock(l, 'bottom', 9999, COL).docks.bottom?.size, 560);
  assert.equal(dockRange('bottom', l, { w: 1200, h: 400 }).max, 400 - MAIN_MIN.h);
});
check('боковой упирается в соседа и не сдвигает его', () => {
  let l = openWindow(openWindow(defaultLayout(), docs), makeRef('agent', 'be'), 'left');
  l = resizeDock(l, 'left', 400, COL);
  l = resizeDock(l, 'right', 9999, COL);
  assert.equal(l.docks.left?.size, 400);
  assert.equal(l.docks.right?.size, COL.w - MAIN_MIN.w - 400);
});
check('свёрнутый сосед занимает 26 px', () => {
  let l = openWindow(openWindow(defaultLayout(), docs), makeRef('agent', 'be'), 'left');
  l = toggleCollapsed(l, 'left');
  assert.equal(dockRange('right', l, COL).max, Math.min(720, COL.w - MAIN_MIN.w - STRIP_SIZE));
});
check('effectiveSize зажимает при малом окне, не портя состояние', () => {
  const l = resizeDock(openWindow(defaultLayout(), docs), 'right', 600, COL);
  assert.equal(effectiveSize('right', l, { w: 700, h: 600 }), 340);
  assert.equal(l.docks.right?.size, 600);
});
check('сброс размера — умолчание; NaN — умолчание', () => {
  let l = resizeDock(openWindow(defaultLayout(), docs), 'right', 300, COL);
  assert.equal(resetDockSize(l, 'right', COL).docks.right?.size, 430);
  assert.equal(clampSize('right', NaN, l, COL), 430);
});
check('resize без дока — тот же объект', () => {
  const l = defaultLayout();
  assert.equal(resizeDock(l, 'bottom', 300, COL), l);
});

console.log('разворот и узкий режим');
check('maximize: повтор возвращает; исчезнувший док снимает', () => {
  let l = openWindow(defaultLayout(), term);
  let rt = maximizeRuntime(defaultRuntime(), l, 'bottom');
  assert.equal(rt.maximized, 'bottom');
  assert.equal(maximizeRuntime(rt, l, 'bottom').maximized, null);
  assert.equal(maximizeRuntime(defaultRuntime(), l, 'right').maximized, null);
  l = closeWindow(l, 'terminal:1');
  rt = syncRuntime(rt, l);
  assert.equal(rt.maximized, null);
});
check('узкое окно: боковые вкладки уходят в нижний, модель не меняется', () => {
  const l = openWindow(openWindow(defaultLayout(), term), docs);
  const d = displayLayout(l, { w: 800 });
  assert.deepEqual(d.docks.bottom?.tabs.map((w) => w.id), ['terminal:1', 'docs']);
  assert.equal(d.docks.right, undefined);
  assert.ok(l.docks.right);
  assert.equal(displayLayout(l, { w: 1200 }), l);
});

console.log('сохранение и восстановление');
check('круг: сохранили — прочитали то же', () => {
  const store = memStore();
  let l = openWindow(openWindow(defaultLayout(), term), docs);
  l = resizeDock(l, 'right', 350, COL);
  l = toggleCollapsed(l, 'bottom');
  saveLayout('o-1', l, store);
  assert.deepEqual(loadLayout('o-1', store), l);
});
check('раскладка у каждого офиса своя', () => {
  const store = memStore();
  saveLayout('o-1', openWindow(defaultLayout(), term), store);
  assert.deepEqual(loadLayout('o-2', store), defaultLayout());
  assert.ok(store.data.has(layoutKey('o-1')));
});
check('битые данные дают умолчание', () => {
  const store = memStore();
  for (const bad of ['{не json', 'null', '[]', '{"v":2,"docks":{}}', '{"v":1}', '"x"']) {
    store.setItem(layoutKey('o'), bad);
    assert.deepEqual(loadLayout('o', store), defaultLayout(), bad);
  }
  assert.deepEqual(loadLayout('o', null), defaultLayout());
});
check('нормализация чинит инварианты', () => {
  const l = normalize({
    v: 1,
    focus: 'left',
    docks: {
      bottom: {
        tabs: [
          { id: 'terminal:1', kind: 'terminal' },
          { id: 'terminal:1', kind: 'terminal' },
          { id: 'x', kind: 'weird' },
          { id: 'log', kind: 'log' },
        ],
        active: 'ghost', size: 5, collapsed: 'yes',
      },
      right: { tabs: [{ id: 'log', kind: 'log' }], active: 'log', size: 300 },
      left: { tabs: [], active: null, size: 300 },
    },
  }) as Layout;
  assert.deepEqual(l.docks.bottom?.tabs.map((w) => w.id), ['terminal:1', 'log']);
  assert.equal(l.docks.bottom?.active, 'terminal:1');
  assert.equal(l.docks.bottom?.size, DOCK_MIN.bottom);
  assert.equal(l.docks.bottom?.collapsed, false);
  assert.equal(l.docks.right, undefined);
  assert.equal(l.docks.left, undefined);
  assert.equal(l.focus, 'main');
});
check('сохранитель сливает частые записи', async () => {
  const store = memStore();
  const saver = createSaver(store, 20);
  saver.schedule('o', openWindow(defaultLayout(), term));
  saver.schedule('o', openWindow(defaultLayout(), docs));
  assert.equal(store.data.size, 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(loadLayout('o', store).docks.right?.tabs.map((w) => w.id), ['docs']);
  assert.equal(loadLayout('o', store).docks.bottom, undefined);
});
check('flush пишет сразу; смена офиса дописывает прежний', () => {
  const store = memStore();
  const saver = createSaver(store, 10_000);
  saver.schedule('a', openWindow(defaultLayout(), term));
  saver.schedule('b', openWindow(defaultLayout(), docs));
  assert.ok(store.data.has(layoutKey('a')));
  saver.flush();
  assert.ok(store.data.has(layoutKey('b')));
});

// check с async не ждёт — даём таймерам отработать перед итогом
setTimeout(() => {
  if (failed) {
    console.log(`\nПровалено: ${failed}`);
    process.exit(1);
  }
  console.log('\nВсе проверки раскладки прошли');
}, 150);

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
import {
  applyDrop, edgeRect, highlightOf, pastThreshold, resolveDrop, sameTarget, slotAt, DRAG_START,
  type DropGeometry, type Rect,
} from '../src/web/layout/dropzone';
import { matchHotkey, nextTerminalId, runHotkey, worksInTextTarget, type HotkeyApi, type KeyInfo } from '../src/web/layout/hotkeys';
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

console.log('горячие клавиши');
const key = (o: Partial<KeyInfo>): KeyInfo => ({ code: '', key: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
const mac = (code: string, o: Partial<KeyInfo> = {}) => key({ code, metaKey: true, ...o });
check('сопоставление сочетаний §2.7', () => {
  assert.deepEqual(matchHotkey(mac('Backquote'), false), { type: 'toggle-bottom' });
  assert.deepEqual(matchHotkey(key({ code: 'Backquote', ctrlKey: true }), false), { type: 'toggle-bottom' });
  assert.deepEqual(matchHotkey(mac('Backquote', { shiftKey: true }), false), { type: 'new-terminal' });
  assert.deepEqual(matchHotkey(mac('KeyJ'), false), { type: 'collapse-bottom' });
  assert.deepEqual(matchHotkey(mac('ArrowLeft', { altKey: true }), false), { type: 'move', dock: 'left' });
  assert.deepEqual(matchHotkey(mac('ArrowRight', { altKey: true }), false), { type: 'move', dock: 'right' });
  assert.deepEqual(matchHotkey(mac('ArrowDown', { altKey: true }), false), { type: 'move', dock: 'bottom' });
  assert.deepEqual(matchHotkey(mac('Digit1', { altKey: true }), false), { type: 'focus', target: 'left' });
  assert.deepEqual(matchHotkey(mac('Digit2', { altKey: true }), false), { type: 'focus', target: 'main' });
  assert.deepEqual(matchHotkey(mac('Digit3', { altKey: true }), false), { type: 'focus', target: 'right' });
  assert.deepEqual(matchHotkey(mac('Digit4', { altKey: true }), false), { type: 'focus', target: 'bottom' });
  assert.deepEqual(matchHotkey(key({ code: 'Escape', key: 'Escape' }), false), { type: 'escape' });
});
check('⌘⇧↵, ⌘W и Ctrl+Tab — только при фокусе в доке', () => {
  assert.equal(matchHotkey(mac('Enter', { shiftKey: true }), false), null);
  assert.deepEqual(matchHotkey(mac('Enter', { shiftKey: true }), true), { type: 'maximize' });
  assert.equal(matchHotkey(mac('KeyW'), false), null);
  assert.deepEqual(matchHotkey(mac('KeyW'), true), { type: 'close-tab' });
  assert.equal(matchHotkey(key({ code: 'Tab', ctrlKey: true }), false), null);
  assert.deepEqual(matchHotkey(key({ code: 'Tab', ctrlKey: true }), true), { type: 'tab', step: 1 });
  assert.deepEqual(matchHotkey(key({ code: 'Tab', ctrlKey: true, shiftKey: true }), true), { type: 'tab', step: -1 });
});
check('обычные клавиши без модификатора не трогаем', () => {
  assert.equal(matchHotkey(key({ code: 'KeyJ', key: 'j' }), true), null);
  assert.equal(matchHotkey(key({ code: 'Backquote', key: '`' }), true), null);
  assert.equal(matchHotkey(key({ code: 'KeyW', key: 'w' }), true), null);
  assert.equal(matchHotkey(mac('KeyJ', { shiftKey: true }), true), null);
});
check('в поле ввода и терминале — только ⌘`, ⌘⇧`, ⌘⌥…', () => {
  const ok = [mac('Backquote'), mac('Backquote', { shiftKey: true }), mac('ArrowLeft', { altKey: true }), mac('Digit4', { altKey: true })];
  for (const k of ok) assert.ok(worksInTextTarget(matchHotkey(k, true)!));
  for (const k of [mac('KeyJ'), mac('KeyW'), mac('Enter', { shiftKey: true }), key({ code: 'Escape', key: 'Escape' }), key({ code: 'Tab', ctrlKey: true })]) {
    assert.ok(!worksInTextTarget(matchHotkey(k, true)!));
  }
});
check('номер нового терминала — следующий за наибольшим', () => {
  assert.equal(nextTerminalId(defaultLayout()), '1');
  let l = openWindow(defaultLayout(), makeRef('terminal', '1'));
  l = openWindow(l, makeRef('terminal', '3'), 'right');
  assert.equal(nextTerminalId(l), '4');
});

/** Запись вызовов вместо стора. */
function fakeApi(layout: Layout, rt: Partial<HotkeyApi> = {}): { api: HotkeyApi; calls: string[] } {
  const calls: string[] = [];
  const api: HotkeyApi = {
    layout, maximized: null, drag: null, ...rt,
    openWindow: (ref, dock) => calls.push(`open ${ref.id} ${dock}`),
    toggleDock: (d) => calls.push(`toggle ${d}`),
    toggleCollapsed: (d) => calls.push(`collapse ${d}`),
    moveWindow: (id, d) => calls.push(`move ${id} ${d}`),
    activate: (d, id) => calls.push(`activate ${d} ${id}`),
    closeWindow: (id) => calls.push(`close ${id}`),
    setFocus: (f) => calls.push(`focus ${f}`),
    maximize: (d) => calls.push(`max ${d}`),
    setDrag: (d) => calls.push(`drag ${d}`),
  };
  return { api, calls };
}
check('⌘` зовёт стор по id окна терминала', () => {
  const a = fakeApi(defaultLayout());
  assert.ok(runHotkey({ type: 'toggle-bottom' }, a.api));
  assert.deepEqual(a.calls, ['open terminal:1 bottom']);
  const b = fakeApi(openWindow(defaultLayout(), term));
  runHotkey({ type: 'toggle-bottom' }, b.api);
  assert.deepEqual(b.calls, ['toggle bottom']);
  const c = fakeApi(openWindow(defaultLayout(), term));
  runHotkey({ type: 'new-terminal' }, c.api);
  assert.deepEqual(c.calls, ['open terminal:2 bottom']);
});
check('перенос, вкладки, закрытие — по активной вкладке дока в фокусе', () => {
  let l = openWindow(openWindow(openWindow(defaultLayout(), term), log), docs);
  l = activate(l, 'bottom', 'log');
  const a = fakeApi(l);
  runHotkey({ type: 'move', dock: 'left' }, a.api);
  runHotkey({ type: 'tab', step: 1 }, a.api);
  runHotkey({ type: 'tab', step: -1 }, a.api);
  runHotkey({ type: 'close-tab' }, a.api);
  runHotkey({ type: 'maximize' }, a.api);
  assert.deepEqual(a.calls, ['move log left', 'activate bottom terminal:1', 'activate bottom terminal:1', 'close log', 'max bottom']);
});
check('фокус в основной области: действия дока не срабатывают', () => {
  const a = fakeApi(openWindow(defaultLayout(), term));
  const main = { ...a.api.layout, focus: 'main' as const };
  const b = fakeApi(main);
  for (const act of [{ type: 'move', dock: 'right' }, { type: 'close-tab' }, { type: 'maximize' }, { type: 'tab', step: 1 }] as const) {
    assert.equal(runHotkey(act, b.api), false);
  }
  assert.equal(runHotkey({ type: 'focus', target: 'left' }, b.api), false);
  assert.equal(runHotkey({ type: 'focus', target: 'bottom' }, b.api), true);
  assert.equal(runHotkey({ type: 'collapse-bottom' }, fakeApi(defaultLayout()).api), false);
});
check('Esc: перенос, затем разворот, иначе — приложению', () => {
  const l = openWindow(defaultLayout(), term);
  const drag = { win: 'terminal:1', label: 'Терминал', x: 0, y: 0, over: null, geo: { column: { x: 0, y: 0, w: 1, h: 1 }, docks: {} } };
  const a = fakeApi(l, { drag, maximized: 'bottom' });
  assert.ok(runHotkey({ type: 'escape' }, a.api));
  assert.deepEqual(a.calls, ['drag null']);
  const b = fakeApi(l, { maximized: 'bottom' });
  assert.ok(runHotkey({ type: 'escape' }, b.api));
  assert.deepEqual(b.calls, ['max null']);
  assert.equal(runHotkey({ type: 'escape' }, fakeApi(l).api), false);
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

// ---- зоны сброса вкладки (dropzone.ts)
const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const tabRects = [R(10, 0, 80, 30), R(94, 0, 80, 30), R(178, 0, 80, 30)];
const GEO: DropGeometry = {
  column: R(0, 0, 1000, 800),
  docks: {
    bottom: { rect: R(0, 520, 1000, 280), head: R(0, 520, 1000, 30), tabs: tabRects.map((r) => ({ ...r, y: 520 })), vertical: false },
  },
};
check('порог отрыва: 5 px — клик, 6 px — перенос', () => {
  assert.equal(pastThreshold(3, 4), false);
  assert.equal(pastThreshold(0, DRAG_START), true);
});
check('слот по серединам вкладок', () => {
  assert.equal(slotAt(tabRects, false, 0, 0), 0);
  assert.equal(slotAt(tabRects, false, 60, 0), 1);
  assert.equal(slotAt(tabRects, false, 500, 0), 3);
  assert.equal(slotAt(tabRects, true, 0, 5), 0);
});
check('шапка дока: зона «вкладка» со слотом', () => {
  assert.deepEqual(resolveDrop(130, 530, GEO), { kind: 'tab', dock: 'bottom', slot: 1 });
});
check('края колонки: 30 % слева, справа и снизу', () => {
  assert.deepEqual(resolveDrop(100, 200, GEO), { kind: 'edge', dock: 'left' });
  assert.deepEqual(resolveDrop(900, 200, GEO), { kind: 'edge', dock: 'right' });
  assert.deepEqual(resolveDrop(500, 700, GEO), { kind: 'edge', dock: 'bottom' });
  assert.equal(resolveDrop(500, 200, GEO), null);
  assert.equal(resolveDrop(299, 200, GEO)?.kind, 'edge');
  assert.equal(resolveDrop(301, 200, GEO), null);
});
check('в углу выигрывает зона, куда зашли глубже', () => {
  assert.deepEqual(resolveDrop(10, 700, GEO), { kind: 'edge', dock: 'left' });
  assert.deepEqual(resolveDrop(280, 790, GEO), { kind: 'edge', dock: 'bottom' });
});
check('вне колонки зоны нет; шапка важнее края', () => {
  assert.equal(resolveDrop(-5, 100, GEO), null);
  assert.equal(resolveDrop(50, 530, GEO)?.kind, 'tab');
});
check('тело существующего дока вне краёв — в конец его вкладок', () => {
  const g: DropGeometry = { column: R(0, 0, 1000, 800), docks: { right: { rect: R(570, 0, 430, 500), head: R(570, 0, 430, 30), tabs: [R(575, 0, 80, 30)], vertical: false } } };
  assert.deepEqual(resolveDrop(500, 250, { ...g, column: R(0, 0, 1000, 800) }), null);
  const g2: DropGeometry = { column: R(0, 0, 1000, 800), docks: { right: { rect: R(300, 0, 400, 500), head: R(300, 0, 400, 30), tabs: [R(305, 0, 80, 30)], vertical: false } } };
  assert.deepEqual(resolveDrop(500, 250, g2), { kind: 'tab', dock: 'right', slot: 1 });
});
check('свёрнутый боковой док: вкладки столбиком', () => {
  const g: DropGeometry = { column: R(0, 0, 1000, 800), docks: { left: { rect: R(0, 0, 26, 800), head: R(0, 0, 26, 800), tabs: [R(0, 0, 26, 100), R(0, 100, 26, 100)], vertical: true } } };
  assert.deepEqual(resolveDrop(10, 180, g), { kind: 'tab', dock: 'left', slot: 2 });
  assert.deepEqual(resolveDrop(10, 20, g), { kind: 'tab', dock: 'left', slot: 0 });
});
check('подсветка: зона края и риска вставки', () => {
  assert.deepEqual(edgeRect(GEO.column, 'right'), R(700, 0, 300, 800));
  assert.deepEqual(highlightOf({ kind: 'edge', dock: 'bottom' }, GEO)?.zone, R(0, 560, 1000, 240));
  const h = highlightOf({ kind: 'tab', dock: 'bottom', slot: 1 }, GEO)!;
  assert.deepEqual(h.zone, GEO.docks.bottom!.head);
  assert.equal(h.mark!.x, 94 - 1);
});
check('sameTarget сравнивает по содержимому', () => {
  assert.ok(sameTarget({ kind: 'tab', dock: 'left', slot: 1 }, { kind: 'tab', dock: 'left', slot: 1 }));
  assert.ok(!sameTarget({ kind: 'tab', dock: 'left', slot: 1 }, { kind: 'tab', dock: 'left', slot: 2 }));
  assert.ok(!sameTarget({ kind: 'edge', dock: 'left' }, { kind: 'tab', dock: 'left', slot: 0 }));
  assert.ok(sameTarget(null, null));
});
check('applyDrop: порядок внутри дока (слот считается до изъятия)', () => {
  let l = openWindow(openWindow(openWindow(defaultLayout(), term, 'bottom'), log, 'bottom'), docs, 'bottom');
  const ids = (x: Layout) => x.docks.bottom!.tabs.map((w) => w.id);
  const [a, b, c] = ids(l);
  assert.deepEqual(ids(applyDrop(l, a!, { kind: 'tab', dock: 'bottom', slot: 3 })), [b, c, a]);
  assert.deepEqual(ids(applyDrop(l, c!, { kind: 'tab', dock: 'bottom', slot: 0 })), [c, a, b]);
  assert.equal(applyDrop(l, b!, { kind: 'tab', dock: 'bottom', slot: 1 }), l);
  assert.equal(applyDrop(l, b!, { kind: 'tab', dock: 'bottom', slot: 2 }), l);
  assert.equal(applyDrop(l, b!, { kind: 'edge', dock: 'bottom' }), l);
});
check('applyDrop: перенос в другой док, в край, в свёрнутый и закрытый док', () => {
  let l = openWindow(openWindow(defaultLayout(), term, 'bottom'), log, 'bottom');
  l = openWindow(l, docs, 'right');
  const m = applyDrop(l, log.id, { kind: 'tab', dock: 'right', slot: 0 });
  assert.deepEqual(m.docks.right!.tabs.map((w) => w.id), [log.id, docs.id]);
  assert.equal(m.docks.right!.active, log.id);
  const edge = applyDrop(l, docs.id, { kind: 'edge', dock: 'left' });
  assert.deepEqual(edge.docks.left!.tabs.map((w) => w.id), [docs.id]);
  assert.equal(edge.docks.right, undefined);
  const col = toggleCollapsed(l, 'right');
  const into = applyDrop(col, log.id, { kind: 'tab', dock: 'right', slot: 1 });
  assert.equal(into.docks.right!.collapsed, false);
  assert.deepEqual(into.docks.right!.tabs.map((w) => w.id), [docs.id, log.id]);
});

// check с async не ждёт — даём таймерам отработать перед итогом
setTimeout(() => {
  if (failed) {
    console.log(`\nПровалено: ${failed}`);
    process.exit(1);
  }
  console.log('\nВсе проверки раскладки прошли');
}, 150);

/**
 * Песочница под роль (T-684): умолчания Unity, свои пути и хосты роли,
 * их хранение в состоянии офиса и правка через API ролей. Токенов не нужно:
 * всё это чистая логика над ролями и временным state.json.
 *
 * Запуск: npm run test:sandbox
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPackage } from '../src/server/packages';
import { roleFromPackage, defaultRole } from '../src/server/roles';
import { SANDBOX, sandboxFor } from '../src/server/sandbox';
import { DEFAULT_SETTINGS, openOfficeState, unloadOfficeState } from '../src/server/state';
import { flushAll, load, save, wipe } from '../src/server/store';
import { cleanAllowedHost, cleanWritePath } from '../src/shared/sandbox';

let failed = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(56)} → ${JSON.stringify(got)}`
    + (ok ? '' : ` (ждали ${JSON.stringify(want)})`));
};

const root = mkdtempSync(resolve(tmpdir(), 'office-sandbox-'));
const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
const home = real(homedir());
const env = { ...process.env, HOME: homedir() };
type Box = { filesystem?: { allowWrite?: string[] }; network?: Record<string, unknown>; excludedCommands?: string[] };

const unity = roleFromPackage(loadPackage('@office/unity')!, 'ru', 'unity');
const backend = roleFromPackage(loadPackage('@office/backend')!, 'ru', 'backend');
check('unity: пакет объявляет game.unity', unity.capabilities?.includes('game.unity'), true);
check('роль из пакета: свои пути и хосты пусты', [unity.writePaths, unity.allowedHosts], [[], []]);

// ------------------------------------------------ умолчания game.unity

// Рабочая копия задачи — каталог с пробелом, как ~/Library/Application Support.
const worktree = resolve(root, 'Application Support', 'T-1');
mkdirSync(resolve(worktree, 'Library'), { recursive: true });
const box = sandboxFor(unity, worktree, env) as Box;
const writes = box.filesystem?.allowWrite ?? [];
for (const path of ['Library/Unity', 'Library/Logs/Unity', 'Library/Preferences']) {
  check(`unity: запись в ~/${path}`, writes.includes(join(home, path)), true);
}
check('unity: запись в /private/tmp/.dotnet', writes.includes('/private/tmp/.dotnet'), true);
check('unity: хосты Unity', box.network?.allowedDomains, ['*.unity.com', '*.unity3d.com']);
check('unity: портов не открывает', box.network?.allowLocalBinding, undefined);
const copy = real(worktree);
check('unity: рабочая копия целиком на запись', writes.includes(copy), true);
check('unity: Library, Temp, Logs, UserSettings копии',
  ['Library', 'Temp', 'Logs', 'UserSettings'].map((d) => writes.includes(join(copy, d))), [true, true, true, true]);
check('unity: пути без ~ и без повторов',
  [writes.some((p) => p.startsWith('~')), new Set(writes).size === writes.length], [false, true]);
check('unity: CLI по-прежнему вне песочницы', box.excludedCommands?.includes('unity test:*'), true);
check('unity: остальная песочница прежняя',
  (['enabled', 'failIfUnavailable', 'allowUnsandboxedCommands', 'autoAllowBashIfSandboxed'] as const)
    .map((k) => (box as Record<string, unknown>)[k]),
  [SANDBOX.enabled, SANDBOX.failIfUnavailable, SANDBOX.allowUnsandboxedCommands, SANDBOX.autoAllowBashIfSandboxed]);

// ------------------------------------------------ свои пути и хосты роли

const own = sandboxFor({
  ...backend,
  writePaths: ['~/Library/Caches/Foo', '/opt/data/', '../etc', '/'],
  allowedHosts: ['API.Example.com', '*.npmjs.org', '*', '*.com'],
}, worktree, env) as Box;
check('свои пути: ~ развёрнут, хвостовой / снят, мусор отброшен',
  own.filesystem?.allowWrite, [join(home, 'Library/Caches/Foo'), real('/opt/data')]);
check('свои хосты: нижний регистр, широкие маски отброшены',
  own.network?.allowedDomains, ['api.example.com', '*.npmjs.org']);
check('свои настройки не дают исключений из песочницы', own.excludedCommands, undefined);
const both = sandboxFor({ ...unity, writePaths: ['~/Unity/Cache'], allowedHosts: ['cdn.example.org'] }, worktree, env) as Box;
check('unity + свои: пути поверх умолчаний',
  [both.filesystem?.allowWrite?.includes(join(home, 'Library/Unity')), both.filesystem?.allowWrite?.includes(join(home, 'Unity/Cache'))],
  [true, true]);
check('unity + свои: хосты поверх умолчаний',
  both.network?.allowedDomains, ['*.unity.com', '*.unity3d.com', 'cdn.example.org']);

// ------------------------------------------------ роль без настроек не меняется

check('backend без настроек — прежняя песочница', sandboxFor(backend, worktree, env), SANDBOX);
check('backend с пустыми списками — прежняя песочница',
  sandboxFor({ ...backend, writePaths: [], allowedHosts: [] }, worktree, env), SANDBOX);
const qa = roleFromPackage(loadPackage('@office/qa')!, 'ru', 'qa');
const qaBox = sandboxFor(qa, worktree, env) as Box;
check('qa: только порты и кеш vite, хостов нет',
  [qaBox.network?.allowLocalBinding, qaBox.network?.allowedDomains, qaBox.filesystem?.allowWrite?.length], [true, undefined, 2]);

// ------------------------------------------------ правила проверки

check('путь: абсолютный и от ~', [cleanWritePath('/a/b'), cleanWritePath('~/x')], ['/a/b', '~/x']);
check('путь: относительный, корень, ~, .. — нет',
  ['a/b', '/', '~', '~/', '/a/../b', 7].map(cleanWritePath), [null, null, null, null, null, null]);
check('хост: имя и маска', [cleanAllowedHost('a.b.com'), cleanAllowedHost('*.unity3d.com')], ['a.b.com', '*.unity3d.com']);
check('хост: звёздочка, маска на зону, мусор — нет',
  ['*', '*.com', 'http://x.com', 'a b.com', ''].map(cleanAllowedHost), [null, null, null, null, null]);

// ------------------------------------------------ состояние офиса и API ролей

const stateFile = resolve(root, 'office.json');
const projectDir = resolve(root, 'project');
mkdirSync(projectDir, { recursive: true });
const savedBackend = { ...defaultRole('backend', 'ru')! };
delete (savedBackend as { package?: unknown }).package;
const savedPm = { ...defaultRole('pm', 'ru')! };
delete (savedPm as { package?: unknown }).package;
// Сохранение до T-684: у ролей полей песочницы нет вовсе. Ручная роль с
// мусором в полях — файл правят руками.
const manual = {
  ...savedBackend, id: 'tools', title: 'Инструменты', brief: 'Свой бриф, не пакета.',
  writePaths: ['~/ok', 'relative'], allowedHosts: ['ok.example.com', 42 as unknown as string],
};
delete (savedBackend as { writePaths?: unknown }).writePaths;
delete (savedBackend as { allowedHosts?: unknown }).allowedHosts;
delete (savedPm as { writePaths?: unknown }).writePaths;
delete (savedPm as { allowedHosts?: unknown }).allowedHosts;
save(stateFile, () => ({
  version: 1, projectDir, taskSeq: 0, tasks: [], chat: [], log: [], instances: [],
  settings: { ...DEFAULT_SETTINGS, language: 'ru', chatLanguage: 'ru', codeLanguage: 'ru' },
  savedAt: Date.now(),
  roles: [savedPm, savedBackend, manual, {
    ...unity, package: { name: '@office/unity', version: unity.package!.version, overrides: {}, briefExtra: '' },
  }],
}));
flushAll();
const office = openOfficeState({ id: 'o-sandbox', projectDir, stateFile }).state;
check('миграция: старая роль — пусто', [office.role('backend')?.writePaths, office.role('backend')?.allowedHosts], [[], []]);
check('ручная роль: мусор из файла отброшен',
  [office.role('tools')?.writePaths, office.role('tools')?.allowedHosts], [['~/ok'], ['ok.example.com']]);
const view = office.roleViews().find((r) => r.id === 'unity')!;
check('API: роль отдаёт поля', [view.writePaths, view.allowedHosts], [[], []]);

const bad = await office.editRole('unity', { writePaths: ['relative/path'], allowedHosts: ['*'] });
check('API: непригодное — ошибки по обоим полям', bad.map((e) => e.field), ['writePaths', 'allowedHosts']);
check('API: после отказа роль не изменилась', office.role('unity')?.writePaths, []);
const okEdit = await office.editRole('unity', {
  writePaths: ['~/Unity/Cache', ''], allowedHosts: ['*.example.org'],
});
check('API: правка принята', okEdit, []);
check('API: пустая строка формы не сохраняется', office.role('unity')?.writePaths, ['~/Unity/Cache']);
check('API: у роли из пакета правка — оверрайд',
  office.role('unity')?.package?.overrides, { writePaths: ['~/Unity/Cache'], allowedHosts: ['*.example.org'] });
const live = sandboxFor(office.role('unity')!, worktree, env) as Box;
check('сессия получает свои пути и хосты роли',
  [live.filesystem?.allowWrite?.includes(join(home, 'Unity/Cache')), live.network?.allowedDomains],
  [true, ['*.unity.com', '*.unity3d.com', '*.example.org']]);

save(stateFile, () => office.toPersisted());
flushAll();
check('state.json: оверрайд сохранён',
  load(stateFile)!.roles?.find((r) => r.id === 'unity')?.package?.overrides,
  { writePaths: ['~/Unity/Cache'], allowedHosts: ['*.example.org'] });
unloadOfficeState('o-sandbox');
const again = openOfficeState({ id: 'o-sandbox', projectDir, stateFile }).state;
check('после перезапуска настройки на месте',
  [again.role('unity')?.writePaths, again.role('unity')?.allowedHosts], [['~/Unity/Cache'], ['*.example.org']]);
await again.editRole('unity', { writePaths: [], allowedHosts: [] });
check('очистили — оверрайда нет', again.role('unity')?.package?.overrides, {});
unloadOfficeState('o-sandbox');
wipe(stateFile);
rmSync(root, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} проверок провалено`);
  process.exit(1);
}
console.log('\nВсе проверки прошли');

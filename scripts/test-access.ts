/**
 * Запрос доступа песочницы через вопрос владельцу и sandbox_status (T-685).
 * Согласие владельца дописывает пути и хосты в настройку песочницы роли и
 * пишет событие в ленту, отказ ничего не меняет; вопрос о доступе свободным
 * текстом помечается ручной настройкой; sandbox_status отдаёт итоговые права
 * сессии с источником каждого правила, рабочую копию и путь моста Unity.
 * Токенов не нужно: сессий не запускаем, только логика над состоянием.
 *
 * Запуск: npm run test:access
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPackage } from '../src/server/packages';
import { roleFromPackage, defaultRole } from '../src/server/roles';
import { rememberSandbox, sandboxFor, sandboxRules } from '../src/server/sandbox';
import { rememberUnityProject } from '../src/server/mcp';
import { sandboxGrants } from '../src/server/access';
import { answerQuestion, askOwner } from '../src/server/questions';
import { sandboxStatusFor } from '../src/server/agents';
import { DEFAULT_SETTINGS, openOfficeState, unloadOfficeState } from '../src/server/state';
import { flushAll, save, wipe } from '../src/server/store';

let failed = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(60)} → ${JSON.stringify(got)}`
    + (ok ? '' : ` (ждали ${JSON.stringify(want)})`));
};

const root = mkdtempSync(resolve(tmpdir(), 'office-access-'));
const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
const home = real(homedir());
type Box = { filesystem?: { allowWrite?: string[] }; network?: { allowedDomains?: string[] } };

// ------------------------------------------------ офис с ролью unity из пакета

const unity = roleFromPackage(loadPackage('@office/unity')!, 'ru', 'unity');
const pm = { ...defaultRole('pm', 'ru')! };
delete (pm as { package?: unknown }).package;
const stateFile = resolve(root, 'office.json');
const projectDir = resolve(root, 'project');
const worktree = resolve(root, 'worktrees', 'T-1');
mkdirSync(projectDir, { recursive: true });
mkdirSync(worktree, { recursive: true });
save(stateFile, () => ({
  version: 1, projectDir, taskSeq: 0, tasks: [], chat: [], log: [], instances: [],
  settings: { ...DEFAULT_SETTINGS, language: 'ru', chatLanguage: 'ru', codeLanguage: 'ru' },
  savedAt: Date.now(),
  roles: [pm, { ...unity, package: { name: '@office/unity', version: unity.package!.version, overrides: {}, briefExtra: '' } }],
}));
flushAll();
const office = openOfficeState({ id: 'o-access', projectDir, stateFile }).state;
if (!office.staffOf('unity').length) office.hire('unity');
check('в роли unity есть сотрудник', office.staffOf('unity').length, 1);
const inst = office.staffOf('unity')[0]!.id;
const lastLog = (): string => office.log.at(-1)?.text ?? '';

// ------------------------------------------------ запрос доступа несёт структуру

const asked = askOwner(office, inst, 'T-1', 'Редактор не стартует: Operation not permitted.', 'компилирую без редактора',
  ['да', 'нет'], [], null, {},
  { roleId: 'unity', request: { writePaths: ['~/Library/Caches/com.unity3d', '/opt/unity-cache/'], allowedHosts: ['Packages.Example.com'] } });
const q = asked.question!;
check('запрос: принят', asked.ok, true);
check('запрос: пути и хосты лежат структурно', q.sandboxRequest,
  { writePaths: ['~/Library/Caches/com.unity3d', '/opt/unity-cache'], allowedHosts: ['packages.example.com'], roleId: 'unity' });
check('запрос: кнопки — согласие и отказ', q.options, ['Открыть доступ роли unity', 'Не открывать']);
check('запрос: в тексте — «со следующей сессии»', q.text.includes('со следующей сессии роли unity'), true);
check('запрос: агенту — «со следующей сессии, не с этой»', asked.text.includes('не с этой'), true);

const bad = askOwner(office, inst, 'T-2', 'Нужен доступ', 'жду', [], [], null, {},
  { roleId: 'unity', request: { writePaths: ['relative/dir', '/'], allowedHosts: ['*'] } });
check('мусор в запросе — отказ с перечнем', [bad.ok, bad.question, bad.text.includes('relative/dir')], [false, null, true]);

// ------------------------------------------------ отказ ничего не меняет

const before = [office.role('unity')?.writePaths, office.role('unity')?.allowedHosts];
const denied = askOwner(office, inst, 'T-3', 'Нужна сеть для пакетов', 'без пакетов', [], [], null, {},
  { roleId: 'unity', request: { allowedHosts: ['cdn.example.org'] } }).question!;
check('отказ: ответ принят', answerQuestion(office, denied.id, 'Не открывать'), true);
check('отказ: роль прежняя', [office.role('unity')?.writePaths, office.role('unity')?.allowedHosts], before);
check('отказ: событие в ленте', lastLog().includes('не открыл доступ'), true);
check('отказ: ничего не записано как выданное', office.questions.get(denied.id)?.sandboxGranted, undefined);
const deniedFree = askOwner(office, inst, 'T-4', 'Можно открыть сеть?', 'нет', [], [], null, {},
  { roleId: 'unity', request: { allowedHosts: ['other.example.org'] } }).question!;
answerQuestion(office, deniedFree.id, 'нет, не надо');
check('отказ своими словами: роль прежняя', office.role('unity')?.allowedHosts, before[1]);

// ------------------------------------------------ согласие пишет в роль и в ленту

check('согласие: ответ принят', answerQuestion(office, q.id, 'Открыть доступ роли unity'), true);
check('согласие: пути роли дописаны',
  office.role('unity')?.writePaths, ['~/Library/Caches/com.unity3d', '/opt/unity-cache']);
check('согласие: хосты роли дописаны', office.role('unity')?.allowedHosts, ['packages.example.com']);
check('согласие: у роли из пакета — оверрайд',
  office.role('unity')?.package?.overrides,
  { writePaths: ['~/Library/Caches/com.unity3d', '/opt/unity-cache'], allowedHosts: ['packages.example.com'] });
check('согласие: событие в ленте со «следующей сессии»',
  [lastLog().includes(q.id), lastLog().includes('/opt/unity-cache'), lastLog().includes('со следующей сессии')], [true, true, true]);
check('согласие: выданное записано на вопросе', office.questions.get(q.id)?.sandboxGranted,
  { writePaths: ['~/Library/Caches/com.unity3d', '/opt/unity-cache'], allowedHosts: ['packages.example.com'] });
check('согласие: журнал по-прежнему получает факт',
  office.factList().some((f) => f.source?.questionId === q.id), true);
const box = sandboxFor(office.role('unity')!, worktree) as Box;
check('следующая сессия получает новые пути и хосты',
  [box.filesystem?.allowWrite?.includes(join(home, 'Library/Caches/com.unity3d')), box.network?.allowedDomains?.includes('packages.example.com')],
  [true, true]);

// Повторное согласие на уже открытое не дублирует записи.
const again = askOwner(office, inst, 'T-5', 'Ещё раз', 'то же', [], [], null, {},
  { roleId: 'unity', request: { writePaths: ['/opt/unity-cache', '~/Unity/Extra'] } }).question!;
answerQuestion(office, again.id, 'да');
check('согласие «да»: дописано только новое',
  office.role('unity')?.writePaths, ['~/Library/Caches/com.unity3d', '/opt/unity-cache', '~/Unity/Extra']);
check('выданное — только новое', office.questions.get(again.id)?.sandboxGranted, { writePaths: ['~/Unity/Extra'], allowedHosts: [] });

// ------------------------------------------------ свободный текст — ручная настройка

const free = askOwner(office, inst, 'T-6', 'Песочница не пускает в ~/Library/Unity, открыть доступ?', 'жду',
  [], [], null, {}, { roleId: 'unity' });
check('свободный текст: помечен ручной настройкой', office.questions.get(free.question!.id)?.sandboxManual, true);
check('свободный текст: в карточке — где настроить',
  free.question!.text.includes('Настройки роли → Песочница'), true);
check('свободный текст: агенту — права не изменятся', free.text.includes('НЕ изменит'), true);
const rolePaths = office.role('unity')?.writePaths;
answerQuestion(office, free.question!.id, 'Открыть доступ роли unity');
check('свободный текст: ответ прав не меняет', office.role('unity')?.writePaths, rolePaths);
check('свободный текст: в ответе — ручная настройка',
  office.chat.some((e) => e.text.startsWith(`Ответ на ${free.question!.id}`) && e.text.includes('Настройки роли → Песочница')), true);
const titled = askOwner(office, inst, 'T-7', 'Нет прав на запись в /opt/x', 'жду', [], [], null,
  { title: 'Доступ на запись' }, { roleId: 'unity' }).question!;
check('свободный текст с сутью: пометка и в подробностях', titled.details?.includes('Настройки роли → Песочница'), true);
const plain = askOwner(office, inst, 'T-8', 'Пагинация по 20 или по 50?', 'по 20', [], [], null, {}, { roleId: 'unity' }).question!;
check('обычный вопрос не помечается', [plain.sandboxManual, plain.sandboxRequest], [undefined, undefined]);

// ------------------------------------------------ sandbox_status

// Сессия стартовала до согласия на ~/Unity/Extra — эмулируем её снимок.
const startRole = { ...office.role('unity')!, writePaths: ['~/Library/Caches/com.unity3d', '/opt/unity-cache', '~/Own/Dir'] };
office.updateRole('unity', { writePaths: [...office.role('unity')!.writePaths!, '~/Own/Dir'] });
rememberSandbox(['T-9', inst], sandboxRules(startRole, worktree, process.env, {
  readDirs: [projectDir], grants: sandboxGrants(office, 'unity'),
}));
rememberUnityProject(['T-9', inst], { path: projectDir, reason: 'main', editorOpen: false });
const status = sandboxStatusFor(office, inst, 'T-9');
console.log(`\n${status}\n`);
const line = (needle: string): string => status.split('\n').find((l) => l.includes(needle)) ?? '';
check('status: рабочая копия', status.includes(`Рабочая копия: ${real(worktree)}`), true);
check('status: путь от ответа владельца с Q-N',
  line(join(home, 'Library/Caches/com.unity3d')).includes(`ответ владельца ${q.id}`), true);
check('status: путь из настройки роли', line(join(home, 'Own/Dir')).includes('настройка роли'), true);
check('status: умолчание пакета Unity', line(join(home, 'Library/Unity')).includes('умолчание пакета'), true);
check('status: хост от ответа владельца', line('packages.example.com').includes(`ответ владельца ${q.id}`), true);
check('status: хост Unity — умолчание пакета', line('*.unity3d.com').includes('умолчание пакета'), true);
check('status: чтение — проект', line(real(projectDir)).includes('сессия'), true);
check('status: мост Unity с причиной',
  status.includes(`Мост Unity: проект ${projectDir} — основная папка репозитория роли`), true);
const pendingAt = status.indexOf('со следующей сессии:');
check('status: выданное после старта — в ожидании следующей сессии',
  pendingAt > 0 && status.slice(pendingAt).includes(join(home, 'Unity/Extra')), true);
check('status: подсказка про sandboxRequest', status.includes('sandboxRequest'), true);
// T-691: показанное агенту и применённое — один и тот же набор из трёх
// источников, без потерь и дублей, даже когда настройка роли повторяет
// умолчание пакета.
const mixed = { ...startRole, writePaths: [...startRole.writePaths, '~/Library/Unity'], allowedHosts: ['packages.example.com', '*.unity.com'] };
const shown = sandboxRules(mixed, worktree, process.env, { grants: sandboxGrants(office, 'unity') });
const applied = sandboxFor(mixed, worktree) as Box;
check('status = sandboxFor: пути на запись', shown.write.map((r) => r.value), applied.filesystem?.allowWrite);
check('status = sandboxFor: хосты', shown.hosts.map((r) => r.value), applied.network?.allowedDomains);
check('три источника на месте',
  ['package', 'role', 'owner'].map((s) => shown.write.some((r) => r.source === s)), [true, true, true]);
check('повтор умолчания пакета не задваивается',
  [shown.write.filter((r) => r.value === join(home, 'Library/Unity')).length,
    shown.hosts.filter((r) => r.value === '*.unity.com').length], [1, 1]);
const fresh = sandboxStatusFor(office, 'нет-такого', 'T-404');
check('status: без сотрудника — понятный отказ', fresh.length > 0, true);

unloadOfficeState('o-access');
wipe(stateFile);
rmSync(root, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} проверок провалено`);
  process.exit(1);
}
console.log('\nВсе проверки прошли');
process.exit(0);

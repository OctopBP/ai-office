/**
 * Чтение файлов менеджером (T-694): набор инструментов сессии менеджера и
 * границы чтения. Менеджер получает Read, Glob и Grep и не получает Write,
 * Edit и Bash; внутри корня офиса, зон и рабочих копий задач чтение идёт без
 * вопроса; секреты (.env*, ключи, ~/.ssh, ~/.aws, файлы токенов) — отказ с
 * причиной; путь снаружи — вопрос владельцу; большой файл целиком — отказ с
 * подсказкой читать диапазоном. Сессий не запускаем: только логика.
 *
 * T-696: выдача Grep по папке без строк файлов-секретов (хук PostToolUse),
 * Grep прямо по секрету — отказ; путь снаружи хук сам доводит до вопроса
 * владельцу через `permissionHandler`, не полагаясь на «ask» SDK.
 *
 * Запуск: npm run test:pm-read
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPmRead, pmReadScope, secretWhy, PM_READ_MAX_LINES, type PmReadScope } from '../src/server/pm-read';
import { classifyPmRead } from '../src/server/permissions';
import { spawnSync } from 'node:child_process';
import { filterPmGrepOutput } from '../src/server/pm-read';
import { permissionHandler, pmGrepFilterHook, pmReadHook, pmSessionTools, type PmAskOwner } from '../src/server/agents';
import type { Subproject } from '../src/shared/types';

let failed = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what.padEnd(60)} → ${JSON.stringify(got)}`
    + (ok ? '' : ` (ждали ${JSON.stringify(want)})`));
};

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pm-read-')));
const office = join(tmp, 'office');
const zoneRepo = join(tmp, 'zone-repo');
const worktree = join(tmp, 'worktrees', 'T-1');
const outside = join(tmp, 'elsewhere');
const home = join(tmp, 'home');
for (const d of [office, join(office, 'src'), zoneRepo, worktree, outside, join(home, '.ssh'), join(home, '.aws')]) {
  mkdirSync(d, { recursive: true });
}
writeFileSync(join(office, 'src', 'small.ts'), 'export const a = 1;\n');
writeFileSync(join(office, 'src', 'secrets.ts'), '// код про секреты, а не секреты\n');
writeFileSync(join(office, 'src', 'big.ts'), Array.from({ length: PM_READ_MAX_LINES + 50 }, (_, i) => `// ${i}`).join('\n'));
writeFileSync(join(office, '.env'), 'TOKEN=xxx\n');
writeFileSync(join(office, '.env.local'), 'TOKEN=xxx\n');
writeFileSync(join(office, 'server.pem'), 'key\n');
writeFileSync(join(office, 'tokens.json'), '{}\n');
writeFileSync(join(zoneRepo, 'main.py'), 'print(1)\n');
writeFileSync(join(worktree, 'notes.md'), 'x\n');
writeFileSync(join(outside, 'swa_seat_feed.py'), 'print(2)\n');
writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key\n');
writeFileSync(join(home, '.aws', 'config'), '[default]\n');
// Симлинк из офиса на ~/.ssh: путь внутри, а читается ключ.
symlinkSync(join(home, '.ssh', 'id_ed25519'), join(office, 'innocent.txt'));

const zone: Subproject = {
  id: 'api', name: 'API', kind: 'repo', root: zoneRepo, summary: '', color: 'accent-1',
} as Subproject;
const fakeOffice = {
  projectDir: office,
  subprojects: () => [zone],
  tasks: new Map([['T-1', { worktreePath: worktree, repoDir: office }]]),
};
const scope: PmReadScope = { ...pmReadScope(fakeOffice), home };
const kind = (tool: string, input: Record<string, unknown>): string => checkPmRead(tool, input, scope).kind;

console.log('Набор инструментов сессии менеджера');
const tools = pmSessionTools();
check('есть Read, Glob, Grep', ['Read', 'Glob', 'Grep'].every((t) => tools.includes(t)), true);
check('нет Write, Edit, MultiEdit, NotebookEdit, Bash',
  ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'].some((t) => tools.includes(t)), false);
// startPm берёт набор именно отсюда: проверяем по исходнику, чтобы набор
// и сессия не разошлись молча.
const src = readFileSync(join(process.cwd(), 'src', 'server', 'agents.ts'), 'utf8');
const startPm = src.slice(src.indexOf('function startPm('), src.indexOf('function startPm(') + 4000);
check('startPm передаёт tools: pmSessionTools()', /tools: pmSessionTools\(\),/.test(startPm), true);
check('startPm ставит хук PreToolUse на чтение', /PreToolUse: \[\{ matcher: PM_READ_TOOLS/.test(startPm), true);
check('хук PreToolUse спрашивает через permissionHandler',
  /pmReadHook\(state, permissionHandler\(state, 'pm#1'\)\)/.test(startPm), true);
check('startPm ставит хук PostToolUse на Grep',
  /PostToolUse: \[\{ matcher: 'Grep', hooks: \[pmGrepFilterHook\(state\)\] \}\]/.test(startPm), true);

console.log('Внутри офиса, зон и рабочих копий — без вопроса');
check('Read src/small.ts (относительный)', kind('Read', { file_path: 'src/small.ts' }), 'inside');
check('Read абсолютный путь в офисе', kind('Read', { file_path: join(office, 'src', 'small.ts') }), 'inside');
check('Read secrets.ts — код, не секрет', kind('Read', { file_path: join(office, 'src', 'secrets.ts') }), 'inside');
check('Read в repo-зоне', kind('Read', { file_path: join(zoneRepo, 'main.py') }), 'inside');
check('Read в рабочей копии задачи', kind('Read', { file_path: join(worktree, 'notes.md') }), 'inside');
check('Glob без path', kind('Glob', { pattern: '**/*.ts' }), 'inside');
check('Grep по зоне', kind('Grep', { pattern: 'print', path: zoneRepo }), 'inside');
check('Grep content без head_limit — потолок',
  checkPmRead('Grep', { pattern: 'a', output_mode: 'content' }, scope), { kind: 'inside', path: office, grepHeadLimit: 200 });
check('verdict внутри — safe', classifyPmRead('Read', { file_path: 'src/small.ts' }, scope, 'ru').risk, 'safe');

console.log('Секреты — отказ с причиной');
check('.env', kind('Read', { file_path: join(office, '.env') }), 'secret');
check('.env.local', kind('Read', { file_path: '.env.local' }), 'secret');
check('ключ .pem', kind('Read', { file_path: 'server.pem' }), 'secret');
check('tokens.json', kind('Read', { file_path: 'tokens.json' }), 'secret');
check('~/.ssh/id_ed25519', kind('Read', { file_path: '~/.ssh/id_ed25519' }), 'secret');
check('~/.aws/config', kind('Read', { file_path: join(home, '.aws', 'config') }), 'secret');
check('Glob по ~/.ssh', kind('Glob', { pattern: '*', path: '~/.ssh' }), 'secret');
check('Grep с glob .env*', kind('Grep', { pattern: 'TOKEN', glob: '.env*' }), 'secret');
check('симлинк из офиса на ключ', kind('Read', { file_path: join(office, 'innocent.txt') }), 'secret');
check('secretWhy: id_rsa', secretWhy('/x/id_rsa', home), 'key');
check('secretWhy: .netrc', secretWhy('/x/.netrc', home), 'token');
check('secretWhy: tokens.css — нет', secretWhy('/x/tokens.css', home), null);
const env = classifyPmRead('Read', { file_path: join(office, '.env') }, scope, 'ru');
check('verdict .env — deny', env.deny, true);
check('причина называет файл окружения', env.reason.includes('файл окружения'), true);

console.log('Снаружи — вопрос владельцу');
const ext = join(outside, 'swa_seat_feed.py');
check('Read внешнего файла', kind('Read', { file_path: ext }), 'outside');
check('Glob с абсолютным шаблоном снаружи', kind('Glob', { pattern: `${outside}/**/*.py` }), 'outside');
check('../ из офиса', kind('Read', { file_path: '../elsewhere/swa_seat_feed.py' }), 'outside');
const outVerdict = classifyPmRead('Read', { file_path: ext }, scope, 'ru');
check('verdict снаружи — danger без запрета', [outVerdict.risk, outVerdict.deny ?? false], ['danger', false]);
check('ключ «всегда» — этот путь', outVerdict.key, `Read:${ext}`);

console.log('Размер: большой файл — только диапазоном');
check('большой файл целиком', kind('Read', { file_path: 'src/big.ts' }), 'tooBig');
check('большой файл диапазоном', kind('Read', { file_path: 'src/big.ts', offset: 1, limit: 100 }), 'inside');
check('limit выше предела', kind('Read', { file_path: 'src/big.ts', limit: 5000 }), 'limitTooBig');
const big = classifyPmRead('Read', { file_path: 'src/big.ts' }, scope, 'ru');
check('отказ подсказывает offset и limit', big.deny === true && big.reason.includes('offset'), true);

console.log('Хук PreToolUse (путь Claude)');
const logs: string[] = [];
const hookOffice = {
  ...fakeOffice,
  lang: () => 'ru',
  addLog: (_who: string, _kind: string, text: string) => { logs.push(text); },
} as unknown as Parameters<typeof pmReadHook>[0];
const asked: string[] = [];
let askAnswer: Awaited<ReturnType<PmAskOwner>> = { behavior: 'allow', updatedInput: {} };
const fakeAsk: PmAskOwner = async (tool, input) => {
  asked.push(`${tool}:${String(input.file_path ?? input.path ?? '')}`);
  return askAnswer;
};
const hook = pmReadHook(hookOffice, fakeAsk);
// Хук берёт домашнюю папку системы, поэтому секрет здесь — .env в офисе.
type HookOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: unknown } };
const run = async (h: typeof hook, tool: string, input: Record<string, unknown>): Promise<HookOut> =>
  await h({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }) as HookOut;
const decision = async (tool: string, input: Record<string, unknown>): Promise<string> =>
  (await run(hook, tool, input)).hookSpecificOutput?.permissionDecision ?? 'none';
check('внутри — без решения (SDK пропустит)', await decision('Read', { file_path: join(office, 'src', 'small.ts') }), 'none');
check('.env — deny', await decision('Read', { file_path: join(office, '.env') }), 'deny');
check('отказ записан в ленту', logs.length, 1);
check('внутри владельца не спрашивали', asked.length, 0);
askAnswer = { behavior: 'allow', updatedInput: { file_path: ext } };
check('снаружи, владелец разрешил — allow', await decision('Read', { file_path: ext }), 'allow');
check('снаружи — вопрос ушёл владельцу из хука', asked, [`Read:${ext}`]);
askAnswer = { behavior: 'deny', message: 'нельзя' };
const deniedOut = await run(hook, 'Read', { file_path: ext });
check('снаружи, владелец запретил — deny с причиной',
  [deniedOut.hookSpecificOutput?.permissionDecision, deniedOut.hookSpecificOutput?.permissionDecisionReason], ['deny', 'нельзя']);
check('Grep content — allow с потолком', await decision('Grep', { pattern: 'a', output_mode: 'content' }), 'allow');
check('чужой инструмент — не трогаем', await decision('Bash', { command: 'ls' }), 'none');

console.log('Grep прямо по файлу-секрету — отказ с причиной');
for (const mode of ['content', 'files_with_matches', 'count']) {
  const out = await run(hook, 'Grep', { pattern: 'TOKEN', path: join(office, '.env'), output_mode: mode });
  check(`Grep ${mode} по .env — deny`, out.hookSpecificOutput?.permissionDecision, 'deny');
  check(`  причина называет файл окружения`, String(out.hookSpecificOutput?.permissionDecisionReason).includes('файл окружения'), true);
}
check('Grep по server.pem относительным путём — secret', kind('Grep', { pattern: 'k', path: 'server.pem' }), 'secret');
check('Grep по симлинку на ключ — secret', kind('Grep', { pattern: 'k', path: join(office, 'innocent.txt') }), 'secret');

console.log('Снаружи — до модалки владельца (permissionHandler, без SDK)');
// Тот же обработчик, что canUseTool менеджера, на поддельном офисе: вопрос
// должен дойти до requestPermission — это и есть модалка владельца.
const permRequests: { toolName: string; detail: string; risk: string }[] = [];
let ownerSays: 'allow' | 'deny' | 'always' | 'never' = 'allow';
const permOffice = {
  ...fakeOffice,
  instances: new Map([['pm#1', { id: 'pm#1', roleId: 'pm', state: 'working', note: null, permissionMode: null }]]),
  role: (id: string) => (id === 'pm' ? { id: 'pm', isManager: true, permissionMode: null } : undefined),
  officeMode: () => 'auto',
  paused: false,
  settings: {},
  lang: () => 'ru',
  say: (key: string) => key,
  setState: () => {},
  addLog: (_who: string, _kind: string, text: string) => { logs.push(text); },
  isAlwaysDenied: () => false,
  isAlwaysAllowed: () => false,
  requestPermission: async (req: { toolName: string; detail: string; risk: string }) => {
    permRequests.push({ toolName: req.toolName, detail: req.detail, risk: req.risk });
    return ownerSays;
  },
} as unknown as Parameters<typeof permissionHandler>[0];
const realHook = pmReadHook(permOffice as unknown as Parameters<typeof pmReadHook>[0], permissionHandler(permOffice, 'pm#1'));
const allowed = await run(realHook, 'Read', { file_path: ext });
check('владелец спрошен (режим auto не обходит)', permRequests, [{ toolName: 'Read', detail: ext, risk: 'danger' }]);
check('«Разрешить» владельца — allow', allowed.hookSpecificOutput?.permissionDecision, 'allow');
ownerSays = 'deny';
const refused = await run(realHook, 'Glob', { pattern: `${outside}/**/*.py` });
check('«Запретить» владельца — deny', refused.hookSpecificOutput?.permissionDecision, 'deny');
check('второй вопрос тоже дошёл', permRequests.length, 2);
permRequests.length = 0;
await run(realHook, 'Read', { file_path: join(office, 'src', 'small.ts') });
await run(realHook, 'Read', { file_path: join(office, '.env') });
check('внутри и секрет — владельца не спрашивают', permRequests.length, 0);

console.log('Выдача Grep — без файлов-секретов (PostToolUse)');
writeFileSync(join(office, 'src', 'config.ts'), 'export const TOKEN = process.env.TOKEN;\n');
writeFileSync(join(office, 'src', 'a-1-b.ts'), 'const TOKEN = 1;\n');
mkdirSync(join(office, 'deploy', '.ssh'), { recursive: true });
writeFileSync(join(office, 'deploy', '.ssh', 'notes'), 'TOKEN in ssh\n');
writeFileSync(join(office, '.env.production'), 'TOKEN=prod-secret\n');
const postHook = pmGrepFilterHook(hookOffice);
type PostOut = { hookSpecificOutput?: { updatedToolOutput?: { content?: string; filenames?: string[]; numFiles?: number; numLines?: number } | string; additionalContext?: string } };
const post = async (response: unknown, input: Record<string, unknown> = { pattern: 'TOKEN' }): Promise<PostOut> =>
  await postHook({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: input, tool_response: response }) as PostOut;

const content = [
  '.env:1:TOKEN=xxx',
  '.env.local:1:TOKEN=xxx',
  'src/config.ts:1:export const TOKEN = process.env.TOKEN;',
  'src/a-1-b.ts:1:const TOKEN = 1;',
  'deploy/.ssh/notes:1:TOKEN in ssh',
  `${join(office, '.env.production')}:1:TOKEN=prod-secret`,
  '--',
].join('\n');
const cut = await post({ mode: 'content', numFiles: 0, filenames: [], content, numLines: 7 });
const cutOut = cut.hookSpecificOutput?.updatedToolOutput as { content: string; numLines: number };
check('строки .env* и .ssh вырезаны', cutOut.content.split('\n'),
  ['src/config.ts:1:export const TOKEN = process.env.TOKEN;', 'src/a-1-b.ts:1:const TOKEN = 1;', '--']);
check('numLines пересчитан', cutOut.numLines, 3);
check('в выдаче нет значений секретов', /xxx|prod-secret|in ssh/.test(cutOut.content), false);
check('менеджеру сказано, что вырезано', String(cut.hookSpecificOutput?.additionalContext).includes('.env'), true);
const files = await post(
  { mode: 'files_with_matches', numFiles: 4, filenames: [join(office, '.env'), join(office, 'src', 'config.ts'), 'server.pem', join(office, 'innocent.txt')] },
  { pattern: 'TOKEN', output_mode: 'files_with_matches' },
);
const filesOut = files.hookSpecificOutput?.updatedToolOutput as { filenames: string[]; numFiles: number };
check('files_with_matches: остался только код', [filesOut.filenames, filesOut.numFiles], [[join(office, 'src', 'config.ts')], 1]);
const counts = await post({ mode: 'count', numFiles: 2, filenames: [], content: '.env:1\nsrc/config.ts:2' }, { pattern: 'TOKEN', output_mode: 'count' });
check('count: строка .env вырезана',
  (counts.hookSpecificOutput?.updatedToolOutput as { content: string }).content, 'src/config.ts:2');
check('строкой — тоже фильтруется',
  (await post('.env:1:TOKEN=xxx\nsrc/config.ts:1:x')).hookSpecificOutput?.updatedToolOutput, 'src/config.ts:1:x');
check('чистая выдача — не трогаем',
  await post({ mode: 'content', numFiles: 1, filenames: [], content: 'src/config.ts:1:x' }), {});
check('не Grep — не трогаем',
  await postHook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: '.env:1:x' }), {});
check('filterPmGrepOutput: path от папки поиска',
  filterPmGrepOutput('notes:1:TOKEN in ssh', { path: 'deploy/.ssh' }, scope)?.output, '');

// Настоящий ripgrep с --hidden (так ищет Grep), если он есть на машине:
// выдача по папке офиса с незаигноренным .env после фильтра без его строк.
const rg = spawnSync('rg', ['--hidden', '-n', '--no-heading', 'TOKEN', '.'], { cwd: office, encoding: 'utf8' });
if (rg.status === 0 || rg.status === 1) {
  const raw = rg.stdout.split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, '')).join('\n');
  check('rg --hidden сам находит .env', /TOKEN=xxx/.test(raw), true);
  const real = filterPmGrepOutput({ mode: 'content', numFiles: 0, filenames: [], content: raw }, { pattern: 'TOKEN' }, scope);
  const realContent = String((real?.output as { content?: string } | undefined)?.content);
  check('после фильтра строк .env нет', /TOKEN=|in ssh/.test(realContent), false);
  check('код остался', realContent.includes('src/config.ts'), true);
} else {
  console.log('  —     ripgrep не найден, живой прогон пропущен');
}

rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} провал(ов)`);
  process.exit(1);
}
console.log('\nВсё прошло');

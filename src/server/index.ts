import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'node:http';
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { ClientCommand, FieldError, RoleOp, ServerEvent } from '../shared/types';
import { OFFICE_SENDER } from '../shared/types';
import { c, setProcessLang } from './i18n';
import { officeViews, openedOffices, openOfficeState, subscribeOffices, type OfficeState } from './state';
import {
  broadcast, broadcastSnapshot, greet, handleOfficeCommand, initOfficeApi, send,
  stateFor, unwatch, watch, watching,
} from './office-api';
import { assignDirect, holdMeeting, resetSessions, retryTask, sendUserMessage, setPaused, stopTask, taskDiff, talkTo } from './agents';
import { approveEpic, cancelEpic, reorderEpics } from './plan';
import { mergeQueue, refreshMergeChecks } from './merge';
import { retryPipeline } from './review';
import { resetProjectWorkflow, saveProjectWorkflow } from './workflows';
import { startSupervisor } from './supervisor';
import { answerQuestion, dismissQuestion } from './questions';
import { archiveFact, confirmFact } from './journal';
import { runRitual } from './rituals';
import { decideProposal } from './initiatives';
import { applyProposal } from './selfchange';
import { RITUAL_IDS } from '../shared/types';
import { githubToken, setGithubToken } from './cloud';
import { clearInitFlag, currentOffice, ensureOffice, loadRegistry, setCurrent, type OfficeEntry } from './offices';
import { hasCommits, initRepo, isRepo, repoProblem } from './git';
import { isPermissionMode } from './permissions';
import { handleMarketCommand } from './market';
import { exportRole } from './export';
import { flushAll } from './store';

const PORT = Number(process.env.OFFICE_PORT ?? 3001);
const DEFAULT_DIR = resolve(process.env.OFFICE_PROJECT_DIR ?? './workspace');

/** Режим проверки PM — свойство запуска, а не офиса: он же и у следующего. */
const DRY_RUN = process.env.OFFICE_DRY_RUN === '1';
if (DRY_RUN) console.log(c('boot.dryRun'));

// Источник доступа важен: с ключом расход идёт в платный API, без него —
// в лимиты подписки Claude Code. Ключ имеет приоритет и подменяет подписку молча.
// Это тоже свойство запуска: его получает каждый открываемый офис.
const USING_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const AUTH_SOURCE = USING_KEY ? 'api-key' : 'subscription';

/**
 * Изоляция задач через git worktree работает только в репозитории.
 * Директорию, которую создали мы сами, инициализируем; чужую — не трогаем,
 * только сообщаем, что изоляция выключена.
 */
async function setupGit(state: OfficeState, dir: string, ours: boolean): Promise<void> {
  if (ours && !(await isRepo(dir))) {
    const ok = await initRepo(dir, state.lang());
    console.log(state.say(ok ? 'boot.gitInit' : 'boot.gitInitFailed'));
  }
  state.gitReady = (await isRepo(dir)) && (await hasCommits(dir));
  console.log(state.gitReady
    ? state.say('boot.isolationOn')
    : state.say('boot.isolationOff', { dir }));
}

/**
 * Роли могут работать в своих репозиториях. Проверяем их на старте: узнать,
 * что путь неверный, из проваленной задачи — слишком поздно.
 */
async function reportRoleRepos(state: OfficeState): Promise<void> {
  // Архивные роли пропускаем: работать в них некому, и ходить в git ради
  // строчки про репозиторий уволенной роли незачем.
  for (const role of state.activeRoles()) {
    const dir = state.repoFor(role);
    if (dir === state.projectDir) continue;
    // Та же проверка, что не даёт сохранить роль с негодным путём, — иначе
    // старт и форма роли расходились бы в том, какой путь считать рабочим.
    const problem = await repoProblem(dir, state.lang());
    console.log(problem === null
      ? `   ${role.emoji} ${role.title} → ${dir}`
      : state.say('boot.roleRepoProblem', { role: role.title, problem }));
  }
}

/**
 * Открыть офис: своё состояние, своя рабочая директория, свой git, свой надзор.
 * Открытых офисов может быть несколько сразу, и каждый работает сам по себе:
 * уже поднятый второй раз не поднимается — иначе он получил бы второго
 * надзирателя и лишний поход в git на каждое возвращение человека.
 */
async function openOffice(entry: OfficeEntry): Promise<void> {
  // Свою директорию офис заводит сам, чужую не трогает: от этого зависит,
  // можно ли делать в ней git init.
  const ours = entry.initGit || !existsSync(entry.projectDir);
  if (!existsSync(entry.projectDir)) {
    mkdirSync(entry.projectDir, { recursive: true });
  }
  if (ours && !existsSync(resolve(entry.projectDir, 'README.md'))) {
    writeFileSync(
      resolve(entry.projectDir, 'README.md'),
      c('boot.readme'),
    );
  }

  // Состояние берётся из реестра: у каждого офиса оно своё и живёт до конца
  // процесса — вернувшийся офис продолжается, а не читается заново.
  const { state, restored, reused } = openOfficeState(entry);
  // Язык процесса берёт открытый офис: терминал у процесса один, и говорить
  // он должен на языке того офиса, с которым сейчас работают.
  setProcessLang(state.lang());
  const board = state.say('boot.board', {
    tasks: state.tasks.size, messages: state.chat.length,
  });
  if (reused) {
    console.log(state.say('boot.reused', { name: entry.name, board }));
    return;
  }
  if (restored) console.log(state.say('boot.restored', { name: entry.name, board }));
  state.dryRun = DRY_RUN;
  state.authSource = AUTH_SOURCE;
  state.setCloud({ hasKey: USING_KEY, hasToken: Boolean(githubToken()) });
  await setupGit(state, entry.projectDir, ours);
  await reportRoleRepos(state);
  clearInitFlag(entry.id);
  // Офис сам следит, что сданная работа доезжает до основной ветки: ветки,
  // оставшиеся с прошлого запуска, поедут без единого нажатия.
  startSupervisor(state);
}

loadRegistry(DEFAULT_DIR);
// Переменная окружения по-прежнему решает, с каким проектом открыться:
// на неё опираются тесты и запуск «в другой папке» одной командой.
if (process.env.OFFICE_PROJECT_DIR) {
  const wanted = ensureOffice({
    name: DEFAULT_DIR.split('/').pop() ?? c('offices.defaultName'), projectDir: DEFAULT_DIR,
  });
  setCurrent(wanted.id);
}
const opened = currentOffice();
if (!opened) throw new Error(c('boot.noOffice'));

/**
 * Причина, по которой стартовый офис не открылся, — или null, если открылся.
 * Провал открытия не роняет процесс: сервер и веб продолжают работать, и
 * человеку надо объяснить, что случилось, а не оставлять его перед пустым
 * экраном. Держим и переменной, и значением обещания: обещание нужно тем,
 * кто подключается, пока офис ещё открывается, а переменная — командам,
 * которые придут уже после.
 */
let startupError: string | null = null;
const startup: Promise<string | null> = openOffice(opened).then(() => null, (err: unknown) => {
  startupError = c('boot.openFailed', {
    name: opened.name, error: (err as Error).message, dir: opened.projectDir,
  });
  console.log(`⚠️  ${startupError}`);
  return startupError;
});

// Досохранить перед выходом, чтобы не потерять последние события.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { flushAll(); process.exit(0); });
}
process.on('exit', () => flushAll());

/**
 * Собранный веб (`npm run build`) раздаётся тем же сервером, что держит
 * WebSocket: один процесс, один порт, никакого vite рядом. Так офис можно
 * запустить как приложение и спокойно работать над его же исходниками —
 * запущенный процесс держит код в памяти и от правок в репозитории не зависит.
 */
const DIST = resolve(process.cwd(), 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

const httpServer = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  // Список офисов доступен и по HTTP: меню открывается раньше, чем офис,
  // и ему хватает реестра — поднимать ради списка WebSocket не обязательно.
  // Меняют офисы только командами по сокету: создание и переключение
  // трогают живое состояние процесса, и делать это запросом без сессии
  // (а значит, без адресата для ответа и ошибки) было бы хуже.
  if (url === '/api/offices') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET' });
      res.end(JSON.stringify({ error: c('boot.officesGetOnly') }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ offices: officeViews() }));
    return;
  }
  if (url.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: c('boot.noRoute', { url }) }));
    return;
  }

  // Путь считаем от dist и проверяем, что не выбрались наружу: запрос
  // приходит из сети, и «../» в нём — обычное дело.
  const wanted = resolve(DIST, `.${decodeURIComponent(url)}`);
  const inside = wanted === DIST || wanted.startsWith(`${DIST}/`);
  let file = inside ? wanted : DIST;
  try {
    if (statSync(file).isDirectory()) file = resolve(file, 'index.html');
  } catch {
    file = resolve(DIST, 'index.html');   // маршрутов нет, но SPA есть SPA
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(existsSync(DIST) ? 404 : 503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(c(existsSync(DIST) ? 'boot.notFound' : 'boot.webNotBuilt'));
  }
});

/**
 * Ответить на операцию с ролью тому клиенту, который её просил. Отказ уходит
 * разложенным по полям формы, успех — отдельным событием: список ролей видят
 * все, кто смотрит офис, а «форму можно закрывать» касается только просившего.
 */
function replyRole(ws: WebSocket, op: RoleOp, roleId: string, errors: FieldError[]): void {
  if (errors.length) send(ws, { t: 'role.error', op, roleId, errors });
  else send(ws, { t: 'role.saved', op, roleId });
}

const wss = new WebSocketServer({ server: httpServer });

// Кто какой офис смотрит, рассылка и команды офисов — в office-api.ts:
// index.ts остаётся про транспорт, а не про правила выбора офиса.
initOfficeApi({ openOffice });

// Подписка на реестр, а не на один OfficeState: покинутый офис продолжает
// работать и слать события, поэтому подписчик один на все офисы, а разбирает
// их по адресатам метка officeId.
subscribeOffices((event: ServerEvent, officeId: string) => broadcast(event, officeId));

wss.on('connection', (ws) => {
  watch(ws);
  // Пока офис открывается, снапшота ещё нет: первый уходит после старта.
  // А если он не открылся — вместо снапшота уходит причина: молчание клиент
  // разобрать не может и остаётся в загрузке.
  void greet(ws, startup);

  ws.on('message', (raw) => {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Офисы разбираются отдельно: список, создание, переключение и скрытие
    // живут в своём модуле вместе с правилами рассылки.
    if (handleOfficeCommand(cmd, ws)) return;

    // Всё остальное — про один конкретный офис, и это офис ЭТОГО клиента.
    // Клиентов несколько, смотрят они разные проекты: брать «открытый на
    // процесс» значило бы останавливать задачи и писать менеджеру в чужой офис.
    const state = stateFor(ws);
    if (!state) {
      const officeId = watching(ws);
      // Стартовый офис мог и вовсе не открыться: тогда «повторите через
      // секунду» — неправда, ждать нечего, и человеку нужна настоящая причина.
      send(ws, {
        t: 'office.error', op: 'open', officeId,
        message: startupError ?? c('boot.officeOpening'),
      });
      return;
    }

    if (cmd.c === 'user_message' && cmd.text.trim()) {
      sendUserMessage(state, cmd.text.trim());
    } else if (cmd.c === 'permission') {
      state.resolvePermission(cmd.id, cmd.decision);
    } else if (cmd.c === 'merge_task') {
      // Слияние одной задачи — та же очередь длиной в один шаг: и проверка
      // сборки после, и пересчёт статусов работают одинаково.
      void mergeQueue([cmd.taskId], state);
    } else if (cmd.c === 'merge_check') {
      void refreshMergeChecks(state);
    } else if (cmd.c === 'merge_queue') {
      void mergeQueue(cmd.taskIds, state);
    } else if (cmd.c === 'workflow_save') {
      // Свой процесс проекта: текст разбирается до записи, отказ — готовым
      // текстом в чат, как у настроек. Сохранённый файл офис видит сразу.
      const problem = saveProjectWorkflow(state, cmd.id, cmd.text);
      if (problem) state.addChat(OFFICE_SENDER, state.say('wf.saveFailed', { problem }));
      else state.addChat(OFFICE_SENDER, state.say('wf.saved', { id: cmd.id }));
      state.emitWorkflows();
    } else if (cmd.c === 'workflow_reset') {
      const problem = resetProjectWorkflow(state, cmd.id);
      if (problem) state.addChat(OFFICE_SENDER, state.say('wf.saveFailed', { problem }));
      else state.addChat(OFFICE_SENDER, state.say('wf.reset', { id: cmd.id }));
      state.emitWorkflows();
    } else if (cmd.c === 'pr_retry') {
      // Вставший конвейер толкают кнопкой: чинить руками в терминале —
      // ровно то, от чего офис и должен избавлять.
      retryPipeline(state, cmd.taskId);
    } else if (cmd.c === 'spawn' || cmd.c === 'hire') {
      // Наём в роль: сотрудник в ней один, и это закрытие вакансии.
      const problem = state.hire(cmd.roleId);
      if (problem) state.addChat(OFFICE_SENDER, problem);
    } else if (cmd.c === 'hire_copy') {
      // «Ещё одного такого же»: отдельный сотрудник с теми же настройками —
      // офис заводит ему свою роль из того же пакета.
      const problem = state.hireCopy(cmd.roleId);
      if (problem) state.addChat(OFFICE_SENDER, problem);
    } else if (cmd.c === 'fire') {
      const problem = state.fire(cmd.instanceId);
      if (problem) state.addChat(OFFICE_SENDER, problem);
    } else if (cmd.c === 'update_role') {
      // Проверка репозитория ходит в git и потому длится: отвечаем событием,
      // когда она закончится, а не задерживаем разбор остальных команд.
      void state.editRole(cmd.roleId, cmd.patch)
        .then((errors) => replyRole(ws, 'update', cmd.roleId, errors));
    } else if (cmd.c === 'create_role') {
      void state.createRole(cmd.role).then((made) => {
        if ('errors' in made) send(ws, { t: 'role.error', op: 'create', roleId: null, errors: made.errors });
        else send(ws, { t: 'role.saved', op: 'create', roleId: made.role.id });
      });
    } else if (cmd.c === 'archive_role') {
      const op = cmd.archived ? 'archive' : 'restore';
      replyRole(ws, op, cmd.roleId, state.archiveRole(cmd.roleId, cmd.archived));
    } else if (cmd.c === 'remove_role') {
      replyRole(ws, 'remove', cmd.roleId, state.removeRole(cmd.roleId));
    } else if (cmd.c === 'detach_role') {
      replyRole(ws, 'detach', cmd.roleId, state.detachRole(cmd.roleId));
    } else if (cmd.c === 'export_role') {
      const role = state.role(cmd.roleId);
      const made = role
        ? exportRole(role, cmd.name, cmd.dir, state.projectDir, state.lang())
        : { ok: false as const, error: state.say('state.role.missing', { role: cmd.roleId }) };
      if (made.ok) {
        state.addLog(null, 'system', state.say('export.done', {
          title: role!.title, id: cmd.roleId, name: cmd.name.trim(), dir: made.dir,
        }));
      }
      send(ws, {
        t: 'role.exported', roleId: cmd.roleId,
        dir: made.ok ? made.dir : '',
        warnings: made.ok ? made.problems.map((p) => `${p.path}: ${p.message}`) : [],
        error: made.ok ? null : made.error,
      });
    } else if (cmd.c.startsWith('market_')) {
      // Маркет ходит в git и в реестр — отвечаем витриной, когда закончим,
      // а не держим разбор остальных команд.
      void handleMarketCommand(cmd as Parameters<typeof handleMarketCommand>[0], state, (e) => send(ws, e));
    } else if (cmd.c === 'agent_permission') {
      // null — снять личное правило и вернуть сотрудника к режиму роли;
      // мусорное значение молча игнорируем, а не выдаём за режим.
      if (cmd.mode === null || isPermissionMode(cmd.mode)) {
        state.setAgentPermissionMode(cmd.instanceId, cmd.mode);
      }
    } else if (cmd.c === 'agent_name') {
      // Отказ (занято, длинное) — готовым текстом в чат, как по найму.
      if (typeof cmd.name === 'string') {
        const problem = state.setAgentName(cmd.instanceId, cmd.name);
        if (problem) state.addChat(OFFICE_SENDER, problem);
      }
    } else if (cmd.c === 'settings') {
      // Отказ по настройкам говорим тем же способом, что и по найму: текст
      // готов к показу, придумывать формулировку клиенту не нужно.
      const problem = state.updateSettings(cmd.settings);
      if (problem) state.addChat(OFFICE_SENDER, problem);
    } else if (cmd.c === 'layout_edit') {
      // Расстановку правит человек мышью: отказ («предмета нет», «позиция за
      // стеной») говорим тем же способом, что и по настройкам — готовым текстом.
      const problem = state.editLayout(cmd.edits);
      if (problem) state.addChat(OFFICE_SENDER, problem);
    } else if (cmd.c === 'layout_reset') {
      const problem = state.resetLayout(cmd.key);
      if (problem) state.addChat(OFFICE_SENDER, problem);
    } else if (cmd.c === 'talk' && cmd.text.trim()) {
      talkTo(state, cmd.instanceId, cmd.text.trim());
    } else if (cmd.c === 'stop_task') {
      stopTask(state, cmd.taskId);
    } else if (cmd.c === 'retry_task') {
      void retryTask(state, cmd.taskId);
    } else if (cmd.c === 'task_diff') {
      void taskDiff(state, cmd.taskId);
    } else if (cmd.c === 'assign_direct') {
      assignDirect(state, cmd.taskId, cmd.instanceId);
    } else if (cmd.c === 'epic_approve') {
      // «Поехали» щелчком — то же самое действие, что и словом в чате:
      // отказ («такой фичи нет», «уже согласована») говорим готовым текстом.
      const outcome = approveEpic(state, cmd.epicId);
      if (!outcome.ok) state.addChat(OFFICE_SENDER, outcome.message);
    } else if (cmd.c === 'epic_cancel') {
      const outcome = cancelEpic(state, cmd.epicId, '');
      if (!outcome.ok) state.addChat(OFFICE_SENDER, outcome.message);
    } else if (cmd.c === 'epic_reorder') {
      const outcome = reorderEpics(state, cmd.epicIds);
      if (!outcome.ok) state.addChat(OFFICE_SENDER, outcome.message);
    } else if (cmd.c === 'answer_question') {
      // Ответ владельца — самая надёжная запись журнала: ложится сразу, а
      // менеджер узнаёт системным сообщением.
      if (!answerQuestion(state, cmd.id, cmd.answer)) {
        state.addChat(OFFICE_SENDER, state.say('questions.noSuch', { id: cmd.id }));
      }
    } else if (cmd.c === 'dismiss_question') {
      dismissQuestion(state, cmd.id);
    } else if (cmd.c === 'fact_confirm') {
      confirmFact(state, cmd.id);
    } else if (cmd.c === 'fact_archive') {
      archiveFact(state, cmd.id);
    } else if (cmd.c === 'direction_create') {
      const problem = state.createDirection(cmd.text);
      if (problem) state.addChat(OFFICE_SENDER, problem);
    } else if (cmd.c === 'direction_update') {
      const problem = state.updateDirection(cmd.id, cmd.patch);
      if (problem) state.addChat(OFFICE_SENDER, problem);
    } else if (cmd.c === 'direction_remove') {
      const problem = state.removeDirection(cmd.id);
      if (problem) state.addChat(OFFICE_SENDER, problem);
    } else if (cmd.c === 'proposal_decide') {
      const outcome = decideProposal(state, cmd.id, cmd.accept, applyProposal);
      if (!outcome.ok) state.addChat(OFFICE_SENDER, outcome.message);
    } else if (cmd.c === 'ritual_run') {
      // По кнопке — тот же путь, что по расписанию: порог лимита и замок
      // «один ритуал за раз» действуют и здесь.
      if (RITUAL_IDS.includes(cmd.ritual)) void runRitual(state, cmd.ritual);
    } else if (cmd.c === 'pause') {
      setPaused(state, cmd.paused);
    } else if (cmd.c === 'cloud_token') {
      // Токен один на процесс, поэтому готовность облака меняется сразу во
      // всех поднятых офисах, а не только в том, из которого его ввели.
      setGithubToken(cmd.token);
      for (const open of openedOffices()) open.setCloud({ hasToken: Boolean(githubToken()) });
    } else if (cmd.c === 'meeting' && cmd.topic.trim()) {
      void holdMeeting(state, cmd.topic.trim(), cmd.participants);
    } else if (cmd.c === 'reset') {
      resetSessions(state);
      state.hardReset();
      broadcastSnapshot(state);
    }
  });

  ws.on('close', () => unwatch(ws));
});

httpServer.listen(PORT);

const built = existsSync(resolve(DIST, 'index.html'));
console.log(c(built ? 'boot.listening' : 'boot.listeningNoWeb', { port: PORT }));
console.log(c('boot.workingIn', { dir: opened.projectDir }));
console.log(c(USING_KEY ? 'boot.paidApi' : 'boot.subscription'));

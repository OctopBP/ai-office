import { WebSocketServer, type WebSocket } from 'ws';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { ClientCommand, FieldError, RoleOp, ServerEvent } from '../shared/types';
import { asTaskPriority, OFFICE_SENDER } from '../shared/types';
import { c, setProcessLang } from './i18n';
import {
  getOffice, isOpened, officeViews, openedOffices, openOfficeState, subscribeOffices,
  type OfficeState,
} from './state';
import {
  broadcast, broadcastSnapshot, greet, handleOfficeCommand, initOfficeApi, send,
  stateFor, unwatch, watch, watching,
} from './office-api';
import { assignDirect, holdMeeting, resetSessions, retryTask, sendUserMessage, setPaused, stopTask, taskDiff, talkTo } from './agents';
import { deleteTask, dropTask, editTask } from './tasks';
import { approveEpic, cancelEpic, reorderEpics } from './plan';
import { mergeQueue, refreshMergeChecks } from './merge';
import { retryPipeline } from './review';
import { resetProjectWorkflow, saveProjectWorkflow } from './workflows';
import { startSupervisor } from './supervisor';
import { answerQuestion, dismissQuestion } from './questions';
import { archiveFact, confirmFact, pageFacts } from './journal';
import { addRule, dropRule, editRule, ruleScopes } from './rules';
import { officeHealth, watchHealth } from './health';
import { runRitual } from './rituals';
import { decideProposal } from './initiatives';
import { applyProposal } from './selfchange';
import { RITUAL_IDS } from '../shared/types';
import { githubToken, setGithubToken } from './cloud';
import {
  clearInitFlag, currentOffice, ensureOffice, loadRegistry, officeById, setCurrent,
  type OfficeEntry,
} from './offices';
import { handleOfficeIcon } from './officeicon';
// hasCommits и repoProblem здесь больше не нужны: проверку репозитория и
// выставление gitReady целиком делает envcheck — одно место на все проверки.
import { initRepo, isRepo } from './git';
import { logEnvChecks, refreshEnvChecks } from './envcheck';
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
 * Изоляция задач через git worktree работает только в репозитории. Директорию,
 * которую создали мы сами, инициализируем; чужую — не трогаем. Результат здесь
 * не оценивается: годен ли git, решает проверка окружения — иначе на один
 * вопрос было бы два ответа, и они бы разошлись.
 */
async function setupGit(state: OfficeState, dir: string, ours: boolean): Promise<void> {
  if (ours && !(await isRepo(dir))) {
    const ok = await initRepo(dir, state.lang());
    console.log(state.say(ok ? 'boot.gitInit' : 'boot.gitInitFailed'));
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
  // Директорию может не получиться завести: путь занят файлом, прав нет, диск
  // отключился. Это не повод не открывать офис — человеку нужен работающий
  // экран с объяснением, а объяснит его проверка окружения ниже.
  try {
    if (!existsSync(entry.projectDir)) {
      mkdirSync(entry.projectDir, { recursive: true });
    }
    if (ours && !existsSync(resolve(entry.projectDir, 'README.md'))) {
      writeFileSync(
        resolve(entry.projectDir, 'README.md'),
        c('boot.readme'),
      );
    }
  } catch (err) {
    console.log(c('boot.dirFailed', { dir: entry.projectDir, error: (err as Error).message }));
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
  // Проверки окружения — последним шагом открытия: к этому моменту известны и
  // режим движка, и git, и состав офиса. Провал ничего не отменяет: офис
  // открыт, а список того, что чинить, лежит в его состоянии.
  logEnvChecks(state, await refreshEnvChecks(state));
  clearInitFlag(entry.id);
  // Офис сам следит, что сданная работа доезжает до основной ветки: ветки,
  // оставшиеся с прошлого запуска, поедут без единого нажатия.
  startSupervisor(state);
  // Сводка здоровья пересчитывается от событий доски, а не по опросу: так она
  // успевает за состоянием, а не отстаёт от него на минуту тика надзора.
  watchHealth(state);
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
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

/**
 * Проверки окружения по HTTP: GET отдаёт последний посчитанный список, POST
 * пересчитывает его заново. Отдельным маршрутом, а не только событием по
 * сокету, потому что ответ «почему офис не сделает задачу» нужен и тогда,
 * когда до браузера дело не дошло: в терминале, в скрипте запуска, в CI.
 * Офис выбирается параметром `?office=`; без него — тот, с которым стартовали.
 */
async function serveEnv(method: string, query: string, res: ServerResponse): Promise<void> {
  const json = (code: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };
  if (method !== 'GET' && method !== 'POST') {
    json(405, { error: c('boot.envGetPost') }, { Allow: 'GET, POST' });
    return;
  }
  // Ждём открытия стартового офиса: запрос может прийти раньше, чем он успел
  // открыться, и пустой список читался бы как «вопросов к окружению нет».
  await startup;
  const officeId = new URLSearchParams(query).get('office') ?? currentOffice()?.id ?? '';
  if (!isOpened(officeId)) {
    json(409, { error: startupError ?? c('boot.officeOpening') });
    return;
  }
  const state = getOffice(officeId);
  json(200, { env: method === 'POST' ? await refreshEnvChecks(state) : state.env });
}

const httpServer = createServer((req, res) => {
  const [url = '/', query = ''] = (req.url ?? '/').split('?');

  // Проверки окружения — до общего 404 по /api/: это единственный ответ,
  // который нужен ровно тогда, когда с офисом что-то не так.
  if (url === '/api/env') {
    void serveEnv(req.method ?? 'GET', query, res);
    return;
  }

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
  // Аватарка офиса: отдача картинки, загрузка и снятие — см. officeicon.ts.
  if (handleOfficeIcon(req, res, url, query)) return;
  // Журнал офиса — постранично: `?limit=50&cursor=J-120&office=<id>`.
  // Снапшот по сокету отдаёт журнал целиком, и это правильно для интерфейса,
  // который держит его весь; всем остальным (скрипты, проверки, сторонний
  // просмотр) нужна страница, а не мегабайт записей за месяцы работы офиса.
  // Только чтение и только по уже открытому офису — как у списка офисов.
  if (url === '/api/journal') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET' });
      res.end(JSON.stringify({ error: c('boot.journalGetOnly') }));
      return;
    }
    const params = new URL(req.url ?? '/', 'http://office').searchParams;
    // Без `office` — тот, который человек открывал последним: у запроса по
    // HTTP нет подписки, и «свой» офис ему взять неоткуда.
    const wantedId = params.get('office');
    const office = wantedId ? officeById(wantedId) : currentOffice();
    if (!office) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: c('offices.notFound', { id: wantedId ?? '' }) }));
      return;
    }
    // Журнал живёт в памяти поднятого офиса. Поднимать офис ради чтения не
    // станем: это завело бы ему сессии и надзор — слишком много для GET.
    if (!isOpened(office.id)) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: c('boot.journalClosed', { office: office.name }) }));
      return;
    }
    const page = pageFacts(getOffice(office.id), {
      limit: params.get('limit'), cursor: params.get('cursor'),
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(page));
    return;
  }
  // Сводка здоровья офиса: `?office=<id>`. Три списка — провалы без разбора,
  // ветки старше суток, вставшие задачи — и возраст каждой записи. Считается
  // на месте из доски и журнала, поэтому одинаково честна и сразу после
  // перезапуска: ничего не копится в памяти между запусками.
  if (url === '/api/health') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET' });
      res.end(JSON.stringify({ error: c('boot.healthGetOnly') }));
      return;
    }
    const params = new URL(req.url ?? '/', 'http://office').searchParams;
    const wantedId = params.get('office');
    const office = wantedId ? officeById(wantedId) : currentOffice();
    if (!office) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: c('offices.notFound', { id: wantedId ?? '' }) }));
      return;
    }
    // Как и с журналом: поднимать офис ради чтения не станем — это завело бы
    // ему сессии и надзор.
    if (!isOpened(office.id)) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: c('boot.healthClosed', { office: office.name }) }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(officeHealth(getOffice(office.id), Date.now())));
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
 * Команды, после которых проверки окружения пересчитываются сами. Список
 * перечислением, а не «на всякий случай после каждой»: проверки ходят в git,
 * и гонять их на каждое сообщение из браузера незачем. Асинхронных правок
 * ролей здесь нет — они пересчитывают сами, когда правка доедет.
 */
const ENV_AFFECTING: ReadonlySet<ClientCommand['c']> = new Set([
  'settings', 'cloud_token', 'hire', 'hire_copy', 'spawn', 'fire',
  'archive_role', 'remove_role', 'detach_role', 'reset',
]);

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
        .then((errors) => {
          replyRole(ws, 'update', cmd.roleId, errors);
          // Пересчёт после ответа, а не вместе с командой: роль правится
          // асинхронно, и проверка репозитория роли до записи увидела бы старый путь.
          return refreshEnvChecks(state);
        });
    } else if (cmd.c === 'create_role') {
      void state.createRole(cmd.role).then((made) => {
        if ('errors' in made) send(ws, { t: 'role.error', op: 'create', roleId: null, errors: made.errors });
        else send(ws, { t: 'role.saved', op: 'create', roleId: made.role.id });
        return refreshEnvChecks(state);
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
    } else if (cmd.c === 'task_edit') {
      // Правка из карточки и правка менеджером — одно и то же действие: отказ
      // («за неё уже взялись», «пустое ТЗ») говорим готовым текстом в чат.
      const outcome = editTask(state, cmd.taskId, cmd.patch);
      if (!outcome.ok) state.addChat(OFFICE_SENDER, outcome.message);
    } else if (cmd.c === 'task_drop') {
      const outcome = dropTask(state, cmd.taskId, cmd.reason ?? '');
      if (!outcome.ok) state.addChat(OFFICE_SENDER, outcome.message);
    } else if (cmd.c === 'task_delete') {
      const outcome = deleteTask(state, cmd.taskId);
      if (!outcome.ok) state.addChat(OFFICE_SENDER, outcome.message);
    } else if (cmd.c === 'task_diff') {
      void taskDiff(state, cmd.taskId);
    } else if (cmd.c === 'task_priority') {
      // Значение приводим к допустимому здесь же: команда приходит из браузера,
      // и чужое слово в приоритете не должно портить доску.
      const problem = state.setTaskPriority(cmd.taskId, asTaskPriority(cmd.priority));
      if (problem) state.addChat(OFFICE_SENDER, problem);
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
    } else if (cmd.c === 'rules_list') {
      // Правила читаются с диска, а не из состояния: файл могли поправить
      // руками или веткой задачи, и панель обязана показывать то, что лежит.
      send(ws, { t: 'rules', scopes: ruleScopes(state) });
    } else if (cmd.c === 'rule_add' || cmd.c === 'rule_edit' || cmd.c === 'rule_drop') {
      const out = cmd.c === 'rule_add'
        ? addRule(state, cmd.scopeId, cmd.text)
        : cmd.c === 'rule_edit' ? editRule(state, cmd.id, cmd.text) : dropRule(state, cmd.id);
      // Удачная правка уже разослала событие всем зрителям офиса; отказ
      // касается только того, кто просил, и идёт ему в чат.
      if (!out.ok) {
        state.addChat(OFFICE_SENDER, out.error);
        send(ws, { t: 'rules', scopes: ruleScopes(state) });
      }
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
    } else if (cmd.c === 'env_check') {
      // Окружение чинят снаружи офиса: создали директорию, сделали git init,
      // положили ключ. Узнать об этом офис может только переспросив — и это
      // единственное, что нужно нажать вместо перезапуска процесса.
      void refreshEnvChecks(state);
    } else if (cmd.c === 'meeting' && cmd.topic.trim()) {
      void holdMeeting(state, cmd.topic.trim(), cmd.participants);
    } else if (cmd.c === 'reset') {
      resetSessions(state);
      state.hardReset();
      broadcastSnapshot(state);
    }

    // Часть команд меняет ответ проверок не меньше, чем правка окружения
    // снаружи: сменили движок на облачный — стал нужен ключ, уволили
    // последнего исполнителя — задачи некому делать. Пересчитываем в одном
    // месте, иначе список врал бы до следующего перезапуска.
    if (ENV_AFFECTING.has(cmd.c)) void refreshEnvChecks(state);
  });

  ws.on('close', () => unwatch(ws));
});

httpServer.listen(PORT);

const built = existsSync(resolve(DIST, 'index.html'));
console.log(c(built ? 'boot.listening' : 'boot.listeningNoWeb', { port: PORT }));
console.log(c('boot.workingIn', { dir: opened.projectDir }));
console.log(c(USING_KEY ? 'boot.paidApi' : 'boot.subscription'));

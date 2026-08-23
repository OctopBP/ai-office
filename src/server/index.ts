import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { ClientCommand, ServerEvent } from '../shared/types';
import { office, officeViews, openOfficeState, subscribeOffices } from './state';
import {
  broadcast, broadcastSnapshot, handleOfficeCommand, initOfficeApi, sendSnapshot,
  unwatch, watch, watching,
} from './office-api';
import { assignDirect, holdMeeting, resetSessions, retryTask, sendUserMessage, setPaused, stopTask, taskDiff, talkTo } from './agents';
import { mergeQueue, refreshMergeChecks } from './merge';
import { retryPipeline } from './review';
import { startSupervisor } from './supervisor';
import { githubToken, setGithubToken } from './cloud';
import { clearInitFlag, currentOffice, ensureOffice, loadRegistry, setCurrent, type OfficeEntry } from './offices';
import { hasCommits, initRepo, isRepo } from './git';
import { isPermissionMode } from './permissions';
import { allRoles } from './roles';
import { flushAll } from './store';

const PORT = Number(process.env.OFFICE_PORT ?? 3001);
const DEFAULT_DIR = resolve(process.env.OFFICE_PROJECT_DIR ?? './workspace');

/** Режим проверки PM — свойство запуска, а не офиса: он же и у следующего. */
const DRY_RUN = process.env.OFFICE_DRY_RUN === '1';
if (DRY_RUN) console.log('🧪 Режим проверки PM: исполнители заглушены');

/**
 * Изоляция задач через git worktree работает только в репозитории.
 * Директорию, которую создали мы сами, инициализируем; чужую — не трогаем,
 * только сообщаем, что изоляция выключена.
 */
async function setupGit(dir: string, ours: boolean): Promise<void> {
  if (ours && !(await isRepo(dir))) {
    const ok = await initRepo(dir);
    console.log(ok
      ? '🌱 Рабочая директория инициализирована как git-репозиторий'
      : '⚠️  Не удалось инициализировать git — изоляция задач выключена');
  }
  office.gitReady = (await isRepo(dir)) && (await hasCommits(dir));
  console.log(office.gitReady
    ? '🌿 Изоляция задач включена: каждая задача получает свой worktree'
    : `⚠️  ${dir} — не git-репозиторий с коммитами. Параллельные исполнители` +
      ' будут работать в общей директории и могут конфликтовать.' +
      ' Включить изоляцию: git init в этой директории.');
}

/**
 * Роли могут работать в своих репозиториях. Проверяем их на старте: узнать,
 * что путь неверный, из проваленной задачи — слишком поздно.
 */
async function reportRoleRepos(): Promise<void> {
  for (const role of allRoles()) {
    const dir = office.repoFor(role);
    if (dir === office.projectDir) continue;
    const ready = (await isRepo(dir)) && (await hasCommits(dir));
    console.log(ready
      ? `   ${role.emoji} ${role.title} → ${dir}`
      : `⚠️  ${role.title}: ${dir} — не git-репозиторий с коммитами.` +
        ' Задачи этой роли пойдут без изоляции веткой.');
  }
}

/** Открыть офис: своё состояние, своя рабочая директория, свой git. */
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
      '# Рабочая директория офиса\n\nЗдесь работает команда AI-агентов.\n',
    );
  }

  // Состояние берётся из реестра: у каждого офиса оно своё и живёт до конца
  // процесса, поэтому `office` здесь просто переставляется на нужное.
  const { state, restored, reused } = openOfficeState(entry);
  state.dryRun = DRY_RUN;
  const board = `задач ${state.tasks.size}, сообщений ${state.chat.length}`;
  if (reused) console.log(`🔁 Офис «${entry.name}» уже открыт в этом запуске: ${board}`);
  else if (restored) console.log(`💾 Офис «${entry.name}» восстановлен: ${board}`);
  await setupGit(entry.projectDir, ours);
  await reportRoleRepos();
  clearInitFlag(entry.id);
  // Офис сам следит, что сданная работа доезжает до основной ветки: ветки,
  // оставшиеся с прошлого запуска, поедут без единого нажатия.
  startSupervisor(state);
}

loadRegistry(DEFAULT_DIR);
// Переменная окружения по-прежнему решает, с каким проектом открыться:
// на неё опираются тесты и запуск «в другой папке» одной командой.
if (process.env.OFFICE_PROJECT_DIR) {
  const wanted = ensureOffice({ name: DEFAULT_DIR.split('/').pop() ?? 'Офис', projectDir: DEFAULT_DIR });
  setCurrent(wanted.id);
}
const opened = currentOffice();
if (!opened) throw new Error('Не удалось определить офис для запуска');
const startup = openOffice(opened);

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
      res.end(JSON.stringify({ error: 'Список офисов отдаётся только по GET.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ offices: officeViews() }));
    return;
  }
  if (url.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `Метода ${url} нет.` }));
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
    res.end(existsSync(DIST)
      ? 'Не найдено'
      : 'Веб не собран. Соберите его: npm run build (или откройте vite на :5173).');
  }
});

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
  void startup.then(() => {
    if (watching(ws)) sendSnapshot(ws);
  });

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

    if (cmd.c === 'user_message' && cmd.text.trim()) {
      sendUserMessage(cmd.text.trim());
    } else if (cmd.c === 'permission') {
      office.resolvePermission(cmd.id, cmd.decision);
    } else if (cmd.c === 'merge_task') {
      // Слияние одной задачи — та же очередь длиной в один шаг: и проверка
      // сборки после, и пересчёт статусов работают одинаково.
      void mergeQueue([cmd.taskId]);
    } else if (cmd.c === 'merge_check') {
      void refreshMergeChecks();
    } else if (cmd.c === 'merge_queue') {
      void mergeQueue(cmd.taskIds);
    } else if (cmd.c === 'pr_retry') {
      // Вставший конвейер толкают кнопкой: чинить руками в терминале —
      // ровно то, от чего офис и должен избавлять.
      retryPipeline(office, cmd.taskId);
    } else if (cmd.c === 'spawn' || cmd.c === 'hire') {
      // Наём: и первый сотрудник в пустую роль, и очередной клон — одно и то же
      // действие, отличается только тем, сколько народу в роли уже сидит.
      const problem = office.hire(cmd.roleId);
      if (problem) office.addChat('офис', problem);
    } else if (cmd.c === 'fire') {
      const problem = office.fire(cmd.instanceId);
      if (problem) office.addChat('офис', problem);
    } else if (cmd.c === 'update_role') {
      office.updateRole(cmd.roleId, cmd.patch);
    } else if (cmd.c === 'agent_permission') {
      // null — снять личное правило и вернуть сотрудника к режиму роли;
      // мусорное значение молча игнорируем, а не выдаём за режим.
      if (cmd.mode === null || isPermissionMode(cmd.mode)) {
        office.setAgentPermissionMode(cmd.instanceId, cmd.mode);
      }
    } else if (cmd.c === 'settings') {
      // Отказ по настройкам говорим тем же способом, что и по найму: текст
      // готов к показу, придумывать формулировку клиенту не нужно.
      const problem = office.updateSettings(cmd.settings);
      if (problem) office.addChat('офис', problem);
    } else if (cmd.c === 'layout_edit') {
      // Расстановку правит человек мышью: отказ («предмета нет», «позиция за
      // стеной») говорим тем же способом, что и по настройкам — готовым текстом.
      const problem = office.editLayout(cmd.edits);
      if (problem) office.addChat('офис', problem);
    } else if (cmd.c === 'layout_reset') {
      const problem = office.resetLayout(cmd.key);
      if (problem) office.addChat('офис', problem);
    } else if (cmd.c === 'talk' && cmd.text.trim()) {
      talkTo(cmd.instanceId, cmd.text.trim());
    } else if (cmd.c === 'stop_task') {
      stopTask(cmd.taskId);
    } else if (cmd.c === 'retry_task') {
      void retryTask(cmd.taskId);
    } else if (cmd.c === 'task_diff') {
      void taskDiff(cmd.taskId);
    } else if (cmd.c === 'assign_direct') {
      assignDirect(cmd.taskId, cmd.instanceId);
    } else if (cmd.c === 'pause') {
      setPaused(cmd.paused);
    } else if (cmd.c === 'cloud_token') {
      setGithubToken(cmd.token);
      office.setCloud({ hasToken: Boolean(githubToken()) });
    } else if (cmd.c === 'meeting' && cmd.topic.trim()) {
      void holdMeeting(cmd.topic.trim(), cmd.participants);
    } else if (cmd.c === 'reset') {
      resetSessions();
      office.hardReset();
      broadcastSnapshot();
    }
  });

  ws.on('close', () => unwatch(ws));
});

httpServer.listen(PORT);

const built = existsSync(resolve(DIST, 'index.html'));
console.log(built
  ? `🏢 AI Office — откройте http://localhost:${PORT}`
  : `🏢 AI Office — сервер на ws://localhost:${PORT} (веб не собран: npm run build)`);
console.log(`📁 Команда работает в: ${opened.projectDir}`);
// Источник доступа важен: с ключом расход идёт в платный API, без него —
// в лимиты подписки Claude Code. Ключ имеет приоритет и подменяет подписку молча.
const usingKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
office.authSource = usingKey ? 'api-key' : 'subscription';
office.cloud = { hasKey: usingKey, hasToken: Boolean(githubToken()) };
console.log(usingKey
  ? '💳 Задан ANTHROPIC_API_KEY — расход идёт в ПЛАТНЫЙ API, а не в подписку Claude Code'
  : '🔑 Ключ API не задан — работаем на авторизации Claude Code (лимиты подписки)');

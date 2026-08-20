import { WebSocketServer, WebSocket } from 'ws';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClientCommand, ServerEvent } from '../shared/types';
import { office, officeViews } from './state';
import { assignDirect, holdMeeting, mergeTask, resetSessions, retryTask, sendUserMessage, setPaused, stopTask, taskDiff, talkTo } from './agents';
import { githubToken, setGithubToken } from './cloud';
import { clearInitFlag, createOffice, currentOffice, ensureOffice, loadRegistry, renameOffice, setCurrent, type OfficeEntry } from './offices';
import { hasCommits, initRepo, isRepo } from './git';
import { flush, setStateFile } from './store';

const PORT = Number(process.env.OFFICE_PORT ?? 3001);
const DEFAULT_DIR = resolve(process.env.OFFICE_PROJECT_DIR ?? './workspace');

office.dryRun = process.env.OFFICE_DRY_RUN === '1';
if (office.dryRun) console.log('🧪 Режим проверки PM: исполнители заглушены');

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

  setStateFile(entry.stateFile);
  office.officeId = entry.id;
  office.projectDir = entry.projectDir;
  office.unload();
  if (office.restore()) {
    console.log(`💾 Офис «${entry.name}» восстановлен: задач ${office.tasks.size}, сообщений ${office.chat.length}`);
  } else {
    office.seed();
  }
  await setupGit(entry.projectDir, ours);
  clearInitFlag(entry.id);
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
  process.on(sig, () => { flush(); process.exit(0); });
}
process.on('exit', () => flush());

const wss = new WebSocketServer({ port: PORT });
const clients = new Set<WebSocket>();

office.subscribe((event: ServerEvent) => {
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
});

function broadcastSnapshot(): void {
  const payload = JSON.stringify(office.snapshot());
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/**
 * Переключение проекта на ходу. Идущие задачи не бросаем: их сессии живут
 * в рабочей директории этого офиса, и оборвать их переключением значило бы
 * потерять работу молча.
 */
async function switchOffice(officeId: string): Promise<void> {
  const target = setCurrent(officeId);
  if (!target) return;
  if (target.id === office.officeId) return;

  const running = [...office.tasks.values()].filter((t) => t.status === 'in_progress');
  if (running.length) {
    setCurrent(office.officeId);
    office.addChat('офис',
      `Сначала дождитесь или остановите задачи в работе: ${running.map((t) => t.id).join(', ')}.`);
    return;
  }

  resetSessions();
  flush();
  await openOffice(target);
  office.addLog(null, 'system', `Открыт офис «${target.name}» (${target.projectDir})`);
  broadcastSnapshot();
}

wss.on('connection', (ws) => {
  clients.add(ws);
  void startup.then(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(office.snapshot()));
  });

  ws.on('message', (raw) => {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (cmd.c === 'user_message' && cmd.text.trim()) {
      sendUserMessage(cmd.text.trim());
    } else if (cmd.c === 'permission') {
      office.resolvePermission(cmd.id, cmd.decision);
    } else if (cmd.c === 'merge_task') {
      void mergeTask(cmd.taskId);
    } else if (cmd.c === 'spawn') {
      const inst = office.spawn(cmd.roleId);
      if (!inst) {
        office.addChat('офис',
          'Не удалось нанять: либо достигнут лимит клонов роли, либо в офисе нет свободных рабочих мест.');
      } else {
        office.addLog(null, 'system', `Нанят ${inst.id}`);
        office.emit({ t: 'roles', roles: office.roleViews() });
      }
    } else if (cmd.c === 'fire') {
      const problem = office.fire(cmd.instanceId);
      if (problem) office.addChat('офис', problem);
    } else if (cmd.c === 'update_role') {
      office.updateRole(cmd.roleId, cmd.patch);
    } else if (cmd.c === 'settings') {
      office.updateSettings(cmd.settings);
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
    } else if (cmd.c === 'switch_office') {
      void switchOffice(cmd.officeId);
    } else if (cmd.c === 'create_office' && cmd.projectDir.trim()) {
      const made = createOffice({ name: cmd.name, projectDir: cmd.projectDir.trim() });
      if ('error' in made) {
        office.addChat('офис', made.error);
      } else {
        office.emit({ t: 'offices', offices: officeViews() });
        void switchOffice(made.office.id);
      }
    } else if (cmd.c === 'rename_office') {
      if (renameOffice(cmd.officeId, cmd.name)) {
        office.emit({ t: 'offices', offices: officeViews() });
      }
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

  ws.on('close', () => clients.delete(ws));
});

console.log(`🏢 AI Office — сервер на ws://localhost:${PORT}`);
console.log(`📁 Команда работает в: ${opened.projectDir}`);
// Источник доступа важен: с ключом расход идёт в платный API, без него —
// в лимиты подписки Claude Code. Ключ имеет приоритет и подменяет подписку молча.
const usingKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
office.authSource = usingKey ? 'api-key' : 'subscription';
office.cloud = { hasKey: usingKey, hasToken: Boolean(githubToken()) };
console.log(usingKey
  ? '💳 Задан ANTHROPIC_API_KEY — расход идёт в ПЛАТНЫЙ API, а не в подписку Claude Code'
  : '🔑 Ключ API не задан — работаем на авторизации Claude Code (лимиты подписки)');

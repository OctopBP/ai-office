import { WebSocketServer, WebSocket } from 'ws';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClientCommand, ServerEvent } from '../shared/types';
import { office } from './state';
import { assignDirect, holdMeeting, mergeTask, resetSessions, retryTask, sendUserMessage, stopTask, taskDiff, talkTo } from './agents';
import { hasCommits, initRepo, isRepo } from './git';
import { flush } from './store';

const PORT = Number(process.env.OFFICE_PORT ?? 3001);
const PROJECT_DIR = resolve(process.env.OFFICE_PROJECT_DIR ?? './workspace');

// Директория, в которой работает команда. По умолчанию отдельная папка,
// чтобы агенты не редактировали исходники самого офиса.
const weCreatedIt = !existsSync(PROJECT_DIR);
if (weCreatedIt) {
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(
    resolve(PROJECT_DIR, 'README.md'),
    '# Рабочая директория офиса\n\nЗдесь работает команда AI-агентов.\n',
  );
}
office.projectDir = PROJECT_DIR;
office.dryRun = process.env.OFFICE_DRY_RUN === '1';
if (office.dryRun) console.log('🧪 Режим проверки PM: исполнители заглушены');

/**
 * Изоляция задач через git worktree работает только в репозитории.
 * Свою собственную директорию мы инициализируем сами; чужую — не трогаем,
 * только сообщаем, что изоляция выключена.
 */
async function setupGit(): Promise<void> {
  if (weCreatedIt && !(await isRepo(PROJECT_DIR))) {
    const ok = await initRepo(PROJECT_DIR);
    console.log(ok
      ? '🌱 Рабочая директория инициализирована как git-репозиторий'
      : '⚠️  Не удалось инициализировать git — изоляция задач выключена');
  }
  office.gitReady = (await isRepo(PROJECT_DIR)) && (await hasCommits(PROJECT_DIR));
  console.log(office.gitReady
    ? '🌿 Изоляция задач включена: каждая задача получает свой worktree'
    : `⚠️  ${PROJECT_DIR} — не git-репозиторий с коммитами. Параллельные исполнители` +
      ' будут работать в общей директории и могут конфликтовать.' +
      ' Включить изоляцию: git init в этой директории.');
}

// Восстанавливаем доску, чат и расходы с прошлого запуска.
if (office.restore()) {
  console.log(`💾 Состояние офиса восстановлено: задач ${office.tasks.size}, сообщений ${office.chat.length}`);
} else {
  office.seed();
}
void setupGit();

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

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(office.snapshot()));

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
    } else if (cmd.c === 'meeting' && cmd.topic.trim()) {
      void holdMeeting(cmd.topic.trim(), cmd.participants);
    } else if (cmd.c === 'reset') {
      resetSessions();
      office.hardReset();
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(office.snapshot()));
      }
    }
  });

  ws.on('close', () => clients.delete(ws));
});

console.log(`🏢 AI Office — сервер на ws://localhost:${PORT}`);
console.log(`📁 Команда работает в: ${PROJECT_DIR}`);
// Источник доступа важен: с ключом расход идёт в платный API, без него —
// в лимиты подписки Claude Code. Ключ имеет приоритет и подменяет подписку молча.
const usingKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
office.authSource = usingKey ? 'api-key' : 'subscription';
console.log(usingKey
  ? '💳 Задан ANTHROPIC_API_KEY — расход идёт в ПЛАТНЫЙ API, а не в подписку Claude Code'
  : '🔑 Ключ API не задан — работаем на авторизации Claude Code (лимиты подписки)');

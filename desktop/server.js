/**
 * Сервер офиса внутри приложения.
 *
 * Сервер живёт отдельным процессом, а не в main: падение сессии агента не
 * должно уносить окно, а перезапуск офиса — требовать перезапуска
 * приложения. Запускается он электроновским node (`ELECTRON_RUN_AS_NODE`) —
 * это обычная нода, с полным ESM и без оговорок Electron о том, что умеет
 * utilityProcess.
 */

const { fork } = require('node:child_process');
const { createServer, connect } = require('node:net');
const { execFileSync } = require('node:child_process');
const { createWriteStream, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');

const paths = require('./paths');

/** Свободный порт: занимаем нулевой, смотрим, что дали, и сразу отпускаем. */
function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

/** Дождаться, пока порт начнёт отвечать. */
function waitPort(port, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  return new Promise((done, fail) => {
    const tick = () => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); done(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > until) fail(new Error('сервер офиса не ответил за 30 секунд'));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

/**
 * PATH, каким его видит человек в терминале.
 *
 * Приложение, запущенное из Finder или с ярлыка, получает голый системный
 * PATH: ни node, ни npm, ни homebrew. Офису это важнее, чем кажется, — он
 * гоняет проверки проекта (`npm run typecheck` и прочие) перед слиянием, и без
 * PATH они падали бы не по делу. Спрашиваем у входного шелла один раз, на
 * старте, и с таймаутом: медленный .zshrc не должен задерживать окно.
 */
function loginPath() {
  if (process.platform === 'win32') return process.env.PATH ?? '';
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'printf "%s" "$PATH"'], {
      encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const found = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    return found || (process.env.PATH ?? '');
  } catch {
    return process.env.PATH ?? '';
  }
}

/**
 * Запустить сервер. Возвращает порт и сам процесс; журнал пишется в файл —
 * у приложения нет терминала, а разбирать поломку по чему-то надо.
 */
async function start({ claudeBin, gitBin, lang }) {
  const port = await freePort();
  mkdirSync(dirname(paths.logFile()), { recursive: true });
  mkdirSync(paths.dataDir(), { recursive: true });
  const log = createWriteStream(paths.logFile(), { flags: 'a' });
  log.write(`\n=== ${new Date().toISOString()} запуск офиса, порт ${port} ===\n`);

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PATH: loginPath(),
    OFFICE_APP: '1',
    OFFICE_PORT: String(port),
    // Только петля: сервер приложения не должен оказаться открытым в сеть.
    OFFICE_HOST: '127.0.0.1',
    OFFICE_ROOT: paths.resourcesDir(),
    OFFICE_DIST_DIR: paths.webDir(),
    OFFICE_STATE_FILE: paths.stateFile(),
    OFFICE_PROJECT_DIR: process.env.OFFICE_PROJECT_DIR ?? paths.defaultProjectDir(),
    // Свои сотрудники — данные человека, а не часть программы: внутрь .app
    // писать нельзя, да и обновление приложения их бы стёрло.
    OFFICE_EMPLOYEES_DIR: join(paths.dataDir(), 'employees'),
    // Свои node-серверы офис запускает нами же: отдельного node рядом с
    // приложением нет (см. NODE_BIN в src/server/mcp.ts).
    OFFICE_NODE_BIN: process.execPath,
  };
  if (claudeBin) env.OFFICE_CLAUDE_BIN = claudeBin;
  else delete env.OFFICE_CLAUDE_BIN;
  if (gitBin) env.OFFICE_GIT_BIN = gitBin;
  if (lang) env.OFFICE_LANG = lang;

  const child = fork(paths.serverEntry(), [], {
    env,
    // Текущая папка у приложения случайна: ставим папку данных, чтобы
    // случайный относительный путь лёг туда, а не в корень диска.
    cwd: paths.dataDir(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  await waitPort(port);
  return { port, child };
}

/**
 * Остановить сервер по-хорошему: по SIGTERM он дописывает состояние офисов на
 * диск. Не успел за три секунды — добиваем, потерять окно закрытия хуже.
 */
function stop(child) {
  return new Promise((done) => {
    if (!child || child.exitCode !== null || child.signalCode) { done(); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    child.kill('SIGTERM');
  });
}

module.exports = { start, stop, freePort, waitPort, loginPath };

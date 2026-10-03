/**
 * Проверка модуля терминала. npm run test:terminal
 *
 * Правило доступа, окружение и сбой загрузки node-pty проверяются без живого
 * терминала. Живой прогон (оболочка в нужной папке) пропускается, если
 * псевдотерминал открыть нельзя: в песочнице исполнителя это EPERM.
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canOpenTerminal, closeAll, closeAllForClient, isExposed, openTerminal,
  setPtyLoaderForTest, shellFor, terminalCount, terminalEnv, TerminalError,
} from '../src/server/terminal';

let failed = 0;
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${what}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
}

// ------------------------------------------------------------- открыт ли офис

check('приложение на 127.0.0.1 — локально', !isExposed({ OFFICE_HOST: '127.0.0.1' }));
check('::1 — локально', !isExposed({ OFFICE_HOST: '::1' }));
check('localhost — локально', !isExposed({ OFFICE_HOST: 'localhost' }));
check('пустой хост (все интерфейсы) — наружу', isExposed({}));
check('0.0.0.0 — наружу', isExposed({ OFFICE_HOST: '0.0.0.0' }));
check('публичный адрес — наружу даже на loopback',
  isExposed({ OFFICE_HOST: '127.0.0.1', OFFICE_PUBLIC_URL: 'https://office.example.com' }));

// ------------------------------------------------------------- правило доступа

const local = { exposed: false, ownerSignedIn: false, host: '127.0.0.1:3001' };
check('локально, своя страница', canOpenTerminal({ ...local, origin: 'http://127.0.0.1:3001' }).ok);
check('локально, dev-сервер vite', canOpenTerminal({ ...local, origin: 'http://localhost:5173' }).ok);
check('локально, чужая вкладка — отказ', !canOpenTerminal({ ...local, origin: 'https://evil.example' }).ok);
check('локально, без Origin — отказ', !canOpenTerminal(local).ok);
check('локально, чужой порт — отказ', !canOpenTerminal({ ...local, origin: 'http://127.0.0.1:4000' }).ok);

const open = { exposed: true, host: 'office.example.com', origin: 'https://office.example.com' };
const denied = canOpenTerminal({ ...open, ownerSignedIn: false });
check('наружу без входа — отказ', !denied.ok);
check('отказ с причиной forbidden и текстом',
  !denied.ok && denied.reason === 'forbidden' && denied.message.length > 0);
check('наружу, вошедший владелец', canOpenTerminal({ ...open, ownerSignedIn: true }).ok);
check('наружу, владелец, но чужая страница — отказ',
  !canOpenTerminal({ ...open, ownerSignedIn: true, origin: 'https://evil.example' }).ok);
check('наружу, dev-сервер не пускает',
  !canOpenTerminal({ ...open, ownerSignedIn: true, origin: 'http://localhost:5173' }).ok);
check('за шлюзом: Origin совпадает с публичным адресом',
  canOpenTerminal({
    exposed: true, ownerSignedIn: true, host: '10.0.0.5:3001',
    origin: 'https://office.example.com', publicUrl: 'https://office.example.com/',
  }).ok);

// ------------------------------------------------------------- оболочка и окружение

check('оболочка из $SHELL с -l',
  JSON.stringify(shellFor('darwin', { SHELL: '/bin/bash' })) === JSON.stringify({ file: '/bin/bash', args: ['-l'] }));
check('без $SHELL — zsh', shellFor('linux', {}).file === '/bin/zsh');
check('Windows без PowerShell — ComSpec',
  shellFor('win32', { SystemRoot: '/нет/такой', ComSpec: 'C:\\cmd.exe' }).file === 'C:\\cmd.exe');

const env = terminalEnv({
  PATH: '/usr/bin', OFFICE_PORT: '3001', ELECTRON_RUN_AS_NODE: '1', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', HOME: '/h',
});
check('окружение без OFFICE_*, ELECTRON_RUN_AS_NODE и токенов GitHub',
  !('OFFICE_PORT' in env) && !('ELECTRON_RUN_AS_NODE' in env) && !('GH_TOKEN' in env) && !('GITHUB_TOKEN' in env));
check('PATH и HOME остались', env.PATH === '/usr/bin' && env.HOME === '/h');
check('TERM, COLORTERM и LANG', env.TERM === 'xterm-256color' && env.COLORTERM === 'truecolor' && env.LANG === 'en_US.UTF-8');
check('ключи провайдеров сняты по умолчанию', !('ANTHROPIC_API_KEY' in terminalEnv()));

// ------------------------------------------------------------- сбой загрузки и папка

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-term-')));
const noop = { onData: () => {}, onExit: () => {} };

function errorOf(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (err) {
    return err;
  }
}

setPtyLoaderForTest(() => {
  throw new Error('Cannot find module node-pty');
});
const broken = errorOf(() => openTerminal({ clientId: 'c1', cwd, cols: 80, rows: 24, ...noop }));
check('незагруженный pty — TerminalError(unavailable)',
  broken instanceof TerminalError && broken.reason === 'unavailable', String(broken));
check('текст ошибки понятный',
  broken instanceof Error && broken.message.includes('node-pty') && broken.message.startsWith('Терминал недоступен'));
const again = errorOf(() => openTerminal({ clientId: 'c1', cwd, cols: 80, rows: 24, ...noop }));
check('повторное открытие тоже отдаёт ошибку, а не падает', again instanceof TerminalError);
check('после сбоя ничего не открыто', terminalCount() === 0);

const noDir = errorOf(() => openTerminal({ clientId: 'c1', cwd: path.join(cwd, 'нет'), cols: 80, rows: 24, ...noop }));
check('нет папки — no_dir', noDir instanceof TerminalError && noDir.reason === 'no_dir', String(noDir));

// ------------------------------------------------------------- живой прогон

setPtyLoaderForTest(null);

async function live(): Promise<void> {
  let output = '';
  let done!: (exit: { code: number | null }) => void;
  const exited = new Promise<{ code: number | null }>((r) => { done = r; });
  let term;
  try {
    term = openTerminal({
      clientId: 'live', cwd, cols: 80, rows: 24,
      onData: (d) => { output += d; },
      onExit: (e) => done(e),
    });
  } catch (err) {
    if (err instanceof TerminalError && err.reason === 'unavailable') {
      console.log(`  skip живой прогон: ${err.message}`);
      return;
    }
    throw err;
  }
  check('терминал учтён за клиентом', terminalCount('live') === 1);
  term.write('pwd; exit\r');
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 10_000));
  const exit = await Promise.race([exited, timeout]);
  check('оболочка завершилась', exit !== null);
  check('pwd совпадает с cwd', output.includes(cwd), JSON.stringify(output.slice(-300)));
  closeAllForClient('live');
  check('после выхода терминалов нет', terminalCount() === 0);
}

await live();
closeAll();
fs.rmSync(cwd, { recursive: true, force: true });

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nТерминал: все проверки прошли.');

#!/usr/bin/env node
/**
 * Стенд для ручной проверки: сервер офиса и vite из рабочей копии, которые
 * исполнитель может остановить сам.
 *
 * Зачем отдельный скрипт. В песочнице исполнителя сигнал чужому процессу
 * запрещён, а «чужим» для неё становится всё, что запущено прошлой командой
 * Bash: `kill <pid>` отвечает «operation not permitted» даже на процесс,
 * который сессия завела сама. Родителю же сигнал своему ребёнку можно. Поэтому
 * сервер и vite запускает надзиратель — отдельный процесс этого же скрипта, —
 * а останавливает их он же, увидев файл-флаг. Флаг пишет `stop`: создать файл
 * песочница разрешает, послать сигнал — нет.
 *
 *   node scripts/stand.mjs start [--port 3027] [--web-port 5178] [--name qa] [--ttl 120]
 *   node scripts/stand.mjs stop [--name qa | --all]
 *   node scripts/stand.mjs list
 *
 * Сервер поднимается с OFFICE_DRY_RUN=1 и своим state.json в `.tmp/stand/<имя>/`,
 * так что живой офис он не трогает. Порт 3002 — живой офис, его стенд не берёт.
 * Надзиратель сам гасит стенд по сроку `--ttl` (минуты, по умолчанию 120) и
 * если упал сервер или vite: забытый стенд не висит до перезагрузки машины.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.tmp', 'stand');
const LIVE_PORTS = new Set([3002]);

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const name = String(opt('name', 'qa')).replace(/[^a-zA-Z0-9_-]/g, '');
const infoFile = (n) => join(DIR, `${n}.json`);
const stopFile = (n) => join(DIR, `${n}.stop`);
const readInfo = (n) => {
  try {
    return JSON.parse(readFileSync(infoFile(n), 'utf8'));
  } catch {
    return null;
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Свободен ли порт на петле. Проверяем подключением, а не пробным listen:
 * песочница может запрещать привязку порта, и тогда пробный listen назвал бы
 * занятым любой порт.
 */
const portFree = (port) =>
  new Promise((res) => {
    const s = connect({ port, host: '127.0.0.1' });
    s.setTimeout(1000);
    s.once('connect', () => { s.destroy(); res(false); });
    s.once('timeout', () => { s.destroy(); res(false); });
    s.once('error', () => res(true));
  });

/** Слушает ли кто-нибудь порт: ждём, пока сервер или vite поднимутся. */
const portBusy = async (port) => !(await portFree(port));

async function start() {
  const port = Number(opt('port', 3027));
  const webPort = Number(opt('web-port', 5178));
  const ttl = Number(opt('ttl', 120));
  for (const p of [port, webPort]) {
    if (LIVE_PORTS.has(p)) fail(`порт ${p} — живой офис, стенд его не берёт`);
    if (!(await portFree(p))) fail(`порт ${p} занят; выберите другой (--port / --web-port)`);
  }
  if (readInfo(name)) fail(`стенд «${name}» уже запущен: node scripts/stand.mjs stop --name ${name}`);

  mkdirSync(join(DIR, name), { recursive: true });
  rmSync(stopFile(name), { force: true });
  const log = openSync(join(DIR, `${name}.log`), 'a');
  const sup = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '_supervise', '--name', name, '--port', String(port), '--web-port', String(webPort), '--ttl', String(ttl)],
    { cwd: ROOT, detached: true, stdio: ['ignore', log, log] },
  );
  let supExited = false;
  let seen = false;
  sup.on('exit', () => { supExited = true; });
  sup.unref();

  // Ждём оба порта: исполнителю нужен адрес, по которому уже отвечают.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if ((await portBusy(port)) && (await portBusy(webPort))) {
      console.log(`стенд «${name}»: сервер http://127.0.0.1:${port}, веб http://127.0.0.1:${webPort}`);
      console.log(`остановить: node scripts/stand.mjs stop --name ${name}`);
      process.exit(0);
    }
    // Надзиратель завёл стенд и уже снял его — значит, что-то упало.
    if (readInfo(name)) seen = true;
    else if (seen || supExited) break;
    await wait(500);
  }
  console.error(`стенд «${name}» не поднялся за минуту, журнал: ${join(DIR, `${name}.log`)}`);
  writeFileSync(stopFile(name), '');
  process.exit(1);
}

async function supervise() {
  const port = Number(opt('port'));
  const webPort = Number(opt('web-port'));
  const ttlMs = Number(opt('ttl', 120)) * 60_000;
  const env = {
    ...process.env,
    OFFICE_PORT: String(port),
    OFFICE_DRY_RUN: '1',
    OFFICE_STATE_FILE: join(DIR, name, 'state.json'),
    VITE_OFFICE_PORT: String(port),
    VITE_CACHE_DIR: join(DIR, name, 'vite'),
  };
  // Своя группа процессов у каждого: vite заводит esbuild, tsx — свои
  // процессы, и гасить надо всю группу, а не только верхний.
  const children = [
    spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { cwd: ROOT, env, detached: true, stdio: 'inherit' }),
    spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(webPort), '--strictPort', '--host', '127.0.0.1', '--configLoader', 'runner'], { cwd: ROOT, env, detached: true, stdio: 'inherit' }),
  ];
  writeFileSync(infoFile(name), JSON.stringify({ name, pid: process.pid, port, webPort, children: children.map((c) => c.pid), started: new Date().toISOString() }, null, 2));
  console.log(`[stand] ${new Date().toISOString()} «${name}» запущен: ${port}/${webPort}`);

  let stopping = false;
  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    console.log(`[stand] останавливаю «${name}»: ${why}`);
    const signal = (sig) => {
      for (const c of children) {
        if (c.exitCode !== null || c.signalCode !== null) continue;
        try {
          process.kill(-c.pid, sig);
        } catch {
          try { c.kill(sig); } catch { /* уже вышел */ }
        }
      }
    };
    signal('SIGTERM');
    const until = Date.now() + 5000;
    while (Date.now() < until && children.some((c) => c.exitCode === null && c.signalCode === null)) await wait(200);
    signal('SIGKILL');
    rmSync(infoFile(name), { force: true });
    rmSync(stopFile(name), { force: true });
    process.exit(0);
  };

  for (const c of children) c.on('exit', () => shutdown(`дочерний процесс ${c.pid} вышел`));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  const born = Date.now();
  setInterval(() => {
    if (existsSync(stopFile(name))) shutdown('флаг stop');
    else if (Date.now() - born > ttlMs) shutdown('истёк срок --ttl');
  }, 500);
}

async function stop() {
  const names = flag('all') ? listNames() : [name];
  let failed = false;
  for (const n of names) {
    const info = readInfo(n);
    if (!info) {
      console.log(`стенд «${n}» не запущен`);
      continue;
    }
    writeFileSync(stopFile(n), '');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && readInfo(n)) await wait(300);
    if (readInfo(n)) {
      failed = true;
      console.error(`стенд «${n}» не остановился (надзиратель pid ${info.pid}); журнал: ${join(DIR, `${n}.log`)}`);
    } else {
      const free = (await portFree(info.port)) && (await portFree(info.webPort));
      console.log(`стенд «${n}» остановлен, порты ${info.port}/${info.webPort} ${free ? 'свободны' : 'ещё заняты'}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

function listNames() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

function list() {
  const names = listNames();
  if (!names.length) console.log('запущенных стендов нет');
  for (const n of names) {
    const i = readInfo(n);
    if (i) console.log(`${n}: сервер ${i.port}, веб ${i.webPort}, надзиратель pid ${i.pid}, с ${i.started}`);
  }
}

function fail(msg) {
  console.error(`stand: ${msg}`);
  process.exit(1);
}

if (cmd === 'start') await start();
else if (cmd === '_supervise') await supervise();
else if (cmd === 'stop') await stop();
else if (cmd === 'list') list();
else fail('команда: start | stop | list');

/**
 * Зависимости слитого дерева для пред-merge гейта (T-300).
 *
 * Копия офиса, в которой гейт собирает слияние, получает `node_modules`
 * симлинком на основную рабочую копию (`linkNodeModules`). Пока ветка не
 * трогает зависимости, это ровно то, что нужно. Но ветка, добавившая пакет,
 * на слитом дереве его не находит: так T-296 с node-pty была зелёной у себя и
 * красной в гейте с «TS2307: Cannot find module».
 *
 * Поэтому, если package.json или package-lock.json на слитом дереве не такие,
 * как в базе, гейт ставит зависимости этого дерева — в СОБСТВЕННЫЙ
 * `node_modules` копии офиса, настоящим каталогом вместо симлинка. Основная
 * копия и ветки задач не задеваются: симлинк снимается `unlink`, а не
 * рекурсивным удалением, и npm пишет только в каталог копии офиса. Хеш
 * манифестов кладётся меткой внутрь каталога: следующий прогон с тем же
 * lock-файлом установку пропускает.
 *
 * Lock не менялся — берём симлинк, но сначала сверяем lock слитого дерева с
 * тем, что реально стоит в основном `node_modules` (`lockSatisfied`, T-346):
 * основную копию после слияний никто не доустанавливает, и она отстаёт от
 * базы. Отстала — ставим своё, как при поменявшемся lock.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Lang } from '../shared/i18n';
import { runProjectCheck } from './checks';
import { git, linkNodeModules } from './git';

/** Манифесты, по которым npm решает, что ставить. */
export const DEP_MANIFESTS = ['package.json', 'package-lock.json'] as const;

/** Метка внутри своего `node_modules`: хеш манифестов, под которые он поставлен. */
export const DEPS_MARKER = '.office-deps';

/** Установка дольше проверки: npm может качать пакеты. */
export const DEPS_TIMEOUT_MS = 10 * 60 * 1000;

/** Команда установки: строго по lock-файлу и без чужих скриптов. */
export const installCommand = (dir: string): string => (existsSync(resolve(dir, 'package-lock.json'))
  ? 'npm ci --ignore-scripts --no-audit --no-fund'
  // lock-файла нет — ставим по package.json, но lock не заводим: дерево
  // копии офиса должно остаться ровно тем, что проверяли.
  : 'npm install --ignore-scripts --no-audit --no-fund --no-package-lock');

export interface DepsOutcome {
  /** 'same' — манифесты как в базе; 'cached' — уже стоят; 'installed'; 'failed'. */
  kind: 'same' | 'cached' | 'installed' | 'failed';
  command: string;
  output: string;
  durationMs: number;
}

/** Хеш манифестов дерева: по нему решаем, годится ли уже поставленное. */
export function manifestsHash(dir: string): string {
  const h = createHash('sha1');
  for (const name of DEP_MANIFESTS) {
    const path = resolve(dir, name);
    h.update(`${name}\0${existsSync(path) ? readFileSync(path) : ''}\0`);
  }
  return h.digest('hex');
}

/** Что лежит на месте `node_modules`: симлинк, свой каталог или ничего. */
function nodeModulesKind(dir: string): 'link' | 'dir' | 'none' {
  try {
    return lstatSync(resolve(dir, 'node_modules')).isSymbolicLink() ? 'link' : 'dir';
  } catch {
    return 'none';
  }
}

/**
 * Убрать то, что лежит на месте `node_modules` копии офиса. Симлинк —
 * только `unlink`: рекурсивное удаление по нему стёрло бы зависимости
 * основной рабочей копии.
 */
async function clearNodeModules(dir: string): Promise<void> {
  const kind = nodeModulesKind(dir);
  const path = resolve(dir, 'node_modules');
  if (kind === 'link') unlinkSync(path);
  else if (kind === 'dir') await rm(path, { recursive: true, force: true });
}

/** Отличаются ли манифесты зависимостей в коммите `sha` от `baseRef`. */
export async function depsChanged(dir: string, baseRef: string, sha: string): Promise<boolean> {
  const diff = await git(dir, ['diff', '--name-only', baseRef, sha, '--', ...DEP_MANIFESTS]);
  // Сравнить не вышло — считаем, что поменялись: лишняя установка дешевле
  // загадочного TS2307 на чужом node_modules.
  return !diff.ok || diff.stdout.trim() !== '';
}

interface LockEntry {
  version?: string;
  link?: boolean;
  resolved?: string;
  optional?: boolean;
  devOptional?: boolean;
}

/**
 * Стоит ли в `node_modules` дерева `dir` то, что требует его package-lock.json
 * (T-346). Симлинк на основную копию сам по себе ничего не гарантирует:
 * основной `node_modules` никто не обновляет после слияний, и ветка, lock не
 * трогавшая, получала зависимости на шаг позади (T-317 завела @xterm, T-318
 * упала в гейте с TS2307).
 *
 * Сверяем по факту, а не по меткам npm: у каждой записи `node_modules/…` из
 * lock-файла читаем package.json установленного пакета и сравниваем версию;
 * у записи-ссылки (`file:`) хватает того, что путь есть. Необязательную
 * запись, которой нет, пропускаем: это пакет под чужую платформу. Lock-файла
 * нет или он не читается — сверять не с чем, считаем, что годится.
 */
export function lockSatisfied(dir: string): boolean {
  let packages: Record<string, LockEntry>;
  try {
    const lock = JSON.parse(readFileSync(resolve(dir, 'package-lock.json'), 'utf8'));
    packages = lock?.packages ?? {};
  } catch {
    return true;
  }
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith('node_modules/')) continue;
    const path = resolve(dir, key);
    if (entry.link) {
      if (!existsSync(path)) return false;
      continue;
    }
    let installed: { version?: string };
    try {
      installed = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8'));
    } catch {
      if (entry.optional || entry.devOptional) continue;
      return false;
    }
    if (entry.version && installed.version !== entry.version) return false;
  }
  return true;
}

/**
 * Подготовить зависимости слитого дерева в копии офиса `worktree`.
 * `changed` — поменялись ли манифесты относительно базы (`depsChanged`).
 */
export async function prepareDeps(
  repoDir: string, worktree: string, changed: boolean, lang: Lang,
): Promise<DepsOutcome> {
  const command = installCommand(worktree);
  const hash = manifestsHash(worktree);
  const marker = resolve(worktree, 'node_modules', DEPS_MARKER);
  // Свой каталог, поставленный под ровно этот lock, годится при любом
  // `changed`: менять его на симлинк незачем, ставить заново — тем более.
  if (nodeModulesKind(worktree) === 'dir' && existsSync(marker)
    && readFileSync(marker, 'utf8').trim() === hash) {
    return { kind: 'cached', command, output: '', durationMs: 0 };
  }

  if (!changed) {
    // Lock как в базе — обычно зависимости основной копии годятся. Если
    // прошлый прогон оставил тут чужой каталог или пустое место после
    // неудачной установки, возвращаем симлинк, как было до него.
    if (nodeModulesKind(worktree) !== 'link') {
      await clearNodeModules(worktree);
      await linkNodeModules(repoDir, worktree);
    }
    // Но верить симлинку вслепую нельзя: основной node_modules мог отстать
    // от базы (T-346). Отстал — ставим своё, как при поменявшемся lock.
    if (lockSatisfied(worktree)) return { kind: 'same', command, output: '', durationMs: 0 };
  }

  await clearNodeModules(worktree);
  const res = await runProjectCheck(worktree, command, lang, { timeoutMs: DEPS_TIMEOUT_MS });
  if (!res.ok) {
    // Недоставленный каталог не оставляем: следующий прогон начнёт с чистого.
    await clearNodeModules(worktree);
    return { kind: 'failed', command, output: res.output, durationMs: res.durationMs };
  }
  // Зависимостей может не быть вовсе — каталога npm тогда не заведёт.
  mkdirSync(resolve(worktree, 'node_modules'), { recursive: true });
  writeFileSync(marker, `${hash}\n`);
  return { kind: 'installed', command, output: res.output, durationMs: res.durationMs };
}

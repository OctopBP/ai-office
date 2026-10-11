/**
 * Выпуски (docs/design/releases/spec.md): офис решает, когда выпускать,
 * готовит выпуск и следит за ним, а собирает тот, кто умеет, — CI проекта
 * или команда на этой машине.
 *
 * Порядок — процесс `workflows/release.json` из обычных узлов; ведёт его
 * тот же раннер (runs.ts). Здесь — действия узлов, поводы по политике цели
 * и то, как выпуск показывается предметом `Release`.
 *
 *   снимок основной ветки → версия → заметки → согласие владельца
 *   → версия в файлах → пуш / тег / сборка → ждём CI
 *   → упало — одна починка задачей от ветки выпуска → заново
 *   → вливаем ветку выпуска обратно в основную, пишем результат
 *
 * Сессии агентов сюда не импортируются: заметки пишет ReleaseAgents, живую
 * реализацию ставит agents.ts, а проверки подменяют её своей. CI — так же:
 * CiClient по умолчанию ходит в GitHub Actions, проверки дают свой.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OFFICE_SENDER } from '../shared/types';
import {
  DEFAULT_TAG, DEFAULT_TIMEOUT_MIN, RELEASE_CHANNELS, STOP_LOG_LINES, allowsManual, channelFrom, defaultChannel, autoLevel, autoReasons, compareVersions, fillVersion, maxLevel,
  nextChannelVersion, nextVersion, parseBuildResult, parseGithubRelease, parseReleaseConfig, parseSemver, parseVersion, releaseActive,
  targetChannels, versionChannel, versionInAnswer, versionLabel,
  type GithubReleaseCheck, type Release, type ReleaseChannel, type ReleaseChannelSpec, type ReleaseChannels, type ReleaseReason,
  type ReleaseSetup, type ReleaseStop, type ReleaseTarget, type VersionLevel, type VersionPoint,
} from '../shared/release';
import { CHECK_NAME_RE, type Run, type Workflow, type WorkflowNode } from '../shared/workflow';
import { taskClosed } from '../shared/types';
import { worktreesRoot, type OfficeState, type Task } from './state';
import { soleZone, zoneRepo } from './subprojects';
import { t, type ServerKey } from './i18n';
import {
  OFFICE_PERSON, baseBranch, commitAll, detachedWorktree, filesOfOfficeCommits, git, isAncestor, isRepo, mergeBranch,
  mergeDown, promoteBranch, pushRef, remoteUrl, revision, syncChannelBranch,
} from './git';
import { integrationDir, runProjectCheck } from './merge';
import { githubToken } from './cloud';
import { maskValues, secretsEnv } from './secrets';
import { githubFor, type GithubRepo } from './github';
import { workflowFor } from './workflows';
import { countWorking } from './busy';
import { gateAnswerYes, tellPm, withMergeLock } from './review';
import { dispatch } from './plan';
import {
  drive, newRun, resumeRun, type Executor, type Halt, type Resolve, type RunHooks, type StepResult,
} from './runs';

const WORKFLOW_ID = 'release';
const HOUR_MS = 60 * 60 * 1000;
/** Паузы перед повтором вставшего выпуска: как у пулл-реквестов, три попытки. */
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** Хвост лога, который уходит в задачу починки и в чат. */
const LOG_TAIL = 4000;

/**
 * Паузы ожидания. Вынесены, чтобы проверки не ждали минутами: CI
 * опрашивается раз в полминуты, задача починки — раз в пять секунд.
 */
export const releaseTiming = {
  ciPollMs: 30_000,
  /** Столько ждём первого прогона CI, прежде чем решить, что CI на коммит нет. */
  ciGraceMs: 3 * 60_000,
  taskPollMs: 5_000,
  /** Релиз на GitHub после CI: как часто смотреть и сколько ждать, пока он станет виден. */
  releasePollMs: 30_000,
  releaseWaitMs: 10 * 60_000,
};

// ------------------------------------------------------------- агенты и CI

export interface NotesInput {
  target: string;
  version: string;
  tasks: Array<{ id: string; title: string; did: string; epic: string | null }>;
  epics: Array<{ id: string; title: string; goal: string }>;
}

export interface ReleaseAgents {
  /** Заметки о выпуске дешёвой моделью. Пусто — офис напишет список сам. */
  notes(state: OfficeState, input: NotesInput): Promise<{ text: string; costUsd: number; error?: string }>;
}

let agents: ReleaseAgents = {
  async notes() { return { text: '', costUsd: 0 }; },
};

export function setReleaseAgents(next: ReleaseAgents): void {
  agents = next;
}

export interface CiRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export interface CiClient {
  /** Прогоны CI по коммиту. null — CI этого репозитория офису не виден. */
  runs(repo: string, sha: string): Promise<{ runs: CiRun[]; error?: string } | null>;
  /** Хвост лога упавших работ прогона. */
  failedLog(repo: string, run: CiRun): Promise<string>;
}

async function ghGet<T>(gh: GithubRepo, path: string): Promise<{ ok: boolean; data: T | null; text: string; error: string }> {
  try {
    const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}${path}`, {
      headers: {
        authorization: `Bearer ${gh.token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'ai-office',
      },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, data: null, text, error: `GitHub ${res.status}` };
    let data: T | null = null;
    try { data = JSON.parse(text) as T; } catch { /* лог — не JSON */ }
    return { ok: true, data, text, error: '' };
  } catch (err) {
    return { ok: false, data: null, text: '', error: (err as Error).message };
  }
}

/** CI по умолчанию: GitHub Actions того же репозитория, тем же токеном, что пулл-реквесты. */
const githubCi: CiClient = {
  async runs(repo, sha) {
    const gh = await githubFor(repo);
    if (!gh) return null;
    const r = await ghGet<{ workflow_runs: Array<{ id: number; name: string; status: string; conclusion: string | null; html_url: string }> }>(
      gh, `/actions/runs?head_sha=${sha}&per_page=50`,
    );
    if (!r.ok || !r.data) return { runs: [], error: r.error || 'GitHub' };
    return {
      runs: r.data.workflow_runs.map((w) => ({
        id: w.id, name: w.name, status: w.status, conclusion: w.conclusion, url: w.html_url,
      })),
    };
  },
  async failedLog(repo, run) {
    const gh = await githubFor(repo);
    if (!gh) return '';
    const jobs = await ghGet<{ jobs: Array<{ id: number; name: string; conclusion: string | null; steps?: Array<{ name: string; conclusion: string | null }> }> }>(
      gh, `/actions/runs/${run.id}/jobs?per_page=50`,
    );
    const failed = (jobs.data?.jobs ?? []).filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out');
    const parts: string[] = [];
    for (const job of failed.slice(0, 2)) {
      const steps = (job.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => s.name).join(', ');
      parts.push(`## ${job.name}${steps ? ` — ${steps}` : ''}`);
      const log = await ghGet<unknown>(gh, `/actions/jobs/${job.id}/logs`);
      if (log.ok) parts.push(log.text.slice(-LOG_TAIL));
    }
    return parts.join('\n');
  },
};

let ci: CiClient = githubCi;

export function setReleaseCi(next: CiClient | null): void {
  ci = next ?? githubCi;
}

export interface ReleaseHost {
  /** Список релизов репозитория как отдал GitHub. null — GitHub офису не виден. */
  releases(repo: string): Promise<{ data: unknown; error?: string } | null>;
}

/** Релизы по умолчанию: GitHub того же репозитория, черновики видны с токеном на запись. */
const githubReleases: ReleaseHost = {
  async releases(repo) {
    const gh = await githubFor(repo);
    if (!gh) return null;
    const r = await ghGet<unknown>(gh, '/releases?per_page=30');
    return r.ok ? { data: r.data } : { data: null, error: r.error || 'GitHub' };
  },
};

let host: ReleaseHost = githubReleases;

export function setReleaseHost(next: ReleaseHost | null): void {
  host = next ?? githubReleases;
}

// --------------------------------------------------------- секреты в логах

/**
 * Лог сборки уходит в промпт починки, в задачу и в чат (§8). Строки, похожие
 * на секреты, закрываются: ключи с известными префиксами, `token=…`,
 * заголовки авторизации, закрытые ключи целиком.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[закрытый ключ скрыт]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '***')
    .replace(/(authorization\s*:\s*(?:bearer|basic|token)?\s*)\S+/gi, '$1***')
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd|pwd)[A-Za-z0-9_]*\s*[=:]\s*)(["']?)[^\s"']{4,}\2/gi, '$1***');
}

/**
 * Переменные офиса (secrets.ts) для команды сборки и команды версии — и
 * больше ни для чего: сессии агентов, проверки гейта и задачи исполнителей
 * их не получают. Значения идут в окружение поверх окружения сервера, а
 * `mask` закрывает их в выводе ещё до обрезки хвоста — вывод потом уходит в
 * выпуск, ленту, задачу починки и клиенту.
 *
 * Связка недоступна — отказ с понятной причиной (в ней только имя
 * переменной, не значение): собирать без ключей, которые владелец завёл,
 * значит упасть позже и непонятнее.
 */
export async function releaseSecrets(state: OfficeState): Promise<
  { ok: true; env: Record<string, string>; mask: (text: string) => string } | { ok: false; error: string }
> {
  try {
    const env = await secretsEnv(state.officeId);
    const values = Object.values(env);
    return { ok: true, env, mask: (text) => scrubSecrets(maskValues(text, values)) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Последние строки вывода: ошибку обычно называют именно они. */
export const logTail = (text: string, lines = STOP_LOG_LINES): string =>
  text.replace(/\s+$/, '').split(/\r?\n/).slice(-lines).join('\n');

// ------------------------------------------------------------------ узлы

interface Ctx {
  state: OfficeState;
  releaseId: string;
  target: ReleaseTarget;
  workflow: Workflow;
  node: WorkflowNode;
  run: Run;
  repo: string;
}

const rel = (ctx: Ctx): Release => ctx.state.releases.get(ctx.releaseId) as Release;
const patch = (ctx: Ctx, p: Partial<Release>): Release => ctx.state.patchRelease(ctx.releaseId, p) as Release;
const say = (ctx: Ctx, key: Parameters<OfficeState['say']>[0], vars?: Parameters<OfficeState['say']>[1]) => ctx.state.say(key, vars);
const fail = (note: string, extra: Partial<StepResult> = {}): StepResult => ({ outcome: 'fail', note, ...extra });

/**
 * Запомнить хвост вывода упавшей команды или CI: если выпуск на этом встанет
 * (сразу или после неудачной починки), менеджер прочитает его в `get_release`.
 * Значения переменных офиса закрываются до обрезки: лог CI приходит сырым.
 * Связка недоступна, а переменные есть — закрыть нечем, и хвост не хранится.
 */
async function keepFailLog(ctx: Ctx, raw: string): Promise<void> {
  const secrets = await releaseSecrets(ctx.state);
  const safe = secrets.ok ? secrets.mask(raw) : ctx.state.secretMetas().length ? '' : scrubSecrets(raw);
  patch(ctx, { failLog: logTail(safe) || null });
}

/** Репозиторий цели по её настройке: свой (`repoDir`), путь внутри проекта (`repo`) или сам проект. */
export const targetRepo = (state: OfficeState, target: ReleaseTarget): string =>
  target.repoDir || (target.repo ? resolve(state.projectDir, target.repo) : state.projectDir);

/**
 * Репозиторий, за которым закреплены все рабочие роли офиса, если он один и
 * это не корень офиса. Роль без зоны, с несколькими зонами или с зоной-папкой
 * работает в корне офиса — тогда общего репозитория нет.
 */
function rolesRepo(state: OfficeState): string | null {
  const subs = state.subprojects();
  const dirs = new Set(state.roles().filter((role) => !role.isManager).map((role) => {
    const zone = soleZone(role, subs);
    return zone ? zoneRepo(zone, state.projectDir) : state.projectDir;
  }));
  const [only] = [...dirs];
  return dirs.size === 1 && only !== state.projectDir ? only : null;
}

/**
 * Откуда выпускать цель — решается один раз, на снимке, и записывается в
 * выпуск (`Release.repoDir`). Путь, названный целью (`repoDir`, `repo`),
 * обязан быть git-репозиторием. Не назван, а корень офиса не git: если все
 * роли закреплены за одним репозиторием — он; иначе выпускать неоткуда, и
 * причина говорит, чем это лечится.
 */
export async function resolveReleaseRepo(
  state: OfficeState, target: ReleaseTarget,
): Promise<{ ok: true; dir: string } | { ok: false; reason: string }> {
  const named = targetRepo(state, target);
  if (await isRepo(named)) return { ok: true, dir: named };
  if (target.repoDir || target.repo) return { ok: false, reason: state.say('rel.noRepo', { dir: named }) };
  const shared = rolesRepo(state);
  if (shared && await isRepo(shared)) return { ok: true, dir: shared };
  return { ok: false, reason: state.say('rel.noTargetRepo', { target: target.id, dir: named }) };
}

/**
 * Папка запуска команд цели в рабочей копии `dir`: `workDir` цели или корень
 * копии. null — такой папки в снимке нет.
 */
function commandDir(dir: string, target: ReleaseTarget): string | null {
  if (!target.workDir) return dir;
  const at = resolve(dir, target.workDir);
  return existsSync(at) && statSync(at).isDirectory() ? at : null;
}

/** Рабочая копия выпуска цели (§7.2): одна на цель, переиспользуется между выпусками. */
export const releaseDir = (state: OfficeState, target: ReleaseTarget): string =>
  resolve(worktreesRoot(state), '_release', target.id);

const point = (r: Release): VersionPoint => ({ version: r.version, build: r.build });
const label = (r: Release): string => versionLabel(point(r)) || r.id;

/** Последний состоявшийся выпуск цели. */
const lastDone = (state: OfficeState, targetId: string, except?: string): Release | null =>
  state.releasesOf(targetId).find((r) => r.status === 'done' && r.id !== except) ?? null;

/** Канал выпуска: записанный, иначе по суффиксу версии, иначе стабильный. */
const releaseChannel = (r: Release): ReleaseChannel => r.channel ?? (r.version ? versionChannel(r.version) : null) ?? 'stable';

/** Последний состоявшийся выпуск канала цели. */
const lastDoneIn = (state: OfficeState, targetId: string, channel: ReleaseChannel, except?: string): Release | null =>
  state.releasesOf(targetId).find((r) => r.status === 'done' && r.id !== except && releaseChannel(r) === channel) ?? null;

/** Строка задачи для заметок и вопроса: что сделано, одной строкой. */
const clip = (s: string, n: number): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

// ------------------------------------------------------------- каналы

/**
 * Каналы выпуска (docs/design/release-channels/spec.md §3): у цели с
 * `channels` выпуск идёт в один канал. Снимок берётся с источника канала,
 * ветка канала обязана быть его предком, а в конце выпуска — после зелёного
 * CI и видимого релиза — её перематывают на вершину выпуска и вливают вниз
 * по цепочке до основной (§3.5).
 */

/** Канал выпуска у цели с каналами; у цели без каналов — null. */
const channelOf = (target: ReleaseTarget, r: Release): ReleaseChannel | null =>
  (target.channels && r.channel && target.channels[r.channel] ? r.channel : null);

const channelSpec = (target: ReleaseTarget, channel: ReleaseChannel): ReleaseChannelSpec =>
  target.channels?.[channel] as ReleaseChannelSpec;

/**
 * Последняя состоявшаяся бета — старшая по версии, а не по времени. Канал
 * определяется тем же `releaseChannel`, что и в `lastDoneIn`.
 */
function lastBeta(state: OfficeState, targetId: string): Release | null {
  let best: Release | null = null;
  for (const r of state.releasesOf(targetId)) {
    if (r.status !== 'done' || releaseChannel(r) !== 'beta' || !r.version || !parseVersion(r.version)) continue;
    if (!best || compareVersions(r.version, best.version as string) > 0) best = r;
  }
  return best;
}

/** Ветка, из которой продвигается канал: основная или ветка другого канала (§3.1). */
function sourceBranch(target: ReleaseTarget, channel: ReleaseChannel, base: string): string {
  const from = channelFrom(target.channels as ReleaseChannels, channel);
  return from === 'main' ? base : channelSpec(target, from).branch;
}

/**
 * Цепочка слияния вниз (§3.5): от ветки канала до основной, по обратному
 * порядку `from` — ['release', 'beta', 'main']. Ветки канала, которой ещё нет
 * (первый выпуск беты не состоялся), в цепочке нет: вливать её некуда.
 */
async function downChain(repo: string, target: ReleaseTarget, channel: ReleaseChannel, base: string): Promise<string[]> {
  const chain = [channelSpec(target, channel).branch];
  let at: ReleaseChannel = channel;
  for (let guard = 0; guard < RELEASE_CHANNELS.length; guard += 1) {
    const next = channelFrom(target.channels as ReleaseChannels, at);
    if (next === 'main') break;
    at = next;
    const branch = channelSpec(target, at).branch;
    if (await revision(repo, `refs/heads/${branch}`)) chain.push(branch);
  }
  chain.push(base);
  return chain;
}

/** Темы коммитов «Выпуск» цели на обоих языках — их строки версии сливаются сами (§3.5). */
const releaseSubjects = (target: ReleaseTarget): string[] =>
  (['ru', 'en'] as const).map((lang) => `${t(lang, 'rel.commit', { target: target.title, version: '' }).trimEnd()} `);

interface ChainResult {
  /** Куда влито (или уже было влито) по цепочке: ['beta', 'main']. */
  reached: string[];
  /** Звенья, где что-то сдвинулось: «release → beta». */
  moved: string[];
  /** Почему цепочка встала; null — дошла до основной. */
  stop: string | null;
}

/**
 * Слить ветку канала вниз по цепочке (§3.5) под замком слияний: перемотка,
 * если принимающая ветка — предок, иначе merge-коммит офиса; конфликт только
 * в строках версии из коммитов «Выпуск» решается в пользу принимающей ветки.
 * Сдвинутые ветки каналов уходят в origin без `+`; основную офис пушит как
 * обычно. Первое неудачное звено останавливает цепочку.
 */
async function mergeChain(ctx: Ctx, channel: ReleaseChannel, base: string): Promise<ChainResult> {
  const { state, repo, target } = ctx;
  const out: ChainResult = { reached: [], moved: [], stop: null };
  if (!(await revision(repo, `refs/heads/${channelSpec(target, channel).branch}`))) return out;
  const chain = await downChain(repo, target, channel, base);
  const subjects = releaseSubjects(target);
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const from = chain[i];
    const into = chain[i + 1];
    const merged = await withMergeLock(repo, () => mergeDown(repo, from, into, integrationDir(state, repo), state.lang(), {
      sign: { author: OFFICE_PERSON, committer: OFFICE_PERSON },
      autoFiles: async (mergeBase) => [...new Set([
        ...await filesOfOfficeCommits(repo, `${mergeBase}..${from}`, subjects),
        ...await filesOfOfficeCommits(repo, `${mergeBase}..${into}`, subjects),
      ])],
    }));
    if (merged.kind === 'conflict' || merged.kind === 'failed') {
      out.stop = say(ctx, 'rel.ch.mergeDownFailed', { from, into, why: clip(merged.message, 300) });
      return out;
    }
    if (merged.kind !== 'nothing') {
      out.moved.push(`${from} → ${into}`);
      if (into !== base && await remoteUrl(repo)) {
        const sha = await revision(repo, `refs/heads/${into}`);
        const pushed = sha ? await pushRef(repo, sha, `refs/heads/${into}`, githubToken(), state.lang()) : null;
        if (!pushed?.ok) {
          out.stop = say(ctx, 'rel.ch.pushDownFailed', { branch: into, why: clip(pushed?.message ?? '', 300) });
          return out;
        }
      }
    }
    out.reached.push(into);
  }
  return out;
}

/**
 * Лечение перед снимком (§3.4): ветка канала, ушедшая вперёд (хотфикс в
 * `release`, коммиты в `beta`, не дошедшие вниз из-за прошлого сбоя),
 * вливается вниз по своей цепочке — от верхнего канала к нижнему, чтобы
 * хотфикс из `release` прошёл через `beta` до основной. Конфликт — стоп с
 * причиной: сводить ветки будет человек или задача.
 */
async function healChannels(ctx: Ctx, base: string): Promise<string | null> {
  const { state, target } = ctx;
  for (const c of targetChannels(target)) {
    const out = await mergeChain(ctx, c, base);
    if (out.moved.length) state.addLog(null, 'system', say(ctx, 'rel.ch.healed', { links: out.moved.join(', ') }));
    if (out.stop) return say(ctx, 'rel.ch.healFailed', { why: out.stop });
  }
  return null;
}

interface ChannelSnapshot {
  sha: string;
  /** Прошлый выпуск этого же канала; null — считать как без каналов. */
  prev: Release | null;
  promote: NonNullable<Release['promote']>;
}

/**
 * Источник выпуска в канал (§3.2 п.1–2, §3.4). Ветки каналов сначала
 * сводятся с origin и, если ушли вперёд, вливаются вниз (`healChannels`). Бета и альфа — вершина основной ветки (или ветки канала,
 * из которого продвигаются); стабильный у цели с бетой — коммит тега
 * последней состоявшейся беты; хотфикс — вершина ветки стабильного. Ветка
 * канала обязана быть предком снимка: иначе в конце её не перемотать, и
 * выпуск встаёт сразу, с причиной, — до сборки, а не после.
 */
async function channelSnapshot(ctx: Ctx, channel: ReleaseChannel, base: string): Promise<StepResult | ChannelSnapshot> {
  const { state, repo, target } = ctx;
  const r = rel(ctx);
  const spec = channelSpec(target, channel);
  for (const c of targetChannels(target)) {
    const branch = channelSpec(target, c).branch;
    const synced = await syncChannelBranch(repo, branch, githubToken(), state.lang());
    if (synced === 'diverged') return fail(say(ctx, 'rel.ch.originDiverged', { branch }), { needsDecision: true });
  }
  const healFailed = await healChannels(ctx, base);
  if (healFailed) return fail(healFailed, { needsDecision: true });
  const beta =channel === 'stable' && !r.hotfix && target.channels?.beta ? lastBeta(state, target.id) : null;
  let from: string;
  let sha: string | null;
  if (channel === 'stable' && r.hotfix) {
    from = spec.branch;
    sha = await revision(repo, `refs/heads/${spec.branch}`);
    if (!sha) return fail(say(ctx, 'rel.ch.noHotfixBranch', { branch: spec.branch }), { needsDecision: true });
  } else if (channel === 'stable' && target.channels?.beta) {
    if (!beta) return fail(say(ctx, 'rel.ch.noBeta', { target: target.title }), { needsDecision: true });
    // Тег беты — то, что проверяли тестеры; запись выпуска — запасной путь,
    // если тег не доехал до этой копии.
    from = fillVersion(target.tag ?? DEFAULT_TAG, point(beta));
    sha = (await revision(repo, `refs/tags/${from}^{commit}`)) ?? (beta.sha || null);
    if (!sha) return fail(say(ctx, 'rel.noBranch', { branch: from }), { needsDecision: true });
  } else {
    from = sourceBranch(target, channel, base);
    sha = await revision(repo, `refs/heads/${from}`);
    if (!sha) return fail(say(ctx, 'rel.noBranch', { branch: from }));
  }

  const tip = await revision(repo, `refs/heads/${spec.branch}`);
  if (tip && tip !== sha && !(await isAncestor(repo, tip, sha))) {
    return channel === 'stable'
      ? fail(say(ctx, 'rel.ch.stableDiverged', { branch: spec.branch, beta: beta?.version ?? from }), { needsDecision: true })
      : fail(say(ctx, 'rel.ch.betaDiverged', { branch: spec.branch, source: from }), { needsDecision: true });
  }
  return { sha, prev: lastDoneIn(state, target.id, channel, r.id), promote: { from, sha, branch: spec.branch } };
}

/**
 * Продвинуть ветку канала на вершину выпуска (§3.2 п.7). Зовётся из
 * `publish` — последнего узла, до которого выпуск доходит только после
 * зелёного CI и видимого релиза (или удачной сборки на машине), так что в
 * ветке канала лежат только выпущенные коммиты. Только перемотка; не вышло —
 * причина, выпуск встаёт с needsDecision.
 */
async function promoteChannel(ctx: Ctx): Promise<string | null> {
  const { state, repo } = ctx;
  const r = rel(ctx);
  if (!r.promote) return null;
  const tip = (await revision(repo, `refs/heads/${r.branch}`)) ?? r.sha;
  const out = await promoteBranch(repo, r.promote.branch, tip, githubToken(), state.lang());
  if (!out.ok) return say(ctx, 'rel.ch.promoteFailed', { branch: r.promote.branch, why: clip(out.message, 300) });
  if (out.kind !== 'same') {
    state.addLog(null, 'system', say(ctx, 'rel.ch.promoted', { branch: r.promote.branch, sha: tip.slice(0, 8) }));
  }
  return null;
}

// ------------------------------------------------- переезд временных веток

/**
 * Временные ветки выпусков переехали из `release/<id>` в `office/rel/<id>`
 * (§5.4): иначе ветку канала `release` не создать — git хранит её файлом, а
 * `release/…` — каталогом. Один раз на офис и репозиторий: влитые в основную
 * удаляются, остальные переименовываются, у выпусков меняется `branch`.
 * Трогаются только ветки выпусков офиса — `release/1.2` человека остаётся.
 */
const migrations = new Map<string, Promise<void>>();

export function migrateReleaseBranches(state: OfficeState, repo: string): Promise<void> {
  const key = `${state.officeId}:${repo}`;
  let done = migrations.get(key);
  if (!done) {
    done = migrateOnce(state, repo).catch((err) => {
      state.addLog(null, 'error', state.say('rel.ch.migrateFailed', { error: (err as Error).message }));
    });
    migrations.set(key, done);
  }
  return done;
}

async function migrateOnce(state: OfficeState, repo: string): Promise<void> {
  if (!(await isRepo(repo))) return;
  const list = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/release/']);
  if (!list.ok || !list.stdout) return;
  const base = await baseBranch(repo);
  const baseSha = base ? await revision(repo, base) : null;
  const targets = new Set(state.releaseTargets().map((x) => x.id));
  for (const old of list.stdout.split('\n').filter(Boolean)) {
    const id = old.slice('release/'.length);
    const ofTarget = /^([a-z0-9][a-z0-9-]*)-\d+$/.exec(id);
    if (!state.releases.has(id) && !(ofTarget && targets.has(ofTarget[1]))) continue;
    const release = state.releases.get(id);
    const sha = await revision(repo, `refs/heads/${old}`);
    // Ветку идущего или вставшего выпуска не удаляем, даже если она «влита»:
    // снимок на вершине основной ветки — тоже её предок.
    const settled = !release || release.status === 'done' || release.status === 'skipped';
    const merged = Boolean(sha && baseSha && settled && (await isAncestor(repo, sha, baseSha)));
    const next = `office/rel/${id}`;
    const out = merged ? await git(repo, ['branch', '-D', old]) : await git(repo, ['branch', '-m', old, next]);
    if (!out.ok) continue;
    if (release?.branch === old) state.patchRelease(id, { branch: merged ? '' : next });
  }
}

/**
 * Снимок (§3): SHA основной ветки, диапазон с прошлого выпуска, задачи и
 * фичи, которые в него вошли, и ветка выпуска на этом коммите. Нового нет —
 * выпуск тихо заканчивается: выпускать то же самое второй раз незачем.
 * У цели с каналами источник, диапазон и продвижение — по каналу
 * (`channelSnapshot`).
 */
const snapshot: Executor<Ctx> = {
  async run(ctx) {
    const { state, target } = ctx;
    // Репозиторий выбирается один раз: у выпуска, который его уже записал
    // (повтор, resume_release), настройка цели заново не читается.
    let repo = rel(ctx).repoDir ?? '';
    if (!repo) {
      const found = await resolveReleaseRepo(state, target);
      if (!found.ok) return fail(found.reason, { needsDecision: true });
      repo = found.dir;
      patch(ctx, { repoDir: repo });
      ctx.repo = repo;
    } else if (!(await isRepo(repo))) {
      return fail(say(ctx, 'rel.noRepo', { dir: repo }), { needsDecision: true });
    }
    const base = await baseBranch(repo);
    const head = base ? await revision(repo, base) : null;
    if (!base || !head) return fail(say(ctx, 'rel.noBase'));
    await migrateReleaseBranches(state, repo);
    const channel = channelOf(target, rel(ctx));
    let sha = head;
    let prev: Release | null;
    let promote: Release['promote'] = null;
    if (channel) {
      const picked = await channelSnapshot(ctx, channel, base);
      if ('outcome' in picked) return picked;
      ({ sha, prev, promote } = picked);
    } else {
      prev = lastDone(state, target.id, ctx.releaseId);
    }
    // Первый выпуск цели, у которой версия живёт в тегах, считается от
    // последнего такого тега: выпуск офиса до настройки был, просто руками.
    const fromSha = prev?.sha || await lastTagSha(repo, target) || null;
    // Пусто — это не только тот же коммит: после выпуска в основной ветке
    // остаётся слияние ветки выпуска, а своих коммитов с ним не приходит.
    const own = fromSha ? await git(repo, ['rev-list', '--no-merges', '--count', `${fromSha}..${sha}`]) : null;
    if (fromSha && (fromSha === sha || await isAncestor(repo, sha, fromSha) || (own?.ok && own.stdout === '0'))) {
      const note = say(ctx, 'rel.nothingNew', { target: target.title, version: prev ? label(prev) : '—' });
      patch(ctx, { status: 'skipped', stage: note, finishedAt: Date.now(), sha, fromSha });
      state.addChat(OFFICE_SENDER, note);
      return { outcome: 'empty', note };
    }
    const range = await git(repo, ['log', '--max-count=5000', '--format=%H%x00%s', fromSha ? `${fromSha}..${sha}` : sha]);
    const commits = new Set<string>();
    const named = new Set<string>();
    for (const line of range.stdout.split('\n').filter(Boolean)) {
      const [hash, subject = ''] = line.split('\0');
      commits.add(hash);
      // Задача узнаётся и по своему слиянию в диапазоне: у задачи, влитой
      // дважды (повтор, перенос между копиями), записано первое слияние, и
      // оно может лежать до прошлого выпуска. Годится squash-коммит «T-5: …»
      // (так вливает офис с T-140) и старые «Merge branch 'task/T-5'» и
      // «Merge pull request #12 from owner/task/T-5».
      for (const m of subject.matchAll(/\btask\/(T-\d+)\b/g)) named.add(m[1]);
      const squashed = /^(T-\d+): /.exec(subject);
      if (squashed) named.add(squashed[1]);
    }
    const tasks = [...state.tasks.values()]
      .filter((t) => t.merged && ((t.mergeCommit && commits.has(t.mergeCommit)) || named.has(t.id)))
      .sort((a, b) => (a.outcome?.at ?? 0) - (b.outcome?.at ?? 0));
    const epicIds = [...new Set(tasks.map((t) => t.epicId).filter((e): e is string => Boolean(e)))];
    const branch = `office/rel/${ctx.releaseId}`;
    const made = await git(repo, ['branch', '-f', branch, sha]);
    if (!made.ok) return fail(say(ctx, 'rel.branchFailed', { branch, error: made.stderr }));
    patch(ctx, {
      sha, fromSha, branch, taskIds: tasks.map((t) => t.id), epicIds, promote,
      stage: say(ctx, 'rel.stage.snapshot', { n: commits.size, tasks: tasks.length }),
    });
    const lines = tasks.map((t) => `- ${t.id} ${clip(t.title, 80)}`);
    return {
      outcome: 'pass',
      artifact: { kind: 'snapshot', ref: sha, text: [say(ctx, 'rel.snapshotHead', { n: commits.size, sha: sha.slice(0, 8) }), ...lines].join('\n') },
    };
  },
};

/**
 * Старший тег цели без пререлиза (docs/design/release-channels/spec.md §4.3):
 * `git tag --sort=-v:refname` ставит `v1.5.0-beta.1` выше `v1.5.0`, а
 * `parseSemver` отрезает пререлиз — так стабильная цель насчитала бы
 * следующую версию от беты. Порядок — полный semver; теги без semver (номер
 * сборки) остаются в порядке git.
 */
async function lastStableTag(repo: string, target: ReleaseTarget): Promise<{ tag: string; point: VersionPoint } | null> {
  const tags = await git(repo, ['tag', '--list', '--sort=-v:refname']);
  const pattern = target.tag ?? DEFAULT_TAG;
  let best: { tag: string; point: VersionPoint } | null = null;
  for (const tag of tags.stdout.split('\n').filter(Boolean)) {
    const point = versionFromTag(tag, pattern);
    if (!point) continue;
    const parsed = parseVersion(point.version);
    if (parsed?.pre.length) continue;
    if (!best) best = { tag, point };
    else if (parsed && parseVersion(best.point.version) && compareVersions(point.version, best.point.version) > 0) best = { tag, point };
  }
  return best;
}

/** Коммит последнего стабильного тега цели — начало диапазона первого выпуска. */
async function lastTagSha(repo: string, target: ReleaseTarget): Promise<string | null> {
  if (target.kind !== 'tag' && target.version.source !== 'tag') return null;
  const found = await lastStableTag(repo, target);
  return found ? revision(repo, `${found.tag}^{commit}`) : null;
}

/** Все известные версии цели: из тегов по её шаблону и из истории выпусков. */
async function knownVersions(ctx: Ctx): Promise<string[]> {
  const { state, target, repo } = ctx;
  const tags = await git(repo, ['tag', '--list']);
  const fromTags = tags.stdout.split('\n').filter(Boolean)
    .map((tag) => versionFromTag(tag, target.tag ?? DEFAULT_TAG)?.version ?? null);
  const fromHistory = state.releasesOf(target.id)
    .filter((x) => x.status === 'done' && x.id !== rel(ctx).id).map((x) => x.version);
  return [...new Set([...fromTags, ...fromHistory].filter((v): v is string => Boolean(v)))];
}

/** Тег по шаблону цели → версия и номер, если тег с этого шаблона. */
function versionFromTag(tag: string, pattern: string): VersionPoint | null {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace('\\{version\\}', '(?<version>[0-9][0-9A-Za-z.+-]*?)')
    .replace('\\{build\\}', '(?<build>\\d+)');
  const m = new RegExp(`^${esc}$`).exec(tag);
  if (!m) return null;
  const build = m.groups?.build ? Number(m.groups.build) : null;
  return { version: m.groups?.version ?? (build === null ? null : String(build)), build };
}

/** Текущая версия цели: из тегов, package.json, команды или истории выпусков (§6.1). */
async function currentVersion(ctx: Ctx): Promise<VersionPoint> {
  const { state, target, repo } = ctx;
  const r = rel(ctx);
  const prev = lastDone(state, target.id, r.id);
  const history: VersionPoint = { version: prev?.version ?? null, build: null };
  // Номер сборки — наибольший из всех попыток цели, а не из последней
  // удачной: номер, уже ушедший в TestFlight, повторять нельзя.
  const builds = state.releasesOf(target.id).map((x) => x.build ?? 0);
  const maxBuild = Math.max(0, ...builds);
  const source = target.version.source ?? (target.kind === 'tag' ? 'tag' : undefined);
  let found: VersionPoint | null = null;
  if (source === 'tag') {
    found = (await lastStableTag(repo, target))?.point ?? null;
  } else if (source === 'package.json') {
    const file = target.workDir ? `${target.workDir.replace(/\\/g, '/').replace(/\/+$/, '')}/package.json` : 'package.json';
    const shown = await git(repo, ['show', `${r.sha}:${file}`]);
    try {
      const v = (JSON.parse(shown.stdout) as { version?: string }).version;
      if (v) found = { version: v, build: null };
    } catch { /* нет package.json — берём историю */ }
  } else if (source === 'command' && target.version.read) {
    const out = await runProjectCheck(commandDir(repo, target) ?? repo, target.version.read, state.lang(), { timeoutMs: 60_000 });
    const line = out.output.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (out.ok && line) found = { version: line, build: /^\d+$/.test(line) ? Number(line) : null };
  }
  const base = found ?? history;
  // Версия из источника могла отстать от истории (тег не запушили) — берём старшую.
  const pick = parseSemver(history.version) && parseSemver(base.version)
    && compareVersions(history.version, base.version) > 0 ? history : base;
  return { version: pick.version, build: Math.max(maxBuild, pick.build ?? 0) };
}

/**
 * Разряд и версия (§6.2). План важнее всего: версия, названная заранее,
 * или разряд плана, или наибольший вклад вошедших фич. Без плана — по
 * составу, и старший разряд так не выбирается никогда.
 */
const version: Executor<Ctx> = {
  async run(ctx) {
    const { state, target } = ctx;
    const r = rel(ctx);
    const spec = target.version;
    const plan = state.openReleasePlan(target.id);
    let level: VersionLevel;
    let levelFrom: Release['levelFrom'];
    if (spec.level === 'plan') {
      const contributions: VersionLevel[] = r.epicIds.map((id) => {
        const epic = state.epics.get(id);
        const mine = !epic?.release?.target || epic.release.target === target.id;
        return (mine && epic?.release?.level) || 'minor';
      });
      if (r.taskIds.some((id) => !state.tasks.get(id)?.epicId)) contributions.push('patch');
      level = plan?.level ?? maxLevel(contributions) ?? 'patch';
      levelFrom = 'plan';
    } else if (spec.level === 'auto') {
      level = autoLevel(r.epicIds.length);
      levelFrom = 'auto';
    } else {
      level = spec.level;
      levelFrom = 'fixed';
    }
    const current = await currentVersion(ctx);
    const next = nextVersion(spec.scheme, current, level, Date.now());
    if (plan?.version && spec.scheme.startsWith('semver')) next.version = plan.version;
    if (r.channel && target.channels) {
      // Цель с каналами (§4.2): версия считается по всем тегам и выпускам цели,
      // у беты и альфы — следующий номер пререлиза (X.Y.Z-beta.N, тег
      // v{version}); стабильный из беты берёт ядро беты, хотфикс — патч.
      const fromBeta = r.channel === 'stable' && !r.hotfix && target.channels.beta
        ? lastBeta(state, target.id)?.version ?? null : null;
      next.version = nextChannelVersion({
        versions: await knownVersions(ctx), channel: r.channel, level, planVersion: plan?.version ?? null,
        hotfix: Boolean(r.hotfix), fromBeta,
      });
    }
    if (target.kind === 'tag') {
      const tag = fillVersion(target.tag ?? DEFAULT_TAG, next);
      if (await revision(ctx.repo, `refs/tags/${tag}`)) {
        return fail(say(ctx, 'rel.tagExists', { tag }), { needsDecision: true });
      }
    }
    patch(ctx, {
      version: next.version, build: next.build, level: spec.scheme === 'none' || spec.scheme === 'build' ? null : level,
      levelFrom, planId: plan?.id ?? null,
    });
    const text = say(ctx, 'rel.versionPicked', {
      version: versionLabel(next) || '—', level, from: say(ctx, `rel.levelFrom.${levelFrom}` as ServerKey),
      current: versionLabel(current) || '—',
    });
    return { outcome: 'pass', artifact: { kind: 'version', text, ref: next.version ?? '' } };
  },
};

/** Заметки о выпуске (§3): дешёвая модель по задачам и запискам; не вышло — список. */
const notes: Executor<Ctx> = {
  async run(ctx) {
    const { state, target } = ctx;
    const r = rel(ctx);
    // Последние полсотни: первый выпуск без истории иначе тащил бы в заметки весь проект.
    const tasks = r.taskIds.map((id) => state.tasks.get(id)).filter((t): t is Task => Boolean(t)).slice(-50);
    const epics = r.epicIds.map((id) => state.epics.get(id)).filter((e) => Boolean(e));
    const plain = [
      ...epics.map((e) => `- ${e!.title}${e!.goal ? ` — ${clip(e!.goal, 120)}` : ''}`),
      ...tasks.filter((t) => !t.epicId).map((t) => `- ${clip(t.title, 120)}`),
    ].join('\n') || say(ctx, 'rel.notesEmpty');
    let text = '';
    if (tasks.length) {
      const out = await agents.notes(state, {
        target: target.title,
        version: label(r),
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, did: clip(t.handoff?.did ?? t.result ?? '', 300), epic: t.epicId })),
        epics: epics.map((e) => ({ id: e!.id, title: e!.title, goal: e!.goal })),
      });
      if (out.error) state.addLog(null, 'error', say(ctx, 'rel.notesFailed', { error: out.error }));
      text = out.text.trim();
      if (out.costUsd) patch(ctx, { costUsd: rel(ctx).costUsd + out.costUsd });
    }
    const final = text || plain;
    patch(ctx, { notes: final });
    return { outcome: 'done', artifact: { kind: 'notes', text: final } };
  },
};

/** Нужен ли вопрос владельцу по политике цели (§5). */
const needsApproval = (target: ReleaseTarget, r: Release): boolean =>
  target.policy.approve === 'always' || (target.policy.approve === 'major' && r.level === 'major');

/**
 * Согласие владельца (§5): вопрос с версией, разрядом, составом и заметками.
 * «Да» — выпускаем; версия в ответе («выпускай 2.0.0») — согласие с этой
 * версией; остальное и снятый вопрос — выпуск пропущен. Молчание — не «да».
 */
const approve: Executor<Ctx> = {
  async run(ctx) {
    const { state, target, run } = ctx;
    const r = rel(ctx);
    if (!needsApproval(target, r)) return { outcome: 'yes', note: say(ctx, 'rel.noApprovalNeeded') };
    let question = run.waitingOn ? state.questions.get(run.waitingOn) ?? null : null;
    if (!question) {
      const yes = say(ctx, 'rel.optYes');
      const no = say(ctx, 'rel.optNo');
      const epics = r.epicIds.map((id) => state.epics.get(id)?.title).filter(Boolean).join(', ');
      // У цели с каналами владелец видит, куда выпуск: «Бета 0.13.0-beta.1».
      const channel = channelOf(target, r);
      const version = channel ? `${say(ctx, `rel.channel.${channel}` as ServerKey)} ${label(r)}` : label(r);
      question = state.addQuestion({
        from: OFFICE_SENDER, taskId: null, kind: 'gate',
        text: say(ctx, 'rel.ask', {
          target: target.title, version,
          level: r.level ? say(ctx, 'rel.askLevel', { level: r.level, from: say(ctx, `rel.levelFrom.${r.levelFrom ?? 'auto'}` as ServerKey) }) : '',
          tasks: r.taskIds.length, epics: epics || '—', notes: clip(r.notes, 1200), yes, no,
        }),
        assumption: say(ctx, 'rel.askAssumption'),
        options: [yes, no],
      });
      state.addChat(OFFICE_SENDER, say(ctx, 'rel.askChat', { target: target.title, version, id: question.id }));
    }
    run.waitingOn = question.id;
    run.status = 'waiting';
    state.saveRun(run);
    patch(ctx, { status: 'waiting', stage: say(ctx, 'rel.stage.waiting', { id: question.id }) });

    const closed = await state.whenQuestionClosed(question.id);
    patch(ctx, { status: 'preparing' });
    const answer = closed?.answeredAt ? closed.answer ?? '' : '';
    const override = versionInAnswer(answer);
    const scheme = target.version.scheme;
    if (override && scheme.startsWith('semver')) {
      patch(ctx, { version: override, levelFrom: 'owner' });
      state.addChat(OFFICE_SENDER, say(ctx, 'rel.approvedAs', { target: target.title, version: label(rel(ctx)) }));
      return { outcome: 'yes', note: answer, artifact: { kind: 'decision', text: answer, ref: 'yes' } };
    }
    // «Выпускай» с кнопки и «ship it» словами — тоже «да», как «согласовано».
    const yes = gateAnswerYes(answer) || /^\s*(выпуска|выкатыва|ship)/iu.test(answer);
    if (closed?.answeredAt && yes) {
      state.addChat(OFFICE_SENDER, say(ctx, 'rel.approved', { target: target.title, version: label(r) }));
      return { outcome: 'yes', note: answer, artifact: { kind: 'decision', text: answer, ref: 'yes' } };
    }
    const note = say(ctx, 'rel.declined', { target: target.title, version: label(r) });
    patch(ctx, { status: 'skipped', stage: note, finishedAt: Date.now() });
    state.addChat(OFFICE_SENDER, note);
    return { outcome: 'no', note: answer, artifact: { kind: 'decision', text: answer, ref: 'no' } };
  },
};

/** Шапка выпуска в CHANGELOG.md: версия, дата, заметки. */
const changelogEntry = (r: Release, now: number): string =>
  `## ${label(r)} — ${new Date(now).toISOString().slice(0, 10)}\n\n${r.notes.trim()}\n\n`;

/**
 * Версия в файлах (§6.3): команда цели в рабочей копии выпуска, запись в
 * CHANGELOG.md, если он есть, и один коммит «Выпуск» в ветку выпуска.
 * Без `bump` у цели узел ничего не делает: версия живёт в теге.
 */
const bump: Executor<Ctx> = {
  async run(ctx) {
    const { state, target, repo } = ctx;
    const r = rel(ctx);
    if (!target.bump) return { outcome: 'pass', note: say(ctx, 'rel.noBump') };
    const dir = releaseDir(state, target);
    const copy = await detachedWorktree(repo, dir, r.branch);
    if (!copy.ok) return fail(say(ctx, 'rel.copyFailed', { error: copy.message }));
    const cwd = commandDir(dir, target);
    if (!cwd) return fail(say(ctx, 'rel.noWorkDir', { dir: target.workDir ?? '', repo }), { needsDecision: true });
    const secrets = await releaseSecrets(state);
    if (!secrets.ok) return fail(say(ctx, 'rel.secretsFailed', { error: secrets.error }), { needsDecision: true });
    patch(ctx, { stage: say(ctx, 'rel.stage.bump', { version: label(r) }) });
    const out = await runProjectCheck(cwd, fillVersion(target.bump, point(r)), state.lang(), {
      timeoutMs: 5 * 60_000, env: secrets.env, mask: secrets.mask,
    });
    if (!out.ok) {
      await keepFailLog(ctx, out.output);
      return fail(say(ctx, 'rel.bumpFailed', { output: out.output }));
    }
    const log = resolve(dir, 'CHANGELOG.md');
    const has = await git(dir, ['ls-files', '--error-unmatch', 'CHANGELOG.md']);
    if (has.ok && r.notes.trim()) {
      const old = readFileSync(log, 'utf8');
      // Заметки встают под заголовком файла, если он есть, иначе — в начало.
      const m = /^# .*\n+/.exec(old);
      const at = m ? m[0].length : 0;
      const head = old.slice(0, at);
      const gap = head && !head.endsWith('\n\n') ? '\n' : '';
      writeFileSync(log, `${head}${gap}${changelogEntry(r, Date.now())}${old.slice(at)}`);
    }
    const committed = await commitAll(dir, say(ctx, 'rel.commit', { target: target.title, version: label(r) }),
      { author: OFFICE_PERSON, committer: OFFICE_PERSON });
    if (committed === 'failed') return fail(say(ctx, 'rel.commitFailed'));
    if (committed === 'committed') {
      const moved = await git(dir, ['update-ref', `refs/heads/${r.branch}`, 'HEAD']);
      if (!moved.ok) return fail(say(ctx, 'rel.branchFailed', { branch: r.branch, error: moved.stderr }));
    }
    return { outcome: 'pass' };
  },
};

/** Развилка по виду цели: решение — поле цели, модель не зовётся. */
const kind: Executor<Ctx> = {
  async run(ctx) {
    return { outcome: ctx.target.kind };
  },
};

/** Вершина ветки выпуска — то, что сейчас выпускаем. Починка её сдвигает. */
async function shipSha(ctx: Ctx): Promise<string | null> {
  const r = rel(ctx);
  const sha = await revision(ctx.repo, `refs/heads/${r.branch}`);
  if (sha && sha !== r.sha) patch(ctx, { sha });
  return sha;
}

/** Пуш в ветку, которую забирает CI (§4, `push`). */
const push: Executor<Ctx> = {
  async run(ctx) {
    const { state, target, repo } = ctx;
    const sha = await shipSha(ctx);
    if (!sha) return fail(say(ctx, 'rel.noBranch', { branch: rel(ctx).branch }));
    patch(ctx, { status: 'building', attempts: rel(ctx).attempts + 1, stage: say(ctx, 'rel.stage.push', { branch: target.branch as string }) });
    const pushed = await pushRef(repo, sha, `refs/heads/${target.branch}`, githubToken(), state.lang());
    if (!pushed.ok) return fail(say(ctx, 'rel.pushFailed', { branch: target.branch as string, error: pushed.message }), { needsDecision: true });
    state.addLog(null, 'system', say(ctx, 'rel.pushed', { target: target.title, branch: target.branch as string, sha: sha.slice(0, 8) }));
    return { outcome: 'pass', artifact: { kind: 'shipped', ref: sha, text: `${target.branch} ← ${sha.slice(0, 8)}` } };
  },
};

/** Тег по шаблону цели и его пуш (§4, `tag`). Нет origin — тег остаётся локальным. */
const tag: Executor<Ctx> = {
  async run(ctx) {
    const { state, target, repo } = ctx;
    const r = rel(ctx);
    const sha = await shipSha(ctx);
    if (!sha) return fail(say(ctx, 'rel.noBranch', { branch: r.branch }));
    const name = fillVersion(target.tag ?? DEFAULT_TAG, point(r));
    const again = r.attempts > 0;
    patch(ctx, { status: 'building', attempts: r.attempts + 1, stage: say(ctx, 'rel.stage.tag', { tag: name }) });
    const made = await git(repo, ['tag', '-a', ...(again ? ['-f'] : []), name, '-m', `${target.title} ${label(r)}\n\n${r.notes}`, sha],
      { GIT_COMMITTER_NAME: OFFICE_PERSON.name, GIT_COMMITTER_EMAIL: OFFICE_PERSON.email });
    if (!made.ok) return fail(say(ctx, 'rel.tagFailed', { tag: name, error: made.stderr }), { needsDecision: true });
    const links = [...r.links];
    if (await remoteUrl(repo)) {
      const pushed = await pushRef(repo, `refs/tags/${name}`, `refs/tags/${name}`, githubToken(), state.lang(), again);
      if (!pushed.ok) return fail(say(ctx, 'rel.pushFailed', { branch: name, error: pushed.message }), { needsDecision: true });
      const gh = await githubFor(repo);
      if (gh) links.push({ title: name, url: `https://github.com/${gh.owner}/${gh.repo}/releases/tag/${encodeURIComponent(name)}` });
    } else {
      state.addLog(null, 'system', say(ctx, 'rel.tagLocal', { tag: name }));
    }
    patch(ctx, { links: dedupe(links) });
    return { outcome: 'pass', artifact: { kind: 'shipped', ref: sha, text: name } };
  },
};

const dedupe = <T extends { url: string }>(list: T[]): T[] =>
  list.filter((x, i) => list.findIndex((y) => y.url === x.url) === i);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Задача «починить сборку» без ожидания — когда петля починки исчерпана (§14.2). */
function fileFixTask(ctx: Ctx, log: string, waitFor: boolean): Task | null {
  const { state, target } = ctx;
  const r = rel(ctx);
  const roleId = fixRole(state, r);
  if (!roleId) return null;
  const zone = ctx.repo === state.projectDir
    ? null
    : state.subprojects().find((sub) => sub.kind === 'repo' && zoneRepo(sub, state.projectDir) === ctx.repo) ?? null;
  const task = state.createTask({
    title: say(ctx, 'rel.fix.title', { target: target.title, version: label(r) }),
    description: say(ctx, waitFor ? 'rel.fix.desc' : 'rel.fix.descStopped', {
      target: target.title, version: label(r), branch: r.branch, sha: r.sha.slice(0, 8),
      log: log || say(ctx, 'rel.fix.noLog'),
    }),
    criteria: [say(ctx, 'rel.fix.crit1'), say(ctx, 'rel.fix.crit2')],
    roleId, type: 'code', priority: 'high',
    // Ветка выпуска лежит в репозитории выпуска: если это repo-зона, задача
    // обязана стартовать в ней, иначе ветвиться ей не от чего.
    ...(zone ? { subprojectId: zone.id } : {}),
  });
  if (waitFor) state.updateTask(task.id, { forkFrom: r.branch });
  dispatch(state);
  return task;
}

/**
 * Кто чинит: роль с `code.write`, лучше та, чья задача последней вошла в
 * выпуск, — она ближе всех к упавшему коду.
 */
function fixRole(state: OfficeState, r: Release): string | null {
  const writes = (roleId: string | null | undefined) => Boolean(roleId && state.role(roleId)?.capabilities?.includes('code.write'));
  for (const id of [...r.taskIds].reverse()) {
    const roleId = state.tasks.get(id)?.roleId;
    if (writes(roleId)) return roleId as string;
  }
  return state.workerRoles().find((role) => writes(role.id))?.id ?? null;
}

/** Выход за петлю починки: задача на доске, выпуск стоит и ждёт решения. */
function exhaustedFix(ctx: Ctx, last: StepResult): Halt {
  const task = fileFixTask(ctx, last.artifact?.text ?? '', false);
  const note = say(ctx, 'rel.fixExhausted', { target: ctx.target.title, task: task?.id ?? '—', why: clip(last.note ?? '', 300) });
  return { note, needsDecision: true };
}

/**
 * Ждём CI (§7.1): прогоны по SHA выпуска, опрос раз в полминуты, общий
 * предел — таймаут цели. Прогонов не появилось за три минуты — CI на этот
 * коммит нет, и ждать час нечего (если цель не требует CI).
 */
const watch: Executor<Ctx> = {
  async run(ctx) {
    const { state, target, repo } = ctx;
    const sha = rel(ctx).sha;
    const mode = target.ci ?? 'auto';
    const noCi = (why: string): StepResult => (mode === 'required'
      ? fail(say(ctx, 'rel.ciRequired', { why }), { needsDecision: true })
      : { outcome: 'pass', note: why, artifact: { kind: 'result', text: why } });
    if (mode === 'off') return { outcome: 'pass', note: say(ctx, 'rel.ciOff') };
    const deadline = Date.now() + (target.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60_000;
    const graceUntil = Date.now() + releaseTiming.ciGraceMs;
    patch(ctx, { status: 'building', stage: say(ctx, 'rel.stage.ci') });
    for (;;) {
      await state.whenResumed();
      const got = await ci.runs(repo, sha);
      if (!got) return noCi(say(ctx, 'rel.ciNone'));
      const runs = got.runs;
      if (!runs.length && Date.now() > graceUntil) return noCi(say(ctx, 'rel.ciNotStarted'));
      if (runs.length && runs.every((x) => x.status === 'completed')) {
        const bad = runs.filter((x) => !['success', 'skipped', 'neutral'].includes(x.conclusion ?? ''));
        patch(ctx, { links: dedupe([...rel(ctx).links, ...runs.map((x) => ({ title: x.name, url: x.url }))]) });
        if (!bad.length) {
          patch(ctx, { failLog: null });
          return { outcome: 'pass', artifact: { kind: 'result', text: runs.map((x) => `${x.name}: ${x.conclusion}`).join('\n') } };
        }
        const raw = await ci.failedLog(repo, bad[0]);
        await keepFailLog(ctx, raw);
        const log = scrubSecrets(raw.slice(-LOG_TAIL));
        const note = say(ctx, 'rel.ciFailed', { name: bad.map((x) => x.name).join(', '), url: bad[0].url });
        return fail(note, { artifact: { kind: 'result', text: `${note}\n${log}`, ref: bad[0].url } });
      }
      if (Date.now() > deadline) {
        return fail(say(ctx, 'rel.ciTimeout', { min: target.timeoutMin ?? DEFAULT_TIMEOUT_MIN }), { needsDecision: true });
      }
      patch(ctx, { stage: say(ctx, 'rel.stage.ciRunning', { n: runs.filter((x) => x.status !== 'completed').length }) });
      await sleep(releaseTiming.ciPollMs);
    }
  },
  exhausted: (ctx, last) => exhaustedFix(ctx, last),
};

/** Причина, по которой релиз ещё не виден автообновлению, — для владельца. */
function invisibleWhy(ctx: Ctx, tag: string, got: Exclude<GithubReleaseCheck, { state: 'ok' }> | { state: 'error'; error: string }): string {
  if (got.state === 'missing') return say(ctx, 'rel.visible.missing', { tag });
  if (got.state === 'draft') return say(ctx, 'rel.visible.draft', { tag, url: got.url });
  if (got.state === 'noAssets') return say(ctx, 'rel.visible.noAssets', { tag, files: got.missing.join(', '), url: got.url });
  return say(ctx, 'rel.visible.error', { error: got.error });
}

/**
 * Релиз виден автообновлению (после CI у тега): релиз с тегом выпуска
 * опубликован, а не черновик, и в нём лежат файлы `assets` цели. Нет ни
 * `assets`, ни GitHub — проверять нечего. Не стал виден за
 * `releaseWaitMs` — в чат карточка «выпуск не дошёл», владельцу вопрос:
 * проверить ещё раз (опубликовал черновик руками) или остановить выпуск.
 */
const visible: Executor<Ctx> = {
  async run(ctx) {
    const { state, target, repo, run } = ctx;
    const assets = target.assets ?? [];
    if (target.kind !== 'tag' || !assets.length) return { outcome: 'pass', note: say(ctx, 'rel.visible.skip') };
    const tagName = fillVersion(target.tag ?? DEFAULT_TAG, point(rel(ctx)));
    for (;;) {
      // После перезапуска сервера вопрос уже задан — ждём ответа, не проверяя заново.
      let question = run.waitingOn ? state.questions.get(run.waitingOn) ?? null : null;
      if (!question) {
        patch(ctx, { status: 'building', stage: say(ctx, 'rel.stage.visible', { tag: tagName }) });
        const deadline = Date.now() + releaseTiming.releaseWaitMs;
        let why = '';
        for (;;) {
          await state.whenResumed();
          const got = await host.releases(repo);
          if (!got) return { outcome: 'pass', note: say(ctx, 'rel.visible.noGithub') };
          const seen = got.error ? { state: 'error' as const, error: got.error } : parseGithubRelease(got.data, tagName, assets);
          if (seen.state === 'ok') {
            if (seen.url) patch(ctx, { links: dedupe([...rel(ctx).links, { title: tagName, url: seen.url }]) });
            return { outcome: 'pass', note: say(ctx, 'rel.visible.ok', { tag: tagName }) };
          }
          why = invisibleWhy(ctx, tagName, seen);
          if (Date.now() + releaseTiming.releasePollMs > deadline) break;
          await sleep(releaseTiming.releasePollMs);
        }
        const again = say(ctx, 'rel.visible.optAgain');
        const stop = say(ctx, 'rel.visible.optStop');
        const r = rel(ctx);
        question = state.addQuestion({
          from: OFFICE_SENDER, taskId: null, kind: 'gate',
          text: say(ctx, 'rel.visible.ask', { target: target.title, version: label(r), why, again, stop }),
          assumption: say(ctx, 'rel.visible.assumption'),
          options: [again, stop],
        });
        const card = say(ctx, 'rel.visible.chat', {
          target: target.title, version: label(r), why, min: Math.round(releaseTiming.releaseWaitMs / 60_000), id: question.id,
        });
        state.addChat(OFFICE_SENDER, card);
        tellPm(state, card);
        run.waitingOn = question.id;
        run.status = 'waiting';
        state.saveRun(run);
      }
      patch(ctx, { status: 'waiting', stage: say(ctx, 'rel.stage.visibleAsk', { id: question.id }) });
      const closed = await state.whenQuestionClosed(question.id);
      run.waitingOn = null;
      run.status = 'running';
      state.saveRun(run);
      const answer = closed?.answeredAt ? closed.answer ?? '' : '';
      if (visibleAgain(answer)) continue;
      return fail(say(ctx, 'rel.visible.stopped', { tag: tagName }), { needsDecision: true });
    }
  },
};

/** «Проверить ещё раз» с кнопки или словами — смотрим релиз заново. */
const visibleAgain = (answer: string): boolean =>
  /^\s*(провер|ещё|еще|снова|опубликовал|check|again|retry|published)/iu.test(answer);

/** Локальная сборка на машине одна за раз (§5): Xcode и связка ключей — общие. */
let localBuild: Promise<unknown> = Promise.resolve();
function withLocalBuild<T>(fn: () => Promise<T>): Promise<T> {
  const next = localBuild.then(fn, fn);
  localBuild = next.catch(() => undefined);
  return next;
}

/**
 * Сборка на этой машине (§7.2): команда цели в рабочей копии выпуска с
 * версией, номером и заметками в окружении. Последняя строка
 * `OFFICE_RESULT {…}` говорит, что вышло. Повторная сборка берёт новый
 * номер: прежний мог уже уйти в TestFlight.
 */
const build: Executor<Ctx> = {
  async run(ctx) {
    const { state, target, repo } = ctx;
    const command = state.settings.checks?.[target.run ?? ''];
    if (!command) return fail(say(ctx, 'rel.noCommand', { name: target.run ?? '' }), { needsDecision: true });
    patch(ctx, { stage: say(ctx, 'rel.stage.queued') });
    return withLocalBuild(async () => {
      await state.whenResumed();
      const sha = await shipSha(ctx);
      if (!sha) return fail(say(ctx, 'rel.noBranch', { branch: rel(ctx).branch }));
      const before = rel(ctx);
      const buildNo = before.attempts > 0 && before.build !== null ? before.build + 1 : before.build;
      patch(ctx, { status: 'building', attempts: before.attempts + 1, build: buildNo });
      const r = rel(ctx);
      const dir = releaseDir(state, target);
      const copy = await detachedWorktree(repo, dir, r.branch);
      if (!copy.ok) return fail(say(ctx, 'rel.copyFailed', { error: copy.message }));
      const cwd = commandDir(dir, target);
      if (!cwd) return fail(say(ctx, 'rel.noWorkDir', { dir: target.workDir ?? '', repo }), { needsDecision: true });
      const notesFile = `${dir}.notes.md`;
      writeFileSync(notesFile, r.notes);
      const secrets = await releaseSecrets(state);
      if (!secrets.ok) return fail(say(ctx, 'rel.secretsFailed', { error: secrets.error }), { needsDecision: true });
      const min = target.timeoutMin ?? DEFAULT_TIMEOUT_MIN;
      patch(ctx, { stage: say(ctx, 'rel.stage.build', { version: label(r), min }) });
      const out = await runProjectCheck(cwd, command, state.lang(), {
        timeoutMs: min * 60_000,
        outputLimit: 8000,
        // Вывод замаскирован внутри: и лог провала, и строка OFFICE_RESULT
        // ниже разбираются уже без значений переменных.
        mask: secrets.mask,
        env: {
          ...secrets.env,
          OFFICE_RELEASE_VERSION: r.version ?? '',
          OFFICE_RELEASE_BUILD: r.build === null ? '' : String(r.build),
          OFFICE_RELEASE_SHA: sha,
          OFFICE_RELEASE_NOTES: notesFile,
          OFFICE_RELEASE_TARGET: target.id,
        },
      });
      const result = parseBuildResult(out.output);
      if (!out.ok) {
        const log = out.output.slice(-LOG_TAIL);
        await keepFailLog(ctx, out.output);
        const note = out.timedOut ? say(ctx, 'rel.buildTimeout', { min }) : say(ctx, 'rel.buildFailed', { target: target.title });
        return fail(note, { artifact: { kind: 'result', text: `${note}\n${log}` } });
      }
      const links = result?.url ? dedupe([...r.links, { title: result.title ?? target.title, url: result.url }]) : r.links;
      patch(ctx, { links, build: result?.build ?? rel(ctx).build, failLog: null });
      if (result?.text) state.addLog(null, 'system', `${target.title}: ${result.text}`);
      return { outcome: 'pass', artifact: { kind: 'result', text: result?.text ?? say(ctx, 'rel.built') } };
    });
  },
  exhausted: (ctx, last) => exhaustedFix(ctx, last),
};

/**
 * Починка (§7.3): задача с хвостом лога, от ветки выпуска и в неё же. Она
 * проходит обычный конвейер — ревью, проверки, слияние, — а выпуск ждёт её
 * конца и идёт на отправку заново уже с починкой. Перезапуск сервера
 * находит ту же задачу: второй она не заводится.
 */
const fix: Executor<Ctx> = {
  async run(ctx) {
    const { state, run } = ctx;
    let r = rel(ctx);
    let task = r.fixTaskId ? state.tasks.get(r.fixTaskId) ?? null : null;
    if (!task) {
      const log = Object.values(run.artifacts).find((a) => a.kind === 'result')?.text ?? '';
      task = fileFixTask(ctx, log, true);
      if (!task) return { outcome: 'failed', note: say(ctx, 'rel.noFixer'), needsDecision: true };
      patch(ctx, { fixTaskId: task.id, status: 'building', stage: say(ctx, 'rel.stage.fix', { task: task.id }) });
      state.addChat(OFFICE_SENDER, say(ctx, 'rel.fixStarted', { target: ctx.target.title, task: task.id }));
      r = rel(ctx);
    }
    for (;;) {
      await state.whenResumed();
      const fresh = state.tasks.get(task.id);
      if (!fresh || fresh.status === 'failed' || fresh.status === 'cancelled') {
        patch(ctx, { fixTaskId: null });
        return { outcome: 'failed', note: say(ctx, 'rel.fixFailed', { task: task.id }), needsDecision: true };
      }
      if (fresh.merged) {
        patch(ctx, { fixTaskId: null });
        return { outcome: 'done', note: say(ctx, 'rel.fixMerged', { task: task.id }), actor: fresh.assigneeId ?? undefined };
      }
      // Сдано без ветки или при выключенном конвейере — сливать нечего или
      // сливает человек: выпуск пробует собрать то, что есть в ветке выпуска.
      if (taskClosed(fresh, Boolean(state.settings.autoPipeline)) && !fresh.branch) {
        patch(ctx, { fixTaskId: null });
        return { outcome: 'done', note: say(ctx, 'rel.fixMerged', { task: task.id }) };
      }
      await sleep(releaseTiming.taskPollMs);
    }
  },
};

/**
 * Итог (§3): ветку выпуска с версией и починками — обратно в основную,
 * план выпуска — закрыть, если всё его вошло, в чат — одно сообщение со
 * ссылками. Слияние обратно не удалось — выпуск всё равно состоялся, об
 * этом говорим менеджеру, а ветку выпуска оставляем.
 */
const publish: Executor<Ctx> = {
  async run(ctx) {
    const { state, target, repo } = ctx;
    const r = rel(ctx);
    // Ветка канала двигается первой: если перемотка не прошла, выпуск
    // встаёт, а временная ветка остаётся — повтор начнёт отсюда же.
    const stop = await promoteChannel(ctx);
    if (stop) {
      // Менеджеру причину скажет остановка выпуска (`markStopped`).
      state.addLog(null, 'error', stop);
      return fail(stop, { needsDecision: true });
    }
    const base = await baseBranch(repo);
    let mergedBack = true;
    const channel = channelOf(target, r);
    if (channel && base) {
      // Цель с каналами (§3.5): ветка канала, уже перемотанная на вершину
      // выпуска, вливается вниз до основной. Не вышло — выпуск всё равно
      // состоялся; следующий начнёт с лечения (§3.4).
      const out = await mergeChain(ctx, channel, base);
      patch(ctx, { mergedDown: out.reached });
      if (out.stop) {
        state.addLog(null, 'error', out.stop);
        tellPm(state, out.stop);
      }
    } else if (base) {
      const out = await withMergeLock(repo, () => mergeBranch(
        repo, r.branch, base, integrationDir(state, repo), state.lang(), undefined,
        { author: OFFICE_PERSON, committer: OFFICE_PERSON },
      ));
      if (!out.ok) {
        mergedBack = false;
        const text = say(ctx, 'rel.mergeBackFailed', { branch: r.branch, base, error: clip(out.message, 300) });
        state.addLog(null, 'error', text);
        tellPm(state, text);
      }
    }
    if (mergedBack) await git(repo, ['branch', '-D', r.branch]);

    const plan = r.planId ? state.releasePlans.get(r.planId) : state.openReleasePlan(target.id);
    if (plan && plan.status === 'open') {
      const all = plan.epicIds.every((id) => state.epics.get(id)?.status === 'done' && r.epicIds.includes(id));
      if (all) state.saveReleasePlan({ ...plan, status: 'closed', closedAt: Date.now(), releaseId: r.id });
      else state.addChat(OFFICE_SENDER, say(ctx, 'rel.planStillOpen', { plan: plan.title }));
    }
    const done = patch(ctx, {
      status: 'done', finishedAt: Date.now(), needsDecision: false, stop: null, failLog: null,
      stage: say(ctx, 'rel.stage.done'),
      costUsd: rel(ctx).costUsd,
    });
    const links = done.links.map((l) => `${l.title}: ${l.url}`).join('\n');
    const text = say(ctx, 'rel.done', {
      target: target.title, version: label(done), tasks: done.taskIds.length,
      links: links ? `\n${links}` : '',
    });
    state.addChat(OFFICE_SENDER, text);
    tellPm(state, text);
    return { outcome: 'pass' };
  },
};

const OFFICE: Record<string, Executor<Ctx>> = {
  'office:release-snapshot': snapshot,
  'office:release-version': version,
  'office:release-notes': notes,
  'office:release-approve': approve,
  'office:release-bump': bump,
  'office:release-kind': kind,
  'office:release-push': push,
  'office:release-tag': tag,
  'office:ci-watch': watch,
  'office:release-visible': visible,
  'office:release-build': build,
  'office:fix-build': fix,
  'office:release-publish': publish,
};

const resolveExecutor: Resolve<Ctx> = (node) => (node.run ? OFFICE[node.run] : undefined);

// -------------------------------------------------------------- прогоны

/** Идущие выпуски: ключ «офис:выпуск». */
const running = new Map<string, Promise<void>>();

export const isReleaseRunning = (state: OfficeState, releaseId: string): boolean =>
  running.has(`${state.officeId}:${releaseId}`);

/**
 * Сколько выпусков в офисе работает прямо сейчас — для признака занятости
 * (busy.ts). Выпуск, ждущий «Выпускай» или другого ответа владельца, не в счёт.
 */
export const runningReleases = (state: OfficeState): number => {
  const prefix = `${state.officeId}:`;
  return countWorking([...running.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => runOfRelease(state, key.slice(prefix.length))));
};

/** Прогон выпуска. У выпуска он один. */
export const runOfRelease = (state: OfficeState, releaseId: string): Run | null =>
  [...state.runs.values()].find((r) => r.subject.releaseId === releaseId) ?? null;

/** Выпуск цели, который ещё идёт. */
export const activeRelease = (state: OfficeState, targetId: string): Release | null =>
  state.releasesOf(targetId).find((r) => releaseActive(r.status)) ?? null;

export interface StartResult {
  ok: boolean;
  message: string;
  release?: Release;
}

/**
 * Начать выпуск цели. Ручной — только если политика цели его допускает;
 * второй выпуск той же цели, пока идёт первый, не начинается.
 */
export function startRelease(
  state: OfficeState, targetId: string, reason: ReleaseReason, note = '', now = Date.now(),
  opts: { channel?: ReleaseChannel; hotfix?: boolean } = {},
): StartResult {
  const target = state.releaseTarget(targetId);
  if (!target) {
    const known = state.releaseTargets().map((t) => t.id).join(', ');
    return { ok: false, message: known ? state.say('rel.noTarget', { id: targetId, known }) : state.say('rel.noTargets') };
  }
  // Канал по умолчанию — бета, если она у цели есть (стабильный — только явным
  // продвижением беты); канала, которого у цели нет, не бывает.
  const channel = opts.channel ?? defaultChannel(target);
  const channels = targetChannels(target);
  if (channels.length ? !channels.includes(channel) : channel !== 'stable') {
    return {
      ok: false,
      message: channels.length
        ? state.say('rel.noChannel', { target: target.title, channel, known: channels.join(', ') })
        : state.say('rel.noChannels', { target: target.title, channel }),
    };
  }
  if (reason === 'manual' && !allowsManual(target.policy)) {
    return { ok: false, message: state.say('rel.noManual', { target: target.title }) };
  }
  const busy = activeRelease(state, targetId);
  if (busy) return { ok: false, message: state.say('rel.busy', { target: target.title, id: busy.id, stage: busy.stage }) };
  if (!workflowFor(state, WORKFLOW_ID)) return { ok: false, message: state.say('rel.noWorkflow') };
  state.noteReleaseTarget(targetId, now);
  const release: Release = {
    id: state.newReleaseId(targetId),
    targetId, ...(channels.length ? { channel } : {}), ...(opts.hotfix && channel === 'stable' && channels.length ? { hotfix: true } : {}), version: null, build: null, level: null, levelFrom: null,
    sha: '', fromSha: null, branch: '', epicIds: [], taskIds: [], planId: null, notes: '',
    reason, note, status: 'preparing', stage: state.say('rel.stage.start'), links: [],
    fixTaskId: null, attempts: 0, retries: 0, nextTryAt: null, needsDecision: false,
    startedAt: now, finishedAt: null, costUsd: 0,
  };
  state.saveRelease(release);
  state.addChat(OFFICE_SENDER, state.say(reason === 'manual' ? 'rel.started.manual' : 'rel.started.auto', {
    target: target.title, why: state.say(`rel.reason.${reason}` as ServerKey),
  }));
  void driveRelease(state, release.id);
  return {
    ok: true,
    message: state.say('rel.startedOk', { id: release.id, target: target.title })
      + (release.channel ? ` ${state.say('rel.startedChannel', { channel: release.channel })}` : ''),
    release,
  };
}

/** Узлы процесса выпуска, у которых есть название стадии в словаре. */
const NODE_TITLES = new Set([
  'snapshot', 'version', 'notes', 'approve', 'bump', 'ship', 'push', 'tag', 'watch', 'visible', 'build', 'fix', 'publish',
]);

/** Стадия по узлу процесса: «Снимок (snapshot)». Узел не из набора — как есть. */
const stageTitle = (state: OfficeState, node: string): string => {
  if (!node) return state.say('rel.node.none');
  return NODE_TITLES.has(node) ? `${state.say(`rel.node.${node}` as ServerKey)} (${node})` : node;
};

/** Что будет дальше со вставшим выпуском: ждёт решения, повторится сам или попытки вышли. */
function stopNext(state: OfficeState, r: Release, needsDecision: boolean): string {
  if (needsDecision) return state.say('rel.stopDecision', { id: r.id });
  if (state.releasesOf(r.targetId)[0]?.id !== r.id || r.retries >= RETRY_MS.length) return state.say('rel.stopNoRetry', { id: r.id });
  return state.say('rel.stopRetry', { n: r.retries + 1, max: RETRY_MS.length });
}

/**
 * Выпуск встал или упал: причина, стадия и хвост журнала ложатся в сам выпуск,
 * а менеджеру уходит системное сообщение с id и причиной — так же, как о
 * вставшем конвейере ревью. Повтор надзора, вставший на том же узле с той же
 * причиной, менеджеру второй раз не пересказывается: `stop` прошлой остановки
 * остаётся в выпуске до конца выпуска или явного `resume_release`.
 */
function markStopped(state: OfficeState, releaseId: string, node: string, why: Halt): void {
  const before = state.releases.get(releaseId);
  if (!before) return;
  const prev = before.stop ?? null;
  const needsDecision = Boolean(why.needsDecision);
  const r = state.patchRelease(releaseId, {
    status: 'failed', stage: why.note, needsDecision,
    stop: { node, reason: why.note, log: before.failLog ?? '', at: Date.now(), needsDecision },
  }) as Release;
  if (prev && prev.node === node && prev.reason === why.note && prev.needsDecision === needsDecision) return;
  tellPm(state, state.say('rel.stuckPm', {
    id: r.id, target: state.releaseTarget(r.targetId)?.title ?? r.targetId, version: versionLabel(point(r)) || '—',
    stage: stageTitle(state, node), why: why.note, next: stopNext(state, r, needsDecision),
  }));
}

/**
 * Причина остановки вставшего выпуска. У выпусков, вставших до появления
 * `stop`, собирается из того, что есть: фраза стадии и узел прогона.
 */
export function stopOf(state: OfficeState, r: Release): ReleaseStop | null {
  if (r.status !== 'failed') return null;
  if (r.stop) return r.stop;
  const run = runOfRelease(state, r.id);
  return {
    node: run?.nodeId ?? '', reason: r.stage || run?.note || '', log: r.failLog ?? '',
    at: run?.updatedAt ?? r.startedAt, needsDecision: r.needsDecision,
  };
}

/**
 * Провести выпуск от текущего узла до конца. Повторный заход продолжает тот
 * же прогон с узла, где он встал: сделанные шаги — версия, заметки,
 * согласие — не переделываются.
 */
export function driveRelease(state: OfficeState, releaseId: string): Promise<void> {
  const key = `${state.officeId}:${releaseId}`;
  const already = running.get(key);
  if (already) return already;
  const promise = driveOnce(state, releaseId)
    .catch((err) => {
      const text = state.say('rel.crashed', { id: releaseId, error: (err as Error).message });
      state.addLog(null, 'error', text);
      markStopped(state, releaseId, runOfRelease(state, releaseId)?.nodeId ?? '', { note: text });
    })
    .finally(() => running.delete(key));
  running.set(key, promise);
  return promise;
}

async function driveOnce(state: OfficeState, releaseId: string): Promise<void> {
  const release = state.releases.get(releaseId);
  if (!release) return;
  const target = state.releaseTarget(release.targetId);
  if (!target) {
    markStopped(state, releaseId, '', { note: state.say('rel.targetGone', { id: release.targetId }), needsDecision: true });
    return;
  }
  const workflow = workflowFor(state, WORKFLOW_ID);
  if (!workflow) return;
  let run = runOfRelease(state, releaseId);
  if (!run || run.workflowId !== workflow.id) {
    if (run) state.runs.delete(run.id);
    run = newRun(workflow, { releaseId });
  }
  if (run.status === 'done') return;
  resumeRun(run);
  state.saveRun(run);
  state.patchRelease(releaseId, {
    status: release.status === 'waiting' ? 'waiting' : 'preparing', needsDecision: false,
  });
  // Репозиторий — с выпуска: снимок записал его при старте. До снимка (и у
  // выпусков, начатых до появления поля) — по настройке цели.
  const repoOf = (): string => state.releases.get(releaseId)?.repoDir || targetRepo(state, target);
  const current = run;
  const fixCost = () => {
    const id = state.releases.get(releaseId)?.fixTaskId;
    return id ? state.tasks.get(id)?.usage.costUsd ?? 0 : 0;
  };
  const hooks: RunHooks<Ctx> = {
    context: (node) => ({ state, releaseId, target, workflow, node, run: current, repo: repoOf() }),
    stuck: (ctx, why) => {
      const r = rel(ctx);
      if (r.status === 'skipped') return;
      markStopped(state, releaseId, ctx.node.id, why);
      state.addChat(OFFICE_SENDER, state.say('rel.stuck', { target: target.title, version: label(r), why: why.note }));
    },
    // Выпуск тратит на заметки (менеджер) и на починку (задача): рост их расхода и есть цена узла.
    cost: () => (state.instances.get('pm#1')?.usage.costUsd ?? 0) + fixCost(),
  };
  await drive(state, workflow, run, resolveExecutor, hooks);
  // Выпуск без итога (снимок пуст, владелец отказал) закрыт раньше; здесь —
  // только то, что прогон мог оставить висеть.
  const after = state.releases.get(releaseId);
  if (after && (run.status as Run['status']) === 'done' && releaseActive(after.status)) {
    state.patchRelease(releaseId, { status: 'skipped', finishedAt: Date.now() });
  }
}

/**
 * Снова пустить вставший выпуск (кнопка, `resume_release`). Ждал решения —
 * с начала: код, скорее всего, поменялся, и снимок устарел (§9.2). Иначе —
 * с того узла, где встал.
 */
export function resumeRelease(state: OfficeState, releaseId: string): StartResult {
  const release = state.releases.get(releaseId);
  if (!release) return { ok: false, message: state.say('rel.noRelease', { id: releaseId }) };
  if (release.status === 'done' || release.status === 'skipped') {
    return { ok: false, message: state.say('rel.notResumable', { id: releaseId }) };
  }
  if (isReleaseRunning(state, releaseId)) return { ok: false, message: state.say('rel.alreadyRunning', { id: releaseId }) };
  const other = activeRelease(state, release.targetId);
  if (other && other.id !== releaseId) return { ok: false, message: state.say('rel.busy', { target: release.targetId, id: other.id, stage: other.stage }) };
  const run = runOfRelease(state, releaseId);
  if (run && release.needsDecision) {
    const workflow = workflowFor(state, WORKFLOW_ID);
    if (workflow) {
      run.nodeId = workflow.nodes[0].id;
      run.from = null;
      run.loops = {};
      run.waitingOn = null;
    }
  }
  // Причина прошлой остановки снимается: встанет снова — менеджер узнает об этом заново.
  state.patchRelease(releaseId, {
    retries: 0, nextTryAt: null, needsDecision: false, stop: null, fixTaskId: release.needsDecision ? null : release.fixTaskId,
  });
  void driveRelease(state, releaseId);
  return { ok: true, message: state.say('rel.resumed', { id: releaseId }) };
}

// ---------------------------------------------------------------- поводы

/**
 * Какой цели пора выпускаться по её политике (§5). null — никакой.
 * Поводы считаются от последнего выпуска цели, а у новой цели — от момента,
 * когда офис о ней узнал: фичи, закрытые до настройки, выпуск не будят.
 */
export function dueRelease(state: OfficeState, now = Date.now()): { target: ReleaseTarget; reason: ReleaseReason } | null {
  if (state.paused || state.archived) return null;
  // Режим инициативы «выключено» гасит автоматические поводы у всех целей.
  if (state.initiativeMode() === 'off') return null;
  for (const target of state.releaseTargets()) {
    const since = state.noteReleaseTarget(target.id, now);
    const reasons = autoReasons(target.policy);
    if (!reasons.length || activeRelease(state, target.id)) continue;
    const history = state.releasesOf(target.id);
    const cursor = Math.max(since, history[0]?.startedAt ?? 0);
    const lastAuto = history.find((r) => r.reason !== 'manual');
    const cooldown = (target.policy.cooldownHours ?? 0) * HOUR_MS;
    if (lastAuto && now - lastAuto.startedAt < cooldown) continue;
    const plan = state.openReleasePlan(target.id);
    const planOpen = plan ? plan.epicIds.some((id) => state.epics.get(id)?.status !== 'done') : false;
    for (const reason of reasons) {
      if (reason === 'epic.done') {
        const fresh = state.epicList().filter((e) => e.status === 'done' && (e.finishedAt ?? 0) > cursor
          && (!e.release?.target || e.release.target === target.id)
          && !(planOpen && plan?.epicIds.includes(e.id)));
        if (fresh.length) return { target, reason: 'epic.done' };
      } else {
        const merged = [...state.tasks.values()].filter((t) => t.merged && (t.outcome?.at ?? 0) > cursor).length;
        if (merged >= reason.merged) return { target, reason: 'merged' };
      }
    }
  }
  return null;
}

/**
 * Проход надзора: выпуски, ждавшие согласия в момент перезапуска, — снова к
 * вопросу; вставшие без решения — повтор с паузами; и не больше одного
 * нового выпуска по поводу за проход.
 */
export function tickReleases(state: OfficeState, now = Date.now()): void {
  settleReleaseSetups(state);
  if (!state.releaseTargets().length && !state.releases.size) return;
  for (const release of state.releaseList()) {
    if (isReleaseRunning(state, release.id)) continue;
    const latest = state.releasesOf(release.targetId)[0];
    if (release.status === 'waiting') {
      state.addLog(null, 'system', state.say('rel.resumeWaiting', { id: release.id }));
      void driveRelease(state, release.id);
      continue;
    }
    // Повторяем только последний выпуск цели: старый вставший после нового
    // уже ничего не выпустит.
    if (release.status !== 'failed' || release.needsDecision || latest?.id !== release.id) continue;
    if (!runOfRelease(state, release.id)) continue;
    if (release.retries >= RETRY_MS.length) continue;
    if (release.nextTryAt && now < release.nextTryAt) continue;
    if (!release.nextTryAt) {
      state.patchRelease(release.id, { nextTryAt: now + RETRY_MS[release.retries] });
      continue;
    }
    state.patchRelease(release.id, { retries: release.retries + 1, nextTryAt: null });
    state.addLog(null, 'system', state.say('rel.retry', { id: release.id, n: release.retries + 1, max: RETRY_MS.length }));
    void driveRelease(state, release.id);
  }
  const due = dueRelease(state, now);
  if (due) startRelease(state, due.target.id, due.reason, '', now);
}

/** Дождаться идущих выпусков — проверкам и остановке сервера. */
export async function whenReleasesIdle(state: OfficeState): Promise<void> {
  for (let guard = 0; guard < 50; guard += 1) {
    const list = [...running.entries()].filter(([key]) => key.startsWith(`${state.officeId}:`)).map(([, p]) => p);
    if (!list.length) return;
    await Promise.all(list);
  }
}

// ----------------------------------------------------------------- планы

export interface PlanInput {
  id?: string;
  targetId: string;
  title: string;
  version: string | null;
  level: VersionLevel | null;
  epicIds: string[];
}

/** Завести или поправить план выпуска (§6.2). У цели открытый план один. */
export function saveReleasePlan(state: OfficeState, input: PlanInput): { ok: boolean; message: string } {
  const target = state.releaseTarget(input.targetId);
  if (!target) return { ok: false, message: state.say('rel.noTarget', { id: input.targetId, known: state.releaseTargets().map((t) => t.id).join(', ') }) };
  const unknown = input.epicIds.filter((id) => !state.epics.has(id));
  if (unknown.length) return { ok: false, message: state.say('rel.planBadEpics', { ids: unknown.join(', ') }) };
  if (input.version && !parseSemver(input.version)) return { ok: false, message: state.say('rel.planBadVersion', { version: input.version }) };
  const existing = input.id ? state.releasePlans.get(input.id) : state.openReleasePlan(input.targetId);
  if (input.id && !existing) return { ok: false, message: state.say('rel.noPlan', { id: input.id }) };
  const plan = {
    id: existing?.id ?? state.newReleasePlanId(),
    targetId: input.targetId,
    title: input.title.trim() || input.version || target.title,
    version: input.version?.trim() || null,
    level: input.level,
    epicIds: [...new Set(input.epicIds)],
    status: 'open' as const,
    createdAt: existing?.createdAt ?? Date.now(),
    closedAt: null,
    releaseId: null,
  };
  state.saveReleasePlan(plan);
  // Фичи плана получают цель и разряд, если своего у них ещё нет: так план и
  // карточка фичи говорят одно и то же.
  for (const id of plan.epicIds) {
    const epic = state.epics.get(id);
    if (epic && !epic.release) state.updateEpic(id, { release: { target: plan.targetId, level: plan.level } });
  }
  return { ok: true, message: state.say('rel.planSaved', { id: plan.id, title: plan.title, n: plan.epicIds.length }) };
}

export function closeReleasePlan(state: OfficeState, id: string): { ok: boolean; message: string } {
  const plan = state.releasePlans.get(id);
  if (!plan) return { ok: false, message: state.say('rel.noPlan', { id }) };
  state.saveReleasePlan({ ...plan, status: 'closed', closedAt: Date.now() });
  return { ok: true, message: state.say('rel.planClosed', { id, title: plan.title }) };
}

/** Выпуски текстом для менеджера: цели, что накопилось, что идёт. */
export function releaseStatusText(state: OfficeState): string {
  const targets = state.releaseTargets();
  const rows = targets.length ? targetRows(state, targets) : state.say('rel.noTargets');
  // Вставший выпуск цели, которой уже нет в настройках, под целью не показать.
  const known = new Set(targets.map((x) => x.id));
  const orphans = state.releaseList().reverse().filter((r) => r.status === 'failed' && !known.has(r.targetId)).slice(0, STOPPED_SHOWN);
  const lost = orphans.length
    ? `\n${state.say('rel.statusOrphans')}\n${orphans.map((r) => `    ${stoppedRow(state, r)}`).join('\n')}`
    : '';
  return `${rows}${lost}\n${secretNamesLine(state)}`;
}

/** Сколько вставших выпусков показывать под целью. */
const STOPPED_SHOWN = 3;

const stamp = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Вставшие выпуски цели, свежие первыми: всё, что встало после последнего
 * состоявшегося. Старые провалы, после которых цель уже выпустилась, менеджеру
 * не нужны — их видно по id через `get_release`.
 */
function stoppedReleases(state: OfficeState, targetId: string): Release[] {
  const out: Release[] = [];
  for (const r of state.releasesOf(targetId)) {
    if (r.status === 'done') break;
    if (r.status === 'failed') out.push(r);
  }
  return out.slice(0, STOPPED_SHOWN);
}

function stoppedRow(state: OfficeState, r: Release): string {
  const stop = stopOf(state, r) as ReleaseStop;
  return state.say('rel.statusStopped', {
    id: r.id, when: stamp(stop.at), stage: stageTitle(state, stop.node), why: clip(stop.reason, 400) || '—',
    next: stopNext(state, r, stop.needsDecision),
  });
}

/**
 * Один выпуск целиком — для `get_release`: цель, версия, канал, пройденные
 * стадии с исходом, а у вставшего — причина остановки и хвост журнала.
 */
export function releaseText(state: OfficeState, releaseId: string): { ok: boolean; message: string } {
  const r = state.releases.get(releaseId);
  if (!r) {
    const known = state.releaseList().slice(-10).map((x) => x.id).join(', ');
    return { ok: false, message: `${state.say('rel.noRelease', { id: releaseId })}${known ? ` ${state.say('rel.get.known', { ids: known })}` : ''}` };
  }
  const target = state.releaseTarget(r.targetId);
  const run = runOfRelease(state, r.id);
  const channel = r.channel ? `${state.say(`rel.channel.${r.channel}` as ServerKey)} (${r.channel})` : state.say('rel.get.noChannel');
  const lines = [
    state.say('rel.get.head', {
      id: r.id, target: r.targetId, title: target?.title ?? state.say('rel.get.targetGone'), kind: target?.kind ?? '—',
    }),
    state.say('rel.get.state', { status: r.status, stage: r.stage || '—' }),
    state.say('rel.get.version', {
      version: versionLabel(point(r)) || '—', level: r.level ?? '—', channel,
    }),
    state.say('rel.get.started', {
      started: stamp(r.startedAt), finished: r.finishedAt ? stamp(r.finishedAt) : '—',
      why: state.say(`rel.reason.${r.reason}` as ServerKey), note: r.note ? ` — ${clip(r.note, 200)}` : '',
    }),
    state.say('rel.get.content', {
      branch: r.branch || '—', sha: r.sha ? r.sha.slice(0, 8) : '—', tasks: r.taskIds.length,
      epics: r.epicIds.join(', ') || '—', attempts: r.attempts,
    }),
  ];
  if (r.repoDir) lines.push(state.say('rel.get.repo', { dir: r.repoDir, work: target?.workDir || '.' }));
  const steps = run?.steps ?? [];
  lines.push(state.say('rel.get.steps'));
  if (!steps.length) lines.push(`  ${state.say('rel.get.noSteps')}`);
  steps.forEach((step, i) => {
    lines.push(`  ${state.say('rel.get.step', { n: i + 1, stage: stageTitle(state, step.node), outcome: step.outcome, sec: (step.ms / 1000).toFixed(1) })}`);
  });
  if (r.fixTaskId) lines.push(state.say('rel.get.fixTask', { task: r.fixTaskId }));
  const stop = stopOf(state, r);
  if (stop) {
    lines.push(state.say('rel.get.stop', { stage: stageTitle(state, stop.node), when: stamp(stop.at), why: stop.reason || '—' }));
    lines.push(stopNext(state, r, stop.needsDecision));
    lines.push(stop.log
      ? `${state.say('rel.get.log', { n: stop.log.split('\n').length })}\n${stop.log}`
      : state.say('rel.get.noLog'));
  }
  if (r.links.length) lines.push(`${state.say('rel.get.links')}\n${r.links.map((l) => `  ${l.title}: ${l.url}`).join('\n')}`);
  return { ok: true, message: lines.join('\n') };
}

/**
 * Какие переменные офиса придут в окружение сборки — ТОЛЬКО имена: по ним
 * менеджер говорит инженеру, что читать в Fastfile. Значений тут нет и быть
 * не может — берутся метаданные состояния, связка ключей не трогается.
 */
function secretNamesLine(state: OfficeState): string {
  const names = state.secretMetas().map((m) => m.name);
  return names.length
    ? state.say('rel.statusSecrets', { names: names.join(', '), first: names[0] })
    : state.say('rel.statusNoSecrets');
}

function targetRows(state: OfficeState, targets: ReleaseTarget[]): string {
  return targets.map((target) => {
    const last = lastDone(state, target.id);
    const active = activeRelease(state, target.id);
    const since = last?.startedAt ?? state.releaseSince[target.id] ?? 0;
    const merged = [...state.tasks.values()].filter((t) => t.merged && (t.outcome?.at ?? 0) > since).length;
    const plan = state.openReleasePlan(target.id);
    return [
      state.say('rel.statusRow', {
        id: target.id, title: target.title, kind: target.kind,
        last: last ? `${label(last)} (${new Date(last.startedAt).toISOString().slice(0, 10)})` : '—',
        merged,
      }),
      describeTarget(state, target, null).split('\n').slice(1).map((l) => `    ${l}`).join('\n'),
      ...targetChannels(target).map((c) => {
        const done = lastDoneIn(state, target.id, c);
        return `    ${state.say('rel.statusChannel', {
          channel: state.say(`rel.channel.${c}` as ServerKey), id: c,
          last: done ? `${label(done)} (${new Date(done.startedAt).toISOString().slice(0, 10)})` : '—',
        })}`;
      }),
      active ?`    ${state.say('rel.statusActive', { id: active.id, stage: active.stage })}` : '',
      ...stoppedReleases(state, target.id).map((r) => `    ${stoppedRow(state, r)}`),
      plan ? `    ${state.say('rel.statusPlan', { id: plan.id, title: plan.title, epics: plan.epicIds.join(', ') })}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n');
}

// ------------------------------------------------- цели по описанию менеджера

export interface SetupInput {
  target: ReleaseTarget;
  /** Команда сборки: ложится в проверки проекта под этим именем. */
  check?: { name: string; command: string } | null;
  /** Задача, после слияния которой цель можно применять. */
  waitTaskId?: string | null;
  note?: string;
}

/** «Применить» с кнопки и «apply» словами — тоже «да», как «согласовано». */
const setupYes = (answer: string): boolean => gateAnswerYes(answer) || /^\s*(примен|apply)/iu.test(answer);

/** Цель словами — для вопроса владельцу: что, куда, когда, с чьего согласия. */
export function describeTarget(state: OfficeState, target: ReleaseTarget, command: string | null): string {
  const say = state.say.bind(state);
  const how = target.kind === 'push'
    ? say('rel.setup.kind.push', { branch: target.branch ?? '' })
    : target.kind === 'tag'
      ? say('rel.setup.kind.tag', { tag: target.tag ?? DEFAULT_TAG })
      : say('rel.setup.kind.command', { command: command ?? state.settings.checks?.[target.run ?? ''] ?? target.run ?? '' });
  const when = target.policy.when.map((w) => (typeof w === 'string'
    ? say(w === 'manual' ? 'rel.setup.when.manual' : 'rel.setup.when.epic')
    : say('rel.setup.when.merged', { n: w.merged }))).join(', ');
  return [
    `«${target.title}» (${target.id}): ${how}`,
    say('rel.setup.whenLine', { when, approve: say(`rel.setup.approve.${target.policy.approve}` as ServerKey) }),
    target.version.scheme === 'none'
      ? say('rel.setup.versionNone')
      : say('rel.setup.versionLine', {
        scheme: say(`rel.setup.scheme.${target.version.scheme === 'semver+build' ? 'semverBuild' : target.version.scheme}` as ServerKey),
        level: say(`rel.setup.level.${target.version.level}` as ServerKey),
      }),
    target.bump ? say('rel.setup.bumpLine', { bump: target.bump }) : '',
    target.repoDir ? say('rel.setup.repoLine', { dir: target.repoDir }) : '',
    target.workDir ? say('rel.setup.workDirLine', { dir: target.workDir }) : '',
    target.assets?.length ? say('rel.setup.assetsLine', { files: target.assets.join(', ') }) : '',
    target.policy.cooldownHours ? say('rel.setup.cooldownLine', { n: target.policy.cooldownHours }) : '',
    ...channelLines(state, target),
  ].filter(Boolean).join('\n');
}

/** Каналы цели строками (§5.5): «Бета: ветка beta, теги v{version}-beta.N, проверка видимости beta-mac.yml». */
function channelLines(state: OfficeState, target: ReleaseTarget): string[] {
  const channels = target.channels;
  if (!channels) return [];
  return targetChannels(target).map((c) => {
    const spec = channels[c] as ReleaseChannelSpec;
    const tag = (target.tag ?? DEFAULT_TAG).replace('{version}', c === 'stable' ? '{version}' : `{version}-${c}.N`);
    return state.say('rel.setup.channelLine', {
      channel: state.say(`rel.channel.${c}` as ServerKey), branch: spec.branch, tag,
      from: channelFromText(state, channels, c),
      files: spec.assets?.length ? state.say('rel.setup.channelFiles', { files: spec.assets.join(', ') }) : '',
    });
  });
}

const channelFromText = (state: OfficeState, channels: ReleaseChannels, c: ReleaseChannel): string => {
  const from = channelFrom(channels, c);
  return state.say(`rel.channel.from.${from}` as ServerKey);
};

/** Ветка канала по умолчанию (§3.1): стабильный — release, остальные — по имени. */
const DEFAULT_CHANNEL_BRANCH: Record<ReleaseChannel, string> = { stable: 'release', beta: 'beta', alpha: 'alpha' };

export type ProposedChannel = ReleaseChannel | { channel: ReleaseChannel; branch?: string; assets?: string[] };

/**
 * Каналы предложенной цели (§5.5). Не переданы — при замене цели остаются
 * прежние; пустой список снимает каналы. Стабильный канал есть всегда.
 * Файлы пререлизного канала, если их не назвали, выводятся из файлов цели по
 * правилу electron-builder: `latest*.yml` → `<канал>*.yml`.
 */
export function proposedChannels(
  state: OfficeState, id: string, kind: ReleaseTarget['kind'], assets: string[], given?: ProposedChannel[],
): { ok: true; channels: ReleaseChannels | null } | { ok: false; message: string } {
  if (!given) return { ok: true, channels: state.releaseTarget(id)?.channels ?? null };
  if (!given.length) return { ok: true, channels: null };
  if (kind !== 'tag') return { ok: false, message: state.say('rel.setup.channelsTagOnly', { kind }) };
  const list = given.map((g) => (typeof g === 'string' ? { channel: g } as Exclude<ProposedChannel, string> : g));
  if (!list.some((g) => g.channel === 'stable')) list.unshift({ channel: 'stable' });
  const out: Partial<Record<ReleaseChannel, ReleaseChannelSpec>> = {};
  for (const c of RELEASE_CHANNELS) {
    const g = list.find((x) => x.channel === c);
    if (!g) continue;
    const files = g.assets?.map((a) => a.trim()).filter(Boolean)
      ?? (c === 'stable' ? [] : assets.filter((a) => /^latest/.test(a)).map((a) => a.replace(/^latest/, c)));
    out[c] = {
      branch: g.branch?.trim() || DEFAULT_CHANNEL_BRANCH[c],
      ...(files.length ? { assets: [...new Set(files)] } : {}),
    };
  }
  return { ok: true, channels: out as ReleaseChannels };
}

/** Настройка выпусков с этой целью и командой — или причина, почему так нельзя. */
function withTarget(
  state: OfficeState, setup: Pick<ReleaseSetup, 'target' | 'check'>,
): { targets: ReleaseTarget[]; checks: Record<string, string> } | { error: string } {
  const checks = { ...(state.settings.checks ?? {}) };
  if (setup.check) checks[setup.check.name] = setup.check.command;
  const targets = [...state.releaseTargets().filter((t) => t.id !== setup.target.id), setup.target];
  try {
    return { targets: parseReleaseConfig({ targets }, checks).targets, checks };
  } catch (err) {
    const e = err as { issues?: Array<{ path: Array<string | number>; message: string }>; message: string };
    return { error: e.issues ? e.issues.map((i) => `${i.path.slice(2).join('.') || 'target'}: ${i.message}`).join('; ') : e.message };
  }
}

/**
 * Файлы релиза для предложенной цели. Разрешены только у тега. Не переданы —
 * при замене цели остаются прежние (иначе повторное предложение молча сняло бы
 * проверку видимости); пустой список снимает проверку явно.
 */
export function proposedAssets(
  state: OfficeState, id: string, kind: ReleaseTarget['kind'], given?: string[],
): { ok: true; assets: string[] } | { ok: false; message: string } {
  const files = given?.map((a) => a.trim()).filter(Boolean);
  if (files?.length && kind !== 'tag') return { ok: false, message: state.say('rel.setup.assetsTagOnly', { kind }) };
  if (kind !== 'tag') return { ok: true, assets: [] };
  return { ok: true, assets: [...new Set(files ?? state.releaseTarget(id)?.assets ?? [])] };
}

/**
 * Репозиторий и рабочая папка предложенной цели. Не переданы — при замене
 * цели остаются прежние (иначе повторное предложение молча вернуло бы выпуск
 * в корень офиса); пустая строка снимает поле явно.
 */
export function proposedDirs(
  state: OfficeState, id: string, given: { repoDir?: string; workDir?: string },
): Pick<ReleaseTarget, 'repoDir' | 'workDir'> {
  const old = state.releaseTarget(id);
  const repoDir = given.repoDir === undefined ? old?.repoDir : given.repoDir.trim();
  const workDir = given.workDir === undefined ? old?.workDir : given.workDir.trim().replace(/^\.[\\/]+|[\\/]+$/g, '');
  return { ...(repoDir ? { repoDir } : {}), ...(workDir && workDir !== '.' ? { workDir } : {}) };
}

/**
 * Менеджер предлагает цель выпуска по описанию владельца (spec §16). Цель
 * проверяется тем же разбором, что форма в панели; прошла — владельцу уходит
 * вопрос с целью словами. Применяется она только после «да» и, если цель
 * ждёт задачу (Fastfile, workflow CI), после её слияния.
 */
export function proposeReleaseTarget(state: OfficeState, input: SetupInput): { ok: boolean; message: string } {
  const target = structuredClone(input.target);
  let check = input.check ?? null;
  if (check) {
    const name = check.name.trim();
    const command = check.command.trim();
    if (!CHECK_NAME_RE.test(name)) return { ok: false, message: state.say('rel.setup.badCheck', { name }) };
    if (!command || command.length > 500) return { ok: false, message: state.say('rel.setup.badCommand') };
    check = { name, command };
    if (target.kind === 'command' && !target.run) target.run = name;
  }
  const waitTaskId = input.waitTaskId?.trim() || null;
  if (waitTaskId && !state.tasks.has(waitTaskId)) return { ok: false, message: state.say('rel.setup.noTask', { task: waitTaskId }) };
  const checked = withTarget(state, { target, check });
  if ('error' in checked) return { ok: false, message: state.say('rel.setup.invalid', { error: checked.error }) };
  const fixed = checked.targets.find((t) => t.id === target.id) as ReleaseTarget;

  // Второе предложение той же цели заменяет первое: владелец отвечает на последнее.
  for (const old of state.releaseSetups.values()) {
    if (old.target.id === fixed.id && (old.status === 'asked' || old.status === 'approved')) {
      state.saveReleaseSetup({ ...old, status: 'dropped', decidedAt: Date.now() });
      const q = state.questions.get(old.id);
      if (q && !q.answeredAt && !q.dismissedAt) state.updateQuestion(q.id, { dismissedAt: Date.now() });
    }
  }
  const replaces = Boolean(state.releaseTarget(fixed.id));
  const yes = state.say('rel.setup.optYes');
  const no = state.say('rel.setup.optNo');
  const question = state.addQuestion({
    from: state.managerId() ?? OFFICE_SENDER, taskId: null, kind: 'gate',
    text: state.say('rel.setup.ask', {
      head: state.say(replaces ? 'rel.setup.headReplace' : 'rel.setup.headNew'),
      target: describeTarget(state, fixed, check?.command ?? null),
      check: check ? state.say('rel.setup.checkLine', { name: check.name, command: check.command }) : '',
      wait: waitTaskId ? state.say('rel.setup.waitLine', { task: waitTaskId }) : '',
      note: input.note?.trim() ? `\n${input.note.trim()}` : '',
      yes, no,
    }).replace(/\n{3,}/g, '\n\n'),
    assumption: state.say('rel.setup.assumption'),
    options: [yes, no],
  });
  state.saveReleaseSetup({
    id: question.id, target: fixed, check, waitTaskId, note: input.note?.trim() ?? '',
    status: 'asked', createdAt: Date.now(), decidedAt: null,
  });
  void state.whenQuestionClosed(question.id).then(() => settleReleaseSetups(state));
  return { ok: true, message: state.say('rel.setup.asked', { id: question.id, target: fixed.title }) };
}

/**
 * Довести предложения целей до итога: ответ «да» — применить (или ждать
 * задачу), «нет» и снятый вопрос — отказ. Зовётся по ответу и из надзора:
 * ответ мог прийти, пока сервер лежал, а задача — слиться позже.
 */
export function settleReleaseSetups(state: OfficeState): void {
  for (const setup of [...state.releaseSetups.values()]) {
    if (setup.status === 'asked') {
      const q = state.questions.get(setup.id);
      if (!q) {
        state.saveReleaseSetup({ ...setup, status: 'dropped', decidedAt: Date.now() });
        continue;
      }
      if (!q.answeredAt && !q.dismissedAt) continue;
      if (!q.answeredAt || !setupYes(q.answer ?? '')) {
        state.saveReleaseSetup({ ...setup, status: 'declined', decidedAt: Date.now() });
        state.addChat(OFFICE_SENDER, state.say('rel.setup.declined', { target: setup.target.title }));
        continue;
      }
      setup.status = 'approved';
      setup.decidedAt = Date.now();
      state.saveReleaseSetup(setup);
      if (setup.waitTaskId && !state.tasks.get(setup.waitTaskId)?.merged) {
        state.addChat(OFFICE_SENDER, state.say('rel.setup.waiting', { target: setup.target.title, task: setup.waitTaskId }));
      }
    }
    if (setup.status !== 'approved') continue;
    if (setup.waitTaskId) {
      const task = state.tasks.get(setup.waitTaskId);
      if (!task || task.status === 'failed' || task.status === 'cancelled') {
        state.saveReleaseSetup({ ...setup, status: 'dropped' });
        const text = state.say('rel.setup.taskGone', { target: setup.target.title, task: setup.waitTaskId });
        state.addChat(OFFICE_SENDER, text);
        tellPm(state, text);
        continue;
      }
      if (!task.merged) continue;
    }
    // Настройка могла поменяться, пока ждали ответа или задачу: проверяем заново.
    const checked = withTarget(state, setup);
    const problem = 'error' in checked
      ? checked.error
      : state.updateSettings({ checks: checked.checks, release: { targets: checked.targets } });
    if (problem) {
      state.saveReleaseSetup({ ...setup, status: 'dropped' });
      const text = state.say('rel.setup.applyFailed', { target: setup.target.title, error: problem });
      state.addChat(OFFICE_SENDER, text);
      tellPm(state, text);
      continue;
    }
    state.saveReleaseSetup({ ...setup, status: 'applied' });
    state.noteReleaseTarget(setup.target.id);
    state.addChat(OFFICE_SENDER, state.say('rel.setup.applied', { target: setup.target.title }));
  }
}

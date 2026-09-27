/**
 * Выпуски (docs/design/releases/spec.md): куда и как офис выпускает проект,
 * когда делает это сам и как считает версию.
 *
 * Здесь — только форма и чистые вычисления: цели выпуска с проверкой, версия
 * по схеме, разряд по плану, строка результата сборки. Ни git, ни состояния
 * офиса: модуль общий, по нему и сервер ведёт выпуск, и интерфейс проверяет
 * настройку до сохранения.
 */
import { z } from 'zod';

/** Как выпускать (§4): пуш в ветку, тег или команда на этой машине. */
export const RELEASE_KINDS = ['push', 'tag', 'command'] as const;
export type ReleaseKind = typeof RELEASE_KINDS[number];

/** Схема версии цели (§6.1). */
export const VERSION_SCHEMES = ['semver', 'semver+build', 'calver', 'build', 'none'] as const;
export type VersionScheme = typeof VERSION_SCHEMES[number];

/** Разряд версии. */
export const VERSION_LEVELS = ['patch', 'minor', 'major'] as const;
export type VersionLevel = typeof VERSION_LEVELS[number];

/** Откуда берётся разряд выпуска (§6.2): план, состав или всегда один. */
export const LEVEL_MODES = ['plan', 'auto', ...VERSION_LEVELS] as const;
export type LevelMode = typeof LEVEL_MODES[number];

/** Повод выпуска (§5). */
export type ReleaseReason = 'manual' | 'epic.done' | 'merged';

const ID_RE = /^[a-z][a-z0-9-]*$/;
/** Имя ветки git без пробелов и управляющих символов; подробности проверит сам git. */
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

const policySchema = z.object({
  /** Поводы: по просьбе, по закрытой фиче, по накоплению слияний. */
  when: z.array(z.union([
    z.literal('manual'),
    z.literal('epic.done'),
    z.object({ merged: z.number().int().min(1).max(1000) }).strict(),
  ])).min(1),
  /** Спрашивать ли владельца перед выпуском. */
  approve: z.enum(['always', 'never', 'major']),
  /** Не чаще, чем раз в N часов, для автоматических поводов. */
  cooldownHours: z.number().min(0).max(24 * 30).optional(),
}).strict();

const versionSchema = z.object({
  scheme: z.enum(VERSION_SCHEMES),
  /** Где лежит текущая версия. Нет — последний выпуск цели, у тега — последний тег. */
  source: z.enum(['tag', 'package.json', 'command']).optional(),
  /** Для source: 'command' — команда, печатающая текущую версию. */
  read: z.string().min(1).max(500).optional(),
  level: z.enum(LEVEL_MODES),
}).strict();

const targetSchema = z.object({
  id: z.string().regex(ID_RE, 'id цели — строчные латинские буквы, цифры и дефис'),
  title: z.string().trim().min(1, 'название цели не заполнено').max(60, 'название цели длиннее 60 знаков'),
  kind: z.enum(RELEASE_KINDS),
  /** push: ветка, которую забирает CI. */
  branch: z.string().regex(BRANCH_RE, 'ветка — латиница, цифры, «.», «_», «/» и «-»').max(200).optional(),
  /** tag: шаблон тега, `{version}` и `{build}` подставляются. По умолчанию `v{version}`. */
  tag: z.string().min(1).max(100).optional(),
  /** command: имя команды из `settings.checks`, которая собирает и грузит. */
  run: z.string().regex(ID_RE, 'выберите команду сборки').optional(),
  /** Сколько ждать сборку или CI, минуты. */
  timeoutMin: z.number().int().min(1, 'ждать сборку — от 1 минуты').max(120, 'ждать сборку — не дольше 120 минут').optional(),
  /** Команда, поднимающая версию в файлах; `{version}` и `{build}` подставляются. */
  bump: z.string().min(1).max(500).optional(),
  /** Нужен ли CI: `auto` — ждём, если он есть; `required` — его отсутствие — ошибка; `off` — не ждём. */
  ci: z.enum(['auto', 'required', 'off']).optional(),
  /** Репозиторий относительно проекта. Нет — сам проект. */
  repo: z.string().min(1).max(300).optional(),
  policy: policySchema,
  version: versionSchema,
}).strict();

const configSchema = z.object({
  targets: z.array(targetSchema).max(20),
}).strict();

export type ReleasePolicy = z.infer<typeof policySchema>;
export type VersionSpec = z.infer<typeof versionSchema>;
export type ReleaseTarget = z.infer<typeof targetSchema>;
export type ReleaseConfig = z.infer<typeof configSchema>;

/** Сколько ждать CI или сборку, если цель не сказала. */
export const DEFAULT_TIMEOUT_MIN = 30;
export const DEFAULT_TAG = 'v{version}';

/**
 * Разобрать настройку выпусков. Как и файл процесса, её пишет человек, и
 * опечатка — ошибка, а не молчаливый отказ: цель без ветки, команда, которой
 * нет в проверках проекта, два одинаковых id.
 */
export function parseReleaseConfig(data: unknown, checks: Record<string, string> = {}): ReleaseConfig {
  const config = configSchema.parse(data);
  const seen = new Set<string>();
  for (const target of config.targets) {
    const where = `цель «${target.id}»`;
    if (seen.has(target.id)) throw new Error(`${where} объявлена дважды`);
    seen.add(target.id);
    if (target.kind === 'push' && !target.branch) throw new Error(`${where}: у пуша нужна ветка branch`);
    if (target.kind === 'command') {
      if (!target.run) throw new Error(`${where}: у сборки командой нужно имя команды run`);
      if (!checks[target.run]) {
        throw new Error(`${where}: команды «${target.run}» нет среди проверок проекта — заведите её в «Процессы → Проверки»`);
      }
    }
    if (target.kind !== 'push' && target.branch) throw new Error(`${where}: ветка branch нужна только пушу`);
    if (target.kind !== 'command' && target.run) throw new Error(`${where}: команда run нужна только сборке командой`);
    if (target.tag && !target.tag.includes('{version}') && !target.tag.includes('{build}')) {
      throw new Error(`${where}: в шаблоне тега нет ни {version}, ни {build} — все выпуски получили бы один тег`);
    }
    if (target.version.source === 'command' && !target.version.read) {
      throw new Error(`${where}: версия читается командой, но команды read нет`);
    }
    if (target.version.scheme === 'none' && target.kind === 'tag') {
      throw new Error(`${where}: тегу нужна версия — схема none не подходит`);
    }
    if (target.repo && (target.repo.startsWith('/') || target.repo.split(/[\\/]/).includes('..'))) {
      throw new Error(`${where}: repo — путь внутри проекта`);
    }
  }
  return config;
}

/** Автоматические поводы цели — всё, кроме просьбы. */
export const autoReasons = (policy: ReleasePolicy): Array<'epic.done' | { merged: number }> =>
  policy.when.filter((w): w is 'epic.done' | { merged: number } => w !== 'manual');

export const allowsManual = (policy: ReleasePolicy): boolean => policy.when.includes('manual');

// ------------------------------------------------------------------ версия

export type Semver = [number, number, number];

/** `1.4.2`, `v1.4.2`, `1.4.2-beta` → [1, 4, 2]. */
export function parseSemver(s: string | null | undefined): Semver | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function bumpSemver(v: Semver, level: VersionLevel): Semver {
  if (level === 'major') return [v[0] + 1, 0, 0];
  if (level === 'minor') return [v[0], v[1] + 1, 0];
  return [v[0], v[1], v[2] + 1];
}

export const semverText = (v: Semver): string => v.join('.');

const LEVEL_RANK: Record<VersionLevel, number> = { patch: 0, minor: 1, major: 2 };

export const maxLevel = (levels: Iterable<VersionLevel>): VersionLevel | null => {
  let best: VersionLevel | null = null;
  for (const l of levels) if (!best || LEVEL_RANK[l] > LEVEL_RANK[best]) best = l;
  return best;
};

/** Дата для calver: `2026.09.27`. */
export const calverDay = (now: number): string => {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
};

export interface VersionPoint {
  version: string | null;
  build: number | null;
}

/**
 * Следующая версия по схеме. `current` — последний выпуск цели (или то, что
 * лежит в теге и package.json); его нет — первый выпуск.
 *
 * - semver — разряд поднимается от текущей; первой нет — `0.1.0`;
 * - semver+build — то же плюс номер сборки, который растёт всегда;
 * - calver — дата, а второй выпуск за день — дата с порядковым номером;
 * - build — только номер;
 * - none — версии нет вовсе.
 */
export function nextVersion(
  scheme: VersionScheme, current: VersionPoint, level: VersionLevel, now: number,
): VersionPoint {
  const build = (current.build ?? 0) + 1;
  if (scheme === 'none') return { version: null, build: null };
  if (scheme === 'build') return { version: String(build), build };
  if (scheme === 'calver') {
    const day = calverDay(now);
    const prev = current.version ?? '';
    if (prev === day || prev.startsWith(`${day}.`)) {
      const n = prev === day ? 1 : Number(prev.slice(day.length + 1)) || 1;
      return { version: `${day}.${n + 1}`, build: null };
    }
    return { version: day, build: null };
  }
  const base = parseSemver(current.version);
  const version = base ? semverText(bumpSemver(base, level)) : '0.1.0';
  return { version, build: scheme === 'semver+build' ? build : null };
}

/** Версия для людей: `1.4.0 (57)`, `2026.09.27`, `#58`. */
export function versionLabel(point: VersionPoint): string {
  if (point.version && point.build !== null && point.build !== undefined && point.version !== String(point.build)) {
    return `${point.version} (${point.build})`;
  }
  if (point.version) return point.version;
  if (point.build !== null && point.build !== undefined) return `#${point.build}`;
  return '';
}

/** Подставить версию и номер в шаблон тега или команды. */
export const fillVersion = (template: string, point: VersionPoint): string =>
  template.split('{version}').join(point.version ?? '').split('{build}').join(point.build === null ? '' : String(point.build));

/**
 * Разряд выпуска без плана (§6.2, `auto`): есть фича — младший разряд,
 * одни задачи вне фич — патч. Старший разряд так не выбирается никогда.
 */
export const autoLevel = (epicCount: number): VersionLevel => (epicCount > 0 ? 'minor' : 'patch');

/** Версия в ответе владельца: «выпускай 2.0.0» — согласие с этой версией. */
export function versionInAnswer(answer: string): string | null {
  const m = /(?:^|[^\d.])(\d+\.\d+\.\d+)(?![\d.])/.exec(answer);
  return m ? m[1] : null;
}

// ---------------------------------------------------------- результат сборки

/**
 * Что команда сборки сообщает офису последней строкой вывода (§7.2):
 * `OFFICE_RESULT {"build":58,"url":"...","text":"сборка 58 в TestFlight"}`.
 * Так Fastfile говорит, что вышло, и офису не надо читать вывод fastlane.
 */
export interface BuildResult {
  build?: number;
  url?: string;
  title?: string;
  text?: string;
}

export function parseBuildResult(output: string): BuildResult | null {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 20; i -= 1) {
    const m = /^OFFICE_RESULT\s+(\{.*\})$/.exec(lines[i]);
    if (!m) continue;
    try {
      const raw = JSON.parse(m[1]) as Record<string, unknown>;
      const out: BuildResult = {};
      if (typeof raw.build === 'number' && Number.isInteger(raw.build) && raw.build > 0) out.build = raw.build;
      if (typeof raw.url === 'string' && /^https?:\/\//.test(raw.url)) out.url = raw.url.slice(0, 500);
      if (typeof raw.title === 'string') out.title = raw.title.slice(0, 80);
      if (typeof raw.text === 'string') out.text = raw.text.slice(0, 500);
      return out;
    } catch {
      return null;
    }
  }
  return null;
}

// ------------------------------------------------------------------ выпуск

export type ReleaseStatus = 'preparing' | 'waiting' | 'building' | 'done' | 'failed' | 'skipped';

/** Выпуск ещё идёт: второй на ту же цель не начинается. */
export const releaseActive = (status: ReleaseStatus): boolean =>
  status === 'preparing' || status === 'waiting' || status === 'building';

export interface ReleaseLink {
  title: string;
  url: string;
}

/** Выпуск как предмет (§9.1): одна попытка выпустить одну цель. */
export interface Release {
  id: string;
  targetId: string;
  version: string | null;
  build: number | null;
  /** Разряд, на который поднята версия, и откуда он. */
  level: VersionLevel | null;
  levelFrom: 'plan' | 'auto' | 'fixed' | 'owner' | null;
  /** Что выпускаем: вершина ветки выпуска. Пусто до снимка. */
  sha: string;
  /** Прошлый выпуск этой цели. null — первый. */
  fromSha: string | null;
  /** Ветка выпуска `release/<id>`: снимок, версия, починки. */
  branch: string;
  epicIds: string[];
  taskIds: string[];
  planId: string | null;
  notes: string;
  reason: ReleaseReason;
  /** Кто попросил и что сказал — для ручного выпуска. */
  note: string;
  status: ReleaseStatus;
  /** Готовая фраза: на чём стоит или почему встал. */
  stage: string;
  links: ReleaseLink[];
  /** Задача «починить сборку», которую ждёт выпуск. */
  fixTaskId: string | null;
  /** Сколько раз уже собирали: номер сборки на повторе растёт. */
  attempts: number;
  retries: number;
  nextTryAt: number | null;
  needsDecision: boolean;
  startedAt: number;
  finishedAt: number | null;
  costUsd: number;
}

/**
 * План выпуска (§6.2): «2.0 = фичи F-4, F-5». Пока план открыт, закрытая
 * фича из него не выпускает цель сама — ждём, пока закроются все.
 */
export interface ReleasePlan {
  id: string;
  targetId: string;
  title: string;
  /** Версия, если её назвали заранее. */
  version: string | null;
  level: VersionLevel | null;
  epicIds: string[];
  status: 'open' | 'closed';
  createdAt: number;
  closedAt: number | null;
  /** Каким выпуском закрыт. */
  releaseId: string | null;
}

/** Вклад фичи в выпуск (§6.2): в какую цель и на какой разряд. */
export interface EpicRelease {
  target: string | null;
  level: VersionLevel | null;
}

/**
 * Предложение цели выпуска от менеджера (spec §16): цель и команда сборки,
 * ждущие «да» владельца. Цель — право офиса выкладывать наружу, поэтому
 * применяет её не менеджер, а ответ на вопрос. Ключ — id вопроса.
 */
export interface ReleaseSetup {
  id: string;
  target: ReleaseTarget;
  /** Команда сборки для `settings.checks`, если цель собирается командой. */
  check: { name: string; command: string } | null;
  /** Задача, после слияния которой цель можно применять (Fastfile, workflow CI). */
  waitTaskId: string | null;
  note: string;
  /** asked — ждём ответа; approved — «да», ждём задачу; дальше — итог. */
  status: 'asked' | 'approved' | 'applied' | 'declined' | 'dropped';
  createdAt: number;
  decidedAt: number | null;
}

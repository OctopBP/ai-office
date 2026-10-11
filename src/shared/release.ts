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

/**
 * Каналы выпуска (docs/design/release-channels/spec.md §3.1): стабильный
 * из ветки `release`, бета и альфа — пререлизы из своих веток.
 */
export const RELEASE_CHANNELS = ['stable', 'beta', 'alpha'] as const;
export type ReleaseChannel = typeof RELEASE_CHANNELS[number];
/** Пререлизные каналы — в порядке «сначала бета» (§5.3: сработали оба — бета первой). */
export const PRERELEASE_CHANNELS = ['beta', 'alpha'] as const;
export type PrereleaseChannel = typeof PRERELEASE_CHANNELS[number];

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

/** Канал цели (§5.1): постоянная ветка, откуда она продвигается, своя политика и файлы. */
const channelSchema = z.object({
  /** Постоянная ветка канала: 'release', 'beta', 'alpha'. */
  branch: z.string().regex(BRANCH_RE, 'ветка — латиница, цифры, «.», «_», «/» и «-»').max(200),
  /** Откуда продвигается: основная ветка или другой канал. Нет — по умолчанию §3.1. */
  from: z.enum(['main', 'alpha', 'beta']).optional(),
  /** Своя политика канала; нет — политика цели. */
  policy: policySchema.optional(),
  /** Файлы релиза для проверки видимости в этом канале (beta-mac.yml, beta.yml). */
  assets: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
}).strict();

const channelsSchema = z.object({
  stable: channelSchema,
  beta: channelSchema.optional(),
  alpha: channelSchema.optional(),
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
  /**
   * tag: файлы, без которых релиз на GitHub не виден автообновлению
   * (у приложения на electron-updater — `latest-mac.yml`). Есть — после CI
   * офис проверяет, что релиз опубликован, а не черновик, и файлы в нём.
   */
  assets: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  /** Репозиторий относительно проекта. Нет — сам проект. */
  repo: z.string().min(1).max(300).optional(),
  policy: policySchema,
  version: versionSchema,
  /**
   * Каналы выпуска (docs/design/release-channels/spec.md §5.1). Нет — цель
   * работает как раньше: снимок основной ветки, тег, слияние обратно.
   */
  channels: channelsSchema.optional(),
}).strict();

const configSchema = z.object({
  targets: z.array(targetSchema).max(20),
}).strict();

export type ReleasePolicy = z.infer<typeof policySchema>;
export type ReleaseChannelSpec = z.infer<typeof channelSchema>;
export type ReleaseChannels = z.infer<typeof channelsSchema>;
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
    if (target.kind !== 'tag' && target.assets?.length) throw new Error(`${where}: файлы релиза assets проверяются только у тега`);
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
    if (target.channels) checkChannels(target, where);
  }
  return config;
}

/** Откуда продвигается канал, если цель не сказала (§3.1, §5.1). */
export function channelFrom(channels: ReleaseChannels, channel: ReleaseChannel): 'main' | 'alpha' | 'beta' {
  const own = channels[channel]?.from;
  if (own) return own;
  if (channel === 'stable') return channels.beta ? 'beta' : 'main';
  return 'main';
}

/** Каналы, объявленные у цели, в порядке stable, beta, alpha. */
export const targetChannels = (target: Pick<ReleaseTarget, 'channels'>): ReleaseChannel[] =>
  (target.channels ? RELEASE_CHANNELS.filter((c) => Boolean(target.channels?.[c])) : []);

/**
 * Канал выпуска, когда его не назвали явно: выпуск по поводу (epic.done,
 * mergedEvery) и ручной без канала. Есть бета — идём в неё: стабильный
 * продвигается только из состоявшейся беты, и без неё сразу встал бы.
 * Нет беты (или каналов вовсе) — стабильный.
 */
export const defaultChannel = (target: Pick<ReleaseTarget, 'channels'>): ReleaseChannel =>
  (target.channels?.beta ? 'beta' : 'stable');

/** Проверки каналов цели (§5.1): вид и схема, ветки, цепочка `from`. */
function checkChannels(target: ReleaseTarget, where: string): void {
  const channels = target.channels as ReleaseChannels;
  if (target.kind !== 'tag') throw new Error(`${where}: каналы выпуска бывают только у тега`);
  if (target.version.scheme !== 'semver') throw new Error(`${where}: каналы выпуска нужны схеме semver — у пререлиза другой схемы нет смысла`);
  if (!(target.tag ?? DEFAULT_TAG).includes('{version}')) throw new Error(`${where}: у цели с каналами в шаблоне тега нужен {version}`);
  if (target.version.source && target.version.source !== 'tag') throw new Error(`${where}: у цели с каналами версия берётся из тегов (source: tag)`);
  const list = targetChannels(target);
  const branches = list.map((c) => (channels[c] as ReleaseChannelSpec).branch);
  for (const [i, branch] of branches.entries()) {
    const name = `канал ${list[i]}`;
    if (['main', 'master'].includes(branch)) throw new Error(`${where}, ${name}: ветка канала не может быть основной`);
    if (branch === 'office' || branch.startsWith('office/')) throw new Error(`${where}, ${name}: ветки office/… — служебные ветки офиса`);
    if (branch.startsWith('/') || branch.endsWith('/') || branch.includes('..') || branch.includes('//')) {
      throw new Error(`${where}, ${name}: «${branch}» — не имя ветки`);
    }
    for (const [j, other] of branches.entries()) {
      if (i === j) continue;
      if (other === branch) throw new Error(`${where}: у каналов ${list[i]} и ${list[j]} одна ветка «${branch}»`);
      // git хранит ветку файлом, а ветки «под» ней — каталогом: вместе нельзя.
      if (other.startsWith(`${branch}/`)) throw new Error(`${where}: ветки «${branch}» и «${other}» не уживутся в одном репозитории`);
    }
  }
  if (target.branch && branches.includes(target.branch)) throw new Error(`${where}: ветка «${target.branch}» уже занята каналом`);
  for (const c of list) {
    const from = channelFrom(channels, c);
    if (from === c) throw new Error(`${where}, канал ${c}: продвигается сам из себя`);
    if (from !== 'main' && !channels[from]) throw new Error(`${where}, канал ${c}: продвигается из канала ${from}, которого у цели нет`);
    if (c === 'alpha' && from !== 'main') throw new Error(`${where}: альфа продвигается только из основной ветки`);
    if (c === 'stable' && from !== (channels.beta ? 'beta' : 'main')) {
      throw new Error(`${where}: стабильный канал продвигается из ${channels.beta ? 'беты' : 'основной ветки'}`);
    }
  }
  // Цепочка до main без циклов: альфа — из main, бета — из main или альфы,
  // стабильный — из беты или main. Цикл при таких правилах невозможен, но
  // проверка дешёвая и страхует от будущих каналов.
  for (const c of list) {
    const seen = new Set<string>([c]);
    let at: string = channelFrom(channels, c);
    while (at !== 'main') {
      if (seen.has(at)) throw new Error(`${where}: каналы продвигаются по кругу`);
      seen.add(at);
      at = channelFrom(channels, at as ReleaseChannel);
    }
  }
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

/**
 * Версия в ответе владельца: «выпускай 2.0.0» — согласие с этой версией.
 * Пререлиз берётся целиком: «1.5.0-beta.2», а не «1.5.0».
 */
export function versionInAnswer(answer: string): string | null {
  const m = /(?:^|[^\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)(?![\d.])/.exec(answer);
  return m ? m[1] : null;
}

// --------------------------------------------- полный semver и каналы

/**
 * Полная версия semver 2.0 (docs/design/release-channels/spec.md §4):
 * `1.5.0-beta.2` → ядро [1, 5, 0] и пререлиз ['beta', '2']. Метаданные
 * сборки (`+…`) отбрасываются — в порядке они не участвуют.
 */
export interface ParsedVersion {
  core: Semver;
  pre: string[];
}

export function parseVersion(s: string | null | undefined): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec((s ?? '').trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

const NUMERIC = /^\d+$/;

/**
 * Сравнение по правилам semver, с пререлизами: `1.5.0-alpha.3 < 1.5.0-beta.1
 * < 1.5.0-beta.2 < 1.5.0`. Не версия — младше любой версии. Сортировка git
 * (`--sort=-v:refname`) так не умеет: без `versionsort.suffix` она ставит
 * `v1.5.0-beta.1` выше `v1.5.0`.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  const core = x.core[0] - y.core[0] || x.core[1] - y.core[1] || x.core[2] - y.core[2];
  if (core) return core;
  // Версия без пререлиза старше любого своего пререлиза.
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = NUMERIC.test(p);
    const qn = NUMERIC.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Ядро версии без пререлиза: `1.5.0-beta.3` → `1.5.0`. */
export const versionBase = (v: string): string | null => {
  const p = parseVersion(v);
  return p ? semverText(p.core) : null;
};

/** Стабильная ли версия — без пререлиза. */
export const isStableVersion = (v: string): boolean => {
  const p = parseVersion(v);
  return Boolean(p && !p.pre.length);
};

/** Канал пререлиза по версии: `1.5.0-beta.2` → beta. Стабильная или чужой суффикс — null. */
export const versionChannel = (v: string): PrereleaseChannel | null => {
  const head = parseVersion(v)?.pre[0];
  return head === 'beta' || head === 'alpha' ? head : null;
};

/** Старшая стабильная версия среди данных — `S` из §4.2. */
export function latestStable(versions: string[]): string | null {
  let best: string | null = null;
  for (const v of versions) if (isStableVersion(v) && (!best || compareVersions(v, best) > 0)) best = v;
  return best ? versionBase(best) : null;
}

/** Старшая версия канала: последняя бета, последняя альфа. */
export function latestOfChannel(versions: string[], channel: PrereleaseChannel): string | null {
  let best: string | null = null;
  for (const v of versions) if (versionChannel(v) === channel && (!best || compareVersions(v, best) > 0)) best = v;
  return best;
}

export interface ChannelVersionInput {
  /** Все известные версии цели: из тегов по шаблону и из истории выпусков. */
  versions: string[];
  channel: ReleaseChannel;
  /** Разряд выпуска (план → вклад фич → auto/фиксированный). */
  level: VersionLevel;
  /** Версия открытого плана выпуска, если её назвали. */
  planVersion?: string | null;
  /** Стабильный прямо из ветки release — патч от последнего стабильного (§3.6). */
  hotfix?: boolean;
  /** Стабильный из беты: версия этой беты. */
  fromBeta?: string | null;
}

/**
 * Следующая версия канала (§4.2).
 *
 * - пререлиз канала c: база — открытый цикл `L`, если он не младше желаемой
 *   версии `want`, иначе `want`; номер — следующий после старшего `{база}-c.n`;
 * - стабильный из беты — ядро беты: разряд уже посчитан для цикла;
 * - хотфикс — патч от последнего стабильного;
 * - стабильный без беты — `want`, как у цели без каналов.
 */
export function nextChannelVersion(input: ChannelVersionInput): string {
  const stable = latestStable(input.versions);
  const S = stable ? parseVersion(stable)?.core ?? null : null;
  if (input.channel === 'stable') {
    if (input.hotfix) return S ? semverText(bumpSemver(S, 'patch')) : '0.1.0';
    if (input.fromBeta) return versionBase(input.fromBeta) ?? input.fromBeta;
  }
  const plan = input.planVersion ? versionBase(input.planVersion) : null;
  const want = plan ?? (S ? semverText(bumpSemver(S, input.level)) : '0.1.0');
  if (input.channel === 'stable') return want;
  // Открытый цикл: старшая база пререлизов, которая старше S.
  let open: string | null = null;
  for (const v of input.versions) {
    if (isStableVersion(v)) continue;
    const base = versionBase(v);
    if (!base || (stable && compareVersions(base, stable) <= 0)) continue;
    if (!open || compareVersions(base, open) > 0) open = base;
  }
  const base = open && compareVersions(open, want) >= 0 ? open : want;
  let n = 0;
  for (const v of input.versions) {
    const p = parseVersion(v);
    if (!p || semverText(p.core) !== base || p.pre[0] !== input.channel) continue;
    const k = Number(p.pre[1]);
    if (p.pre.length === 2 && Number.isInteger(k) && k > n) n = k;
  }
  return `${base}-${input.channel}.${n + 1}`;
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

// ------------------------------------------------------- релиз на GitHub

/**
 * Виден ли релиз автообновлению. `missing` — релиза с этим тегом нет,
 * `draft` — он черновик (electron-updater черновики не видит), `noAssets` —
 * опубликован, но без нужных файлов.
 */
export type GithubReleaseCheck =
  | { state: 'ok'; url: string }
  | { state: 'missing' }
  | { state: 'draft'; url: string }
  | { state: 'noAssets'; url: string; missing: string[] };

/**
 * Разобрать ответ `GET /repos/{owner}/{repo}/releases` — список, а не
 * `/releases/tags/{tag}`: черновик тега ещё не имеет, и по тегу GitHub его
 * не отдаёт, а в списке он есть. Из нескольких релизов с одним тегом берём
 * опубликованный — черновик-дубль рядом с ним делу не мешает.
 */
export function parseGithubRelease(data: unknown, tag: string, assets: string[]): GithubReleaseCheck {
  const list = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
  const mine = list.filter((r) => r && typeof r === 'object' && r.tag_name === tag);
  if (!mine.length) return { state: 'missing' };
  const release = mine.find((r) => r.draft !== true) ?? mine[0];
  const url = typeof release.html_url === 'string' ? release.html_url : '';
  if (release.draft === true) return { state: 'draft', url };
  const names = new Set((Array.isArray(release.assets) ? release.assets as Array<Record<string, unknown>> : [])
    .map((a) => (a && typeof a.name === 'string' ? a.name : '')));
  const missing = assets.filter((name) => !names.has(name));
  return missing.length ? { state: 'noAssets', url, missing } : { state: 'ok', url };
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

/** Сколько последних строк вывода сборки или CI хранит вставший выпуск. */
export const STOP_LOG_LINES = 40;

/**
 * Почему выпуск встал или упал — чтобы менеджер прочитал причину сам
 * (`release_status`, `get_release`), а не просил текст ошибки у владельца.
 */
export interface ReleaseStop {
  /** Узел процесса, на котором встал: snapshot, build, watch… Пусто — упал вне узла. */
  node: string;
  /** Текст ошибки. */
  reason: string;
  /**
   * Хвост вывода команды или CI, последние STOP_LOG_LINES строк. Пусто, если
   * до сборки не дошло. Значения переменных офиса в нём закрыты.
   */
  log: string;
  at: number;
  /** Повторять бессмысленно: нужно решение. */
  needsDecision: boolean;
}

/** Выпуск как предмет (§9.1): одна попытка выпустить одну цель. */
export interface Release {
  id: string;
  targetId: string;
  /**
   * Канал выпуска (docs/design/release-channels/spec.md §5.5). Нет — цель без
   * каналов или выпуск, начатый до каналов: считается стабильным.
   */
  channel?: ReleaseChannel;
  version: string | null;
  build: number | null;
  /** Разряд, на который поднята версия, и откуда он. */
  level: VersionLevel | null;
  levelFrom: 'plan' | 'auto' | 'fixed' | 'owner' | null;
  /** Что выпускаем: вершина ветки выпуска. Пусто до снимка. */
  sha: string;
  /** Прошлый выпуск этой цели. null — первый. */
  fromSha: string | null;
  /**
   * Временная ветка выпуска `office/rel/<id>`: снимок, версия, починки.
   * У выпусков до каналов — `release/<id>`, их переименовывает
   * `migrateReleaseBranches` (docs/design/release-channels/spec.md §5.4).
   */
  branch: string;
  /** Стабильный выпуск прямо из ветки `release` (§3.5): продвигать нечего. */
  hotfix?: boolean;
  /**
   * Продвижение ветки канала: откуда снимок (ветка или тег беты), его коммит
   * и ветка канала, которую в конце перематывают на вершину выпуска.
   */
  promote?: { from: string; sha: string; branch: string } | null;
  /**
   * Куда ветка канала влита вниз после выпуска (§3.5): ['beta', 'main'].
   * Неполный список у состоявшегося выпуска — ветки разошлись.
   */
  mergedDown?: string[];
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
  /**
   * Причина остановки вставшего или упавшего выпуска. Имеет смысл только при
   * `status: 'failed'`: пока надзор повторяет выпуск, она остаётся от прошлой
   * остановки (по ней видно, что встал там же), а снимают её удачный выпуск и
   * явный `resume_release`.
   */
  stop?: ReleaseStop | null;
  /**
   * Хвост вывода последней упавшей сборки или CI: переживает починку и
   * перезапуск, а при остановке уходит в `stop.log`. Сборка прошла — снимается.
   */
  failLog?: string | null;
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

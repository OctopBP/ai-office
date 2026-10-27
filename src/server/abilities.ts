/**
 * Что умеет роль — для менеджера: пакет, подключённые MCP-серверы, скилы и
 * плагины. Менеджер файлов не видит и о возможностях исполнителей знал только
 * первую строку брифа, поэтому на «перенеси посты из figma в figcraft»
 * переспрашивал владельца, что такое figcraft, хотя у дизайнера он подключён.
 *
 * Два вида вывода: подробный блок «умеет» в list_team (по строке на сервер и
 * скил) и сводка «Кто что умеет» в системном промпте менеджера — по одной
 * строке на роль с жёстким потолком длины, потому что промпт платится на
 * каждом ходу.
 *
 * Сбор (`roleAbilities`) читает диск пакета, разбор в текст — нет: тексты
 * проверяются на готовых данных без пакетов на диске.
 */
import type { Lang, Vars } from '../shared/i18n';
import type { Settings } from '../shared/types';
import type { ServerKey } from './i18n';
import { mcpAbout, serversFor } from './mcp';
import { pick, resolvePackage } from './packages';
import type { Role } from './roles';
import { employeePack } from './skills';

export interface RoleAbilities {
  /** `@office/designer@0.3.0`; null — роль заведена руками. */
  package: string | null;
  /** Описание пакета из манифеста (summary) на языке офиса. */
  packageAbout: string;
  /** Подключённые серверы: id и что это. Выключенные в каталоге не входят. */
  servers: Array<{ id: string; about: string }>;
  /** Скилы полным именем; у встроенных `builtin` и описания нет. */
  skills: Array<{ name: string; about: string; builtin: boolean }>;
  /** Плагины, из которых пришли скилы. */
  plugins: string[];
}

type Say = (key: ServerKey, vars?: Vars) => string;

/** Длина строки описания в list_team: одна строка, а не абзац из SKILL.md. */
const ABOUT_MAX = 110;
/** Потолок строки роли в сводке промпта. */
export const BRIEF_LINE_MAX = 260;
/** Сколько скилов назвать в сводке промпта, остальное — «+N». */
const BRIEF_SKILLS_MAX = 6;

/** Первое предложение и не длиннее `max` — с многоточием, если обрезали. */
export function oneLine(text: string, max = ABOUT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** Короткое имя скила — без плагина в префиксе. */
const shortSkill = (name: string): string => name.slice(name.indexOf(':') + 1);

/**
 * Возможности роли из её пакета и каталога офиса. Ошибка чтения пакета не
 * роняет list_team: роль тогда показывается с тем, что удалось собрать.
 */
export function roleAbilities(settings: Settings, role: Role, lang: Lang): RoleAbilities {
  let pkgAbout = '';
  if (role.package) {
    try {
      const pkg = resolvePackage(role.package);
      if (pkg) pkgAbout = oneLine(pick(pkg.manifest.summary, lang));
    } catch {
      // Пакет не читается — имя и версия всё равно известны из ссылки роли.
    }
  }
  let pack: ReturnType<typeof employeePack> = null;
  try {
    pack = employeePack(role);
  } catch {
    pack = null;
  }
  const skills = (pack?.skills ?? []).map((name) => {
    const builtin = !name.includes(':');
    return { name, builtin, about: builtin ? '' : oneLine(pack?.descriptions[name] ?? '') };
  });
  return {
    package: role.package ? `${role.package.name}@${role.package.version}` : null,
    packageAbout: pkgAbout,
    servers: serversFor(settings, role).map((s) => ({ id: s.id, about: oneLine(mcpAbout(s, lang)) })),
    skills,
    plugins: [...new Set(skills.filter((s) => !s.builtin).map((s) => s.name.slice(0, s.name.indexOf(':'))))],
  };
}

const isEmpty = (ab: RoleAbilities): boolean =>
  !ab.package && !ab.servers.length && !ab.skills.length;

/**
 * Блок «умеет» для list_team: по строке на пакет, сервер и скил, с отступом
 * под строкой роли. Брифы сюда не входят — только имена и одна строка о том,
 * что это.
 */
export function abilitiesBlock(ab: RoleAbilities, say: Say): string {
  const head = `  ${say('prompt.team.abilities')}:`;
  if (isEmpty(ab)) return `${head} ${say('prompt.team.nothing')}`;
  const lines: string[] = [];
  if (ab.package) {
    lines.push(`${say('prompt.team.package')} ${ab.package}${ab.packageAbout ? ` — ${ab.packageAbout}` : ''}`);
  }
  for (const s of ab.servers) lines.push(`MCP ${s.id}${s.about && s.about !== s.id ? ` — ${s.about}` : ''}`);
  for (const s of ab.skills) {
    const about = s.builtin ? say('prompt.team.builtin') : s.about;
    lines.push(`${say('prompt.team.skill')} ${s.name}${about ? ` — ${about}` : ''}`);
  }
  if (ab.plugins.length) lines.push(`${say('prompt.team.plugins')}: ${ab.plugins.join(', ')}`);
  return [head, ...lines.map((l) => `    ${l}`)].join('\n');
}

/**
 * Строка роли для сводки в промпте: серверы с подписью и скилы по коротким
 * именам. Пустая строка — сказать о роли нечего, в сводку она не идёт.
 */
export function abilitiesLine(roleId: string, ab: RoleAbilities, say: Say): string {
  const parts: string[] = [];
  if (ab.servers.length) {
    parts.push(`MCP ${ab.servers.map((s) => (s.about && s.about !== s.id ? `${s.id} (${s.about})` : s.id)).join(', ')}`);
  }
  if (ab.skills.length) {
    const names = ab.skills.map((s) => shortSkill(s.name));
    const shown = names.slice(0, BRIEF_SKILLS_MAX).join(', ');
    const more = names.length > BRIEF_SKILLS_MAX ? ` +${names.length - BRIEF_SKILLS_MAX}` : '';
    parts.push(`${say('prompt.team.skills')}: ${shown}${more}`);
  }
  if (!parts.length) return '';
  const line = `- ${roleId}: ${parts.join('; ')}`;
  return line.length > BRIEF_LINE_MAX ? `${line.slice(0, BRIEF_LINE_MAX - 1).trimEnd()}…` : line;
}

/**
 * Сводка «Кто что умеет» для системного промпта менеджера: строка на роль с
 * серверами или скилами, остальные роли не упоминаются (их видно в list_team).
 * Сводка есть всегда, даже пустая: правило «сначала сверься, потом спрашивай»
 * в ней же, и оно нужно и офису, где пока ничего не подключено.
 */
export function abilitiesBrief(roles: Array<{ id: string; abilities: RoleAbilities }>, say: Say): string {
  const lines = roles.map((r) => abilitiesLine(r.id, r.abilities, say)).filter(Boolean);
  return say('prompt.pm.abilities', { lines: lines.length ? lines.join('\n') : `- ${say('prompt.pm.abilitiesNone')}` });
}

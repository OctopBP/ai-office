/**
 * Пакеты сотрудников: то, что роль умеет сверх брифа — скилы.
 *
 * Бриф и скил делят между собой разную работу, и путать их дорого. Бриф —
 * это обязанности и границы: он уезжает в системный промпт целиком и платится
 * токенами в каждой сессии, поэтому должен быть коротким. Скил — это подробная
 * инструкция к одному делу: он лежит на диске, модель видит только его
 * описание и читает целиком лишь тогда, когда дело дошло до него. Значит,
 * «как пользоваться инструментом» — это всегда скил, а не абзац в брифе.
 *
 * Формат пакета не наш: это обычный плагин Claude Code —
 *
 *   employees/<роль>/
 *     .claude-plugin/plugin.json     имя, версия, описание
 *     skills/<скил>/SKILL.md         свои навыки
 *     pack.json                      ссылки на чужие плагины, отбор скилов и
 *                                    серверы, которые пакету нужны
 *
 * Чужие скилы пакет НЕ копирует, а ссылается на уже установленный плагин
 * (`use` в pack.json). Причина не техническая: готовые наборы приходят с
 * собственными условиями — у официальных скилов Figma, например, нет лицензии
 * вовсе, — и класть их файлами в чужой репозиторий значит раздавать чужое.
 * Ссылка снимает вопрос целиком: плагин ставит пользователь, файлы остаются
 * там, куда их положил установщик, а обновление плагина не требует пересборки
 * пакета.
 *
 * Своего формата мы не заводим намеренно. Такой пакет ставится и работает в
 * обычном Claude Code без офиса вовсе, а у плагинов уже есть маркетплейсы —
 * то есть пакет сотрудника можно однажды опубликовать, не изобретая для этого
 * ни хранилища, ни установщика.
 *
 * MCP-серверы пакета офис намеренно НЕ читает (см. `skipMcpDiscovery`): чем
 * роль ходит наружу, решает офис в `server/mcp.ts` — там же, где живут ключи,
 * доверие и разбор рисков. Пакет объявляет умения, подключения выдаёт офис.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerDef } from '../shared/types';
import { checkMcpServers } from './mcp';
import type { Role } from './roles';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Где офис ищет пакеты сотрудников. Имя папки — id роли.
 *
 * Путь переопределяется переменной окружения: тем же ключом проверка гоняет
 * пакеты на времянке, не подкладывая их в репозиторий, и им же сюда однажды
 * подставится каталог пакетов, поставленных из маркетплейса.
 */
export const EMPLOYEES_DIR = process.env.OFFICE_EMPLOYEES_DIR
  ? resolve(process.env.OFFICE_EMPLOYEES_DIR)
  : resolve(ROOT, 'employees');

export interface EmployeePack {
  /** Папки плагинов, которые получит сессия: свой пакет и то, на что он ссылается. */
  dirs: string[];
  /** Полные имена скилов, `<плагин>:<скил>`. */
  skills: string[];
  /**
   * Серверы, которые пакет ПРОСИТ. Именно просит: офис их не подключает и в
   * каталог не кладёт — это делает человек, увидев, что за команда будет
   * запущена. Пакет приезжает из маркетплейса, и «объявил сервер» значит
   * «объявил процесс, который поднимется на этой машине»: тихо соглашаться на
   * такое нельзя ни разу.
   *
   * Смысл поля в том, что скил без своего инструмента бесполезен, и пакет
   * должен уметь сказать, чего ему не хватает, — а не оставлять человека
   * гадать, почему навык не работает.
   */
  servers: McpServerDef[];
}

/** Что лежит в pack.json. Оба поля необязательны. */
interface PackFile {
  /** Пути к уже установленным плагинам. `~` и `*` в последнем сегменте раскрываются. */
  use?: string[];
  /**
   * Какие скилы включить. Пусто — все найденные. Нужен там, где чужой плагин
   * большой, а роли из него нужна половина: каждый скил платится описанием в
   * контексте всех её сессий.
   */
  skills?: string[];
  /** Серверы, без которых навыки пакета бесполезны. Офис их только предлагает. */
  servers?: McpServerDef[];
}

/** Один плагин на диске. */
interface Plugin {
  name: string;
  dir: string;
  skills: string[];
}

/** Имя скила из заголовка SKILL.md; пусто — берётся имя папки. */
function skillName(file: string): string {
  const head = readFileSync(file, 'utf8').slice(0, 2000);
  return /^name:\s*(\S+)/m.exec(head)?.[1] ?? '';
}

/**
 * Плагин в папке — или null, если его там нет. Развалившийся плагин (нет
 * манифеста, нет скилов) считается отсутствующим: работа роли не должна
 * вставать из-за папки.
 */
function pluginAt(dir: string, fallbackName: string): Plugin | null {
  const manifest = resolve(dir, '.claude-plugin/plugin.json');
  if (!existsSync(manifest)) return null;

  let name = fallbackName;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const declared = (parsed as { name?: unknown }).name;
    if (typeof declared === 'string' && declared.trim()) name = declared.trim();
  } catch {
    // Битый манифест — имя берём по папке: скилы всё равно найдутся, а
    // разбираться с чужим JSON у сотрудника посреди задачи повода нет.
  }

  const skillsDir = resolve(dir, 'skills');
  if (!existsSync(skillsDir)) return null;
  const skills: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = resolve(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    // Полное имя, а не короткое: короткое SDK сопоставляет по суффиксу, и два
    // плагина с одинаково названным скилом разъехались бы молча.
    skills.push(`${name}:${skillName(file) || entry.name}`);
  }
  return skills.length ? { name, dir, skills } : null;
}

/** Путь из pack.json: `~` — домашняя директория, остальное как есть. */
const expandHome = (path: string): string =>
  (path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path));

/**
 * Папка по пути, где последний сегмент может быть маской. Плагины ставятся в
 * папку с версией (`.../figma/2.2.96`), и прибивать версию в пакете значит
 * ломать его при первом же обновлении: маска `figma/*` берёт старшую.
 */
function resolveDir(path: string): string | null {
  const full = expandHome(path);
  if (!full.includes('*')) return existsSync(full) ? full : null;
  const parent = dirname(full);
  const mask = basename(full);
  if (mask.includes('*') === false || !existsSync(parent)) return null;
  const re = new RegExp(`^${mask.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const hits = readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && re.test(e.name))
    .map((e) => e.name)
    // Версии сравниваем как числа, иначе 2.2.96 оказалась бы старше 2.10.0.
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return hits.length ? resolve(parent, hits[hits.length - 1]) : null;
}

/** Отбор скилов из pack.json: по полному имени или по короткому. */
const wanted = (skill: string, list: string[]): boolean =>
  list.some((want) => skill === want || skill.endsWith(`:${want}`));

/**
 * Пакет роли — или null, если его нет. Диск читаем на каждый запуск сессии,
 * а не один раз при старте: добавленный скил должен доезжать до следующей
 * задачи, а не до следующего перезапуска сервера.
 */
export function employeePack(role: Role): EmployeePack | null {
  const dir = resolve(EMPLOYEES_DIR, role.id);
  if (!existsSync(dir)) return null;

  const plugins: Plugin[] = [];
  const own = pluginAt(dir, role.id);
  if (own) plugins.push(own);

  let pack: PackFile = {};
  const packFile = resolve(dir, 'pack.json');
  if (existsSync(packFile)) {
    try {
      pack = JSON.parse(readFileSync(packFile, 'utf8')) as PackFile;
    } catch {
      // Битый pack.json — считаем, что ссылок нет. Свои скилы пакета при этом
      // остаются: половина пакета лучше, чем сотрудник, который не запустился.
    }
  }

  for (const path of pack.use ?? []) {
    const target = resolveDir(path);
    // Ссылка в никуда — плагин не установлен или переехал. Это не отказ
    // запускать роль: пусть работает тем, что есть, а недостача видна в логе.
    if (!target) continue;
    const found = pluginAt(target, basename(target));
    if (found) plugins.push(found);
  }

  // Объявленные серверы проходят ту же проверку, что и каталог из формы, но
  // строже в исходе: форма с ошибкой не сохраняется целиком и человек её
  // правит, а пакет править некому — он приезжает из маркетплейса. Поэтому
  // сервер с замечанием просто не предлагается: предложить его «почти как
  // объявлено» (с молча вычищенным токеном, например) значит показать
  // человеку не то, что написал автор пакета.
  const checked = checkMcpServers(pack.servers ?? []);
  const broken = new Set(checked.problems.map((p) => p.id));
  const servers = checked.servers.filter((srv) => !broken.has(srv.id));

  if (!plugins.length) return servers.length ? { dirs: [], skills: [], servers } : null;
  const all = plugins.flatMap((p) => p.skills);
  const skills = pack.skills?.length ? all.filter((s) => wanted(s, pack.skills!)) : all;
  return skills.length || servers.length
    ? { dirs: plugins.map((p) => p.dir), skills, servers }
    : null;
}

/**
 * Плагины роли для опций сессии. undefined — пакета нет, и опция не ставится
 * вовсе: у роли без пакета сессия обязана выглядеть ровно так же, как до
 * появления этого файла.
 */
export function employeePlugins(role: Role): SdkPluginConfig[] | undefined {
  const pack = employeePack(role);
  // Пакет может состоять из одной просьбы про сервер — плагина в нём тогда
  // нет, и опцию сессии ставить нечем.
  if (!pack?.dirs.length) return undefined;
  // skipMcpDiscovery: подключения роли выдаёт офис (server/mcp.ts), а не
  // пакет. Без этого чужой плагин поднимал бы в сессии свои серверы мимо
  // каталога, разбора рисков и подтверждений — а у больших наборов вроде
  // официального Figma свой MCP в комплекте есть.
  return pack?.dirs.map((path) => ({ type: 'local', path, skipMcpDiscovery: true }));
}

/**
 * Скилы роли для опций сессии. Перечисляем поимённо, а не через `'all'`:
 * список — это то, что роль умеет, и он должен читаться в логе и в пакете, а
 * не зависеть от того, что ещё оказалось видно сессии.
 */
export function employeeSkills(role: Role): string[] | undefined {
  const skills = employeePack(role)?.skills;
  return skills?.length ? skills : undefined;
}

/**
 * Серверы, которые просит пакет роли. Что с ними делать — решает человек в
 * каталоге: офис показывает просьбу и команду, но не подключает.
 */
export const employeeServers = (role: Role): McpServerDef[] => employeePack(role)?.servers ?? [];

/**
 * Набор встроенных инструментов сессии. У ролей с урезанным набором
 * (дизайнер, юрист, SMM) в списке нет `Skill` — а без него скилы пакета
 * видно, но открыть нельзя. Дописываем его сам, и только тем ролям, у кого
 * пакет действительно есть: роли без пакета набор менять незачем.
 */
export function sessionTools(role: Role): string[] | undefined {
  if (!role.tools || role.tools.includes('Skill') || !employeeSkills(role)) return role.tools;
  return [...role.tools, 'Skill'];
}

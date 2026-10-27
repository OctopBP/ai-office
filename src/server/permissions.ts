import { resolve, isAbsolute, relative, sep } from 'node:path';
import type { PermissionMode, RiskLevel } from '../shared/types';
import type { Lang } from '../shared/i18n';
import { t, type ServerKey } from './i18n';
import type { Settings } from '../shared/types';
import { inWriteZone, type WriteZone } from './subprojects';
import { checkPmRead, PM_READ_MAX_LINES, type PmReadScope } from './pm-read';

export interface Verdict {
  risk: RiskLevel;
  reason: string;
  summary: string;   // одна строка для заголовка модалки
  detail: string;    // подробности: команда, путь, фрагмент
  /** Ключ для «разрешать всегда»: Bash-команды различаем по первому слову. */
  key: string;
  /**
   * Запрет без вопроса в любом режиме — запись в чужую зону (spec подпроектов
   * §5.2). У запрета `detail` — путь, в который пытались писать.
   */
  deny?: true;
}

/**
 * Зона задачи-папки для классификатора: что можно менять и от какого
 * каталога считать её пути (корень копии репозитория задачи).
 */
export interface ClassifyZone extends WriteZone {
  base: string;
}

/** Инструменты, которые ничего не меняют — их не спрашиваем никогда. */
const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite',
  'WebSearch', 'WebFetch', 'AskUserQuestion', 'Task',
]);

/** Пишущие инструменты — риск зависит от того, куда пишут. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

/**
 * Наши собственные MCP-серверы: `office` у исполнителя, `team` у менеджера.
 * Их инструменты пишет сам офис, и опасного в них нет по построению — сказать
 * фразу, отметить критерий, назначить задачу.
 *
 * Всё остальное под префиксом `mcp__` — чужой сервер из набора ролей
 * (`server/mcp.ts`), и «наши инструменты безопасны» на него не
 * распространяется: он ходит не в рабочую копию, а в чужие данные — в
 * открытый файл Figma, в сцену Blender, в трекер, — где ни песочница, ни
 * ветка задачи ничего не защищают.
 */
const OWN_MCP_SERVERS = new Set(['office', 'team']);

/**
 * Читающие инструменты внешнего сервера. Разбираем по имени: MCP не размечает
 * инструменты по действию, а спрашивать про каждый просмотр документа — это
 * та самая утопленная в подтверждениях работа, ради которой у Bash заведён
 * список опасного, а не список всего подряд.
 */
const READ_MCP_TOOL = /^(get|list|read|search|find|fetch|describe|inspect)_/;

/**
 * Инструменты внешнего сервера, стирающие чужое. Их мало и они по имени
 * узнаваемы, зато отменить их нечем: ветку задачи можно не мержить, а узел,
 * удалённый в открытом файле Figma, офису уже не вернуть. Поэтому им `danger`,
 * а не `write`, — в режиме «спрашивать только про необратимое» спрашивается
 * именно `danger`, и с `write` весь разбор чужих серверов остался бы
 * украшением.
 */
const DESTRUCTIVE_MCP_TOOL = /^(delete|remove|clear|drop|purge|reset|ungroup|detach|revert)_/;

/**
 * Браузер QA (`tools/browser/`, id в каталоге — `browser`). Сервер наш, и
 * периметр у него свой: адреса ограничены localhost, 127.0.0.1 и опубликованной
 * страницей проекта, а снимки пишутся только в рабочую копию. Спрашивать
 * владельца про каждое касание и скриншот незачем — это и есть работа QA.
 * Поэтому `get_*` — чтение, как у всех, а остальные его инструменты тоже
 * `safe`: границу держит фильтр сервера, а не модалка.
 */
const QA_BROWSER_SERVER = 'browser';

/**
 * Figma Console (`figma-console-mcp`, id в каталоге — `figma-console`). У него
 * все инструменты названы с префиксом `figma_`, поэтому общие правила по
 * глаголу к нему применяются после снятия префикса: `figma_get_variables` —
 * чтение, `figma_delete_node` — стирание, как у моста.
 *
 * Сверх общего у него есть читающие инструменты с другими глаголами —
 * скриншоты, аудит, разбор, сравнение версий, — и `figma_execute`: он
 * исполняет в открытом файле произвольный код Plugin API, то есть может всё,
 * включая удаление. Отличить по аргументам, стирает ли он, нельзя, поэтому
 * ему `danger` — вопрос владельцу даже в режиме «только про необратимое».
 */
const FIGMA_CONSOLE_SERVER = 'figma-console';
const FIGMA_CONSOLE_PREFIX = 'figma_';
const FIGMA_CONSOLE_READ =
  /^(capture_screenshot|take_screenshot|analyze_|audit_|check_|diagnose|diff_|lint_|blame_|ds_status|ds_analyze|ds_verify)/;
const FIGMA_CONSOLE_CODE = /^execute(_|$)/;

/**
 * Мост к редактору Unity (`unity mcp` из Unity CLI, id в каталоге — `unity`).
 * Его главные инструменты — `eval` и `eval_file`: они исполняют в открытом
 * редакторе произвольный C#, то есть могут стереть ассет, переписать сцену и
 * сохранить её на диск мимо ветки задачи. Отличить по аргументам, безвреден
 * ли код, нельзя, поэтому им `danger`, как `figma_execute`. Остальные его
 * инструменты — зарегистрированные команды редактора — разбираются по общим
 * правилам глагола.
 */
const UNITY_SERVER = 'unity';
const UNITY_CODE = /^(eval|execute|run_code)(_|$)/;

/**
 * figcraft (`figcraft-cli mcp`, id в каталоге — `figcraft`, разбор — D-4 §5).
 * `inspect_document`, `inspect_ui`, `get_node` и `list_commands` читающие по
 * общему глаголу. Сверх того читают два инструмента без глагола в имени:
 * `screenshot` — всегда, это снимок документа картинкой агенту, и `export` —
 * только без `path`: тогда картинка тоже возвращается в ответе. С `path` он
 * пишет файл, а периметра записи у сервера нет, поэтому это запись, как и
 * `save_file`. `run_command` и читает, и пишет — отличить нельзя, он пишущий.
 *
 * Имена сверены с живым `tools/list` 0.6.0 (T-595): те же 18. Сам сервер
 * помечает `export` как `readOnlyHint: true` и с `path` — мы строже, потому
 * что файл на диске уже не чтение. У `screenshot` в 0.6.0 есть `window`
 * (снимок окна в режиме `--attach`) — тоже чтение.
 */
const FIGCRAFT_SERVER = 'figcraft';
const figcraftReads = (verb: string, input: Record<string, unknown>): boolean =>
  verb === 'screenshot' || (verb === 'export' && (input.path === undefined || input.path === ''));

/**
 * Bash — основной источник опасных действий. Спрашиваем не про всякую команду
 * (иначе пользователь утонет в подтверждениях на ls и cat), а про те, что
 * необратимы или выходят за пределы проекта.
 */
const DANGEROUS_BASH: Array<{ re: RegExp; why: ServerKey }> = [
  { re: /(^|[\s;&|(])rm\b/,                         why: 'perm.why.rm' },
  { re: /(^|[\s;&|(])rmdir\b/,                      why: 'perm.why.rmdir' },
  { re: /(^|[\s;&|(])(kill|pkill|killall)\b/,       why: 'perm.why.kill' },
  { re: /(^|[\s;&|(])sudo\b/,                       why: 'perm.why.sudo' },
  { re: /(^|[\s;&|(])(chmod|chown)\b/,              why: 'perm.why.chmod' },
  { re: /(^|[\s;&|(])(dd|mkfs|fdisk)\b/,            why: 'perm.why.disk' },
  { re: /(^|[\s;&|(])(shutdown|reboot|halt)\b/,     why: 'perm.why.shutdown' },
  { re: /git\s+push\b/,                             why: 'perm.why.push' },
  { re: /git\s+reset\s+--hard\b/,                   why: 'perm.why.reset' },
  { re: /git\s+clean\b/,                            why: 'perm.why.clean' },
  { re: /(npm|yarn|pnpm)\s+publish\b/,              why: 'perm.why.publish' },
  { re: /(curl|wget)[^|;]*\|\s*(ba|z|fi)?sh\b/,     why: 'perm.why.pipeSh' },
  { re: /(^|[\s;&|(])(shred|srm|truncate|unlink)\b/, why: 'perm.why.shred' },
  // Встроенный код в интерпретаторе обходит любую проверку текста команды:
  // именно так агент удалил файл после двух отказов на rm.
  { re: /(^|[\s;&|(])(python3?|node|perl|ruby|deno|bun|php|osascript)\s+(-e|-c|--eval|eval)\b/,
    why: 'perm.why.eval' },
  { re: /-delete\b|(xargs|find)\b[^|;]*\b(rm|unlink)\b/, why: 'perm.why.massDelete' },
  { re: /\bhistory\s+-c\b/,                         why: 'perm.why.historyClear' },
  { re: /(^|[\s;&|(])mv\b/,                         why: 'perm.why.mv' },
];

const clip = (s: unknown, n: number): string => {
  const str = String(s ?? '').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

/** Путь внутри рабочей директории проекта? */
function insideProject(path: unknown, projectDir: string): boolean {
  const raw = String(path ?? '');
  if (!raw) return true;
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(projectDir, raw);
  const root = resolve(projectDir);
  // Разделитель системный: на Windows resolve() отдаёт обратные слеши.
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Разобрать вызов инструмента: насколько он опасен и что показать человеку.
 * Язык здесь нужен потому, что причина и сводка уходят прямо в модалку
 * разрешения и в ленту офиса, а не в код.
 */
export function classify(
  toolName: string,
  input: Record<string, unknown>,
  projectDir: string,
  lang: Lang,
  /** Зона задачи-папки: запись вне неё — отказ. Чтение не ограничивается. */
  zone?: ClassifyZone,
): Verdict {
  // Имя инструмента MCP — `mcp__<сервер>__<инструмент>`. Сервер отделяем от
  // инструмента: своё от чужого различается именно сервером.
  if (toolName.startsWith('mcp__')) {
    const [, server = '', ...rest] = toolName.split('__');
    const short = rest.join('__');
    if (OWN_MCP_SERVERS.has(server)) {
      return { risk: 'safe', reason: '', summary: toolName, detail: '', key: toolName };
    }
    // Глагол инструмента: у Figma Console он идёт после общего префикса.
    const figmaConsole = server === FIGMA_CONSOLE_SERVER;
    const verb = figmaConsole && short.startsWith(FIGMA_CONSOLE_PREFIX)
      ? short.slice(FIGMA_CONSOLE_PREFIX.length)
      : short;
    if (READ_MCP_TOOL.test(verb) || server === QA_BROWSER_SERVER
      || (figmaConsole && FIGMA_CONSOLE_READ.test(verb))
      || (server === FIGCRAFT_SERVER && figcraftReads(verb, input))) {
      return { risk: 'safe', reason: '', summary: `${server}: ${short}`, detail: '', key: toolName };
    }
    const destructive = DESTRUCTIVE_MCP_TOOL.test(verb)
      || (figmaConsole && FIGMA_CONSOLE_CODE.test(verb))
      || (server === UNITY_SERVER && UNITY_CODE.test(verb));
    return {
      risk: destructive ? 'danger' : 'write',
      reason: t(lang, destructive ? 'perm.reason.mcpDestructive' : 'perm.reason.mcpWrite'),
      summary: `${server}: ${short}`,
      // Ключ «разрешать всегда» — полное имя инструмента: разрешив один раз
      // create_frame, дизайнер не должен получить заодно delete_nodes.
      detail: clip(JSON.stringify(input), 400),
      key: toolName,
    };
  }

  if (SAFE_TOOLS.has(toolName)) {
    return { risk: 'safe', reason: '', summary: toolName, detail: '', key: toolName };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const path = input.file_path ?? input.notebook_path;
    const outside = !insideProject(path, projectDir);
    // Чужая зона внутри той же копии. Вне копии — своя развилка ниже (`danger`
    // и песочница ОС): зона говорит только о файлах репозитория задачи.
    const foreign = zone && path ? foreignZonePath(String(path), projectDir, zone) : null;
    if (zone && foreign) {
      return {
        risk: 'danger',
        reason: t(lang, 'perm.reason.foreignZone', { zone: zone.label }),
        summary: `${toolName} → ${path}`,
        detail: foreign,
        key: `${toolName}:zone`,
        deny: true,
      };
    }
    const content = String(input.content ?? input.new_string ?? '');
    return {
      risk: outside ? 'danger' : 'write',
      reason: t(lang, outside ? 'perm.reason.outside' : 'perm.reason.write'),
      summary: `${toolName} → ${path}`,
      detail: content ? clip(content, 600) : '',
      key: outside ? `${toolName}:outside` : toolName,
    };
  }

  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    const hit = DANGEROUS_BASH.find((rule) => rule.re.test(command));
    const first = command.trim().split(/\s+/)[0] ?? 'bash';
    if (hit) {
      return {
        risk: 'danger',
        reason: t(lang, hit.why),
        summary: clip(command, 90),
        detail: command,
        key: `Bash:${first}`,
      };
    }
    return {
      risk: 'write',
      reason: t(lang, 'perm.reason.bash'),
      summary: clip(command, 90),
      detail: command,
      key: `Bash:${first}`,
    };
  }

  // Публикация артефакта — единственный встроенный инструмент, отправляющий
  // работу наружу: канвас макетов уезжает страницей в аккаунт claude.ai. Это
  // тот же род действия, что `git push`, и риск у него тот же — `danger`:
  // «спрашивать только про необратимое» обязано спросить именно здесь, а
  // молча выпускать сделанное за пределы машины офис не должен.
  if (toolName === 'Artifact') {
    const what = input.title ?? input.file_path ?? input.url ?? input.action ?? '';
    return {
      risk: 'danger',
      reason: t(lang, 'perm.reason.artifact'),
      summary: `Artifact → ${clip(what, 70)}`,
      detail: clip(JSON.stringify(input), 400),
      key: 'Artifact',
    };
  }

  // Незнакомый инструмент — считаем пишущим, пусть решает пользователь.
  return {
    risk: 'write',
    reason: t(lang, 'perm.reason.unknownTool'),
    summary: toolName,
    detail: clip(JSON.stringify(input), 400),
    key: toolName,
  };
}

/** Вердикт чтения менеджера: с входом, который надо передать инструменту. */
export interface PmReadVerdict extends Verdict {
  updatedInput: Record<string, unknown>;
}

/**
 * Чтение менеджером (Read, Glob, Grep — T-694). Границы считает
 * `checkPmRead`, здесь они превращаются в вердикт для обработчика:
 *  - внутри офиса — `safe`;
 *  - вне — `danger` без запрета: владелец решает модалкой в любом режиме,
 *    «разрешать всегда» — для этого же пути, а не для чтения вообще;
 *  - секрет, большой файл целиком, слишком большой limit — `deny`, а `reason`
 *    — готовый текст отказа агенту с причиной и тем, как читать правильно.
 */
export function classifyPmRead(
  toolName: string,
  input: Record<string, unknown>,
  scope: PmReadScope,
  lang: Lang,
): PmReadVerdict {
  const check = checkPmRead(toolName, input, scope);
  const summary = `${toolName} → ${check.path}`;
  const denied = (reason: string): PmReadVerdict => ({
    risk: 'danger', reason, summary, detail: check.path, key: `${toolName}:${check.path}`,
    deny: true, updatedInput: input,
  });
  switch (check.kind) {
    case 'inside':
      return {
        risk: 'safe', reason: '', summary, detail: '', key: toolName,
        updatedInput: check.grepHeadLimit ? { ...input, head_limit: check.grepHeadLimit } : input,
      };
    case 'outside':
      return {
        risk: 'danger',
        reason: t(lang, 'perm.reason.pmReadOutside'),
        summary,
        detail: check.path,
        key: `${toolName}:${check.path}`,
        updatedInput: input,
      };
    case 'secret':
      return denied(t(lang, 'pmRead.deny.secret', { path: check.path, why: t(lang, `pmRead.why.${check.why}`) }));
    case 'tooBig':
      return denied(t(lang, 'pmRead.deny.tooBig', {
        path: check.path, lines: check.lines, kb: Math.ceil(check.bytes / 1024), max: PM_READ_MAX_LINES,
      }));
    case 'limitTooBig':
      return denied(t(lang, 'pmRead.deny.limit', { limit: check.limit, max: PM_READ_MAX_LINES }));
  }
}

// ------------------------------------------------------- режим доступа

/** Что делать с вызовом: пропустить молча, спросить человека или запретить. */
export type Decision = 'allow' | 'ask' | 'deny';

/**
 * Эффективный режим агента: чем ближе уровень к конкретному сотруднику, тем
 * он сильнее — агент важнее роли, роль важнее офиса. null на уровне означает
 * «своего режима нет, наследовать следующий». Отдельная функция, потому что то
 * же вычисление нужно и обработчику разрешений, и снимку состояния для UI:
 * расходиться им нельзя.
 */
export function effectiveMode(
  agentMode: PermissionMode | null | undefined,
  roleMode: PermissionMode | null | undefined,
  officeMode: PermissionMode,
): PermissionMode {
  return agentMode ?? roleMode ?? officeMode;
}

const MODES: readonly PermissionMode[] = ['auto', 'ask-risky', 'ask-writes', 'readonly'];

/**
 * Режим пришёл по сети от клиента, а не из нашего кода: чужое значение
 * попало бы в файл состояния и осталось бы там навсегда.
 */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/**
 * Путь записи от корня копии, если он внутри копии и вне зоны; иначе null.
 * Файлы вне копии зона не судит — их уже держат `outside` и песочница.
 */
function foreignZonePath(path: string, projectDir: string, zone: ClassifyZone): string | null {
  const abs = isAbsolute(path) ? resolve(path) : resolve(projectDir, path);
  const rel = relative(resolve(zone.base), abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const file = rel.split(sep).join('/');
  return inWriteZone(file, zone) ? null : file;
}

/**
 * Решение по уже классифицированному вызову в заданном режиме. `deny` из
 * вердикта сильнее любого режима, включая «разрешать всё».
 */
export function decide(mode: PermissionMode, risk: RiskLevel, deny?: boolean): Decision {
  if (deny) return 'deny';
  // Читающие инструменты не спрашиваем ни в одном режиме, включая readonly.
  if (risk === 'safe') return 'allow';
  switch (mode) {
    case 'auto':       return 'allow';
    case 'readonly':   return 'deny';
    case 'ask-writes': return 'ask';
    // Необратимое спрашиваем, обычную запись и команды пропускаем.
    case 'ask-risky':  return risk === 'danger' ? 'ask' : 'allow';
  }
}

/** Название режима доступа словами — тем же, что видит человек в настройках. */
export function modeLabel(mode: PermissionMode, lang: Lang): string {
  return t(lang, `perm.mode.${mode}`);
}

/**
 * Строка в ленту офиса про действие, прошедшее без вопроса. Человек видит её
 * постфактум, поэтому в ней должно быть видно и инструмент, и что он сделал.
 */
export function autoApprovedText(
  mode: PermissionMode,
  toolName: string,
  verdict: Verdict,
  lang: Lang,
): string {
  // У Write/Edit summary уже начинается с имени инструмента — не дублируем.
  const what = verdict.summary.startsWith(toolName)
    ? verdict.summary
    : `${toolName}: ${verdict.summary || '—'}`;
  const why = verdict.reason ? ` (${verdict.reason})` : '';
  return t(lang, 'perm.autoApproved', { mode: modeLabel(mode, lang), what: `${what}${why}` });
}

// ------------------------------------------------------------- выпуски

/**
 * Команда агента, которая выпускает в обход процесса выпуска
 * (docs/design/releases/spec.md §8): пуш тегов, пуш в ветку, которую забирает
 * CI, команда сборки цели и очевидные формы загрузки в стор. Правило есть,
 * только когда у офиса есть цели выпуска: без них выпуска нет и обходить нечего.
 *
 * Это защита от случайного «сейчас сам и выложу», а не изоляция: у агента
 * оболочка, и настоящая граница — то, что ключи лежат не в проекте.
 * Возвращает то, на что сработало правило, или null.
 */
export function releaseCommandBlocked(command: string, settings: Pick<Settings, 'release' | 'checks'>): string | null {
  const targets = settings.release?.targets ?? [];
  if (!targets.length) return null;
  const cmd = command.replace(/\s+/g, ' ');
  const pushes = /\bgit( -C \S+)? push\b/.test(cmd);
  if (pushes && /(--tags\b|--follow-tags\b|refs\/tags\/)/.test(cmd)) return 'git push --tags';
  for (const target of targets) {
    if (target.kind === 'push' && target.branch && pushes) {
      const esc = target.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[\\s:+]|refs/heads/)${esc}(\\s|$)`).test(cmd)) return `git push → ${target.branch}`;
    }
    const run = target.run ? settings.checks?.[target.run]?.trim() : '';
    if (run && cmd.includes(run.replace(/\s+/g, ' '))) return run;
  }
  if (/\bfastlane\b/.test(cmd) && /\b(beta|release|deliver|pilot|upload_to_testflight|upload_to_app_store|supply)\b/.test(cmd)) return 'fastlane';
  if (/\bxcrun (altool|notarytool)\b/.test(cmd) && /--upload|\bsubmit\b|upload-app/.test(cmd)) return 'xcrun upload';
  if (/\bgh release (create|upload|edit)\b/.test(cmd)) return 'gh release';
  return null;
}

// ------------------------------------------- git на чтение для шага процесса

/**
 * Подкоманды git, которые ничего не меняют ни в репозитории, ни в рабочей
 * копии. Список разрешённого, а не запрещённого: незнакомая подкоманда — отказ.
 * `branch`, `reflog`, `remote` и `worktree` пишут в части своих форм — их
 * разбирают отдельно ниже.
 */
const GIT_READ_SUBCOMMANDS = new Set([
  'log', 'show', 'diff', 'status', 'blame', 'annotate', 'rev-parse', 'rev-list',
  'ls-files', 'ls-tree', 'cat-file', 'shortlog', 'describe', 'merge-base',
  'name-rev', 'grep', 'whatchanged', 'diff-tree', 'diff-files', 'diff-index',
  'for-each-ref', 'show-ref', 'show-branch', 'range-diff', 'count-objects',
  'branch', 'reflog', 'remote', 'worktree',
]);

/** Глобальные ключи git до подкоманды, которые ничего не открывают. */
const GIT_SAFE_GLOBAL = new Set(['--no-pager', '-P', '--no-optional-locks', '--no-replace-objects']);

/**
 * Ключи, которые и у читающих подкоманд пишут в файл или зовут внешнюю
 * программу: `--output` у diff/log, `-O` у grep (открыть в пейджере),
 * внешний diff.
 */
const GIT_WRITING_OPTION = /^(--output(=|$)|-O|--open-files-in-pager|--ext-diff$)/;

/** Ключи `git branch`, которые меняют ветки. */
const GIT_BRANCH_WRITE = /^(-[dDmMcCfu]|--delete|--move|--copy|--force|--set-upstream-to|--unset-upstream|--edit-description|--create-reflog|--track|--no-track|--recurse-submodules)/;
/** Ключи `git branch` со значением следующим словом: значение — не имя ветки. */
const GIT_BRANCH_VALUE = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--color', '--column']);

/**
 * Символы, которые делают из команды больше одной: цепочки, конвейеры,
 * подстановки, перенаправления, переводы строк. Обратную косую черту тоже не
 * пускаем — разбор слов ниже нарочно простой и экранирования не знает.
 */
const SHELL_META = /[;&|`$()<>\n\r\\]/;

/** Слова команды с учётом одинарных и двойных кавычек; null — кавычка не закрыта. */
function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(cur);
  return words;
}

/**
 * Проверка Bash-команды для шага процесса с доступом `shell: "git-read"`
 * (workflows/research.json → verify): разрешена ровно одна команда git на
 * чтение. null — можно; иначе — что именно не пустили (уходит агенту в отказ).
 *
 * Отказ всему, что не одна git-команда: другие программы, `env`/`command`
 * перед git, переменные окружения, цепочки `;` `&&` `|`, подстановки `$( )`
 * и перенаправления. Глобальные ключи git — только безобидные: `-c`, `-C`,
 * `--git-dir`, `--exec-path` позволяют подменить конфиг или репозиторий и
 * исполнить чужое (`-c core.pager=…`).
 */
export function gitReadOnlyProblem(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return 'empty';
  const meta = SHELL_META.exec(trimmed);
  if (meta) return `shell: ${JSON.stringify(meta[0])}`;
  const words = shellWords(trimmed);
  if (!words) return 'shell: quote';
  if (words[0] !== 'git') return words[0];

  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (!GIT_SAFE_GLOBAL.has(words[i])) return `git ${words[i]}`;
    i++;
  }
  const sub = words[i];
  if (!sub) return 'git';
  if (!GIT_READ_SUBCOMMANDS.has(sub)) return `git ${sub}`;
  const args = words.slice(i + 1);
  const bad = args.find((a) => GIT_WRITING_OPTION.test(a));
  if (bad) return `git ${sub} ${bad}`;

  if (sub === 'branch') {
    // Без --list имя в аргументах — это создание ветки.
    let listing = false;
    let named = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (GIT_BRANCH_WRITE.test(a)) return `git branch ${a}`;
      if (a === '--list' || a === '-l') listing = true;
      else if (GIT_BRANCH_VALUE.has(a)) k++;
      else if (!a.startsWith('-')) named = true;
    }
    if (named && !listing) return 'git branch <name>';
  }
  // reflog: expire и delete переписывают журнал ссылок.
  if (sub === 'reflog' && args[0] && !args[0].startsWith('-') && !['show', 'exists'].includes(args[0])) {
    return `git reflog ${args[0]}`;
  }
  // remote: только список; add, remove, set-url и прочие — запись в конфиг.
  if (sub === 'remote' && args.some((a) => a !== '-v' && a !== '--verbose')) return `git remote ${args.join(' ')}`;
  // worktree: только list.
  if (sub === 'worktree' && args[0] !== 'list') return `git worktree ${args[0] ?? ''}`.trim();
  return null;
}

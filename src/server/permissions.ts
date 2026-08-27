import { resolve, isAbsolute } from 'node:path';
import type { PermissionMode, RiskLevel } from '../shared/types';
import type { Lang } from '../shared/i18n';
import { t, type ServerKey } from './i18n';

export interface Verdict {
  risk: RiskLevel;
  reason: string;
  summary: string;   // одна строка для заголовка модалки
  detail: string;    // подробности: команда, путь, фрагмент
  /** Ключ для «разрешать всегда»: Bash-команды различаем по первому слову. */
  key: string;
}

/** Инструменты, которые ничего не меняют — их не спрашиваем никогда. */
const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite',
  'WebSearch', 'WebFetch', 'AskUserQuestion', 'Task',
]);

/** Пишущие инструменты — риск зависит от того, куда пишут. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

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
  return abs === root || abs.startsWith(`${root}/`);
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
): Verdict {
  // Наши собственные инструменты офиса безопасны по построению.
  if (toolName.startsWith('mcp__')) {
    return { risk: 'safe', reason: '', summary: toolName, detail: '', key: toolName };
  }

  if (SAFE_TOOLS.has(toolName)) {
    return { risk: 'safe', reason: '', summary: toolName, detail: '', key: toolName };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const path = input.file_path ?? input.notebook_path;
    const outside = !insideProject(path, projectDir);
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

  // Незнакомый инструмент — считаем пишущим, пусть решает пользователь.
  return {
    risk: 'write',
    reason: t(lang, 'perm.reason.unknownTool'),
    summary: toolName,
    detail: clip(JSON.stringify(input), 400),
    key: toolName,
  };
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

/** Решение по уже классифицированному вызову в заданном режиме. */
export function decide(mode: PermissionMode, risk: RiskLevel): Decision {
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

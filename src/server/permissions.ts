import { resolve, isAbsolute } from 'node:path';
import type { PermissionMode, RiskLevel } from '../shared/types';

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
const DANGEROUS_BASH: Array<{ re: RegExp; why: string }> = [
  { re: /(^|[\s;&|(])rm\b/,                         why: 'удаляет файлы' },
  { re: /(^|[\s;&|(])rmdir\b/,                      why: 'удаляет директории' },
  { re: /(^|[\s;&|(])(kill|pkill|killall)\b/,       why: 'завершает процессы' },
  { re: /(^|[\s;&|(])sudo\b/,                       why: 'запрашивает права root' },
  { re: /(^|[\s;&|(])(chmod|chown)\b/,              why: 'меняет права доступа' },
  { re: /(^|[\s;&|(])(dd|mkfs|fdisk)\b/,            why: 'низкоуровневая операция с диском' },
  { re: /(^|[\s;&|(])(shutdown|reboot|halt)\b/,     why: 'выключает систему' },
  { re: /git\s+push\b/,                             why: 'публикует изменения в удалённый репозиторий' },
  { re: /git\s+reset\s+--hard\b/,                   why: 'необратимо откатывает изменения' },
  { re: /git\s+clean\b/,                            why: 'удаляет неотслеживаемые файлы' },
  { re: /(npm|yarn|pnpm)\s+publish\b/,              why: 'публикует пакет' },
  { re: /(curl|wget)[^|;]*\|\s*(ba|z|fi)?sh\b/,     why: 'выполняет скачанный из сети скрипт' },
  { re: /(^|[\s;&|(])(shred|srm|truncate|unlink)\b/, why: 'необратимо затирает данные' },
  // Встроенный код в интерпретаторе обходит любую проверку текста команды:
  // именно так агент удалил файл после двух отказов на rm.
  { re: /(^|[\s;&|(])(python3?|node|perl|ruby|deno|bun|php|osascript)\s+(-e|-c|--eval|eval)\b/,
    why: 'выполняет встроенный код — содержимое не проверяется правилами команд' },
  { re: /-delete\b|(xargs|find)\b[^|;]*\b(rm|unlink)\b/, why: 'массовое удаление файлов' },
  { re: /\bhistory\s+-c\b/,                         why: 'очищает историю команд' },
  { re: /(^|[\s;&|(])mv\b/,                         why: 'перемещает файлы' },
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

export function classify(
  toolName: string,
  input: Record<string, unknown>,
  projectDir: string,
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
      reason: outside ? 'файл за пределами рабочей директории' : 'запись в файл проекта',
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
        reason: hit.why,
        summary: clip(command, 90),
        detail: command,
        key: `Bash:${first}`,
      };
    }
    return {
      risk: 'write',
      reason: 'команда в оболочке',
      summary: clip(command, 90),
      detail: command,
      key: `Bash:${first}`,
    };
  }

  // Незнакомый инструмент — считаем пишущим, пусть решает пользователь.
  return {
    risk: 'write',
    reason: 'незнакомый инструмент',
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

const MODE_LABEL: Record<PermissionMode, string> = {
  auto: 'полный доступ',
  'ask-risky': 'спрашивать только про необратимое',
  'ask-writes': 'спрашивать про любую запись',
  readonly: 'только чтение',
};

export function modeLabel(mode: PermissionMode): string {
  return MODE_LABEL[mode];
}

/**
 * Строка в ленту офиса про действие, прошедшее без вопроса. Человек видит её
 * постфактум, поэтому в ней должно быть видно и инструмент, и что он сделал.
 */
export function autoApprovedText(
  mode: PermissionMode,
  toolName: string,
  verdict: Verdict,
): string {
  // У Write/Edit summary уже начинается с имени инструмента — не дублируем.
  const what = verdict.summary.startsWith(toolName)
    ? verdict.summary
    : `${toolName}: ${verdict.summary || '—'}`;
  const why = verdict.reason ? ` (${verdict.reason})` : '';
  return `Без вопроса, режим «${MODE_LABEL[mode]}» — ${what}${why}`;
}

/**
 * Тексты, которые офис САМ кладёт в git проекта и на GitHub: сообщения
 * коммитов (слияние задачи, подтягивание базы, коммиты за исполнителя,
 * выпуск), аннотации тегов, заголовок и тело пулл-реквеста.
 *
 * Это артефакты проекта, поэтому язык у них — язык РЕАЛИЗАЦИИ офиса
 * (`state.codeLang()`), а не язык общения: договариваться по-русски и вести
 * историю git по-английски — обычное требование к репозиторию. Язык берётся
 * в момент коммита: сменили настройку — новые коммиты идут на новом языке,
 * старую историю никто не переписывает.
 *
 * Шаблоны собраны здесь, а не в общих словарях i18n: так видно разом всё, что
 * уходит в историю, и нельзя по ошибке взять фразу на языке общения. Языков
 * шаблонов два; для любого другого языка реализации — английский.
 *
 * Технические части не переводятся и подставляются как есть: номера задач
 * (T-N), имена веток, версии, хеши. Префикс «T-N: » у коммитов задачи
 * одинаков на всех языках — по нему задачу находят в истории (`taskCommitRe`,
 * `findMergeCommit`).
 */
import type { Vars } from '../shared/i18n';

/** Языки, на которых есть шаблоны. */
export const VCS_LANGS = ['ru', 'en'] as const;
export type VcsLang = (typeof VCS_LANGS)[number];

/** Запасной язык: для языка реализации без своих шаблонов. */
export const VCS_FALLBACK: VcsLang = 'en';

/** Язык шаблонов по языку реализации: свой, если есть, иначе запасной. */
export function vcsLang(lang: unknown): VcsLang {
  const code = typeof lang === 'string' ? lang.trim().toLowerCase().split(/[-_]/)[0] : '';
  return (VCS_LANGS as readonly string[]).includes(code ?? '') ? code as VcsLang : VCS_FALLBACK;
}

const en = {
  /** Первый коммит репозитория, который офис создал сам. */
  initCommit: 'Initial state of the working directory',
  /** Заголовок коммита задачи: squash в основную, автокоммит сданной работы, PR. */
  taskSubject: '{task}: {title}',
  /** Подтягивание базовой ветки в ветку задачи (узел sync-base). */
  syncMerge: "Merge branch '{base}' into {branch}",
  /** Слияние ветки без squash: ветка выпуска обратно в основную, вниз по каналам. */
  branchMerge: "Merge branch '{branch}' into {base}",
  /** Офис доводит за автора незавершённое слияние с базой. */
  settleMerge: '{task}: merge with {base}',
  settleRework: '{task}: rework after review',
  settleFixChecks: '{task}: fixing the checks',
  /** Шаг процесса: имя узла — идентификатор, не переводится. */
  settleStep: '{task}: {node}',
  /** Коммиты за исполнителя, когда работа прервана. */
  partialCancelled: '{task}: task dropped, saving what was done',
  partialStopped: '{task}: partial work (stopped)',
  partialBudget: '{task}: partial work (stopped by the spending guard)',
  partialLimited: '{task}: partial work (plan limit)',
  /** Коммит доработки по ревью. */
  rework: '{task}: rework',
  /** Коммит подъёма версии в ветке выпуска; он же заголовок аннотации тега. */
  release: 'Release {target} {version}',
  /** Публикация своего агента в репозиторий владельца. */
  agentPublish: '{name}@{version}: publish an office agent',
  /** Тело пулл-реквеста. */
  prTask: '**Task {task}: {title}**',
  prCriteria: 'Acceptance criteria ({done} of {total} ticked):',
  prReport: 'The worker’s report:',
  prAssumed: 'Author’s decisions:',
  prLeft: 'Left undone:',
  prFooter: '_This pull request was opened automatically by AI Office._',
};

export type VcsKey = keyof typeof en;

const ru: Record<VcsKey, string> = {
  initCommit: 'Начальное состояние рабочей директории',
  taskSubject: '{task}: {title}',
  syncMerge: 'Слияние ветки «{base}» в {branch}',
  branchMerge: 'Слияние ветки «{branch}» в {base}',
  settleMerge: '{task}: слияние с {base}',
  settleRework: '{task}: доработка по ревью',
  settleFixChecks: '{task}: починка проверок',
  settleStep: '{task}: {node}',
  partialCancelled: '{task}: задача снята, сохраняю сделанное',
  partialStopped: '{task}: частичная работа (остановлено)',
  partialBudget: '{task}: частичная работа (остановлено предохранителем расхода)',
  partialLimited: '{task}: частичная работа (лимит плана)',
  rework: '{task}: доработка',
  release: 'Выпуск {target} {version}',
  agentPublish: '{name}@{version}: публикация своего агента офиса',
  prTask: '**Задача {task}: {title}**',
  prCriteria: 'Критерии готовности (отмечено {done} из {total}):',
  prReport: 'Отчёт исполнителя:',
  prAssumed: 'Решения автора:',
  prLeft: 'Не сделано:',
  prFooter: '_Пулл-реквест открыт офисом AI Office автоматически._',
};

const TEMPLATES: Record<VcsLang, Record<VcsKey, string>> = { en, ru };

/**
 * Текст по шаблону на языке реализации. Подстановки идут как есть: перевода
 * у них нет — это идентификаторы, имена веток и заголовки, написанные людьми.
 */
export function vcsText(lang: unknown, key: VcsKey, vars: Vars = {}): string {
  return TEMPLATES[vcsLang(lang)][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    (name in vars ? String(vars[name]) : whole));
}

/** Заголовок коммита задачи «T-N: заголовок» — заголовок в одну строку. */
export function taskSubject(lang: unknown, taskId: string, title: string): string {
  return vcsText(lang, 'taskSubject', { task: taskId, title: title.replace(/\s+/g, ' ').trim() });
}

/** Сколько тела из отчёта уезжает в сообщение коммита: пара строк, не отчёт целиком. */
const BODY_MAX = 280;
const BODY_WIDTH = 72;

/**
 * Сообщение коммита задачи в основной ветке: «T-N: заголовок», пустая строка и
 * первый абзац отчёта, если он есть. По префиксу «T-N:» задачу потом находят
 * в истории (`taskCommitRe`), поэтому формат заголовка менять нельзя.
 *
 * Из отчёта берём только первый абзац и режем по слову: хвосты вроде
 * «⚠️ дубль правки» и списки файлов — это мусор для истории git.
 */
export function taskCommitMessage(
  taskId: string, title: string, report?: string | null, lang: unknown = VCS_FALLBACK,
): string {
  const subject = taskSubject(lang, taskId, title);
  const para = (report ?? '').trim().split(/\n\s*\n/)[0] ?? '';
  let body = para.replace(/\s+/g, ' ').trim();
  if (!body || body.startsWith('⚠️')) return subject;
  if (body.length > BODY_MAX) {
    const cut = body.slice(0, BODY_MAX);
    body = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), BODY_MAX / 2)).trimEnd()}…`;
  }
  const lines: string[] = [];
  let line = '';
  for (const word of body.split(' ')) {
    if (line && line.length + 1 + word.length > BODY_WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return `${subject}\n\n${lines.join('\n')}`;
}

/** Аннотация тега выпуска: заголовок как у коммита выпуска, ниже заметки. */
export function releaseTagMessage(lang: unknown, target: string, version: string, notes: string): string {
  const head = vcsText(lang, 'release', { target, version });
  return notes.trim() ? `${head}\n\n${notes}` : head;
}

/**
 * Начала заголовков коммитов выпуска на всех языках шаблонов: офис узнаёт
 * свои коммиты в истории, даже если их писали до смены языка реализации.
 */
export function releaseSubjects(target: string): string[] {
  return VCS_LANGS.map((lang) => `${vcsText(lang, 'release', { target, version: '' }).trimEnd()} `);
}

export interface PrBodyInput {
  taskId: string;
  title: string;
  description: string;
  criteria: { text: string; done: boolean }[];
  report?: string | null;
  assumed?: string | null;
  left?: string | null;
}

/** Тело пулл-реквеста задачи. Заголовок PR — `taskSubject`. */
export function prBody(lang: unknown, p: PrBodyInput): string {
  const done = p.criteria.filter((c) => c.done).length;
  return [
    vcsText(lang, 'prTask', { task: p.taskId, title: p.title }),
    '',
    p.description,
    '',
    p.criteria.length
      ? `${vcsText(lang, 'prCriteria', { done, total: p.criteria.length })}\n` +
        p.criteria.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')
      : '',
    '',
    p.report ? `${vcsText(lang, 'prReport')}\n${p.report}` : '',
    p.assumed ? `\n${vcsText(lang, 'prAssumed')}\n${p.assumed}` : '',
    p.left ? `\n${vcsText(lang, 'prLeft')}\n${p.left}` : '',
    '',
    vcsText(lang, 'prFooter'),
  ].filter(Boolean).join('\n');
}

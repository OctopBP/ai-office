/**
 * Ритуалы офиса (docs/design/living-office/spec.md §5): то, что офис делает
 * не по задаче, а по расписанию, глядя на самого себя.
 *
 * Планёрка — единственный ритуал, который смотрит вперёд, а не назад, и
 * единственный, которому не нужна модель: она собирается из данных доски.
 * Показывается при первом открытии офиса за день — «первое открытие» здесь
 * значит первый снапшот, ушедший клиенту в этот день, а не старт сервера:
 * офис, поднятый на ночь, никому ничего не говорит, пока его не откроют.
 */
import { dayKey, OFFICE_SENDER } from '../shared/types';
import { LANG_LOCALE } from '../shared/i18n';
import type { OfficeState } from './state';

/** Если планёрки ещё не было ни разу — «с прошлой» значит «за сутки». */
const FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;

const clip = (s: string, n = 120): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** Пора ли показывать планёрку: день сменился с прошлой. */
export const standupDue = (state: OfficeState, now = Date.now()): boolean =>
  state.life.standupDay !== dayKey(now);

/**
 * Текст планёрки из данных доски: что ждёт человека, что офис сделал сам с
 * прошлого раза, что встало. Пустые разделы не печатаются — сообщение должно
 * читаться за десять секунд, иначе его перестанут читать вовсе.
 */
export function standupText(state: OfficeState, now = Date.now()): string {
  const say = state.say.bind(state);
  const tasks = [...state.tasks.values()];
  const lines: string[] = [say('life.standup.head', {
    date: new Date(now).toLocaleDateString(LANG_LOCALE[state.lang()], {
      weekday: 'long', day: 'numeric', month: 'long',
    }),
  })];

  // 1. Что ждёт именно человека: без него это не сдвинется.
  const waiting: string[] = [];
  const permissions = state.pendingRequests().length;
  if (permissions) waiting.push(say('life.standup.permissions', { n: permissions }));
  const unmerged = tasks.filter((t) => t.status === 'done' && t.branch && !t.merged).length;
  if (unmerged && !state.settings.autoPipeline) waiting.push(say('life.standup.unmerged', { n: unmerged }));
  for (const epic of state.epicList()) {
    if (epic.status === 'planned' && !epic.approved) {
      waiting.push(say('life.standup.approval', { epic: epic.id, title: epic.title }));
    }
  }
  if (waiting.length) lines.push('', say('life.standup.waiting'), ...waiting);

  // 2. Что случилось с прошлой планёрки — по исходам, а не по статусам.
  const since = state.life.standupAt ?? now - FIRST_WINDOW_MS;
  const closed = tasks.filter((t) => t.outcome && t.outcome.at >= since).map((t) => t.outcome!);
  const count = (kind: string) => closed.filter((o) => o.kind === kind).length;
  const delivered = count('clean') + count('reworked') + count('stuck');
  const done: string[] = [];
  if (delivered) {
    done.push(say('life.standup.closed', {
      n: delivered, clean: count('clean'), reworked: count('reworked'), stuck: count('stuck'),
    }));
  }
  if (count('failed')) done.push(say('life.standup.failed', { n: count('failed') }));
  if (count('reverted')) done.push(say('life.standup.reverted', { n: count('reverted') }));
  const byOffice = closed.filter((o) => o.origin === 'office').length;
  if (byOffice) done.push(say('life.standup.byOffice', { n: byOffice }));
  if (done.length) lines.push('', say('life.standup.since'), ...done);

  // 3. Что встало: конвейер сам дальше не поедет.
  const stuck = [...state.prs.values()].filter((pr) => pr.stage === 'stuck');
  if (stuck.length) {
    lines.push('', say('life.standup.stuckHead'), ...stuck.map((pr) => say('life.standup.stuckRow', {
      task: pr.taskId, title: pr.title, note: clip(pr.note),
    })));
  }

  if (lines.length === 1) lines.push(say('life.standup.quiet'));
  return lines.join('\n');
}

/** Показать планёрку и запомнить, что сегодня она была. */
export function runStandup(state: OfficeState, now = Date.now()): string {
  const text = standupText(state, now);
  state.addChat(OFFICE_SENDER, text);
  state.addLog(null, 'system', state.say('life.standup.log'));
  state.touchLife({ standupDay: dayKey(now), standupAt: now });
  return text;
}

/**
 * Офис открыли — кто-то на него смотрит. Первый взгляд за день получает
 * планёрку; остальные — ничего: это не приветствие, а сводка.
 */
export function noteOfficeViewed(state: OfficeState, now = Date.now()): void {
  if (!state.opened) return;
  if (standupDue(state, now)) runStandup(state, now);
}

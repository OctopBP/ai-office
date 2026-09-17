import { setFlowAgents, type DecideOutput } from './flows';
import type { FeatureProposal } from './initiatives';
import { TASK_TYPES } from '../shared/workflow';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MessageQueue } from './queue';
import {
  criteriaProgress, loadedOffices, onRoleSetChanged, onWorkerLimitChanged, taskRepo,
  totalRunningWorkers, worktreesRoot,
  type Instance, type OfficeState, type Task,
} from './state';
import { DEFAULT_PROCESS_WORKERS, emptyUsage, OFFICE_SENDER } from '../shared/types';
import { LANG_NAME_EN, type Lang, type Vars } from '../shared/i18n';
import { t, type ServerKey } from './i18n';
import type { MeetingView, PrStage, PullRequestView, ReviewVerdict } from '../shared/types';
import { cloudProblem, runCloudTask, stopCloudTask } from './cloud';
import type { Role } from './roles';
import { externalMcp, mcpBrief } from './mcp';
import { employeePlugins, employeeSkills, sessionTools } from './skills';
import { autoApprovedText, classify, decide, effectiveMode } from './permissions';
import { commitAll, createWorktree, diffBranch, hasCommits, hasWork, isRepo, preserveBranch, removeWorktree } from './git';
import {
  approveEpic, cancelEpic, createPlan, dispatch, planSummary, reorderEpics, setPlanAgents,
  type PlannedEpic,
} from './plan';
import {
  prDiff, retryPipeline, runPipeline, setPipelineAgents, maxRounds,
  type StepOutcome, type StepRequest,
  type ReviewOutcome, type ReworkOutcome,
} from './review';
import { closeIfDone, recordOutcome } from './outcomes';
import { journalBrief } from './journal';
import { answerFromChat, askOwner } from './questions';
import {
  setRitualAgents, type ConsolidationInput, type ReflectionOutput, type RitualOutput,
} from './rituals';
import { resolveModel } from '../shared/models';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';

/**
 * Общий потолок одновременных сессий исполнителей на весь процесс. Лимит из
 * настроек — пер-офисный, и трёх открытых офисов хватало, чтобы платить втрое
 * больше, ничего для этого не сделав. Здесь считается сумма по всем офисам.
 *
 * Значение берётся из окружения при каждой проверке: сервер поднимают
 * скриптом, и потолок для конкретного прогона задаётся там же, где остальные
 * переменные, — своей настройки в UI у него нет, потому что настройки живут
 * в офисе, а этот потолок офису не принадлежит.
 */
export function processWorkerCap(): number {
  const raw = Number(process.env.OFFICE_MAX_WORKERS);
  if (!Number.isFinite(raw)) return DEFAULT_PROCESS_WORKERS;
  const n = Math.floor(raw);
  return n < 1 ? DEFAULT_PROCESS_WORKERS : n;
}

/**
 * Есть ли свободный слот исполнителя. Возвращает причину отказа по-русски
 * (её увидит человек в ленте офиса) или null, если запускать можно.
 *
 * Считаются только сессии исполнителей: менеджер под лимит не попадает —
 * иначе на потолке офис переставал бы отвечать, а это выглядит как поломка,
 * а не как экономия. Сессии конвейера (ревью, доработка, разбор конфликта)
 * слот занимают, но через эту проверку не проходят: они продолжают уже
 * начатую работу, и держать их в очереди значило бы копить незакрытые
 * пулл-реквесты ради экономии, которой всё равно не будет.
 */
export function slotProblem(state: OfficeState): string | null {
  const limit = state.workerLimit();
  if (state.running >= limit) {
    return state.say('agent.slot.office', { n: state.running, limit });
  }
  const total = totalRunningWorkers();
  const cap = processWorkerCap();
  if (total >= cap) {
    return state.say('agent.slot.process', { n: total, cap });
  }
  return null;
}

/**
 * Поставить задачу в очередь за слотом. Не отказ: задача остаётся на доске
 * и стартует сама, как только слот освободится. Сообщение в ленту пишем
 * один раз на постановку — иначе надзор, дёргающий раздачу каждый проход,
 * забил бы ленту одним и тем же.
 */
function queueForSlot(state: OfficeState, task: Task, problem: string): void {
  if (state.waitingForSlot.has(task.id)) return;
  state.waitingForSlot.add(task.id);
  state.addChat(OFFICE_SENDER,
    state.say('agent.queue.chat', { task: task.id, title: task.title, problem }));
  state.addLog(null, 'system', state.say('agent.queue.log', { task: task.id }));
}

/**
 * Слот занят/освобождён. Отдельные функции, а не правка счётчика на месте:
 * освобождение обязано ещё и подтолкнуть очередь, а мест, где сессия
 * заканчивается, три — и разойтись они не должны. Освобождение экспортируется
 * ради проверок состояния: они гоняют ровно тот путь, что и живые сессии.
 */
function occupySlot(state: OfficeState): void {
  state.running += 1;
  state.setBusy(true);
}

export function releaseSlot(state: OfficeState): void {
  state.running = Math.max(0, state.running - 1);
  if (state.running === 0) state.setBusy(false);
  // Освободившийся слот отдаём ждущим не в этом же тике: сессия ещё
  // доигрывает свой finally, и стартовать поверх неё рано.
  setTimeout(() => {
    // Порядок важен: сначала те, кто уже стоял в очереди за слотом, и только
    // потом созревшие задачи плана. Иначе свежая задача обгоняла бы ту,
    // которую офис пообещал запустить раньше.
    startWaiting();
    // Исполнитель освободился — самое время посмотреть, не созрело ли
    // следующее звено плана. Именно так «бэкенд закрыл свои задачи по фиче»
    // превращается в «бэкенд взял задачу из следующей»: никто никого не
    // переключает, просто в ранней фиче для его роли работы больше нет.
    dispatch(state);
  }, 0);
}

/**
 * Раздать освободившиеся слоты тем, кто их ждёт. Идём по всем офисам, а не
 * только по открытому: слот освободился в одном офисе, а ждать его может
 * задача в соседнем — общий потолок на то и общий.
 */
function startWaiting(): void {
  for (const state of loadedOffices()) {
    if (state.waitingForSlot.size === 0) continue;
    for (const taskId of [...state.waitingForSlot]) {
      const task = state.tasks.get(taskId);
      // Задачу могли удалить, назначить вручную или закрыть, пока она ждала.
      if (!task || task.status !== 'backlog' || task.assigneeId) {
        state.waitingForSlot.delete(taskId);
        continue;
      }
      if (slotProblem(state)) return;      // мест снова нет — ждём следующего освобождения
      const outcome = officeAssign(state, taskId);
      if (!outcome.ok) return;             // пауза, бюджет, некому взять — попробуем позже
      state.addChat(OFFICE_SENDER, state.say('agent.queue.started', {
        task: taskId, title: task.title, message: outcome.message,
      }));
    }
  }
}

// Подъём лимита в настройках отпускает очередь сразу: ждать, пока кто-то
// доработает, человеку, который только что поднял лимит, объяснить нельзя.
onWorkerLimitChanged(startWaiting);

/**
 * Бриф проекта — OFFICE.md в рабочей директории. Он идёт во все сессии: у PM
 * вообще нет доступа к файлам, и без брифа он декомпозирует вслепую, а
 * исполнителю CLAUDE.md проекта не достаётся (settingSources пуст намеренно).
 *
 * Читаем на каждом старте сессии, а не при запуске сервера: правку брифа
 * подхватит следующая задача, перезапускать офис не нужно.
 */
const BRIEF_LIMIT = 8000;

/**
 * Изоляция веткой возможна только в репозитории с историей. Раньше хватало
 * одного флага на офис, но у ролей репозитории разные, и проверять надо тот,
 * в котором роль работает.
 */
async function repoReady(state: OfficeState, dir: string): Promise<boolean> {
  if (dir === state.projectDir) return state.gitReady;
  return (await isRepo(dir)) && (await hasCommits(dir));
}

/**
 * Бриф проекта плюс журнал офиса (docs/design/living-office/spec.md §4.2).
 * Журнал едет туда же, куда OFFICE.md, и по той же причине: следующая
 * сессия получает его первым сообщением, а не полагается на память прошлой.
 * `roleId` решает, какие записи роль видит: общие и свои; null — менеджер,
 * ему вместо своих достаются офисные.
 */
function projectBrief(state: OfficeState, roleId: string | null = null): string {
  let brief = '';
  try {
    const text = readFileSync(resolve(state.projectDir, 'OFFICE.md'), 'utf8').trim();
    if (text) {
      const body = text.length > BRIEF_LIMIT
        ? `${text.slice(0, BRIEF_LIMIT)}\n${state.say('prompt.brief.clipped')}`
        : text;
      brief = `\n\n${state.say('prompt.brief.header')}\n${body}`;
    }
  } catch {
    // брифа нет — работаем как раньше
  }
  return brief + journalBrief(state, roleId);
}

/**
 * Песочница ОС для исполнителей (на macOS — встроенный Seatbelt, ставить нечего).
 * Второй слой защиты, а не замена модалки разрешений: песочница держит границу
 * по файлам и сети, но не мешает послать сигнал процессу (kill) или сделать
 * git push. Эти действия по-прежнему ловит классификатор рисков.
 *
 * По умолчанию запись разрешена только в рабочую директорию сессии (cwd) и
 * временную папку — то есть в workspace/, и никуда больше.
 */
const SANDBOX = {
  enabled: true,
  // Не притворяться защищёнными: если песочница недоступна, лучше упасть,
  // чем молча выполнять команды без изоляции.
  failIfUnavailable: true,
  // Убрать аварийный люк dangerouslyDisableSandbox.
  allowUnsandboxedCommands: false,
  // По умолчанию true — тогда песочница отключает подтверждения для Bash
  // и модалка перестаёт срабатывать. Нам нужны оба слоя.
  autoAllowBashIfSandboxed: false,
} as const;

// ---------------------------------------------------------------- утилиты

const base = (p: unknown): string => String(p ?? '').split('/').filter(Boolean).pop() ?? String(p ?? '');
const clip = (s: unknown, n = 70): string => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

/** Короткая подпись действия — то, что видно в пузыре над головой. */
function toolBrief(name: string, input: Record<string, unknown>, lang: Lang): string {
  const say = (key: ServerKey, what: unknown): string => t(lang, key, { what: String(what) });
  switch (name) {
    case 'Read':      return say('bubble.read', base(input.file_path));
    case 'Write':     return say('bubble.write', base(input.file_path));
    case 'Edit':      return say('bubble.edit', base(input.file_path));
    case 'Bash':      return `$ ${clip(input.command, 48)}`;
    case 'Glob':      return say('bubble.glob', clip(input.pattern, 30));
    case 'Grep':      return say('bubble.grep', clip(input.pattern, 30));
    case 'TodoWrite': return t(lang, 'bubble.todo');
    case 'WebSearch': return say('bubble.search', clip(input.query, 30));
    // Публикация макета — заметное действие, и в пузыре у него своё слово:
    // «неизвестный инструмент» над головой дизайнера ничего не объясняет.
    case 'Artifact':  return say('bubble.artifact', clip(input.title ?? base(input.file_path), 30));
    default: {
      if (name.startsWith('mcp__')) {
        const short = name.split('__').pop() ?? name;
        if (short === 'say') return clip(input.text, 70);
        if (short === 'create_task') return say('bubble.createTask', clip(input.title, 40));
        if (short === 'assign_task') return say('bubble.assignTask', input.taskId);
        if (short === 'finish_task') return t(lang, 'bubble.finishTask');
        if (short === 'list_team') return t(lang, 'bubble.listTeam');
        if (short === 'get_board') return t(lang, 'bubble.getBoard');
        return short;
      }
      return name;
    }
  }
}

/** Успешный результат: мало проверить subtype — SDK возвращает
 *  subtype 'success' с is_error: true, например при протухшей авторизации. */
function isOk(msg: Extract<SDKMessage, { type: 'result' }>): msg is SDKResultSuccess {
  return msg.subtype === 'success' && !msg.is_error;
}

/** Человекочитаемая причина завершения сессии. */
function resultReason(msg: Extract<SDKMessage, { type: 'result' }>, lang: Lang): string {
  if (msg.subtype === 'error_max_budget_usd') {
    return t(lang, 'agent.result.budget');
  }
  // Про лимит ходов SDK пишет «Reached maximum number of turns (60)», и по
  // этой строке не догадаться, что цифра настраивается. Говорим прямо — иначе
  // человек решает, что упёрся в потолок Claude Code.
  if (msg.subtype === 'error_max_turns') {
    return t(lang, 'agent.result.maxTurns');
  }
  if ('result' in msg && typeof msg.result === 'string' && msg.result.trim()) return msg.result;
  return msg.subtype;
}

/**
 * Разбор потока сообщений SDK в состояние офиса и события UI.
 *
 * Офис передаётся явно, а не ищется по «текущему»: сессия живёт минутами, и
 * пользователь за это время может открыть другой офис — тогда состояние агента
 * и его расход уехали бы в чужой офис, где такого исполнителя может и не быть.
 *
 * `rememberSession` выключают короткоживущие сессии, которые не должны стать
 * «главным разговором» агента: иначе после перезапуска офис продолжит их,
 * а не переписку, ради которой сессия заводилась (см. совещание).
 */
function consume(
  state: OfficeState, instanceId: string, msg: SDKMessage, rememberSession = true,
): void {
  // Запоминаем id сессии, чтобы продолжить разговор после перезапуска сервера.
  if (msg.type === 'system' && msg.subtype === 'init') {
    if (rememberSession) state.setSessionId(instanceId, msg.session_id);
    return;
  }

  if (msg.type === 'assistant') {
    for (const block of msg.message.content ?? []) {
      if (block.type === 'thinking') {
        state.setState(instanceId, 'thinking', state.say('agent.state.thinking'));
      } else if (block.type === 'text') {
        const text = block.text?.trim();
        if (text) state.addLog(instanceId, 'text', clip(text, 400));
      } else if (block.type === 'tool_use') {
        const brief = toolBrief(block.name, block.input as Record<string, unknown>, state.lang());
        state.setState(instanceId, 'working', brief);
        state.addLog(instanceId, 'tool', `${block.name}: ${brief}`);
      }
    }
    if (msg.error) {
      state.addLog(instanceId, 'error', state.say('agent.log.modelError', { error: String(msg.error) }));
    }
    return;
  }

  // Лимит плана подписки. Событие приходит само по ходу работы — своих
  // запросов офис за ним не делает: спрашивать SDK о лимите можно только на
  // живой сессии, а поднимать её ради шкалы значит тратить лимит, чтобы на
  // него посмотреть.
  if (msg.type === 'rate_limit_event') {
    state.noteRateLimit(msg.rate_limit_info);
    return;
  }

  if (msg.type === 'result') {
    const usage = 'usage' in msg ? msg.usage : undefined;
    // Кеш держим отдельной строкой, а не подмешиваем во ввод: он в разы
    // дешевле, и без разделения расход выглядит необъяснимым.
    state.addUsage(instanceId, {
      costUsd: msg.total_cost_usd ?? 0,
      tokensIn: usage?.input_tokens ?? 0,
      tokensOut: usage?.output_tokens ?? 0,
      cacheRead: usage?.cache_read_input_tokens ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    });
    if (!isOk(msg)) {
      const reason = resultReason(msg, state.lang());
      state.addLog(instanceId, 'error',
        state.say('agent.log.sessionFailed', { reason: clip(reason, 200) }));
    }
  }
}

/**
 * Единственная точка, через которую проходит КАЖДЫЙ вызов инструмента.
 * Решает сама, если действие безопасно; иначе поднимает модалку пользователю
 * и блокирует агента до ответа.
 */
function permissionHandler(
  /**
   * Офис сессии. Передаётся явно: сессия живёт минутами, а пользователь за это
   * время может уйти в другой офис — вопрос о разрешении обязан всплыть там,
   * где идёт работа, и в его же ленте.
   */
  state: OfficeState,
  instanceId: string,
  taskId: string | null = null,
  /** Рабочая директория агента: у изолированной задачи это её worktree. */
  workdir: string = state.projectDir,
) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): Promise<PermissionResult> => {
    const inst = state.instances.get(instanceId);
    const role = inst ? state.role(inst.roleId) : undefined;
    // Режим сотрудника сильнее режима роли, режим роли — сильнее офисного:
    // офис здесь фолбэк для тех, у кого своего нет (permissionMode === null).
    // Так «бэкенду полный доступ, остальные спрашивают» задаётся одной ролью
    // или одним человеком, не трогая офис целиком.
    //
    // Офисный режим берём у state сессии, а не у глобального office: пока
    // сессия работает, пользователь может уйти в другой офис, и его режим
    // к этой работе отношения не имеет.
    const mode = effectiveMode(inst?.permissionMode, role?.permissionMode, state.officeMode());

    // Пауза офиса: сессия не убивается, а замирает перед следующим действием.
    // Это единственная точка, через которую проходит любой вызов инструмента,
    // поэтому здесь пауза и живёт — отдельного «стоп-крана» не нужно.
    //
    // Менеджер не замирает: на паузе с ним по-прежнему можно разговаривать
    // и планировать. Запускать работу он всё равно не сможет — assign_task
    // на паузе отказывает и объясняет почему.
    if (state.paused && inst && !role?.isManager) {
      const wasState = inst.state;
      const wasNote = inst.note;
      state.setState(instanceId, 'paused', state.say('agent.state.paused'));
      state.addLog(instanceId, 'system', state.say('agent.log.pause', { tool: toolName }));
      await state.whenResumed(options.signal);
      if (options.signal.aborted) {
        return { behavior: 'deny', message: state.say('agent.deny.paused') };
      }
      state.setState(instanceId, wasState, wasNote);
    }

    const verdict = classify(toolName, input, workdir, state.lang());

    if (verdict.risk === 'safe') {
      return { behavior: 'allow', updatedInput: input };
    }

    // Явный запрет пользователя сильнее любого режима: режим — это про то,
    // о чём не спрашивать, а не про право отменить уже сказанное «никогда».
    if (role && state.isAlwaysDenied(role.id, verdict.key)) {
      return {
        behavior: 'deny',
        message: state.say('agent.deny.sessionBan', { key: verdict.key }),
      };
    }

    const byMode = decide(mode, verdict.risk);

    if (byMode === 'deny') {
      return {
        behavior: 'deny',
        message: state.say('agent.deny.readonly'),
      };
    }

    // Действие небезопасно само по себе, но режим доступа разрешает его без
    // вопроса — это стоит зафиксировать в ленте отдельной строкой, а не молчать.
    //
    // Отдельной строкой отмечаем только необратимое (risk === 'danger'):
    // обычная запись и обычная команда и так видны в ленте строкой вызова
    // инструмента, а вторая строка на каждый Write превратила бы след
    // в шум, в котором настоящее «удалил файлы» уже не разглядеть.
    if (byMode === 'allow') {
      if (verdict.risk === 'danger') {
        state.addLog(instanceId, 'system',
          autoApprovedText(mode, toolName, verdict, state.lang()), true);
      }
      return { behavior: 'allow', updatedInput: input };
    }

    // «Разрешать всегда» пользователь нажал сам — такие вызовы в ленту не пишем:
    // это не автоодобрение по режиму, а его же решение, уже записанное раньше.
    if (role && state.isAlwaysAllowed(role.id, verdict.key)) {
      return { behavior: 'allow', updatedInput: input };
    }

    const prevState = inst?.state ?? 'working';
    const prevNote = inst?.note ?? null;
    state.setState(instanceId, 'waiting_approval',
      state.say('agent.state.waitingApproval', { what: verdict.summary }));
    state.addLog(instanceId, 'system',
      state.say('agent.log.asksPermission', { tool: toolName, reason: verdict.reason }));

    const decision = await state.requestPermission(
      {
        agentId: instanceId,
        taskId,
        toolName,
        summary: verdict.summary,
        detail: verdict.detail,
        risk: verdict.risk,
        reason: verdict.reason,
        key: verdict.key,
      },
      options.signal,
    );

    state.setState(instanceId, prevState, prevNote);

    if (decision === 'deny' || decision === 'never') {
      state.addLog(instanceId, 'system', state.say('agent.log.userDenied', { what: verdict.summary }));
      return { behavior: 'deny', message: state.say('agent.deny.user') };
    }

    state.addLog(instanceId, 'system', state.say('agent.log.userAllowed', { what: verdict.summary }));
    return { behavior: 'allow', updatedInput: input };
  };
}

// ---------------------------------------------------------------- PM

/**
 * Доска задач текстом — по строке на задачу. Нужна в двух местах: инструменту
 * get_board и реплике менеджера на совещании. Файлов менеджер не видит, и доска
 * для него — единственный способ говорить о делах предметно, а не общими словами.
 */
/** Стадии конвейера словами: их читает менеджер, а не интерфейс. */
const stageText = (stage: PrStage, lang: Lang): string => t(lang, `pr.stage.${stage}`);

function boardSummary(state: OfficeState): string {
  const tasks = [...state.tasks.values()];
  // Направления — над планом: они объясняют, откуда взялись инициативы.
  const directions = directionsText(state);
  const plan = [
    directions ? `${state.say('prompt.board.directions')}\n${directions}` : '',
    planSummary(state),
  ].filter(Boolean).join('\n\n');
  if (!tasks.length) return plan || state.say('prompt.board.empty');
  const lang = state.lang();
  // План идёт первым: он объясняет, почему часть задач стоит, — без него
  // доска выглядит как список, где половина работ непонятно чего ждёт.
  const head = plan ? `${plan}\n\n` : '';
  return head + tasks.map((task) => {
    const { done, total } = criteriaProgress(task);
    const marks = task.criteria.map((c) => `${c.done ? '✓' : '·'} ${c.text}`).join('; ');
    const pr = state.prOf(task.id);
    return `${task.id} [${task.status}] ${task.title} → ${task.assigneeId ?? '—'}` +
      (pr ? `\n    ${state.say('prompt.board.review')}: ${stageText(pr.stage, lang)} — ${clip(pr.note, 160)}` : '') +
      (total ? `\n    ${state.say('prompt.board.criteria')} ${done}/${total}: ${clip(marks, 200)}` : '') +
      (task.result ? `\n    ${state.say('prompt.board.result')}: ${clip(task.result, 160)}` : '');
  }).join('\n');
}

/**
 * Системный промпт менеджера — на языке офиса. Отдельная функция, а не
 * константа: язык у каждого офиса свой, и один и тот же процесс держит
 * русский офис и английский одновременно.
 */
const pmPrompt = (state: OfficeState): string =>
  state.say('prompt.pm.system', { lang: LANG_NAME_EN[state.lang()] })
  + state.say('prompt.pm.life')
  + state.say('prompt.pm.directions', { directions: directionsText(state) || state.say('prompt.pm.noDirections') });

/** Направления словами — в бриф менеджера и на доску. */
function directionsText(state: OfficeState): string {
  return state.directionList().map((d) => state.say('prompt.board.directionRow', {
    id: d.id, text: d.text, paused: d.active ? '' : state.say('prompt.board.paused'),
  })).join('\n');
}

/**
 * Почему роли сейчас нельзя отдать задачу: в ней не осталось сотрудников.
 * Причину спрашивают и менеджер, и перезапуск задачи, а текст отказа должен
 * быть один — иначе пользователь получит два разных объяснения одного и того же.
 */
export function noStaffReason(roleId: string, state: OfficeState): string | null {
  if (state.staffOf(roleId).length > 0) return null;
  const title = state.role(roleId)?.title ?? roleId;
  return state.say('agent.noStaff', { role: roleId, title });
}

/**
 * Состав команды словами — то, что менеджер видит в list_team.
 * Вынесено из инструмента, чтобы регрессии этого текста ловились проверкой,
 * а не сценарием с живой моделью: от него зависит, кому PM раздаёт задачи.
 */
export function teamSummary(state: OfficeState): string {
  const lines = state.workerRoles().map((role) => {
    const insts = state.staffOf(role.id);
    // Роль без сотрудников — открытая вакансия: она есть в реестре, но
    // работать некому, пока пользователь не наймёт человека.
    const desc = insts.length
      ? insts.map((i) => `${i.id} — ${i.currentTaskId
        ? state.say('prompt.team.busy', { task: i.currentTaskId })
        : state.say('prompt.team.free')}`).join(', ')
      : state.say('prompt.team.vacant');
    const first = role.brief.split('\n')[0] ?? '';
    const repo = state.repoFor(role);
    // Репозиторий называем, только если он свой: иначе строка одинаковая
    // у всех и лишь удлиняет ответ.
    const where = repo === state.projectDir
      ? ''
      : `\n  ${state.say('prompt.team.repo')}: ${repo}`;
    const result = state.say(role.isolate ? 'prompt.team.isolated' : 'prompt.team.direct');
    return `- ${role.id} (${role.title})${first ? ` — ${first}` : ''}\n  ${desc}${where}` +
      `\n  ${state.say('prompt.team.result')}: ${result}`;
  });
  return `${state.say('prompt.team.header')}\n${lines.join('\n')}`;
}

/**
 * Инструменты менеджера. Собираются на каждый офис свои: менеджер покинутого
 * офиса продолжает разбирать отчёты, и его create_task/assign_task обязаны
 * ложиться на его доску, а не на ту, что человек открыл сейчас.
 */
const teamTools = (state: OfficeState) => createSdkMcpServer({
  name: 'team',
  version: '1.0.0',
  instructions: state.say('tool.team.instructions'),
  tools: [
    tool(
      'list_team',
      state.say('tool.listTeam.desc'),
      {},
      async () => ({ content: [{ type: 'text', text: teamSummary(state) }] }),
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'create_task',
      state.say('tool.createTask.desc'),
      {
        title: z.string().describe(state.say('tool.createTask.title')),
        description: z.string().describe(state.say('tool.createTask.description')),
        acceptanceCriteria: z.array(z.string()).describe(state.say('tool.createTask.criteria')),
        roleId: z.string().describe(state.say('tool.createTask.role', {
          roles: state.workerRoles().map((r) => `${r.id} (${r.title})`).join(', '),
        })),
        featureId: z.string().default('').describe(state.say('tool.createTask.feature')),
        dependsOn: z.array(z.string()).default([])
          .describe(state.say('tool.createTask.dependsOn')),
        type: z.enum([...TASK_TYPES, '']).default('').describe(state.say('tool.createTask.type')),
      },
      async (args) => {
        // Список ролей не дублируем в схеме: перечисление в enum уже один раз
        // разошлось с реальным реестром, и новые роли молча стали недоступны.
        const valid = state.workerRoles().map((r) => r.id);
        if (!valid.includes(args.roleId)) {
          return {
            content: [{
              type: 'text',
              text: state.say('tool.createTask.badRole', {
                role: args.roleId, valid: valid.join(', '),
              }),
            }],
            isError: true,
          };
        }
        const criteria = (args.acceptanceCriteria ?? []).map((c) => c.trim()).filter(Boolean);
        if (criteria.length === 0) {
          return {
            content: [{
              type: 'text',
              text: state.say('tool.createTask.noCriteria'),
            }],
            isError: true,
          };
        }
        const epicId = args.featureId?.trim() || null;
        if (epicId && !state.epics.get(epicId)) {
          return {
            content: [{ type: 'text', text: state.say('plan.err.noEpic', { epic: epicId }) }],
            isError: true,
          };
        }
        const deps = (args.dependsOn ?? []).map((d) => d.trim()).filter(Boolean);
        const unknown = deps.filter((d) => !state.tasks.has(d));
        if (unknown.length) {
          return {
            content: [{
              type: 'text',
              text: state.say('tool.createTask.badDep', { deps: unknown.join(', ') }),
            }],
            isError: true,
          };
        }
        // Задача в фиче или с зависимостями — плановая: её раздаст офис, когда
        // придёт её черёд. Одиночная задача, как и раньше, сразу в очередь на
        // раздачу — иначе простая просьба перестала бы работать без плана.
        const task = state.createTask({
          title: args.title,
          description: args.description,
          criteria,
          roleId: args.roleId,
          epicId,
          dependsOn: deps,
          status: epicId || deps.length ? 'planned' : 'backlog',
          order: epicId ? state.tasksOfEpic(epicId).length + 1 : undefined,
          ...(args.type ? { type: args.type } : {}),
        });
        // Предупреждаем сразу: иначе менеджер узнает о пустой роли только из
        // отказа assign_task и успеет пообещать пользователю работу.
        const empty = state.staffOf(args.roleId).length === 0
          ? state.say('tool.createTask.roleEmpty', { role: args.roleId })
          : '';
        const ok = state.say('tool.createTask.ok', {
          task: task.id, title: task.title, role: args.roleId, n: criteria.length,
        });
        // Плановую задачу офис раздаст сам — про это надо сказать прямо,
        // иначе менеджер вызовет на неё assign_task и запустит раньше срока.
        const planned = task.status === 'planned' ? state.say('tool.createTask.planned') : '';
        if (task.status === 'planned') dispatch(state);
        return { content: [{ type: 'text', text: `${ok}${empty}${planned}` }] };
      },
    ),

    tool(
      'assign_task',
      state.say('tool.assignTask.desc'),
      {
        taskId: z.string().describe(state.say('tool.assignTask.taskId')),
        instanceId: z.string().default('').describe(state.say('tool.assignTask.instanceId')),
      },
      async (args) => {
        if (state.paused) {
          return {
            content: [{
              type: 'text',
              text: state.say('tool.assignTask.paused'),
            }],
            isError: true,
          };
        }
        const cloudBlocked = state.settings.engine === 'cloud' ? cloudProblem(state) : null;
        if (cloudBlocked) {
          return {
            content: [{
              type: 'text',
              text: state.say('tool.assignTask.cloudBroken', { problem: cloudBlocked }),
            }],
            isError: true,
          };
        }
        if (state.budgetExhausted()) {
          const cap = state.settings.globalBudgetUsd;
          return {
            content: [{
              type: 'text',
              text: state.say('tool.assignTask.budget', {
                spent: state.totalCost().toFixed(2), cap: cap?.toFixed(2) ?? '—',
              }),
            }],
            isError: true,
          };
        }

        const task = state.tasks.get(args.taskId);
        if (!task) {
          return {
            content: [{ type: 'text', text: state.say('tool.assignTask.noTask', { task: args.taskId }) }],
            isError: true,
          };
        }
        if (task.assigneeId) {
          return {
            content: [{
              type: 'text',
              text: state.say('tool.assignTask.already', { task: task.id, who: task.assigneeId }),
            }],
            isError: true,
          };
        }
        const roleId = task.roleId ?? 'backend';
        // Роль, из которой уволили всех, не доукомплектовываем молча: сотрудников
        // убрал пользователь, и нанять обратно — тоже его решение, а не наше.
        // Явно названного исполнителя это не касается: он живой человек в офисе.
        const noStaff = args.instanceId ? null : noStaffReason(roleId, state);
        if (noStaff) {
          return {
            content: [{
              type: 'text',
              text: state.say('tool.assignTask.noStaff', { problem: noStaff, task: task.id }),
            }],
            isError: true,
          };
        }

        // Слот проверяем до выбора исполнителя: иначе ради задачи, которая
        // всё равно встанет в очередь, офис нанял бы ещё одного сотрудника.
        const noSlot = slotProblem(state);
        if (noSlot) {
          queueForSlot(state, task, noSlot);
          return {
            content: [{
              type: 'text',
              text: state.say('tool.assignTask.queued', { task: task.id, problem: noSlot }),
            }],
          };
        }

        const inst = args.instanceId
          ? state.instances.get(args.instanceId) ?? null
          : state.findFree(roleId) ?? state.spawn(roleId) ?? state.findFree(roleId);

        if (!inst) {
          return {
            content: [{
              type: 'text',
              text: args.instanceId
                ? state.say('tool.assignTask.noSuchWorker', { who: args.instanceId })
                : state.say('tool.assignTask.allBusy', { role: roleId }),
            }],
            isError: true,
          };
        }
        if (inst.currentTaskId) {
          return {
            content: [{
              type: 'text',
              text: state.say('tool.assignTask.workerBusy', { who: inst.id, task: inst.currentTaskId }),
            }],
            isError: true,
          };
        }

        startWorker(state, task, inst);
        return {
          content: [{
            type: 'text',
            text: state.say('tool.assignTask.ok', { task: task.id, who: inst.id }),
          }],
        };
      },
    ),

    tool(
      'review_status',
      state.say('tool.reviewStatus.desc'),
      {},
      async () => {
        const prs = [...state.prs.values()];
        if (!prs.length) {
          return { content: [{ type: 'text', text: state.say('tool.reviewStatus.empty') }] };
        }
        const text = prs
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((pr) => `${pr.taskId} «${pr.title}» — ${stageText(pr.stage, state.lang())}` +
            `${pr.rounds ? state.say('tool.reviewStatus.rounds', { n: pr.rounds }) : ''}` +
            `${pr.url ? `, ${pr.url}` : ''}\n    ${clip(pr.note, 200)}`)
          .join('\n');
        return { content: [{ type: 'text', text }] };
      },
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'retry_review',
      state.say('tool.retryReview.desc'),
      { taskId: z.string().describe(state.say('tool.retryReview.taskId')) },
      async (args) => {
        const pr = state.prOf(args.taskId);
        if (!pr) {
          return {
            content: [{
              type: 'text',
              text: state.say('tool.retryReview.noPipeline', { task: args.taskId }),
            }],
            isError: true,
          };
        }
        if (pr.stage !== 'stuck') {
          return {
            content: [{
              type: 'text',
              text: state.say('tool.retryReview.notStuck', {
                task: args.taskId, stage: stageText(pr.stage, state.lang()),
              }),
            }],
            isError: true,
          };
        }
        void retryPipeline(state, args.taskId);
        return {
          content: [{ type: 'text', text: state.say('tool.retryReview.ok', { task: args.taskId }) }],
        };
      },
    ),

    tool(
      'plan_features',
      state.say('tool.planFeatures.desc'),
      {
        features: z.array(z.object({
          title: z.string().describe(state.say('tool.planFeatures.title')),
          goal: z.string().describe(state.say('tool.planFeatures.goal')),
          tasks: z.array(z.object({
            key: z.string().describe(state.say('tool.planFeatures.key')),
            title: z.string().describe(state.say('tool.createTask.title')),
            description: z.string().describe(state.say('tool.createTask.description')),
            acceptanceCriteria: z.array(z.string())
              .describe(state.say('tool.createTask.criteria')),
            roleId: z.string().describe(state.say('tool.planFeatures.role', {
              roles: state.workerRoles().map((r) => `${r.id} (${r.title})`).join(', '),
            })),
            dependsOn: z.array(z.string()).default([])
              .describe(state.say('tool.planFeatures.dependsOn')),
            type: z.enum([...TASK_TYPES, '']).default('').describe(state.say('tool.createTask.type')),
          })).describe(state.say('tool.planFeatures.tasks')),
        })).describe(state.say('tool.planFeatures.features')),
      },
      async (args) => {
        const outcome = createPlan(state, args.features as PlannedEpic[]);
        return { content: [{ type: 'text', text: outcome.message }], isError: !outcome.ok };
      },
    ),

    tool(
      'start_feature',
      state.say('tool.startFeature.desc'),
      { featureId: z.string().describe(state.say('tool.startFeature.epicId')) },
      async (args) => {
        const outcome = approveEpic(state, args.featureId);
        return { content: [{ type: 'text', text: outcome.message }], isError: !outcome.ok };
      },
    ),

    tool(
      'cancel_feature',
      state.say('tool.cancelFeature.desc'),
      {
        featureId: z.string().describe(state.say('tool.cancelFeature.epicId')),
        reason: z.string().default('').describe(state.say('tool.cancelFeature.reason')),
      },
      async (args) => {
        const outcome = cancelEpic(state, args.featureId, args.reason ?? '');
        return { content: [{ type: 'text', text: outcome.message }], isError: !outcome.ok };
      },
    ),

    tool(
      'reorder_features',
      state.say('tool.reorderFeatures.desc'),
      { featureIds: z.array(z.string()).describe(state.say('tool.reorderFeatures.ids')) },
      async (args) => {
        const outcome = reorderEpics(state, args.featureIds);
        return { content: [{ type: 'text', text: outcome.message }], isError: !outcome.ok };
      },
    ),

    tool(
      'get_board',
      state.say('tool.getBoard.desc'),
      {},
      async () => ({ content: [{ type: 'text', text: boardSummary(state) }] }),
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'ask_owner',
      state.say('tool.askOwner.pm.desc'),
      {
        question: z.string().describe(state.say('tool.askOwner.question')),
        assumption: z.string().describe(state.say('tool.askOwner.assumption')),
      },
      async (args) => {
        const asked = askOwner(state, 'pm#1', null, args.question, args.assumption);
        return { content: [{ type: 'text', text: asked.text }], isError: !asked.ok };
      },
    ),

    tool(
      'note_fact',
      state.say('tool.noteFact.desc'),
      {
        kind: z.enum(['fact', 'decision', 'lesson']).describe(state.say('tool.noteFact.kind')),
        text: z.string().describe(state.say('tool.noteFact.text')),
        roleId: z.string().default('').describe(state.say('tool.noteFact.role')),
      },
      async (args) => {
        const roleId = args.roleId?.trim() ?? '';
        if (roleId && !state.workerRoles().some((r) => r.id === roleId)) {
          return {
            content: [{ type: 'text', text: state.say('tool.createTask.badRole', {
              role: roleId, valid: state.workerRoles().map((r) => r.id).join(', '),
            }) }],
            isError: true,
          };
        }
        if (!args.text.trim()) {
          return { content: [{ type: 'text', text: state.say('tool.noteFact.empty') }], isError: true };
        }
        const fact = state.addFact({
          kind: args.kind, text: args.text, scope: roleId ? `role:${roleId}` : 'project',
        });
        state.addLog('pm#1', 'system', state.say('journal.noted', { id: fact.id, text: clip(fact.text, 120) }));
        return { content: [{ type: 'text', text: state.say('tool.noteFact.ok', { id: fact.id }) }] };
      },
    ),

    tool(
      'say',
      state.say('tool.say.pm.desc'),
      { text: z.string().describe(state.say('tool.say.limit')) },
      async (args) => {
        state.setState('pm#1', state.instances.get('pm#1')?.state ?? 'working', clip(args.text));
        return { content: [{ type: 'text', text: state.say('tool.ok') }] };
      },
    ),
  ],
});

/** Поднять сессию менеджера конкретного офиса. У каждого офиса она своя. */
function startPm(state: OfficeState): void {
  if (state.pmLoop) return;
  const queue = new MessageQueue();
  state.pmQueue = queue;

  // Продолжаем прошлую сессию, если она известна: так PM помнит, о чём шла речь
  // до перезапуска, и не платит за пересборку контекста.
  const resumeId = state.instances.get('pm#1')?.sessionId ?? undefined;
  if (resumeId) {
    state.addLog('pm#1', 'system', state.say('agent.log.resumingSession', { id: resumeId.slice(0, 8) }));
  }

  const session = query({
    prompt: queue,
    options: {
      resume: resumeId,
      model: state.role('pm')!.model,
      systemPrompt: pmPrompt(state) + projectBrief(state),
      cwd: state.projectDir,
      tools: [],                         // у PM нет доступа к файлам — только командные инструменты
      mcpServers: { team: teamTools(state) },
      permissionMode: 'default',
      canUseTool: permissionHandler(state, 'pm#1'),
      settingSources: [],                // не наследовать настройки Claude Code пользователя
      includePartialMessages: false,
    },
  });

  // Заодно спрашиваем у живой сессии полную картину лимитов плана: событиями
  // приезжает только то окно, в которое упираются сейчас, и пятичасовое из
  // них можно не увидеть ни разу. Ответа никто не ждёт — см. state.pollLimits.
  state.pollLimits(session);

  state.pmLoop = (async () => {
    try {
      for await (const msg of session) {
        consume(state, 'pm#1', msg);
        if (msg.type === 'result') {
          if (isOk(msg) && msg.result?.trim()) {
            state.addChat('pm#1', msg.result.trim());
          } else if (!isOk(msg)) {
            const reason = resultReason(msg, state.lang());
            state.addChat(OFFICE_SENDER, state.say('agent.pm.noAnswer', { reason: clip(reason, 300) }));
            state.setState('pm#1', 'failed', state.say('agent.state.error'));
          }
          if (state.instances.get('pm#1')?.state !== 'failed') {
            state.setState('pm#1', 'idle', null);
          }
          state.setBusy(state.running > 0);
          // Набор ролей меняли, пока менеджер отвечал: ход закончен, обрывать
          // больше нечего — перезапускаем сессию с новым перечнем.
          if (pmRestartPending.has(state.officeId)) restartPm(state);
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      state.addLog('pm#1', 'error', state.say('agent.log.pmCrashed', { error: message }));
      if (resumeId) {
        // Скорее всего прошлой сессии уже нет на диске — забываем её,
        // чтобы следующее сообщение начало разговор заново.
        state.setSessionId('pm#1', '');
        state.addChat(OFFICE_SENDER, state.say('agent.pm.lostSession'));
      } else {
        state.addChat(OFFICE_SENDER, state.say('agent.pm.crashed', { error: clip(message, 200) }));
      }
      state.setState('pm#1', 'failed', state.say('agent.state.sessionFailed'));
    } finally {
      // Сессию могли уже заменить (например сбросом офиса) — тогда очередь
      // принадлежит новой сессии, и обнулять ссылки нельзя: её сообщения
      // ушли бы в никуда.
      if (state.pmQueue === queue) {
        state.pmLoop = null;
        state.pmQueue = null;
      }
    }
  })();
}

/**
 * Офисы, у которых набор ролей изменился, пока менеджер был занят ходом.
 * Ключ — id офиса: перезапуск ждёт конца хода, а офисов в памяти несколько.
 */
const pmRestartPending = new Set<string>();

/**
 * Перезапустить сессию менеджера этого офиса. Нужно после каждой правки
 * перечня ролей: и описание create_task, и бриф собираются один раз при
 * старте сессии, поэтому менеджер с прежней сессией продолжал бы назначать
 * задачи на заархивированную роль и не видел бы только что заведённую.
 *
 * Переписка при этом не теряется. Во-первых, сессия не обрывается посреди
 * хода: пока менеджер думает или ждёт инструмент, перезапуск откладывается до
 * конца хода. Во-вторых, следующий запуск продолжает ту же сессию SDK по
 * сохранённому sessionId — разговор для менеджера идёт с того же места, меняются
 * только инструменты и системный промпт.
 */
function restartPm(state: OfficeState): void {
  if (!state.pmLoop) {
    // Живой сессии нет — следующая поднимется уже с новым набором ролей.
    pmRestartPending.delete(state.officeId);
    return;
  }
  const pm = state.instances.get('pm#1');
  if (pm && pm.state !== 'idle' && pm.state !== 'failed') {
    pmRestartPending.add(state.officeId);
    return;
  }
  pmRestartPending.delete(state.officeId);
  // Ссылки обнуляем сразу, а не в finally цикла: иначе следующее сообщение
  // легло бы в уже закрытую очередь и пропало. Так же гасит сессию сброс офиса.
  state.pmQueue?.close();
  state.pmQueue = null;
  state.pmLoop = null;
  state.addLog('pm#1', 'system',
    state.say('agent.pm.restarted'));
}

// Набор ролей правят из окна управления агентами, а перечень исполнителей
// вшит в сессию менеджера: без перезапуска он назначал бы задачи вслепую.
onRoleSetChanged(restartPm);

/** Сообщение пользователя PM'у того офиса, в котором он его написал. */
export function sendUserMessage(state: OfficeState, text: string): void {
  state.addChat('user', text);
  // «Q-3: да, оставляем» — ответ на вопрос офиса, а не реплика менеджеру:
  // ответ ложится в журнал, а менеджер узнаёт о нём системным сообщением.
  if (answerFromChat(state, text)) return;
  startPm(state);
  state.setState('pm#1', 'thinking', state.say('agent.state.readingTask'));
  state.setBusy(true);
  state.pmQueue?.push(text);
}

/**
 * Системное уведомление PM'у (например, о завершении задачи).
 * Офис передаётся явно: уведомление приходит из работы, которая могла начаться
 * задолго до того, как пользователь ушёл в другой офис.
 */
function notifyPm(state: OfficeState, text: string): void {
  startPm(state);
  state.pmQueue?.push(text);
}

// ---------------------------------------------------------------- совещание

/**
 * Менеджер ли это — спрашиваем у роли: признак задан флагом isManager, а не id.
 * Роль берём у офиса сотрудника: у каждого офиса свои правки ролей.
 */
const isManager = (state: OfficeState, inst: Instance): boolean =>
  state.role(inst.roleId)?.isManager ?? false;

/**
 * Совещание: участники высказываются по очереди, каждый видит сказанное до него.
 * Это не свободный чат всех со всеми — такой формат быстро уходит в бесконечное
 * согласование. Итог уходит менеджеру: действовать по результату всё равно ему.
 */
export async function holdMeeting(
  /**
   * Офис, в котором созвали совещание. Приходит от клиента, а не от «текущего
   * на процесс»: клиентов несколько, они смотрят разные офисы, а совещание длится
   * долго — итог обязан уйти менеджеру того офиса, где его созвали.
   */
  meetingOffice: OfficeState,
  topic: string,
  participantIds: string[],
  /** report: false — стенограмму менеджеру не слать: её подведёт узел процесса. */
  opts: { report?: boolean } = {},
): Promise<{ ok: boolean; said: Array<{ id: string; title: string; text: string }> }> {
  const none = { ok: false, said: [] };
  if (meetingOffice.meetingRunning) {
    meetingOffice.addChat(OFFICE_SENDER, meetingOffice.say('meeting.alreadyRunning'), 'meeting');
    return none;
  }
  // Раньше менеджер отсеивался здесь по роли: считалось, что он не участник,
  // а адресат итога. На практике половина тем — про приоритеты и сроки, и
  // обсуждать их без него бессмысленно. Теперь он такой же участник: реплику
  // на совещании он даёт отдельной короткой сессией, а его основная сессия
  // (переписка с пользователем и раздача задач) при этом продолжает работать.
  // Дубликаты в списке убираем — иначе агент высказался бы дважды подряд.
  const participants = [...new Set(participantIds)]
    .map((id) => meetingOffice.instances.get(id))
    .filter((i): i is Instance => Boolean(i));

  if (participants.length < 2) {
    meetingOffice.addChat(OFFICE_SENDER, meetingOffice.say('meeting.needTwo'), 'meeting');
    return none;
  }
  // Занятость проверяем только у исполнителей: у менеджера задач на руках не
  // бывает, а прерывать из-за совещания обработку доски мы и не хотим.
  const busy = participants.find((i) => !isManager(meetingOffice, i) && i.currentTaskId);
  if (busy) {
    meetingOffice.addChat(OFFICE_SENDER,
      meetingOffice.say('meeting.busy', { who: busy.label, task: busy.currentTaskId ?? '' }),
      'meeting');
    return none;
  }
  if (meetingOffice.paused) {
    meetingOffice.addChat(OFFICE_SENDER, meetingOffice.say('meeting.paused'), 'meeting');
    return none;
  }
  if (meetingOffice.budgetExhausted()) {
    meetingOffice.addChat(OFFICE_SENDER, meetingOffice.say('meeting.budget'), 'meeting');
    return none;
  }

  meetingOffice.meetingRunning = true;
  const id = `M-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  /** Состояние совещания для стола и истории: меняются только говорящий и статус. */
  const view = (speaking: string | null, status: MeetingView['status']): MeetingView => ({
    id, topic, participants: participants.map((p) => p.id), speaking, status, startedAt,
    finishedAt: status === 'running' ? null : Date.now(),
  });
  meetingOffice.setMeeting(view(null, 'running'));
  meetingOffice.addChat('user', meetingOffice.say('meeting.topic', { topic }), 'meeting', id);
  // Что было до совещания — чтобы вернуть менеджера ровно туда, откуда позвали:
  // его сессия живёт своей жизнью, и «свободен» после совещания было бы враньём,
  // если он в это время разбирал сообщение пользователя.
  const stateBefore = new Map(participants.map((p) => [p.id, { state: p.state, note: p.note }]));
  for (const p of participants) meetingOffice.setState(p.id, 'talking', meetingOffice.say('agent.state.inMeeting'));

  const said: Array<{ id: string; title: string; text: string }> = [];
  let ok = false;

  try {
    for (const inst of participants) {
      const role = meetingOffice.role(inst.roleId);
      if (!role) continue;
      meetingOffice.setMeeting(view(inst.id, 'running'));
      meetingOffice.setState(inst.id, 'talking', meetingOffice.say('agent.state.speaking'));

      const before = said.length
        ? `${meetingOffice.say('meeting.saidSoFar')}\n` +
          `${said.map((s) => `— ${s.title} (${s.id}): ${s.text}`).join('\n\n')}\n\n`
        : '';

      const turn = meetingOffice.say('meeting.turn');

      // Менеджеру вместо файлов даём доску: файлов он не видит по устройству роли,
      // и предметно говорить ему позволяет именно состояние задач.
      const head = meetingOffice.say('meeting.topic', { topic });
      const prompt = isManager(meetingOffice, inst)
        ? `${head}\n\n${before}${meetingOffice.say('meeting.boardNow')}\n` +
          `${boardSummary(meetingOffice)}\n\n${turn}`
        : `${head}\n\n${before}${turn}`;

      let text = '';
      if (meetingOffice.dryRun) {
        // Проверяем поведение менеджера, а не содержательность реплик:
        // настоящие сессии участников тут не нужны и стоили бы дорого.
        text = meetingOffice.say('meeting.stub', { role: role.title, topic });
        said.push({ id: inst.id, title: role.title, text });
        meetingOffice.addChat(inst.id, text, 'meeting', id);
        meetingOffice.setState(inst.id, 'talking', meetingOffice.say('agent.state.inMeeting'));
        continue;
      }

      // Реплика на совещании — всегда отдельная короткая сессия, в том числе у
      // менеджера. Его основную сессию мы не трогаем и не ставим в очередь:
      // очередь бы задержала разбор задач, а совещание — визуализация поверх
      // работы офиса, а не её замена. Всё сказанное менеджер всё равно получит
      // стенограммой в свой разговор, когда совещание закончится.
      const systemPrompt = isManager(meetingOffice, inst)
        ? [
            meetingOffice.say('prompt.meeting.pm'),
            '',
            meetingOffice.say('prompt.meeting.pmTail'),
          ]
        : [
            meetingOffice.say('prompt.meeting.worker', { role: role.title }),
            inst.name ? meetingOffice.say('prompt.worker.name', { name: inst.name }) : '',
            role.brief,
            '',
            meetingOffice.say('prompt.meeting.workerTail'),
          ];

      const session = query({
        prompt,
        options: {
          model: role.model,
          systemPrompt: systemPrompt.join('\n')
            + projectBrief(meetingOffice, isManager(meetingOffice, inst) ? null : role.id),
          cwd: meetingOffice.repoFor(role),
          tools: isManager(meetingOffice, inst) ? [] : ['Read', 'Glob', 'Grep'],
          permissionMode: 'default',
          canUseTool: permissionHandler(meetingOffice, inst.id),
          settingSources: [],
          sandbox: SANDBOX,
          maxTurns: 8,
        },
      });

      for await (const msg of session) {
        // Расход этой сессии пишем на агента, а её id — не запоминаем: у
        // менеджера он затёр бы id основного разговора с пользователем, и после
        // перезапуска офис продолжил бы совещание вместо переписки.
        consume(meetingOffice, inst.id, msg, !isManager(meetingOffice, inst));
        if (msg.type === 'result' && isOk(msg)) text = msg.result?.trim() ?? '';
      }

      if (text) {
        said.push({ id: inst.id, title: role.title, text });
        meetingOffice.addChat(inst.id, text, 'meeting', id);
      } else {
        meetingOffice.addChat(OFFICE_SENDER,
          meetingOffice.say('meeting.noWords', { who: inst.label }), 'meeting', id);
      }
      meetingOffice.setState(inst.id, 'talking', meetingOffice.say('agent.state.inMeeting'));
    }

    meetingOffice.setMeeting(view(null, 'done'));
    meetingOffice.addChat(OFFICE_SENDER, meetingOffice.say('meeting.over'), 'meeting', id);
    ok = true;

    // Стенограмма уходит менеджеру — итог подводит он. Если он сам был на
    // совещании, предупреждаем об этом: иначе он примет собственную реплику
    // за чужую и станет спорить сам с собой. Совещанию из процесса офиса
    // итог подводит узел, и в основную сессию стенограмма не идёт.
    const pmWasThere = participants.some((p) => isManager(meetingOffice, p));
    if (opts.report !== false) notifyPm(meetingOffice,
      meetingOffice.say('meeting.pmSummary', { topic }) +
      (pmWasThere ? meetingOffice.say('meeting.pmWasThere') : '') +
      '\n\n' +
      said.map((s) => `${s.title} (${s.id}):\n${s.text}`).join('\n\n') +
      `\n\n${meetingOffice.say('meeting.pmAsk')}`,
    );
  } catch (err) {
    meetingOffice.addChat(OFFICE_SENDER,
      meetingOffice.say('meeting.crashed', { error: clip((err as Error).message, 200) }), 'meeting', id);
    meetingOffice.setMeeting(view(null, 'failed'));
  } finally {
    meetingOffice.meetingRunning = false;
    for (const p of participants) {
      if (isManager(meetingOffice, p)) {
        // Менеджера возвращаем в то состояние, в котором позвали. Но только если
        // совещание — последнее, что его меняло: его собственная сессия могла за
        // это время взять новое сообщение, и её «думает…» затирать нельзя.
        const prev = stateBefore.get(p.id);
        if (prev && p.state === 'talking') meetingOffice.setState(p.id, prev.state, prev.note);
        continue;
      }
      if (!p.currentTaskId) meetingOffice.setState(p.id, 'idle', null);
    }
    setTimeout(() => { if (meetingOffice.meeting?.id === id) meetingOffice.setMeeting(null); }, 20000);
  }
  return { ok, said };
}

// ---------------------------------------------------------------- прямой разговор

/**
 * Прямой диалог с агентом. Это отдельная сессия, не связанная с задачами:
 * можно спросить совета, уточнить решение, обсудить подход.
 *
 * Офис фиксируем на входе: разговор идёт минутами, а пользователь за это время
 * может уйти в другой — ответ обязан вернуться в тот, где спрашивали.
 */
export function talkTo(talkOffice: OfficeState, instanceId: string, text: string): void {
  const inst = talkOffice.instances.get(instanceId);
  if (!inst) return;
  const role = talkOffice.role(inst.roleId);
  if (!role) return;

  if (inst.currentTaskId) {
    talkOffice.addChat(OFFICE_SENDER,
      talkOffice.say('talk.busy', { who: inst.label, task: inst.currentTaskId }), instanceId);
    return;
  }

  talkOffice.addChat('user', text, instanceId);

  const existing = talkOffice.talks.get(instanceId);
  if (existing) {
    talkOffice.setState(instanceId, 'talking', talkOffice.say('agent.state.talkingToYou'));
    existing.queue.push(text);
    return;
  }

  const queue = new MessageQueue();
  queue.push(text);
  talkOffice.setState(instanceId, 'talking', talkOffice.say('agent.state.talkingToYou'));

  const systemPrompt = [
    talkOffice.say('prompt.talk.system', { role: role.title }),
    inst.name ? talkOffice.say('prompt.worker.name', { name: inst.name }) : '',
    role.brief,
    '',
    talkOffice.say('prompt.talk.tail'),
  ].join('\n') + projectBrief(talkOffice, role.id);

  const session = query({
    prompt: queue,
    options: {
      model: role.model,
      systemPrompt,
      cwd: talkOffice.repoFor(role),
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      permissionMode: 'default',
      canUseTool: permissionHandler(talkOffice, instanceId),
      settingSources: [],
      sandbox: SANDBOX,
    },
  });

  const loop = (async () => {
    try {
      for await (const msg of session) {
        consume(talkOffice, instanceId, msg);
        if (msg.type === 'result') {
          if (isOk(msg) && msg.result?.trim()) {
            talkOffice.addChat(instanceId, msg.result.trim(), instanceId);
          } else if (!isOk(msg)) {
            talkOffice.addChat(OFFICE_SENDER,
              talkOffice.say('talk.failed', { reason: clip(resultReason(msg, talkOffice.lang()), 200) }),
              instanceId);
          }
          if (!talkOffice.instances.get(instanceId)?.currentTaskId) {
            talkOffice.setState(instanceId, 'idle', null);
          }
        }
      }
    } catch (err) {
      talkOffice.addChat(OFFICE_SENDER,
        talkOffice.say('talk.crashed', { error: clip((err as Error).message, 200) }), instanceId);
    } finally {
      talkOffice.talks.delete(instanceId);
    }
  })();

  talkOffice.talks.set(instanceId, { queue, loop });
}

// ---------------------------------------------------------------- исполнители

/**
 * Сколько раз за задачу можно спросить коллег. Ограничение не про деньги, а
 * про то, чтобы исполнитель не заменял работу перепиской: пять вопросов — это
 * уже разговор, а не справка.
 */
const MAX_CONSULTS_PER_TASK = 5;

/**
 * Вопрос коллеге другой роли. Нужен, потому что роли работают в разных
 * репозиториях: лезть в чужой код — и медленно, и опасно (можно поправить
 * то, за что отвечает другой), а гадать — ещё хуже.
 *
 * Отвечает НАСТОЯЩАЯ сессия той роли в ЕЁ репозитории, только на чтение и без
 * офисных инструментов: тогда отвечающий не может ни изменить свой проект, ни
 * позвать третьего — цепочка вопросов не уходит в бесконечность.
 *
 * Офис приходит от задачи спрашивающего: отвечать должен коллега из того же
 * офиса, а не тот, кто сидит в открытом сейчас.
 */
async function consultRole(
  state: OfficeState, askerId: string, roleId: string, question: string, taskId: string,
): Promise<{ ok: boolean; text: string }> {
  const asker = state.instances.get(askerId);
  const role = state.role(roleId);
  if (!asker) return { ok: false, text: state.say('consult.noAsker') };
  if (!role || role.isManager) {
    const names = state.workerRoles().map((r) => r.id).join(', ');
    return { ok: false, text: state.say('consult.noRole', { role: roleId, names }) };
  }
  if (role.id === asker.roleId) {
    return { ok: false, text: state.say('consult.ownRole') };
  }

  const used = state.consultsByTask.get(taskId) ?? 0;
  if (used >= MAX_CONSULTS_PER_TASK) {
    return {
      ok: false,
      text: state.say('consult.limit', { max: MAX_CONSULTS_PER_TASK }),
    };
  }

  // Отвечает только свободный коллега. Занятого не отвлекаем: у него своя
  // сессия и своя задача, а списывать разговор на её стоимость — враньё в
  // расходах. Офис так же поступает с прямым разговором пользователя.
  const answerer = [...state.instances.values()].find(
    (i) => i.roleId === roleId && !i.currentTaskId && i.state !== 'talking',
  );
  if (!answerer) {
    return {
      ok: false,
      text: state.say('consult.allBusy', { role: role.title }),
    };
  }

  state.consultsByTask.set(taskId, used + 1);
  const askerRole = state.role(asker.roleId);
  state.addLog(askerId, 'system',
    state.say('agent.log.question', { who: answerer.id, question: clip(question, 120) }));
  state.emit({ t: 'handoff', from: askerId, to: answerer.id, text: clip(question, 60) });

  const prevState = asker.state;
  const prevNote = asker.note;
  state.setState(askerId, 'talking', state.say('agent.state.asking', { who: answerer.label }));
  state.setState(answerer.id, 'talking', state.say('agent.state.answering', { who: asker.label }));

  let text = '';
  try {
    const session = query({
      prompt: [
        state.say('prompt.consult.intro', { role: askerRole?.title ?? asker.roleId }),
        '',
        question,
        '',
        state.say('prompt.consult.tail'),
      ].join('\n'),
      options: {
        model: role.model,
        systemPrompt: [
          state.say('prompt.consult.system', { role: role.title }),
          role.brief,
          '',
          state.say('prompt.consult.systemTail'),
        ].join('\n') + projectBrief(state, role.id),
        cwd: state.repoFor(role),
        // Только чтение и никаких офисных инструментов: отвечающий не должен
        // ни править свой проект, ни звать третьего.
        tools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'default',
        canUseTool: permissionHandler(state, answerer.id),
        settingSources: [],
        sandbox: SANDBOX,
        maxTurns: 12,
      },
    });
    for await (const msg of session) {
      consume(state, answerer.id, msg);
      if (msg.type === 'result' && isOk(msg)) text = msg.result?.trim() ?? '';
    }
  } catch (err) {
    text = '';
    state.addLog(answerer.id, 'error',
      state.say('agent.log.answerFailed', { error: (err as Error).message }));
  }

  state.setState(answerer.id, 'idle', null);
  state.setState(askerId, prevState, prevNote);

  if (!text) {
    return { ok: false, text: state.say('consult.failed', { who: answerer.label }) };
  }
  state.addLog(answerer.id, 'text',
    state.say('agent.log.answer', { who: asker.id, text: clip(text, 300) }));
  return {
    ok: true,
    text: `${state.say('consult.answered', { who: answerer.label, role: role.title })}\n\n${text}`,
  };
}

/**
 * Инструменты офиса для сессии исполнителя. Офис задачи передаётся сюда явно:
 * инструмент вызывается из живой сессии, и «текущий» офис к этому моменту может
 * быть уже другим — тогда отметка критерия ушла бы на чужую доску.
 */
function workerTools(state: OfficeState, instanceId: string, task: Task) {
  return createSdkMcpServer({
    name: 'office',
    version: '1.0.0',
    instructions: state.say('tool.office.instructions'),
    tools: [
      tool(
        'say',
        state.say('tool.say.worker.desc'),
        { text: z.string().describe(state.say('tool.say.worker.limit')) },
        async (args) => {
          state.setState(instanceId, 'working', clip(args.text));
          return { content: [{ type: 'text', text: state.say('tool.ok') }] };
        },
      ),
      tool(
        'check_criterion',
        state.say('tool.checkCriterion.desc'),
        {
          index: z.number().describe(state.say('tool.checkCriterion.index')),
          done: z.boolean().default(true).describe(state.say('tool.checkCriterion.done')),
        },
        async (args) => {
          const outcome = state.checkCriterion(task.id, args.index, args.done);
          return { content: [{ type: 'text', text: outcome.text }], isError: !outcome.ok };
        },
      ),
      tool(
        'ask_colleague',
        state.say('tool.askColleague.desc'),
        {
          role: z.string().describe(state.say('tool.askColleague.role')),
          question: z.string().describe(state.say('tool.askColleague.question')),
        },
        async (args) => {
          const answer = await consultRole(state, instanceId, args.role, args.question, task.id);
          return { content: [{ type: 'text', text: answer.text }], isError: !answer.ok };
        },
      ),
      tool(
        'ask_owner',
        state.say('tool.askOwner.desc'),
        {
          question: z.string().describe(state.say('tool.askOwner.question')),
          assumption: z.string().describe(state.say('tool.askOwner.assumption')),
        },
        async (args) => {
          const asked = askOwner(state, instanceId, task.id, args.question, args.assumption);
          return { content: [{ type: 'text', text: asked.text }], isError: !asked.ok };
        },
      ),
      tool(
        'finish_task',
        state.say('tool.finishTask.desc'),
        {
          summary: z.string().describe(state.say('tool.finishTask.summary')),
          assumed: z.string().describe(state.say('tool.finishTask.assumed')),
          left: z.string().describe(state.say('tool.finishTask.left')),
          files: z.array(z.string()).default([]).describe(state.say('tool.finishTask.files')),
        },
        async (args) => {
          const fresh = state.tasks.get(task.id);
          const { done, total } = fresh ? criteriaProgress(fresh) : { done: 0, total: 0 };
          // Неотмеченные пункты не «дожимаем» за исполнителя: расхождение между
          // «сдал» и «отмечено» — это и есть сигнал пользователю посмотреть внимательнее.
          const gap = total && done < total
            ? `\n\n${state.say('tool.finishTask.partial', { done, total })}`
            : '';
          state.updateTask(task.id, {
            result: args.summary + gap, files: args.files, status: 'review',
            // Записка при передаче: её читают ревьюер, владелец и следующий
            // шаг процесса — транскрипта этой сессии они не увидят.
            handoff: { did: args.summary, assumed: args.assumed.trim(), left: args.left.trim() },
          });
          return {
            content: [{
              type: 'text',
              text: gap
                ? state.say('tool.finishTask.acceptedPartial', { done, total })
                : state.say('tool.finishTask.accepted'),
            }],
          };
        },
      ),
    ],
  });
}

function workerPrompt(
  state: OfficeState, task: Task, artifactsDir: string | null, projectDir: string,
): string {
  return [
    state.say('prompt.task.header', { task: task.id, title: task.title }),
    '',
    task.description,
    '',
    task.criteria.length
      ? `${state.say('prompt.task.criteria')}\n` +
        task.criteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n')
      : '',
    '',
    artifactsDir
      ? state.say('prompt.task.docsDir', { dir: artifactsDir, project: projectDir })
      : '',
    state.say('prompt.task.finish'),
  ].filter(Boolean).join('\n');
}

/**
 * Запустить исполнителя. Офис задачи передаётся явно и дальше используется
 * ВЕЗДЕ вместо текущего: работа идёт минутами, а пользователь за это время
 * может уйти в другой офис — доска, лента и отчёт обязаны остаться в своём.
 */
function startWorker(taskOffice: OfficeState, task: Task, inst: Instance): void {
  const role = taskOffice.role(inst.roleId);
  if (!role) return;

  // Задача поехала — из очереди за слотом её надо убрать в любом случае:
  // сюда приходят и мимо очереди (пользователь отдал задачу руками).
  taskOffice.waitingForSlot.delete(task.id);
  inst.currentTaskId = task.id;
  taskOffice.updateTask(task.id, {
    assigneeId: inst.id, status: 'in_progress', startedAt: Date.now(), finishedAt: null,
  });
  taskOffice.emit({ t: 'handoff', from: 'pm#1', to: inst.id, text: task.title });
  taskOffice.setState(inst.id, 'working', taskOffice.say('agent.state.takingTask'));

  // Режим проверки поведения менеджера: настоящую сессию исполнителя не поднимаем.
  // Так сценарии прогоняются за секунды и стоят только токенов PM.
  if (taskOffice.dryRun) {
    // Задержку поднимают в тестах, где нужно успеть вмешаться в работу.
    const delay = Number(process.env.OFFICE_DRY_RUN_DELAY ?? 250);

    const finish = (stopped: boolean) => {
      inst.currentTaskId = null;
      inst.abort = null;
      taskOffice.setState(inst.id, 'idle', null);
      if (stopped) {
        taskOffice.stoppedByUser.delete(task.id);
        taskOffice.updateTask(task.id, {
          status: 'blocked',
          result: taskOffice.say('agent.task.stopped'),
          finishedAt: Date.now(),
        });
        notifyPm(taskOffice, taskOffice.say('agent.pmMsg.stopped', { task: task.id }));
        return;
      }
      taskOffice.updateTask(task.id, {
        status: 'done',
        result: taskOffice.say('agent.task.stub', { title: task.title }),
        finishedAt: Date.now(),
        criteria: task.criteria.map((c) => ({ ...c, done: true })),
      });
      closeIfDone(taskOffice, task.id);
      notifyPm(taskOffice, taskOffice.say('agent.pmMsg.stubDone', {
        task: task.id, title: task.title, who: inst.id,
      }));
    };

    const timer = setTimeout(() => finish(false), delay);
    // Прерывание должно ЗАВЕРШИТЬ задачу как остановленную, а не просто снять
    // таймер: иначе она навсегда зависала бы в статусе «в работе».
    inst.abort = { abort: () => { clearTimeout(timer); finish(true); } } as AbortController;
    return;
  }

  occupySlot(taskOffice);

  const systemPrompt = [
    taskOffice.say('prompt.worker.system', { role: role.title }),
    // Имя — в системный промпт, а не в бриф роли: оно у сотрудника, а не у роли.
    inst.name ? taskOffice.say('prompt.worker.name', { name: inst.name }) : '',
    role.brief,
    '',
    taskOffice.say('prompt.worker.tail'),
    taskOffice.say('prompt.worker.life'),
  ].join('\n') + projectBrief(taskOffice, role.id);

  if (taskOffice.settings.engine === 'cloud') {
    startCloudWorker(task, inst, role, systemPrompt, taskOffice);
    return;
  }

  const abort = new AbortController();
  inst.abort = abort;

  // Роль может работать в своём репозитории: ветка, diff и слияние задачи
  // пойдут именно в него. Фиксируем его на задаче — потом по ней мержат и
  // сравнивают, а правку роли к тому времени могли уже поменять.
  const repoDir = taskOffice.repoFor(role);
  taskOffice.updateTask(task.id, { repoDir });

  (async () => {
    let workdir = repoDir;
    // Корень рабочей копии нужен и в catch (коммит наработок при остановке),
    // поэтому объявлен снаружи try.
    let workRoot = repoDir;
    try {
      // Изоляция: своя ветка и свой worktree, чтобы параллельные исполнители
      // физически не могли затереть друг другу файлы.
      if (role.isolate && await repoReady(taskOffice, repoDir)) {
        const wt = await createWorktree(repoDir, worktreesRoot(taskOffice), task.id);
        if (wt) {
          workdir = wt.path;
          workRoot = wt.path;
          taskOffice.updateTask(task.id, {
            branch: wt.branch, baseBranch: wt.base, worktreePath: wt.path,
          });
          taskOffice.addLog(inst.id, 'system',
            taskOffice.say('agent.log.worktree', { branch: wt.branch }));
        } else {
          taskOffice.addLog(inst.id, 'error',
            taskOffice.say('agent.log.worktreeFailed', { task: task.id }));
        }
      }

      // Документные роли пишут в свою папку задачи ВНУТРИ рабочей копии.
      // Рабочей директорией становится именно она: тогда песочница не пустит
      // запись наружу через оболочку, а классификатор пометит запись вне папки
      // как выход за периметр. Раньше это была просьба в промпте, и юрист её нарушал.
      let artifactsDir: string | null = null;
      if (role.docsDir) {
        artifactsDir = `${role.docsDir}/${task.id}`;
        const abs = resolve(workRoot, artifactsDir);
        try {
          mkdirSync(abs, { recursive: true });
        } catch { /* создаст сам исполнитель */ }
        workdir = abs;
      }

      const session = query({
        prompt: workerPrompt(taskOffice, task, artifactsDir, repoDir),
        options: {
          model: role.model,
          // Про внешние инструменты рассказываем только здесь: в облаке
          // локального моста до Figma нет, и обещать его там нельзя.
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: systemPrompt + mcpBrief(taskOffice.settings, role, taskOffice.lang()),
          },
          cwd: workdir,
          // Проект остаётся читаемым: писать нельзя, смотреть можно.
          additionalDirectories: artifactsDir ? [workRoot] : undefined,
          tools: sessionTools(role),
          mcpServers: {
            office: workerTools(taskOffice, inst.id, task),
            ...externalMcp(taskOffice.settings, role, workdir),
          },
          // Скилы роли — из её пакета в employees/<роль>/. Пакета нет, обе
          // опции undefined, и сессия собирается ровно как прежде.
          plugins: employeePlugins(role),
          skills: employeeSkills(role),
          permissionMode: 'default',
          canUseTool: permissionHandler(taskOffice, inst.id, task.id, workdir),
          settingSources: [],
          sandbox: SANDBOX,
          // Лимит ходов берём из настроек офиса задачи, а не из константы:
          // задачи разной величины упираются в него по-разному, и поднять его
          // должно быть можно без правки кода. Свой лимит роли сильнее
          // офисного, null — без ограничения.
          maxTurns: taskOffice.turnsFor(role) ?? undefined,
          maxBudgetUsd: taskOffice.settings.taskBudgetUsd ?? undefined,
          abortController: abort,
        },
      });

      taskOffice.pollLimits(session);

      // Что с внешними серверами роли — узнаём попутно, пока сессия работает:
      // без этого отказ инструмента неотличим от неоткрытого плагина.
      taskOffice.pollMcp(inst.id, role, session);

      let finalText = '';
      let sessionFailed: string | null = null;
      for await (const msg of session) {
        consume(taskOffice, inst.id, msg);
        if (msg.type === 'result') {
          if (isOk(msg)) finalText = msg.result ?? '';
          else sessionFailed = clip(resultReason(msg, taskOffice.lang()), 300);
        }
      }

      // Запоминаем сессию задачи: если дело дойдёт до доработки по ревью,
      // автор продолжит этот же разговор вместо пересборки контекста с нуля.
      if (inst.sessionId) taskOffice.updateTask(task.id, { workerSessionId: inst.sessionId });

      if (sessionFailed) throw new Error(sessionFailed);

      const fresh = taskOffice.tasks.get(task.id);
      let summary = fresh?.result ?? clip(finalText, 600) ?? taskOffice.say('agent.task.noReport');

      // Коммитим сами: полагаться на то, что исполнитель не забудет, нельзя.
      if (fresh?.branch) {
        const outcome = await commitAll(
          workRoot, `${task.id}: ${task.title}`, { author: taskOffice.gitPerson(inst.id) });
        if (outcome === 'committed') {
          taskOffice.addLog(inst.id, 'system',
            taskOffice.say('agent.log.committed', { branch: fresh.branch }));
        } else if (outcome === 'empty') {
          summary += `\n\n${taskOffice.say('agent.task.noFileChanges')}`;
          taskOffice.addLog(inst.id, 'system', taskOffice.say('agent.log.noChanges'));
        } else {
          taskOffice.addLog(inst.id, 'error',
            taskOffice.say('agent.log.commitFailed', { branch: fresh.branch }));
        }
      }

      // Ветка есть — работу дальше ведёт конвейер: ревью и слияние идут без
      // человека. Нет ветки (роль без изоляции, не репозиторий) — задача просто
      // сделана, как и раньше.
      const toPipeline = Boolean(fresh?.branch) && taskOffice.settings.autoPipeline;
      taskOffice.updateTask(task.id, {
        status: toPipeline ? 'review' : 'done', result: summary, finishedAt: Date.now(),
      });
      // Без конвейера сдача и есть закрытие: исход ставится здесь, а с
      // конвейером — при слиянии, когда известны круги ревью.
      if (!toPipeline) closeIfDone(taskOffice, task.id);
      taskOffice.setState(inst.id, 'done',
        taskOffice.say(toPipeline ? 'agent.state.handedOver' : 'agent.state.done'));
      const progress = fresh ? criteriaProgress(fresh) : { done: 0, total: 0 };
      notifyPm(taskOffice, [
        taskOffice.say('agent.pmMsg.done', { task: task.id, title: task.title, who: inst.id }),
        taskOffice.say('agent.pmMsg.report', { report: summary }),
        fresh?.handoff?.assumed ? taskOffice.say('agent.pmMsg.assumed', { text: fresh.handoff.assumed }) : '',
        fresh?.handoff?.left ? taskOffice.say('agent.pmMsg.left', { text: fresh.handoff.left }) : '',
        progress.total
          ? taskOffice.say('agent.pmMsg.criteria', { done: progress.done, total: progress.total })
          : '',
        fresh?.files.length ? taskOffice.say('agent.pmMsg.files', { files: fresh.files.join(', ') }) : '',
        taskOffice.say(toPipeline ? 'agent.pmMsg.pipelineNext' : 'agent.pmMsg.judge'),
      ].filter(Boolean).join('\n'));
      // Исполнитель освобождается в finally — конвейер запускаем после него,
      // иначе доработку по ревью будет некому взять: автор всё ещё «занят».
      if (toPipeline) setTimeout(() => runPipeline(taskOffice, task.id), 0);
    } catch (err) {
      const message = (err as Error).message;

      if (taskOffice.stoppedByUser.delete(task.id)) {
        // Наработки не выбрасываем: то, что успели сделать, коммитим в ветку задачи.
        const fresh = taskOffice.tasks.get(task.id);
        let note = taskOffice.say('agent.task.stopped');
        if (fresh?.branch) {
          const outcome = await commitAll(
            workRoot, taskOffice.say('agent.task.stoppedCommit', { task: task.id }),
            { author: taskOffice.gitPerson(inst.id) });
          note += outcome === 'committed'
            ? taskOffice.say('agent.task.stoppedKept', { branch: fresh.branch })
            : taskOffice.say('agent.task.stoppedEmpty');
        }
        taskOffice.updateTask(task.id, { status: 'blocked', result: note, finishedAt: Date.now() });
        taskOffice.addLog(inst.id, 'system', taskOffice.say('agent.log.taskStopped', { task: task.id }));
        taskOffice.setState(inst.id, 'idle', null);
        notifyPm(taskOffice, taskOffice.say('agent.pmMsg.stopped', { task: task.id }));
      } else {
        taskOffice.addLog(inst.id, 'error',
          taskOffice.say('agent.log.taskFailed', { task: task.id, error: message }));
        taskOffice.updateTask(task.id, {
          status: 'failed',
          result: taskOffice.say('agent.task.error', { error: message }),
          finishedAt: Date.now(),
        });
        recordOutcome(taskOffice, task.id, 'failed');
        taskOffice.setState(inst.id, 'failed', taskOffice.say('agent.state.error'));
        notifyPm(taskOffice,
          taskOffice.say('agent.pmMsg.failed', { task: task.id, who: inst.id, error: message }));
      }
    } finally {
      inst.currentTaskId = null;
      inst.abort = null;
      taskOffice.consultsByTask.delete(task.id);
      releaseSlot(taskOffice);
      setTimeout(() => {
        if (!inst.currentTaskId) taskOffice.setState(inst.id, 'idle', null);
      }, 4000);
    }
  })().catch(() => { /* обработано выше */ });
}

/**
 * Исполнитель в облаке. Отличий от локального два: работу делает контейнер
 * Anthropic, а результат приезжает готовой веткой из GitHub — своей рабочей
 * копии и коммита от офиса тут нет.
 */
function startCloudWorker(
  task: Task, inst: Instance, role: Role, systemPrompt: string, taskOffice: OfficeState,
): void {
  // Прерывание идёт событием в сессию, а не сигналом процессу.
  inst.abort = { abort: () => { void stopCloudTask(taskOffice.officeId, task.id); } } as AbortController;

  void (async () => {
    try {
      const outcome = await runCloudTask(task, inst, role, systemPrompt, taskOffice);

      if (taskOffice.stoppedByUser.delete(task.id)) {
        taskOffice.updateTask(task.id, {
          status: 'blocked',
          result: taskOffice.say('agent.task.stoppedCloud', {
            where: outcome.branch
              ? taskOffice.say('agent.task.stoppedCloudBranch', { branch: outcome.branch })
              : taskOffice.say('agent.task.stoppedCloudNoBranch'),
          }),
          finishedAt: Date.now(),
          branch: outcome.branch, baseBranch: outcome.baseBranch,
        });
        taskOffice.setState(inst.id, 'idle', null);
        notifyPm(taskOffice, taskOffice.say('agent.pmMsg.stopped', { task: task.id }));
        return;
      }

      if (!outcome.ok) throw new Error(outcome.summary);

      taskOffice.updateTask(task.id, {
        status: 'done', result: outcome.summary, finishedAt: Date.now(),
        branch: outcome.branch, baseBranch: outcome.baseBranch,
      });
      closeIfDone(taskOffice, task.id);
      taskOffice.setState(inst.id, 'done', taskOffice.say('agent.state.done'));
      const fresh = taskOffice.tasks.get(task.id);
      const progress = fresh ? criteriaProgress(fresh) : { done: 0, total: 0 };
      notifyPm(taskOffice, [
        taskOffice.say('agent.pmMsg.cloudDone', {
          task: task.id, title: task.title, who: inst.id,
        }),
        taskOffice.say('agent.pmMsg.report', { report: outcome.summary }),
        progress.total
          ? taskOffice.say('agent.pmMsg.criteria', { done: progress.done, total: progress.total })
          : '',
        outcome.branch ? taskOffice.say('agent.pmMsg.cloudBranch', { branch: outcome.branch }) : '',
        taskOffice.say('agent.pmMsg.judge'),
      ].filter(Boolean).join('\n'));
    } catch (err) {
      const message = clip((err as Error).message, 300);
      taskOffice.addLog(inst.id, 'error',
        taskOffice.say('agent.log.cloudTaskFailed', { task: task.id, error: message }));
      taskOffice.updateTask(task.id, {
        status: 'failed',
        result: taskOffice.say('agent.task.error', { error: message }),
        finishedAt: Date.now(),
      });
      recordOutcome(taskOffice, task.id, 'failed');
      taskOffice.setState(inst.id, 'failed', taskOffice.say('agent.state.error'));
      notifyPm(taskOffice,
        taskOffice.say('agent.pmMsg.cloudFailed', { task: task.id, who: inst.id, error: message }));
    } finally {
      inst.currentTaskId = null;
      inst.abort = null;
      releaseSlot(taskOffice);
      setTimeout(() => {
        if (!inst.currentTaskId) taskOffice.setState(inst.id, 'idle', null);
      }, 4000);
    }
  })();
}

/**
 * Закрыть все живые сессии офиса. Нужно при сбросе: иначе доска пуста,
 * а менеджер продолжает помнить прошлые задачи и обсуждения — офис
 * оказывается сброшен наполовину.
 */
export function resetSessions(state: OfficeState): void {
  // Сбрасывается офис, который попросил клиент, — чужие сессии трогать нельзя.
  // Само закрытие живёт в состоянии офиса: так же гасят сессии при выгрузке
  // офиса из памяти, и разойтись эти два пути не должны.
  state.closeSessions();
}

/** Прервать работу над задачей. Наработки сохраняются. */
export function stopTask(state: OfficeState, taskId: string): void {
  const task = state.tasks.get(taskId);
  if (!task) return;
  const inst = [...state.instances.values()].find((i) => i.currentTaskId === taskId);
  if (!inst?.abort) {
    state.addChat(OFFICE_SENDER, state.say('restart.notRunning', { task: taskId }));
    return;
  }
  state.stoppedByUser.add(taskId);
  inst.abort.abort();
}

/**
 * Запустить задачу заново: с нуля, но с тем же ТЗ. Офис приходит аргументом:
 * перезапуск ходит в git и потому длится, а звать его может и надзор
 * покинутого офиса — задача обязана остаться на своей доске.
 */
export async function retryTask(state: OfficeState, taskId: string): Promise<boolean> {
  const task = state.tasks.get(taskId);
  if (!task) return false;
  if (task.status === 'in_progress') {
    state.addChat(OFFICE_SENDER, state.say('restart.running', { task: taskId }));
    return false;
  }
  if (task.merged) {
    state.addChat(OFFICE_SENDER, state.say('restart.merged', { task: taskId }));
    return false;
  }
  if (state.paused) {
    state.addChat(OFFICE_SENDER, state.say('restart.paused', { task: taskId }));
    return false;
  }
  const cloudBlocked = state.settings.engine === 'cloud' ? cloudProblem(state) : null;
  if (cloudBlocked) {
    state.addChat(OFFICE_SENDER, state.say('restart.cloudBroken', { problem: cloudBlocked }));
    return false;
  }
  if (state.budgetExhausted()) {
    state.addChat(OFFICE_SENDER, state.say('restart.budget'));
    return false;
  }

  const roleId = task.roleId ?? 'backend';
  const noStaff = noStaffReason(roleId, state);
  if (noStaff) {
    state.addChat(OFFICE_SENDER, state.say('restart.noStaff', { problem: noStaff, task: taskId }));
    return false;
  }
  // Перезапуск ходит в git и переписывает задачу в backlog, поэтому лимит
  // проверяем до всего этого: на потолке задача просто вернётся в очередь.
  const noSlot = slotProblem(state);
  if (noSlot) {
    state.addChat(OFFICE_SENDER, state.say('restart.noSlot', { task: taskId, problem: noSlot }));
    return false;
  }
  const inst = state.findFree(roleId) ?? state.spawn(roleId) ?? state.findFree(roleId);
  if (!inst) {
    state.addChat(OFFICE_SENDER, state.say('restart.allBusy', { role: roleId, task: taskId }));
    return false;
  }

  // Если в прошлой попытке что-то успели сделать — сохраняем ветку под другим
  // именем, а не удаляем: при остановке офис обещал, что работа не пропадёт.
  const repo = taskRepo(task, state);
  if (task.branch && task.baseBranch && await repoReady(state, repo)) {
    const worthKeeping = await hasWork(repo, task.branch, task.baseBranch);
    if (task.worktreePath) {
      await removeWorktree(repo, task.worktreePath, task.branch,
        { keepBranch: worthKeeping });
    }
    if (worthKeeping) {
      const kept = await preserveBranch(repo, task.branch);
      if (kept) {
        state.addChat(OFFICE_SENDER, state.say('restart.branchKept', { task: taskId, branch: kept }));
      }
    }
  }

  state.updateTask(taskId, {
    status: 'backlog', assigneeId: null, result: null, files: [],
    branch: null, baseBranch: null, worktreePath: null, merged: false,
    interrupted: false, attention: null,
    startedAt: null, finishedAt: null, usage: emptyUsage(), daily: {},
    // Отметки прошлой попытки к новой не относятся: работа начинается с нуля.
    criteria: task.criteria.map((c) => ({ ...c, done: false })),
    // Исход прошлой попытки — тоже: судить новую по нему нельзя.
    outcome: null, mergeCommit: null,
  });
  const fresh = state.tasks.get(taskId);
  if (fresh) startWorker(state, fresh, inst);
  state.addLog(null, 'system', state.say('agent.log.taskRestarted', { task: taskId, who: inst.id }));
  return Boolean(fresh);
}

/**
 * Отдать задачу конкретному исполнителю мимо менеджера.
 * PM об этом узнаёт: иначе доска и его представление о мире разойдутся.
 */
export function assignDirect(state: OfficeState, taskId: string, instanceId: string): void {
  const task = state.tasks.get(taskId);
  const inst = state.instances.get(instanceId);
  if (!task || !inst) return;
  if (task.assigneeId && task.status === 'in_progress') {
    state.addChat(OFFICE_SENDER, state.say('start.alreadyRunning', { task: taskId, who: task.assigneeId }));
    return;
  }
  if (inst.currentTaskId) {
    state.addChat(OFFICE_SENDER, state.say('start.workerBusy', { who: inst.label, task: inst.currentTaskId }));
    return;
  }
  if (state.paused) {
    state.addChat(OFFICE_SENDER, state.say('start.paused', { task: taskId }));
    return;
  }
  const cloudBlocked = state.settings.engine === 'cloud' ? cloudProblem(state) : null;
  if (cloudBlocked) {
    state.addChat(OFFICE_SENDER, state.say('start.cloudBroken', { problem: cloudBlocked }));
    return;
  }
  if (state.budgetExhausted()) {
    state.addChat(OFFICE_SENDER, state.say('start.budget'));
    return;
  }
  // Задачу отдали руками, но лимит одновременных сессий от этого не растёт:
  // ставим в очередь и говорим об этом — молча проглотить действие человека
  // хуже, чем объяснить, почему оно случится через минуту. Роль на задаче
  // остаётся выбранная, а вот конкретного исполнителя очередь не держит:
  // через минуту свободен будет тот, кто освободился, а не тот, на кого
  // ткнули. Статус возвращаем в «очередь» — из неё задачу и подхватят.
  const noSlot = slotProblem(state);
  if (noSlot) {
    state.updateTask(taskId, { roleId: inst.roleId, status: 'backlog', assigneeId: null });
    const fresh = state.tasks.get(taskId);
    if (fresh) queueForSlot(state, fresh, noSlot);
    return;
  }
  state.updateTask(taskId, { roleId: inst.roleId });
  const fresh = state.tasks.get(taskId);
  if (!fresh) return;
  startWorker(state, fresh, inst);
  notifyPm(state,
    state.say('agent.pmMsg.directAssign', { task: taskId, title: task.title, who: inst.id }));
}

/**
 * Отдать стоящую задачу свободному исполнителю от имени офиса. Нужно надзору:
 * задача, которую менеджер завёл и не раздал, иначе стоит на доске вечно —
 * а пользователь не должен это замечать и тем более чинить.
 *
 * Возвращает id исполнителя или причину, по которой запустить нельзя.
 */
export function officeAssign(state: OfficeState, taskId: string): { ok: boolean; message: string } {
  const task = state.tasks.get(taskId);
  if (!task) return { ok: false, message: state.say('assign.noTask', { task: taskId }) };
  if (task.status !== 'backlog') {
    return { ok: false, message: state.say('assign.notQueued', { task: taskId }) };
  }
  if (state.paused) return { ok: false, message: state.say('assign.paused') };
  if (state.budgetExhausted()) return { ok: false, message: state.say('assign.budget') };
  const cloudBlocked = state.settings.engine === 'cloud' ? cloudProblem(state) : null;
  if (cloudBlocked) return { ok: false, message: cloudBlocked };

  const roleId = task.roleId ?? 'backend';
  const noStaff = noStaffReason(roleId, state);
  if (noStaff) return { ok: false, message: noStaff };

  // Потолок одновременных сессий — не отказ, а очередь: задача остаётся на
  // доске и стартует сама. Надзору достаточно знать, что сейчас не вышло.
  const noSlot = slotProblem(state);
  if (noSlot) {
    queueForSlot(state, task, noSlot);
    return { ok: false, message: noSlot };
  }

  const inst = state.findFree(roleId) ?? state.spawn(roleId) ?? state.findFree(roleId);
  if (!inst || inst.currentTaskId) {
    return { ok: false, message: state.say('assign.allBusy', { role: roleId }) };
  }

  startWorker(state, task, inst);
  return { ok: true, message: inst.id };
}

/**
 * Показать, что задача изменила: дифф её ветки против базовой. Офис приходит
 * аргументом: git на большой ветке думает заметно, и ответ обязан уйти
 * подписчикам того офиса, где дифф попросили.
 */
export async function taskDiff(state: OfficeState, taskId: string): Promise<void> {
  const task = state.tasks.get(taskId);
  const send = (patch: Partial<{ stat: string; patch: string; truncated: boolean; error: string }>) =>
    state.emit({ t: 'task.diff', taskId, stat: '', patch: '', truncated: false, ...patch });

  if (!task) return;
  if (!task.branch || !task.baseBranch) {
    send({ error: state.say('diff.noBranch') });
    return;
  }
  if (task.merged) {
    send({ error: state.say('diff.merged', { base: task.baseBranch }) });
    return;
  }

  const result = await diffBranch(taskRepo(task, state), task.baseBranch, task.branch, state.lang());
  if ('error' in result) send({ error: result.error });
  else if (!result.stat) send({ error: state.say('diff.empty') });
  else send(result);
}

/**
 * Пауза и снятие паузы офиса.
 * На паузе исполнители замирают на следующем вызове инструмента, а новая
 * работа не запускается. Уже начатый вызов доводится до конца: обрывать его
 * на середине — это «Остановить», а не пауза.
 */
export function setPaused(state: OfficeState, paused: boolean): void {
  if (state.paused === paused) return;
  state.setPaused(paused);
  state.addLog(null, 'system',
    state.say(paused ? 'agent.log.officePaused' : 'agent.log.officeResumed'));
  state.addChat(OFFICE_SENDER,
    state.say(paused ? 'start.pauseChat' : 'agent.log.officeResumed'));

  // Задачи, которые менеджер завёл на паузе, сами собой не поедут: он получил
  // отказ на assign_task и ждёт. Без этого напоминания доска молча стоит.
  const waiting = [...state.tasks.values()].filter((t) => t.status === 'backlog' && !t.assigneeId);
  if (!paused && waiting.length > 0) {
    notifyPm(state,
      state.say('agent.pmMsg.resumed', { tasks: waiting.map((t) => t.id).join(', ') }));
  }
}

/**
 * Загрузка офиса и всего процесса: у каждого офиса свои живые сессии, но
 * потолок у них общий. Отдаётся вместе, потому что порознь картина врёт —
 * «1 из 3» в офисе ничего не говорит о том, что процесс уже на потолке.
 */
export function concurrency(state: OfficeState): {
  running: number; max: number; total: number; cap: number;
} {
  return {
    running: state.running,
    max: state.workerLimit(),
    total: totalRunningWorkers(),
    cap: processWorkerCap(),
  };
}

// ---------- конвейер ревью: живые агенты ----------

/**
 * Дождаться свободного исполнителя роли. Конвейер идёт минутами, и «все заняты»
 * в этот момент — не повод бросать пулл-реквест: через минуту-другую кто-то
 * освободится. Ждём с потолком, чтобы не висеть вечно.
 */
const FREE_WAIT_MS = 10 * 60 * 1000;
const FREE_POLL_MS = 3000;

async function waitForFree(
  state: OfficeState, roleId: string, preferId: string | null,
): Promise<Instance | null> {
  const deadline = Date.now() + FREE_WAIT_MS;
  for (;;) {
    await state.whenResumed();
    // Автора берём того же: он знает свою ветку и уже видел эту задачу.
    const preferred = preferId ? state.instances.get(preferId) : null;
    if (preferred && !preferred.currentTaskId) return preferred;
    const free = state.findFree(roleId) ?? state.spawn(roleId) ?? state.findFree(roleId);
    if (free) return free;
    if (Date.now() > deadline) return null;
    if (state.staffOf(roleId).length === 0) return null;   // вакансия — ждать нечего
    await new Promise((r) => setTimeout(r, FREE_POLL_MS));
  }
}

interface SessionRun {
  ok: boolean;
  text: string;
  error: string | null;
  /** Повтор не поможет: нужен человек или менеджер (бюджет, пустая роль). */
  needsDecision?: boolean;
}

/**
 * Сессия исполнителя вне обычного «взял задачу с доски»: доработка по отзыву,
 * разбор конфликта, ревью. Отличий от startWorker два — задача уже сделана
 * и рабочая копия уже есть, поэтому ни ветки, ни статуса «в работе» тут нет.
 */
async function runAgentSession(
  state: OfficeState, inst: Instance, role: Role,
  opts: {
    cwd: string; prompt: string; systemPrompt: string; taskId: string;
    mcp: Record<string, ReturnType<typeof createSdkMcpServer>>;
    note: string;
    /** Продолжить прошлую сессию этой же задачи вместо пересборки контекста с нуля. */
    resume?: string;
    /** Что ещё видно на чтение: документной роли — вся рабочая копия. */
    extraDirs?: string[];
  },
): Promise<SessionRun> {
  if (state.budgetExhausted()) {
    return { ok: false, text: '', error: state.say('review.budget'), needsDecision: true };
  }
  const abort = new AbortController();
  inst.abort = abort;
  inst.currentTaskId = opts.taskId;
  state.setState(inst.id, 'working', opts.note);
  occupySlot(state);

  try {
    const session = query({
      prompt: opts.prompt,
      options: {
        resume: opts.resume,
        model: role.model,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: opts.systemPrompt + mcpBrief(state.settings, role, state.lang()),
        },
        cwd: opts.cwd,
        additionalDirectories: opts.extraDirs,
        tools: sessionTools(role),
        mcpServers: { ...opts.mcp, ...externalMcp(state.settings, role, opts.cwd) },
        plugins: employeePlugins(role),
        skills: employeeSkills(role),
        permissionMode: 'default',
        canUseTool: permissionHandler(state, inst.id, opts.taskId, opts.cwd),
        settingSources: [],
        sandbox: SANDBOX,
        // Доработка по отзыву и разбор конфликта — та же работа исполнителя,
        // и лимит ходов у них тот же: свой у роли, иначе офисный.
        maxTurns: state.turnsFor(role) ?? undefined,
        maxBudgetUsd: state.settings.taskBudgetUsd ?? undefined,
        abortController: abort,
      },
    });

    state.pollLimits(session);
    state.pollMcp(inst.id, role, session);

    let finalText = '';
    let failed: string | null = null;
    for await (const msg of session) {
      consume(state, inst.id, msg);
      if (msg.type === 'result') {
        if (isOk(msg)) finalText = msg.result ?? '';
        else failed = clip(resultReason(msg, state.lang()), 300);
      }
    }
    return { ok: !failed, text: finalText, error: failed };
  } catch (err) {
    return { ok: false, text: '', error: (err as Error).message };
  } finally {
    inst.currentTaskId = null;
    inst.abort = null;
    releaseSlot(state);
    state.setState(inst.id, 'idle', null);
  }
}

/** Системный промпт исполнителя — один и тот же и для задачи, и для доработки. */
function workerSystemPrompt(role: Role, state: OfficeState): string {
  return [
    state.say('prompt.worker.system', { role: role.title }),
    role.brief,
  ].join('\n') + projectBrief(state, role.id);
}

/**
 * Доработка: автор правит СВОЮ ветку в СВОЕЙ рабочей копии — по отзыву
 * ревьюера, по упавшим проверкам или разбирая конфликт с основной веткой.
 */
async function reworkTask(
  state: OfficeState, task: Task, instruction: string,
): Promise<ReworkOutcome> {
  const roleId = task.roleId ?? 'backend';
  const worktree = task.worktreePath;
  if (!worktree) return { ok: false, message: state.say('review.noWorktree') };

  const inst = await waitForFree(state, roleId, task.assigneeId);
  if (!inst) {
    const empty = state.staffOf(roleId).length === 0;
    return {
      ok: false,
      // Все заняты — пройдёт само, надзор попробует позже. Роль пустая —
      // не пройдёт никогда: нанимать некому, кроме человека.
      needsDecision: empty,
      message: state.say('review.noWorker', {
        role: roleId,
        why: state.say(empty ? 'review.roleEmpty' : 'review.allBusyLong'),
      }),
    };
  }
  const role = state.role(inst.roleId);
  if (!role) return { ok: false, message: state.say('review.roleGone', { role: inst.roleId }) };

  state.updateTask(task.id, { assigneeId: inst.id });
  const run = await runAgentSession(state, inst, role, {
    cwd: worktree,
    prompt: instruction,
    systemPrompt: workerSystemPrompt(role, state),
    taskId: task.id,
    mcp: { office: workerTools(state, inst.id, task) },
    note: state.say('agent.state.reworking'),
    // Тот же исполнитель уже видел задачу и код — продолжаем его сессию,
    // а не пересказываем всё с нуля.
    resume: task.workerSessionId ?? undefined,
  });
  if (inst.sessionId) state.updateTask(task.id, { workerSessionId: inst.sessionId });
  if (!run.ok) {
    return {
      ok: false, message: run.error ?? state.say('review.sessionFailed'),
      needsDecision: run.needsDecision,
    };
  }

  // Коммитим за автора, как и после обычной задачи: полагаться на то, что
  // он не забудет, нельзя — а незакоммиченная правка до ревью не доедет.
  const committed = await commitAll(
    worktree, state.say('review.reworkCommit', { task: task.id }), { author: state.gitPerson(inst.id) });
  if (committed === 'failed') return { ok: false, message: state.say('review.commitFailed') };
  return {
    ok: true,
    message: state.say(committed === 'empty' ? 'review.noChangesNeeded' : 'review.reworkCommitted'),
  };
}

/**
 * Свободный сотрудник с нужными умениями. Сначала — тот, кого просили
 * (`same`), если он свободен; потом любой подходящий; потом клон. Никого с
 * такими умениями в офисе нет — ждать нечего, вернётся сразу с `empty`.
 */
async function waitForCapable(
  state: OfficeState, needs: readonly string[], prefer: string | null, exclude: string[],
): Promise<{ inst: Instance | null; empty: boolean }> {
  const deadline = Date.now() + FREE_WAIT_MS;
  for (;;) {
    await state.whenResumed();
    const preferred = prefer ? state.instances.get(prefer) : null;
    if (preferred && !preferred.currentTaskId) return { inst: preferred, empty: false };
    const found = state.findCapable(needs, { exclude });
    if (found.inst || found.empty) return found;
    if (Date.now() > deadline) return { inst: null, empty: false };
    await new Promise((r) => setTimeout(r, FREE_POLL_MS));
  }
}

/**
 * Шаг процесса (spec §8.2): сессия исполнителя, собранная из узла — что
 * передали, что считать сделанным, какие исходы бывают. Кончается ровно
 * одним finish_step; всё остальное — как у доработки по ревью.
 */
async function runStep(state: OfficeState, task: Task, req: StepRequest): Promise<StepOutcome> {
  const { inst, empty } = await waitForCapable(state, req.needs, req.prefer, req.exclude);
  if (!inst) {
    return {
      ok: false, outcome: null, summary: '', needsDecision: empty,
      error: state.say(empty ? 'wf.noCapableRole' : 'wf.noCapable', {
        node: req.node, needs: req.needs.join(', '),
      }),
    };
  }
  const role = state.role(inst.roleId);
  if (!role) return { ok: false, outcome: null, summary: '', error: state.say('review.roleGone', { role: inst.roleId }) };

  // Документная роль работает в своей папке задачи внутри рабочей копии, как
  // и на самой задаче: писать — только туда, читать — всё.
  let cwd = req.cwd;
  let extra = '';
  if (role.docsDir) {
    const dir = `${role.docsDir}/${task.id}`;
    cwd = resolve(req.cwd, dir);
    try { mkdirSync(cwd, { recursive: true }); } catch { /* создаст сам исполнитель */ }
    extra = `\n${state.say('prompt.step.docsDir', { dir })}`;
  }

  let outcome: string | null = null;
  let summary = '';
  const outcomes = req.outcomes.join(', ');
  const tools = createSdkMcpServer({
    name: 'office',
    version: '1.0.0',
    instructions: state.say('tool.office.instructions'),
    tools: [
      tool(
        'say',
        state.say('tool.say.worker.desc'),
        { text: z.string().describe(state.say('tool.say.worker.limit')) },
        async (args) => {
          state.setState(inst.id, 'working', clip(args.text));
          return { content: [{ type: 'text', text: state.say('tool.ok') }] };
        },
      ),
      tool(
        'ask_owner',
        state.say('tool.askOwner.desc'),
        {
          question: z.string().describe(state.say('tool.askOwner.question')),
          assumption: z.string().describe(state.say('tool.askOwner.assumption')),
        },
        async (args) => {
          const asked = askOwner(state, inst.id, task.id, args.question, args.assumption);
          return { content: [{ type: 'text', text: asked.text }], isError: !asked.ok };
        },
      ),
      tool(
        'finish_step',
        state.say('tool.finishStep.desc'),
        {
          outcome: z.string().describe(state.say('tool.finishStep.outcome', { outcomes })),
          summary: z.string().describe(state.say('tool.finishStep.summary')),
        },
        async (args) => {
          if (!req.outcomes.includes(args.outcome)) {
            return {
              content: [{ type: 'text', text: state.say('tool.finishStep.badOutcome', { outcome: args.outcome, outcomes }) }],
              isError: true,
            };
          }
          outcome = args.outcome;
          summary = args.summary;
          return { content: [{ type: 'text', text: state.say('tool.finishStep.ok') }] };
        },
      ),
    ],
  });

  const run = await runAgentSession(state, inst, role, {
    cwd,
    prompt: req.prompt + extra,
    systemPrompt: workerSystemPrompt(role, state),
    taskId: task.id,
    mcp: { office: tools },
    note: state.say('agent.state.step', { node: req.node, task: task.id }),
    extraDirs: role.docsDir ? [req.cwd] : undefined,
  });
  if (!run.ok || !outcome) {
    return {
      ok: false, outcome: null, summary, actor: inst.id, needsDecision: run.needsDecision,
      error: run.error ?? state.say('review.noStepVerdict'),
    };
  }
  return { ok: true, outcome, summary, actor: inst.id };
}

/** Ревью пулл-реквеста: смотрит живой ревьюер и выносит вердикт инструментом. */
async function reviewPr(
  state: OfficeState, task: Task, pr: PullRequestView,
): Promise<ReviewOutcome> {
  const role = state.role('reviewer');
  if (!role) {
    return {
      verdict: 'changes', text: '', reviewerId: null, error: state.say('review.noReviewerRole'),
    };
  }
  // Того же ревьюера, если он свободен: он уже смотрел этот диф и прошлые
  // круги — тогда сессию можно продолжить, а не пересказывать всё заново.
  const inst = await waitForFree(state, 'reviewer', pr.reviewerId);
  if (!inst) {
    const empty = state.staffOf('reviewer').length === 0;
    return {
      verdict: 'changes', text: '', reviewerId: null,
      needsDecision: empty,
      error: state.say(empty ? 'review.noReviewerStaff' : 'review.reviewerBusy'),
    };
  }

  let verdict: ReviewVerdict | null = null;
  let text = '';
  const tools = createSdkMcpServer({
    name: 'office',
    version: '1.0.0',
    instructions: state.say('tool.review.instructions'),
    tools: [
      tool(
        'say',
        state.say('tool.say.review.desc'),
        { text: z.string().describe(state.say('tool.say.limit')) },
        async (args) => {
          state.setState(inst.id, 'working', clip(args.text));
          return { content: [{ type: 'text', text: state.say('tool.ok') }] };
        },
      ),
      tool(
        'approve_pr',
        state.say('tool.approvePr.desc'),
        { summary: z.string().describe(state.say('tool.approvePr.summary')) },
        async (args) => {
          verdict = 'approve';
          text = args.summary;
          return { content: [{ type: 'text', text: state.say('tool.approvePr.ok') }] };
        },
      ),
      tool(
        'request_changes',
        state.say('tool.requestChanges.desc'),
        { summary: z.string().describe(state.say('tool.requestChanges.summary')) },
        async (args) => {
          verdict = 'changes';
          text = args.summary;
          return { content: [{ type: 'text', text: state.say('tool.requestChanges.ok') }] };
        },
      ),
    ],
  });

  const { done, total } = criteriaProgress(task);
  const diff = await prDiff(pr, state.lang());
  // Продолжаем прошлую сессию этого же ревью, если она есть: тогда ревьюер
  // уже помнит задачу, критерии и свои прошлые замечания — пересказывать
  // их заново незачем, нужен только актуальный дифф.
  const resumeId = task.reviewerSessionId ?? undefined;
  const report = [
    task.result ? `\n${state.say('prompt.review.authorReport')}\n${task.result}` : '',
    task.handoff?.assumed ? `\n${state.say('prompt.review.assumed')}\n${task.handoff.assumed}` : '',
    task.handoff?.left ? `\n${state.say('prompt.review.left')}\n${task.handoff.left}` : '',
  ].join('');
  const tail = [
    state.say('prompt.review.noFixing'),
    state.say('prompt.review.oneCall'),
    state.say('prompt.review.rounds', { max: maxRounds(state) }),
    state.say('prompt.review.roundsTail'),
  ];
  const prompt = resumeId
    ? [
        state.say('prompt.review.reworked', { task: task.id, round: pr.rounds + 1 }),
        report,
        '',
        state.say('prompt.review.currentDiff'),
        diff,
        '',
        state.say('prompt.review.runChecks'),
        ...tail,
      ].filter(Boolean).join('\n')
    : [
        state.say('prompt.review.header', { branch: pr.branch, base: pr.base, task: task.id }),
        pr.url
          ? state.say('prompt.review.prUrl', { url: pr.url })
          : state.say('prompt.review.prInternal'),
        '',
        state.say('prompt.review.task', { title: task.title }),
        task.description,
        task.criteria.length
          ? `\n${state.say('prompt.review.criteria', { done, total })}\n` +
            task.criteria.map((c, i) => `${i + 1}. [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')
          : '',
        report,
        pr.rounds ? `\n${state.say('prompt.review.round', { round: pr.rounds + 1 })}` : '',
        pr.reviews.length
          ? `\n${state.say('prompt.review.pastReviews')}\n${pr.reviews.map((r) => `— ${state.say(
            r.verdict === 'approve' ? 'prompt.review.approved' : 'prompt.review.changes',
          )}: ${clip(r.text, 400)}`).join('\n')}`
          : '',
        '',
        state.say('prompt.review.diff'),
        diff,
        '',
        state.say('prompt.review.whereYouAre', {
          where: pr.repoDir === process.cwd() ? state.say('prompt.review.projectRepo') : pr.branch,
        }),
        state.say('prompt.review.runChecksNamed'),
        ...tail,
      ].filter(Boolean).join('\n');

  const run = await runAgentSession(state, inst, role, {
    cwd: task.worktreePath ?? pr.repoDir,
    prompt,
    systemPrompt: workerSystemPrompt(role, state),
    taskId: task.id,
    mcp: { office: tools },
    note: state.say('agent.state.reviewing', { task: task.id }),
    resume: resumeId,
  });
  if (inst.sessionId) state.updateTask(task.id, { reviewerSessionId: inst.sessionId });

  if (!verdict) {
    return {
      verdict: 'changes', text: '', reviewerId: inst.id,
      needsDecision: run.needsDecision,
      error: run.error
        ? state.say('review.sessionBroke', { error: run.error })
        : state.say('review.noVerdict'),
    };
  }
  return { verdict, text, reviewerId: inst.id };
}

// ---------- ритуалы: сессии на модели ----------

/** Дешёвая модель для ритуалов памяти: сворачивать дельту — не решать. */
const RITUAL_MODEL = resolveModel('haiku');

/**
 * Инструменты ритуала — единственный способ, которым модель кладёт что-то в
 * журнал: структурированный вызов, а не текст, который потом пришлось бы
 * разбирать. Всё собирается в `out`, а в состояние ложится уже ритуалом
 * (rituals.ts): так у проверок и у живой модели один и тот же путь.
 */
function ritualTools(state: OfficeState, out: RitualOutput) {
  return createSdkMcpServer({
    name: 'journal',
    version: '1.0.0',
    tools: [
      tool(
        'note_fact',
        state.say('tool.noteFact.desc'),
        {
          kind: z.enum(['fact', 'decision', 'lesson']).describe(state.say('tool.noteFact.kind')),
          text: z.string().describe(state.say('tool.noteFact.text')),
          scope: z.string().default('project').describe(state.say('tool.ritualFact.scope')),
          taskId: z.string().default('').describe(state.say('tool.ritualFact.task')),
        },
        async (args) => {
          const scope = args.scope && args.scope !== 'project' ? `role:${args.scope.replace(/^role:/, '')}` : 'project';
          out.facts.push({ kind: args.kind, text: args.text, scope, ...(args.taskId ? { taskId: args.taskId } : {}) });
          return { content: [{ type: 'text', text: state.say('tool.ok') }] };
        },
      ),
      tool(
        'flag_contradiction',
        state.say('tool.flagContradiction.desc'),
        {
          a: z.string().describe(state.say('tool.flagContradiction.a')),
          b: z.string().describe(state.say('tool.flagContradiction.b')),
          text: z.string().describe(state.say('tool.flagContradiction.text')),
        },
        async (args) => {
          out.contradictions.push({ a: args.a, b: args.b, text: args.text });
          return { content: [{ type: 'text', text: state.say('tool.ok') }] };
        },
      ),
      tool(
        'ask_owner',
        state.say('tool.askOwner.pm.desc'),
        {
          question: z.string().describe(state.say('tool.ritualAsk.question')),
          assumption: z.string().describe(state.say('tool.ritualAsk.assumption')),
        },
        async (args) => {
          out.questions.push({ text: args.question, assumption: args.assumption });
          return { content: [{ type: 'text', text: state.say('tool.ok') }] };
        },
      ),
    ],
  });
}

/**
 * Одна короткая сессия ритуала: без файлов, без оболочки, только
 * инструменты журнала. Расход пишется на менеджера — ритуал и есть работа
 * офиса над собой, а не чья-то задача; id сессии не запоминается, чтобы
 * не затереть разговор менеджера с человеком.
 */
async function ritualSession(
  state: OfficeState, systemPrompt: string, prompt: string,
): Promise<RitualOutput> {
  const out: RitualOutput = { facts: [], contradictions: [], questions: [], costUsd: 0 };
  if (state.dryRun) return out;
  const before = state.instances.get('pm#1')?.usage.costUsd ?? 0;
  try {
    const session = query({
      prompt,
      options: {
        model: RITUAL_MODEL,
        systemPrompt,
        cwd: state.projectDir,
        tools: [],
        mcpServers: { journal: ritualTools(state, out) },
        permissionMode: 'default',
        canUseTool: permissionHandler(state, 'pm#1'),
        settingSources: [],
        maxTurns: 12,
      },
    });
    for await (const msg of session) {
      consume(state, 'pm#1', msg, false);
      if (msg.type === 'result' && !isOk(msg)) out.error = clip(resultReason(msg, state.lang()), 300);
    }
  } catch (err) {
    out.error = (err as Error).message;
  }
  out.costUsd = Math.max(0, (state.instances.get('pm#1')?.usage.costUsd ?? 0) - before);
  return out;
}

/** Журнал словами — для ритуалов, которые его перечитывают. */
function journalText(state: OfficeState, facts: ConsolidationInput['facts']): string {
  if (!facts.length) return state.say('prompt.ritual.journalEmpty');
  return facts.map((f) => state.say('prompt.ritual.journalRow', {
    id: f.id, kind: f.kind, scope: f.scope, text: f.text,
  })).join('\n');
}

/**
 * Инструмент «предложить фичу» — один и тот же у рефлексии, у «что дальше»
 * и у итога совещания: предложение везде выглядит одинаково.
 */
function proposeFeatureTool(state: OfficeState, roles: string, onFeature: (f: FeatureProposal) => void) {
  return tool(
    'propose_feature',
    state.say('tool.proposeFeature.desc'),
    {
      title: z.string().describe(state.say('tool.planFeatures.title')),
      goal: z.string().describe(state.say('tool.planFeatures.goal')),
      rationale: z.string().describe(state.say('tool.proposeFeature.rationale')),
      directionId: z.string().default('').describe(state.say('tool.proposeFeature.direction')),
      tasks: z.array(z.object({
        key: z.string().describe(state.say('tool.planFeatures.key')),
        title: z.string().describe(state.say('tool.createTask.title')),
        description: z.string().describe(state.say('tool.createTask.description')),
        acceptanceCriteria: z.array(z.string()).describe(state.say('tool.createTask.criteria')),
        roleId: z.string().describe(state.say('tool.planFeatures.role', { roles })),
        dependsOn: z.array(z.string()).default([]).describe(state.say('tool.planFeatures.dependsOn')),
      })).describe(state.say('tool.planFeatures.tasks')),
    },
    async (args) => {
      onFeature({
        title: args.title, goal: args.goal, rationale: args.rationale,
        directionId: args.directionId?.trim() || null,
        tasks: args.tasks.map((t) => ({ ...t, dependsOn: t.dependsOn ?? [] })),
      });
      return { content: [{ type: 'text', text: state.say('tool.proposeFeature.ok', { result: args.title }) }] };
    },
  );
}

/**
 * Короткая сессия менеджера для процесса офиса: без файлов и оболочки,
 * только инструменты решения. Расход — на менеджера, id сессии не
 * запоминается, чтобы не затереть его разговор с человеком.
 */
async function flowSession(
  state: OfficeState,
  opts: { system: string; prompt: string; mcp: Record<string, ReturnType<typeof createSdkMcpServer>>; maxTurns: number },
): Promise<{ text: string; error?: string; costUsd: number }> {
  const before = state.instances.get('pm#1')?.usage.costUsd ?? 0;
  let text = '';
  let error: string | undefined;
  try {
    const session = query({
      prompt: opts.prompt,
      options: {
        model: state.role('pm')?.model ?? RITUAL_MODEL,
        systemPrompt: opts.system,
        cwd: state.projectDir,
        tools: [],
        mcpServers: opts.mcp,
        permissionMode: 'default',
        canUseTool: permissionHandler(state, 'pm#1'),
        settingSources: [],
        maxTurns: opts.maxTurns,
      },
    });
    for await (const msg of session) {
      consume(state, 'pm#1', msg, false);
      if (msg.type === 'result') {
        if (isOk(msg)) text = msg.result?.trim() ?? '';
        else error = clip(resultReason(msg, state.lang()), 300);
      }
    }
  } catch (err) {
    error = (err as Error).message;
  }
  return { text, error, costUsd: Math.max(0, (state.instances.get('pm#1')?.usage.costUsd ?? 0) - before) };
}

setFlowAgents({
  async decide(state, input) {
    if (state.dryRun) return { kind: 'nothing', costUsd: 0, why: state.say('flow.dryRun') };
    const say = state.say.bind(state);
    const roles = state.workerRoles().map((r) => `${r.id} (${r.title})`).join(', ');
    let out: DecideOutput = { kind: 'nothing', costUsd: 0 };
    const tools = createSdkMcpServer({
      name: 'flow',
      version: '1.0.0',
      tools: [
        proposeFeatureTool(state, roles, (feature) => { out = { ...out, kind: 'feature', feature }; }),
        ...(input.canMeet ? [tool(
          'call_meeting',
          say('tool.callMeeting.desc'),
          { topic: z.string().describe(say('tool.callMeeting.topic')) },
          async (args) => {
            out = { ...out, kind: 'meet', topic: args.topic };
            return { content: [{ type: 'text', text: say('tool.callMeeting.ok') }] };
          },
        )] : []),
        tool(
          'nothing',
          say('tool.nothing.desc'),
          { why: z.string().describe(say('tool.nothing.why')) },
          async (args) => {
            out = { ...out, kind: 'nothing', why: args.why };
            return { content: [{ type: 'text', text: say('tool.nothing.ok') }] };
          },
        ),
      ],
    });
    const prompt = [
      say('prompt.whatNext.user', {
        canMeet: say(input.canMeet ? 'prompt.whatNext.meetAllowed' : 'prompt.whatNext.meetNotAllowed'),
      }),
      '',
      input.digest,
    ].join('\n');
    const r = await flowSession(state, {
      system: say('prompt.whatNext.system', { lang: LANG_NAME_EN[state.lang()] }),
      prompt, mcp: { flow: tools }, maxTurns: 10,
    });
    return { ...out, costUsd: r.costUsd, error: r.error };
  },

  async summarize(state, input) {
    if (state.dryRun) return { features: [], summary: '', costUsd: 0 };
    const say = state.say.bind(state);
    const roles = state.workerRoles().map((r) => `${r.id} (${r.title})`).join(', ');
    const features: FeatureProposal[] = [];
    const tools = createSdkMcpServer({
      name: 'flow',
      version: '1.0.0',
      tools: [proposeFeatureTool(state, roles, (f) => features.push(f))],
    });
    const prompt = [
      say('prompt.summary.user'), '',
      say('prompt.summary.agenda'), input.agenda, '',
      say('prompt.summary.transcript'), input.transcript,
    ].join('\n');
    const r = await flowSession(state, {
      system: say('prompt.summary.system', { lang: LANG_NAME_EN[state.lang()] }),
      prompt, mcp: { flow: tools }, maxTurns: 12,
    });
    return { features, summary: r.text, costUsd: r.costUsd, error: r.error };
  },

  async meeting(state, topic, participants) {
    const r = await holdMeeting(state, topic, participants, { report: false });
    return { ok: r.ok, said: r.said, error: r.ok ? undefined : state.say('flow.meetingFailed') };
  },
});

setRitualAgents({
  consolidate(state, input) {
    const lang = LANG_NAME_EN[state.lang()];
    const closed = input.closed.map((c) => [
      state.say('prompt.ritual.closedRow', {
        id: c.id, title: c.title, role: c.roleId, kind: c.kind, result: c.result,
      }),
      ...c.reviews.map((text) => state.say('prompt.ritual.reviewRow', { text })),
    ].join('\n'));
    const chat = input.chat.map((c) => `- ${c.from}: ${c.text}`);
    const prompt = [
      state.say('prompt.consolidate.user'),
      '',
      closed.length ? `${state.say('prompt.ritual.closedHead')}\n${closed.join('\n')}` : '',
      chat.length ? `${state.say('prompt.ritual.chatHead')}\n${chat.join('\n')}` : '',
      '',
      state.say('prompt.ritual.journalHead'),
      journalText(state, input.facts),
    ].filter(Boolean).join('\n');
    return ritualSession(state, state.say('prompt.consolidate.system', { lang }), prompt);
  },
  contradictions(state, facts) {
    const lang = LANG_NAME_EN[state.lang()];
    const prompt = [
      state.say('prompt.contradictions.user'),
      '',
      state.say('prompt.ritual.journalHead'),
      journalText(state, facts),
    ].join('\n');
    return ritualSession(state, state.say('prompt.contradictions.system', { lang }), prompt);
  },

  /**
   * Рефлексия — на модели менеджера: это и есть менеджер, только с цифрами
   * вместо файлов. Фичи предлагаются инструментом той же формы, что
   * plan_features, и ложатся через режим инициативы уже в rituals.ts.
   */
  async reflect(state, input) {
    const lang = LANG_NAME_EN[state.lang()];
    const out: ReflectionOutput = {
      facts: [], contradictions: [], questions: [], costUsd: 0, features: [], rules: [], summary: '',
    };
    if (state.dryRun) return out;
    const roles = state.workerRoles().map((r) => `${r.id} (${r.title})`).join(', ');
    const proposeTools = createSdkMcpServer({
      name: 'reflect',
      version: '1.0.0',
      tools: [
        tool(
          'propose_rule',
          state.say('tool.proposeRule.desc'),
          {
            roleId: z.string().describe(state.say('tool.proposeRule.role')),
            text: z.string().describe(state.say('tool.proposeRule.text')),
            rationale: z.string().describe(state.say('tool.proposeRule.rationale')),
          },
          async (args) => {
            if (!state.workerRoles().some((r) => r.id === args.roleId)) {
              return {
                content: [{ type: 'text', text: state.say('tool.createTask.badRole', {
                  role: args.roleId, valid: state.workerRoles().map((r) => r.id).join(', '),
                }) }],
                isError: true,
              };
            }
            out.rules.push({ roleId: args.roleId, text: args.text, rationale: args.rationale });
            return { content: [{ type: 'text', text: state.say('tool.proposeRule.ok', { id: `#${out.rules.length}` }) }] };
          },
        ),
        proposeFeatureTool(state, roles, (f) => out.features.push(f)),
      ],
    });
    const say = state.say.bind(state);
    const reports = input.reports.length
      ? input.reports.map((r) => say('prompt.reflect.reportRow', {
        role: r.roleId, closed: r.closed, clean: Math.round(r.cleanShare * 100),
        reworked: r.byKind.reworked, stuck: r.byKind.stuck, failed: r.byKind.failed,
        reverted: r.byKind.reverted, cost: r.avgCostUsd.toFixed(2),
      })).join('\n')
      : say('prompt.reflect.nothing');
    const reviews = input.reviews.length
      ? input.reviews.map((r) => say('prompt.reflect.reviewRow', {
        task: r.taskId, title: r.title, role: r.roleId, text: r.text,
      })).join('\n')
      : say('prompt.reflect.nothing');
    const open = input.questions.filter((q) => !q.answeredAt && !q.dismissedAt).length;
    const questions = input.questions.length
      ? input.questions.map((q) => say('prompt.reflect.questionRow', {
        id: q.id, status: say(q.answeredAt ? 'prompt.reflect.answeredStatus' : 'prompt.reflect.open'),
        text: clip(q.text, 200), answer: q.answer ? say('prompt.reflect.answered', { answer: clip(q.answer, 200) }) : '',
      })).join('\n')
      : say('prompt.reflect.nothing');
    const directions = input.directions.map((d) => say('prompt.reflect.directionRow', {
      id: d.id, text: d.text, paused: d.active ? '' : say('prompt.board.paused'),
    })).join('\n');
    const prompt = [
      say('prompt.reflect.user'),
      '',
      say('prompt.reflect.reports'), reports, '',
      say('prompt.reflect.reviews'), reviews, '',
      say('prompt.reflect.rituals', { runs: input.rituals.runs, cost: input.rituals.costUsd.toFixed(2) }), '',
      say('prompt.reflect.questions', { open }), questions, '',
      say('prompt.reflect.directions'), directions, '',
      say('prompt.reflect.plan'), input.plan || say('prompt.reflect.noPlan'), '',
      say('prompt.ritual.journalHead'), journalText(state, input.facts),
    ].join('\n');

    const before = state.instances.get('pm#1')?.usage.costUsd ?? 0;
    try {
      const session = query({
        prompt,
        options: {
          model: state.role('pm')!.model,
          systemPrompt: say('prompt.reflect.system', { lang }),
          cwd: state.projectDir,
          tools: [],
          mcpServers: { journal: ritualTools(state, out), reflect: proposeTools },
          permissionMode: 'default',
          canUseTool: permissionHandler(state, 'pm#1'),
          settingSources: [],
          maxTurns: 16,
        },
      });
      for await (const msg of session) {
        consume(state, 'pm#1', msg, false);
        if (msg.type === 'result') {
          if (isOk(msg)) out.summary = msg.result?.trim() ?? '';
          else out.error = clip(resultReason(msg, state.lang()), 300);
        }
      }
    } catch (err) {
      out.error = (err as Error).message;
    }
    out.costUsd = Math.max(0, (state.instances.get('pm#1')?.usage.costUsd ?? 0) - before);
    return out;
  },
});

// Конвейер знает про офис только через эти три действия — сессии агентов
// живут здесь, а он остаётся про порядок шагов.
setPipelineAgents({ review: reviewPr, rework: reworkTask, step: runStep, notifyPm });
setPlanAgents({ assign: officeAssign, notifyPm });

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MessageQueue } from './queue';
import {
  clampTurns, criteriaProgress, DEFAULT_SETTINGS, office, taskRepo, worktreesRoot,
  type Instance, type OfficeState, type Task,
} from './state';
import { emptyUsage } from '../shared/types';
import type { PrStage, PullRequestView, ReviewVerdict } from '../shared/types';
import { cloudProblem, runCloudTask, stopCloudTask } from './cloud';
import { roleById, workerRoles, type Role } from './roles';
import { autoApprovedText, classify, decide, effectiveMode } from './permissions';
import { commitAll, createWorktree, diffBranch, hasCommits, hasWork, isRepo, preserveBranch, removeWorktree } from './git';
import {
  prDiff, retryPipeline, runPipeline, setPipelineAgents, MAX_ROUNDS,
  type ReviewOutcome, type ReworkOutcome,
} from './review';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';

const MAX_CONCURRENT_WORKERS = 3;
/**
 * Потолок ходов одной сессии исполнителя — настройка офиса: шестидесяти ходов
 * хватает обычной задаче и не хватает крупной, а упирается она в него молча,
 * падением «Reached maximum number of turns». Деньги ограничены отдельно
 * (бюджет офиса и бюджет задачи), так что это страховка от зацикливания.
 */
const workerTurns = (state: OfficeState): number =>
  clampTurns(state.settings.workerMaxTurns ?? DEFAULT_SETTINGS.workerMaxTurns);

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

function projectBrief(state: OfficeState): string {
  try {
    const text = readFileSync(resolve(state.projectDir, 'OFFICE.md'), 'utf8').trim();
    if (!text) return '';
    const body = text.length > BRIEF_LIMIT
      ? `${text.slice(0, BRIEF_LIMIT)}\n… (бриф обрезан, полностью — в OFFICE.md)`
      : text;
    return `\n\nО ПРОЕКТЕ — из OFFICE.md рабочей директории:\n${body}`;
  } catch {
    return '';   // брифа нет — работаем как раньше
  }
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
function toolBrief(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':      return `читает ${base(input.file_path)}`;
    case 'Write':     return `создаёт ${base(input.file_path)}`;
    case 'Edit':      return `правит ${base(input.file_path)}`;
    case 'Bash':      return `$ ${clip(input.command, 48)}`;
    case 'Glob':      return `ищет ${clip(input.pattern, 30)}`;
    case 'Grep':      return `грепает ${clip(input.pattern, 30)}`;
    case 'TodoWrite': return 'планирует';
    case 'WebSearch': return `гуглит ${clip(input.query, 30)}`;
    default: {
      if (name.startsWith('mcp__')) {
        const short = name.split('__').pop() ?? name;
        if (short === 'say') return clip(input.text, 70);
        if (short === 'create_task') return `создаёт задачу: ${clip(input.title, 40)}`;
        if (short === 'assign_task') return `назначает ${input.taskId}`;
        if (short === 'finish_task') return 'сдаёт работу';
        if (short === 'list_team') return 'смотрит, кто свободен';
        if (short === 'get_board') return 'смотрит доску';
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
function resultReason(msg: Extract<SDKMessage, { type: 'result' }>): string {
  if (msg.subtype === 'error_max_budget_usd') {
    return 'исчерпан бюджет задачи — повысьте лимит в настройках офиса или разбейте задачу на части';
  }
  if ('result' in msg && typeof msg.result === 'string' && msg.result.trim()) return msg.result;
  return msg.subtype;
}

/**
 * Разбор потока сообщений SDK в состояние офиса и события UI.
 *
 * Офис передаётся явно, а не берётся из `office`: сессия живёт минутами, и
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
        state.setState(instanceId, 'thinking', 'думает…');
      } else if (block.type === 'text') {
        const text = block.text?.trim();
        if (text) state.addLog(instanceId, 'text', clip(text, 400));
      } else if (block.type === 'tool_use') {
        const brief = toolBrief(block.name, block.input as Record<string, unknown>);
        state.setState(instanceId, 'working', brief);
        state.addLog(instanceId, 'tool', `${block.name}: ${brief}`);
      }
    }
    if (msg.error) state.addLog(instanceId, 'error', `Ошибка модели: ${msg.error}`);
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
      const reason = resultReason(msg);
      state.addLog(instanceId, 'error', `Сессия завершилась ошибкой: ${clip(reason, 200)}`);
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
    const role = inst ? roleById(inst.roleId) : undefined;
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
      state.setState(instanceId, 'paused', 'офис на паузе');
      state.addLog(instanceId, 'system', `Пауза офиса: ${toolName} ждёт продолжения`);
      await state.whenResumed(options.signal);
      if (options.signal.aborted) {
        return { behavior: 'deny', message: 'Работа прервана, пока офис стоял на паузе.' };
      }
      state.setState(instanceId, wasState, wasNote);
    }

    const verdict = classify(toolName, input, workdir);

    if (verdict.risk === 'safe') {
      return { behavior: 'allow', updatedInput: input };
    }

    // Явный запрет пользователя сильнее любого режима: режим — это про то,
    // о чём не спрашивать, а не про право отменить уже сказанное «никогда».
    if (role && state.isAlwaysDenied(role.id, verdict.key)) {
      return {
        behavior: 'deny',
        message: `Пользователь запретил «${verdict.key}» для этой роли до конца сессии. ` +
          'Не пытайся обойти запрет другим способом — реши задачу иначе или объясни в отчёте, почему нельзя.',
      };
    }

    const byMode = decide(mode, verdict.risk);

    if (byMode === 'deny') {
      return {
        behavior: 'deny',
        message: 'Эта роль работает в режиме «только чтение» и не может менять файлы или запускать команды.',
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
        state.addLog(instanceId, 'system', autoApprovedText(mode, toolName, verdict), true);
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
    state.setState(instanceId, 'waiting_approval', `ждёт разрешения: ${verdict.summary}`);
    state.addLog(instanceId, 'system', `Просит разрешение — ${toolName}: ${verdict.reason}`);

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
      state.addLog(instanceId, 'system', `Пользователь запретил: ${verdict.summary}`);
      return {
        behavior: 'deny',
        message:
          'Пользователь запретил это действие. НЕ пытайся добиться того же результата обходным путём — ' +
          'через интерпретатор (python -c, node -e), другую утилиту или иной приём: это прямое нарушение запрета. ' +
          'Если без этого действия задачу не решить, прекрати попытки и напиши в отчёте, что именно заблокировано.',
      };
    }

    state.addLog(instanceId, 'system', `Пользователь разрешил: ${verdict.summary}`);
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
const PR_STAGE_TEXT: Record<PrStage, string> = {
  sync: 'подтягивается основная ветка',
  checks: 'идут проверки проекта',
  opening: 'открывается пулл-реквест',
  review: 'смотрит ревьюер',
  rework: 'автор дорабатывает по отзыву',
  merging: 'вливается в основную ветку',
  merged: 'влито',
  stuck: 'ВСТАЛО, нужно твоё решение',
};

function boardSummary(state: OfficeState): string {
  const tasks = [...state.tasks.values()];
  if (!tasks.length) return 'Доска пуста.';
  return tasks.map((t) => {
    const { done, total } = criteriaProgress(t);
    const marks = t.criteria.map((c) => `${c.done ? '✓' : '·'} ${c.text}`).join('; ');
    const pr = state.prOf(t.id);
    return `${t.id} [${t.status}] ${t.title} → ${t.assigneeId ?? '—'}` +
      (pr ? `\n    ревью: ${PR_STAGE_TEXT[pr.stage]} — ${clip(pr.note, 160)}` : '') +
      (total ? `\n    критерии ${done}/${total}: ${clip(marks, 200)}` : '') +
      (t.result ? `\n    результат: ${clip(t.result, 160)}` : '');
  }).join('\n');
}

const PM_PROMPT = `Ты — проектный менеджер (PM) в команде AI-агентов. Ты управляешь командой, но НЕ пишешь код сам — у тебя нет доступа к файлам.

ГЛАВНОЕ ПРАВИЛО: действие считается выполненным, только если ты вызвал инструмент.
Написать «я поручил задачу разработчику», не вызвав create_task и assign_task, — это ложь.
Доска задач — единственный источник правды, и пользователь смотрит на неё, а не на твои слова.

Любая просьба пользователя — это работа для КОМАНДЫ, а не для тебя лично. Даже когда она
звучит как обращение к тебе («сделай», «запиши», «проверь», «запусти»), твоя работа —
оформить её задачей и назначить исполнителя, а не объяснять, что у тебя нет доступа к файлам.
Отсутствие у тебя инструментов — не повод для отказа: инструменты есть у исполнителей.
Отказывайся, только если задача не по силам никому в команде.

Рабочий цикл на каждую просьбу пользователя:
1. list_team — посмотри, кто есть в команде и кто сейчас свободен.
2. Разбей работу на задачи: одна задача = один исполнитель = один осязаемый результат.
   На каждую вызови create_task.
3. На каждую созданную задачу вызови assign_task. Он возвращается СРАЗУ, исполнитель работает
   в фоне. Раздай все независимые задачи подряд, НЕ жди результата первой — так команда
   работает параллельно.
4. Коротко (2–3 предложения) скажи пользователю, что раздал.

Когда приходит системное сообщение о завершении задачи — оцени результат.
Всё хорошо → скажи пользователю, что сделано и что задача пошла на ревью.
Нужна доработка по существу → создай и назначь новую задачу.
Когда все задачи по просьбе закрыты — дай короткое финальное резюме.

Про ревью и слияние. За тем, чтобы сданная работа доехала до основной ветки,
следишь ТЫ, а не пользователь. Он сказал, что нужно сделать, — дальше это дело офиса.
- review_status — где сейчас каждая сданная задача: ревьюят её, дорабатывают,
  офис перезапускает конвейер или ждёт твоего решения. Загляни туда, прежде чем
  говорить пользователю «готово»: пока задача не влита, она не готова.
- Вставший конвейер офис перезапускает САМ, до трёх раз с растущей паузой. Пока
  он пробует — не делай ничего и не пересказывай это пользователю.
- Системное сообщение приходит только тогда, когда сам он дальше не поедет.
  Тогда решай и ДЕЙСТВУЙ САМ: заведи задачу на исправление и назначь её,
  переформулируй эту, отдай другой роли. Не пересказывай беду пользователю и не
  жди от него указаний — он для того тебя и держит.
- К пользователю обращайся только за тем, чего никто в офисе сделать не может:
  нанять сотрудника в пустую роль, поднять бюджет, дать доступ. Одной фразой:
  что именно нужно и зачем.
- retry_review({taskId}) — толкнуть конвейер, который ждёт решения, после того как
  ты устранил причину (например, починил соседнюю задачу). Дёргать его без
  изменений бессмысленно: он встанет ровно там же.
- Слить ветку руками ты не можешь и не должен: у тебя нет такого инструмента.

Офис за тобой подстраховывает и сам присылает системные сообщения, когда работа стоит.
Это не отчёты для пользователя, а работа для тебя:
- «на доске стоят задачи, которые никто не выполняет» — раздай их (assign_task) или ответь,
  что ждёшь другую задачу. Промолчишь — через десять минут офис раздаст их сам.
- «офис отдал задачу N исполнителю» — это уже сделано за тебя, второй раз не раздавай.
- «на доске лежат провалившиеся задачи» — разбери их сам. Упала по лимиту ходов —
  поставь заново, разбив на части поменьше; устарела — оставь как есть.
- «работу оборвал перезапуск» — офис уже возобновил её, делать ничего не нужно.
Пользователю про всё это не докладывай: он держит тебя ровно для того, чтобы не следить
за такими вещами. Скажи ему, только если нужен именно он — нанять сотрудника, поднять
лимит трат, дать доступ.

Как устроена изоляция (важно, иначе будешь ставить невыполнимые задачи и врать про результат):
- КАЖДЫЙ исполнитель работает в своей ветке и своей рабочей копии — и разработчики,
  и документные роли (дизайнер, SMM, юрист). Они не видят изменений друг друга,
  и в основной директории этих изменений пока нет.
- Сданную работу офис ведёт дальше САМ, без тебя и без пользователя: подтягивает основную
  ветку в ветку задачи, просит автора разобрать конфликты, гоняет проверки проекта,
  открывает пулл-реквест, отдаёт его ревьюеру и по одобрению вливает, а ветку убирает.
  Поэтому не создавай задачи «сделать ревью», «слить ветку», «разрешить конфликт» —
  это уже происходит само, и такая задача будет вторым исполнителем в той же ветке.
- Пока конвейер идёт, задача стоит в статусе review. Говори пользователю честно:
  «сделано, идёт ревью» — а не «влито», пока не пришло системное сообщение о слиянии.
- Конвейер зовёт тебя ровно в одном случае: он ВСТАЛ (не разошлись конфликты, не проходят
  проверки, ревьюер вернул работу больше двух раз подряд). Тогда придёт системное сообщение —
  реши, что делать: переформулировать задачу, поставить новую, отдать другой роли.
- Не создавай задачу «проверить, что результаты обеих задач на месте»: пока задача не влита,
  проверять нечего, и исполнитель честно ничего не найдёт.
- Документные роли складывают файлы в docs/<роль>/<задача>/ внутри своей ветки.
- Роли могут работать в РАЗНЫХ репозиториях: у такой роли в list_team указан её
  репозиторий. Одна задача живёт ровно в одном репозитории. Работу, которая задевает
  два, разбивай на две задачи разным ролям и в описании каждой пиши, на что со стороны
  соседа она опирается. Не поручай роли править чужой репозиторий — она его не видит.

Правила декомпозиции:
- Исполнитель НЕ видит вашу переписку с пользователем. Всё нужное пиши в description задачи:
  что сделать, где, в каком стиле, какие файлы и технологии.
- acceptanceCriteria — СПИСОК отдельных проверяемых пунктов (2–5), каждый из которых можно
  отметить галочкой независимо: «файл api/notes.js экспортирует CRUD-роуты», «GET /notes
  возвращает список». Не пиши один абзац: исполнитель отмечает пункты по ходу работы,
  и пользователь видит прогресс «2 из 4».
- Не создавай задачи «обсудить», «подумать», «спланировать» — только те, у которых есть артефакт.
- Не дроби на микрозадачи: 2–4 задачи на типичную просьбу.

Отвечай пользователю по-русски и коротко.`;

/**
 * Почему роли сейчас нельзя отдать задачу: в ней не осталось сотрудников.
 * Причину спрашивают и менеджер, и перезапуск задачи, а текст отказа должен
 * быть один — иначе пользователь получит два разных объяснения одного и того же.
 */
export function noStaffReason(roleId: string, state: OfficeState = office): string | null {
  if (state.staffOf(roleId).length > 0) return null;
  const title = roleById(roleId)?.title ?? roleId;
  return `В роли ${roleId} (${title}) сейчас нет ни одного сотрудника — вакансия открыта, работать некому.`;
}

/**
 * Состав команды словами — то, что менеджер видит в list_team.
 * Вынесено из инструмента, чтобы регрессии этого текста ловились проверкой,
 * а не сценарием с живой моделью: от него зависит, кому PM раздаёт задачи.
 */
export function teamSummary(state: OfficeState = office): string {
  const lines = workerRoles().map((role) => {
    const insts = state.staffOf(role.id);
    // Роль без сотрудников — открытая вакансия: она есть в реестре, но
    // работать некому, пока пользователь не наймёт человека.
    const desc = insts.length
      ? insts.map((i) => `${i.id} — ${i.currentTaskId ? `занят (${i.currentTaskId})` : 'свободен'}`).join(', ')
      : 'сотрудников нет (можно нанять) — задачи этой роли выполнять некому';
    const first = role.brief.split('\n')[0] ?? '';
    const repo = state.repoFor(role);
    // Репозиторий называем, только если он свой: иначе строка одинаковая
    // у всех и лишь удлиняет ответ.
    const where = repo === state.projectDir ? '' : `\n  репозиторий: ${repo}`;
    return `- ${role.id} (${role.title})${first ? ` — ${first}` : ''}\n  ${desc}${where}` +
      `\n  результат: ${role.isolate ? 'в отдельной ветке, нужно слияние' : 'сразу в рабочей директории'}`;
  });
  return `Команда:\n${lines.join('\n')}`;
}

/**
 * Инструменты менеджера. Собираются на каждый офис свои: менеджер покинутого
 * офиса продолжает разбирать отчёты, и его create_task/assign_task обязаны
 * ложиться на его доску, а не на ту, что человек открыл сейчас.
 */
const teamTools = (state: OfficeState) => createSdkMcpServer({
  name: 'team',
  version: '1.0.0',
  instructions: 'Инструменты управления командой офиса.',
  tools: [
    tool(
      'list_team',
      'Показать состав команды: роли, конкретных исполнителей и кто сейчас свободен. Вызывай это первым делом, прежде чем создавать и раздавать задачи.',
      {},
      async () => ({ content: [{ type: 'text', text: teamSummary(state) }] }),
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'create_task',
      'Создать задачу на доске. Одна задача = один исполнитель = один осязаемый результат. Возвращает id задачи, который нужно передать в assign_task.',
      {
        title: z.string().describe('Короткий заголовок, до 60 символов'),
        description: z.string().describe('Полное ТЗ для исполнителя. Он не видит переписку с пользователем — опиши всё: что сделать, в каких файлах, каким стеком.'),
        acceptanceCriteria: z.array(z.string()).describe(
          'Список проверяемых пунктов готовности, 2–5 штук. Каждый — отдельная строка, ' +
          'которую исполнитель отметит выполненной по ходу работы.',
        ),
        roleId: z.string().describe(
          `id роли-исполнителя, строго один из: ${workerRoles().map((r) => `${r.id} (${r.title})`).join(', ')}. ` +
          'Выбирай по специализации, а не по первой попавшейся: неверная роль — это ' +
          'документ, написанный разработчиком, или код, написанный юристом.',
        ),
      },
      async (args) => {
        // Список ролей не дублируем в схеме: перечисление в enum уже один раз
        // разошлось с реальным реестром, и новые роли молча стали недоступны.
        const valid = workerRoles().map((r) => r.id);
        if (!valid.includes(args.roleId)) {
          return {
            content: [{
              type: 'text',
              text: `Неизвестная роль «${args.roleId}». Доступные: ${valid.join(', ')}. ` +
                'Посмотри list_team, там указано, кто чем занимается.',
            }],
            isError: true,
          };
        }
        const criteria = (args.acceptanceCriteria ?? []).map((c) => c.trim()).filter(Boolean);
        if (criteria.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'Нужен хотя бы один проверяемый критерий готовности — без него ' +
                'исполнителю нечего отмечать, а пользователю нечего проверять.',
            }],
            isError: true,
          };
        }
        const task = state.createTask({
          title: args.title,
          description: args.description,
          criteria,
          roleId: args.roleId,
        });
        // Предупреждаем сразу: иначе менеджер узнает о пустой роли только из
        // отказа assign_task и успеет пообещать пользователю работу.
        const empty = state.staffOf(args.roleId).length === 0
          ? `. Внимание: в роли ${args.roleId} сейчас нет сотрудников — назначить задачу будет некому,` +
            ' пока пользователь не наймёт человека на эту роль'
          : '';
        return { content: [{ type: 'text', text: `Создана задача ${task.id}: ${task.title} (роль ${args.roleId}), критериев ${criteria.length}${empty}` }] };
      },
    ),

    tool(
      'assign_task',
      'Назначить задачу исполнителю и запустить работу. ВОЗВРАЩАЕТСЯ СРАЗУ — исполнитель работает в фоне, результат придёт тебе отдельным системным сообщением. Вызывай подряд для всех независимых задач, чтобы команда работала параллельно.',
      {
        taskId: z.string().describe('id задачи из create_task, например T-1'),
        instanceId: z.string().default('').describe('Конкретный исполнитель, например backend#1. Пусто — выбрать свободного автоматически.'),
      },
      async (args) => {
        if (state.paused) {
          return {
            content: [{
              type: 'text',
              text: 'Офис на паузе — новые задачи не запускаются. Задача остаётся на доске; ' +
                'скажи пользователю, что она ждёт снятия паузы, и не пытайся назначить её снова.',
            }],
            isError: true,
          };
        }
        const cloudBlocked = state.settings.engine === 'cloud' ? cloudProblem(state) : null;
        if (cloudBlocked) {
          return {
            content: [{
              type: 'text',
              text: `Офис работает в облачном режиме, но он не настроен: ${cloudBlocked} ` +
                'Задача остаётся на доске — скажи об этом пользователю.',
            }],
            isError: true,
          };
        }
        if (state.budgetExhausted()) {
          const cap = state.settings.globalBudgetUsd;
          return {
            content: [{
              type: 'text',
              text: `Общий бюджет офиса исчерпан: потрачено $${state.totalCost().toFixed(2)} из $${cap?.toFixed(2)}. ` +
                'Новые задачи не запускаются. Сообщи об этом пользователю — он поднимет лимит в настройках.',
            }],
            isError: true,
          };
        }

        const task = state.tasks.get(args.taskId);
        if (!task) {
          return { content: [{ type: 'text', text: `Задачи ${args.taskId} нет на доске` }], isError: true };
        }
        if (task.assigneeId) {
          return { content: [{ type: 'text', text: `${task.id} уже назначена на ${task.assigneeId}` }], isError: true };
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
              text: `${noStaff} ${task.id} остаётся на доске. Скажи пользователю, что на эту роль ` +
                'нужно кого-то нанять, либо переназначь задачу роли, которой она по силам. ' +
                'Повторно вызывать assign_task на эту роль бессмысленно.',
            }],
            isError: true,
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
                ? `Исполнителя ${args.instanceId} нет в офисе — возможно, его уволили. ` +
                  'Посмотри list_team и назови того, кто есть, или оставь поле пустым.'
                : `Все исполнители роли ${roleId} заняты, свободных рабочих мест нет. Дождись завершения текущих задач.`,
            }],
            isError: true,
          };
        }
        if (inst.currentTaskId) {
          return { content: [{ type: 'text', text: `${inst.id} сейчас занят задачей ${inst.currentTaskId}` }], isError: true };
        }

        startWorker(state, task, inst);
        return { content: [{ type: 'text', text: `${task.id} назначена на ${inst.id}, работа началась. Не жди — раздавай остальные задачи.` }] };
      },
    ),

    tool(
      'review_status',
      'Что происходит со сданными задачами: стадия ревью и слияния по каждой. ' +
      'Смотри сюда, прежде чем отвечать пользователю «готово»: пока задача не влита, она не готова.',
      {},
      async () => {
        const prs = [...state.prs.values()];
        if (!prs.length) {
          return { content: [{ type: 'text', text: 'Сданных задач в конвейере нет.' }] };
        }
        const text = prs
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((pr) => `${pr.taskId} «${pr.title}» — ${PR_STAGE_TEXT[pr.stage]}` +
            `${pr.rounds ? `, кругов доработки: ${pr.rounds}` : ''}` +
            `${pr.url ? `, ${pr.url}` : ''}\n    ${clip(pr.note, 200)}`)
          .join('\n');
        return { content: [{ type: 'text', text }] };
      },
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'retry_review',
      'Толкнуть вставший конвейер по задаче: он продолжит с той стадии, где встал. ' +
      'Помогает, когда причина остановки уже устранена — например, соседнюю задачу починили ' +
      'и конфликт больше не возникнет. Если причина осталась, конвейер встанет снова: ' +
      'дёргать его подряд без изменений бессмысленно.',
      { taskId: z.string().describe('id задачи, например T-3') },
      async (args) => {
        const pr = state.prOf(args.taskId);
        if (!pr) {
          return {
            content: [{ type: 'text', text: `По ${args.taskId} конвейера не было — сдавать на ревью нечего.` }],
            isError: true,
          };
        }
        if (pr.stage !== 'stuck') {
          return {
            content: [{ type: 'text', text: `${args.taskId}: конвейер не стоит — сейчас ${PR_STAGE_TEXT[pr.stage]}. Просто дождись.` }],
            isError: true,
          };
        }
        void retryPipeline(state, args.taskId);
        return { content: [{ type: 'text', text: `${args.taskId}: конвейер запущен заново. Результат придёт системным сообщением.` }] };
      },
    ),

    tool(
      'get_board',
      'Текущее состояние доски задач со статусами и результатами.',
      {},
      async () => ({ content: [{ type: 'text', text: boardSummary(state) }] }),
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'say',
      'Сказать короткую реплику, которая появится пузырём над твоей головой в офисе. Используй, чтобы пользователь видел, чем ты занят.',
      { text: z.string().describe('До 70 символов') },
      async (args) => {
        state.setState('pm#1', state.instances.get('pm#1')?.state ?? 'working', clip(args.text));
        return { content: [{ type: 'text', text: 'ок' }] };
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
  if (resumeId) state.addLog('pm#1', 'system', `Продолжаю сессию ${resumeId.slice(0, 8)}…`);

  const session = query({
    prompt: queue,
    options: {
      resume: resumeId,
      model: roleById('pm')!.model,
      systemPrompt: PM_PROMPT + projectBrief(state),
      cwd: state.projectDir,
      tools: [],                         // у PM нет доступа к файлам — только командные инструменты
      mcpServers: { team: teamTools(state) },
      permissionMode: 'default',
      canUseTool: permissionHandler(state, 'pm#1'),
      settingSources: [],                // не наследовать настройки Claude Code пользователя
      includePartialMessages: false,
    },
  });

  state.pmLoop = (async () => {
    try {
      for await (const msg of session) {
        consume(state, 'pm#1', msg);
        if (msg.type === 'result') {
          if (isOk(msg) && msg.result?.trim()) {
            state.addChat('pm#1', msg.result.trim());
          } else if (!isOk(msg)) {
            const reason = resultReason(msg);
            state.addChat('офис', `⚠️ PM не смог ответить: ${clip(reason, 300)}`);
            state.setState('pm#1', 'failed', 'ошибка');
          }
          if (state.instances.get('pm#1')?.state !== 'failed') {
            state.setState('pm#1', 'idle', null);
          }
          state.setBusy(state.running > 0);
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      state.addLog('pm#1', 'error', `Сессия PM упала: ${message}`);
      if (resumeId) {
        // Скорее всего прошлой сессии уже нет на диске — забываем её,
        // чтобы следующее сообщение начало разговор заново.
        state.setSessionId('pm#1', '');
        state.addChat('офис',
          '⚠️ Не удалось продолжить прошлую сессию PM. Она забыта — отправьте сообщение ещё раз, ' +
          'разговор начнётся заново (доска задач при этом сохранена).');
      } else {
        state.addChat('офис', `⚠️ Сессия PM упала: ${clip(message, 200)}`);
      }
      state.setState('pm#1', 'failed', 'сессия упала');
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

/** Сообщение пользователя PM'у текущего офиса — того, в котором он его написал. */
export function sendUserMessage(text: string): void {
  const state = office;
  startPm(state);
  state.addChat('user', text);
  state.setState('pm#1', 'thinking', 'читает задачу…');
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

/** Менеджер ли это — спрашиваем у роли: признак задан флагом isManager, а не id. */
const isManager = (inst: Instance): boolean => roleById(inst.roleId)?.isManager ?? false;

/**
 * Совещание: участники высказываются по очереди, каждый видит сказанное до него.
 * Это не свободный чат всех со всеми — такой формат быстро уходит в бесконечное
 * согласование. Итог уходит менеджеру: действовать по результату всё равно ему.
 */
export async function holdMeeting(topic: string, participantIds: string[]): Promise<void> {
  // Совещание длится долго — офис фиксируем на входе, чтобы итог ушёл менеджеру
  // того офиса, где совещание созвали, даже если пользователь ушёл в другой.
  const meetingOffice = office;
  if (meetingOffice.meetingRunning) {
    meetingOffice.addChat('офис', 'Совещание уже идёт — дождитесь окончания.', 'meeting');
    return;
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
    meetingOffice.addChat('офис', 'Для совещания нужно минимум два участника.', 'meeting');
    return;
  }
  // Занятость проверяем только у исполнителей: у менеджера задач на руках не
  // бывает, а прерывать из-за совещания обработку доски мы и не хотим.
  const busy = participants.find((i) => !isManager(i) && i.currentTaskId);
  if (busy) {
    meetingOffice.addChat('офис',
      `${busy.label} занят задачей ${busy.currentTaskId}. Дождитесь окончания или остановите задачу.`,
      'meeting');
    return;
  }
  if (meetingOffice.paused) {
    meetingOffice.addChat('офис', 'Офис на паузе — совещание не начинается. Снимите паузу (SPACE).', 'meeting');
    return;
  }
  if (meetingOffice.budgetExhausted()) {
    meetingOffice.addChat('офис', 'Бюджет офиса исчерпан — совещание не запускается.', 'meeting');
    return;
  }

  meetingOffice.meetingRunning = true;
  const id = `M-${Date.now().toString(36)}`;
  meetingOffice.setMeeting({ id, topic, participants: participants.map((p) => p.id), speaking: null, status: 'running' });
  meetingOffice.addChat('user', `Тема совещания: ${topic}`, 'meeting');
  // Что было до совещания — чтобы вернуть менеджера ровно туда, откуда позвали:
  // его сессия живёт своей жизнью, и «свободен» после совещания было бы враньём,
  // если он в это время разбирал сообщение пользователя.
  const stateBefore = new Map(participants.map((p) => [p.id, { state: p.state, note: p.note }]));
  for (const p of participants) meetingOffice.setState(p.id, 'talking', 'на совещании');

  const said: Array<{ id: string; title: string; text: string }> = [];

  try {
    for (const inst of participants) {
      const role = roleById(inst.roleId);
      if (!role) continue;
      meetingOffice.setMeeting({ id, topic, participants: participants.map((p) => p.id), speaking: inst.id, status: 'running' });
      meetingOffice.setState(inst.id, 'talking', 'говорит');

      const before = said.length
        ? `Уже высказались:\n${said.map((s) => `— ${s.title} (${s.id}): ${s.text}`).join('\n\n')}\n\n`
        : '';

      const turn =
        'Твоя очередь. Ответь по существу, 3–6 предложений: что важно с точки зрения твоей роли, ' +
        'с чем согласен или не согласен из сказанного, что предлагаешь конкретно. ' +
        'Не повторяй уже сказанное и не пересказывай тему.';

      // Менеджеру вместо файлов даём доску: файлов он не видит по устройству роли,
      // и предметно говорить ему позволяет именно состояние задач.
      const prompt = isManager(inst)
        ? `Тема совещания: ${topic}\n\n${before}Доска задач сейчас:\n${boardSummary(meetingOffice)}\n\n${turn}`
        : `Тема совещания: ${topic}\n\n${before}${turn}`;

      let text = '';
      if (meetingOffice.dryRun) {
        // Проверяем поведение менеджера, а не содержательность реплик:
        // настоящие сессии участников тут не нужны и стоили бы дорого.
        text = `[заглушка] Мнение роли ${role.title} по теме «${topic}».`;
        said.push({ id: inst.id, title: role.title, text });
        meetingOffice.addChat(inst.id, text, 'meeting');
        meetingOffice.setState(inst.id, 'talking', 'на совещании');
        continue;
      }

      // Реплика на совещании — всегда отдельная короткая сессия, в том числе у
      // менеджера. Его основную сессию мы не трогаем и не ставим в очередь:
      // очередь бы задержала разбор задач, а совещание — визуализация поверх
      // работы офиса, а не её замена. Всё сказанное менеджер всё равно получит
      // стенограммой в свой разговор, когда совещание закончится.
      const systemPrompt = isManager(inst)
        ? [
            'Ты — проектный менеджер в команде AI-агентов. Кода ты не пишешь и файлов не видишь:',
            'твоё — люди, приоритеты, порядок работ и то, чем решение обернётся для пользователя.',
            '',
            'Ты на рабочем совещании с командой. Говори коротко и предметно, без вежливых',
            'вступлений. Задач здесь не создавай и не раздавай — инструментов доски в этой',
            'сессии нет, решения примешь после совещания.',
          ]
        : [
            `Ты — ${role.title} в команде AI-агентов.`,
            role.brief,
            '',
            'Ты на рабочем совещании с коллегами. Говори как специалист своей роли: коротко,',
            'предметно, без вежливых вступлений. Можешь посмотреть файлы проекта, чтобы',
            'говорить по делу, но менять ничего нельзя.',
          ];

      const session = query({
        prompt,
        options: {
          model: role.model,
          systemPrompt: systemPrompt.join('\n') + projectBrief(meetingOffice),
          cwd: meetingOffice.repoFor(role),
          tools: isManager(inst) ? [] : ['Read', 'Glob', 'Grep'],
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
        consume(meetingOffice, inst.id, msg, !isManager(inst));
        if (msg.type === 'result' && isOk(msg)) text = msg.result?.trim() ?? '';
      }

      if (text) {
        said.push({ id: inst.id, title: role.title, text });
        meetingOffice.addChat(inst.id, text, 'meeting');
      } else {
        meetingOffice.addChat('офис', `${inst.label} не смог высказаться.`, 'meeting');
      }
      meetingOffice.setState(inst.id, 'talking', 'на совещании');
    }

    meetingOffice.setMeeting({ id, topic, participants: participants.map((p) => p.id), speaking: null, status: 'done' });
    meetingOffice.addChat('офис',
      'Совещание окончено. Итог и решения менеджер напишет в чате с ним.', 'meeting');

    // Стенограмма уходит менеджеру в любом случае — итог подводит он. Если он
    // сам был на совещании, предупреждаем об этом: иначе он примет собственную
    // реплику за чужую и станет спорить сам с собой.
    const pmWasThere = participants.some(isManager);
    notifyPm(meetingOffice,
      `[СИСТЕМА] Прошло совещание по теме «${topic}».` +
      (pmWasThere ? ' Ты был на нём — в стенограмме есть и твоя реплика.' : '') +
      '\n\n' +
      said.map((s) => `${s.title} (${s.id}):\n${s.text}`).join('\n\n') +
      '\n\nПодведи короткий итог для пользователя: к чему пришли, где расходятся мнения ' +
      'и какие задачи из этого следуют. Задачи пока НЕ создавай — сначала дождись согласия пользователя.',
    );
  } catch (err) {
    meetingOffice.addChat('офис', `⚠️ Совещание оборвалось: ${clip((err as Error).message, 200)}`, 'meeting');
    meetingOffice.setMeeting({ id, topic, participants: participants.map((p) => p.id), speaking: null, status: 'failed' });
  } finally {
    meetingOffice.meetingRunning = false;
    for (const p of participants) {
      if (isManager(p)) {
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
}

// ---------------------------------------------------------------- прямой разговор

/**
 * Прямой диалог с агентом. Это отдельная сессия, не связанная с задачами:
 * можно спросить совета, уточнить решение, обсудить подход.
 *
 * Офис фиксируем на входе: разговор идёт минутами, а пользователь за это время
 * может уйти в другой — ответ обязан вернуться в тот, где спрашивали.
 */
export function talkTo(instanceId: string, text: string): void {
  const talkOffice = office;
  const inst = talkOffice.instances.get(instanceId);
  if (!inst) return;
  const role = roleById(inst.roleId);
  if (!role) return;

  if (inst.currentTaskId) {
    talkOffice.addChat('офис',
      `${inst.label} сейчас занят задачей ${inst.currentTaskId}. Дождитесь окончания — ` +
      'прерывать работу посреди задачи дороже, чем подождать.', instanceId);
    return;
  }

  talkOffice.addChat('user', text, instanceId);

  const existing = talkOffice.talks.get(instanceId);
  if (existing) {
    talkOffice.setState(instanceId, 'talking', 'разговор с вами');
    existing.queue.push(text);
    return;
  }

  const queue = new MessageQueue();
  queue.push(text);
  talkOffice.setState(instanceId, 'talking', 'разговор с вами');

  const systemPrompt = [
    `Ты — ${role.title} в команде AI-агентов.`,
    role.brief,
    '',
    'Сейчас с тобой напрямую разговаривает пользователь — это не задача с доски.',
    'Отвечай по существу и коротко. Ты можешь смотреть файлы проекта, чтобы ответить',
    'предметно, но НЕ меняй их: правки делаются только в рамках поставленной задачи.',
    'Если пользователь просит что-то изменить — скажи, что для этого нужно поставить',
    'задачу через менеджера.',
  ].join('\n') + projectBrief(talkOffice);

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
            talkOffice.addChat('офис', `⚠️ ${clip(resultReason(msg), 200)}`, instanceId);
          }
          if (!talkOffice.instances.get(instanceId)?.currentTaskId) {
            talkOffice.setState(instanceId, 'idle', null);
          }
        }
      }
    } catch (err) {
      talkOffice.addChat('офис', `⚠️ Разговор оборвался: ${clip((err as Error).message, 200)}`, instanceId);
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
  const role = roleById(roleId);
  if (!asker) return { ok: false, text: 'Спрашивающий не найден.' };
  if (!role || role.isManager) {
    const names = workerRoles().map((r) => r.id).join(', ');
    return { ok: false, text: `Роли «${roleId}» нет. Есть: ${names}.` };
  }
  if (role.id === asker.roleId) {
    return { ok: false, text: 'Это твоя собственная роль — отвечать на такой вопрос тебе.' };
  }

  const used = state.consultsByTask.get(taskId) ?? 0;
  if (used >= MAX_CONSULTS_PER_TASK) {
    return {
      ok: false,
      text: `Лимит вопросов по задаче исчерпан (${MAX_CONSULTS_PER_TASK}). ` +
        'Прими решение сам и опиши допущение в отчёте.',
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
      text: `Все исполнители роли «${role.title}» сейчас заняты. Реши сам и опиши ` +
        'в отчёте, на какое предположение опирался.',
    };
  }

  state.consultsByTask.set(taskId, used + 1);
  const askerRole = roleById(asker.roleId);
  state.addLog(askerId, 'system', `Вопрос к ${answerer.id}: ${clip(question, 120)}`);
  state.emit({ t: 'handoff', from: askerId, to: answerer.id, text: clip(question, 60) });

  const prevState = asker.state;
  const prevNote = asker.note;
  state.setState(askerId, 'talking', `спрашивает ${answerer.label}`);
  state.setState(answerer.id, 'talking', `отвечает ${asker.label}`);

  let text = '';
  try {
    const session = query({
      prompt: [
        `К тебе обратился коллега — ${askerRole?.title ?? asker.roleId}. Вопрос:`,
        '',
        question,
        '',
        'Ответь по существу и коротко. Если ответ есть в твоём коде — посмотри и назови',
        'конкретные файлы, функции и формат данных, а не общие слова. Если чего-то не',
        'знаешь — так и скажи, не выдумывай.',
      ].join('\n'),
      options: {
        model: role.model,
        systemPrompt: [
          `Ты — ${role.title} в команде AI-агентов.`,
          role.brief,
          '',
          'Коллега из другой роли задаёт тебе вопрос по твоей части работы. Ты отвечаешь',
          'как человек, который её писал: смотришь свой код и объясняешь, как есть.',
          'Менять ничего нельзя — это разговор, а не задача.',
        ].join('\n') + projectBrief(state),
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
    state.addLog(answerer.id, 'error', `Не удалось ответить: ${(err as Error).message}`);
  }

  state.setState(answerer.id, 'idle', null);
  state.setState(askerId, prevState, prevNote);

  if (!text) {
    return { ok: false, text: `${answerer.label} не смог ответить. Реши сам и опиши допущение в отчёте.` };
  }
  state.addLog(answerer.id, 'text', `Ответ ${asker.id}: ${clip(text, 300)}`);
  return { ok: true, text: `Ответил ${answerer.label} (${role.title}):\n\n${text}` };
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
    instructions: 'Инструменты для связи с офисом.',
    tools: [
      tool(
        'say',
        'Сказать одной строкой, что ты делаешь прямо сейчас. Появится пузырём над твоей головой в офисе. Вызывай перед каждым логическим шагом работы.',
        { text: z.string().describe('До 70 символов, настоящее время: «читаю схему БД»') },
        async (args) => {
          state.setState(instanceId, 'working', clip(args.text));
          return { content: [{ type: 'text', text: 'ок' }] };
        },
      ),
      tool(
        'check_criterion',
        'Отметить критерий готовности выполненным. Вызывай сразу, как пункт действительно сделан и проверен, — пользователь видит прогресс «2 из 4» в реальном времени.',
        {
          index: z.number().describe('Номер критерия из списка в задаче, начиная с 1'),
          done: z.boolean().default(true).describe('false — снять отметку, если пункт снова сломался'),
        },
        async (args) => {
          const outcome = state.checkCriterion(task.id, args.index, args.done);
          return { content: [{ type: 'text', text: outcome.text }], isError: !outcome.ok };
        },
      ),
      tool(
        'ask_colleague',
        'Спросить коллегу другой роли о его части работы: как устроен его код, какой формат данных, ' +
        'почему сделано так. Отвечает живой исполнитель этой роли, глядя в свой проект. ' +
        'Используй это ВМЕСТО того, чтобы лезть в чужой репозиторий или гадать.',
        {
          role: z.string().describe('id роли: backend, frontend, design, reviewer, artist, smm, legal'),
          question: z.string().describe('Один конкретный вопрос. Не «расскажи про бэкенд», а «какой формат ответа у GET /notes».'),
        },
        async (args) => {
          const answer = await consultRole(state, instanceId, args.role, args.question, task.id);
          return { content: [{ type: 'text', text: answer.text }], isError: !answer.ok };
        },
      ),
      tool(
        'finish_task',
        'Сдать выполненную задачу. Вызывай ровно один раз, когда работа полностью закончена.',
        {
          summary: z.string().describe('Что сделано, 2–4 предложения. Это увидит PM.'),
          files: z.array(z.string()).default([]).describe('Пути к созданным и изменённым файлам'),
        },
        async (args) => {
          const fresh = state.tasks.get(task.id);
          const { done, total } = fresh ? criteriaProgress(fresh) : { done: 0, total: 0 };
          // Неотмеченные пункты не «дожимаем» за исполнителя: расхождение между
          // «сдал» и «отмечено» — это и есть сигнал пользователю посмотреть внимательнее.
          const gap = total && done < total
            ? `\n\n⚠️ Отмечено критериев: ${done} из ${total}.`
            : '';
          state.updateTask(task.id, {
            result: args.summary + gap, files: args.files, status: 'review',
          });
          return {
            content: [{
              type: 'text',
              text: gap
                ? `Работа принята офисом. Внимание: отмечено ${done} из ${total} критериев — ` +
                  'если остальные тоже выполнены, отметь их через check_criterion.'
                : 'Работа принята офисом.',
            }],
          };
        },
      ),
    ],
  });
}

function workerPrompt(task: Task, artifactsDir: string | null, projectDir: string): string {
  return [
    `Задача ${task.id}: ${task.title}`,
    '',
    task.description,
    '',
    task.criteria.length
      ? 'Критерии готовности — отмечай каждый через check_criterion({index}), как только он ' +
        'выполнен и проверен:\n' +
        task.criteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n')
      : '',
    '',
    artifactsDir
      ? `Твоя рабочая директория — ${artifactsDir}/, туда и клади все файлы по этой задаче. ` +
        `Исходники проекта лежат в ${projectDir} — их можно читать, но не менять. ` +
        'Запись за пределы своей папки будет остановлена и потребует подтверждения пользователя.'
      : '',
    'Выполни задачу полностью и самостоятельно, затем вызови finish_task.',
  ].filter(Boolean).join('\n');
}

/**
 * Запустить исполнителя. Офис задачи передаётся явно и дальше используется
 * ВЕЗДЕ вместо текущего: работа идёт минутами, а пользователь за это время
 * может уйти в другой офис — доска, лента и отчёт обязаны остаться в своём.
 */
function startWorker(taskOffice: OfficeState, task: Task, inst: Instance): void {
  const role = roleById(inst.roleId);
  if (!role) return;

  inst.currentTaskId = task.id;
  taskOffice.updateTask(task.id, {
    assigneeId: inst.id, status: 'in_progress', startedAt: Date.now(), finishedAt: null,
  });
  taskOffice.emit({ t: 'handoff', from: 'pm#1', to: inst.id, text: task.title });
  taskOffice.setState(inst.id, 'working', 'берётся за задачу');

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
          status: 'blocked', result: '⏹ Остановлена пользователем.', finishedAt: Date.now(),
        });
        notifyPm(taskOffice,
          `[СИСТЕМА] Задача ${task.id} остановлена пользователем вручную. ` +
          'Не назначай её заново по своей инициативе — дождись указания.',
        );
        return;
      }
      taskOffice.updateTask(task.id, {
        status: 'done',
        result: `[заглушка] Задача «${task.title}» выполнена.`,
        finishedAt: Date.now(),
        criteria: task.criteria.map((c) => ({ ...c, done: true })),
      });
      notifyPm(taskOffice,
        `[СИСТЕМА] Задача ${task.id} «${task.title}» завершена исполнителем ${inst.id}.\n` +
        'Отчёт: [заглушка] Задача выполнена.\nОцени результат и реши, что делать дальше.',
      );
    };

    const timer = setTimeout(() => finish(false), delay);
    // Прерывание должно ЗАВЕРШИТЬ задачу как остановленную, а не просто снять
    // таймер: иначе она навсегда зависала бы в статусе «в работе».
    inst.abort = { abort: () => { clearTimeout(timer); finish(true); } } as AbortController;
    return;
  }

  taskOffice.running += 1;
  taskOffice.setBusy(true);

  const systemPrompt = [
    `Ты — ${role.title} в команде AI-агентов, работаешь в директории проекта.`,
    role.brief,
    '',
    'Тебе выдана ровно одна задача. Ты НЕ видишь переписку PM с пользователем — вся нужная',
    'информация в тексте задачи. Если чего-то не хватает, прими разумное решение сам и опиши его',
    'в отчёте, а не останавливайся.',
    '',
    'Ты работаешь в своей рабочей копии. Соседние репозитории — чужая ответственность:',
    'без крайней необходимости туда не ходи даже смотреть. Нужно знать, как устроена часть',
    'другой роли — спроси через ask_colleague({role, question}): ответит живой коллега,',
    'глядя в свой код. Это быстрее и честнее, чем догадываться.',
    '',
    'Перед каждым логическим шагом вызывай say({text}) — пользователь видит это над твоей головой.',
    'Когда всё готово — вызови finish_task({summary, files}).',
    '',
    'Что происходит после сдачи: офис сам подтянет основную ветку в твою, прогонит проверки',
    'проекта, откроет пулл-реквест и отдаст его ревьюеру. Сам НЕ сливай свою ветку в основную,',
    'не пуш и не переключай ветки — этим занимается офис. Если ревьюер вернёт работу или',
    'всплывёт конфликт, задачу вернут тебе же, в ту же ветку, с текстом отзыва.',
  ].join('\n') + projectBrief(taskOffice);

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
          taskOffice.addLog(inst.id, 'system', `Рабочая копия: ${wt.branch}`);
        } else {
          taskOffice.addLog(inst.id, 'error',
            `Не удалось создать worktree для ${task.id}, работаю в общей директории`);
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
        prompt: workerPrompt(task, artifactsDir, repoDir),
        options: {
          model: role.model,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
          cwd: workdir,
          // Проект остаётся читаемым: писать нельзя, смотреть можно.
          additionalDirectories: artifactsDir ? [workRoot] : undefined,
          tools: role.tools,
          mcpServers: { office: workerTools(taskOffice, inst.id, task) },
          permissionMode: 'default',
          canUseTool: permissionHandler(taskOffice, inst.id, task.id, workdir),
          settingSources: [],
          sandbox: SANDBOX,
          maxTurns: workerTurns(taskOffice),
          maxBudgetUsd: taskOffice.settings.taskBudgetUsd ?? undefined,
          abortController: abort,
        },
      });

      let finalText = '';
      let sessionFailed: string | null = null;
      for await (const msg of session) {
        consume(taskOffice, inst.id, msg);
        if (msg.type === 'result') {
          if (isOk(msg)) finalText = msg.result ?? '';
          else sessionFailed = clip(resultReason(msg), 300);
        }
      }

      if (sessionFailed) throw new Error(sessionFailed);

      const fresh = taskOffice.tasks.get(task.id);
      let summary = fresh?.result ?? clip(finalText, 600) ?? 'Задача завершена без отчёта.';

      // Коммитим сами: полагаться на то, что исполнитель не забудет, нельзя.
      if (fresh?.branch) {
        const outcome = await commitAll(workRoot, `${task.id}: ${task.title}`);
        if (outcome === 'committed') {
          taskOffice.addLog(inst.id, 'system', `Изменения закоммичены в ${fresh.branch}`);
        } else if (outcome === 'empty') {
          summary += '\n\n⚠️ Файлы не изменились — коммитить нечего.';
          taskOffice.addLog(inst.id, 'system', 'Изменений в рабочей копии нет');
        } else {
          taskOffice.addLog(inst.id, 'error', `Не удалось закоммитить ветку ${fresh.branch}`);
        }
      }

      // Ветка есть — работу дальше ведёт конвейер: ревью и слияние идут без
      // человека. Нет ветки (роль без изоляции, не репозиторий) — задача просто
      // сделана, как и раньше.
      const toPipeline = Boolean(fresh?.branch) && taskOffice.settings.autoPipeline;
      taskOffice.updateTask(task.id, {
        status: toPipeline ? 'review' : 'done', result: summary, finishedAt: Date.now(),
      });
      taskOffice.setState(inst.id, 'done', toPipeline ? 'сдал на ревью' : 'готово ✅');
      const progress = fresh ? criteriaProgress(fresh) : { done: 0, total: 0 };
      notifyPm(taskOffice,
        `[СИСТЕМА] Задача ${task.id} «${task.title}» завершена исполнителем ${inst.id}.\n` +
        `Отчёт: ${summary}\n` +
        (progress.total ? `Критерии: отмечено ${progress.done} из ${progress.total}.\n` : '') +
        (fresh?.files.length ? `Файлы: ${fresh.files.join(', ')}\n` : '') +
        (toPipeline
          ? 'Дальше работу ведёт офис: ревью и слияние идут сами, вмешиваться не нужно. ' +
            'Системное сообщение придёт, когда задачу вольют или когда конвейер встанет.'
          : 'Оцени результат и реши, что делать дальше.'),
      );
      // Исполнитель освобождается в finally — конвейер запускаем после него,
      // иначе доработку по ревью будет некому взять: автор всё ещё «занят».
      if (toPipeline) setTimeout(() => runPipeline(taskOffice, task.id), 0);
    } catch (err) {
      const message = (err as Error).message;

      if (taskOffice.stoppedByUser.delete(task.id)) {
        // Наработки не выбрасываем: то, что успели сделать, коммитим в ветку задачи.
        const fresh = taskOffice.tasks.get(task.id);
        let note = '⏹ Остановлена пользователем.';
        if (fresh?.branch) {
          const outcome = await commitAll(workRoot, `${task.id}: частичная работа (остановлено)`);
          note += outcome === 'committed'
            ? ` Сделанное закоммичено в ${fresh.branch}.`
            : ' Изменений в рабочей копии не было.';
        }
        taskOffice.updateTask(task.id, { status: 'blocked', result: note, finishedAt: Date.now() });
        taskOffice.addLog(inst.id, 'system', `Задача ${task.id} остановлена пользователем`);
        taskOffice.setState(inst.id, 'idle', null);
        notifyPm(taskOffice,
          `[СИСТЕМА] Задача ${task.id} остановлена пользователем вручную. ` +
          'Не назначай её заново по своей инициативе — дождись указания.',
        );
      } else {
        taskOffice.addLog(inst.id, 'error', `Задача ${task.id} упала: ${message}`);
        taskOffice.updateTask(task.id, { status: 'failed', result: `Ошибка: ${message}`, finishedAt: Date.now() });
        taskOffice.setState(inst.id, 'failed', 'ошибка');
        notifyPm(taskOffice, `[СИСТЕМА] Задача ${task.id} провалилась у ${inst.id}. Ошибка: ${message}`);
      }
    } finally {
      inst.currentTaskId = null;
      inst.abort = null;
      taskOffice.consultsByTask.delete(task.id);
      taskOffice.running = Math.max(0, taskOffice.running - 1);
      if (taskOffice.running === 0) taskOffice.setBusy(false);
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
  inst.abort = { abort: () => { void stopCloudTask(task.id); } } as AbortController;

  void (async () => {
    try {
      const outcome = await runCloudTask(task, inst, role, systemPrompt, taskOffice);

      if (taskOffice.stoppedByUser.delete(task.id)) {
        taskOffice.updateTask(task.id, {
          status: 'blocked',
          result: `⏹ Остановлена пользователем. ${outcome.branch
            ? `Сделанное осталось в ветке ${outcome.branch}.`
            : 'Ветка в origin, если исполнитель успел запушить.'}`,
          finishedAt: Date.now(),
          branch: outcome.branch, baseBranch: outcome.baseBranch,
        });
        taskOffice.setState(inst.id, 'idle', null);
        notifyPm(taskOffice,
          `[СИСТЕМА] Задача ${task.id} остановлена пользователем вручную. ` +
          'Не назначай её заново по своей инициативе — дождись указания.',
        );
        return;
      }

      if (!outcome.ok) throw new Error(outcome.summary);

      taskOffice.updateTask(task.id, {
        status: 'done', result: outcome.summary, finishedAt: Date.now(),
        branch: outcome.branch, baseBranch: outcome.baseBranch,
      });
      taskOffice.setState(inst.id, 'done', 'готово ✅');
      const fresh = taskOffice.tasks.get(task.id);
      const progress = fresh ? criteriaProgress(fresh) : { done: 0, total: 0 };
      notifyPm(taskOffice,
        `[СИСТЕМА] Задача ${task.id} «${task.title}» выполнена в облаке исполнителем ${inst.id}.\n` +
        `Отчёт: ${outcome.summary}\n` +
        (progress.total ? `Критерии: отмечено ${progress.done} из ${progress.total}.\n` : '') +
        (outcome.branch ? `Результат в ветке ${outcome.branch}, нужно слияние.\n` : '') +
        'Оцени результат и реши, что делать дальше.',
      );
    } catch (err) {
      const message = clip((err as Error).message, 300);
      taskOffice.addLog(inst.id, 'error', `Облачная задача ${task.id} упала: ${message}`);
      taskOffice.updateTask(task.id, { status: 'failed', result: `Ошибка: ${message}`, finishedAt: Date.now() });
      taskOffice.setState(inst.id, 'failed', 'ошибка');
      notifyPm(taskOffice, `[СИСТЕМА] Задача ${task.id} провалилась в облаке у ${inst.id}. Ошибка: ${message}`);
    } finally {
      inst.currentTaskId = null;
      inst.abort = null;
      taskOffice.running = Math.max(0, taskOffice.running - 1);
      if (taskOffice.running === 0) taskOffice.setBusy(false);
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
export function resetSessions(): void {
  // Сбрасывается текущий офис — чужие сессии трогать нельзя.
  office.pmQueue?.close();
  office.pmQueue = null;
  office.pmLoop = null;
  for (const [id, talk] of office.talks) {
    talk.queue.close();
    office.talks.delete(id);
  }
  for (const inst of office.instances.values()) inst.abort?.abort();
  office.stoppedByUser.clear();
  office.meetingRunning = false;
}

/** Прервать работу над задачей. Наработки сохраняются. */
export function stopTask(taskId: string): void {
  const task = office.tasks.get(taskId);
  if (!task) return;
  const inst = [...office.instances.values()].find((i) => i.currentTaskId === taskId);
  if (!inst?.abort) {
    office.addChat('офис', `${taskId} сейчас никто не выполняет — останавливать нечего.`);
    return;
  }
  office.stoppedByUser.add(taskId);
  inst.abort.abort();
}

/** Запустить задачу заново: с нуля, но с тем же ТЗ. */
export async function retryTask(taskId: string, from: OfficeState = office): Promise<boolean> {
  // Перезапуск ходит в git и потому длится: офис фиксируем на входе, иначе
  // после переключения задача уехала бы на доску соседнего проекта.
  const state = from;
  const task = state.tasks.get(taskId);
  if (!task) return false;
  if (task.status === 'in_progress') {
    state.addChat('офис', `${taskId} уже выполняется. Сначала остановите её.`);
    return false;
  }
  if (task.merged) {
    state.addChat('офис', `${taskId} уже влита в основную ветку — перезапуск создал бы дубль.`);
    return false;
  }
  if (state.paused) {
    state.addChat('офис', `Офис на паузе — ${taskId} не перезапускается. Снимите паузу (SPACE).`);
    return false;
  }
  const cloudBlocked = state.settings.engine === 'cloud' ? cloudProblem(state) : null;
  if (cloudBlocked) {
    state.addChat('офис', `Облачный режим не настроен: ${cloudBlocked}`);
    return false;
  }
  if (state.budgetExhausted()) {
    state.addChat('офис', 'Бюджет офиса исчерпан — поднимите лимит, прежде чем перезапускать задачи.');
    return false;
  }

  const roleId = task.roleId ?? 'backend';
  const noStaff = noStaffReason(roleId, state);
  if (noStaff) {
    state.addChat('офис', `${noStaff} Наймите сотрудника, чтобы перезапустить ${taskId}.`);
    return false;
  }
  const inst = state.findFree(roleId) ?? state.spawn(roleId) ?? state.findFree(roleId);
  if (!inst) {
    state.addChat('офис', `Все исполнители роли ${roleId} заняты — перезапустить ${taskId} сейчас некому.`);
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
        state.addChat('офис',
          `Наработки прошлой попытки ${taskId} сохранены в ветке ${kept} — она никуда не денется.`);
      }
    }
  }

  state.updateTask(taskId, {
    status: 'backlog', assigneeId: null, result: null, files: [],
    branch: null, baseBranch: null, worktreePath: null, merged: false,
    interrupted: false, attention: null,
    startedAt: null, finishedAt: null, usage: emptyUsage(),
    // Отметки прошлой попытки к новой не относятся: работа начинается с нуля.
    criteria: task.criteria.map((c) => ({ ...c, done: false })),
  });
  const fresh = state.tasks.get(taskId);
  if (fresh) startWorker(state, fresh, inst);
  state.addLog(null, 'system', `Задача ${taskId} перезапущена на ${inst.id}`);
  return Boolean(fresh);
}

/**
 * Отдать задачу конкретному исполнителю мимо менеджера.
 * PM об этом узнаёт: иначе доска и его представление о мире разойдутся.
 */
export function assignDirect(taskId: string, instanceId: string): void {
  const task = office.tasks.get(taskId);
  const inst = office.instances.get(instanceId);
  if (!task || !inst) return;
  if (task.assigneeId && task.status === 'in_progress') {
    office.addChat('офис', `${taskId} уже выполняется (${task.assigneeId}).`);
    return;
  }
  if (inst.currentTaskId) {
    office.addChat('офис', `${inst.label} занят задачей ${inst.currentTaskId}.`);
    return;
  }
  if (office.paused) {
    office.addChat('офис', `Офис на паузе — ${taskId} не запускается. Снимите паузу (SPACE).`);
    return;
  }
  const cloudBlocked = office.settings.engine === 'cloud' ? cloudProblem() : null;
  if (cloudBlocked) {
    office.addChat('офис', `Облачный режим не настроен: ${cloudBlocked}`);
    return;
  }
  if (office.budgetExhausted()) {
    office.addChat('офис', 'Бюджет офиса исчерпан — задача не запускается.');
    return;
  }
  office.updateTask(taskId, { roleId: inst.roleId });
  const fresh = office.tasks.get(taskId);
  if (!fresh) return;
  startWorker(office, fresh, inst);
  notifyPm(office,
    `[СИСТЕМА] Пользователь отдал задачу ${taskId} «${task.title}» напрямую исполнителю ${inst.id}, ` +
    'минуя тебя. Учти это в планах и не назначай её повторно.',
  );
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
  if (!task) return { ok: false, message: `задачи ${taskId} нет на доске` };
  if (task.status !== 'backlog') return { ok: false, message: `${taskId} уже не в очереди` };
  if (state.paused) return { ok: false, message: 'офис на паузе' };
  if (state.budgetExhausted()) return { ok: false, message: 'бюджет офиса исчерпан' };
  const cloudBlocked = state.settings.engine === 'cloud' ? cloudProblem(state) : null;
  if (cloudBlocked) return { ok: false, message: cloudBlocked };

  const roleId = task.roleId ?? 'backend';
  const noStaff = noStaffReason(roleId, state);
  if (noStaff) return { ok: false, message: noStaff };

  const inst = state.findFree(roleId) ?? state.spawn(roleId) ?? state.findFree(roleId);
  if (!inst || inst.currentTaskId) return { ok: false, message: `все исполнители роли ${roleId} заняты` };

  startWorker(state, task, inst);
  return { ok: true, message: inst.id };
}

/** Показать, что задача изменила: дифф её ветки против базовой. */
export async function taskDiff(taskId: string): Promise<void> {
  // git на большой ветке думает заметно: офис фиксируем на входе, иначе ответ
  // ушёл бы подписчикам того офиса, который человек успел открыть.
  const state = office;
  const task = state.tasks.get(taskId);
  const send = (patch: Partial<{ stat: string; patch: string; truncated: boolean; error: string }>) =>
    state.emit({ t: 'task.diff', taskId, stat: '', patch: '', truncated: false, ...patch });

  if (!task) return;
  if (!task.branch || !task.baseBranch) {
    send({ error: 'У задачи нет своей ветки — сравнивать не с чем.' });
    return;
  }
  if (task.merged) {
    send({ error: `Задача уже влита в ${task.baseBranch}, её ветка удалена. Смотрите историю основной ветки.` });
    return;
  }

  const result = await diffBranch(taskRepo(task, state), task.baseBranch, task.branch);
  if ('error' in result) send({ error: result.error });
  else if (!result.stat) send({ error: 'Изменений в ветке нет.' });
  else send(result);
}

/**
 * Пауза и снятие паузы офиса.
 * На паузе исполнители замирают на следующем вызове инструмента, а новая
 * работа не запускается. Уже начатый вызов доводится до конца: обрывать его
 * на середине — это «Остановить», а не пауза.
 */
export function setPaused(paused: boolean): void {
  if (office.paused === paused) return;
  office.setPaused(paused);
  office.addLog(null, 'system', paused ? 'Офис поставлен на паузу' : 'Офис снят с паузы');
  office.addChat('офис', paused
    ? '⏸ Офис на паузе: исполнители замрут на следующем действии, новые задачи не запускаются.'
    : '▶ Офис снова работает.');

  // Задачи, которые менеджер завёл на паузе, сами собой не поедут: он получил
  // отказ на assign_task и ждёт. Без этого напоминания доска молча стоит.
  const waiting = [...office.tasks.values()].filter((t) => t.status === 'backlog' && !t.assigneeId);
  if (!paused && waiting.length > 0) {
    notifyPm(office,
      `[СИСТЕМА] Пользователь снял офис с паузы. Ждут раздачи: ${waiting.map((t) => t.id).join(', ')}. ` +
      'Назначь их через assign_task.',
    );
  }
}

/** Загрузка текущего офиса: у каждого офиса свои живые сессии исполнителей. */
export function concurrency(): { running: number; max: number } {
  return { running: office.running, max: MAX_CONCURRENT_WORKERS };
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
  },
): Promise<SessionRun> {
  if (state.budgetExhausted()) {
    return { ok: false, text: '', error: 'Бюджет офиса исчерпан.', needsDecision: true };
  }
  const abort = new AbortController();
  inst.abort = abort;
  inst.currentTaskId = opts.taskId;
  state.setState(inst.id, 'working', opts.note);
  state.running += 1;
  state.setBusy(true);

  try {
    const session = query({
      prompt: opts.prompt,
      options: {
        model: role.model,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.systemPrompt },
        cwd: opts.cwd,
        tools: role.tools,
        mcpServers: opts.mcp,
        permissionMode: 'default',
        canUseTool: permissionHandler(state, inst.id, opts.taskId, opts.cwd),
        settingSources: [],
        sandbox: SANDBOX,
        maxTurns: workerTurns(state),
        maxBudgetUsd: state.settings.taskBudgetUsd ?? undefined,
        abortController: abort,
      },
    });

    let finalText = '';
    let failed: string | null = null;
    for await (const msg of session) {
      consume(state, inst.id, msg);
      if (msg.type === 'result') {
        if (isOk(msg)) finalText = msg.result ?? '';
        else failed = clip(resultReason(msg), 300);
      }
    }
    return { ok: !failed, text: finalText, error: failed };
  } catch (err) {
    return { ok: false, text: '', error: (err as Error).message };
  } finally {
    inst.currentTaskId = null;
    inst.abort = null;
    state.running = Math.max(0, state.running - 1);
    if (state.running === 0) state.setBusy(false);
    state.setState(inst.id, 'idle', null);
  }
}

/** Системный промпт исполнителя — один и тот же и для задачи, и для доработки. */
function workerSystemPrompt(role: Role, state: OfficeState): string {
  return [
    `Ты — ${role.title} в команде AI-агентов, работаешь в директории проекта.`,
    role.brief,
  ].join('\n') + projectBrief(state);
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
  if (!worktree) return { ok: false, message: 'У задачи нет рабочей копии.' };

  const inst = await waitForFree(state, roleId, task.assigneeId);
  if (!inst) {
    const empty = state.staffOf(roleId).length === 0;
    return {
      ok: false,
      // Все заняты — пройдёт само, надзор попробует позже. Роль пустая —
      // не пройдёт никогда: нанимать некому, кроме человека.
      needsDecision: empty,
      message: `Свободного исполнителя роли ${roleId} не нашлось: ` +
        (empty ? 'в роли никого нет, работать некому.' : 'все заняты дольше десяти минут.'),
    };
  }
  const role = roleById(inst.roleId);
  if (!role) return { ok: false, message: `Роль ${inst.roleId} исчезла из реестра.` };

  state.updateTask(task.id, { assigneeId: inst.id });
  const run = await runAgentSession(state, inst, role, {
    cwd: worktree,
    prompt: instruction,
    systemPrompt: workerSystemPrompt(role, state),
    taskId: task.id,
    mcp: { office: workerTools(state, inst.id, task) },
    note: 'дорабатывает по ревью',
  });
  if (!run.ok) {
    return {
      ok: false, message: run.error ?? 'сессия исполнителя не отработала',
      needsDecision: run.needsDecision,
    };
  }

  // Коммитим за автора, как и после обычной задачи: полагаться на то, что
  // он не забудет, нельзя — а незакоммиченная правка до ревью не доедет.
  const committed = await commitAll(worktree, `${task.id}: доработка`);
  if (committed === 'failed') return { ok: false, message: 'не удалось закоммитить доработку' };
  return { ok: true, message: committed === 'empty' ? 'изменений не потребовалось' : 'доработка закоммичена' };
}

/** Ревью пулл-реквеста: смотрит живой ревьюер и выносит вердикт инструментом. */
async function reviewPr(
  state: OfficeState, task: Task, pr: PullRequestView,
): Promise<ReviewOutcome> {
  const role = roleById('reviewer');
  if (!role) return { verdict: 'changes', text: '', reviewerId: null, error: 'Роли ревьюера нет в реестре.' };
  const inst = await waitForFree(state, 'reviewer', null);
  if (!inst) {
    const empty = state.staffOf('reviewer').length === 0;
    return {
      verdict: 'changes', text: '', reviewerId: null,
      needsDecision: empty,
      error: empty
        ? 'В роли ревьюера нет сотрудников — ревьюить некому. Нужно нанять ревьюера.'
        : 'Ревьюер занят дольше десяти минут.',
    };
  }

  let verdict: ReviewVerdict | null = null;
  let text = '';
  const tools = createSdkMcpServer({
    name: 'office',
    version: '1.0.0',
    instructions: 'Инструменты ревью.',
    tools: [
      tool(
        'say',
        'Сказать одной строкой, что ты сейчас смотришь. Появится пузырём над твоей головой.',
        { text: z.string().describe('До 70 символов') },
        async (args) => {
          state.setState(inst.id, 'working', clip(args.text));
          return { content: [{ type: 'text', text: 'ок' }] };
        },
      ),
      tool(
        'approve_pr',
        'Одобрить пулл-реквест. Вызывай, когда работа делает то, что обещала задача, ' +
        'и ты не нашёл ошибок, из-за которых её нельзя вливать. После этого офис вольёт ветку.',
        {
          summary: z.string().describe(
            'Отзыв: что проверил, что прогнал, почему считаешь, что можно вливать. Это увидит автор и пользователь.',
          ),
        },
        async (args) => {
          verdict = 'approve';
          text = args.summary;
          return { content: [{ type: 'text', text: 'Принято: пулл-реквест уходит на слияние.' }] };
        },
      ),
      tool(
        'request_changes',
        'Вернуть работу автору. Вызывай, когда нашёл ошибку, дыру в проверках или расхождение ' +
        'с тем, что обещала задача. Придирки к стилю ради стиля — не повод возвращать.',
        {
          summary: z.string().describe(
            'По пунктам: что не так, где именно (файл:строка), почему это важно и что сделать. ' +
            'Это единственное, что увидит автор, — общих слов он починить не сможет.',
          ),
        },
        async (args) => {
          verdict = 'changes';
          text = args.summary;
          return { content: [{ type: 'text', text: 'Принято: работа возвращается автору.' }] };
        },
      ),
    ],
  });

  const { done, total } = criteriaProgress(task);
  const diff = await prDiff(pr);
  const prompt = [
    `Ревью пулл-реквеста ${pr.branch} → ${pr.base} по задаче ${task.id}.`,
    pr.url ? `Пулл-реквест: ${pr.url}` : 'Пулл-реквест внутренний, на GitHub его нет.',
    '',
    `Задача: ${task.title}`,
    task.description,
    task.criteria.length
      ? `\nКритерии готовности (автор отметил ${done} из ${total}):\n` +
        task.criteria.map((c, i) => `${i + 1}. [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')
      : '',
    task.result ? `\nОтчёт автора:\n${task.result}` : '',
    pr.rounds ? `\nЭто круг ${pr.rounds + 1}: работу уже возвращали. Проверь, что прошлые замечания закрыты.` : '',
    pr.reviews.length
      ? `\nПрошлые отзывы:\n${pr.reviews.map((r) => `— ${r.verdict === 'approve' ? 'одобрено' : 'на доработку'}: ${clip(r.text, 400)}`).join('\n')}`
      : '',
    '',
    'Изменения ветки относительно базовой:',
    diff,
    '',
    `Ты находишься в рабочей копии этой ветки (${pr.repoDir === process.cwd() ? 'репозиторий проекта' : pr.branch}).`,
    'Прогони проверки проекта, если они есть (npm run typecheck и подобные), и учти их результат.',
    'Код НЕ правь: твой результат — вердикт, а исправляет автор.',
    'Закончи ровно одним вызовом: approve_pr({summary}) или request_changes({summary}).',
    `Возвращать работу можно не бесконечно: после ${MAX_ROUNDS} возвратов подряд задача уходит менеджеру.`,
    'Поэтому возвращай по существу, а мелкие замечания, не мешающие вливать, пиши в approve_pr.',
  ].filter(Boolean).join('\n');

  const run = await runAgentSession(state, inst, role, {
    cwd: task.worktreePath ?? pr.repoDir,
    prompt,
    systemPrompt: workerSystemPrompt(role, state),
    taskId: task.id,
    mcp: { office: tools },
    note: `ревью ${task.id}`,
  });

  if (!verdict) {
    return {
      verdict: 'changes', text: '', reviewerId: inst.id,
      needsDecision: run.needsDecision,
      error: run.error
        ? `сессия ревьюера оборвалась: ${run.error}`
        : 'ревьюер закончил, не вынеся вердикта (ни approve_pr, ни request_changes)',
    };
  }
  return { verdict, text, reviewerId: inst.id };
}

// Конвейер знает про офис только через эти три действия — сессии агентов
// живут здесь, а он остаётся про порядок шагов.
setPipelineAgents({ review: reviewPr, rework: reworkTask, notifyPm });

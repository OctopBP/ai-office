import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MessageQueue } from './queue';
import { criteriaProgress, office, taskRepo, type Instance, type Task } from './state';
import { emptyUsage } from '../shared/types';
import { cloudProblem, runCloudTask, stopCloudTask } from './cloud';
import { roleById, workerRoles, type Role } from './roles';
import { classify } from './permissions';
import { commitAll, createWorktree, diffBranch, hasCommits, hasWork, isRepo, preserveBranch, removeWorktree } from './git';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';

const MAX_CONCURRENT_WORKERS = 3;
const MAX_WORKER_TURNS = 60;

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
async function repoReady(dir: string): Promise<boolean> {
  if (dir === office.projectDir) return office.gitReady;
  return (await isRepo(dir)) && (await hasCommits(dir));
}

function projectBrief(): string {
  try {
    const text = readFileSync(resolve(office.projectDir, 'OFFICE.md'), 'utf8').trim();
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
/**
 * Куда складываем worktree задач — вне репозитория пользователя, чтобы не
 * сорить в нём. У каждого офиса своя папка: номера задач в разных проектах
 * совпадают, и общий корень склеил бы чужие рабочие копии.
 */
const worktreesRoot = (): string =>
  resolve(process.cwd(), '.office/worktrees', office.officeId);

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

let running = 0;
/** Задачи, которые пользователь остановил вручную — чтобы отличить это от падения. */
const stoppedByUser = new Set<string>();

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
 * `rememberSession` выключают короткоживущие сессии, которые не должны стать
 * «главным разговором» агента: иначе после перезапуска офис продолжит их,
 * а не переписку, ради которой сессия заводилась (см. совещание).
 */
function consume(instanceId: string, msg: SDKMessage, rememberSession = true): void {
  // Запоминаем id сессии, чтобы продолжить разговор после перезапуска сервера.
  if (msg.type === 'system' && msg.subtype === 'init') {
    if (rememberSession) office.setSessionId(instanceId, msg.session_id);
    return;
  }

  if (msg.type === 'assistant') {
    for (const block of msg.message.content ?? []) {
      if (block.type === 'thinking') {
        office.setState(instanceId, 'thinking', 'думает…');
      } else if (block.type === 'text') {
        const text = block.text?.trim();
        if (text) office.addLog(instanceId, 'text', clip(text, 400));
      } else if (block.type === 'tool_use') {
        const brief = toolBrief(block.name, block.input as Record<string, unknown>);
        office.setState(instanceId, 'working', brief);
        office.addLog(instanceId, 'tool', `${block.name}: ${brief}`);
      }
    }
    if (msg.error) office.addLog(instanceId, 'error', `Ошибка модели: ${msg.error}`);
    return;
  }

  if (msg.type === 'result') {
    const usage = 'usage' in msg ? msg.usage : undefined;
    // Кеш держим отдельной строкой, а не подмешиваем во ввод: он в разы
    // дешевле, и без разделения расход выглядит необъяснимым.
    office.addUsage(instanceId, {
      costUsd: msg.total_cost_usd ?? 0,
      tokensIn: usage?.input_tokens ?? 0,
      tokensOut: usage?.output_tokens ?? 0,
      cacheRead: usage?.cache_read_input_tokens ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    });
    if (!isOk(msg)) {
      const reason = resultReason(msg);
      office.addLog(instanceId, 'error', `Сессия завершилась ошибкой: ${clip(reason, 200)}`);
    }
  }
}

/**
 * Единственная точка, через которую проходит КАЖДЫЙ вызов инструмента.
 * Решает сама, если действие безопасно; иначе поднимает модалку пользователю
 * и блокирует агента до ответа.
 */
function permissionHandler(
  instanceId: string,
  taskId: string | null = null,
  /** Рабочая директория агента: у изолированной задачи это её worktree. */
  workdir: string = office.projectDir,
) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): Promise<PermissionResult> => {
    const inst = office.instances.get(instanceId);
    const role = inst ? roleById(inst.roleId) : undefined;
    const mode = role?.permissionMode ?? 'ask-risky';

    // Пауза офиса: сессия не убивается, а замирает перед следующим действием.
    // Это единственная точка, через которую проходит любой вызов инструмента,
    // поэтому здесь пауза и живёт — отдельного «стоп-крана» не нужно.
    //
    // Менеджер не замирает: на паузе с ним по-прежнему можно разговаривать
    // и планировать. Запускать работу он всё равно не сможет — assign_task
    // на паузе отказывает и объясняет почему.
    if (office.paused && inst && !role?.isManager) {
      const wasState = inst.state;
      const wasNote = inst.note;
      office.setState(instanceId, 'paused', 'офис на паузе');
      office.addLog(instanceId, 'system', `Пауза офиса: ${toolName} ждёт продолжения`);
      await office.whenResumed(options.signal);
      if (options.signal.aborted) {
        return { behavior: 'deny', message: 'Работа прервана, пока офис стоял на паузе.' };
      }
      office.setState(instanceId, wasState, wasNote);
    }

    const verdict = classify(toolName, input, workdir);

    if (verdict.risk === 'safe' || mode === 'auto') {
      return { behavior: 'allow', updatedInput: input };
    }

    if (mode === 'readonly') {
      return {
        behavior: 'deny',
        message: 'Эта роль работает в режиме «только чтение» и не может менять файлы или запускать команды.',
      };
    }

    if (role && office.isAlwaysDenied(role.id, verdict.key)) {
      return {
        behavior: 'deny',
        message: `Пользователь запретил «${verdict.key}» для этой роли до конца сессии. ` +
          'Не пытайся обойти запрет другим способом — реши задачу иначе или объясни в отчёте, почему нельзя.',
      };
    }

    if (role && office.isAlwaysAllowed(role.id, verdict.key)) {
      return { behavior: 'allow', updatedInput: input };
    }

    const mustAsk = mode === 'ask-writes' ? true : verdict.risk === 'danger';
    if (!mustAsk) return { behavior: 'allow', updatedInput: input };

    const prevState = inst?.state ?? 'working';
    const prevNote = inst?.note ?? null;
    office.setState(instanceId, 'waiting_approval', `ждёт разрешения: ${verdict.summary}`);
    office.addLog(instanceId, 'system', `Просит разрешение — ${toolName}: ${verdict.reason}`);

    const decision = await office.requestPermission(
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

    office.setState(instanceId, prevState, prevNote);

    if (decision === 'deny' || decision === 'never') {
      office.addLog(instanceId, 'system', `Пользователь запретил: ${verdict.summary}`);
      return {
        behavior: 'deny',
        message:
          'Пользователь запретил это действие. НЕ пытайся добиться того же результата обходным путём — ' +
          'через интерпретатор (python -c, node -e), другую утилиту или иной приём: это прямое нарушение запрета. ' +
          'Если без этого действия задачу не решить, прекрати попытки и напиши в отчёте, что именно заблокировано.',
      };
    }

    office.addLog(instanceId, 'system', `Пользователь разрешил: ${verdict.summary}`);
    return { behavior: 'allow', updatedInput: input };
  };
}

// ---------------------------------------------------------------- PM

/**
 * Доска задач текстом — по строке на задачу. Нужна в двух местах: инструменту
 * get_board и реплике менеджера на совещании. Файлов менеджер не видит, и доска
 * для него — единственный способ говорить о делах предметно, а не общими словами.
 */
function boardSummary(): string {
  const tasks = [...office.tasks.values()];
  if (!tasks.length) return 'Доска пуста.';
  return tasks.map((t) => {
    const { done, total } = criteriaProgress(t);
    const marks = t.criteria.map((c) => `${c.done ? '✓' : '·'} ${c.text}`).join('; ');
    return `${t.id} [${t.status}] ${t.title} → ${t.assigneeId ?? '—'}` +
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
Всё хорошо → скажи пользователю. Нужна доработка → создай и назначь новую задачу.
Когда все задачи по просьбе закрыты — дай короткое финальное резюме.

Как устроена изоляция (важно, иначе будешь ставить невыполнимые задачи и врать про результат):
- КАЖДЫЙ исполнитель работает в своей ветке и своей рабочей копии — и разработчики,
  и документные роли (дизайнер, SMM, юрист). Они не видят изменений друг друга,
  и в основной директории этих изменений пока нет.
- Результат попадает в основную ветку, когда пользователь нажмёт «Смержить» на карточке
  задачи. Так и говори: «готово, лежит в ветке задачи, нужно слияние».
- Не создавай задачу «проверить, что результаты обеих задач на месте»: до слияния веток
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
export function noStaffReason(roleId: string): string | null {
  if (office.staffOf(roleId).length > 0) return null;
  const title = roleById(roleId)?.title ?? roleId;
  return `В роли ${roleId} (${title}) сейчас нет ни одного сотрудника — вакансия открыта, работать некому.`;
}

/**
 * Состав команды словами — то, что менеджер видит в list_team.
 * Вынесено из инструмента, чтобы регрессии этого текста ловились проверкой,
 * а не сценарием с живой моделью: от него зависит, кому PM раздаёт задачи.
 */
export function teamSummary(): string {
  const lines = workerRoles().map((role) => {
    const insts = office.staffOf(role.id);
    // Роль без сотрудников — открытая вакансия: она есть в реестре, но
    // работать некому, пока пользователь не наймёт человека.
    const desc = insts.length
      ? insts.map((i) => `${i.id} — ${i.currentTaskId ? `занят (${i.currentTaskId})` : 'свободен'}`).join(', ')
      : 'сотрудников нет (можно нанять) — задачи этой роли выполнять некому';
    const first = role.brief.split('\n')[0] ?? '';
    const repo = office.repoFor(role);
    // Репозиторий называем, только если он свой: иначе строка одинаковая
    // у всех и лишь удлиняет ответ.
    const where = repo === office.projectDir ? '' : `\n  репозиторий: ${repo}`;
    return `- ${role.id} (${role.title})${first ? ` — ${first}` : ''}\n  ${desc}${where}` +
      `\n  результат: ${role.isolate ? 'в отдельной ветке, нужно слияние' : 'сразу в рабочей директории'}`;
  });
  return `Команда:\n${lines.join('\n')}`;
}

const teamTools = createSdkMcpServer({
  name: 'team',
  version: '1.0.0',
  instructions: 'Инструменты управления командой офиса.',
  tools: [
    tool(
      'list_team',
      'Показать состав команды: роли, конкретных исполнителей и кто сейчас свободен. Вызывай это первым делом, прежде чем создавать и раздавать задачи.',
      {},
      async () => ({ content: [{ type: 'text', text: teamSummary() }] }),
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
        const task = office.createTask({
          title: args.title,
          description: args.description,
          criteria,
          roleId: args.roleId,
        });
        // Предупреждаем сразу: иначе менеджер узнает о пустой роли только из
        // отказа assign_task и успеет пообещать пользователю работу.
        const empty = office.staffOf(args.roleId).length === 0
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
        if (office.paused) {
          return {
            content: [{
              type: 'text',
              text: 'Офис на паузе — новые задачи не запускаются. Задача остаётся на доске; ' +
                'скажи пользователю, что она ждёт снятия паузы, и не пытайся назначить её снова.',
            }],
            isError: true,
          };
        }
        const cloudBlocked = office.settings.engine === 'cloud' ? cloudProblem() : null;
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
        if (office.budgetExhausted()) {
          const cap = office.settings.globalBudgetUsd;
          return {
            content: [{
              type: 'text',
              text: `Общий бюджет офиса исчерпан: потрачено $${office.totalCost().toFixed(2)} из $${cap?.toFixed(2)}. ` +
                'Новые задачи не запускаются. Сообщи об этом пользователю — он поднимет лимит в настройках.',
            }],
            isError: true,
          };
        }

        const task = office.tasks.get(args.taskId);
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
        const noStaff = args.instanceId ? null : noStaffReason(roleId);
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
          ? office.instances.get(args.instanceId) ?? null
          : office.findFree(roleId) ?? office.spawn(roleId) ?? office.findFree(roleId);

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

        startWorker(task, inst);
        return { content: [{ type: 'text', text: `${task.id} назначена на ${inst.id}, работа началась. Не жди — раздавай остальные задачи.` }] };
      },
    ),

    tool(
      'get_board',
      'Текущее состояние доски задач со статусами и результатами.',
      {},
      async () => ({ content: [{ type: 'text', text: boardSummary() }] }),
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'say',
      'Сказать короткую реплику, которая появится пузырём над твоей головой в офисе. Используй, чтобы пользователь видел, чем ты занят.',
      { text: z.string().describe('До 70 символов') },
      async (args) => {
        office.setState('pm#1', office.instances.get('pm#1')?.state ?? 'working', clip(args.text));
        return { content: [{ type: 'text', text: 'ок' }] };
      },
    ),
  ],
});

let pmQueue: MessageQueue | null = null;
let pmLoop: Promise<void> | null = null;

function startPm(): void {
  if (pmLoop) return;
  const queue = new MessageQueue();
  pmQueue = queue;

  // Продолжаем прошлую сессию, если она известна: так PM помнит, о чём шла речь
  // до перезапуска, и не платит за пересборку контекста.
  const resumeId = office.instances.get('pm#1')?.sessionId ?? undefined;
  if (resumeId) office.addLog('pm#1', 'system', `Продолжаю сессию ${resumeId.slice(0, 8)}…`);

  const session = query({
    prompt: queue,
    options: {
      resume: resumeId,
      model: roleById('pm')!.model,
      systemPrompt: PM_PROMPT + projectBrief(),
      cwd: office.projectDir,
      tools: [],                         // у PM нет доступа к файлам — только командные инструменты
      mcpServers: { team: teamTools },
      permissionMode: 'default',
      canUseTool: permissionHandler('pm#1'),
      settingSources: [],                // не наследовать настройки Claude Code пользователя
      includePartialMessages: false,
    },
  });

  pmLoop = (async () => {
    try {
      for await (const msg of session) {
        consume('pm#1', msg);
        if (msg.type === 'result') {
          if (isOk(msg) && msg.result?.trim()) {
            office.addChat('pm#1', msg.result.trim());
          } else if (!isOk(msg)) {
            const reason = resultReason(msg);
            office.addChat('офис', `⚠️ PM не смог ответить: ${clip(reason, 300)}`);
            office.setState('pm#1', 'failed', 'ошибка');
          }
          if (office.instances.get('pm#1')?.state !== 'failed') {
            office.setState('pm#1', 'idle', null);
          }
          office.setBusy(running > 0);
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      office.addLog('pm#1', 'error', `Сессия PM упала: ${message}`);
      if (resumeId) {
        // Скорее всего прошлой сессии уже нет на диске — забываем её,
        // чтобы следующее сообщение начало разговор заново.
        office.setSessionId('pm#1', '');
        office.addChat('офис',
          '⚠️ Не удалось продолжить прошлую сессию PM. Она забыта — отправьте сообщение ещё раз, ' +
          'разговор начнётся заново (доска задач при этом сохранена).');
      } else {
        office.addChat('офис', `⚠️ Сессия PM упала: ${clip(message, 200)}`);
      }
      office.setState('pm#1', 'failed', 'сессия упала');
    } finally {
      // Сессию могли уже заменить (например сбросом офиса) — тогда очередь
      // принадлежит новой сессии, и обнулять ссылки нельзя: её сообщения
      // ушли бы в никуда.
      if (pmQueue === queue) {
        pmLoop = null;
        pmQueue = null;
      }
    }
  })();
}

/** Сообщение пользователя PM'у. */
export function sendUserMessage(text: string): void {
  startPm();
  office.addChat('user', text);
  office.setState('pm#1', 'thinking', 'читает задачу…');
  office.setBusy(true);
  pmQueue?.push(text);
}

/** Системное уведомление PM'у (например, о завершении задачи). */
function notifyPm(text: string): void {
  startPm();
  pmQueue?.push(text);
}

// ---------------------------------------------------------------- совещание

let meetingRunning = false;

/** Менеджер ли это — спрашиваем у роли: признак задан флагом isManager, а не id. */
const isManager = (inst: Instance): boolean => roleById(inst.roleId)?.isManager ?? false;

/**
 * Совещание: участники высказываются по очереди, каждый видит сказанное до него.
 * Это не свободный чат всех со всеми — такой формат быстро уходит в бесконечное
 * согласование. Итог уходит менеджеру: действовать по результату всё равно ему.
 */
export async function holdMeeting(topic: string, participantIds: string[]): Promise<void> {
  if (meetingRunning) {
    office.addChat('офис', 'Совещание уже идёт — дождитесь окончания.', 'meeting');
    return;
  }
  // Раньше менеджер отсеивался здесь по роли: считалось, что он не участник,
  // а адресат итога. На практике половина тем — про приоритеты и сроки, и
  // обсуждать их без него бессмысленно. Теперь он такой же участник: реплику
  // на совещании он даёт отдельной короткой сессией, а его основная сессия
  // (переписка с пользователем и раздача задач) при этом продолжает работать.
  // Дубликаты в списке убираем — иначе агент высказался бы дважды подряд.
  const participants = [...new Set(participantIds)]
    .map((id) => office.instances.get(id))
    .filter((i): i is Instance => Boolean(i));

  if (participants.length < 2) {
    office.addChat('офис', 'Для совещания нужно минимум два участника.', 'meeting');
    return;
  }
  // Занятость проверяем только у исполнителей: у менеджера задач на руках не
  // бывает, а прерывать из-за совещания обработку доски мы и не хотим.
  const busy = participants.find((i) => !isManager(i) && i.currentTaskId);
  if (busy) {
    office.addChat('офис',
      `${busy.label} занят задачей ${busy.currentTaskId}. Дождитесь окончания или остановите задачу.`,
      'meeting');
    return;
  }
  if (office.paused) {
    office.addChat('офис', 'Офис на паузе — совещание не начинается. Снимите паузу (SPACE).', 'meeting');
    return;
  }
  if (office.budgetExhausted()) {
    office.addChat('офис', 'Бюджет офиса исчерпан — совещание не запускается.', 'meeting');
    return;
  }

  meetingRunning = true;
  const id = `M-${Date.now().toString(36)}`;
  office.setMeeting({ id, topic, participants: participants.map((p) => p.id), speaking: null, status: 'running' });
  office.addChat('user', `Тема совещания: ${topic}`, 'meeting');
  // Что было до совещания — чтобы вернуть менеджера ровно туда, откуда позвали:
  // его сессия живёт своей жизнью, и «свободен» после совещания было бы враньём,
  // если он в это время разбирал сообщение пользователя.
  const stateBefore = new Map(participants.map((p) => [p.id, { state: p.state, note: p.note }]));
  for (const p of participants) office.setState(p.id, 'talking', 'на совещании');

  const said: Array<{ id: string; title: string; text: string }> = [];

  try {
    for (const inst of participants) {
      const role = roleById(inst.roleId);
      if (!role) continue;
      office.setMeeting({ id, topic, participants: participants.map((p) => p.id), speaking: inst.id, status: 'running' });
      office.setState(inst.id, 'talking', 'говорит');

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
        ? `Тема совещания: ${topic}\n\n${before}Доска задач сейчас:\n${boardSummary()}\n\n${turn}`
        : `Тема совещания: ${topic}\n\n${before}${turn}`;

      let text = '';
      if (office.dryRun) {
        // Проверяем поведение менеджера, а не содержательность реплик:
        // настоящие сессии участников тут не нужны и стоили бы дорого.
        text = `[заглушка] Мнение роли ${role.title} по теме «${topic}».`;
        said.push({ id: inst.id, title: role.title, text });
        office.addChat(inst.id, text, 'meeting');
        office.setState(inst.id, 'talking', 'на совещании');
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
          systemPrompt: systemPrompt.join('\n') + projectBrief(),
          cwd: office.repoFor(role),
          tools: isManager(inst) ? [] : ['Read', 'Glob', 'Grep'],
          permissionMode: 'default',
          canUseTool: permissionHandler(inst.id),
          settingSources: [],
          sandbox: SANDBOX,
          maxTurns: 8,
        },
      });

      for await (const msg of session) {
        // Расход этой сессии пишем на агента, а её id — не запоминаем: у
        // менеджера он затёр бы id основного разговора с пользователем, и после
        // перезапуска офис продолжил бы совещание вместо переписки.
        consume(inst.id, msg, !isManager(inst));
        if (msg.type === 'result' && isOk(msg)) text = msg.result?.trim() ?? '';
      }

      if (text) {
        said.push({ id: inst.id, title: role.title, text });
        office.addChat(inst.id, text, 'meeting');
      } else {
        office.addChat('офис', `${inst.label} не смог высказаться.`, 'meeting');
      }
      office.setState(inst.id, 'talking', 'на совещании');
    }

    office.setMeeting({ id, topic, participants: participants.map((p) => p.id), speaking: null, status: 'done' });
    office.addChat('офис',
      'Совещание окончено. Итог и решения менеджер напишет в чате с ним.', 'meeting');

    // Стенограмма уходит менеджеру в любом случае — итог подводит он. Если он
    // сам был на совещании, предупреждаем об этом: иначе он примет собственную
    // реплику за чужую и станет спорить сам с собой.
    const pmWasThere = participants.some(isManager);
    notifyPm(
      `[СИСТЕМА] Прошло совещание по теме «${topic}».` +
      (pmWasThere ? ' Ты был на нём — в стенограмме есть и твоя реплика.' : '') +
      '\n\n' +
      said.map((s) => `${s.title} (${s.id}):\n${s.text}`).join('\n\n') +
      '\n\nПодведи короткий итог для пользователя: к чему пришли, где расходятся мнения ' +
      'и какие задачи из этого следуют. Задачи пока НЕ создавай — сначала дождись согласия пользователя.',
    );
  } catch (err) {
    office.addChat('офис', `⚠️ Совещание оборвалось: ${clip((err as Error).message, 200)}`, 'meeting');
    office.setMeeting({ id, topic, participants: participants.map((p) => p.id), speaking: null, status: 'failed' });
  } finally {
    meetingRunning = false;
    for (const p of participants) {
      if (isManager(p)) {
        // Менеджера возвращаем в то состояние, в котором позвали. Но только если
        // совещание — последнее, что его меняло: его собственная сессия могла за
        // это время взять новое сообщение, и её «думает…» затирать нельзя.
        const prev = stateBefore.get(p.id);
        if (prev && p.state === 'talking') office.setState(p.id, prev.state, prev.note);
        continue;
      }
      if (!p.currentTaskId) office.setState(p.id, 'idle', null);
    }
    setTimeout(() => { if (office.meeting?.id === id) office.setMeeting(null); }, 20000);
  }
}

// ---------------------------------------------------------------- прямой разговор

/** Живые разговоры пользователя с конкретными исполнителями, мимо PM. */
const talks = new Map<string, { queue: MessageQueue; loop: Promise<void> }>();

/**
 * Прямой диалог с агентом. Это отдельная сессия, не связанная с задачами:
 * можно спросить совета, уточнить решение, обсудить подход.
 */
export function talkTo(instanceId: string, text: string): void {
  const inst = office.instances.get(instanceId);
  if (!inst) return;
  const role = roleById(inst.roleId);
  if (!role) return;

  if (inst.currentTaskId) {
    office.addChat('офис',
      `${inst.label} сейчас занят задачей ${inst.currentTaskId}. Дождитесь окончания — ` +
      'прерывать работу посреди задачи дороже, чем подождать.', instanceId);
    return;
  }

  office.addChat('user', text, instanceId);

  const existing = talks.get(instanceId);
  if (existing) {
    office.setState(instanceId, 'talking', 'разговор с вами');
    existing.queue.push(text);
    return;
  }

  const queue = new MessageQueue();
  queue.push(text);
  office.setState(instanceId, 'talking', 'разговор с вами');

  const systemPrompt = [
    `Ты — ${role.title} в команде AI-агентов.`,
    role.brief,
    '',
    'Сейчас с тобой напрямую разговаривает пользователь — это не задача с доски.',
    'Отвечай по существу и коротко. Ты можешь смотреть файлы проекта, чтобы ответить',
    'предметно, но НЕ меняй их: правки делаются только в рамках поставленной задачи.',
    'Если пользователь просит что-то изменить — скажи, что для этого нужно поставить',
    'задачу через менеджера.',
  ].join('\n') + projectBrief();

  const session = query({
    prompt: queue,
    options: {
      model: role.model,
      systemPrompt,
      cwd: office.repoFor(role),
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      permissionMode: 'default',
      canUseTool: permissionHandler(instanceId),
      settingSources: [],
      sandbox: SANDBOX,
    },
  });

  const loop = (async () => {
    try {
      for await (const msg of session) {
        consume(instanceId, msg);
        if (msg.type === 'result') {
          if (isOk(msg) && msg.result?.trim()) {
            office.addChat(instanceId, msg.result.trim(), instanceId);
          } else if (!isOk(msg)) {
            office.addChat('офис', `⚠️ ${clip(resultReason(msg), 200)}`, instanceId);
          }
          if (!office.instances.get(instanceId)?.currentTaskId) {
            office.setState(instanceId, 'idle', null);
          }
        }
      }
    } catch (err) {
      office.addChat('офис', `⚠️ Разговор оборвался: ${clip((err as Error).message, 200)}`, instanceId);
    } finally {
      talks.delete(instanceId);
    }
  })();

  talks.set(instanceId, { queue, loop });
}

// ---------------------------------------------------------------- исполнители

/**
 * Сколько раз за задачу можно спросить коллег. Ограничение не про деньги, а
 * про то, чтобы исполнитель не заменял работу перепиской: пять вопросов — это
 * уже разговор, а не справка.
 */
const MAX_CONSULTS_PER_TASK = 5;
const consultsByTask = new Map<string, number>();

/**
 * Вопрос коллеге другой роли. Нужен, потому что роли работают в разных
 * репозиториях: лезть в чужой код — и медленно, и опасно (можно поправить
 * то, за что отвечает другой), а гадать — ещё хуже.
 *
 * Отвечает НАСТОЯЩАЯ сессия той роли в ЕЁ репозитории, только на чтение и без
 * офисных инструментов: тогда отвечающий не может ни изменить свой проект, ни
 * позвать третьего — цепочка вопросов не уходит в бесконечность.
 */
async function consultRole(
  askerId: string, roleId: string, question: string, taskId: string,
): Promise<{ ok: boolean; text: string }> {
  const asker = office.instances.get(askerId);
  const role = roleById(roleId);
  if (!asker) return { ok: false, text: 'Спрашивающий не найден.' };
  if (!role || role.isManager) {
    const names = workerRoles().map((r) => r.id).join(', ');
    return { ok: false, text: `Роли «${roleId}» нет. Есть: ${names}.` };
  }
  if (role.id === asker.roleId) {
    return { ok: false, text: 'Это твоя собственная роль — отвечать на такой вопрос тебе.' };
  }

  const used = consultsByTask.get(taskId) ?? 0;
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
  const answerer = [...office.instances.values()].find(
    (i) => i.roleId === roleId && !i.currentTaskId && i.state !== 'talking',
  );
  if (!answerer) {
    return {
      ok: false,
      text: `Все исполнители роли «${role.title}» сейчас заняты. Реши сам и опиши ` +
        'в отчёте, на какое предположение опирался.',
    };
  }

  consultsByTask.set(taskId, used + 1);
  const askerRole = roleById(asker.roleId);
  office.addLog(askerId, 'system', `Вопрос к ${answerer.id}: ${clip(question, 120)}`);
  office.emit({ t: 'handoff', from: askerId, to: answerer.id, text: clip(question, 60) });

  const prevState = asker.state;
  const prevNote = asker.note;
  office.setState(askerId, 'talking', `спрашивает ${answerer.label}`);
  office.setState(answerer.id, 'talking', `отвечает ${asker.label}`);

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
        ].join('\n') + projectBrief(),
        cwd: office.repoFor(role),
        // Только чтение и никаких офисных инструментов: отвечающий не должен
        // ни править свой проект, ни звать третьего.
        tools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'default',
        canUseTool: permissionHandler(answerer.id),
        settingSources: [],
        sandbox: SANDBOX,
        maxTurns: 12,
      },
    });
    for await (const msg of session) {
      consume(answerer.id, msg);
      if (msg.type === 'result' && isOk(msg)) text = msg.result?.trim() ?? '';
    }
  } catch (err) {
    text = '';
    office.addLog(answerer.id, 'error', `Не удалось ответить: ${(err as Error).message}`);
  }

  office.setState(answerer.id, 'idle', null);
  office.setState(askerId, prevState, prevNote);

  if (!text) {
    return { ok: false, text: `${answerer.label} не смог ответить. Реши сам и опиши допущение в отчёте.` };
  }
  office.addLog(answerer.id, 'text', `Ответ ${asker.id}: ${clip(text, 300)}`);
  return { ok: true, text: `Ответил ${answerer.label} (${role.title}):\n\n${text}` };
}

function workerTools(instanceId: string, task: Task) {
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
          office.setState(instanceId, 'working', clip(args.text));
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
          const outcome = office.checkCriterion(task.id, args.index, args.done);
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
          const answer = await consultRole(instanceId, args.role, args.question, task.id);
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
          const fresh = office.tasks.get(task.id);
          const { done, total } = fresh ? criteriaProgress(fresh) : { done: 0, total: 0 };
          // Неотмеченные пункты не «дожимаем» за исполнителя: расхождение между
          // «сдал» и «отмечено» — это и есть сигнал пользователю посмотреть внимательнее.
          const gap = total && done < total
            ? `\n\n⚠️ Отмечено критериев: ${done} из ${total}.`
            : '';
          office.updateTask(task.id, {
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

function startWorker(task: Task, inst: Instance): void {
  const role = roleById(inst.roleId);
  if (!role) return;

  inst.currentTaskId = task.id;
  office.updateTask(task.id, {
    assigneeId: inst.id, status: 'in_progress', startedAt: Date.now(), finishedAt: null,
  });
  office.emit({ t: 'handoff', from: 'pm#1', to: inst.id, text: task.title });
  office.setState(inst.id, 'working', 'берётся за задачу');

  // Режим проверки поведения менеджера: настоящую сессию исполнителя не поднимаем.
  // Так сценарии прогоняются за секунды и стоят только токенов PM.
  if (office.dryRun) {
    // Задержку поднимают в тестах, где нужно успеть вмешаться в работу.
    const delay = Number(process.env.OFFICE_DRY_RUN_DELAY ?? 250);

    const finish = (stopped: boolean) => {
      inst.currentTaskId = null;
      inst.abort = null;
      office.setState(inst.id, 'idle', null);
      if (stopped) {
        stoppedByUser.delete(task.id);
        office.updateTask(task.id, {
          status: 'blocked', result: '⏹ Остановлена пользователем.', finishedAt: Date.now(),
        });
        notifyPm(
          `[СИСТЕМА] Задача ${task.id} остановлена пользователем вручную. ` +
          'Не назначай её заново по своей инициативе — дождись указания.',
        );
        return;
      }
      office.updateTask(task.id, {
        status: 'done',
        result: `[заглушка] Задача «${task.title}» выполнена.`,
        finishedAt: Date.now(),
        criteria: task.criteria.map((c) => ({ ...c, done: true })),
      });
      notifyPm(
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

  running += 1;
  office.setBusy(true);

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
  ].join('\n') + projectBrief();

  if (office.settings.engine === 'cloud') {
    startCloudWorker(task, inst, role, systemPrompt);
    return;
  }

  const abort = new AbortController();
  inst.abort = abort;

  // Роль может работать в своём репозитории: ветка, diff и слияние задачи
  // пойдут именно в него. Фиксируем его на задаче — потом по ней мержат и
  // сравнивают, а правку роли к тому времени могли уже поменять.
  const repoDir = office.repoFor(role);
  office.updateTask(task.id, { repoDir });

  (async () => {
    let workdir = repoDir;
    // Корень рабочей копии нужен и в catch (коммит наработок при остановке),
    // поэтому объявлен снаружи try.
    let workRoot = repoDir;
    try {
      // Изоляция: своя ветка и свой worktree, чтобы параллельные исполнители
      // физически не могли затереть друг другу файлы.
      if (role.isolate && await repoReady(repoDir)) {
        const wt = await createWorktree(repoDir, worktreesRoot(), task.id);
        if (wt) {
          workdir = wt.path;
          workRoot = wt.path;
          office.updateTask(task.id, {
            branch: wt.branch, baseBranch: wt.base, worktreePath: wt.path,
          });
          office.addLog(inst.id, 'system', `Рабочая копия: ${wt.branch}`);
        } else {
          office.addLog(inst.id, 'error',
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
          mcpServers: { office: workerTools(inst.id, task) },
          permissionMode: 'default',
          canUseTool: permissionHandler(inst.id, task.id, workdir),
          settingSources: [],
          sandbox: SANDBOX,
          maxTurns: MAX_WORKER_TURNS,
          maxBudgetUsd: office.settings.taskBudgetUsd ?? undefined,
          abortController: abort,
        },
      });

      let finalText = '';
      let sessionFailed: string | null = null;
      for await (const msg of session) {
        consume(inst.id, msg);
        if (msg.type === 'result') {
          if (isOk(msg)) finalText = msg.result ?? '';
          else sessionFailed = clip(resultReason(msg), 300);
        }
      }

      if (sessionFailed) throw new Error(sessionFailed);

      const fresh = office.tasks.get(task.id);
      let summary = fresh?.result ?? clip(finalText, 600) ?? 'Задача завершена без отчёта.';

      // Коммитим сами: полагаться на то, что исполнитель не забудет, нельзя.
      if (fresh?.branch) {
        const outcome = await commitAll(workRoot, `${task.id}: ${task.title}`);
        if (outcome === 'committed') {
          office.addLog(inst.id, 'system', `Изменения закоммичены в ${fresh.branch}`);
        } else if (outcome === 'empty') {
          summary += '\n\n⚠️ Файлы не изменились — коммитить нечего.';
          office.addLog(inst.id, 'system', 'Изменений в рабочей копии нет');
        } else {
          office.addLog(inst.id, 'error', `Не удалось закоммитить ветку ${fresh.branch}`);
        }
      }

      office.updateTask(task.id, { status: 'done', result: summary, finishedAt: Date.now() });
      office.setState(inst.id, 'done', 'готово ✅');
      const progress = fresh ? criteriaProgress(fresh) : { done: 0, total: 0 };
      notifyPm(
        `[СИСТЕМА] Задача ${task.id} «${task.title}» завершена исполнителем ${inst.id}.\n` +
        `Отчёт: ${summary}\n` +
        (progress.total ? `Критерии: отмечено ${progress.done} из ${progress.total}.\n` : '') +
        (fresh?.files.length ? `Файлы: ${fresh.files.join(', ')}\n` : '') +
        'Оцени результат и реши, что делать дальше.',
      );
    } catch (err) {
      const message = (err as Error).message;

      if (stoppedByUser.delete(task.id)) {
        // Наработки не выбрасываем: то, что успели сделать, коммитим в ветку задачи.
        const fresh = office.tasks.get(task.id);
        let note = '⏹ Остановлена пользователем.';
        if (fresh?.branch) {
          const outcome = await commitAll(workRoot, `${task.id}: частичная работа (остановлено)`);
          note += outcome === 'committed'
            ? ` Сделанное закоммичено в ${fresh.branch}.`
            : ' Изменений в рабочей копии не было.';
        }
        office.updateTask(task.id, { status: 'blocked', result: note, finishedAt: Date.now() });
        office.addLog(inst.id, 'system', `Задача ${task.id} остановлена пользователем`);
        office.setState(inst.id, 'idle', null);
        notifyPm(
          `[СИСТЕМА] Задача ${task.id} остановлена пользователем вручную. ` +
          'Не назначай её заново по своей инициативе — дождись указания.',
        );
      } else {
        office.addLog(inst.id, 'error', `Задача ${task.id} упала: ${message}`);
        office.updateTask(task.id, { status: 'failed', result: `Ошибка: ${message}`, finishedAt: Date.now() });
        office.setState(inst.id, 'failed', 'ошибка');
        notifyPm(`[СИСТЕМА] Задача ${task.id} провалилась у ${inst.id}. Ошибка: ${message}`);
      }
    } finally {
      inst.currentTaskId = null;
      inst.abort = null;
      consultsByTask.delete(task.id);
      running = Math.max(0, running - 1);
      if (running === 0) office.setBusy(false);
      setTimeout(() => {
        if (!inst.currentTaskId) office.setState(inst.id, 'idle', null);
      }, 4000);
    }
  })().catch(() => { /* обработано выше */ });
}

/**
 * Исполнитель в облаке. Отличий от локального два: работу делает контейнер
 * Anthropic, а результат приезжает готовой веткой из GitHub — своей рабочей
 * копии и коммита от офиса тут нет.
 */
function startCloudWorker(task: Task, inst: Instance, role: Role, systemPrompt: string): void {
  // Прерывание идёт событием в сессию, а не сигналом процессу.
  inst.abort = { abort: () => { void stopCloudTask(task.id); } } as AbortController;

  void (async () => {
    try {
      const outcome = await runCloudTask(task, inst, role, systemPrompt);

      if (stoppedByUser.delete(task.id)) {
        office.updateTask(task.id, {
          status: 'blocked',
          result: `⏹ Остановлена пользователем. ${outcome.branch
            ? `Сделанное осталось в ветке ${outcome.branch}.`
            : 'Ветка в origin, если исполнитель успел запушить.'}`,
          finishedAt: Date.now(),
          branch: outcome.branch, baseBranch: outcome.baseBranch,
        });
        office.setState(inst.id, 'idle', null);
        notifyPm(
          `[СИСТЕМА] Задача ${task.id} остановлена пользователем вручную. ` +
          'Не назначай её заново по своей инициативе — дождись указания.',
        );
        return;
      }

      if (!outcome.ok) throw new Error(outcome.summary);

      office.updateTask(task.id, {
        status: 'done', result: outcome.summary, finishedAt: Date.now(),
        branch: outcome.branch, baseBranch: outcome.baseBranch,
      });
      office.setState(inst.id, 'done', 'готово ✅');
      const fresh = office.tasks.get(task.id);
      const progress = fresh ? criteriaProgress(fresh) : { done: 0, total: 0 };
      notifyPm(
        `[СИСТЕМА] Задача ${task.id} «${task.title}» выполнена в облаке исполнителем ${inst.id}.\n` +
        `Отчёт: ${outcome.summary}\n` +
        (progress.total ? `Критерии: отмечено ${progress.done} из ${progress.total}.\n` : '') +
        (outcome.branch ? `Результат в ветке ${outcome.branch}, нужно слияние.\n` : '') +
        'Оцени результат и реши, что делать дальше.',
      );
    } catch (err) {
      const message = clip((err as Error).message, 300);
      office.addLog(inst.id, 'error', `Облачная задача ${task.id} упала: ${message}`);
      office.updateTask(task.id, { status: 'failed', result: `Ошибка: ${message}`, finishedAt: Date.now() });
      office.setState(inst.id, 'failed', 'ошибка');
      notifyPm(`[СИСТЕМА] Задача ${task.id} провалилась в облаке у ${inst.id}. Ошибка: ${message}`);
    } finally {
      inst.currentTaskId = null;
      inst.abort = null;
      running = Math.max(0, running - 1);
      if (running === 0) office.setBusy(false);
      setTimeout(() => {
        if (!inst.currentTaskId) office.setState(inst.id, 'idle', null);
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
  pmQueue?.close();
  pmQueue = null;
  pmLoop = null;
  for (const [id, talk] of talks) {
    talk.queue.close();
    talks.delete(id);
  }
  for (const inst of office.instances.values()) inst.abort?.abort();
  stoppedByUser.clear();
  meetingRunning = false;
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
  stoppedByUser.add(taskId);
  inst.abort.abort();
}

/** Запустить задачу заново: с нуля, но с тем же ТЗ. */
export async function retryTask(taskId: string): Promise<void> {
  const task = office.tasks.get(taskId);
  if (!task) return;
  if (task.status === 'in_progress') {
    office.addChat('офис', `${taskId} уже выполняется. Сначала остановите её.`);
    return;
  }
  if (task.merged) {
    office.addChat('офис', `${taskId} уже влита в основную ветку — перезапуск создал бы дубль.`);
    return;
  }
  if (office.paused) {
    office.addChat('офис', `Офис на паузе — ${taskId} не перезапускается. Снимите паузу (SPACE).`);
    return;
  }
  const cloudBlocked = office.settings.engine === 'cloud' ? cloudProblem() : null;
  if (cloudBlocked) {
    office.addChat('офис', `Облачный режим не настроен: ${cloudBlocked}`);
    return;
  }
  if (office.budgetExhausted()) {
    office.addChat('офис', 'Бюджет офиса исчерпан — поднимите лимит, прежде чем перезапускать задачи.');
    return;
  }

  const roleId = task.roleId ?? 'backend';
  const noStaff = noStaffReason(roleId);
  if (noStaff) {
    office.addChat('офис', `${noStaff} Наймите сотрудника, чтобы перезапустить ${taskId}.`);
    return;
  }
  const inst = office.findFree(roleId) ?? office.spawn(roleId) ?? office.findFree(roleId);
  if (!inst) {
    office.addChat('офис', `Все исполнители роли ${roleId} заняты — перезапустить ${taskId} сейчас некому.`);
    return;
  }

  // Если в прошлой попытке что-то успели сделать — сохраняем ветку под другим
  // именем, а не удаляем: при остановке офис обещал, что работа не пропадёт.
  const repo = taskRepo(task);
  if (task.branch && task.baseBranch && await repoReady(repo)) {
    const worthKeeping = await hasWork(repo, task.branch, task.baseBranch);
    if (task.worktreePath) {
      await removeWorktree(repo, task.worktreePath, task.branch,
        { keepBranch: worthKeeping });
    }
    if (worthKeeping) {
      const kept = await preserveBranch(repo, task.branch);
      if (kept) {
        office.addChat('офис',
          `Наработки прошлой попытки ${taskId} сохранены в ветке ${kept} — она никуда не денется.`);
      }
    }
  }

  office.updateTask(taskId, {
    status: 'backlog', assigneeId: null, result: null, files: [],
    branch: null, baseBranch: null, worktreePath: null, merged: false,
    startedAt: null, finishedAt: null, usage: emptyUsage(),
    // Отметки прошлой попытки к новой не относятся: работа начинается с нуля.
    criteria: task.criteria.map((c) => ({ ...c, done: false })),
  });
  const fresh = office.tasks.get(taskId);
  if (fresh) startWorker(fresh, inst);
  office.addLog(null, 'system', `Задача ${taskId} перезапущена на ${inst.id}`);
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
  startWorker(fresh, inst);
  notifyPm(
    `[СИСТЕМА] Пользователь отдал задачу ${taskId} «${task.title}» напрямую исполнителю ${inst.id}, ` +
    'минуя тебя. Учти это в планах и не назначай её повторно.',
  );
}

/** Показать, что задача изменила: дифф её ветки против базовой. */
export async function taskDiff(taskId: string): Promise<void> {
  const task = office.tasks.get(taskId);
  const send = (patch: Partial<{ stat: string; patch: string; truncated: boolean; error: string }>) =>
    office.emit({ t: 'task.diff', taskId, stat: '', patch: '', truncated: false, ...patch });

  if (!task) return;
  if (!task.branch || !task.baseBranch) {
    send({ error: 'У задачи нет своей ветки — сравнивать не с чем.' });
    return;
  }
  if (task.merged) {
    send({ error: `Задача уже влита в ${task.baseBranch}, её ветка удалена. Смотрите историю основной ветки.` });
    return;
  }

  const result = await diffBranch(taskRepo(task), task.baseBranch, task.branch);
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
    notifyPm(
      `[СИСТЕМА] Пользователь снял офис с паузы. Ждут раздачи: ${waiting.map((t) => t.id).join(', ')}. ` +
      'Назначь их через assign_task.',
    );
  }
}

export function concurrency(): { running: number; max: number } {
  return { running, max: MAX_CONCURRENT_WORKERS };
}

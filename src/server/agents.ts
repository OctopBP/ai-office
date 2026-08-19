import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MessageQueue } from './queue';
import { office, type Instance, type Task } from './state';
import { roleById, workerRoles } from './roles';
import { classify } from './permissions';
import { commitAll, createWorktree, hasWork, mergeBranch, preserveBranch, removeWorktree } from './git';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';

const MAX_CONCURRENT_WORKERS = 3;
const MAX_WORKER_TURNS = 60;

/**
 * Песочница ОС для исполнителей (на macOS — встроенный Seatbelt, ставить нечего).
 * Второй слой защиты, а не замена модалки разрешений: песочница держит границу
 * по файлам и сети, но не мешает послать сигнал процессу (kill) или сделать
 * git push. Эти действия по-прежнему ловит классификатор рисков.
 *
 * По умолчанию запись разрешена только в рабочую директорию сессии (cwd) и
 * временную папку — то есть в workspace/, и никуда больше.
 */
/** Куда складываем worktree задач — вне репозитория пользователя, чтобы не сорить в нём. */
const WORKTREES_ROOT = resolve(process.cwd(), '.office/worktrees');

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

/** Разбор потока сообщений SDK в состояние офиса и события UI. */
function consume(instanceId: string, msg: SDKMessage): void {
  // Запоминаем id сессии, чтобы продолжить разговор после перезапуска сервера.
  if (msg.type === 'system' && msg.subtype === 'init') {
    office.setSessionId(instanceId, msg.session_id);
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
    office.addCost(instanceId, msg.total_cost_usd ?? 0);
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

    if (decision === 'deny') {
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
- Роли, меняющие КОД (backend, frontend), работают каждая в СВОЕЙ ветке и своей рабочей копии.
  Они не видят изменений друг друга, и в основной директории этих изменений пока нет.
  Их результат пользователь вводит в основную ветку кнопкой «Смержить» на карточке задачи.
- Роли, работающие с ДОКУМЕНТАМИ (design, smm, legal), веток НЕ используют: они пишут файлы
  сразу в рабочую директорию, в свою папку docs/<роль>/<задача>/. Никакого слияния для них
  не нужно, и предлагать «Смержить» по таким задачам — ошибка.
- Не создавай задачу «проверить, что результаты обеих задач на месте»: до слияния веток
  проверять нечего, и исполнитель честно ничего не найдёт.
- Если сомневаешься, есть ли у задачи ветка, посмотри get_board, а не выдумывай.

Правила декомпозиции:
- Исполнитель НЕ видит вашу переписку с пользователем. Всё нужное пиши в description задачи:
  что сделать, где, в каком стиле, какие файлы и технологии.
- В acceptanceCriteria пиши проверяемый результат («файл api/notes.js экспортирует CRUD-роуты»),
  а не «сделано хорошо».
- Не создавай задачи «обсудить», «подумать», «спланировать» — только те, у которых есть артефакт.
- Не дроби на микрозадачи: 2–4 задачи на типичную просьбу.

Отвечай пользователю по-русски и коротко.`;

const teamTools = createSdkMcpServer({
  name: 'team',
  version: '1.0.0',
  instructions: 'Инструменты управления командой офиса.',
  tools: [
    tool(
      'list_team',
      'Показать состав команды: роли, конкретных исполнителей и кто сейчас свободен. Вызывай это первым делом, прежде чем создавать и раздавать задачи.',
      {},
      async () => {
        const lines = workerRoles().map((role) => {
          const insts = [...office.instances.values()].filter((i) => i.roleId === role.id);
          const desc = insts.map((i) => `${i.id} — ${i.currentTaskId ? `занят (${i.currentTaskId})` : 'свободен'}`).join(', ');
          const first = role.brief.split('\n')[0] ?? '';
          return `- ${role.id} (${role.title})${first ? ` — ${first}` : ''}\n  ${desc}` +
            `\n  результат: ${role.isolate ? 'в отдельной ветке, нужно слияние' : 'сразу в рабочей директории'}`;
        });
        return { content: [{ type: 'text', text: `Команда:\n${lines.join('\n')}` }] };
      },
      { annotations: { readOnlyHint: true } },
    ),

    tool(
      'create_task',
      'Создать задачу на доске. Одна задача = один исполнитель = один осязаемый результат. Возвращает id задачи, который нужно передать в assign_task.',
      {
        title: z.string().describe('Короткий заголовок, до 60 символов'),
        description: z.string().describe('Полное ТЗ для исполнителя. Он не видит переписку с пользователем — опиши всё: что сделать, в каких файлах, каким стеком.'),
        acceptanceCriteria: z.string().describe('Проверяемый критерий готовности'),
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
        const task = office.createTask({
          title: args.title,
          description: args.description,
          acceptanceCriteria: args.acceptanceCriteria,
          roleId: args.roleId,
        });
        return { content: [{ type: 'text', text: `Создана задача ${task.id}: ${task.title} (роль ${args.roleId})` }] };
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
        const inst = args.instanceId
          ? office.instances.get(args.instanceId) ?? null
          : office.findFree(roleId) ?? office.spawn(roleId) ?? office.findFree(roleId);

        if (!inst) {
          return {
            content: [{ type: 'text', text: `Все исполнители роли ${roleId} заняты, свободных рабочих мест нет. Дождись завершения текущих задач.` }],
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
      async () => {
        const tasks = [...office.tasks.values()];
        if (!tasks.length) return { content: [{ type: 'text', text: 'Доска пуста.' }] };
        const lines = tasks.map((t) =>
          `${t.id} [${t.status}] ${t.title} → ${t.assigneeId ?? '—'}${t.result ? `\n    результат: ${clip(t.result, 160)}` : ''}`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      },
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
      systemPrompt: PM_PROMPT,
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
      pmLoop = null;
      pmQueue = null;
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
  const participants = participantIds
    .map((id) => office.instances.get(id))
    .filter((i): i is NonNullable<typeof i> => Boolean(i) && i!.roleId !== 'pm');

  if (participants.length < 2) {
    office.addChat('офис', 'Для совещания нужно минимум два участника, кроме менеджера.', 'meeting');
    return;
  }
  const busy = participants.find((i) => i.currentTaskId);
  if (busy) {
    office.addChat('офис',
      `${busy.label} занят задачей ${busy.currentTaskId}. Дождитесь окончания или остановите задачу.`,
      'meeting');
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

      const prompt =
        `Тема совещания: ${topic}\n\n${before}` +
        'Твоя очередь. Ответь по существу, 3–6 предложений: что важно с точки зрения твоей роли, ' +
        'с чем согласен или не согласен из сказанного, что предлагаешь конкретно. ' +
        'Не повторяй уже сказанное и не пересказывай тему.';

      let text = '';
      const session = query({
        prompt,
        options: {
          model: role.model,
          systemPrompt: [
            `Ты — ${role.title} в команде AI-агентов.`,
            role.brief,
            '',
            'Ты на рабочем совещании с коллегами. Говори как специалист своей роли: коротко,',
            'предметно, без вежливых вступлений. Можешь посмотреть файлы проекта, чтобы',
            'говорить по делу, но менять ничего нельзя.',
          ].join('\n'),
          cwd: office.projectDir,
          tools: ['Read', 'Glob', 'Grep'],
          permissionMode: 'default',
          canUseTool: permissionHandler(inst.id),
          settingSources: [],
          sandbox: SANDBOX,
          maxTurns: 8,
        },
      });

      for await (const msg of session) {
        consume(inst.id, msg);
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

    notifyPm(
      `[СИСТЕМА] Прошло совещание по теме «${topic}».\n\n` +
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
  ].join('\n');

  const session = query({
    prompt: queue,
    options: {
      model: role.model,
      systemPrompt,
      cwd: office.projectDir,
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
        'finish_task',
        'Сдать выполненную задачу. Вызывай ровно один раз, когда работа полностью закончена.',
        {
          summary: z.string().describe('Что сделано, 2–4 предложения. Это увидит PM.'),
          files: z.array(z.string()).default([]).describe('Пути к созданным и изменённым файлам'),
        },
        async (args) => {
          office.updateTask(task.id, { result: args.summary, files: args.files, status: 'review' });
          return { content: [{ type: 'text', text: 'Работа принята офисом.' }] };
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
    `Критерий готовности: ${task.acceptanceCriteria}`,
    '',
    artifactsDir
      ? `Твоя рабочая директория — ${artifactsDir}/, туда и клади все файлы по этой задаче. ` +
        `Исходники проекта лежат в ${projectDir} — их можно читать, но не менять: ` +
        'рядом параллельно работают коллеги. Запись за пределы своей папки будет ' +
        'остановлена и потребует подтверждения пользователя.'
      : '',
    'Выполни задачу полностью и самостоятельно, затем вызови finish_task.',
  ].filter(Boolean).join('\n');
}

function startWorker(task: Task, inst: Instance): void {
  const role = roleById(inst.roleId);
  if (!role) return;

  inst.currentTaskId = task.id;
  office.updateTask(task.id, { assigneeId: inst.id, status: 'in_progress' });
  office.emit({ t: 'handoff', from: 'pm#1', to: inst.id, text: task.title });
  office.setState(inst.id, 'working', 'берётся за задачу');

  // Режим проверки поведения менеджера: настоящую сессию исполнителя не поднимаем.
  // Так сценарии прогоняются за секунды и стоят только токенов PM.
  if (office.dryRun) {
    setTimeout(() => {
      inst.currentTaskId = null;
      office.setState(inst.id, 'idle', null);
      office.updateTask(task.id, {
        status: 'done',
        result: `[заглушка] Задача «${task.title}» выполнена.`,
      });
      notifyPm(
        `[СИСТЕМА] Задача ${task.id} «${task.title}» завершена исполнителем ${inst.id}.\n` +
        `Отчёт: [заглушка] Задача выполнена.\nОцени результат и реши, что делать дальше.`,
      );
    }, 250);
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
    'Перед каждым логическим шагом вызывай say({text}) — пользователь видит это над твоей головой.',
    'Когда всё готово — вызови finish_task({summary, files}).',
  ].join('\n');

  const abort = new AbortController();
  inst.abort = abort;

  (async () => {
    let workdir = office.projectDir;
    try {
      // Изоляция: своя ветка и свой worktree, чтобы параллельные исполнители
      // физически не могли затереть друг другу файлы.
      if (role.isolate && office.gitReady) {
        const wt = await createWorktree(office.projectDir, WORKTREES_ROOT, task.id);
        if (wt) {
          workdir = wt.path;
          office.updateTask(task.id, {
            branch: wt.branch, baseBranch: wt.base, worktreePath: wt.path,
          });
          office.addLog(inst.id, 'system', `Рабочая копия: ${wt.branch}`);
        } else {
          office.addLog(inst.id, 'error',
            `Не удалось создать worktree для ${task.id}, работаю в общей директории`);
        }
      }

      // Роли без изоляции веткой складывают артефакты в свою папку —
      // так двое SMM или дизайнеров не пишут в один и тот же файл.
      let artifactsDir: string | null = null;
      if (!role.isolate && role.docsDir) {
        artifactsDir = `${role.docsDir}/${task.id}`;
        const abs = resolve(office.projectDir, artifactsDir);
        try {
          mkdirSync(abs, { recursive: true });
        } catch { /* создаст сам исполнитель */ }
        // Рабочая директория — папка задачи, а не весь проект. Тогда песочница
        // не пустит запись наружу через оболочку, а классификатор пометит
        // запись вне папки как выход за периметр и спросит пользователя.
        // Раньше это была просьба в промпте, и юрист её уже нарушал.
        workdir = abs;
      }

      const session = query({
        prompt: workerPrompt(task, artifactsDir, office.projectDir),
        options: {
          model: role.model,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
          cwd: workdir,
          // Проект остаётся читаемым: писать нельзя, смотреть можно.
          additionalDirectories: artifactsDir ? [office.projectDir] : undefined,
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
        const outcome = await commitAll(workdir, `${task.id}: ${task.title}`);
        if (outcome === 'committed') {
          office.addLog(inst.id, 'system', `Изменения закоммичены в ${fresh.branch}`);
        } else if (outcome === 'empty') {
          summary += '\n\n⚠️ Файлы не изменились — коммитить нечего.';
          office.addLog(inst.id, 'system', 'Изменений в рабочей копии нет');
        } else {
          office.addLog(inst.id, 'error', `Не удалось закоммитить ветку ${fresh.branch}`);
        }
      }

      office.updateTask(task.id, { status: 'done', result: summary });
      office.setState(inst.id, 'done', 'готово ✅');
      notifyPm(
        `[СИСТЕМА] Задача ${task.id} «${task.title}» завершена исполнителем ${inst.id}.\n` +
        `Отчёт: ${summary}\n` +
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
          const outcome = await commitAll(workdir, `${task.id}: частичная работа (остановлено)`);
          note += outcome === 'committed'
            ? ` Сделанное закоммичено в ${fresh.branch}.`
            : ' Изменений в рабочей копии не было.';
        }
        office.updateTask(task.id, { status: 'blocked', result: note });
        office.addLog(inst.id, 'system', `Задача ${task.id} остановлена пользователем`);
        office.setState(inst.id, 'idle', null);
        notifyPm(
          `[СИСТЕМА] Задача ${task.id} остановлена пользователем вручную. ` +
          'Не назначай её заново по своей инициативе — дождись указания.',
        );
      } else {
        office.addLog(inst.id, 'error', `Задача ${task.id} упала: ${message}`);
        office.updateTask(task.id, { status: 'failed', result: `Ошибка: ${message}` });
        office.setState(inst.id, 'failed', 'ошибка');
        notifyPm(`[СИСТЕМА] Задача ${task.id} провалилась у ${inst.id}. Ошибка: ${message}`);
      }
    } finally {
      inst.currentTaskId = null;
      inst.abort = null;
      running = Math.max(0, running - 1);
      if (running === 0) office.setBusy(false);
      setTimeout(() => {
        if (!inst.currentTaskId) office.setState(inst.id, 'idle', null);
      }, 4000);
    }
  })().catch(() => { /* обработано выше */ });
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
  if (office.budgetExhausted()) {
    office.addChat('офис', 'Бюджет офиса исчерпан — поднимите лимит, прежде чем перезапускать задачи.');
    return;
  }

  const roleId = task.roleId ?? 'backend';
  const inst = office.findFree(roleId) ?? office.spawn(roleId) ?? office.findFree(roleId);
  if (!inst) {
    office.addChat('офис', `Все исполнители роли ${roleId} заняты — перезапустить ${taskId} сейчас некому.`);
    return;
  }

  // У документных ролей роль ветки играет папка задачи — её тоже сохраняем.
  const assignee = task.assigneeId ? office.instances.get(task.assigneeId) : null;
  const retryRole = roleById(assignee?.roleId ?? task.roleId ?? '');
  if (retryRole && !retryRole.isolate && retryRole.docsDir) {
    const dir = resolve(office.projectDir, retryRole.docsDir, taskId);
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      for (let n = 1; n < 50; n += 1) {
        const target = `${dir}.stopped-${n}`;
        if (existsSync(target)) continue;
        try {
          renameSync(dir, target);
          office.addChat('офис',
            `Наработки прошлой попытки ${taskId} сохранены в ${retryRole.docsDir}/${taskId}.stopped-${n}.`);
        } catch { /* не смогли — не страшно, продолжаем */ }
        break;
      }
    }
  }

  // Если в прошлой попытке что-то успели сделать — сохраняем ветку под другим
  // именем, а не удаляем: при остановке офис обещал, что работа не пропадёт.
  if (task.branch && task.baseBranch && office.gitReady) {
    const worthKeeping = await hasWork(office.projectDir, task.branch, task.baseBranch);
    if (task.worktreePath) {
      await removeWorktree(office.projectDir, task.worktreePath, task.branch,
        { keepBranch: worthKeeping });
    }
    if (worthKeeping) {
      const kept = await preserveBranch(office.projectDir, task.branch);
      if (kept) {
        office.addChat('офис',
          `Наработки прошлой попытки ${taskId} сохранены в ветке ${kept} — она никуда не денется.`);
      }
    }
  }

  office.updateTask(taskId, {
    status: 'backlog', assigneeId: null, result: null, files: [],
    branch: null, baseBranch: null, worktreePath: null, merged: false,
  });
  const fresh = office.tasks.get(taskId);
  if (fresh) startWorker(fresh, inst);
  office.addLog(null, 'system', `Задача ${taskId} перезапущена на ${inst.id}`);
}

/** Влить ветку задачи в основную и убрать worktree. Вызывается кнопкой из UI. */
export async function mergeTask(taskId: string): Promise<void> {
  const task = office.tasks.get(taskId);
  if (!task) return;
  if (!task.branch || !task.baseBranch) {
    office.addChat('офис', `У задачи ${taskId} нет отдельной ветки — сливать нечего.`);
    return;
  }
  if (task.merged) {
    office.addChat('офис', `${taskId} уже влита в ${task.baseBranch}.`);
    return;
  }

  const outcome = await mergeBranch(office.projectDir, task.branch, task.baseBranch);
  office.addChat('офис', `${taskId}: ${outcome.message}`);
  office.addLog(null, outcome.ok ? 'system' : 'error', `merge ${task.branch}: ${outcome.kind}`);

  if (outcome.ok) {
    if (task.worktreePath) {
      await removeWorktree(office.projectDir, task.worktreePath, task.branch);
    }
    office.updateTask(taskId, { merged: true, worktreePath: null });
  }
}

export function concurrency(): { running: number; max: number } {
  return { running, max: MAX_CONCURRENT_WORKERS };
}

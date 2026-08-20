/**
 * Облачный режим: задачу выполняет не локальный Claude Code, а Managed
 * Agents — Anthropic держит и цикл агента, и контейнер, в котором работают
 * инструменты.
 *
 * Что это меняет по существу:
 * - Файлы рождаются НЕ в вашей папке, а в контейнере. Поэтому проект должен
 *   лежать на GitHub: контейнер монтирует репозиторий, исполнитель коммитит
 *   и пушит ветку задачи, а офис забирает её к себе (`git fetch`) — только
 *   после этого работают «Показать diff» и «Смержить».
 * - Расход идёт в ПЛАТНЫЙ API, а не в лимиты подписки Claude Code. Без
 *   ANTHROPIC_API_KEY облачный режим недоступен.
 * - Наша песочница ОС и классификатор рисков к контейнеру не применяются:
 *   границу держит сам контейнер. Что остаётся нашим — подтверждения:
 *   режим разрешений роли раскладывается в permission_policy инструментов,
 *   и «спросить» приходит в ту же модалку, что и локально.
 */
import Anthropic from '@anthropic-ai/sdk';
import { criteriaProgress, office, type Instance, type Task } from './state';
import type { Role } from './roles';
import { currentBranch, fetchBranch, remoteUrl } from './git';

/**
 * Токен GitHub держим только в памяти процесса. Класть чужой токен с правом
 * записи в JSON-файл рядом с доской — плохой размен: состояние офиса никак
 * не защищено, а токен утекает вместе с ним.
 */
let token: string | null = process.env.OFFICE_GITHUB_TOKEN?.trim() || null;

export const githubToken = (): string | null => token;
export const setGithubToken = (value: string): void => {
  token = value.trim() || null;
};

let client: Anthropic | null = null;
const agentIds = new Map<string, string>();   // ключ конфигурации роли → id агента
let environmentId: string | null = null;
/** Сессии идущих облачных задач — по ним работает «Остановить». */
const sessions = new Map<string, string>();

const clip = (s: unknown, n = 70): string => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

/** Почему облачный режим сейчас не запустится. null — всё готово. */
export function cloudProblem(): string | null {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return 'Облачный режим работает только на платном API: задайте ANTHROPIC_API_KEY и перезапустите сервер.';
  }
  if (!office.settings.cloudRepoUrl) {
    return 'Не указан репозиторий на GitHub — контейнеру нечего монтировать. Укажите его в настройках.';
  }
  if (!token) {
    return 'Нет токена GitHub с доступом на запись — исполнитель не сможет запушить ветку задачи. Введите его в настройках (он не сохраняется на диск) или задайте OFFICE_GITHUB_TOKEN.';
  }
  return null;
}

function api(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** Контейнер один на офис: настройки одинаковые, а создание стоит времени. */
async function ensureEnvironment(): Promise<string> {
  if (environmentId) return environmentId;
  const name = `ai-office-${office.officeId}`;
  try {
    const env = await api().beta.environments.create({
      name,
      config: { type: 'cloud', networking: { type: 'unrestricted' } },
    });
    environmentId = env.id;
  } catch (err) {
    // Имя окружения уникально: после перезапуска сервера оно уже создано.
    const existing = await findEnvironment(name);
    if (!existing) throw err;
    environmentId = existing;
  }
  return environmentId;
}

async function findEnvironment(name: string): Promise<string | null> {
  for await (const env of api().beta.environments.list()) {
    if (env.name === name) return env.id;
  }
  return null;
}

/**
 * Набор инструментов агента. Режим разрешений роли раскладывается в политики:
 * readonly вообще не получает запись и оболочку, ask-writes спрашивает про
 * любую правку, ask-risky — только про оболочку.
 */
/** Имена встроенных инструментов контейнера — так их знает Managed Agents. */
type ToolName = 'bash' | 'edit' | 'glob' | 'grep' | 'read' | 'web_fetch' | 'web_search' | 'write';

function toolset(role: Role) {
  const writeTools: ToolName[] = ['write', 'edit', 'bash'];
  const ask = { type: 'always_ask' as const };

  if (role.permissionMode === 'readonly') {
    return {
      type: 'agent_toolset_20260401' as const,
      default_config: { enabled: true },
      configs: writeTools.map((name) => ({ name, enabled: false })),
    };
  }
  // Документным ролям оболочка не нужна — как и локально.
  const configs: Array<{ name: ToolName; enabled?: boolean; permission_policy?: typeof ask }> =
    role.docsDir ? [{ name: 'bash', enabled: false }] : [];

  if (role.permissionMode === 'ask-writes') {
    for (const name of writeTools) {
      if (!configs.some((c) => c.name === name)) configs.push({ name, permission_policy: ask });
    }
  } else if (role.permissionMode === 'ask-risky' && !role.docsDir) {
    configs.push({ name: 'bash', permission_policy: ask });
  }

  return { type: 'agent_toolset_20260401' as const, default_config: { enabled: true }, configs };
}

/** Инструменты офиса — те же, что локально, но исполняет их наш сервер. */
const OFFICE_TOOLS = [
  {
    type: 'custom' as const,
    name: 'say',
    description: 'Сказать одной строкой, что ты делаешь прямо сейчас. Появится пузырём над твоей головой в офисе. Вызывай перед каждым логическим шагом работы.',
    input_schema: {
      type: 'object' as const,
      properties: { text: { type: 'string', description: 'До 70 символов, настоящее время' } },
      required: ['text'],
    },
  },
  {
    type: 'custom' as const,
    name: 'check_criterion',
    description: 'Отметить критерий готовности выполненным. Вызывай сразу, как пункт действительно сделан и проверен.',
    input_schema: {
      type: 'object' as const,
      properties: {
        index: { type: 'integer', description: 'Номер критерия из списка в задаче, начиная с 1' },
        done: { type: 'boolean', description: 'false — снять отметку' },
      },
      required: ['index'],
    },
  },
  {
    type: 'custom' as const,
    name: 'finish_task',
    description: 'Сдать выполненную задачу. Вызывай ровно один раз, когда работа закончена и ветка запушена.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Что сделано, 2–4 предложения. Это увидит PM.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Пути к созданным и изменённым файлам' },
      },
      required: ['summary'],
    },
  },
];

/**
 * Агент — постоянный объект: создаём один раз на конфигурацию роли и
 * переиспользуем. Ключ включает всё, что попадает в агента, — поменяли
 * промпт или модель в редакторе ролей, появится новый агент.
 */
async function ensureAgent(role: Role, systemPrompt: string): Promise<string> {
  const key = `${role.id}:${role.model}:${role.permissionMode}:${systemPrompt.length}:${systemPrompt.slice(0, 64)}`;
  const known = agentIds.get(key);
  if (known) return known;

  const agent = await api().beta.agents.create({
    name: `AI Office — ${role.title}`,
    model: role.model,
    system: systemPrompt,
    tools: [toolset(role), ...OFFICE_TOOLS],
  });
  agentIds.set(key, agent.id);
  return agent.id;
}

function workerPrompt(task: Task, role: Role, branch: string, base: string, mount: string): string {
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
    `Репозиторий проекта примонтирован в ${mount}, текущая ветка — ${base}.`,
    role.docsDir
      ? `Файлы по этой задаче клади в ${mount}/${role.docsDir}/${task.id}/ и больше никуда.`
      : '',
    'Порядок работы с гитом (без него результат никто не увидит):',
    `1. git checkout -b ${branch}`,
    '2. Сделай работу и закоммить её.',
    `3. git push -u origin ${branch}`,
    '4. Вызови finish_task({summary, files}).',
    '',
    'Работай самостоятельно и до конца. Перед каждым шагом вызывай say({text}).',
  ].filter(Boolean).join('\n');
}

/** Прервать облачную задачу. Сессия остаётся, работа фиксируется в ветке. */
export async function stopCloudTask(taskId: string): Promise<boolean> {
  const sessionId = sessions.get(taskId);
  if (!sessionId) return false;
  try {
    await api().beta.sessions.events.send(sessionId, { events: [{ type: 'user.interrupt' }] });
    return true;
  } catch {
    return false;
  }
}

export interface CloudOutcome {
  ok: boolean;
  summary: string;
  branch: string | null;
  baseBranch: string | null;
}

/**
 * Выполнить задачу в облаке. Возвращает исход; статусы задачи и состояние
 * агента по ходу дела обновляются здесь же, как и у локального движка.
 */
export async function runCloudTask(
  task: Task, inst: Instance, role: Role, systemPrompt: string,
): Promise<CloudOutcome> {
  const repoUrl = office.settings.cloudRepoUrl!;
  const base = (await currentBranch(office.projectDir)) ?? 'main';
  const branch = `task/${task.id}`;
  const mount = '/workspace/repo';

  const [environment, agentId] = await Promise.all([
    ensureEnvironment(),
    ensureAgent(role, systemPrompt),
  ]);

  const cap = office.settings.taskBudgetUsd;
  const session = await api().beta.sessions.create({
    agent: agentId,
    environment_id: environment,
    title: `${task.id} · ${clip(task.title, 40)}`,
    resources: [{
      type: 'github_repository',
      url: repoUrl,
      authorization_token: token!,
      mount_path: mount,
      checkout: { type: 'branch', name: base },
    }],
    initial_events: [{
      type: 'user.message',
      content: [{ type: 'text', text: workerPrompt(task, role, branch, base, mount) }],
    }],
    // Бюджет задачи здесь жёсткий и считается платформой: дойдя до потолка,
    // сессия встаёт на паузу, а не тратит дальше.
    ...(cap ? { budget: { type: 'limit' as const, max_list_cost: { amount: String(Math.round(cap * 100)), currency: 'USD' } } } : {}),
  });

  sessions.set(task.id, session.id);
  office.addLog(inst.id, 'system', `Облачная сессия ${session.id.slice(0, 12)}… (${repoUrl})`);

  let finished: string | null = null;
  let files: string[] = [];
  let failure: string | null = null;
  let costRecorded = 0;

  try {
    // Поток не отдаёт то, что случилось до подписки, а сессия стартует сразу
    // из initial_events. Поэтому: открыть поток, дочитать историю, дальше
    // склеивать по id — иначе первые события теряются.
    const stream = await api().beta.sessions.events.stream(session.id);
    const seen = new Set<string>();
    const handled: string[] = [];

    const step = (e: CloudEvent) =>
      consume(e, task, inst, session.id, (s, f) => { finished = s; files = f; }, handled);

    for await (const past of api().beta.sessions.events.list(session.id)) {
      const e = past as unknown as CloudEvent;
      if (e.id) seen.add(e.id);
      if (await step(e)) return await settle();
    }

    for await (const event of stream) {
      const e = event as unknown as CloudEvent;
      // Превью-события потока (event_start / event_delta) своего id не имеют
      // и ничего не добавляют: содержимое придёт готовым событием.
      if (!e.id || seen.has(e.id)) continue;
      seen.add(e.id);
      if (await step(e)) break;
    }
  } catch (err) {
    failure = (err as Error).message;
  }

  return await settle();

  /** Свести итог: расход, ветка и отчёт. */
  async function settle(): Promise<CloudOutcome> {
    sessions.delete(task.id);
    try {
      const fresh = await api().beta.sessions.retrieve(session.id);
      const usage = fresh.usage;
      const cents = Number(usage?.list_cost?.amount ?? 0);
      office.addUsage(inst.id, {
        costUsd: Math.max(0, cents / 100 - costRecorded),
        tokensIn: usage?.input_tokens ?? 0,
        tokensOut: usage?.output_tokens ?? 0,
        cacheRead: usage?.cache_read_input_tokens ?? 0,
        cacheWrite: (usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0)
          + (usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0),
      });
      costRecorded = cents / 100;
    } catch { /* расход уже не узнать — не повод терять результат */ }

    if (failure) return { ok: false, summary: failure, branch: null, baseBranch: null };

    // Ветку тянем к себе: без неё «Показать diff» и «Смержить» пусты.
    const pulled = await fetchBranch(office.projectDir, branch);
    const note = pulled
      ? ''
      : `\n\n⚠️ Ветка ${branch} не подтянулась из origin — посмотрите её на GitHub.`;
    const summary = (finished ?? 'Сессия завершилась без отчёта.') + note;
    if (files.length) office.updateTask(task.id, { files });
    return {
      ok: finished !== null,
      summary,
      branch: pulled ? branch : null,
      baseBranch: pulled ? base : null,
    };
  }
}

/**
 * Один событие потока → состояние офиса. Возвращает true, когда сессия
 * закончила работу и читать дальше нечего.
 */
/** Событие потока в удобном для разбора виде: SDK-типы здесь только мешают. */
type CloudEvent = { type: string; id?: string } & Record<string, unknown>;

async function consume(
  event: CloudEvent,
  task: Task,
  inst: Instance,
  sessionId: string,
  onFinish: (summary: string, files: string[]) => void,
  handled: string[],
): Promise<boolean> {
  const send = (events: unknown[]) =>
    api().beta.sessions.events.send(sessionId, { events: events as never });

  switch (event.type) {
    case 'agent.message': {
      const blocks = (event.content ?? []) as Array<{ type: string; text?: string }>;
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ').trim();
      if (text) office.addLog(inst.id, 'text', clip(text, 400));
      return false;
    }
    case 'agent.thinking':
      office.setState(inst.id, 'thinking', 'думает…');
      return false;
    case 'agent.tool_use': {
      const name = String(event.name ?? '');
      const brief = clip(JSON.stringify(event.input ?? {}), 60);
      office.setState(inst.id, 'working', `${name}: ${brief}`);
      office.addLog(inst.id, 'tool', `${name}: ${brief}`);
      if (event.evaluated_permission === 'ask' && event.id && !handled.includes(event.id)) {
        handled.push(event.id);
        const decision = await office.requestPermission({
          agentId: inst.id,
          taskId: task.id,
          toolName: name,
          summary: `${name} в облачном контейнере`,
          detail: JSON.stringify(event.input ?? {}, null, 2),
          risk: name === 'bash' ? 'danger' : 'write',
          reason: 'действие в облачном контейнере: наша песочница на него не распространяется',
          key: `cloud:${name}`,
        });
        const allow = decision === 'allow' || decision === 'always';
        await send([{
          type: 'user.tool_confirmation',
          tool_use_id: event.id,
          result: allow ? 'allow' : 'deny',
          ...(allow ? {} : { deny_message: 'Пользователь запретил это действие. Не обходи запрет другим способом.' }),
        }]);
      }
      return false;
    }
    case 'agent.custom_tool_use': {
      const name = String(event.name ?? '');
      const input = (event.input ?? {}) as Record<string, unknown>;
      let text = 'ок';
      let isError = false;

      if (name === 'say') {
        office.setState(inst.id, 'working', clip(input.text));
      } else if (name === 'check_criterion') {
        const outcome = office.checkCriterion(task.id, Number(input.index), input.done !== false);
        text = outcome.text;
        isError = !outcome.ok;
      } else if (name === 'finish_task') {
        const fresh = office.tasks.get(task.id);
        const { done, total } = fresh ? criteriaProgress(fresh) : { done: 0, total: 0 };
        const gap = total && done < total ? `\n\n⚠️ Отмечено критериев: ${done} из ${total}.` : '';
        onFinish(String(input.summary ?? '') + gap, (input.files as string[] | undefined) ?? []);
        text = 'Работа принята офисом.';
      } else {
        text = `Неизвестный инструмент ${name}.`;
        isError = true;
      }

      await send([{
        type: 'user.custom_tool_result',
        custom_tool_use_id: event.id,
        content: [{ type: 'text', text }],
        is_error: isError,
      }]);
      return false;
    }
    case 'session.error':
      office.addLog(inst.id, 'error', `Облако: ${clip(JSON.stringify(event.error ?? event), 200)}`);
      return false;
    case 'session.status_idle': {
      const stop = (event.stop_reason ?? {}) as { type?: string };
      // «Требуется действие» — это ожидание нашего ответа, работа не кончена.
      return stop.type !== 'requires_action';
    }
    case 'session.status_terminated':
      return true;
    default:
      return false;
  }
}

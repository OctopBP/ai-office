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
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { criteriaProgress, type Instance, type OfficeState, type Task } from './state';
import type { PermissionMode } from '../shared/types';
import { effectiveMode } from './permissions';
import type { Role } from './roles';
import { currentBranch, fetchBranch, remoteUrl } from './git';
import type { Lang } from '../shared/i18n';
import { t } from './i18n';

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
/**
 * Контейнер на офис, ключ — id офиса. Одной переменной хватало, пока офис был
 * один: с несколькими открытыми второй офис получал бы контейнер первого,
 * смонтированный на его репозиторий.
 */
const environmentIds = new Map<string, string>();
/**
 * Сессии идущих облачных задач — по ним работает «Остановить». Ключ составной,
 * «офис:задача»: id задач уникальны только внутри офиса, и на одном ключе
 * `T-1` соседний офис затирал бы чужую сессию — «Остановить» уходило бы не
 * туда, а завершение одной задачи глушило кнопку у другой.
 */
const sessions = new Map<string, string>();

const sessionKey = (officeId: string, taskId: string): string => `${officeId}:${taskId}`;

const clip = (s: unknown, n = 70): string => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

/** Почему облачный режим сейчас не запустится. null — всё готово. */
export function cloudProblem(state: OfficeState): string | null {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return state.say('cloud.needApiKey');
  }
  if (!state.settings.cloudRepoUrl) {
    return state.say('cloud.needRepo');
  }
  if (!token) {
    return state.say('cloud.needToken');
  }
  return null;
}

function api(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** Контейнер один на офис: настройки одинаковые, а создание стоит времени. */
async function ensureEnvironment(state: OfficeState): Promise<string> {
  const known = environmentIds.get(state.officeId);
  if (known) return known;
  const name = `ai-office-${state.officeId}`;
  let id: string;
  try {
    const env = await api().beta.environments.create({
      name,
      config: { type: 'cloud', networking: { type: 'unrestricted' } },
    });
    id = env.id;
  } catch (err) {
    // Имя окружения уникально: после перезапуска сервера оно уже создано.
    const existing = await findEnvironment(name);
    if (!existing) throw err;
    id = existing;
  }
  environmentIds.set(state.officeId, id);
  return id;
}

async function findEnvironment(name: string): Promise<string | null> {
  for await (const env of api().beta.environments.list()) {
    if (env.name === name) return env.id;
  }
  return null;
}

/**
 * Набор инструментов агента. Эффективный режим разрешений (агент → роль →
 * офис) раскладывается в политики: readonly вообще не получает запись и
 * оболочку, ask-writes спрашивает про любую правку, ask-risky — только про
 * оболочку, auto не спрашивает ни о чём.
 */
/** Имена встроенных инструментов контейнера — так их знает Managed Agents. */
type ToolName = 'bash' | 'edit' | 'glob' | 'grep' | 'read' | 'web_fetch' | 'web_search' | 'write';

function toolset(role: Role, mode: PermissionMode) {
  const writeTools: ToolName[] = ['write', 'edit', 'bash'];
  const ask = { type: 'always_ask' as const };

  if (mode === 'readonly') {
    return {
      type: 'agent_toolset_20260401' as const,
      default_config: { enabled: true },
      configs: writeTools.map((name) => ({ name, enabled: false })),
    };
  }
  // Документным ролям оболочка не нужна — как и локально.
  const configs: Array<{ name: ToolName; enabled?: boolean; permission_policy?: typeof ask }> =
    role.docsDir ? [{ name: 'bash', enabled: false }] : [];

  if (mode === 'ask-writes') {
    for (const name of writeTools) {
      if (!configs.some((c) => c.name === name)) configs.push({ name, permission_policy: ask });
    }
  } else if (mode === 'ask-risky' && !role.docsDir) {
    configs.push({ name: 'bash', permission_policy: ask });
  }

  return { type: 'agent_toolset_20260401' as const, default_config: { enabled: true }, configs };
}

/**
 * Инструменты офиса — те же, что локально, но исполняет их наш сервер.
 * Собираются под язык офиса: описание инструмента модель читает так же, как
 * системный промпт, и русское описание в английской сессии сбивало бы её.
 */
const officeTools = (lang: Lang) => [
  {
    type: 'custom' as const,
    name: 'say',
    description: t(lang, 'cloud.say.desc'),
    input_schema: {
      type: 'object' as const,
      properties: { text: { type: 'string', description: t(lang, 'cloud.say.limit') } },
      required: ['text'],
    },
  },
  {
    type: 'custom' as const,
    name: 'check_criterion',
    description: t(lang, 'cloud.check.desc'),
    input_schema: {
      type: 'object' as const,
      properties: {
        index: { type: 'integer', description: t(lang, 'cloud.check.index') },
        done: { type: 'boolean', description: t(lang, 'cloud.check.done') },
      },
      required: ['index'],
    },
  },
  {
    type: 'custom' as const,
    name: 'finish_task',
    description: t(lang, 'cloud.finish.desc'),
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: t(lang, 'cloud.finish.summary') },
        files: { type: 'array', items: { type: 'string' }, description: t(lang, 'cloud.finish.files') },
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
async function ensureAgent(
  role: Role, systemPrompt: string, mode: PermissionMode, lang: Lang,
): Promise<string> {
  // В ключе именно эффективный режим: у двух сотрудников одной роли он может
  // отличаться, и агент с чужими политиками инструментов им не подойдёт.
  // Язык там же: от него зависят описания инструментов агента.
  //
  // Промпт — отпечатком целиком, а не длиной с началом строки: смена языка
  // реализации правит блок про языки в середине, а длина и первые 64 символа
  // при этом не меняются, и офис молча переиспользовал бы старого агента.
  const digest = createHash('sha1').update(systemPrompt).digest('hex');
  const key = `${role.id}:${role.model}:${mode}:${lang}:${digest}`;
  const known = agentIds.get(key);
  if (known) return known;

  const agent = await api().beta.agents.create({
    name: `AI Office — ${role.title}`,
    model: role.model,
    system: systemPrompt,
    tools: [toolset(role, mode), ...officeTools(lang)],
  });
  agentIds.set(key, agent.id);
  return agent.id;
}

function workerPrompt(
  state: OfficeState, task: Task, role: Role, branch: string, base: string, mount: string,
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
    state.say('cloud.task.mount', { mount, base }),
    role.docsDir
      ? state.say('cloud.task.docsDir', { mount, dir: role.docsDir, task: task.id })
      : '',
    state.say('cloud.task.gitHead'),
    state.say('cloud.task.gitSteps', { branch, base }),
    '',
    state.say('cloud.task.tail'),
  ].filter(Boolean).join('\n');
}

/** Прервать облачную задачу. Сессия остаётся, работа фиксируется в ветке. */
export async function stopCloudTask(officeId: string, taskId: string): Promise<boolean> {
  const sessionId = sessions.get(sessionKey(officeId, taskId));
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
  task: Task, inst: Instance, role: Role, systemPrompt: string, state: OfficeState,
): Promise<CloudOutcome> {
  const repoUrl = state.settings.cloudRepoUrl!;
  const base = (await currentBranch(state.projectDir)) ?? 'main';
  const branch = `task/${task.id}`;
  const mount = '/workspace/repo';

  // Режим считаем так же, как локальный обработчик разрешений: личный режим
  // сотрудника сильнее режима роли, роль — сильнее офиса.
  // Режим офиса берём из state задачи, а не из глобального office: в
  // мультиофисном рантайме текущий офис может быть уже другим.
  const mode = effectiveMode(inst.permissionMode, role.permissionMode, state.officeMode());
  const [environment, agentId] = await Promise.all([
    ensureEnvironment(state),
    ensureAgent(role, systemPrompt, mode, state.lang()),
  ]);

  const cap = state.settings.taskBudgetUsd;
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
      content: [{ type: 'text', text: workerPrompt(state, task, role, branch, base, mount) }],
    }],
    // Бюджет задачи здесь жёсткий и считается платформой: дойдя до потолка,
    // сессия встаёт на паузу, а не тратит дальше.
    ...(cap ? { budget: { type: 'limit' as const, max_list_cost: { amount: String(Math.round(cap * 100)), currency: 'USD' } } } : {}),
  });

  sessions.set(sessionKey(state.officeId, task.id), session.id);
  state.addLog(inst.id, 'system',
    state.say('cloud.session', { id: session.id.slice(0, 12), repo: repoUrl }));

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
      consume(e, state, task, inst, session.id, (s, f) => { finished = s; files = f; }, handled);

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
    sessions.delete(sessionKey(state.officeId, task.id));
    try {
      const fresh = await api().beta.sessions.retrieve(session.id);
      const usage = fresh.usage;
      const cents = Number(usage?.list_cost?.amount ?? 0);
      state.addUsage(inst.id, {
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
    const pulled = await fetchBranch(state.projectDir, branch);
    const note = pulled
      ? ''
      : `\n\n${state.say('cloud.branchMissing', { branch })}`;
    const summary = (finished ?? state.say('cloud.noReport')) + note;
    if (files.length) state.updateTask(task.id, { files });
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
  state: OfficeState,
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
      if (text) state.addLog(inst.id, 'text', clip(text, 400));
      return false;
    }
    case 'agent.thinking':
      state.setState(inst.id, 'thinking', state.say('agent.state.thinking'));
      return false;
    case 'agent.tool_use': {
      const name = String(event.name ?? '');
      const brief = clip(JSON.stringify(event.input ?? {}), 60);
      state.setState(inst.id, 'working', `${name}: ${brief}`);
      state.addLog(inst.id, 'tool', `${name}: ${brief}`);
      if (event.evaluated_permission === 'ask' && event.id && !handled.includes(event.id)) {
        handled.push(event.id);
        const decision = await state.requestPermission({
          agentId: inst.id,
          taskId: task.id,
          toolName: name,
          summary: state.say('cloud.toolSummary', { tool: name }),
          detail: JSON.stringify(event.input ?? {}, null, 2),
          risk: name === 'bash' ? 'danger' : 'write',
          reason: state.say('cloud.toolReason'),
          key: `cloud:${name}`,
        });
        const allow = decision === 'allow' || decision === 'always';
        await send([{
          type: 'user.tool_confirmation',
          tool_use_id: event.id,
          result: allow ? 'allow' : 'deny',
          ...(allow ? {} : { deny_message: state.say('cloud.denyMessage') }),
        }]);
      }
      return false;
    }
    case 'agent.custom_tool_use': {
      const name = String(event.name ?? '');
      const input = (event.input ?? {}) as Record<string, unknown>;
      let text = state.say('tool.ok');
      let isError = false;

      if (name === 'say') {
        state.setState(inst.id, 'working', clip(input.text));
      } else if (name === 'check_criterion') {
        const outcome = state.checkCriterion(task.id, Number(input.index), input.done !== false);
        text = outcome.text;
        isError = !outcome.ok;
      } else if (name === 'finish_task') {
        const fresh = state.tasks.get(task.id);
        const { done, total } = fresh ? criteriaProgress(fresh) : { done: 0, total: 0 };
        const gap = total && done < total
          ? `\n\n${state.say('tool.finishTask.partial', { done, total })}`
          : '';
        onFinish(String(input.summary ?? '') + gap, (input.files as string[] | undefined) ?? []);
        text = state.say('tool.finishTask.accepted');
      } else {
        text = state.say('cloud.unknownTool', { tool: name });
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
      state.addLog(inst.id, 'error',
        state.say('cloud.error', { error: clip(JSON.stringify(event.error ?? event), 200) }));
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

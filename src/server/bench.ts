/**
 * Стенд: срабатывают ли скилы роли.
 *
 * Скил живёт не тем, что он написан, а тем, что модель открывает его вовремя.
 * Проверить это вычиткой нельзя: срабатывание решает описание в заголовке
 * SKILL.md, и понять, ловит ли оно нужные запросы и не ловит ли лишние, можно
 * только прогоном. Отсюда и стенд — самая дешёвая его форма.
 *
 * Что он меряет: на типовом запросе роли — какие скилы модель открыла, какие
 * инструменты попыталась вызвать, сколько ходов и денег ушло. Чего он НЕ
 * меряет: получилась ли работа. Для этого нужна настоящая задача и открытые
 * приложения за мостами.
 *
 * Случаи едут внутри пакета — `bench/cases.json`: автор описывает, на каких
 * запросах его агент обязан открыть какой скил и на каких не должен. Прогон
 * стоит денег: это живые сессии, порядка десятка центов на случай.
 *
 * ЧУЖИХ ДАННЫХ СТЕНД НЕ ТРОГАЕТ. Роль получает свои настоящие серверы, а
 * значит и мост в открытый файл Figma, — поэтому каждый вызов проходит через
 * наш же классификатор рисков, и всё, кроме безопасного чтения, отклоняется.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { engineFor, startSession, type EngineSession, type SessionRequest } from './engines';
import { isConnected, PROVIDER_IDS, PROVIDERS, type ModelChoice } from '../shared/providers';
import type { Lang } from '../shared/i18n';
import type { Settings } from '../shared/types';
import { t } from './i18n';
import { DEFAULT_MCP_SERVERS, externalMcp, mcpBrief } from './mcp';
import { resolvePackage } from './packages';
import { classify } from './permissions';
import { roleRuntime, type Role } from './roles';
import { employeePlugins, employeeSkills, sessionTools } from './skills';

/** Случай стенда: запрос роли и чего мы от него ждём. */
export interface BenchCase {
  what: string;
  prompt: string;
  /** Скилы, которые обязаны открыться. */
  expect: string[];
  /** Скилы, которых здесь быть не должно: срабатывание не по делу тоже дефект. */
  avoid?: string[];
}

export interface BenchOutcome {
  what: string;
  ok: boolean;
  opened: string[];
  called: string[];
  denied: string[];
  missing: string[];
  extra: string[];
  stopped: string;
  turns: number;
  costUsd: number;
}

/** Случаи из `bench/cases.json` пакета. Пусто — файла нет или он битый. */
export function readBenchCases(dir: string): BenchCase[] {
  const file = resolve(dir, 'bench/cases.json');
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { cases?: unknown };
    const list = Array.isArray(raw.cases) ? raw.cases : [];
    return list
      .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
      .filter((c) => typeof c.prompt === 'string' && c.prompt.trim())
      .map((c) => ({
        what: typeof c.what === 'string' ? c.what : String(c.prompt).slice(0, 60),
        prompt: c.prompt as string,
        expect: Array.isArray(c.expect) ? c.expect.filter((s): s is string => typeof s === 'string') : [],
        avoid: Array.isArray(c.avoid) ? c.avoid.filter((s): s is string => typeof s === 'string') : [],
      }));
  } catch {
    return [];
  }
}

const short = (name: string): string => name.split(':').pop() ?? name;

/**
 * Провайдер прогона: свой выбор роли, выбор офиса — а без них первый
 * подключённый по порядку каталога. Стенд гоняют и без офиса, из CLI автора
 * пакета, и требовать от него настройку офиса было бы странно; но и молча
 * вставать на Claude Code нельзя — поэтому берётся то, что правда подключено,
 * и вызывающий печатает, что именно. null — не подключён никто.
 */
export async function benchRuntime(role: Role, settings?: Settings): Promise<ModelChoice | null> {
  const chosen = roleRuntime(role, settings?.model ?? null);
  if (chosen) return chosen;
  for (const id of PROVIDER_IDS) {
    const status = await engineFor(id).status(id).catch(() => null);
    if (status && isConnected(status)) return roleRuntime({ provider: id, tier: role.tier }, null);
  }
  return null;
}

/** Подпись провайдера прогона для терминала. */
export const benchRuntimeLabel = (r: ModelChoice): string => `${PROVIDERS[r.provider].label} · ${r.model}`;

/** Потолок ходов: скил открывается на первом-втором, дальше платить незачем. */
const MAX_TURNS = 4;

export interface BenchRunOptions {
  lang: Lang;
  settings?: Settings;
  cwd?: string;
  runtime?: ModelChoice;
  /** Дополнительная строка брифа — правило-кандидат, которое пробуем. */
  extraBrief?: string;
  /** Запуск сессии. По умолчанию — движок провайдера; тесты подставляют заглушку. */
  start?: (request: SessionRequest) => EngineSession;
}

/** Прогнать один случай живой сессией роли. */
export async function runBenchCase(role: Role, c: BenchCase, opts: BenchRunOptions): Promise<BenchOutcome> {
  const settings = opts.settings ?? ({ mcpServers: DEFAULT_MCP_SERVERS } as Settings);
  const runtime = opts.runtime ?? await benchRuntime(role, opts.settings);
  if (!runtime) {
    return {
      what: c.what, ok: false, opened: [], called: [], denied: [], missing: c.expect, extra: [],
      stopped: t(opts.lang, 'bench.noProvider'), turns: 0, costUsd: 0,
    };
  }
  const cwd = opts.cwd ?? process.cwd();
  const opened = new Set<string>();
  const called: string[] = [];
  const denied: string[] = [];
  let turns = 0;
  let cost = 0;

  const query = opts.start ?? startSession;
  const rule = opts.extraBrief?.trim();
  const session = query({
    prompt: c.prompt,
    options: {
      ...runtime,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        // Тот же системный промпт, что у исполнителя, минус бриф проекта:
        // он про конкретный офис, а на срабатывание скила не влияет.
        append: [t(opts.lang, 'prompt.worker.system', { role: role.title }), role.brief, ...(rule ? [rule] : [])].join('\n')
          + mcpBrief(settings, role, opts.lang),
      },
      cwd,
      tools: sessionTools(role),
      plugins: employeePlugins(role),
      skills: employeeSkills(role),
      mcpServers: externalMcp(settings, role),
      permissionMode: 'default',
      canUseTool: async (toolName, input) => {
        const verdict = classify(toolName, input, cwd, opts.lang);
        if (verdict.risk === 'safe') return { behavior: 'allow', updatedInput: input };
        denied.push(toolName);
        return { behavior: 'deny', message: 'Bench: state-changing calls are refused here.' };
      },
      settingSources: [],
      maxTurns: MAX_TURNS,
    },
  });

  // Потолок ходов SDK отдаёт исключением, а для стенда это обычный исход:
  // скил открывается на первом-втором ходу, и упереться в потолок — значит
  // «работал дальше», а не «сорвалось».
  let stopped = '';
  try {
    for await (const msg of session) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type !== 'tool_use') continue;
          called.push(block.name);
          if (block.name === 'Skill') {
            const asked = (block.input as { command?: string; skill?: string; name?: string });
            opened.add(short(String(asked.command ?? asked.skill ?? asked.name ?? '?')));
          }
        }
        turns += 1;
      }
      if (msg.type === 'result') cost = (msg as { total_cost_usd?: number }).total_cost_usd ?? 0;
    }
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    stopped = /maximum number of turns/i.test(text) ? `reached the turn cap (${MAX_TURNS})` : text;
  }

  const missing = c.expect.filter((s) => !opened.has(s));
  const extra = (c.avoid ?? []).filter((s) => opened.has(s));
  return {
    what: c.what, ok: !missing.length && !extra.length,
    opened: [...opened], called: [...new Set(called)], denied: [...new Set(denied)],
    missing, extra, stopped, turns, costUsd: cost,
  };
}

/**
 * Проба правила (D-8, идеи A и E): прежде чем вписать строку в бриф, прогнать
 * случаи роли дважды — без правила и с ним — и посмотреть, что поменялось.
 * Стенд не говорит, стала ли работа лучше; он говорит, изменилось ли
 * поведение: какие скилы открылись, что модель пыталась вызвать, сколько
 * ходов и денег ушло.
 *
 * Бюджет задаётся до прогона: прогонов ровно 2 × число случаев, денег — не
 * больше предела. После прогона фактические числа сверяются с ним, и
 * превышение — ошибка в результате, а не исключение: потраченное уже
 * потрачено, и вызывающему важнее увидеть сколько, чем поймать throw.
 */

/** Предел денег на прогон по умолчанию: случай стенда стоит порядка десятка центов. */
export const PROBE_USD_PER_RUN = 0.25;

export interface ProbeBudget {
  runs: number;
  maxUsd: number;
}

/** Разница одного случая: «после» минус «до». */
export interface ProbeCaseDiff {
  what: string;
  without: BenchOutcome;
  with: BenchOutcome;
  /** Скилы, которые открылись только с правилом / только без него. */
  openedAdded: string[];
  openedRemoved: string[];
  calledAdded: string[];
  calledRemoved: string[];
  turnsDelta: number;
  costDelta: number;
  /** Случай перестал проходить / начал проходить. */
  broke: boolean;
  fixed: boolean;
}

export type ProbeResult =
  | { status: 'nothing-to-check'; reason: string; budget: ProbeBudget; runs: 0; costUsd: 0; cases: []; errors: [] }
  | {
    status: 'done';
    budget: ProbeBudget;
    /** Сколько прогонов и денег ушло на деле. */
    runs: number;
    costUsd: number;
    cases: ProbeCaseDiff[];
    /** Сумма по случаям: ходы и деньги «с правилом» минус «без». */
    turnsDelta: number;
    costDelta: number;
    broke: number;
    fixed: number;
    /** Превышение бюджета и остановка на нём. Пусто — уложились. */
    errors: string[];
  };

export interface ProbeOptions extends Omit<BenchRunOptions, 'extraBrief'> {
  /** Папка пакета роли. Нет — берётся по ссылке роли на пакет. */
  dir?: string;
  /** Предел денег на всю пробу. По умолчанию — PROBE_USD_PER_RUN за прогон. */
  maxUsd?: number;
}

const added = (from: string[], to: string[]): string[] => to.filter((s) => !from.includes(s));

/** Сравнить два исхода одного случая. */
export function diffOutcomes(without: BenchOutcome, withRule: BenchOutcome): ProbeCaseDiff {
  return {
    what: without.what,
    without,
    with: withRule,
    openedAdded: added(without.opened, withRule.opened),
    openedRemoved: added(withRule.opened, without.opened),
    calledAdded: added(without.called, withRule.called),
    calledRemoved: added(withRule.called, without.called),
    turnsDelta: withRule.turns - without.turns,
    costDelta: withRule.costUsd - without.costUsd,
    broke: without.ok && !withRule.ok,
    fixed: !without.ok && withRule.ok,
  };
}

/** Прогнать случаи роли без правила и с ним и вернуть разницу. */
export async function probeRule(role: Role, ruleText: string, opts: ProbeOptions): Promise<ProbeResult> {
  const dir = opts.dir ?? (role.package ? resolvePackage(role.package)?.dir : undefined);
  const cases = dir ? readBenchCases(dir) : [];
  const runs = 2 * cases.length;
  const budget: ProbeBudget = { runs, maxUsd: opts.maxUsd ?? runs * PROBE_USD_PER_RUN };
  if (!cases.length) {
    return {
      status: 'nothing-to-check', reason: t(opts.lang, 'bench.probe.noCases'),
      budget, runs: 0, costUsd: 0, cases: [], errors: [],
    };
  }

  // Провайдер выбирается один раз: обе половины пары обязаны идти на одной
  // модели, иначе разница будет про модель, а не про правило.
  const runtime = opts.runtime ?? await benchRuntime(role, opts.settings) ?? undefined;
  const { dir: _dir, maxUsd: _max, ...base } = opts;
  const diffs: ProbeCaseDiff[] = [];
  const errors: string[] = [];
  let done = 0;
  let spent = 0;
  for (const c of cases) {
    // Предел уже выбран — следующую пару не начинаем: дальше были бы деньги
    // сверх того, на что согласились.
    if (spent >= budget.maxUsd) {
      errors.push(t(opts.lang, 'bench.probe.stopped', { done: diffs.length, total: cases.length }));
      break;
    }
    const without = await runBenchCase(role, c, { ...base, runtime });
    const withRule = await runBenchCase(role, c, { ...base, runtime, extraBrief: ruleText });
    done += 2;
    spent += without.costUsd + withRule.costUsd;
    diffs.push(diffOutcomes(without, withRule));
  }

  if (done > budget.runs) errors.push(t(opts.lang, 'bench.probe.overRuns', { actual: done, budget: budget.runs }));
  if (spent > budget.maxUsd) {
    errors.push(t(opts.lang, 'bench.probe.overUsd', { actual: spent.toFixed(4), budget: budget.maxUsd.toFixed(4) }));
  }
  return {
    status: 'done', budget, runs: done, costUsd: spent, cases: diffs,
    turnsDelta: diffs.reduce((n, d) => n + d.turnsDelta, 0),
    costDelta: diffs.reduce((n, d) => n + d.costDelta, 0),
    broke: diffs.filter((d) => d.broke).length,
    fixed: diffs.filter((d) => d.fixed).length,
    errors,
  };
}

/** Отчёт по одному случаю — строками для терминала. */
export function formatOutcome(o: BenchOutcome): string {
  const lines = [
    `${o.ok ? '  ok  ' : '  FAIL'} ${o.what}`,
    `       opened skills: ${o.opened.join(', ') || '(none)'}`,
    `       tried to call: ${o.called.join(', ') || '(none)'}`,
  ];
  if (o.denied.length) lines.push(`       refused:       ${o.denied.join(', ')}`);
  if (o.missing.length) lines.push(`       expected but not opened: ${o.missing.join(', ')}`);
  if (o.extra.length) lines.push(`       opened needlessly: ${o.extra.join(', ')}`);
  if (o.stopped) lines.push(`       stopped: ${o.stopped}`);
  lines.push(`       turns ${o.turns}, $${o.costUsd.toFixed(4)}`, '');
  return lines.join('\n');
}

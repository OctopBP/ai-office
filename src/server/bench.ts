import { providerOf } from '../shared/providers';
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
import { query } from './providers';
import type { Lang } from '../shared/i18n';
import type { Settings } from '../shared/types';
import { t } from './i18n';
import { DEFAULT_MCP_SERVERS, externalMcp, mcpBrief } from './mcp';
import { classify } from './permissions';
import type { Role } from './roles';
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

/** Потолок ходов: скил открывается на первом-втором, дальше платить незачем. */
const MAX_TURNS = 4;

/** Прогнать один случай живой сессией роли. */
export async function runBenchCase(
  role: Role, c: BenchCase, opts: { lang: Lang; settings?: Settings; cwd?: string } ,
): Promise<BenchOutcome> {
  const settings = opts.settings ?? ({ mcpServers: DEFAULT_MCP_SERVERS } as Settings);
  const cwd = opts.cwd ?? process.cwd();
  const opened = new Set<string>();
  const called: string[] = [];
  const denied: string[] = [];
  let turns = 0;
  let cost = 0;

  const session = query({
    prompt: c.prompt,
    options: {
      model: role.model,
      provider: providerOf(role),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        // Тот же системный промпт, что у исполнителя, минус бриф проекта:
        // он про конкретный офис, а на срабатывание скила не влияет.
        append: [t(opts.lang, 'prompt.worker.system', { role: role.title }), role.brief].join('\n')
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

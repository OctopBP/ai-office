/**
 * Проба правила на стенде (T-669, D-8 идеи A и E) — без единой живой сессии.
 *
 * Движок подменён заглушкой: она смотрит, есть ли правило в системном промпте,
 * и по этому отвечает по-разному — открывает другой скил, делает больше
 * ходов, тратит другие деньги. Проверяем:
 *  1. каждый случай прогоняется дважды, правило уходит только во второй прогон,
 *     разница по исходам посчитана;
 *  2. бюджет задан до прогона (2 × случаи, предел денег) и сверяется после:
 *     превышение — ошибка в результате, не исключение;
 *  3. без bench/cases.json — «нечем проверить» и ни одного прогона.
 *
 * Запуск: node --import tsx/esm scripts/test-probe-rule.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeRule } from '../src/server/bench';
import type { EngineSession, SessionRequest } from '../src/server/engines';
import type { Role } from '../src/server/roles';

const RULE = 'Перед правкой макета всегда открывай скил layout-check.';

const role = { id: 'design', title: 'Дизайнер', brief: 'Ты дизайнер.' } as Role;
const runtime = { provider: 'claude-code' as const, model: 'claude-sonnet-5-5' };

/** Заглушка движка: с правилом в промпте открывает layout-check и работает дольше. */
function stubEngine(costs: { without: number; with: number }) {
  const prompts: string[] = [];
  const start = (request: SessionRequest): EngineSession => {
    const sp = request.options.systemPrompt as { append?: string } | undefined;
    const append = sp?.append ?? '';
    prompts.push(append);
    const ruled = append.includes(RULE);
    const skill = ruled ? 'layout-check' : 'figma-read';
    async function* stream() {
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } };
      if (ruled) yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } };
      yield { type: 'result', total_cost_usd: ruled ? costs.with : costs.without };
    }
    return stream() as unknown as EngineSession;
  };
  return { start, prompts };
}

function packageDir(withCases: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'probe-rule-'));
  if (withCases) {
    mkdirSync(join(dir, 'bench'));
    writeFileSync(join(dir, 'bench/cases.json'), JSON.stringify({ cases: [
      { what: 'правка макета', prompt: 'Поправь отступы в карточке', expect: ['layout-check'] },
      { what: 'чтение макета', prompt: 'Что на экране входа?', expect: ['figma-read'], avoid: ['layout-check'] },
    ] }));
  }
  return dir;
}

const results: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => results.push([name, ok]);
const dirs: string[] = [];

try {
  // 1–2. Две пары, бюджет с запасом.
  {
    const dir = packageDir(true); dirs.push(dir);
    const engine = stubEngine({ without: 0.01, with: 0.03 });
    const r = await probeRule(role, RULE, { lang: 'ru', dir, runtime, start: engine.start, maxUsd: 1 });
    check('статус done', r.status === 'done');
    check('прогонов 4 = 2 × 2 случая', r.runs === 4 && engine.prompts.length === 4);
    check('бюджет задан заранее: 4 прогона, $1', r.budget.runs === 4 && r.budget.maxUsd === 1);
    check('правило только во втором прогоне пары',
      engine.prompts.map((p) => p.includes(RULE)).join() === 'false,true,false,true');
    if (r.status === 'done') {
      const [edit, read] = r.cases;
      check('скил добавился и убрался', edit.openedAdded.join() === 'layout-check' && edit.openedRemoved.join() === 'figma-read');
      check('вызовы: добавился Read', edit.calledAdded.join() === 'Read' && !edit.calledRemoved.length);
      check('ходов +1 на случай', edit.turnsDelta === 1 && r.turnsDelta === 2);
      check('деньги: +0.02 на случай', Math.abs(edit.costDelta - 0.02) < 1e-9 && Math.abs(r.costDelta - 0.04) < 1e-9);
      check('цена пробы — сумма всех прогонов', Math.abs(r.costUsd - 0.08) < 1e-9);
      check('правка макета починилась', edit.fixed && !edit.broke);
      check('чтение макета сломалось', read.broke && !read.fixed && r.broke === 1 && r.fixed === 1);
      check('в бюджет уложились — ошибок нет', r.errors.length === 0);
    }
  }

  // 2. Превышение денег — ошибка в результате, следующая пара не начинается.
  {
    const dir = packageDir(true); dirs.push(dir);
    const engine = stubEngine({ without: 0.2, with: 0.3 });
    let threw = false;
    const r = await probeRule(role, RULE, { lang: 'ru', dir, runtime, start: engine.start, maxUsd: 0.4 })
      .catch(() => { threw = true; return null; });
    check('превышение не бросает исключение', !threw && r !== null);
    if (r && r.status === 'done') {
      check('остановились после первой пары', r.runs === 2 && engine.prompts.length === 2);
      check('ошибка о деньгах в результате', r.errors.some((e) => e.includes('$0.5000') && e.includes('$0.4000')));
      check('ошибка об остановке в результате', r.errors.some((e) => e.includes('1 из 2')));
    }
  }

  // 2. Предел по умолчанию — от числа прогонов.
  {
    const dir = packageDir(true); dirs.push(dir);
    const engine = stubEngine({ without: 0, with: 0 });
    const r = await probeRule(role, RULE, { lang: 'ru', dir, runtime, start: engine.start });
    check('предел по умолчанию = 4 × $0.25', r.budget.maxUsd === 1);
  }

  // 3. Без cases.json — нечем проверить, ни одного прогона.
  {
    const dir = packageDir(false); dirs.push(dir);
    const engine = stubEngine({ without: 1, with: 1 });
    const r = await probeRule(role, RULE, { lang: 'ru', dir, runtime, start: engine.start });
    check('без cases.json — nothing-to-check', r.status === 'nothing-to-check' && /нечем проверить/.test(
      r.status === 'nothing-to-check' ? r.reason : ''));
    check('без cases.json — ни прогонов, ни денег', r.runs === 0 && r.costUsd === 0 && engine.prompts.length === 0);
  }

  // 3. Роль без пакета и без папки — тоже нечем проверить.
  {
    const engine = stubEngine({ without: 1, with: 1 });
    const r = await probeRule(role, RULE, { lang: 'ru', runtime, start: engine.start });
    check('роль без пакета — nothing-to-check', r.status === 'nothing-to-check' && engine.prompts.length === 0);
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok] of results) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}
console.log(failed ? `провалено ${failed} из ${results.length}` : `все ${results.length} прошли`);
process.exit(failed ? 1 : 0);

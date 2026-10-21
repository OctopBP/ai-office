/**
 * Рефлексия прикладывает пробу к предложению правила (T-670) — без живых сессий.
 *
 * Агент рефлексии и движок стенда подменены заглушками. Проверяем:
 *  1. правило роли со случаями стенда прогоняется probeRule до показа
 *     владельцу, в ProposalView.probe — разница, цена и статус 'checked';
 *  2. цена пробы входит в costUsd прогона ритуала;
 *  3. роль без случаев — 'nothing-to-check' и ни одного прогона;
 *  4. окно подписки за порогом — 'skipped-limit', стенд не зовётся;
 *  5. проба сорвалась — 'error', предложение всё равно показано;
 *  6. правило о проекте ('domain') стендом не гоняется;
 *  7. принятие правила от пробы не зависит.
 *
 * Запуск: node --import tsx/esm scripts/test-reflect-probe.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOffice, toProposalView, unloadOfficeState } from '../src/server/state';
import { runRitual, setRitualAgents, setRuleProbe, type ReflectionOutput } from '../src/server/rituals';
import { probeRule } from '../src/server/bench';
import { applyProposal } from '../src/server/selfchange';
import type { EngineSession, SessionRequest } from '../src/server/engines';

process.env.OFFICE_LANG = 'ru';

const RULE = 'Перед правкой макета всегда открывай скил layout-check.';
const OFFICE_ID = 'o-reflect-probe';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** Заглушка движка: с правилом в промпте открывает layout-check, ходит дольше и дороже. */
let sessions = 0;
const start = (request: SessionRequest): EngineSession => {
  sessions += 1;
  const sp = request.options.systemPrompt as { append?: string } | undefined;
  const ruled = (sp?.append ?? '').includes(RULE);
  async function* stream() {
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: ruled ? 'layout-check' : 'figma-read' } }] } };
    if (ruled) yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } };
    yield { type: 'result', total_cost_usd: ruled ? 0.03 : 0.01 };
  }
  return stream() as unknown as EngineSession;
};

async function main(): Promise<void> {
  const office = getOffice(OFFICE_ID);
  office.seed();
  office.opened = true;
  office.dryRun = false;
  office.settings.ritualsEnabled = true;
  office.settings.model = { provider: 'claude-code', model: 'claude-sonnet-5-5' };
  const [withCases, noCases] = office.roles().filter((r) => !r.archived).map((r) => r.id);
  assert.ok(withCases && noCases, 'в офисе нужны две роли');

  const dir = mkdtempSync(join(tmpdir(), 'reflect-probe-'));
  mkdirSync(join(dir, 'bench'));
  writeFileSync(join(dir, 'bench/cases.json'), JSON.stringify({ cases: [
    { what: 'правка макета', prompt: 'Поправь отступы в карточке', expect: ['layout-check'] },
    { what: 'чтение макета', prompt: 'Что на экране входа?', expect: ['figma-read'], avoid: ['layout-check'] },
  ] }));

  let rules: ReflectionOutput['rules'] = [];
  setRitualAgents({
    async consolidate() { return { facts: [], contradictions: [], questions: [], costUsd: 0 }; },
    async contradictions() { return { facts: [], contradictions: [], questions: [], costUsd: 0 }; },
    async reflect() { return { facts: [], contradictions: [], questions: [], costUsd: 0.5, features: [], rules, summary: '' }; },
  });
  let busy: { percent: number } | null = null;
  let explode = false;
  let probeCalls = 0;
  setRuleProbe({
    dir: (role) => (role.id === withCases ? dir : undefined),
    busy: () => busy,
    run: async (role, text, opts) => {
      probeCalls += 1;
      if (explode) throw new Error('движок упал');
      return probeRule(role, text, { ...opts, start, runtime: { provider: 'claude-code', model: 'claude-sonnet-5-5' } });
    },
  });
  const proposalFor = (roleId: string, text: string) =>
    office.proposalList().find((p) => p.kind === 'rule' && p.roleId === roleId && p.text === text);

  console.log('роль со случаями стенда');
  rules = [{ roleId: withCases, text: RULE, rationale: 'забывал проверять макет', kind: 'how' }];
  const run = await runRitual(office, 'reflect');
  const checked = proposalFor(withCases, RULE);
  await check('probeRule прогнал оба случая без правила и с ним', () => {
    assert.equal(probeCalls, 1);
    assert.equal(sessions, 4);
  });
  await check('в ProposalView.probe — статус, разница и цена', () => {
    const probe = toProposalView(checked!).probe;
    assert.ok(probe);
    assert.equal(probe.status, 'checked');
    assert.equal(probe.runs, 4);
    assert.ok(Math.abs(probe.costUsd - 0.08) < 1e-9);
    assert.ok(Math.abs(probe.costDelta - 0.04) < 1e-9);
    assert.equal(probe.turnsDelta, 2);
    assert.equal(probe.cases.length, 2);
    assert.deepEqual(probe.cases[0].openedAdded, ['layout-check']);
    assert.deepEqual(probe.cases[0].openedRemoved, ['figma-read']);
    assert.equal(probe.fixed, 1);
    assert.equal(probe.broke, 1);
  });
  await check('цена пробы входит в costUsd ритуала', () => {
    assert.ok(run);
    assert.ok(Math.abs(run.costUsd - 0.58) < 1e-9, `costUsd ${run.costUsd}`);
  });

  console.log('без случаев, за лимитом, с ошибкой, правило о проекте');
  const noCasesRule = 'Пиши тесты до кода.';
  const limitRule = 'Сверяй макет со спекой.';
  const errorRule = 'Проверяй контраст.';
  const domainRule = 'Хранилище проекта — JSON-файл.';
  office.life.lastRun = {};
  rules = [{ roleId: noCases, text: noCasesRule, rationale: 'r', kind: 'how' }];
  const callsBefore = probeCalls;
  const run2 = await runRitual(office, 'reflect');
  await check('роль без случаев — «нечем проверить», стенд не зовётся', () => {
    const probe = proposalFor(noCases, noCasesRule)?.probe;
    assert.equal(probe?.status, 'nothing-to-check');
    assert.equal(probe?.runs, 0);
    assert.equal(probeCalls, callsBefore);
    assert.ok(Math.abs((run2?.costUsd ?? 0) - 0.5) < 1e-9);
  });

  office.life.lastRun = {};
  busy = { percent: 93 };
  rules = [{ roleId: withCases, text: limitRule, rationale: 'r', kind: 'how' }];
  await runRitual(office, 'reflect');
  await check('окно за порогом — «пропущено по лимиту»', () => {
    const probe = proposalFor(withCases, limitRule)?.probe;
    assert.equal(probe?.status, 'skipped-limit');
    assert.ok(probe?.note?.includes('93'));
    assert.equal(probeCalls, callsBefore);
  });

  office.life.lastRun = {};
  busy = null;
  explode = true;
  rules = [
    { roleId: withCases, text: errorRule, rationale: 'r', kind: 'how' },
    { roleId: withCases, text: domainRule, rationale: 'r', kind: 'domain' },
  ];
  await runRitual(office, 'reflect');
  await check('проба сорвалась — «ошибка», предложение всё равно показано', () => {
    const probe = proposalFor(withCases, errorRule)?.probe;
    assert.equal(probe?.status, 'error');
    assert.equal(probe?.note, 'движок упал');
    assert.equal(probeCalls, callsBefore + 1);
  });
  await check('правило о проекте стендом не гоняется', () => {
    assert.equal(proposalFor(withCases, domainRule)?.probe?.status, 'nothing-to-check');
  });

  await check('принятие правила от пробы не зависит', () => {
    const failed = proposalFor(withCases, errorRule)!;
    assert.equal(applyProposal(office, failed), null);
    const role = office.role(withCases)!;
    const text = role.package ? role.package.briefExtra : role.brief;
    assert.ok(text.includes(errorRule));
  });

  rmSync(dir, { recursive: true, force: true });
  unloadOfficeState(OFFICE_ID);
  console.log(`\nпроба в рефлексии: ${passed} проверок прошло`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

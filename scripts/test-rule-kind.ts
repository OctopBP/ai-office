/**
 * Правила и уроки рефлексии (T-666, D-8 §3, идеи B и D): урок без основания
 * ритуал не пишет; правило 'how' ложится в бриф роли, 'domain' — в журнал и
 * не в бриф; правило без вида — как раньше, в бриф.
 *
 * Запуск: node --import tsx/esm scripts/test-rule-kind.ts
 */
import './_isolate'; // первым: до чтения окружения в root.ts и store.ts
import assert from 'node:assert/strict';
import { getOffice, toProposalView, unloadOfficeState } from '../src/server/state';
import { groundedLesson, ruleProposal } from '../src/server/rituals';
import { applyProposal } from '../src/server/selfchange';

process.env.OFFICE_LANG = 'ru';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('основание урока');

check('урок с cue и ссылкой на задачу, запись или коммит — с основанием', () => {
  for (const ref of ['T-12', 'J-40', 'Q-3', 'D-8', 'abc1234', 'отзыв ревью по T-7']) {
    assert.ok(groundedLesson({ kind: 'lesson', text: 'x', scope: 'project', cue: 'когда', evidence: [ref] }), ref);
  }
});

check('задача, из которой урок родился, — тоже основание', () => {
  assert.ok(groundedLesson({ kind: 'lesson', text: 'x', scope: 'project', cue: 'когда', taskId: 'T-5' }));
});

check('урок без cue, без evidence или без ссылок — без основания', () => {
  assert.ok(!groundedLesson({ kind: 'lesson', text: 'x', scope: 'project', evidence: ['T-1'] }));
  assert.ok(!groundedLesson({ kind: 'lesson', text: 'x', scope: 'project', cue: '  ', evidence: ['T-1'] }));
  assert.ok(!groundedLesson({ kind: 'lesson', text: 'x', scope: 'project', cue: 'когда' }));
  assert.ok(!groundedLesson({ kind: 'lesson', text: 'x', scope: 'project', cue: 'когда', evidence: ['по опыту'] }));
});

check('факт и решение основания не требуют', () => {
  assert.ok(groundedLesson({ kind: 'fact', text: 'x', scope: 'project' }));
  assert.ok(groundedLesson({ kind: 'decision', text: 'x', scope: 'project' }));
});

console.log('вид правила');

check('вид правила едет в предложение; без вида и с мусором — без поля', () => {
  const base = { roleId: 'backend', text: ' Правило ', rationale: 'T-1, T-2' };
  assert.equal(ruleProposal({ ...base, kind: 'how' }).ruleKind, 'how');
  assert.equal(ruleProposal({ ...base, kind: 'domain' }).ruleKind, 'domain');
  assert.ok(!('ruleKind' in ruleProposal(base)));
  assert.ok(!('ruleKind' in ruleProposal({ ...base, kind: 'other' as never })));
  assert.equal(ruleProposal(base).text, 'Правило');
});

const office = getOffice('o-rule-kind');
office.seed();
const roleId = office.workerRoles()[0].id;
const briefOf = () => {
  const role = office.role(roleId)!;
  return role.package ? role.package.briefExtra : role.brief;
};
const accept = (rule: { text: string; kind?: 'how' | 'domain' }) => {
  const p = office.addProposal(ruleProposal({ roleId, rationale: 'T-1, T-2', ...rule }));
  assert.equal(applyProposal(office, p), null);
  return p;
};

check('правило how — в бриф роли', () => {
  accept({ text: 'Перед сдачей прогоняй typecheck.', kind: 'how' });
  assert.ok(briefOf().includes('Перед сдачей прогоняй typecheck.'));
});

check('правило domain — в журнал роли, не в бриф', () => {
  const before = briefOf();
  const p = accept({ text: 'Журнал офиса живёт в src/server/journal.ts.', kind: 'domain' });
  assert.equal(briefOf(), before);
  const fact = office.factList().find((f) => f.text === 'Журнал офиса живёт в src/server/journal.ts.');
  assert.ok(fact, 'запись в журнале');
  assert.equal(fact.kind, 'decision');
  assert.equal(fact.scope, `role:${roleId}`);
  assert.deepEqual(fact.evidence, [p.id]);
  assert.ok(office.log.some((l) => l.text.includes('записано в журнал')));
});

check('правило без вида — как раньше, в бриф', () => {
  accept({ text: 'Не читай большие файлы целиком.' });
  assert.ok(briefOf().includes('Не читай большие файлы целиком.'));
  assert.ok(!office.factList().some((f) => f.text === 'Не читай большие файлы целиком.'));
});

check('предложение отдаёт вид клиенту', () => {
  const views = office.proposalList().map(toProposalView);
  assert.ok(views.some((v) => v.ruleKind === 'domain'));
  assert.ok(views.some((v) => v.kind === 'rule' && !('ruleKind' in v)));
});

unloadOfficeState('o-rule-kind');
console.log(`\n${passed} проверок прошло`);

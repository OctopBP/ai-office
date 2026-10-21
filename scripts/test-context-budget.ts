/**
 * Замер постоянного контекста роли (src/server/context-budget.ts, T-667):
 * разбивка по частям, итог, порог из настройки и `OFFICE_ALWAYS_ON_MAX`,
 * скилы с пустым или общим описанием; предупреждения валидатора пакета и
 * строка в ленту при старте сессии (T-668). Ни одного токена: всё во времянке.
 *
 * Запуск: npm run test:context-budget
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = mkdtempSync(resolve(tmpdir(), 'office-budget-'));
// До импорта: каталог наборов и файл состояния читаются на загрузке модулей.
process.env.OFFICE_EMPLOYEES_DIR = resolve(root, 'employees');
process.env.OFFICE_STATE_FILE = resolve(root, 'state.json');
process.env.OFFICE_LANG = 'ru';
delete process.env.OFFICE_ALWAYS_ON_MAX;

const { alwaysOnMax, contextBudget, DEFAULT_ALWAYS_ON_MAX, MIN_SKILL_DESCRIPTION } = await import('../src/server/context-budget');
const { skillDescription } = await import('../src/server/skills');
const { blankRole } = await import('../src/server/roles');
const { rulesBrief } = await import('../src/server/rules');
const { journalBrief } = await import('../src/server/journal');
const { getOffice } = await import('../src/server/state');
const { BUDGET_NOTE_EVERY_MS, noteContextBudget } = await import('../src/server/context-budget');
const { packageBudget, validatePackage } = await import('../src/server/packages');
const { ROOT } = await import('../src/server/root');

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** Набор роли в employees/: плагин и скилы с заданными заголовками. */
function makePack(id: string, skills: Record<string, string>): void {
  const dir = resolve(root, 'employees', id);
  mkdirSync(resolve(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(resolve(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: id }));
  for (const [slug, head] of Object.entries(skills)) {
    mkdirSync(resolve(dir, 'skills', slug), { recursive: true });
    writeFileSync(resolve(dir, 'skills', slug, 'SKILL.md'), `---\nname: ${slug}\n${head}---\n\nТело скила в замер не входит.\n`);
  }
}

console.log('описание скила');

check('одна строка, кавычки и блок YAML', () => {
  assert.equal(skillDescription('---\nname: a\ndescription: Просто строка\n---\n'), 'Просто строка');
  assert.equal(skillDescription('---\ndescription: "В кавычках"\n---\n'), 'В кавычках');
  assert.equal(skillDescription('---\ndescription: >\n  Первая\n  вторая\nname: x\n---\n'), 'Первая вторая');
  assert.equal(skillDescription('---\ndescription: |\n  Строка 1\n  Строка 2\n---\n'), 'Строка 1\nСтрока 2');
});

check('нет заголовка или поля — пустое описание', () => {
  assert.equal(skillDescription('# Скил без заголовка\n'), '');
  assert.equal(skillDescription('---\nname: a\n---\n'), '');
});

console.log('порог');

check('по умолчанию 24 000', () => {
  assert.equal(DEFAULT_ALWAYS_ON_MAX, 24_000);
  assert.equal(alwaysOnMax(undefined, undefined), 24_000);
});

check('настройка офиса меняет порог', () => {
  assert.equal(alwaysOnMax(30_000, undefined), 30_000);
});

check('OFFICE_ALWAYS_ON_MAX сильнее настройки', () => {
  assert.equal(alwaysOnMax(30_000, '12000'), 12_000);
  assert.equal(alwaysOnMax(undefined, '5000'), 5000);
});

check('негодное значение пропускается', () => {
  assert.equal(alwaysOnMax(undefined, 'много'), 24_000);
  assert.equal(alwaysOnMax(30_000, '-1'), 30_000);
  assert.equal(alwaysOnMax(0, ''), 24_000);
});

console.log('замер роли');

const projectDir = resolve(root, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(resolve(projectDir, 'RULES.md'), '# Правила\n\n- Не читать большие файлы целиком\n- Тесты через node --import tsx/esm\n');

const office = getOffice('o-context-budget');
office.setStateFile(resolve(root, 'state.json'));
office.projectDir = projectDir;
office.dryRun = true;
office.addFact({ kind: 'lesson', text: 'Порог постоянного контекста — 24 000 символов', scope: 'project' });

const shortText = 'Делает что-то';
const longText = 'Как собрать спрайт персонажа из слоёв и проверить его на сетке офиса.';
makePack('writer', {
  good: `description: ${longText}\n`,
  vague: `description: ${shortText}\n`,
  bare: '',
});

// Роль без пакета: скилы — из набора employees/ по id.
const role = { ...blankRole('writer'), brief: 'Свой бриф роли.' };
// Роль с пакетом: `Role.brief` склеен из брифа пакета и приписки.
const linked = {
  ...blankRole('linked'),
  brief: 'Бриф пакета.\n\nПриписка владельца.',
  package: { name: '@office/linked', version: '0.0.0', overrides: {}, briefExtra: 'Приписка владельца.' },
};

check('разбивка по частям и итог', () => {
  const budget = contextBudget(office, role);
  assert.equal(budget.roleId, 'writer');
  assert.equal(budget.parts.brief, 'Свой бриф роли.'.length);
  assert.equal(budget.parts.briefExtra, 0);
  assert.equal(budget.parts.rules, rulesBrief(office, 'writer').trim().length);
  assert.ok(budget.parts.rules > 0, 'правила офиса доехали');
  assert.equal(budget.parts.journal, journalBrief(office, 'writer').trim().length);
  assert.ok(budget.parts.journal > 0, 'журнал доехал');
  const skills = ['writer:good', 'writer:vague', 'writer:bare'].join('').length + longText.length + shortText.length;
  assert.equal(budget.parts.skills, skills);
  assert.equal(budget.total, Object.values(budget.parts).reduce((a, b) => a + b, 0));
  assert.equal(budget.limit, 24_000);
  assert.equal(budget.over, 0);
});

check('пустое и общее описание — в предупреждениях, внятное — нет', () => {
  const { skillWarnings } = contextBudget(office, role);
  assert.deepEqual(
    skillWarnings.map((w) => [w.skill, w.reason]).sort(),
    [['writer:bare', 'empty'], ['writer:vague', 'short']],
  );
  assert.ok(shortText.length < MIN_SKILL_DESCRIPTION && longText.length >= MIN_SKILL_DESCRIPTION);
});

check('бриф пакета и приписка — отдельными частями', () => {
  const budget = contextBudget(office, linked);
  assert.equal(budget.parts.brief, 'Бриф пакета.'.length);
  assert.equal(budget.parts.briefExtra, 'Приписка владельца.'.length);
  // Пакета на диске нет — и скилов нет, замер не падает.
  assert.equal(budget.parts.skills, 0);
  assert.deepEqual(budget.skillWarnings, []);
});

check('превышение считается и ничего не ломает', () => {
  process.env.OFFICE_ALWAYS_ON_MAX = '100';
  try {
    const budget = contextBudget(office, { ...role, brief: 'х'.repeat(500) });
    assert.equal(budget.limit, 100);
    assert.equal(budget.over, budget.total - 100);
    assert.ok(budget.over > 0);
  } finally {
    delete process.env.OFFICE_ALWAYS_ON_MAX;
  }
});

check('настройка офиса alwaysOnMax доезжает до замера', () => {
  office.settings.alwaysOnMax = 50_000;
  try {
    assert.equal(contextBudget(office, role).limit, 50_000);
  } finally {
    delete office.settings.alwaysOnMax;
  }
});

console.log('валидатор пакета');

// Живой пакет из репозитория во времянку — и к нему скилы.
const pkgDir = resolve(root, 'pkg');
cpSync(resolve(ROOT, 'packages/@office/backend'), pkgDir, { recursive: true });
rmSync(resolve(pkgDir, 'skills'), { recursive: true, force: true });
const addSkill = (slug: string, head: string) => {
  mkdirSync(resolve(pkgDir, 'skills', slug), { recursive: true });
  writeFileSync(resolve(pkgDir, 'skills', slug, 'SKILL.md'), `---\nname: ${slug}\n${head}---\n\nТело.\n`);
};
addSkill('good', `description: ${longText}\n`);
addSkill('vague', `description: ${shortText}\n`);
addSkill('blank', 'description: |\n');

const warnsAt = (lang: 'ru' | 'en') => validatePackage(pkgDir, lang).filter((p) => p.level === 'warn');

check('скил с пустым и с общим описанием — предупреждения, внятный — нет', () => {
  const warns = warnsAt('ru');
  const at = (slug: string) => warns.filter((p) => p.path === `skills/${slug}/SKILL.md`).map((p) => p.message);
  assert.equal(at('good').length, 0);
  assert.equal(at('blank').length, 1);
  assert.match(at('blank')[0], /пустое описание/);
  assert.equal(at('vague').length, 1);
  assert.match(at('vague')[0], new RegExp(`короче ${MIN_SKILL_DESCRIPTION}`));
});

check('предупреждения на языке валидатора', () => {
  const blank = warnsAt('en').find((p) => p.path === 'skills/blank/SKILL.md');
  assert.match(blank?.message ?? '', /empty skill description/);
});

check('замер пакета: бриф по языкам и описания скилов', () => {
  const budget = packageBudget(pkgDir);
  assert.ok(budget.briefs.ru && budget.briefs.en, 'оба брифа посчитаны');
  assert.equal(budget.brief, Math.max(budget.briefs.ru!, budget.briefs.en!));
  assert.ok(budget.skills >= longText.length + shortText.length);
  assert.equal(budget.total, budget.brief + budget.skills);
  assert.equal(budget.over, 0);
});

check('превышение порога — предупреждение, не ошибка', () => {
  assert.ok(!warnsAt('ru').some((p) => /порог/.test(p.message)), 'в пороге молчим');
  process.env.OFFICE_ALWAYS_ON_MAX = '100';
  try {
    const problems = validatePackage(pkgDir, 'ru');
    const over = problems.filter((p) => /постоянный контекст/.test(p.message));
    assert.equal(over.length, 1);
    assert.equal(over[0].level, 'warn');
    assert.ok(!problems.some((p) => p.level === 'error'));
    assert.match(over[0].message, /при пороге 100/);
  } finally {
    delete process.env.OFFICE_ALWAYS_ON_MAX;
  }
});

console.log('событие при старте сессии');

check('в пороге — в ленте пусто', () => {
  const before = office.log.length;
  assert.equal(noteContextBudget(office, role), false);
  assert.equal(office.log.length, before);
});

check('превышение — одна строка в ленту, не чаще раза в сутки на роль', () => {
  process.env.OFFICE_ALWAYS_ON_MAX = '100';
  try {
    const fat = { ...role, brief: 'х'.repeat(500) };
    const before = office.log.length;
    const t0 = 1_000_000;
    assert.equal(noteContextBudget(office, fat, t0), true);
    assert.equal(office.log.length, before + 1);
    const entry = office.log[office.log.length - 1];
    assert.equal(entry.kind, 'system');
    assert.match(entry.text, /при пороге 100/);
    // Повтор в те же сутки — тишина; другая роль — своя строка.
    assert.equal(noteContextBudget(office, fat, t0 + BUDGET_NOTE_EVERY_MS - 1), false);
    assert.equal(noteContextBudget(office, { ...linked, brief: 'х'.repeat(500) }, t0 + 1), true);
    assert.equal(office.log.length, before + 2);
    // Сутки прошли — снова.
    assert.equal(noteContextBudget(office, fat, t0 + BUDGET_NOTE_EVERY_MS), true);
    assert.equal(office.log.length, before + 3);
  } finally {
    delete process.env.OFFICE_ALWAYS_ON_MAX;
  }
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} проверок прошло`);
process.exit(0);
